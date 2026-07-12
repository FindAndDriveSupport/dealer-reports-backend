/**
 * admin.js — Cloudflare Worker admin routes
 *
 * All routes require a valid JWT from an admin user (is_admin = 1 in D1).
 *
 * Routes:
 *   GET  /api/admin/overview           — internal team + grouped dealer list
 *   POST /api/admin/invite             — invite a new dealer or internal user
 *   PUT  /api/admin/dealers/:id        — update dealer metadata
 *   DELETE /api/admin/dealers/:id      — remove dealer access
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
      const [internalResult, groupsResult, dealersResult, dealerUsersResult] = await Promise.all([
        env.DB.prepare(
          `SELECT id, email, last_sign_in_at, created_at, status FROM users WHERE is_admin = 1 ORDER BY email`
        ).all(),
        env.DB.prepare(`SELECT id, name FROM groups ORDER BY name`).all(),
        env.DB.prepare(`SELECT id, name, group_id, finance_type, has_website FROM dealers ORDER BY name`).all(),
        env.DB.prepare(
          `SELECT id, email, dealer_id, group_id, finance_type, last_sign_in_at, created_at, status
           FROM users WHERE is_admin = 0 ORDER BY email`
        ).all(),
      ]);

      const internalUsers = (internalResult.results || []).map(u => ({
        id:         u.id,
        email:      u.email,
        lastSignIn: u.last_sign_in_at,
        createdAt:  u.created_at,
        status:     u.status || 'invited',
      }));

      const dealers = dealersResult.results || [];
      const dealerUsers = dealerUsersResult.results || [];

      // Attach users to each dealer (a dealer can have multiple branch users, though usually one)
      const usersByDealer = {};
      for (const u of dealerUsers) {
        if (!u.dealer_id) continue;
        if (!usersByDealer[u.dealer_id]) usersByDealer[u.dealer_id] = [];
        usersByDealer[u.dealer_id].push({
          id:          u.id,
          email:       u.email,
          lastSignIn:  u.last_sign_in_at,
          createdAt:   u.created_at,
          status:      u.status || 'invited',
        });
      }

      // Also track group-level admins (users with group_id set, dealer_id null)
      const groupAdmins = {};
      for (const u of dealerUsers) {
        if (!u.group_id || u.dealer_id) continue;
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

  // POST /api/admin/invite — invite a dealer (branch), group admin, or internal user
  if (subPath === '/invite' && method === 'POST') {
    let body = {};
    try { body = await request.json(); } catch {}

    const {
      email,
      inviteType,      // 'dealer' | 'groupAdmin' | 'internal'
      dealerId,
      dealerName,
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
        // Default: dealer (branch-level) invite
        if (!dealerId || !dealerName) {
          return json({ error: 'dealerId and dealerName are required for a dealer invite' }, 400);
        }
        const slug = dealerId.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');

        // Ensure the dealer row exists (in case it wasn't onboarded via the automated flow)
        await env.DB.prepare(`
          INSERT INTO dealers (id, name, group_id, finance_type, has_website)
          VALUES (?, ?, ?, ?, 0)
          ON CONFLICT(id) DO NOTHING
        `).bind(slug, dealerName, groupId || null, financeType || 'vehicle').run();

        await env.DB.prepare(`
          INSERT INTO users (id, email, dealer_id, dealer_name, finance_type, is_admin, invite_token, invite_expires_at, status)
          VALUES (?, ?, ?, ?, ?, 0, ?, ?, 'invited')
        `).bind(id, normalizedEmail, slug, dealerName, financeType || 'vehicle', token, expiresAt).run();
      }

      await sendInviteEmail(env, { email: normalizedEmail, token, name: dealerName || groupName || '' });

      return json({ success: true, message: `Invite sent to ${email}`, userId: id });
    } catch (err) {
      await env.DB.prepare(`DELETE FROM users WHERE id = ?`).bind(id).run().catch(() => {});
      return json({ error: err.message }, 500);
    }
  }

  // PUT /api/admin/dealers/:id — update dealer metadata
  const idMatch = subPath.match(/^\/dealers\/([a-zA-Z0-9-_]+)$/);
  if (idMatch && method === 'PUT') {
    const userId = idMatch[1];
    let body = {};
    try { body = await request.json(); } catch {}

    const { dealerId, dealerName, financeType } = body;
    if (!dealerId || !dealerName) {
      return json({ error: 'dealerId and dealerName are required' }, 400);
    }

    try {
      await env.DB.prepare(`
        UPDATE users SET dealer_id = ?, dealer_name = ?, finance_type = ? WHERE id = ?
      `).bind(dealerId, dealerName, financeType || 'vehicle', userId).run();
      return json({ success: true, message: `Dealer ${dealerName} updated` });
    } catch (err) {
      return json({ error: err.message }, 500);
    }
  }

  // DELETE /api/admin/dealers/:id — remove dealer access
  if (idMatch && method === 'DELETE') {
    const userId = idMatch[1];
    try {
      await env.DB.prepare(`DELETE FROM users WHERE id = ? AND is_admin = 0`).bind(userId).run();
      return json({ success: true, message: 'Access removed' });
    } catch (err) {
      return json({ error: err.message }, 500);
    }
  }

  return json({ error: 'Not found' }, 404);
}
