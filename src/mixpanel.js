/**
 * mixpanel.js — Cloudflare Worker edition (JQL-based)
 *
 * Uses Mixpanel's JQL API to filter events server-side (by branch code and
 * date range) before any data is transferred — instead of downloading the
 * full account export and filtering client-side, which was expensive even
 * for narrow queries (e.g. "one dealer, last 7 days" still cost the same as
 * "everyone, last 7 days") and could exceed Worker CPU/memory limits on
 * larger exports (Cloudflare error 1102).
 *
 * Exports getEngagementForDealer() for use by dealers.js's access-scoped
 * /api/dealers/:id/engagement route.
 *
 * Env vars:
 *   MIXPANEL_API_SECRET
 */

import { json } from './index.js';

const JQL_URL = 'https://data-eu.mixpanel.com/api/2.0/jql';
const CACHE_TTL = 60 * 60; // 1 hour
const MAX_EVENTS = 50000;  // safety cap on returned rows

// ─── JQL query ────────────────────────────────────────────────────────────────
// Filters to page-view events matching the branch code, and maps each event
// down to only the fields the dashboard needs — everything else (raw
// payloads, unrelated properties) never leaves Mixpanel's servers.

function buildScript(fromDate, toDate, branchCode) {
  // branchCode is sourced from our own D1 table (admin-controlled, not raw
  // user input), but still escaped defensively before interpolating into
  // the JQL script string.
  const safeBranch = String(branchCode || '').replace(/["\\]/g, '');

  return `
function main() {
  return Events({
    from_date: "${fromDate}",
    to_date: "${toDate}",
    event_selectors: [{event: "$mp_web_page_view"}, {event: "page_view"}]
  })
  .filter(function(e) {
    var url = (e.properties["current_url_search"] || e.properties["$current_url"] || "");
    return ${safeBranch ? `url.indexOf("${safeBranch}") !== -1` : 'true'};
  })
  .map(function(e) {
    return {
      referrer:    e.properties["$initial_referrer"] || "",
      device:      e.properties["$device"] || "",
      os:          e.properties["$os"] || "",
      userAgent:   e.properties["$user_agent"] || "",
      region:      e.properties["$region"] || "",
      distinctId:  e.properties["distinct_id"] || "",
      time:        e.time
    };
  });
}
`.trim();
}

async function fetchEngagementEvents(env, { startDate, endDate }, branchCode) {
  const username  = env.MIXPANEL_SERVICE_ACCOUNT_USERNAME;
  const secret    = env.MIXPANEL_SERVICE_ACCOUNT_SECRET;
  const projectId = env.MIXPANEL_PROJECT_ID;

  if (!username || !secret) {
    throw new Error('MIXPANEL_SERVICE_ACCOUNT_USERNAME / MIXPANEL_SERVICE_ACCOUNT_SECRET are not set — JQL requires a Service Account, not the legacy API secret');
  }
  if (!projectId) {
    throw new Error('MIXPANEL_PROJECT_ID is not set — required alongside the Service Account to identify which project to query');
  }

  const script      = buildScript(startDate, endDate, branchCode);
  const credentials = btoa(`${username}:${secret}`);

  const url  = `${JQL_URL}?project_id=${encodeURIComponent(projectId)}`;
  const body = new URLSearchParams({ script });

  const res = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization:  `Basic ${credentials}`,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body,
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Mixpanel JQL failed (${res.status}): ${text}`);
  }

  const rows = await res.json();
  if (!Array.isArray(rows)) {
    throw new Error('Unexpected JQL response shape');
  }

  const truncated = rows.length > MAX_EVENTS;
  const events    = truncated ? rows.slice(0, MAX_EVENTS) : rows;

  if (truncated) {
    console.warn(`[mixpanel] JQL returned ${rows.length} rows, capped at ${MAX_EVENTS} — narrow the date range for exact figures.`);
  }

  console.log(`[mixpanel] JQL returned ${events.length} matching events${branchCode ? ` (branch=${branchCode})` : ' (unfiltered)'}`);
  return events;
}

// ─── Process flat JQL rows → EngagementData ───────────────────────────────────
// Rows are already filtered and reshaped by JQL, so this is pure aggregation
// over a small, relevant dataset — no per-event classification of raw
// Mixpanel payloads needed here anymore.

function processEvents(rows) {
  const total = rows.length;

  const channelMap = {};
  rows.forEach(r => {
    const channel = classifyReferrer(r.referrer);
    channelMap[channel] = (channelMap[channel] || 0) + 1;
  });
  const acquisitionChannels = Object.entries(channelMap)
    .map(([channel, count]) => ({
      channel,
      count,
      percent: total > 0 ? +((count / total) * 100).toFixed(1) : 0,
    }))
    .sort((a, b) => b.count - a.count);

  const deviceMap = { mobile: 0, desktop: 0, tablet: 0 };
  rows.forEach(r => {
    deviceMap[classifyDevice(r.device, r.os, r.userAgent)]++;
  });
  const deviceTotal = Object.values(deviceMap).reduce((a, b) => a + b, 0);
  const devices = Object.entries(deviceMap).map(([type, count]) => ({
    type,
    count,
    percent: deviceTotal > 0 ? +((count / deviceTotal) * 100).toFixed(1) : 0,
  }));

  const provinceMap = {};
  rows.forEach(r => {
    const province = r.region || 'Unknown';
    provinceMap[province] = (provinceMap[province] || 0) + 1;
  });
  const provinces = Object.entries(provinceMap)
    .map(([province, count]) => ({
      province,
      count,
      percent: total > 0 ? +((count / total) * 100).toFixed(1) : 0,
    }))
    .sort((a, b) => b.count - a.count)
    .slice(0, 10);

  const distinctIds    = rows.map(r => r.distinctId).filter(Boolean);
  const uniqueVisitors = new Set(distinctIds).size;
  const returning      = distinctIds.length - uniqueVisitors;
  const returnRate     = uniqueVisitors > 0
    ? +((returning / distinctIds.length) * 100).toFixed(1)
    : 0;

  const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
  const heatmapMap = {};
  DAYS.forEach(d => { heatmapMap[d] = {}; });

  rows.forEach(r => {
    if (!r.time) return;
    const date = new Date(r.time * 1000);
    const day  = DAYS[date.getUTCDay()];
    const hour = date.getUTCHours();
    heatmapMap[day][hour] = (heatmapMap[day][hour] || 0) + 1;
  });

  const heatmap = DAYS.map(day => ({
    day,
    hours: Array.from({ length: 24 }, (_, hour) => ({
      hour,
      count: heatmapMap[day][hour] || 0,
    })),
  }));

  const peakHours = DAYS.map(day => {
    const hours   = heatmap.find(h => h.day === day)?.hours || [];
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

  return {
    acquisitionChannels,
    devices,
    provinces,
    returnRate,
    heatmap,
    peakHours,
    totalEvents: total,
  };
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function classifyReferrer(referrer) {
  if (!referrer || referrer === '$direct' || referrer === 'direct') return 'Direct';
  if (referrer.includes('google'))    return 'Google';
  if (referrer.includes('facebook') || referrer.includes('fb.')) return 'Facebook';
  if (referrer.includes('instagram')) return 'Instagram';
  if (referrer.includes('tiktok'))    return 'TikTok';
  if (referrer.includes('twitter') || referrer.includes('x.com')) return 'Twitter/X';
  if (referrer.includes('linkedin'))  return 'LinkedIn';
  if (referrer.includes('whatsapp'))  return 'WhatsApp';
  if (referrer.includes('email') || referrer.includes('mail')) return 'Email';
  return 'Other';
}

function classifyDevice(device, os, userAgent) {
  const ua  = (userAgent || '').toLowerCase();
  const dev = (device    || '').toLowerCase();
  const osl = (os        || '').toLowerCase();

  if (dev === 'spider' || ua.includes('bot') || ua.includes('spider')) return 'desktop';
  if (dev === 'tablet' || ua.includes('tablet') || ua.includes('ipad')) return 'tablet';
  if (
    dev === 'android' || dev === 'iphone' || dev === 'k' ||
    osl === 'android' || osl === 'ios'    ||
    ua.includes('mobile')
  ) return 'mobile';
  return 'desktop';
}

function formatHour(hour) {
  if (hour === 0)  return '12:00 AM';
  if (hour < 12)   return `${hour}:00 AM`;
  if (hour === 12) return '12:00 PM';
  return `${hour - 12}:00 PM`;
}

function defaultDateRange() {
  const to   = new Date();
  const from = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
  return {
    startDate: from.toISOString().split('T')[0],
    endDate:   to.toISOString().split('T')[0],
  };
}

// ─── Public: reusable dealer-scoped engagement fetch ──────────────────────────
// Used by dealers.js's /api/dealers/:id/engagement route — access-checked,
// D1-based, fully independent of Seriti's report index.

export async function getEngagementForDealer(env, dealerId, startDate, endDate) {
  const dates = (startDate && endDate) ? { startDate, endDate } : defaultDateRange();

  const cacheKey = `mixpanel:${dealerId}:${dates.startDate}:${dates.endDate}`;
  try {
    const cached = await env.CACHE.get(cacheKey);
    if (cached) return { ...JSON.parse(cached), _cached: true };
  } catch { /* cache miss */ }

  // Look up the Seriti branch code for this dealer from D1 — set during onboarding.
  let branchCode = null;
  if (env.DB) {
    const row = await env.DB.prepare(
      `SELECT branch_code FROM dealers WHERE id = ?`
    ).bind(dealerId).first();
    branchCode = row?.branch_code || null;
  }

  // JQL filters server-side — only matching, reshaped rows are transferred.
  const rows       = await fetchEngagementEvents(env, dates, branchCode);
  const engagement = processEvents(rows);

  await env.CACHE.put(cacheKey, JSON.stringify(engagement), { expirationTtl: CACHE_TTL });

  return { ...engagement, _cached: false };
}

// ─── Legacy route handler (kept for backward compatibility) ──────────────────
// Still JWT-scoped to a single dealer_id — prefer /api/dealers/:id/engagement
// for group admins who need to switch between dealers.

export async function handleMixpanel(request, env, path, method, dealer) {
  if (method !== 'GET') return json({ error: 'Method not allowed' }, 405);

  const url         = new URL(request.url);
  const queryParams = Object.fromEntries(url.searchParams);
  const subPath     = path.replace('/api/mixpanel', '') || '/';

  const dates = (queryParams.startDate && queryParams.endDate)
    ? { startDate: queryParams.startDate, endDate: queryParams.endDate }
    : defaultDateRange();

  if (subPath === '/raw') {
    try {
      let branchCode = null;
      if (env.DB) {
        const row = await env.DB.prepare(`SELECT branch_code FROM dealers WHERE id = ?`).bind(dealer.dealerId).first();
        branchCode = row?.branch_code || null;
      }
      const rows = await fetchEngagementEvents(env, dates, branchCode);
      return json({
        totalEvents: rows.length,
        sample:      rows.slice(0, 5),
      });
    } catch (err) {
      return json({ error: err.message }, 502);
    }
  }

  const slugMatch = subPath.match(/^\/([a-z0-9-]+)$/);
  if (slugMatch) {
    const requestedSlug = slugMatch[1];

    if (requestedSlug !== dealer.dealerId) {
      return json({ error: 'Forbidden — you can only access your own engagement data' }, 403);
    }

    try {
      const engagement = await getEngagementForDealer(env, dealer.dealerId, dates.startDate, dates.endDate);
      return json(engagement);
    } catch (err) {
      console.error(`[mixpanel] ${err.message}`);
      return json({ error: err.message }, 502);
    }
  }

  return json({ error: 'Not found' }, 404);
}
