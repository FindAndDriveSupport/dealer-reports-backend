/**
 * report.js — Cloudflare Worker edition
 *
 * Handles all /api/report/* routes.
 * No Express — receives (request, env, path, method, dealer) from index.js router.
 *
 * The `dealer` object is injected by withAuth() middleware and contains:
 *   dealer.dealerId    — verified dealer slug (e.g. "yonda")
 *   dealer.dealerName  — display name
 *   dealer.financeType — "vehicle" | "bike"
 *
 * Cache strategy: Cloudflare KV (env.CACHE)
 *   Key "master:index"           → dealer index
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

// ─── Applications override — real policy_events count from D1 ────────────────
// Seriti's "SubmittedOn" field only reflects the widget/journey's own
// submission flag, not whether a real policy was actually created in Edith.
// policy_events (D1) is the authoritative record of applications actually
// created, so this overrides funnel.applicationsSubmitted (and recalculates
// the Pre-Approval → Application conversion rate) whenever a D1 dealer id
// is supplied alongside the request.
async function overrideApplicationsFromPolicies(env, report, dealerId, startDate, endDate) {
  if (!env.DB || !dealerId) return report;

  const from = startDate || report.meta?.dateRange?.from;
  const to   = endDate   || report.meta?.dateRange?.to;
  if (!from || !to) return report;

  try {
    const row = await env.DB.prepare(
      `SELECT COUNT(*) as count FROM policy_events WHERE dealer_key = ? AND created_at >= ? AND created_at <= ?`
    ).bind(dealerId, `${from}T00:00:00`, `${to}T23:59:59.999`).first();

    const applicationsSubmitted = row?.count ?? 0;
    const preApprovals = report.funnel.preApprovals;
    const preApprovalToApplication = preApprovals > 0
      ? +((applicationsSubmitted / preApprovals) * 100).toFixed(1)
      : 0;

    console.log(`[report] Applications overridden from policy_events: ${applicationsSubmitted} (dealer_key=${dealerId})`);

    return {
      ...report,
      funnel: {
        ...report.funnel,
        applicationsSubmitted,
        preApprovalToApplication,
      },
      // High Intent in the Intent funnel means the same thing as "an actual
      // application was submitted" — keep it consistent with the real
      // policy_events count rather than Seriti's SubmittedOn flag.
      intent: {
        ...report.intent,
        highIntent: applicationsSubmitted,
      },
    };
  } catch (err) {
    console.error('[report] policy override failed:', err.message);
    return report; // fail safe — keep Seriti's numbers if the D1 query errors
  }
}

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
        financeType:  clientName.toUpperCase() === 'YONDA' ? 'bike' : 'vehicle',
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

export async function handleReport(request, env, path, method, dealer) {
  const url         = new URL(request.url);
  const subPath     = path.replace('/api/report', '') || '/';
  const queryParams = Object.fromEntries(url.searchParams);

  // GET /api/report/health
  if (subPath === '/health' && method === 'GET') {
    const result = await testConnection(env);
    return json(result, result.ok ? 200 : 502);
  }

  // GET /api/report/index
  // Admins see every dealer; non-admin dealer users only see their own entry.
  if (subPath === '/index' && method === 'GET') {
    const cached = await cacheGet(env, 'master:index');

    if (!cached) {
      await fetchAndProcessAll(env, {
        startDate: queryParams.startDate,
        endDate:   queryParams.endDate,
      });
    }

    const index = await cacheGet(env, 'master:index');
    if (!index) return json({ error: 'Failed to build dealer index from Seriti API' }, 502);

    // Admins bypass scoping entirely — they need to see and switch between
    // all dealers. (Group/branch-level scoping for the funnel index still
    // relies on dealerSlug === dealer.dealerId matching, which assumes the
    // D1 dealer id and Seriti's auto-generated ClientName slug are the same
    // string — worth reconciling those two ID systems if group/branch users
    // report seeing an empty index too.)
    if (dealer?.isAdmin) {
      return json({ ...index, _cached: !!cached });
    }

    const dealerEntry = index.dealers.find(d => d.dealerSlug === dealer?.dealerId);
    const scopedIndex = {
      ...index,
      dealers:      dealerEntry ? [dealerEntry] : [],
      totalDealers: dealerEntry ? 1 : 0,
      totalClients: dealerEntry ? 1 : 0,
      _cached:      !!cached,
    };

    return json(scopedIndex);
  }

  // POST /api/report/refresh — still webhook-secret protected, not dealer-facing
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
  // Enforce that the requested slug matches the authenticated dealer.
  const slugMatch = subPath.match(/^\/([a-z0-9-]+)\/([a-z0-9-]+)$/);
  if (slugMatch && method === 'GET') {
    const [, clientSlug, dSlug] = slugMatch;

    if (!SLUG_RE.test(clientSlug) || !SLUG_RE.test(dSlug)) {
      return json({ error: 'Invalid slug format' }, 400);
    }

    // Security: reject if the requested dealer slug doesn't match the JWT —
    // admins bypass this since they're allowed to view any dealer's report.
    if (!dealer?.isAdmin && dSlug !== dealer?.dealerId) {
      return json({ error: 'Forbidden — you can only access your own dealer report' }, 403);
    }

    const CACHE_KEY = `dealer:${clientSlug}:${dSlug}`;
    const cached    = await cacheGet(env, CACHE_KEY);
    const d1DealerId = queryParams.dealerId || null;

    if (cached) {
      const withOverride = await overrideApplicationsFromPolicies(
        env, cached, d1DealerId, queryParams.startDate, queryParams.endDate
      );
      return json({ ...withOverride, _cached: true });
    }

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

    const withOverride = await overrideApplicationsFromPolicies(
      env, report, d1DealerId, queryParams.startDate, queryParams.endDate
    );
    return json({ ...withOverride, _cached: false });
  }

  return json({ error: 'Not found' }, 404);
}
