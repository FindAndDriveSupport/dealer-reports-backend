/**
 * seritiSync.js — Background sync: Seriti API → D1 storage
 *
 * Runs on a schedule (Cron Trigger) and on-demand (admin "Refresh data").
 * Fetches Seriti's /Reporting data in small DAY-SIZED chunks rather than
 * one large multi-week request — each individual Seriti call stays small
 * regardless of total historical volume, which is what actually protects
 * against the memory-crash class of failure (Cloudflare error 1102) we hit
 * repeatedly fetching large multi-week ranges in one call. Live dashboard
 * requests then just query D1 — fast, cheap, and never touch Seriti at
 * request time at all.
 */

import { fetchReportingData, normaliseRow, slugifyClientName } from './seritiApiService.js';

// Same hybrid resolution already proven in seritiApiService.js's
// splitByClient — GUID when Seriti provides one (correctly distinguishes
// dealers sharing one ClientName, e.g. every Alpine Motors branch),
// slugified ClientName otherwise (matches D1's legacy seriti_slug for
// dealers without a GUID).
function resolveDealerKey(rawRow) {
  if (rawRow.dealershipId) return rawRow.dealershipId.toLowerCase();
  return slugifyClientName(rawRow.clientName || 'unknown');
}

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

// Syncs one single day's data — kept small and isolated so a failure on
// one day doesn't lose progress on the rest of the range.
async function syncOneDay(env, dateStr) {
  let rawRows;
  try {
    rawRows = await fetchReportingData(env, { startDate: dateStr, endDate: dateStr });
  } catch (err) {
    await env.DB.prepare(
      `INSERT INTO seriti_sync_log (sync_date, rows_synced, status, error) VALUES (?, 0, 'error', ?)`
    ).bind(dateStr, err.message).run();
    console.error(`[sync] ${dateStr} failed: ${err.message}`);
    return { date: dateStr, ok: false, count: 0 };
  }

  if (!Array.isArray(rawRows) || rawRows.length === 0) {
    await env.DB.prepare(
      `INSERT INTO seriti_sync_log (sync_date, rows_synced, status) VALUES (?, 0, 'ok')`
    ).bind(dateStr).run();
    return { date: dateStr, ok: true, count: 0 };
  }

  // Store the NORMALIZED row (same shape processRows() already expects)
  // so reads are a plain JSON.parse with no further transformation needed.
  const stmts = rawRows.map(rawRow => {
    const dealerKey    = resolveDealerKey(rawRow);
    const applicantId  = rawRow.applicantId || crypto.randomUUID(); // fallback, shouldn't normally happen
    const normalized   = normaliseRow(rawRow);
    return env.DB.prepare(`
      INSERT INTO seriti_leads (applicant_id, dealer_key, display_name, lead_date, data, synced_at)
      VALUES (?, ?, ?, ?, ?, datetime('now'))
      ON CONFLICT(applicant_id) DO UPDATE SET
        dealer_key   = excluded.dealer_key,
        display_name = excluded.display_name,
        lead_date    = excluded.lead_date,
        data         = excluded.data,
        synced_at    = excluded.synced_at
    `).bind(
      applicantId,
      dealerKey,
      rawRow.clientName || null,
      dateStr,
      JSON.stringify(normalized),
    );
  });

  // D1 batches are capped in size — chunk defensively at 50 statements
  for (let i = 0; i < stmts.length; i += 50) {
    await env.DB.batch(stmts.slice(i, i + 50));
  }

  await env.DB.prepare(
    `INSERT INTO seriti_sync_log (sync_date, rows_synced, status) VALUES (?, ?, 'ok')`
  ).bind(dateStr, rawRows.length).run();

  console.log(`[sync] ${dateStr} — ${rawRows.length} rows synced`);
  return { date: dateStr, ok: true, count: rawRows.length };
}

// Public: sync a date range, day by day, sequentially (deliberately not
// parallel — keeps memory flat, one day's payload in memory at a time).
export async function syncDateRange(env, fromDate, toDate) {
  const results = [];
  for (const day of eachDay(fromDate, toDate)) {
    const result = await syncOneDay(env, day);
    results.push(result);
  }
  const totalRows = results.reduce((a, r) => a + r.count, 0);
  const failures  = results.filter(r => !r.ok);
  console.log(`[sync] Range ${fromDate} → ${toDate} complete: ${totalRows} rows, ${failures.length} failed day(s)`);
  return { totalRows, days: results.length, failures: failures.length, results };
}

// Cron entry point — syncs a short rolling window (catches new/updated
// leads without re-fetching ancient history on every tick).
export async function scheduledSync(env, rollingDays = 3) {
  const to   = new Date();
  const from = new Date(Date.now() - rollingDays * 24 * 60 * 60 * 1000);
  return syncDateRange(env, formatDate(from), formatDate(to));
}

// One-time bulk import — for loading a pre-fetched Seriti JSON export
// directly into D1 without re-fetching from Seriti at all. Expects the same
// raw row shape fetchReportingData() returns (an array of Seriti's raw
// camelCase objects).
export async function importRawRows(env, rawRows) {
  if (!Array.isArray(rawRows)) {
    throw new Error('Expected an array of raw Seriti rows');
  }

  let imported = 0;
  let skipped  = 0;

  const stmts = [];
  for (const rawRow of rawRows) {
    const applicantId = rawRow.applicantId;
    if (!applicantId) { skipped++; continue; }

    // lead_date comes from the row's own createdAt (rows span the whole
    // imported range, not segmented by day like the live sync path).
    const leadDate = (rawRow.createdAt || '').split('T')[0] || null;
    const dealerKey  = resolveDealerKey(rawRow);
    const normalized = normaliseRow(rawRow);

    stmts.push(
      env.DB.prepare(`
        INSERT INTO seriti_leads (applicant_id, dealer_key, display_name, lead_date, data, synced_at)
        VALUES (?, ?, ?, ?, ?, datetime('now'))
        ON CONFLICT(applicant_id) DO UPDATE SET
          dealer_key   = excluded.dealer_key,
          display_name = excluded.display_name,
          lead_date    = excluded.lead_date,
          data         = excluded.data,
          synced_at    = excluded.synced_at
      `).bind(applicantId, dealerKey, rawRow.clientName || null, leadDate, JSON.stringify(normalized))
    );
    imported++;
  }

  for (let i = 0; i < stmts.length; i += 50) {
    await env.DB.batch(stmts.slice(i, i + 50));
  }

  await env.DB.prepare(
    `INSERT INTO seriti_sync_log (sync_date, rows_synced, status) VALUES (?, ?, 'ok')`
  ).bind('bulk-import', imported).run();

  console.log(`[sync] Bulk import: ${imported} imported, ${skipped} skipped (missing applicantId)`);
  return { imported, skipped, total: rawRows.length };
}
