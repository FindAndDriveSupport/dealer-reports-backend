/**
 * admin.js — Cloudflare Worker admin routes
 *
 * All routes require a valid JWT from an admin user (is_admin = 1 in D1).
 *
 * Routes:
 *   GET  /api/admin/overview           — internal team + grouped dealer list
 *   POST /api/admin/invite             — invite a new dealer (multi-branch), group admin, or internal user
 *   PUT  /api/admin/dealers/:id        — update a dealer user's branch access + metadata
 *   DELETE /api/admin/dealers/:id      — remove a user's access entirely
 *
 * Multi-branch access: a dealer/branch user's real access comes from
 * user_dealer_access (one row per granted branch) — users.dealer_id is kept
 * only as a legacy display convenience (first granted branch), never as the
 * source of truth. See dealers.js's getAccessibleDealerRows/canAccessDealer.
 */

import { json } from './index.js';

const SITE_URL   = 'https://analytics.findndrive.co.za';
const FROM_EMAIL = 'noreply@findndrive.co.za';
const FROM_NAME  = 'E-fficient Analytics';
const MAGIC_LINK_EXPIRY_MINUTES = 60 * 24 * 7; // 7 days for invite links

// ── Helpers ───────────────────────────────────────────────────────────────────

function generateToken(length = 32) {
  const bytes = new Uint8Array(length);
  crypto.getRandomValues(bytes);
  return Array.from(bytes).map(b => b.toString(16).padStart(2, '0')).join('');
}

function generateId() {
  return crypto.randomUUID();
}

async function sendInviteEmail(env, { email, token, name }) {
  const link = `${SITE_URL}/auth/verify?token=${token}`;
  const greeting = name || 'there';

  const html = `
    <!DOCTYPE html>
    <html>
    <body style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; background: #f8fafc; margin: 0; padding: 40px 20px;">
      <div style="max-width: 480px; margin: 0 auto; background: white; border-radius: 24px; padding: 40px; border: 1px solid #e2e8f0;">
        <div style="text-align: center; margin-bottom: 32px;">
          <table role="presentation" style="margin: 0 auto 12px; border-collapse: collapse;">
            <tr>
              <td style="width: 48px; height: 48px; background: #0f766e; border-radius: 16px; text-align: center; vertical-align: middle;">
                <span style="color: white; font-size: 20px; font-weight: 900; line-height: 48px; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;">E</span>
              </td>
            </tr>
          </table>
          <p style="margin: 0; font-size: 13px; font-weight: 600; color: #475569; letter-spacing: 0.05em;">E-FFICIENT ANALYTICS</p>
        </div>

        <h1 style="font-size: 22px; font-weight: 700; color: #0f172a; margin: 0 0 8px;">You've been invited</h1>
        <p style="font-size: 15px; color: #64748b; margin: 0 0 32px;">
          Hi ${greeting}, you've been given access to E-fficient Analytics.
          Click below to sign in — this link expires in 7 days.
        </p>

        <a href="${link}" style="display: block; text-align: center; background: #0f766e; color: white; text-decoration: none; padding: 14px 24px; border-radius: 12px; font-size: 15px; font-weight: 600; margin-bottom: 24px;">
          Access your dashboard
        </a>

        <p style="font-size: 13px; color: #94a3b8; margin: 0; text-align: center;">
          If you didn't expect this invitation, you can safely ignore this email.
        </p>

        <hr style="border: none; border-top: 1px solid #e2e8f0; margin: 24px 0;" />
        <p style="font-size: 12px; color: #cbd5e1; margin: 0; text-align: center;">
          Find &amp; Drive Group (Pty) Ltd · ${SITE_URL}
        </p>
      </div>
    </body>
    </html>
  `;

  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${env.RESEND_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      from:    `${FROM_NAME} <${FROM_EMAIL}>`,
      to:      [email],
      subject: `You've been invited to E-fficient Analytics`,
      html,
    }),
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Failed to send invite email: ${body}`);
  }
}

// ── Route handler ─────────────────────────────────────────────────────────────

export async function handleAdmin(request, env, path, method, dealer) {
  if (!dealer.isAdmin) {
    return json({ error: 'Forbidden — admin access only' }, 403);
  }

  if (!env.DB) {
    return json({ error: 'Database not configured' }, 500);
  }

  const subPath = path.replace('/api/admin', '') || '/';

  // GET /api/admin/overview — internal team + grouped dealer list
  if (subPath === '/overview' && method === 'GET') {
    try {
      const [internalResult, groupsResult, dealersResult, accessResult] = await Promise.all([
        env.DB.prepare(
          `SELECT id, email, last_sign_in_at, created_at, status FROM users WHERE is_admin = 1 ORDER BY email`
        ).all(),
        env.DB.prepare(`SELECT id, name FROM groups ORDER BY name`).all(),
        env.DB.prepare(`SELECT id, name, group_id, finance_type, has_website FROM dealers ORDER BY name`).all(),
        // Multi-branch aware: join user_dealer_access → users, so a user
        // granted access to several branches appears under each of them.
        env.DB.prepare(`
          SELECT uda.dealer_id, u.id, u.email, u.last_sign_in_at, u.created_at, u.status
          FROM user_dealer_access uda
          INNER JOIN users u ON u.id = uda.user_id
          WHERE u.is_admin = 0
          ORDER BY u.email
        `).all(),
      ]);

      // Group-level admins are separate — they have group_id set, no dealer_id/junction rows
      const groupAdminsResult = await env.DB.prepare(
        `SELECT id, email, group_id, last_sign_in_at, created_at, status
         FROM users WHERE is_admin = 0 AND group_id IS NOT NULL`
      ).all();

      const internalUsers = (internalResult.results || []).map(u => ({
        id:         u.id,
        email:      u.email,
        lastSignIn: u.last_sign_in_at,
        createdAt:  u.created_at,
        status:     u.status || 'invited',
      }));

      const dealers = dealersResult.results || [];
      const accessRows = accessResult.results || [];
      const groupAdminRows = groupAdminsResult.results || [];

      const usersByDealer = {};
      for (const row of accessRows) {
        if (!usersByDealer[row.dealer_id]) usersByDealer[row.dealer_id] = [];
        usersByDealer[row.dealer_id].push({
          id:          row.id,
          email:       row.email,
          lastSignIn:  row.last_sign_in_at,
          createdAt:   row.created_at,
          status:      row.status || 'invited',
        });
      }

      const groupAdmins = {};
      for (const u of groupAdminRows) {
        if (!groupAdmins[u.group_id]) groupAdmins[u.group_id] = [];
        groupAdmins[u.group_id].push({
          id:          u.id,
          email:       u.email,
          lastSignIn:  u.last_sign_in_at,
          createdAt:   u.created_at,
          status:      u.status || 'invited',
        });
      }

      const dealerNode = (d) => ({
        id:          d.id,
        name:        d.name,
        financeType: d.finance_type,
        hasWebsite:  d.has_website === 1,
        users:       usersByDealer[d.id] || [],
      });

      const groups = (groupsResult.results || []).map(g => ({
        id:         g.id,
        name:       g.name,
        admins:     groupAdmins[g.id] || [],
        dealers:    dealers.filter(d => d.group_id === g.id).map(dealerNode),
      }));

      const standaloneDealers = dealers
        .filter(d => !d.group_id)
        .map(dealerNode);

      return json({ internalUsers, groups, standaloneDealers });
    } catch (err) {
      return json({ error: err.message }, 500);
    }
  }

  // POST /api/admin/invite — invite a dealer (one or more branches), group admin, or internal user
  if (subPath === '/invite' && method === 'POST') {
    let body = {};
    try { body = await request.json(); } catch {}

    const {
      email,
      inviteType,      // 'dealer' | 'groupAdmin' | 'internal'
      dealerIds,        // string[] — one or more D1 dealer ids for a 'dealer' invite
      dealerName,       // used only when a dealerId doesn't already exist as a dealers row
      financeType,
      groupId,
      groupName,
    } = body;

    if (!email) {
      return json({ error: 'email is required' }, 400);
    }

    const normalizedEmail = email.toLowerCase().trim();

    const existing = await env.DB.prepare(
      `SELECT id FROM users WHERE email = ?`
    ).bind(normalizedEmail).first();

    if (existing) {
      return json({ error: `${email} already has an account` }, 409);
    }

    const id        = generateId();
    const token     = generateToken();
    const expiresAt = new Date(Date.now() + MAGIC_LINK_EXPIRY_MINUTES * 60 * 1000).toISOString();

    try {
      if (inviteType === 'internal') {
        await env.DB.prepare(`
          INSERT INTO users (id, email, is_admin, invite_token, invite_expires_at, status)
          VALUES (?, ?, 1, ?, ?, 'invited')
        `).bind(id, normalizedEmail, token, expiresAt).run();

      } else if (inviteType === 'groupAdmin') {
        if (!groupId) return json({ error: 'groupId is required for a group admin invite' }, 400);

        await env.DB.prepare(
          `INSERT OR IGNORE INTO groups (id, name) VALUES (?, ?)`
        ).bind(groupId, groupName || groupId).run();

        await env.DB.prepare(`
          INSERT INTO users (id, email, group_id, is_admin, role, invite_token, invite_expires_at, status)
          VALUES (?, ?, ?, 0, 'admin', ?, ?, 'invited')
        `).bind(id, normalizedEmail, groupId, token, expiresAt).run();

      } else {
        // Dealer/branch invite — one or more branches via user_dealer_access.
        const ids = Array.isArray(dealerIds) ? dealerIds.filter(Boolean) : [];
        if (ids.length === 0) {
          return json({ error: 'At least one dealerId is required for a dealer invite' }, 400);
        }

        const slugs = ids.map(d => d.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, ''));

        // users.dealer_id/dealer_name kept only as a legacy display
        // convenience (first granted branch) — real access is the junction
        // rows below, checked first by dealers.js.
        const primarySlug = slugs[0];
        await env.DB.prepare(`
          INSERT INTO users (id, email, dealer_id, dealer_name, finance_type, is_admin, invite_token, invite_expires_at, status)
          VALUES (?, ?, ?, ?, ?, 0, ?, ?, 'invited')
        `).bind(id, normalizedEmail, primarySlug, dealerName || primarySlug, financeType || 'vehicle', token, expiresAt).run();

        for (const slug of slugs) {
          // Ensure the dealer row exists (in case it wasn't onboarded via the automated flow)
          await env.DB.prepare(`
            INSERT INTO dealers (id, name, group_id, finance_type, has_website)
            VALUES (?, ?, ?, ?, 0)
            ON CONFLICT(id) DO NOTHING
          `).bind(slug, dealerName || slug, groupId || null, financeType || 'vehicle').run();

          await env.DB.prepare(
            `INSERT OR IGNORE INTO user_dealer_access (user_id, dealer_id) VALUES (?, ?)`
          ).bind(id, slug).run();
        }
      }

      await sendInviteEmail(env, { email: normalizedEmail, token, name: dealerName || groupName || '' });

      return json({ success: true, message: `Invite sent to ${email}`, userId: id });
    } catch (err) {
      await env.DB.prepare(`DELETE FROM users WHERE id = ?`).bind(id).run().catch(() => {});
      await env.DB.prepare(`DELETE FROM user_dealer_access WHERE user_id = ?`).bind(id).run().catch(() => {});
      return json({ error: err.message }, 500);
    }
  }

  // PUT /api/admin/dealers/:id — replace a user's branch access set + metadata
  const idMatch = subPath.match(/^\/dealers\/([a-zA-Z0-9-_]+)$/);
  if (idMatch && method === 'PUT') {
    const userId = idMatch[1];
    let body = {};
    try { body = await request.json(); } catch {}

    const { dealerIds, dealerName, financeType } = body;
    const ids = Array.isArray(dealerIds) ? dealerIds.filter(Boolean) : [];

    if (ids.length === 0) {
      return json({ error: 'At least one dealerId is required' }, 400);
    }

    try {
      // Replace-set semantics: clear existing grants, insert the new set.
      await env.DB.prepare(`DELETE FROM user_dealer_access WHERE user_id = ?`).bind(userId).run();

      for (const rawId of ids) {
        const slug = rawId.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
        await env.DB.prepare(
          `INSERT OR IGNORE INTO user_dealer_access (user_id, dealer_id) VALUES (?, ?)`
        ).bind(userId, slug).run();
      }

      // Update legacy display fields to the first branch in the new set
      const primarySlug = ids[0].toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
      await env.DB.prepare(`
        UPDATE users SET dealer_id = ?, dealer_name = ?, finance_type = ? WHERE id = ?
      `).bind(primarySlug, dealerName || primarySlug, financeType || 'vehicle', userId).run();

      return json({ success: true, message: `Access updated (${ids.length} branch${ids.length === 1 ? '' : 'es'})` });
    } catch (err) {
      return json({ error: err.message }, 500);
    }
  }

  // DELETE /api/admin/dealers/:id — remove a user's access entirely
  if (idMatch && method === 'DELETE') {
    const userId = idMatch[1];
    try {
      await env.DB.prepare(`DELETE FROM user_dealer_access WHERE user_id = ?`).bind(userId).run();
      await env.DB.prepare(`DELETE FROM users WHERE id = ? AND is_admin = 0`).bind(userId).run();
      return json({ success: true, message: 'Access removed' });
    } catch (err) {
      return json({ error: err.message }, 500);
    }
  }

  return json({ error: 'Not found' }, 404);
}
