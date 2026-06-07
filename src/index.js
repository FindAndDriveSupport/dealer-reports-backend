/**
 * index.js — Cloudflare Worker entry point
 *
 * Replaces Express. Routes requests manually to handler functions.
 * env is passed into every handler — no process.env anywhere.
 *
 * KV namespace bindings (set in wrangler.toml + Cloudflare dashboard):
 *   CACHE  — dealer report data + master index
 *   TOKENS — Seriti JWT token cache
 *
 * Secrets (set via `wrangler secret put` or dashboard):
 *   SERITI_API_BASE_URL
 *   SERITI_API_KEY_ID
 *   SERITI_API_SECRET
 *   WEBHOOK_SECRET
 *   ALLOWED_ORIGINS
 *   MIXPANEL_SERVICE_ACCOUNT_USERNAME
 *   MIXPANEL_SERVICE_ACCOUNT_SECRET
 *   MIXPANEL_PROJECT_ID
 *   EMAIL_PROVIDER
 *   EMAIL_FROM
 *   EMAIL_FROM_NAME
 *   EMAIL_API_KEY
 */

import { handleReport }   from './report.js';
import { handleMixpanel } from './mixpanel.js';
import { handleEmail }    from './email.js';

export default {
  async fetch(request, env, ctx) {
    const url    = new URL(request.url);
    const path   = url.pathname;
    const method = request.method;

    // ── CORS ──────────────────────────────────────────────────────────────────
    const origin  = request.headers.get('Origin') || '';
    const allowed = (env.ALLOWED_ORIGINS || '*').split(',').map(o => o.trim());
    const corsOk  = allowed.includes('*') || allowed.includes(origin);

    const corsHeaders = {
      'Access-Control-Allow-Origin':  corsOk ? origin : allowed[0],
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, x-webhook-secret',
    };

    if (method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: corsHeaders });
    }

    // ── Health ────────────────────────────────────────────────────────────────
    if (path === '/health' && method === 'GET') {
      return json({
        status:    'ok',
        platform:  'Seriti E-fficient API',
        version:   '2.0.0',
        runtime:   'Cloudflare Workers',
        timestamp: new Date().toISOString(),
      }, 200, corsHeaders);
    }

    // ── Route dispatch ────────────────────────────────────────────────────────
    try {
      let response;

      if (path.startsWith('/api/report')) {
        response = await handleReport(request, env, path, method);
      } else if (path.startsWith('/api/mixpanel')) {
        response = await handleMixpanel(request, env, path, method);
      } else if (path.startsWith('/api/email')) {
        response = await handleEmail(request, env, path, method);
      } else {
        response = json({ error: 'Not found' }, 404);
      }

      // Attach CORS headers to every response
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
};

// ── Shared helper — used by all route handlers ────────────────────────────────
export function json(data, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'Content-Type': 'application/json',
      ...extraHeaders,
    },
  });
}
