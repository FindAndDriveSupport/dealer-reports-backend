/**
 * admin.js — Cloudflare Worker admin routes
 *
 * All routes require a valid JWT from an admin user (is_admin = 1 in D1).
 *
 * D1 binding required: DB (postal-codes-db)
 *
 * Routes:
 *   GET  /api/admin/dealers            — list all dealer users
 *   POST /api/admin/invite             — invite a new dealer (creates D1 user + sends magic link)
 *   PUT  /api/admin/dealers/:id        — update dealer metadata
 *   DELETE /api/admin/dealers/:id      — remove dealer access
 *   GET  /api/admin/stats              — usage stats per dealer (from KV cache)
 *   GET  /api/admin/policies           — policy_events summary (all dealers)
 *   GET  /api/admin/policies/:dealer   — policy_events summary (one dealer)
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

async function sendInviteEmail(env, { email, token, dealerName }) {
  const link = `${SITE_URL}/auth/verify?token=${token}`;
  const name = dealerName || 'there';

  const html = `
    <!DOCTYPE html>
    <html>
    <body style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; background: #f8fafc; margin: 0; padding: 40px 20px;">
      <div style="max-width: 480px; margin: 0 auto; background: white; border-radius: 24px; padding: 40px; border: 1px solid #e2e8f0;">
        <div style="text-align: center; margin-bottom: 32px;">
          <div style="display: inline-flex; align-items: center; justify-content: center; width: 48px; height: 48px; background: #0f766e; border-radius: 16px; margin-bottom: 12px;">
            <span style="color: white; font-size: 20px; font-weight: 900;">E</span>
          </div>
          <p style="margin: 0; font-size: 13px; font-weight: 600; color: #475569; letter-spacing: 0.05em;">E-FFICIENT ANALYTICS</p>
        </div>

        <h1 style="font-size: 22px; font-weight: 700; color: #0f172a; margin: 0 0 8px;">You've been invited</h1>
        <p style="font-size: 15px; color: #64748b; margin: 0 0 32px;">
          Hi ${name}, you've been given access to your E-fficient Analytics dashboard.
          Click below to set up your account — this link expires in 7 days.
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

// ── Policy summary ────────────────────────────────────────────────────────────

async function queryPolicySummary(env, dealerKey = null) {
  if (!env.DB) throw new Error('D1 database not bound — check wrangler.toml');

  const whereClause = dealerKey ? `WHERE dealer_key = ?` : '';
  const params      = dealerKey ? [dealerKey] : [];

  const totalsResult = await env.DB.prepare(`
    SELECT
      dealer_key, finance_type,
      COUNT(*) as total_policies,
      COUNT(CASE WHEN finance_status = 'PAID OUT' THEN 1 END) as paid_out,
      COUNT(CASE WHEN finance_status = 'DECLINED' THEN 1 END) as declined,
      COUNT(CASE WHEN transaction_status = 'DELIVERED' THEN 1 END) as delivered,
      COUNT(CASE WHEN transaction_status = 'DUPLICATE DEAL' THEN 1 END) as duplicate_deals,
      COUNT(CASE WHEN transaction_status LIKE 'AWAITING%' THEN 1 END) as awaiting_delivery,
      MIN(created_at) as earliest,
      MAX(created_at) as latest
    FROM policy_events
    ${whereClause}
    GROUP BY dealer_key, finance_type
    ORDER BY dealer_key
  `).bind(...params).all();

  const financeStatusResult = await env.DB.prepare(`
    SELECT dealer_key, finance_type, finance_company, finance_status, COUNT(*) as count
    FROM policy_events
    ${whereClause}
    GROUP BY dealer_key, finance_type, finance_company, finance_status
    ORDER BY dealer_key, count DESC
  `).bind(...params).all();

  const transactionStatusResult = await env.DB.prepare(`
    SELECT dealer_key, transaction_status, COUNT(*) as count
    FROM policy_events
    ${whereClause}
    GROUP BY dealer_key, transaction_status
    ORDER BY dealer_key, count DESC
  `).bind(...params).all();

  const fcWhere  = dealerKey
    ? `WHERE dealer_key = ? AND finance_company IS NOT NULL`
    : `WHERE finance_company IS NOT NULL`;
  const fcParams = dealerKey ? [dealerKey] : [];

  const financeCompanyResult = await env.DB.prepare(`
    SELECT dealer_key, finance_company,
      COUNT(*) as count,
      COUNT(CASE WHEN finance_status = 'PAID OUT' THEN 1 END) as paid_out
    FROM policy_events
    ${fcWhere}
    GROUP BY dealer_key, finance_company
    ORDER BY dealer_key, count DESC
  `).bind(...fcParams).all();

  return {
    totals:            totalsResult.results        || [],
    financeStatus:     financeStatusResult.results || [],
    transactionStatus: transactionStatusResult.results || [],
    financeCompany:    financeCompanyResult.results || [],
  };
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

  // GET /api/admin/dealers — list all dealer users from D1
  if (subPath === '/dealers' && method === 'GET') {
    try {
      const result = await env.DB.prepare(
        `SELECT id, email, dealer_id, dealer_name, finance_type, is_admin,
                last_sign_in_at, created_at, status
         FROM users
         ORDER BY created_at DESC`
      ).all();

      const dealers = (result.results || []).map(u => ({
        id:          u.id,
        email:       u.email,
        dealerId:    u.dealer_id,
        dealerName:  u.dealer_name,
        financeType: u.finance_type || 'vehicle',
        isAdmin:     u.is_admin === 1,
        lastSignIn:  u.last_sign_in_at,
        createdAt:   u.created_at,
        status:      u.status || 'invited',
      }));

      return json({ dealers });
    } catch (err) {
      return json({ error: err.message }, 500);
    }
  }

  // POST /api/admin/invite — create D1 user + send invite email
  if (subPath === '/invite' && method === 'POST') {
    let body = {};
    try { body = await request.json(); } catch {}

    const { email, dealerId, dealerName, financeType } = body;

    if (!email || !dealerId || !dealerName) {
      return json({ error: 'email, dealerId and dealerName are required' }, 400);
    }

    const slug = dealerId.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');

    // Check if user already exists
    const existing = await env.DB.prepare(
      `SELECT id FROM users WHERE email = ?`
    ).bind(email.toLowerCase()).first();

    if (existing) {
      return json({ error: `${email} already has an account` }, 409);
    }

    const id         = generateId();
    const token      = generateToken();
    const expiresAt  = new Date(Date.now() + MAGIC_LINK_EXPIRY_MINUTES * 60 * 1000).toISOString();

    try {
      await env.DB.prepare(`
        INSERT INTO users (id, email, dealer_id, dealer_name, finance_type, is_admin, invite_token, invite_expires_at, status)
        VALUES (?, ?, ?, ?, ?, 0, ?, ?, 'invited')
      `).bind(id, email.toLowerCase(), slug, dealerName, financeType || 'vehicle', token, expiresAt).run();

      await sendInviteEmail(env, { email, token, dealerName });

      return json({ success: true, message: `Invite sent to ${email}`, userId: id });
    } catch (err) {
      // Clean up if email failed
      await env.DB.prepare(`DELETE FROM users WHERE id = ?`).bind(id).run().catch(() => {});
      return json({ error: err.message }, 500);
    }
  }

  // PUT /api/admin/dealers/:id — update dealer metadata
  const idMatch = subPath.match(/^\/dealers\/([a-zA-Z0-9-]+)$/);
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

  // DELETE /api/admin/dealers/:id — remove dealer
  if (idMatch && method === 'DELETE') {
    const userId = idMatch[1];
    try {
      await env.DB.prepare(`DELETE FROM users WHERE id = ? AND is_admin = 0`).bind(userId).run();
      return json({ success: true, message: 'Dealer removed' });
    } catch (err) {
      return json({ error: err.message }, 500);
    }
  }

  // GET /api/admin/stats — usage stats from KV cache
  if (subPath === '/stats' && method === 'GET') {
    try {
      const index = await env.CACHE.get('master:index');
      if (!index) return json({ stats: [] });

      const parsed = JSON.parse(index);
      const stats  = (parsed.dealers || []).map(d => ({
        dealerId:    d.dealerSlug,
        dealerName:  d.dealerName,
        totalLeads:  d.totalLeads,
        dateRange:   d.dateRange,
        processedAt: d.processedAt,
        financeType: d.financeType,
      }));

      return json({ stats, generatedAt: parsed.generatedAt });
    } catch (err) {
      return json({ error: err.message }, 500);
    }
  }

  // GET /api/admin/policies — all dealers
  if (subPath === '/policies' && method === 'GET') {
    try {
      const summary = await queryPolicySummary(env, null);
      return json(summary);
    } catch (err) {
      return json({ error: err.message }, 500);
    }
  }

  // GET /api/admin/policies/:dealerKey — single dealer
  const policyMatch = subPath.match(/^\/policies\/([a-z0-9-]+)$/);
  if (policyMatch && method === 'GET') {
    const dealerKey = policyMatch[1];
    try {
      const summary = await queryPolicySummary(env, dealerKey);
      return json({ dealerKey, ...summary });
    } catch (err) {
      return json({ error: err.message }, 500);
    }
  }

  return json({ error: 'Not found' }, 404);
}
