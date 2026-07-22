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
import { getAccessibleDealerRows, canAccessSeritiSlug } from './dealers.js';

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

async function fetchAndProcessAll(env, { startDate, endDate, onlyClientSlug } = {}) {
  const dates = startDate && endDate
    ? { startDate, endDate }
    : defaultDateRange();

  console.log(`[report] Fetching from Seriti API (${dates.startDate} → ${dates.endDate})...`);

  const allRows = await fetchLeadData(env, dates, onlyClientSlug);

  if (!allRows.length) {
    console.warn('[report] Seriti API returned 0 rows for this date range');
    return [];
  }

  // Grouped by DealershipId (Seriti's stable GUID) rather than ClientName —
  // this key is now used directly as the cache/URL slug, eliminating the
  // whole class of bugs where our own slugified ClientName drifted from
  // whatever got manually typed into D1 (findanddrive vs findndrive, etc.).
  const clientMap = splitByClient(allRows);
  const allKeys   = Object.keys(clientMap);

  // When onlyClientSlug is set (a single dealer's report was requested and
  // wasn't cached), only that one dealer gets the CPU-heavy processRows()
  // pipeline run — not every dealer in the account. Reprocessing everyone
  // just because one new/uncached dealer was viewed was hitting Cloudflare's
  // Worker CPU time limit (503) once the dealer count grew past ~20-30.
  // Full-account refresh (all dealers) still happens via /refresh and the
  // /index route's cache-miss path — this only narrows the targeted case.
  const dealerKeys = onlyClientSlug
    ? allKeys.filter(key => key === onlyClientSlug)
    : allKeys;

  console.log(
    onlyClientSlug
      ? `[report] Targeted processing: ${dealerKeys.join(', ') || '(no match for ' + onlyClientSlug + ')'}`
      : `[report] Processing ${dealerKeys.length} dealer(s)`
  );

  const index = [];

  // Resolve every dealer's real applications count from D1 CONCURRENTLY
  // rather than one-at-a-time inside the processing loop below — with a
  // growing dealer count (Alpine Motors' many branches, etc.), sequential
  // awaits here were adding up enough to risk the Worker's CPU time limit
  // on any cache-miss (which reprocesses every dealer, not just one).
  // Prefers seriti_dealership_id (the stable GUID) over the legacy
  // name-based seriti_slug for dealers that have been migrated.
  const overridesByKey = {};
  if (env.DB) {
    await Promise.all(dealerKeys.map(async (key) => {
      const dateRange = extractDateRange(clientMap[key]);
      if (!dateRange) return;

      try {
        const dealerRow = await env.DB.prepare(
          `SELECT id FROM dealers WHERE seriti_dealership_id = ? OR seriti_slug = ?`
        ).bind(key, key).first();

        if (dealerRow) {
          const countRow = await env.DB.prepare(
            `SELECT COUNT(*) as count FROM policy_events WHERE dealer_key = ? AND created_at >= ? AND created_at <= ?`
          ).bind(dealerRow.id, `${dateRange.from}T00:00:00`, `${dateRange.to}T23:59:59.999`).first();
          overridesByKey[key] = countRow?.count ?? 0;
          console.log(`[report] Real applications for ${key} (dealer_key=${dealerRow.id}): ${overridesByKey[key]}`);
        }
      } catch (d1Err) {
        console.warn(`[report] Could not resolve policy_events count for ${key}: ${d1Err.message} — falling back to Seriti's SubmittedOn`);
      }
    }));
  }

  for (const key of dealerKeys) {
    const rows        = clientMap[key];
    const displayName = rows[0]?.ClientName || key;
    const dateRange   = extractDateRange(rows);

    try {
      const applicationsOverrideCount = overridesByKey[key] ?? null;

      const analytics = processRows(rows, {
        clientName: displayName,
        clientSlug: key,
        dealerName: displayName,
        dealerSlug: key,
        dateRange,
        source:     'seriti-api',
        applicationsOverrideCount,
      });

      await cacheSet(env, `dealer:${key}:${key}`, analytics);

      index.push({
        dealerName:  displayName,
        dealerSlug:  key,
        clientName:  displayName,
        clientSlug:  key,
        financeType: displayName.toUpperCase() === 'YONDA' ? 'bike' : 'vehicle',
        totalLeads:  analytics.funnel.totalLeads,
        dateRange,
        processedAt: analytics.meta.processedAt,
      });

      console.log(`[report] ✅ ${displayName} (${key}) — ${rows.length} rows, ${analytics.funnel.totalLeads} unique leads`);
    } catch (err) {
      console.error(`[report] ❌ ${displayName} (${key}): ${err.message}`);
    }
  }

  // When targeted (onlyClientSlug), merge this one dealer into the EXISTING
  // cached index rather than overwriting it — otherwise every other
  // dealer would vanish from /api/report/index the next time anyone views
  // a single uncached dealer's report.
  let finalDealers = index;
  if (onlyClientSlug) {
    const existing = await cacheGet(env, 'master:index');
    const existingDealers = existing?.dealers || [];
    const otherDealers = existingDealers.filter(d => d.dealerSlug !== onlyClientSlug);
    finalDealers = [...otherDealers, ...index];
  }

  const masterIndex = {
    platform:     'Seriti E-fficient',
    generatedAt:  new Date().toISOString(),
    totalClients: finalDealers.length,
    totalDealers: finalDealers.length,
    dateRange:    { startDate: dates.startDate, endDate: dates.endDate },
    dealers:      finalDealers,
  };

  await cacheSet(env, 'master:index', masterIndex);
  console.log(`[report] Index cached — ${finalDealers.length} dealer(s) total${onlyClientSlug ? ` (${index.length} just processed)` : ''}`);

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
    // all dealers.
    if (dealer?.isAdmin) {
      return json({ ...index, _cached: !!cached });
    }

    // Non-admins: resolve which Seriti dealer keys (GUIDs) this user can
    // access via D1, same pattern as canAccessSeritiSlug — comparing raw
    // dealerSlug (now a GUID) against dealer.dealerId (a D1 dealer id like
    // "yonda-bike") would never match, since those are different ID systems.
    const accessibleRows = await getAccessibleDealerRows(env, dealer);
    const accessibleKeys = new Set(
      accessibleRows.flatMap(d => [d.seriti_dealership_id, d.seriti_slug].filter(Boolean))
    );
    const scopedDealers = index.dealers.filter(d => accessibleKeys.has(d.dealerSlug));

    const scopedIndex = {
      ...index,
      dealers:      scopedDealers,
      totalDealers: scopedDealers.length,
      totalClients: scopedDealers.length,
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
      const seritiSlugs = dealerRows.map(d => d.seriti_dealership_id || d.seriti_slug).filter(Boolean);

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

      // Income Group Analysis — sum user counts per group, weighted-average
      // the risk metrics (credit score, DTI, approval rate, etc.) by each
      // dealer's user count within that group, so a group with more actual
      // leads has proportionally more influence on the combined average.
      const groupLabels = [...new Set(reports.flatMap(r => (r.incomeGroups || []).map(g => g.label)))];
      const incomeGroups = groupLabels.map(label => {
        const groupRows = reports
          .map(r => (r.incomeGroups || []).find(g => g.label === label))
          .filter(Boolean);

        const users = groupRows.reduce((a, g) => a + (g.users || 0), 0);
        const weightedAvgGroup = (getVal) => {
          if (users === 0) return 0;
          return groupRows.reduce((a, g) => a + (getVal(g) * (g.users || 0)), 0) / users;
        };

        return {
          label,
          users,
          percentOfTotal:       totalLeads > 0 ? +((users / totalLeads) * 100).toFixed(1) : 0,
          avgNetIncome:         Math.round(weightedAvgGroup(g => g.avgNetIncome || 0)),
          avgEstimatedApproval: Math.round(weightedAvgGroup(g => g.avgEstimatedApproval || 0)),
          approvalRate:         +weightedAvgGroup(g => g.approvalRate || 0).toFixed(1),
          avgCreditScore:       Math.round(weightedAvgGroup(g => g.avgCreditScore || 0)),
          avgDebtLevel:         +weightedAvgGroup(g => g.avgDebtLevel || 0).toFixed(1),
        };
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
        incomeGroups,
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

    // Security: resolve access via D1's seriti_slug mapping — dSlug here is
    // Seriti's own auto-generated slug, which may differ from the D1 dealer
    // id string, so a direct dSlug === dealer.dealerId comparison incorrectly
    // blocks legitimate branch/group users whenever the two don't match.
    const allowed = await canAccessSeritiSlug(env, dealer, dSlug);
    if (!allowed) {
      return json({ error: 'Forbidden — you can only access your own dealer report' }, 403);
    }

    const CACHE_KEY = `dealer:${clientSlug}:${dSlug}`;
    const cached    = await cacheGet(env, CACHE_KEY);

    if (cached) return json({ ...cached, _cached: true });

    console.log(`[report] Cache miss for ${clientSlug}/${dSlug} — fetching targeted from Seriti...`);
    await fetchAndProcessAll(env, {
      startDate: queryParams.startDate,
      endDate:   queryParams.endDate,
      onlyClientSlug: dSlug,
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
