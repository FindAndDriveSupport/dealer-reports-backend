/**
 * report.js — Cloudflare Worker route handler (D1-backed)
 *
 * Live Seriti fetching moved OUT of request-time entirely — dashboard
 * requests now just query D1's seriti_leads table (populated by
 * seritiSync.js on a schedule + on-demand refresh). This eliminates both
 * failure modes that plagued the old live-fetch approach:
 *   - CPU timeout: reprocessing the whole account on every uncached dealer
 *   - Memory crash (1102): parsing Seriti's full-account JSON payload live
 *
 * Routes:
 *   GET  /api/report/health                    — Seriti connection test (public)
 *   POST /api/report/refresh                    — trigger a D1 sync (admin only)
 *   GET  /api/report/index                      — dealer list from D1, access-scoped
 *   GET  /api/report/aggregate                   — summed/weighted across accessible dealers
 *   GET  /api/report/:clientSlug/:dealerSlug     — one dealer's funnel/lead-quality report
 *
 * D1 binding required: DB
 */

import { testConnection } from './seritiApiService.js';
import { syncDateRange, importRawRows } from './seritiSync.js';
import { processRows, getGrade } from './metricsProcessor.js';
import { json } from './index.js';
import { getAccessibleDealerRows, canAccessSeritiSlug } from './dealers.js';

const SLUG_RE = /^[a-z0-9-]+$/;

function defaultDateRange() {
  const to   = new Date();
  const from = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
  return {
    startDate: from.toISOString().split('T')[0],
    endDate:   to.toISOString().split('T')[0],
  };
}

// Applications override — real policy_events count from D1, same as before.
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

    return {
      ...report,
      funnel: { ...report.funnel, applicationsSubmitted, preApprovalToApplication },
      intent: { ...report.intent, highIntent: applicationsSubmitted },
    };
  } catch (err) {
    console.error('[report] policy override failed:', err.message);
    return report;
  }
}

// Fetch one dealer's normalized lead rows from D1 for a date range.
async function getDealerRowsFromD1(env, dealerKey, startDate, endDate) {
  const result = await env.DB.prepare(
    `SELECT data FROM seriti_leads WHERE dealer_key = ? AND lead_date >= ? AND lead_date <= ?`
  ).bind(dealerKey, startDate, endDate).all();

  return (result.results || []).map(r => {
    try { return JSON.parse(r.data); } catch { return null; }
  }).filter(Boolean);
}

export async function handleReport(request, env, path, method, dealer) {
  const url         = new URL(request.url);
  const queryParams = Object.fromEntries(url.searchParams);
  const subPath      = path.replace('/api/report', '') || '/';

  // GET /api/report/health — public, tests raw Seriti connection
  if (subPath === '/health' && method === 'GET') {
    const result = await testConnection(env);
    return json(result, result.ok ? 200 : 502);
  }

  if (!env.DB) return json({ error: 'Database not configured' }, 500);

  // POST /api/report/refresh — admin-triggered D1 sync (day-by-day, small payloads)
  if (subPath === '/refresh' && method === 'POST') {
    const dates = (queryParams.startDate && queryParams.endDate)
      ? { startDate: queryParams.startDate, endDate: queryParams.endDate }
      : defaultDateRange();

    try {
      const result = await syncDateRange(env, dates.startDate, dates.endDate);
      return json({
        success: true,
        message: `Synced ${result.totalRows} row(s) across ${result.days} day(s)${result.failures > 0 ? ` (${result.failures} day(s) failed — check logs)` : ''}`,
        ...result,
      });
    } catch (err) {
      console.error('[report] refresh failed:', err.message);
      return json({ error: err.message }, 500);
    }
  }

  // POST /api/report/import — bulk-load a pre-fetched Seriti JSON export
  // directly into D1, skipping live Seriti calls entirely. Body is the raw
  // JSON array exactly as Seriti's /Reporting endpoint returns it. Admin only.
  if (subPath === '/import' && method === 'POST') {
    if (!dealer?.isAdmin) return json({ error: 'Forbidden — admin access only' }, 403);

    try {
      const rawRows = await request.json();
      const result = await importRawRows(env, rawRows);
      return json({
        success: true,
        message: `Imported ${result.imported} lead(s)${result.skipped > 0 ? `, skipped ${result.skipped} (missing applicantId)` : ''}`,
        ...result,
      });
    } catch (err) {
      console.error('[report] import failed:', err.message);
      return json({ error: err.message }, 500);
    }
  }

  // GET /api/report/index — dealer list from D1, access-scoped
  if (subPath === '/index' && method === 'GET') {
    const dates = (queryParams.startDate && queryParams.endDate)
      ? { startDate: queryParams.startDate, endDate: queryParams.endDate }
      : defaultDateRange();

    try {
      const result = await env.DB.prepare(`
        SELECT dealer_key, display_name, COUNT(*) as totalLeads, MAX(synced_at) as processedAt
        FROM seriti_leads
        WHERE lead_date >= ? AND lead_date <= ?
        GROUP BY dealer_key
        ORDER BY display_name
      `).bind(dates.startDate, dates.endDate).all();

      const allDealers = (result.results || []).map(r => ({
        dealerName:  r.display_name || r.dealer_key,
        dealerSlug:  r.dealer_key,
        clientName:  r.display_name || r.dealer_key,
        clientSlug:  r.dealer_key,
        financeType: (r.display_name || '').toUpperCase().includes('YONDA') ? 'bike' : 'vehicle',
        totalLeads:  r.totalLeads,
        dateRange:   dates,
        processedAt: r.processedAt,
      }));

      let scopedDealers = allDealers;
      if (!dealer?.isAdmin) {
        const accessibleRows = await getAccessibleDealerRows(env, dealer);
        const accessibleKeys = new Set(
          accessibleRows.flatMap(d => [d.seriti_dealership_id, d.seriti_slug].filter(Boolean).map(s => s.toLowerCase()))
        );
        scopedDealers = allDealers.filter(d => accessibleKeys.has(d.dealerSlug.toLowerCase()));
      }

      return json({
        platform:     'Seriti E-fficient',
        generatedAt:  new Date().toISOString(),
        totalClients: scopedDealers.length,
        totalDealers: scopedDealers.length,
        dateRange:    dates,
        dealers:      scopedDealers,
      });
    } catch (err) {
      console.error('[report] index failed:', err.message);
      return json({ error: err.message }, 500);
    }
  }

  // GET /api/report/aggregate — summed/weighted across every accessible dealer
  if (subPath === '/aggregate' && method === 'GET') {
    try {
      const dates = (queryParams.startDate && queryParams.endDate)
        ? { startDate: queryParams.startDate, endDate: queryParams.endDate }
        : defaultDateRange();

      const dealerRows  = await getAccessibleDealerRows(env, dealer);
      const dealerKeys  = dealerRows.flatMap(d => [d.seriti_dealership_id, d.seriti_slug].filter(Boolean));

      if (dealerKeys.length === 0) {
        return json({ error: 'No dealers found for this user' }, 404);
      }

      const reports = [];
      for (const key of dealerKeys) {
        const rows = await getDealerRowsFromD1(env, key, dates.startDate, dates.endDate);
        if (rows.length === 0) continue;
        const analytics = processRows(rows, {
          clientName: key, clientSlug: key, dealerName: key, dealerSlug: key,
          dateRange: dates, source: 'd1',
        });
        reports.push(analytics);
      }

      if (reports.length === 0) {
        return json({ error: 'No lead data found — try syncing data first via Refresh data' }, 404);
      }

      const sumField = (f) => reports.reduce((a, r) => a + (r.funnel?.[f] || 0), 0);
      const totalLeads            = sumField('totalLeads');
      const preApprovals          = sumField('preApprovals');
      const applicationsSubmitted = sumField('applicationsSubmitted');

      const funnel = {
        totalLeads,
        preQualifications: totalLeads,
        preApprovals,
        applicationsSubmitted,
        leadsToPreApproval:       totalLeads   > 0 ? +((preApprovals / totalLeads) * 100).toFixed(1) : 0,
        preApprovalToApplication: preApprovals > 0 ? +((applicationsSubmitted / preApprovals) * 100).toFixed(1) : 0,
      };

      const intent = {
        lowIntent: totalLeads,
        mediumIntent: reports.reduce((a, r) => a + (r.intent?.mediumIntent || 0), 0),
        highIntent: applicationsSubmitted,
      };

      const weightedAvg = (getVal) => {
        const totalWeight = reports.reduce((a, r) => a + (r.funnel?.totalLeads || 0), 0);
        if (totalWeight === 0) return 0;
        return reports.reduce((a, r) => a + (getVal(r) * (r.funnel?.totalLeads || 0)), 0) / totalWeight;
      };

      const trafficScore   = Math.round(weightedAvg(r => r.leadQualityIntelligence?.trafficQuality?.score || 0));
      const applicantScore = Math.round(weightedAvg(r => r.leadQualityIntelligence?.applicantQuality?.score || 0));
      const overallScore   = Math.round(trafficScore * 0.40 + applicantScore * 0.60);

      const leadQualityIntelligence = {
        score: overallScore,
        grade: getGrade(overallScore),
        totalLeads,
        trafficQuality: {
          score: trafficScore,
          grade: getGrade(trafficScore),
          confidencePct: +weightedAvg(r => r.leadQualityIntelligence?.trafficQuality?.confidencePct || 0).toFixed(1),
          completionPct: totalLeads > 0 ? +((applicationsSubmitted / totalLeads) * 100).toFixed(1) : 0,
        },
        applicantQuality: {
          score: applicantScore,
          grade: getGrade(applicantScore),
          avgCreditScore: Math.round(weightedAvg(r => r.leadQualityIntelligence?.applicantQuality?.avgCreditScore || 0)),
          avgDti:         +weightedAvg(r => r.leadQualityIntelligence?.applicantQuality?.avgDti || 0).toFixed(1),
          avgIncome:      Math.round(weightedAvg(r => r.leadQualityIntelligence?.applicantQuality?.avgIncome || 0)),
        },
        insights: [],
        biggestOpportunity: null,
      };

      const incomeLabels = [...new Set(reports.flatMap(r => (r.incomeDistribution || []).map(d => d.label)))];
      const incomeDistribution = incomeLabels.map(label => {
        const count = reports.reduce((a, r) => a + ((r.incomeDistribution || []).find(d => d.label === label)?.count || 0), 0);
        return { label, count, percentOfTotal: totalLeads > 0 ? +((count / totalLeads) * 100).toFixed(1) : 0 };
      });

      const groupLabels = [...new Set(reports.flatMap(r => (r.incomeGroups || []).map(g => g.label)))];
      const incomeGroups = groupLabels.map(label => {
        const groupRows = reports.map(r => (r.incomeGroups || []).find(g => g.label === label)).filter(Boolean);
        const users = groupRows.reduce((a, g) => a + (g.users || 0), 0);
        const wAvg = (getVal) => users > 0 ? groupRows.reduce((a, g) => a + (getVal(g) * (g.users || 0)), 0) / users : 0;
        return {
          label, users,
          percentOfTotal:       totalLeads > 0 ? +((users / totalLeads) * 100).toFixed(1) : 0,
          avgNetIncome:         Math.round(wAvg(g => g.avgNetIncome || 0)),
          avgEstimatedApproval: Math.round(wAvg(g => g.avgEstimatedApproval || 0)),
          approvalRate:         +wAvg(g => g.approvalRate || 0).toFixed(1),
          avgCreditScore:       Math.round(wAvg(g => g.avgCreditScore || 0)),
          avgDebtLevel:         +wAvg(g => g.avgDebtLevel || 0).toFixed(1),
        };
      });

      return json({
        meta: {
          processedAt: new Date().toISOString(),
          totalRows: reports.reduce((a, r) => a + (r.meta?.totalRows || 0), 0),
          dateRange: dates,
          clientName: 'All dealers', clientSlug: 'all',
          dealerName: 'All dealers', dealerSlug: 'all',
          source: 'aggregate',
        },
        funnel, incomeDistribution, incomeGroups, leadQualityIntelligence, intent,
        dealerBreakdown: reports.map(r => ({ dealer: r.meta?.clientName || 'Unknown', ...r.funnel })),
        engagement: null,
        dealerCount: reports.length,
        _cached: false,
      });
    } catch (err) {
      console.error('[report] aggregate failed:', err.message);
      return json({ error: err.message }, 500);
    }
  }

  // GET /api/report/:clientSlug/:dealerSlug — one dealer's report, from D1
  const slugMatch = subPath.match(/^\/([a-z0-9-]+)\/([a-z0-9-]+)$/);
  if (slugMatch && method === 'GET') {
    const [, rawClientSlug, rawDSlug] = slugMatch;

    if (!SLUG_RE.test(rawClientSlug) || !SLUG_RE.test(rawDSlug)) {
      return json({ error: 'Invalid slug format' }, 400);
    }

    const dSlug = rawDSlug.toLowerCase();

    const allowed = await canAccessSeritiSlug(env, dealer, dSlug);
    if (!allowed) {
      return json({ error: 'Forbidden — you can only access your own dealer report' }, 403);
    }

    const dates = (queryParams.startDate && queryParams.endDate)
      ? { startDate: queryParams.startDate, endDate: queryParams.endDate }
      : defaultDateRange();

    try {
      const rows = await getDealerRowsFromD1(env, dSlug, dates.startDate, dates.endDate);

      if (rows.length === 0) {
        return json({
          error: `No data found for dealer "${dSlug}" in this date range`,
          hint:  'Try Refresh data on /admin, or a wider date range',
        }, 404);
      }

      const displayName = rows[0]?.ClientName || dSlug;
      const analytics = processRows(rows, {
        clientName: displayName, clientSlug: dSlug,
        dealerName: displayName, dealerSlug: dSlug,
        dateRange: dates, source: 'd1',
      });

      const d1DealerId = queryParams.dealerId || null;
      const withOverride = await overrideApplicationsFromPolicies(env, analytics, d1DealerId, dates.startDate, dates.endDate);

      return json({ ...withOverride, _cached: false });
    } catch (err) {
      console.error('[report] dealer report failed:', err.message);
      return json({ error: err.message }, 500);
    }
  }

  return json({ error: 'Not found' }, 404);
}
