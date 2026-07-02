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
 * Routes:
 *   GET  /api/admin/dealers        — list all dealer users
 *   POST /api/admin/invite         — invite a new dealer
 *   PUT  /api/admin/dealers/:id    — update dealer metadata
 *   GET  /api/admin/stats          — usage stats per dealer (from KV cache)
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
  const url = new URL(request.url);

  // GET /api/admin/dealers — list all dealer users
  if (subPath === '/dealers' && method === 'GET') {
    try {
      const data = await supabaseFetch(env, '/users?per_page=100');
      const dealers = (data.users || [])
        .filter(u => u.app_metadata?.dealer_id) // only dealer accounts
        .map(u => ({
          id: u.id,
          email: u.email,
          dealerId: u.app_metadata?.dealer_id,
          dealerName: u.app_metadata?.dealer_name,
          financeType: u.app_metadata?.finance_type || 'vehicle',
          lastSignIn: u.last_sign_in_at,
          createdAt: u.created_at,
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
      // Invite user
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

      // Set app_metadata
      await supabaseFetch(env, `/users/${user.id}`, {
        method: 'PUT',
        body: JSON.stringify({
          app_metadata: {
            dealer_id: slug,
            dealer_name: dealerName,
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
            dealer_id: dealerId,
            dealer_name: dealerName,
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
        dealerId: d.dealerSlug,
        dealerName: d.dealerName,
        totalLeads: d.totalLeads,
        dateRange: d.dateRange,
        processedAt: d.processedAt,
        financeType: d.financeType,
      }));

      return json({ stats, generatedAt: parsed.generatedAt });
    } catch (err) {
      return json({ error: err.message }, 500);
    }
  }

  return json({ error: 'Not found' }, 404);
}
