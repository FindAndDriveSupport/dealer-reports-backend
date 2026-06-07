/**
 * mixpanel.js — Cloudflare Worker edition
 *
 * Handles /api/mixpanel/* routes.
 *
 * Fetches raw event data from the Mixpanel Export API and processes it
 * into the EngagementData shape the frontend expects.
 *
 * Env vars:
 *   MIXPANEL_API_SECRET   — Project API secret (Access Keys)
 *   MIXPANEL_PROJECT_ID   — Project ID (not used in export API but kept for reference)
 *
 * Routes:
 *   GET /api/mixpanel/:dealerSlug?startDate=&endDate=
 *     Returns EngagementData for a specific dealer (filtered by branchCode)
 *
 *   GET /api/mixpanel/raw?startDate=&endDate=
 *     Returns raw event count — useful for debugging
 */

import { json } from './index.js';

const EXPORT_URL = 'https://data-eu.mixpanel.com/api/2.0/export';
const CACHE_TTL  = 60 * 60; // 1 hour

// ─── Branch code → dealer slug mapping ───────────────────────────────────────
// Add entries here as new dealers are onboarded
const BRANCH_TO_SLUG = {
  'YCGY001':  'yourcarguy',
  'YONDA001': 'yonda',
  'FAD001':   'findanddrive',
  'GFI001':   'gfi-motor-corporation-pty-ltd-new',
  'NWF001':   'north-western-ford',
};

// ─── Fetch raw events from Mixpanel Export API ────────────────────────────────

async function fetchRawEvents(env, { startDate, endDate }) {
  const secret = env.MIXPANEL_API_SECRET;
  if (!secret) throw new Error('MIXPANEL_API_SECRET is not set');

  const params = new URLSearchParams({ from_date: startDate, to_date: endDate });
  const url    = `${EXPORT_URL}?${params}`;

  const credentials = btoa(`${secret}:`);

  const res = await fetch(url, {
    headers: {
      Authorization:   `Basic ${credentials}`,
      'Accept-Encoding': 'gzip',
    },
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Mixpanel export failed (${res.status}): ${body}`);
  }

  // Export API returns newline-delimited JSON
  const text   = await res.text();
  const events = [];
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      events.push(JSON.parse(trimmed));
    } catch {
      // skip malformed lines
    }
  }

  console.log(`[mixpanel] Fetched ${events.length} raw events`);
  return events;
}

// ─── Filter events by dealer (branchCode in URL) ─────────────────────────────

function filterByDealer(events, dealerSlug) {
  if (!dealerSlug || dealerSlug === 'all') return events;

  return events.filter(e => {
    const url = e.properties?.current_url_search || e.properties?.['$current_url'] || '';
    // Match by branchCode param or by dealer slug in URL
    const branchMatch = Object.entries(BRANCH_TO_SLUG).some(
      ([code, slug]) => slug === dealerSlug && url.includes(code)
    );
    return branchMatch;
  });
}

// ─── Process raw events → EngagementData ─────────────────────────────────────

function processEvents(events) {
  const pageViews = events.filter(e =>
    e.event === '$mp_web_page_view' || e.event === 'page_view'
  );

  const total = pageViews.length || events.length;
  const base  = pageViews.length ? pageViews : events;

  // ── Acquisition channels ────────────────────────────────────────────────────
  const channelMap = {};
  base.forEach(e => {
    const referrer = e.properties?.['$initial_referrer'] || 'direct';
    const channel  = classifyReferrer(referrer);
    channelMap[channel] = (channelMap[channel] || 0) + 1;
  });
  const acquisitionChannels = Object.entries(channelMap)
    .map(([channel, count]) => ({
      channel,
      count,
      percent: total > 0 ? +((count / total) * 100).toFixed(1) : 0,
    }))
    .sort((a, b) => b.count - a.count);

  // ── Device breakdown ────────────────────────────────────────────────────────
  const deviceMap = { mobile: 0, desktop: 0, tablet: 0 };
  base.forEach(e => {
    const device = classifyDevice(
      e.properties?.['$device'] || '',
      e.properties?.['$os']     || '',
      e.properties?.['$user_agent'] || ''
    );
    deviceMap[device]++;
  });
  const deviceTotal = Object.values(deviceMap).reduce((a, b) => a + b, 0);
  const devices = Object.entries(deviceMap).map(([type, count]) => ({
    type,
    count,
    percent: deviceTotal > 0 ? +((count / deviceTotal) * 100).toFixed(1) : 0,
  }));

  // ── Provinces ───────────────────────────────────────────────────────────────
  const provinceMap = {};
  base.forEach(e => {
    const province = e.properties?.['$region'] || 'Unknown';
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

  // ── Return rate ─────────────────────────────────────────────────────────────
  const distinctIds   = base.map(e => e.properties?.distinct_id).filter(Boolean);
  const uniqueVisitors = new Set(distinctIds).size;
  const returning     = distinctIds.length - uniqueVisitors;
  const returnRate    = uniqueVisitors > 0
    ? +((returning / distinctIds.length) * 100).toFixed(1)
    : 0;

  // ── Heatmap (day × hour) ────────────────────────────────────────────────────
  const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
  const heatmapMap = {};
  DAYS.forEach(d => { heatmapMap[d] = {}; });

  base.forEach(e => {
    const ts = e.properties?.time;
    if (!ts) return;
    const date = new Date(ts * 1000);
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

  // ── Peak hours ──────────────────────────────────────────────────────────────
  const peakHours = DAYS.map(day => {
    const hours = heatmap.find(h => h.day === day)?.hours || [];
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
    totalEvents: events.length,
  };
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function classifyReferrer(referrer) {
  if (!referrer || referrer === '$direct' || referrer === 'direct') return 'Direct';
  if (referrer.includes('google'))   return 'Google';
  if (referrer.includes('facebook') || referrer.includes('fb.')) return 'Facebook';
  if (referrer.includes('instagram')) return 'Instagram';
  if (referrer.includes('tiktok'))   return 'TikTok';
  if (referrer.includes('twitter') || referrer.includes('x.com')) return 'Twitter/X';
  if (referrer.includes('linkedin')) return 'LinkedIn';
  if (referrer.includes('whatsapp')) return 'WhatsApp';
  if (referrer.includes('email') || referrer.includes('mail')) return 'Email';
  return 'Other';
}

function classifyDevice(device, os, userAgent) {
  const ua  = (userAgent || '').toLowerCase();
  const dev = (device   || '').toLowerCase();
  const osl = (os       || '').toLowerCase();

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

// ─── Main route handler ───────────────────────────────────────────────────────

export async function handleMixpanel(request, env, path, method) {
  if (method !== 'GET') return json({ error: 'Method not allowed' }, 405);

  const url         = new URL(request.url);
  const queryParams = Object.fromEntries(url.searchParams);
  const subPath     = path.replace('/api/mixpanel', '') || '/';

  const dates = (queryParams.startDate && queryParams.endDate)
    ? { startDate: queryParams.startDate, endDate: queryParams.endDate }
    : defaultDateRange();

  // GET /api/mixpanel/raw — debug endpoint
  if (subPath === '/raw') {
    try {
      const events = await fetchRawEvents(env, dates);
      return json({
        totalEvents: events.length,
        eventTypes:  [...new Set(events.map(e => e.event))].slice(0, 20),
        sample:      events.slice(0, 2),
      });
    } catch (err) {
      return json({ error: err.message }, 502);
    }
  }

  // GET /api/mixpanel/:dealerSlug
  const slugMatch = subPath.match(/^\/([a-z0-9-]+)$/);
  if (slugMatch) {
    const dealerSlug = slugMatch[1];

    // Check KV cache first
    const cacheKey = `mixpanel:${dealerSlug}:${dates.startDate}:${dates.endDate}`;
    try {
      const cached = await env.CACHE.get(cacheKey);
      if (cached) return json({ ...JSON.parse(cached), _cached: true });
    } catch { /* cache miss */ }

    try {
      const allEvents     = await fetchRawEvents(env, dates);
      const filtered      = filterByDealer(allEvents, dealerSlug);
      const engagement    = processEvents(filtered);

      await env.CACHE.put(cacheKey, JSON.stringify(engagement), {
        expirationTtl: CACHE_TTL,
      });

      return json({ ...engagement, _cached: false });
    } catch (err) {
      console.error(`[mixpanel] ${err.message}`);
      return json({ error: err.message }, 502);
    }
  }

  return json({ error: 'Not found' }, 404);
}