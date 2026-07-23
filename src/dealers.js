/**
 * dealers.js — Dealer access resolution + scoped policy reporting + engagement
 *
 * Routes:
 *   GET /api/dealers/accessible                                — list of dealers the current user can view
 *   GET /api/dealers/:id/policies?startDate=&endDate=          — policy events for one dealer (access-checked, optional date range)
 *   GET /api/dealers/:id/engagement?startDate=&endDate=        — Mixpanel engagement for one dealer (access-checked)
 *   GET /api/dealers/all/policies?startDate=&endDate=          — policy events summed across every accessible dealer
 *   GET /api/dealers/all/engagement?startDate=&endDate=        — Mixpanel engagement summed across every accessible dealer
 *
 * Access rules:
 *   is_admin = true              → all dealers
 *   group_id set, dealer_id null → all dealers in that group (group-level admin)
 *   dealer_id set                → only that one dealer (branch-level user)
 *
 * D1 binding required: DB
 */

import { json } from './index.js';
import { getEngagementForDealer } from './mixpanel.js';

// ── Access resolution ────────────────────────────────────────────────────────
//
// Multi-branch access: a user can be granted access to any number of
// specific dealer branches via user_dealer_access, independent of group
// membership — e.g. someone who needs exactly 3 branches across 2 different
// groups. This sits alongside (not replacing) is_admin and group_id, which
// remain the simplest/broadest access grants.

export async function canAccessDealer(env, dealer, targetDealerId) {
  if (dealer.isAdmin) return true;

  if (dealer.groupId) {
    const row = await env.DB.prepare(
      `SELECT id FROM dealers WHERE id = ? AND group_id = ?`
    ).bind(targetDealerId, dealer.groupId).first();
    if (row) return true;
  }

  const grant = await env.DB.prepare(
    `SELECT 1 FROM user_dealer_access WHERE user_id = ? AND dealer_id = ?`
  ).bind(dealer.userId, targetDealerId).first();
  if (grant) return true;

  // Legacy fallback — pre-migration users.dealer_id, in case the backfill
  // hasn't run yet or a row was created outside the normal invite flow.
  return dealer.dealerId === targetDealerId;
}

// Report.js's funnel/lead-quality data is keyed by Seriti's own auto-slug
// (clientSlug === dealerSlug), which may differ from the D1 dealer id — see
// seriti_slug backfill. This resolves access the same way as
// canAccessDealer, but starting from the Seriti slug in the URL instead of
// the D1 id, so branch and group users aren't incorrectly blocked just
// because the two id systems don't match as strings.
export async function canAccessSeritiSlug(env, dealer, seritiSlug) {
  if (dealer.isAdmin) return true;

  // Case-insensitive — Seriti's GUID casing isn't guaranteed to match
  // whatever casing ended up stored in D1.
  const row = await env.DB.prepare(
    `SELECT id, group_id FROM dealers WHERE LOWER(seriti_dealership_id) = LOWER(?) OR LOWER(seriti_slug) = LOWER(?)`
  ).bind(seritiSlug, seritiSlug).first();

  if (!row) return false;

  if (dealer.groupId && row.group_id === dealer.groupId) return true;

  const grant = await env.DB.prepare(
    `SELECT 1 FROM user_dealer_access WHERE user_id = ? AND dealer_id = ?`
  ).bind(dealer.userId, row.id).first();
  if (grant) return true;

  return dealer.dealerId === row.id;
}

// Full list of dealer rows the current user can see. Admins see everything;
// group admins see their whole group; everyone else sees exactly the
// branches granted to them in user_dealer_access (which may span multiple
// groups or standalone dealers — this is what makes multi-branch access
// possible without requiring a shared group_id).
export async function getAccessibleDealerRows(env, dealer) {
  if (dealer.isAdmin) {
    const result = await env.DB.prepare(
      `SELECT id, name, group_id, finance_type, has_website, seriti_slug, seriti_dealership_id FROM dealers ORDER BY name`
    ).all();
    return result.results || [];
  }

  if (dealer.groupId) {
    const result = await env.DB.prepare(
      `SELECT id, name, group_id, finance_type, has_website, seriti_slug, seriti_dealership_id FROM dealers WHERE group_id = ? ORDER BY name`
    ).bind(dealer.groupId).all();
    return result.results || [];
  }

  if (dealer.userId) {
    const result = await env.DB.prepare(`
      SELECT d.id, d.name, d.group_id, d.finance_type, d.has_website, d.seriti_slug
      FROM dealers d
      INNER JOIN user_dealer_access uda ON uda.dealer_id = d.id
      WHERE uda.user_id = ?
      ORDER BY d.name
    `).bind(dealer.userId).all();

    if (result.results && result.results.length > 0) {
      return result.results;
    }
  }

  // Legacy fallback — pre-migration users.dealer_id with no junction rows yet
  if (dealer.dealerId) {
    const row = await env.DB.prepare(
      `SELECT id, name, group_id, finance_type, has_website, seriti_slug, seriti_dealership_id FROM dealers WHERE id = ?`
    ).bind(dealer.dealerId).first();
    return row ? [row] : [{
      id: dealer.dealerId,
      name: dealer.dealerName,
      group_id: null,
      finance_type: dealer.financeType,
      has_website: 0,
      seriti_slug: null,
      seriti_dealership_id: null,
    }];
  }

  return [];
}

// ── Policy summary query (with optional date range) ────────────────────────────

async function queryPolicySummary(env, dealerKey, startDate, endDate) {
  const hasDateRange = !!(startDate && endDate);
  const dateClause = hasDateRange ? `AND created_at >= ? AND created_at <= ?` : '';
  const dateParams = hasDateRange ? [`${startDate}T00:00:00`, `${endDate}T23:59:59.999`] : [];

  const totalsResult = await env.DB.prepare(`
    SELECT
      dealer_key, finance_type,
      COUNT(*) as total_policies,
      COUNT(CASE WHEN finance_status = 'PAID OUT' THEN 1 END) as paid_out,
      COUNT(CASE WHEN finance_status = 'DECLINED' THEN 1 END) as declined,
      COUNT(CASE WHEN transaction_status = 'DELIVERED' THEN 1 END) as delivered,
      COUNT(CASE WHEN transaction_status = 'DUPLICATE DEAL' THEN 1 END) as duplicate_deals,
      COUNT(CASE WHEN transaction_status LIKE 'AWAITING%' THEN 1 END) as awaiting_delivery
    FROM policy_events
    WHERE dealer_key = ? ${dateClause}
    GROUP BY dealer_key, finance_type
  `).bind(dealerKey, ...dateParams).all();

  const financeStatusResult = await env.DB.prepare(`
    SELECT finance_type, finance_company, finance_status, COUNT(*) as count
    FROM policy_events
    WHERE dealer_key = ? ${dateClause}
    GROUP BY finance_type, finance_company, finance_status
    ORDER BY count DESC
  `).bind(dealerKey, ...dateParams).all();

  const transactionStatusResult = await env.DB.prepare(`
    SELECT transaction_status, COUNT(*) as count
    FROM policy_events
    WHERE dealer_key = ? ${dateClause}
    GROUP BY transaction_status
    ORDER BY count DESC
  `).bind(dealerKey, ...dateParams).all();

  const fcDateClause = hasDateRange ? `AND created_at >= ? AND created_at <= ?` : '';
  const fcParams = hasDateRange ? [`${startDate}T00:00:00`, `${endDate}T23:59:59.999`] : [];
  const financeCompanyResult = await env.DB.prepare(`
    SELECT finance_company, COUNT(*) as count,
      COUNT(CASE WHEN finance_status = 'PAID OUT' THEN 1 END) as paid_out
    FROM policy_events
    WHERE dealer_key = ? AND finance_company IS NOT NULL ${fcDateClause}
    GROUP BY finance_company
    ORDER BY count DESC
  `).bind(dealerKey, ...fcParams).all();

  return {
    totals:            totalsResult.results        || [],
    financeStatus:     financeStatusResult.results || [],
    transactionStatus: transactionStatusResult.results || [],
    financeCompany:    financeCompanyResult.results || [],
  };
}

// Sums queryPolicySummary results across a set of dealer_keys into one
// combined shape, matching the same fields the single-dealer version returns.
async function querySummedPolicySummary(env, dealerKeys, startDate, endDate) {
  const perDealer = await Promise.all(
    dealerKeys.map(k => queryPolicySummary(env, k, startDate, endDate))
  );

  const totals = [];
  const financeStatus = [];
  const transactionStatus = [];
  const financeCompany = [];

  for (const summary of perDealer) {
    totals.push(...summary.totals);
    financeStatus.push(...summary.financeStatus);
    transactionStatus.push(...summary.transactionStatus);
    financeCompany.push(...summary.financeCompany);
  }

  // Collapse transaction_status and finance_company across dealers into one
  // set of totals each (rather than listing every dealer's rows separately),
  // since this is an aggregate ("totals only") view.
  const collapseByKey = (rows, key, extraSumKeys = []) => {
    const map = new Map();
    for (const row of rows) {
      const k = row[key] ?? null;
      if (!map.has(k)) {
        map.set(k, { [key]: k, count: 0, ...Object.fromEntries(extraSumKeys.map(ek => [ek, 0])) });
      }
      const entry = map.get(k);
      entry.count += row.count || 0;
      extraSumKeys.forEach(ek => { entry[ek] += row[ek] || 0; });
    }
    return [...map.values()].sort((a, b) => b.count - a.count);
  };

  return {
    totals, // per-dealer-per-financeType rows — frontend already sums these into KPIs
    financeStatus:     collapseByKey(financeStatus, 'finance_status'),
    transactionStatus: collapseByKey(transactionStatus, 'transaction_status'),
    financeCompany:    collapseByKey(financeCompany, 'finance_company', ['paid_out']),
  };
}

// ── Route handler ─────────────────────────────────────────────────────────────

export async function handleDealers(request, env, path, method, dealer) {
  if (!env.DB) return json({ error: 'Database not configured' }, 500);

  const url      = new URL(request.url);
  const subPath  = path.replace('/api/dealers', '') || '/';

  // GET /api/dealers/accessible
  if (subPath === '/accessible' && method === 'GET') {
    try {
      const dealers = await getAccessibleDealerRows(env, dealer);

      // Distinct groups among the dealers this user can see — each becomes
      // a selectable "view by group" aggregate option in the dealer
      // switcher, sitting between "All Dealers" and individual dealers.
      const groupMap = new Map();
      for (const d of dealers) {
        if (d.group_id && !groupMap.has(d.group_id)) {
          groupMap.set(d.group_id, { id: d.group_id, name: d.group_id });
        }
      }
      // Resolve real group display names from the groups table
      if (groupMap.size > 0) {
        const groupIds = [...groupMap.keys()];
        const placeholders = groupIds.map(() => '?').join(', ');
        const groupRows = await env.DB.prepare(
          `SELECT id, name FROM groups WHERE id IN (${placeholders})`
        ).bind(...groupIds).all();
        for (const g of (groupRows.results || [])) {
          if (groupMap.has(g.id)) groupMap.set(g.id, { id: g.id, name: g.name });
        }
      }

      return json({
        dealers: dealers.map(d => ({
          id:          d.id,
          name:        d.name,
          groupId:     d.group_id,
          financeType: d.finance_type,
          hasWebsite:  d.has_website === 1,
          // Prefer the stable GUID (seriti_dealership_id) over the legacy
          // name-based seriti_slug — frontend treats this as an opaque
          // identifier and just passes it straight through to the backend.
          seritiSlug:  d.seriti_dealership_id || d.seriti_slug || null,
        })),
        groups: [...groupMap.values()],
        canSwitchDealer: dealer.isAdmin || !!dealer.groupId,
      });
    } catch (err) {
      return json({ error: err.message }, 500);
    }
  }

  // GET /api/dealers/all/policies?startDate=&endDate= — summed across every accessible dealer
  // Only meaningful for admins/group admins — canSwitchDealer gates this on the frontend,
  // but branch users technically only ever have one accessible dealer anyway so this is safe.
  if (subPath === '/all/policies' && method === 'GET') {
    try {
      let dealers = await getAccessibleDealerRows(env, dealer);

      // Optional ?groupId= narrows the aggregate to just one dealer group
      // (e.g. "Alpine Motors") instead of everything the user can access.
      const groupId = url.searchParams.get('groupId');
      if (groupId) {
        dealers = dealers.filter(d => d.group_id === groupId);
        if (dealers.length === 0) {
          return json({ error: `No accessible dealers found in group "${groupId}"` }, 404);
        }
      }

      const dealerKeys = dealers.map(d => d.id);

      const startDate = url.searchParams.get('startDate');
      const endDate   = url.searchParams.get('endDate');

      const summary = await querySummedPolicySummary(env, dealerKeys, startDate, endDate);
      return json({
        dealerKey: groupId ? `group:${groupId}` : 'all',
        dealerCount: dealerKeys.length,
        dateRange: startDate && endDate ? { from: startDate, to: endDate } : null,
        ...summary,
      });
    } catch (err) {
      return json({ error: err.message }, 500);
    }
  }

  // GET /api/dealers/all/engagement?startDate=&endDate=&groupId= — summed across accessible (or one group's) dealers
  if (subPath === '/all/engagement' && method === 'GET') {
    try {
      let dealers = await getAccessibleDealerRows(env, dealer);

      const groupId = url.searchParams.get('groupId');
      if (groupId) {
        dealers = dealers.filter(d => d.group_id === groupId);
        if (dealers.length === 0) {
          return json({ error: `No accessible dealers found in group "${groupId}"` }, 404);
        }
      }

      const startDate = url.searchParams.get('startDate');
      const endDate   = url.searchParams.get('endDate');

      const perDealer = await Promise.all(
        dealers.map(d => getEngagementForDealer(env, d.id, startDate, endDate).catch(() => null))
      );
      const valid = perDealer.filter(Boolean);

      // Sum count-based fields across dealers. returnRate/avgVisitsPerVisitor
      // are recomputed from the summed totals rather than averaged, since a
      // straight average would misweight dealers with very different volumes.
      const sumByKey = (arrays, keyField) => {
        const map = new Map();
        for (const arr of arrays) {
          for (const row of arr) {
            const k = row[keyField];
            if (!map.has(k)) map.set(k, { ...row, count: 0 });
            map.get(k).count += row.count;
          }
        }
        const total = [...map.values()].reduce((a, r) => a + r.count, 0);
        return [...map.values()]
          .map(r => ({ ...r, percent: total > 0 ? +((r.count / total) * 100).toFixed(1) : 0 }))
          .sort((a, b) => b.count - a.count);
      };

      const totalEvents          = valid.reduce((a, e) => a + (e.totalEvents || 0), 0);
      const totalVisits          = valid.reduce((a, e) => a + (e.totalVisits || 0), 0);
      const uniqueVisitors       = valid.reduce((a, e) => a + (e.uniqueVisitors || 0), 0);
      const avgVisitsPerVisitor  = uniqueVisitors > 0 ? +(totalVisits / uniqueVisitors).toFixed(2) : 0;
      const repeatVisits         = totalVisits - uniqueVisitors;
      const returnRate           = totalVisits > 0 ? +((repeatVisits / totalVisits) * 100).toFixed(1) : 0;

      // Heatmap: sum per day/hour across dealers
      const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
      const heatmap = DAYS.map((day, di) => ({
        day,
        hours: Array.from({ length: 24 }, (_, hour) => ({
          hour,
          count: valid.reduce((a, e) => a + (e.heatmap?.[di]?.hours?.[hour]?.count || 0), 0),
        })),
      }));

      const formatHour = (hour) => {
        if (hour === 0)  return '12:00 AM';
        if (hour < 12)   return `${hour}:00 AM`;
        if (hour === 12) return '12:00 PM';
        return `${hour - 12}:00 PM`;
      };
      const peakHours = DAYS.map((day, di) => {
        const hours   = heatmap[di].hours;
        const amHours = hours.filter(h => h.hour < 12).sort((a, b) => b.count - a.count);
        const pmHours = hours.filter(h => h.hour >= 12).sort((a, b) => b.count - a.count);
        const amPeak  = amHours[0];
        const pmPeak  = pmHours[0];
        return {
          day,
          amPeak:  amPeak  ? formatHour(amPeak.hour)  : 'N/A',
          pmPeak:  pmPeak  ? formatHour(pmPeak.hour)  : 'N/A',
          amCount: amPeak?.count || 0,
          pmCount: pmPeak?.count || 0,
        };
      });

      return json({
        acquisitionChannels: sumByKey(valid.map(e => e.acquisitionChannels || []), 'channel'),
        devices:             sumByKey(valid.map(e => e.devices || []), 'type'),
        provinces:           sumByKey(valid.map(e => e.provinces || []), 'province'),
        returnRate,
        uniqueVisitors,
        totalVisits,
        avgVisitsPerVisitor,
        heatmap,
        peakHours,
        totalEvents,
        dealerCount: dealers.length,
      });
    } catch (err) {
      return json({ error: err.message }, 502);
    }
  }

  // GET /api/dealers/:id/policies?startDate=&endDate= — access-checked policy summary
  const policyMatch = subPath.match(/^\/([a-z0-9-_]+)\/policies$/);
  if (policyMatch && method === 'GET') {
    const targetDealerId = policyMatch[1];

    const allowed = await canAccessDealer(env, dealer, targetDealerId);
    if (!allowed) {
      return json({ error: 'Forbidden — you do not have access to this dealer' }, 403);
    }

    const startDate = url.searchParams.get('startDate');
    const endDate   = url.searchParams.get('endDate');

    try {
      const summary = await queryPolicySummary(env, targetDealerId, startDate, endDate);
      return json({ dealerKey: targetDealerId, dateRange: startDate && endDate ? { from: startDate, to: endDate } : null, ...summary });
    } catch (err) {
      return json({ error: err.message }, 500);
    }
  }

  // GET /api/dealers/:id/engagement?startDate=&endDate= — access-checked Mixpanel engagement
  const engagementMatch = subPath.match(/^\/([a-z0-9-_]+)\/engagement$/);
  if (engagementMatch && method === 'GET') {
    const targetDealerId = engagementMatch[1];

    const allowed = await canAccessDealer(env, dealer, targetDealerId);
    if (!allowed) {
      return json({ error: 'Forbidden — you do not have access to this dealer' }, 403);
    }

    const startDate = url.searchParams.get('startDate');
    const endDate   = url.searchParams.get('endDate');

    try {
      const engagement = await getEngagementForDealer(env, targetDealerId, startDate, endDate);
      return json(engagement);
    } catch (err) {
      return json({ error: err.message }, 502);
    }
  }

  return json({ error: 'Not found' }, 404);
}
