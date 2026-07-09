/**
 * admin.js — Cloudflare Worker admin routes
 *
 * All routes require a valid Supabase JWT from an admin email.
 * Dealer data is read from Supabase Auth (users list).
 *
 * Secrets required:
 *   SUPABASE_URL
 *   SUPABASE_SERVICE_ROLE_KEY
 *   SUPABASE_JWT_SECRET  (already set)
 *
 * D1 binding required:
 *   DB — postal-codes-db (see wrangler.toml)
 *
 * Routes:
 *   GET  /api/admin/dealers            — list all dealer users
 *   POST /api/admin/invite             — invite a new dealer
 *   PUT  /api/admin/dealers/:id        — update dealer metadata
 *   GET  /api/admin/stats              — usage stats per dealer (from KV cache)
 *   GET  /api/admin/policies           — policy_events summary (all dealers)
 *   GET  /api/admin/policies/:dealer   — policy_events summary (one dealer)
 */

import { json } from './index.js';

const ADMIN_EMAILS = [
  'mpho@findndrive.co.za',
  'luzuko@findndrive.co.za',
  'anric@seritisolutions.com',
  'liezels@seritisolutions.com',
];

const SITE_URL = 'https://analytics.findndrive.co.za';

// ── Auth check ────────────────────────────────────────────────────────────────

function isAdmin(email) {
  return ADMIN_EMAILS.includes((email || '').toLowerCase());
}

// ── Supabase Admin helpers ────────────────────────────────────────────────────

async function supabaseFetch(env, path, options = {}) {
  const res = await fetch(`${env.SUPABASE_URL}/auth/v1/admin${path}`, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`,
      'apikey': env.SUPABASE_SERVICE_ROLE_KEY,
      ...(options.headers || {}),
    },
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.message || data.msg || `HTTP ${res.status}`);
  return data;
}

// ── Policy summary helpers ────────────────────────────────────────────────────

async function queryPolicySummary(env, dealerKey = null) {
  if (!env.DB) throw new Error('D1 database not bound — check wrangler.toml');

  const whereClause = dealerKey ? `WHERE dealer_key = ?` : '';
  const params      = dealerKey ? [dealerKey] : [];

  // Overall totals per dealer
  const totalsResult = await env.DB.prepare(`
    SELECT
      dealer_key,
      finance_type,
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

  // Finance status breakdown
  const financeStatusResult = await env.DB.prepare(`
    SELECT
      dealer_key,
      finance_type,
      finance_company,
      finance_status,
      COUNT(*) as count
    FROM policy_events
    ${whereClause}
    GROUP BY dealer_key, finance_type, finance_company, finance_status
    ORDER BY dealer_key, count DESC
  `).bind(...params).all();

  // Transaction status breakdown
  const transactionStatusResult = await env.DB.prepare(`
    SELECT
      dealer_key,
      transaction_status,
      COUNT(*) as count
    FROM policy_events
    ${whereClause}
    GROUP BY dealer_key, transaction_status
    ORDER BY dealer_key, count DESC
  `).bind(...params).all();

  // Finance company breakdown (non-null only)
  const fcWhere  = dealerKey
    ? `WHERE dealer_key = ? AND finance_company IS NOT NULL`
    : `WHERE finance_company IS NOT NULL`;
  const fcParams = dealerKey ? [dealerKey] : [];

  const financeCompanyResult = await env.DB.prepare(`
    SELECT
      dealer_key,
      finance_company,
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
  // Admin check — only allowed emails can access these routes
  if (!isAdmin(dealer.email)) {
    return json({ error: 'Forbidden — admin access only' }, 403);
  }

  if (!env.SUPABASE_URL || !env.SUPABASE_SERVICE_ROLE_KEY) {
    return json({ error: 'Supabase admin credentials not configured' }, 500);
  }

  const subPath = path.replace('/api/admin', '') || '/';

  // GET /api/admin/dealers — list all dealer users
  if (subPath === '/dealers' && method === 'GET') {
    try {
      const data = await supabaseFetch(env, '/users?per_page=100');
      const dealers = (data.users || [])
        .filter(u => u.app_metadata?.dealer_id)
        .map(u => ({
          id:          u.id,
          email:       u.email,
          dealerId:    u.app_metadata?.dealer_id,
          dealerName:  u.app_metadata?.dealer_name,
          financeType: u.app_metadata?.finance_type || 'vehicle',
          lastSignIn:  u.last_sign_in_at,
          createdAt:   u.created_at,
          confirmedAt: u.confirmed_at,
          status: !u.confirmed_at ? 'invited' : u.last_sign_in_at ? 'active' : 'pending',
        }));
      return json({ dealers });
    } catch (err) {
      return json({ error: err.message }, 502);
    }
  }

  // POST /api/admin/invite — invite a new dealer
  if (subPath === '/invite' && method === 'POST') {
    let body = {};
    try { body = await request.json(); } catch {}

    const { email, dealerId, dealerName, financeType } = body;

    if (!email || !dealerId || !dealerName) {
      return json({ error: 'email, dealerId and dealerName are required' }, 400);
    }

    const slug = dealerId.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');

    try {
      const user = await supabaseFetch(env, '/invite', {
        method: 'POST',
        body: JSON.stringify({
          email,
          options: {
            redirectTo: `${SITE_URL}/auth/reset-password`,
            data: { dealer_id: slug, dealer_name: dealerName, finance_type: financeType || 'vehicle' },
          },
        }),
      });

      await supabaseFetch(env, `/users/${user.id}`, {
        method: 'PUT',
        body: JSON.stringify({
          app_metadata: {
            dealer_id:    slug,
            dealer_name:  dealerName,
            finance_type: financeType || 'vehicle',
          },
        }),
      });

      return json({ success: true, message: `Invite sent to ${email}`, userId: user.id });
    } catch (err) {
      return json({ error: err.message }, 400);
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
      await supabaseFetch(env, `/users/${userId}`, {
        method: 'PUT',
        body: JSON.stringify({
          app_metadata: {
            dealer_id:    dealerId,
            dealer_name:  dealerName,
            finance_type: financeType || 'vehicle',
          },
        }),
      });
      return json({ success: true, message: `Dealer ${dealerName} updated` });
    } catch (err) {
      return json({ error: err.message }, 400);
    }
  }

  // GET /api/admin/stats — usage stats per dealer from KV cache
  if (subPath === '/stats' && method === 'GET') {
    try {
      const index = await env.CACHE.get('master:index');
      if (!index) return json({ stats: [] });

      const parsed = JSON.parse(index);
      const stats = (parsed.dealers || []).map(d => ({
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
      console.error('[admin] policies error:', err.message);
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
      console.error('[admin] policies error:', err.message);
      return json({ error: err.message }, 500);
    }
  }

  return json({ error: 'Not found' }, 404);
}
