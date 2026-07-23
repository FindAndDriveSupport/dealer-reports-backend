/**
 * mixpanelSync.js — Background sync: Mixpanel API → D1 storage
 *
 * Runs on a schedule (shares the same Cron Trigger as seritiSync.js — this
 * account is capped at 5 total triggers) and on-demand. Fetches Mixpanel's
 * Export API day-by-day, keeping only events matching a KNOWN dealer
 * domain (via the same CPU-optimized raw-text pre-filter used live), and
 * stores them in D1's mixpanel_events table.
 *
 * This is what actually fixes the 524 timeouts (Mixpanel's own export
 * taking too long to generate for a live user-facing request) and 429 rate
 * limits (too many concurrent live calls from group-aggregate views) —
 * Mixpanel's API now only ever gets called by this one background job on
 * its own schedule, never by live dashboard traffic.
 */

import { fetchRawEvents } from './mixpanel.js';

function formatDate(d) {
  return d.toISOString().split('T')[0];
}

function* eachDay(fromDate, toDate) {
  const cur = new Date(fromDate + 'T00:00:00Z');
  const end = new Date(toDate + 'T00:00:00Z');
  while (cur <= end) {
    yield formatDate(cur);
    cur.setUTCDate(cur.getUTCDate() + 1);
  }
}

// Collects every known dealer domain from D1, deduped, to build the filter
// list for the sync fetch — only events matching at least one real dealer
// domain get stored, everything else in the account is discarded.
async function getAllKnownDomains(env) {
  const result = await env.DB.prepare(
    `SELECT domain FROM dealers WHERE domain IS NOT NULL AND domain != ''`
  ).all();

  const domainSet = new Set();
  for (const row of (result.results || [])) {
    row.domain.split(',').map(d => d.trim()).filter(Boolean).forEach(d => domainSet.add(d));
  }
  return [...domainSet];
}

async function syncOneDay(env, dateStr, domainList) {
  let events;
  try {
    events = await fetchRawEvents(env, { startDate: dateStr, endDate: dateStr }, domainList);
  } catch (err) {
    console.error(`[mixpanel-sync] ${dateStr} failed: ${err.message}`);
    return { date: dateStr, ok: false, count: 0 };
  }

  if (!Array.isArray(events) || events.length === 0) {
    return { date: dateStr, ok: true, count: 0 };
  }

  const stmts = events.map(event => {
    const url = event.properties?.current_url_search || event.properties?.['$current_url'] || '';
    return env.DB.prepare(`
      INSERT INTO mixpanel_events (id, event_date, url, data, synced_at)
      VALUES (?, ?, ?, ?, datetime('now'))
    `).bind(crypto.randomUUID(), dateStr, url, JSON.stringify(event));
  });

  for (let i = 0; i < stmts.length; i += 50) {
    await env.DB.batch(stmts.slice(i, i + 50));
  }

  console.log(`[mixpanel-sync] ${dateStr} — ${events.length} matching event(s) synced`);
  return { date: dateStr, ok: true, count: events.length };
}

// Public: sync a date range, day by day, sequentially.
export async function syncMixpanelDateRange(env, fromDate, toDate) {
  const domainList = (await getAllKnownDomains(env)).join(',');

  const results = [];
  for (const day of eachDay(fromDate, toDate)) {
    // Delete existing rows for this day first — re-syncing a day should
    // replace it, not duplicate on top (unlike seriti_leads, these rows
    // have no natural unique key to upsert against).
    await env.DB.prepare(`DELETE FROM mixpanel_events WHERE event_date = ?`).bind(day).run();
    const result = await syncOneDay(env, day, domainList);
    results.push(result);
  }

  const totalEvents = results.reduce((a, r) => a + r.count, 0);
  const failures     = results.filter(r => !r.ok);
  console.log(`[mixpanel-sync] Range ${fromDate} → ${toDate} complete: ${totalEvents} event(s), ${failures.length} failed day(s)`);
  return { totalEvents, days: results.length, failures: failures.length, results };
}

// Cron entry point — syncs a short rolling window.
export async function scheduledMixpanelSync(env, rollingDays = 3) {
  const to   = new Date();
  const from = new Date(Date.now() - rollingDays * 24 * 60 * 60 * 1000);
  return syncMixpanelDateRange(env, formatDate(from), formatDate(to));
}

// Deletes stored events older than the retention window — keeps D1 storage
// bounded. Mirrors seritiSync.js's cleanupOldLeads.
export async function cleanupOldMixpanelEvents(env, retentionDays = 90) {
  const cutoff = new Date(Date.now() - retentionDays * 24 * 60 * 60 * 1000);
  const cutoffDate = cutoff.toISOString().split('T')[0];

  const result = await env.DB.prepare(
    `DELETE FROM mixpanel_events WHERE event_date < ?`
  ).bind(cutoffDate).run();

  const deleted = result.meta?.changes ?? 0;
  console.log(`[mixpanel-sync] Cleanup: removed ${deleted} event(s) older than ${cutoffDate}`);
  return { deleted, cutoffDate };
}
