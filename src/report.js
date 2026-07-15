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
import { processRows, getGrade } from './metricsProcessor.js';
import { json } from './index.js';
import { getAccessibleDealerRows } from './dealers.js';

const SLUG_RE = /^[a-z0-9-]+$/;

// Note: applications numbers now come from policy_events at *processing*
// time (see fetchAndProcessAll below), baked into the cached report — so
// Funnel, Intent, and Lead Quality Intelligence all agree by construction.
// A previous version of this file patched applicationsSubmitted/highIntent
// after the fact on each request, which left Lead Quality Intelligence
// (computed deep in metricsProcessor.js from Seriti's own SubmittedOn flag)
// out of sync with the patched Funnel numbers. Fixed at the source instead.

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
      // Resolve the real applications count from policy_events (D1) — the
      // authoritative record of applications actually created in Edith,
      // rather than trusting Seriti's own SubmittedOn flag. Baked into the
      // calculation here so Funnel, Intent, and Lead Quality Intelligence
      // all agree, instead of patching pieces after the fact.
      let applicationsOverrideCount = null;
      if (env.DB) {
        try {
          const dealerRow = await env.DB.prepare(
            `SELECT id FROM dealers WHERE seriti_slug = ?`
          ).bind(slug).first();

          if (dealerRow && dateRange) {
            const countRow = await env.DB.prepare(
              `SELECT COUNT(*) as count FROM policy_events WHERE dealer_key = ? AND created_at >= ? AND created_at <= ?`
            ).bind(dealerRow.id, `${dateRange.from}T00:00:00`, `${dateRange.to}T23:59:59.999`).first();
            applicationsOverrideCount = countRow?.count ?? 0;
            console.log(`[report] Real applications for ${clientName} (dealer_key=${dealerRow.id}): ${applicationsOverrideCount}`);
          }
        } catch (d1Err) {
          console.warn(`[report] Could not resolve policy_events count for ${clientName}: ${d1Err.message} — falling back to Seriti's SubmittedOn`);
        }
      }

      const analytics = processRows(rows, {
        clientName,
        clientSlug: slug,
        dealerName: clientName,
        dealerSlug: slug,
        dateRange,
        source:     'seriti-api',
        applicationsOverrideCount,
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

  // GET /api/report/aggregate?startDate=&endDate= — funnel & lead quality
  // summed/weighted-averaged across every dealer the current user can access.
  // "Totals only" per scope — insights/biggestOpportunity aren't meaningfully
  // combinable across dealers, so those come back empty in aggregate mode.
  if (subPath === '/aggregate' && method === 'GET') {
    try {
      const dealerRows = await getAccessibleDealerRows(env, dealer);
      const seritiSlugs = dealerRows.map(d => d.seriti_slug).filter(Boolean);

      if (seritiSlugs.length === 0) {
        return json({ error: 'No dealers with a mapped Seriti slug found for this user' }, 404);
      }

      const reports = [];
      for (const slug of seritiSlugs) {
        const cached = await cacheGet(env, `dealer:${slug}:${slug}`);
        if (cached) reports.push(cached);
      }

      if (reports.length === 0) {
        return json({ error: 'No cached report data found — try Refresh data from /admin first' }, 404);
      }

      // ── Sum funnel + intent ──────────────────────────────────────────────
      const sumField = (f) => reports.reduce((a, r) => a + (r.funnel?.[f] || 0), 0);
      const totalLeads           = sumField('totalLeads');
      const preQualifications    = totalLeads; // same-by-definition rule applies in aggregate too
      const preApprovals         = sumField('preApprovals');
      const applicationsSubmitted = sumField('applicationsSubmitted');

      const funnel = {
        totalLeads,
        preQualifications,
        preApprovals,
        applicationsSubmitted,
        leadsToPreApproval:       totalLeads   > 0 ? +((preApprovals / totalLeads) * 100).toFixed(1) : 0,
        preApprovalToApplication: preApprovals > 0 ? +((applicationsSubmitted / preApprovals) * 100).toFixed(1) : 0,
      };

      const intent = {
        lowIntent:    totalLeads,
        mediumIntent: reports.reduce((a, r) => a + (r.intent?.mediumIntent || 0), 0),
        highIntent:   applicationsSubmitted,
      };

      // ── Leads-weighted average for Lead Quality Intelligence ────────────
      const weightedAvg = (getVal) => {
        const totalWeight = reports.reduce((a, r) => a + (r.funnel?.totalLeads || 0), 0);
        if (totalWeight === 0) return 0;
        return reports.reduce((a, r) => a + (getVal(r) * (r.funnel?.totalLeads || 0)), 0) / totalWeight;
      };

      const trafficScore     = Math.round(weightedAvg(r => r.leadQualityIntelligence?.trafficQuality?.score || 0));
      const applicantScore   = Math.round(weightedAvg(r => r.leadQualityIntelligence?.applicantQuality?.score || 0));
      const overallScore     = Math.round(trafficScore * 0.40 + applicantScore * 0.60);
      const confidencePct    = +weightedAvg(r => r.leadQualityIntelligence?.trafficQuality?.confidencePct || 0).toFixed(1);
      const completionPct    = totalLeads > 0 ? +((applicationsSubmitted / totalLeads) * 100).toFixed(1) : 0;
      const avgCreditScore   = Math.round(weightedAvg(r => r.leadQualityIntelligence?.applicantQuality?.avgCreditScore || 0));
      const avgDti           = +weightedAvg(r => r.leadQualityIntelligence?.applicantQuality?.avgDti || 0).toFixed(1);
      const avgIncome        = Math.round(weightedAvg(r => r.leadQualityIntelligence?.applicantQuality?.avgIncome || 0));

      const leadQualityIntelligence = {
        score: overallScore,
        grade: getGrade(overallScore),
        totalLeads,
        trafficQuality: {
          score: trafficScore,
          grade: getGrade(trafficScore),
          confidencePct,
          completionPct,
        },
        applicantQuality: {
          score: applicantScore,
          grade: getGrade(applicantScore),
          avgCreditScore,
          avgDti,
          avgIncome,
        },
        // Per-dealer insights/opportunities don't combine meaningfully into
        // one aggregate recommendation — left empty by design in this view.
        insights: [],
        biggestOpportunity: null,
      };

      // ── Income distribution/groups — sum counts, recompute percentages ──
      const incomeLabels = [...new Set(reports.flatMap(r => (r.incomeDistribution || []).map(d => d.label)))];
      const incomeDistribution = incomeLabels.map(label => {
        const count = reports.reduce((a, r) =>
          a + ((r.incomeDistribution || []).find(d => d.label === label)?.count || 0), 0);
        return { label, count, percentOfTotal: totalLeads > 0 ? +((count / totalLeads) * 100).toFixed(1) : 0 };
      });

      return json({
        meta: {
          processedAt: new Date().toISOString(),
          totalRows:   reports.reduce((a, r) => a + (r.meta?.totalRows || 0), 0),
          dateRange:   reports[0]?.meta?.dateRange || null,
          clientName:  'All dealers',
          clientSlug:  'all',
          dealerName:  'All dealers',
          dealerSlug:  'all',
          source:      'aggregate',
        },
        funnel,
        incomeDistribution,
        incomeGroups: [], // per-income-group risk breakdown doesn't combine meaningfully across dealers
        leadQualityIntelligence,
        intent,
        dealerBreakdown: reports.map(r => ({
          dealer: r.meta?.clientName || 'Unknown',
          ...r.funnel,
        })),
        engagement: null, // fetched separately via /api/dealers/all/engagement
        dealerCount: reports.length,
        _cached: true,
      });
    } catch (err) {
      console.error('[report] aggregate error:', err.message);
      return json({ error: err.message }, 500);
    }
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
