/**
 * dealers.js — Dealer access resolution + scoped policy reporting
 *
 * Routes:
 *   GET /api/dealers/accessible                                — list of dealers the current user can view
 *   GET /api/dealers/:id/policies?startDate=&endDate=          — policy events for one dealer (access-checked, optional date range)
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

// ── Access check ──────────────────────────────────────────────────────────────

async function canAccessDealer(env, dealer, targetDealerId) {
  if (dealer.isAdmin) return true;

  if (dealer.groupId) {
    const row = await env.DB.prepare(
      `SELECT id FROM dealers WHERE id = ? AND group_id = ?`
    ).bind(targetDealerId, dealer.groupId).first();
    return !!row;
  }

  return dealer.dealerId === targetDealerId;
}

// ── Policy summary query (with optional date range) ────────────────────────────

async function queryPolicySummary(env, dealerKey, startDate, endDate) {
  const hasDateRange = !!(startDate && endDate);
  const dateClause = hasDateRange ? `AND created_at >= ? AND created_at <= ?` : '';
  const dateParams = hasDateRange ? [startDate, `${endDate} 23:59:59`] : [];

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
  const financeCompanyResult = await env.DB.prepare(`
    SELECT finance_company, COUNT(*) as count,
      COUNT(CASE WHEN finance_status = 'PAID OUT' THEN 1 END) as paid_out
    FROM policy_events
    WHERE dealer_key = ? AND finance_company IS NOT NULL ${fcDateClause}
    GROUP BY finance_company
    ORDER BY count DESC
  `).bind(dealerKey, ...dateParams).all();

  return {
    totals:            totalsResult.results        || [],
    financeStatus:     financeStatusResult.results || [],
    transactionStatus: transactionStatusResult.results || [],
    financeCompany:    financeCompanyResult.results || [],
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
      let dealers;

      if (dealer.isAdmin) {
        const result = await env.DB.prepare(
          `SELECT id, name, group_id, finance_type, has_website FROM dealers ORDER BY name`
        ).all();
        dealers = result.results || [];

      } else if (dealer.groupId) {
        const result = await env.DB.prepare(
          `SELECT id, name, group_id, finance_type, has_website FROM dealers WHERE group_id = ? ORDER BY name`
        ).bind(dealer.groupId).all();
        dealers = result.results || [];

      } else if (dealer.dealerId) {
        const row = await env.DB.prepare(
          `SELECT id, name, group_id, finance_type, has_website FROM dealers WHERE id = ?`
        ).bind(dealer.dealerId).first();
        dealers = row ? [row] : [{
          id: dealer.dealerId,
          name: dealer.dealerName,
          group_id: null,
          finance_type: dealer.financeType,
          has_website: 0,
        }];

      } else {
        dealers = [];
      }

      return json({
        dealers: dealers.map(d => ({
          id:          d.id,
          name:        d.name,
          groupId:     d.group_id,
          financeType: d.finance_type,
          hasWebsite:  d.has_website === 1,
        })),
        canSwitchDealer: dealer.isAdmin || !!dealer.groupId,
      });
    } catch (err) {
      return json({ error: err.message }, 500);
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
  // Independent of Seriti's report index — safe to use even while Seriti's API is down.
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
