/**
 * mixpanel.js — Cloudflare Worker edition
 *
 * Exports getEngagementForDealer() for use by dealers.js's access-scoped
 * /api/dealers/:id/engagement route — the D1-based dealer model, fully
 * independent of Seriti's report index.
 *
 * Env vars:
 *   MIXPANEL_API_SECRET
 */

import { json } from './index.js';

const EXPORT_URL = 'https://data-eu.mixpanel.com/api/2.0/export';
const CACHE_TTL  = 60 * 60; // 1 hour

// ─── Fetch raw events from Mixpanel Export API ────────────────────────────────
// Filters events for the target branch code WHILE streaming/parsing, rather
// than collecting the full unfiltered export first. This is what was blowing
// past Worker CPU/memory limits (Cloudflare error 1102) — a 30-day export
// across all dealers can be huge; keeping only matching events as we go
// keeps memory flat regardless of total export size.

const MAX_EVENTS = 50000; // safety cap on MATCHING events, not raw export size

async function fetchRawEvents(env, { startDate, endDate }, domainList = null) {
  const secret = env.MIXPANEL_API_SECRET;
  if (!secret) throw new Error('MIXPANEL_API_SECRET is not set');

  const params      = new URLSearchParams({ from_date: startDate, to_date: endDate });
  const url         = `${EXPORT_URL}?${params}`;
  const credentials = btoa(`${secret}:`);

  const res = await fetch(url, {
    headers: {
      Authorization:     `Basic ${credentials}`,
      'Accept-Encoding': 'gzip',
    },
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Mixpanel export failed (${res.status}): ${body}`);
  }

  const events  = [];
  const reader  = res.body.getReader();
  const decoder = new TextDecoder();
  let   buffer     = '';
  let   truncated  = false;
  let   totalSeen  = 0;

  // Tracked URLs reflect the dealer's own website domain (or the
  // seritifinance.findndrive.co.za subdomain) — Seriti branch codes never
  // appear in the widget's tracked page URLs, they're internal to
  // Seriti/Edith only. domainList is comma-separated; match any.
  const domains = (domainList || '').split(',').map(d => d.trim()).filter(Boolean);

  const matches = (parsed) => {
    if (domains.length === 0) return true;
    const url = parsed.properties?.current_url_search || parsed.properties?.['$current_url'] || '';
    return domains.some(d => url.includes(d));
  };

  const tryPush = (line) => {
    const trimmed = line.trim();
    if (!trimmed) return;
    totalSeen++;
    try {
      const parsed = JSON.parse(trimmed);
      if (matches(parsed)) events.push(parsed);
    } catch { /* skip malformed line */ }
  };

  while (true) {
    if (events.length >= MAX_EVENTS) {
      truncated = true;
      try { await reader.cancel(); } catch { /* ignore */ }
      break;
    }

    const { done, value } = await reader.read();
    if (done) break;

    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split('\n');
    buffer = lines.pop();

    for (const line of lines) {
      if (events.length >= MAX_EVENTS) { truncated = true; break; }
      tryPush(line);
    }
  }

  if (!truncated && buffer.trim()) tryPush(buffer);

  if (truncated) {
    console.warn(`[mixpanel] Matching-event cap reached (${MAX_EVENTS}) — narrow the date range for exact figures.`);
  }

  console.log(`[mixpanel] Scanned ${totalSeen} events, kept ${events.length} matching${domains.length ? ` domains=${domains.join('|')}` : ' (unfiltered)'}${truncated ? ' (capped)' : ''}`);
  return events;
}

// ─── Process raw events → EngagementData ─────────────────────────────────────

function processEvents(events) {
  const pageViews = events.filter(e =>
    e.event === '$mp_web_page_view' || e.event === 'page_view'
  );

  const total = pageViews.length || events.length;
  const base  = pageViews.length ? pageViews : events;

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

  const distinctIds    = base.map(e => e.properties?.distinct_id).filter(Boolean);
  const uniqueVisitors = new Set(distinctIds).size;
  const totalVisits    = distinctIds.length;
  const repeatVisits   = totalVisits - uniqueVisitors;
  const returnRate     = uniqueVisitors > 0
    ? +((repeatVisits / totalVisits) * 100).toFixed(1)
    : 0;
  const avgVisitsPerVisitor = uniqueVisitors > 0
    ? +(totalVisits / uniqueVisitors).toFixed(2)
    : 0;

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
    uniqueVisitors,
    totalVisits,
    avgVisitsPerVisitor,
    heatmap,
    peakHours,
    totalEvents: events.length,
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

  // Look up the dealer's website domain(s) from D1 — set during onboarding.
  // Tracked URLs reflect the domain, not a Seriti branch code.
  let domainList = null;
  if (env.DB) {
    const row = await env.DB.prepare(
      `SELECT domain FROM dealers WHERE id = ?`
    ).bind(dealerId).first();
    domainList = row?.domain || null;
  }

  // Filtered inline during streaming — keeps memory flat regardless of
  // total export size, avoiding Worker resource limit crashes.
  const filtered   = await fetchRawEvents(env, dates, domainList);
  const engagement = processEvents(filtered);

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
      let domainList = null;
      if (env.DB) {
        const row = await env.DB.prepare(`SELECT domain FROM dealers WHERE id = ?`).bind(dealer.dealerId).first();
        domainList = row?.domain || null;
      }
      const filtered = await fetchRawEvents(env, dates, domainList);
      return json({
        totalEvents: filtered.length,
        eventTypes:  [...new Set(filtered.map(e => e.event))].slice(0, 20),
        sample:      filtered.slice(0, 2),
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
