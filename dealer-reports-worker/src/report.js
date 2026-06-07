/**
 * report.js — Cloudflare Worker edition
 *
 * Handles all /api/report/* routes.
 * No Express — receives (request, env, path, method) from index.js router.
 *
 * Cache strategy: Cloudflare KV (env.CACHE)
 *   Key "master:index"         → dealer index
 *   Key "dealer:{client}:{slug}" → full analytics JSON per dealer
 *   TTL: CACHE_TTL_MINUTES env var (default 60 min)
 *
 * Routes:
 *   GET  /api/report/health
 *   GET  /api/report/index
 *   POST /api/report/refresh
 *   GET  /api/report/:clientSlug/:dealerSlug
 */

import { fetchLeadData, splitByClient, testConnection } from './seritiApiService.js';
import { processRows } from './metricsProcessor.js';
import { json } from './index.js';

const SLUG_RE = /^[a-z0-9-]+$/;

// ─── Cache helpers (KV) ───────────────────────────────────────────────────────

function cacheTtlSeconds(env) {
  return (Number(env.CACHE_TTL_MINUTES) || 60) * 60;
}

async function cacheGet(env, key) {
  try {
    const raw = await env.CACHE.get(key);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

async function cacheSet(env, key, value) {
  await env.CACHE.put(key, JSON.stringify(value), {
    expirationTtl: cacheTtlSeconds(env),
  });
}

async function cacheBust(env) {
  // KV doesn't support bulk delete — list and delete all keys
  const listed = await env.CACHE.list();
  await Promise.all(listed.keys.map(k => env.CACHE.delete(k.name)));
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function dealerSlug(name) {
  return String(name).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
}

function defaultDateRange() {
  const to   = new Date();
  const from = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
  return {
    startDate: from.toISOString().split('T')[0],
    endDate:   to.toISOString().split('T')[0],
  };
}

function extractDateRange(rows) {
  const dates = rows
    .map(r => r.CreatedAt)
    .filter(Boolean)
    .map(d => new Date(d))
    .filter(d => !isNaN(d))
    .sort((a, b) => a - b);
  if (!dates.length) return null;
  return {
    from: dates[0].toISOString().split('T')[0],
    to:   dates[dates.length - 1].toISOString().split('T')[0],
  };
}

// ─── Core: fetch from Seriti, process all dealers, populate KV cache ──────────

async function fetchAndProcessAll(env, { startDate, endDate } = {}) {
  const dates = startDate && endDate
    ? { startDate, endDate }
    : defaultDateRange();

  console.log(`[report] Fetching from Seriti API (${dates.startDate} → ${dates.endDate})...`);

  const allRows = await fetchLeadData(env, dates);

  if (!allRows.length) {
    console.warn('[report] Seriti API returned 0 rows for this date range');
    return [];
  }

  const clientMap   = splitByClient(allRows);
  const clientNames = Object.keys(clientMap);
  console.log(`[report] Processing ${clientNames.length} dealer(s): ${clientNames.join(', ')}`);

  const index = [];

  for (const clientName of clientNames) {
    const rows      = clientMap[clientName];
    const slug      = dealerSlug(clientName);
    const dateRange = extractDateRange(rows);

    try {
      const analytics = processRows(rows, {
        clientName,
        clientSlug: slug,
        dealerName: clientName,
        dealerSlug: slug,
        dateRange,
        source:     'seriti-api',
      });

      await cacheSet(env, `dealer:${slug}:${slug}`, analytics);

      index.push({
        dealerName:  clientName,
        dealerSlug:  slug,
        clientName,
        clientSlug:  slug,
        totalLeads:  analytics.funnel.totalLeads,
        dateRange,
        processedAt: analytics.meta.processedAt,
      });

      console.log(`[report] ✅ ${clientName} — ${rows.length} rows, ${analytics.funnel.totalLeads} unique leads`);
    } catch (err) {
      console.error(`[report] ❌ ${clientName}: ${err.message}`);
    }
  }

  const masterIndex = {
    platform:     'Seriti E-fficient',
    generatedAt:  new Date().toISOString(),
    totalClients: index.length,
    totalDealers: index.length,
    dateRange:    { startDate: dates.startDate, endDate: dates.endDate },
    dealers:      index,
  };

  await cacheSet(env, 'master:index', masterIndex);
  console.log(`[report] Index cached — ${index.length} dealer(s)`);

  return index;
}

// ─── Main route handler ───────────────────────────────────────────────────────

export async function handleReport(request, env, path, method) {
  const url         = new URL(request.url);
  const subPath     = path.replace('/api/report', '') || '/';
  const queryParams = Object.fromEntries(url.searchParams);

  // GET /api/report/health
  if (subPath === '/health' && method === 'GET') {
    const result = await testConnection(env);
    return json(result, result.ok ? 200 : 502);
  }

  // GET /api/report/index
  if (subPath === '/index' && method === 'GET') {
    const cached = await cacheGet(env, 'master:index');
    if (cached) return json({ ...cached, _cached: true });

    await fetchAndProcessAll(env, {
      startDate: queryParams.startDate,
      endDate:   queryParams.endDate,
    });

    const index = await cacheGet(env, 'master:index');
    if (!index) return json({ error: 'Failed to build dealer index from Seriti API' }, 502);

    return json({ ...index, _cached: false });
  }

  // POST /api/report/refresh
  if (subPath === '/refresh' && method === 'POST') {
    const secret = env.WEBHOOK_SECRET;
    if (secret && request.headers.get('x-webhook-secret') !== secret) {
      return json({ error: 'Unauthorized' }, 401);
    }

    let body = {};
    try { body = await request.json(); } catch { /* no body is fine */ }

    const { startDate, endDate } = body;

    console.log('[report] Manual refresh triggered');
    await cacheBust(env);

    const dealers = await fetchAndProcessAll(env, { startDate, endDate });

    return json({
      success:     true,
      message:     `Refreshed ${dealers.length} dealer(s)`,
      dealers:     dealers.map(d => d.dealerName),
      processedAt: new Date().toISOString(),
    });
  }

  // GET /api/report/:clientSlug/:dealerSlug
  const slugMatch = subPath.match(/^\/([a-z0-9-]+)\/([a-z0-9-]+)$/);
  if (slugMatch && method === 'GET') {
    const [, clientSlug, dSlug] = slugMatch;

    if (!SLUG_RE.test(clientSlug) || !SLUG_RE.test(dSlug)) {
      return json({ error: 'Invalid slug format' }, 400);
    }

    const CACHE_KEY = `dealer:${clientSlug}:${dSlug}`;
    const cached    = await cacheGet(env, CACHE_KEY);
    if (cached) return json({ ...cached, _cached: true });

    console.log(`[report] Cache miss for ${clientSlug}/${dSlug} — fetching all from Seriti...`);
    await fetchAndProcessAll(env, {
      startDate: queryParams.startDate,
      endDate:   queryParams.endDate,
    });

    const report = await cacheGet(env, CACHE_KEY);
    if (!report) {
      return json({
        error: `Dealer not found: "${dSlug}"`,
        hint:  'Check /api/report/index to see available dealers',
      }, 404);
    }

    return json({ ...report, _cached: false });
  }

  return json({ error: 'Not found' }, 404);
}
