/**
 * index.js — Cloudflare Worker entry point
 *
 * Secrets:
 *   SERITI_API_BASE_URL, SERITI_API_KEY_ID, SERITI_API_SECRET
 *   ALLOWED_ORIGINS
 *   MIXPANEL_API_SECRET
 *   EMAIL_PROVIDER, EMAIL_FROM, EMAIL_FROM_NAME, EMAIL_API_KEY
 *   RESEND_API_KEY
 *   JWT_SECRET
 */

import { handleReport }   from './report.js';
import { handleMixpanel } from './mixpanel.js';
import { handleEmail }    from './email.js';
import { handleAdmin }    from './admin.js';
import { handleAuth }     from './auth.js';
import { handleDealers }  from './dealers.js';
import { withAuth }       from './middleware/auth.js';
import { scheduledSync }  from './seritiSync.js';

export default {
  async fetch(request, env, ctx) {
    const url    = new URL(request.url);
    const path   = url.pathname;
    const method = request.method;

    const origin  = request.headers.get('Origin') || '';
    const allowed = (env.ALLOWED_ORIGINS || '*').split(',').map(o => o.trim());
    const corsOk  = allowed.includes('*') || allowed.includes(origin);

    const corsHeaders = {
      'Access-Control-Allow-Origin':  corsOk ? origin : allowed[0],
      'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    };

    if (method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: corsHeaders });
    }

    // ── Public routes — no JWT required ─────────────────────────────────────

    if (path === '/health' && method === 'GET') {
      return json({
        status:    'ok',
        platform:  'Seriti E-fficient API',
        version:   '4.1.0',
        runtime:   'Cloudflare Workers',
        timestamp: new Date().toISOString(),
      }, 200, corsHeaders);
    }

    // Seriti connection health check — deliberately public so it can be used
    // to verify the raw Seriti connection without needing to be logged in.
    if (path === '/api/report/health' && method === 'GET') {
      const response = await handleReport(request, env, path, method, null);
      const headers  = new Headers(response.headers);
      Object.entries(corsHeaders).forEach(([k, v]) => headers.set(k, v));
      return new Response(response.body, { status: response.status, headers });
    }

    if (path.startsWith('/api/auth')) {
      const response = await handleAuth(request, env, path, method);
      const headers  = new Headers(response.headers);
      Object.entries(corsHeaders).forEach(([k, v]) => headers.set(k, v));
      return new Response(response.body, { status: response.status, headers });
    }

    // ── Refresh — admin JWT required ────────────────────────────────────────

    if (path === '/api/report/refresh' && method === 'POST') {
      const response = await withAuth(async (req, e, c, dealer) => {
        if (!dealer.isAdmin) return json({ error: 'Forbidden — admin access only' }, 403);
        return handleReport(req, e, path, method, dealer);
      })(request, env, ctx);

      const headers = new Headers(response.headers);
      Object.entries(corsHeaders).forEach(([k, v]) => headers.set(k, v));
      return new Response(response.body, { status: response.status, headers });
    }

    // ── Protected routes ────────────────────────────────────────────────────

    try {
      let response;

      if (path.startsWith('/api/admin')) {
        response = await withAuth(
          (req, e, c, dealer) => handleAdmin(req, e, path, method, dealer)
        )(request, env, ctx);

      } else if (path.startsWith('/api/dealers')) {
        response = await withAuth(
          (req, e, c, dealer) => handleDealers(req, e, path, method, dealer)
        )(request, env, ctx);

      } else if (path.startsWith('/api/report')) {
        response = await withAuth(
          (req, e, c, dealer) => handleReport(req, e, path, method, dealer)
        )(request, env, ctx);

      } else if (path.startsWith('/api/mixpanel')) {
        response = await withAuth(
          (req, e, c, dealer) => handleMixpanel(req, e, path, method, dealer)
        )(request, env, ctx);

      } else if (path.startsWith('/api/email')) {
        response = await handleEmail(request, env, path, method);

      } else {
        response = json({ error: 'Not found' }, 404);
      }

      const headers = new Headers(response.headers);
      Object.entries(corsHeaders).forEach(([k, v]) => headers.set(k, v));
      return new Response(response.body, { status: response.status, headers });

    } catch (err) {
      console.error(`[worker] ${err.message}`);
      return json(
        { error: err.message || 'Internal server error', timestamp: new Date().toISOString() },
        500,
        corsHeaders
      );
    }
  },

  // Cron Trigger — background sync of Seriti's data into D1, day by day.
  // Configure the schedule in wrangler.toml, e.g.:
  //   [triggers]
  //   crons = ["*/30 * * * *"]   # every 30 minutes
  async scheduled(event, env, ctx) {
    ctx.waitUntil(
      scheduledSync(env, 3).catch(err => {
        console.error('[scheduled] sync failed:', err.message);
      })
    );
  },
};

export function json(data, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json', ...extraHeaders },
  });
}
