/**
 * seritiApiService.js — Cloudflare Worker edition
 *
 * Changes from Node version:
 *   • No `import fetch from 'node-fetch'` — fetch is native in Workers
 *   • No process.env — credentials come from `env` passed into each function
 *   • Buffer.from(...base64...) → atob() (Workers have Web Crypto, not Node Buffer)
 *   • Token cache uses Cloudflare KV (env.TOKENS) so it persists across
 *     Worker restarts and is shared between instances.
 *     KV key: "seriti:token"
 *     KV value: JSON { token, expiresAt }
 */
const TOKEN_KV_KEY    = 'seriti:token';
const TOKEN_BUFFER_MS = 30_000; // refresh 30s before actual expiry
// ─── KV token cache helpers ───────────────────────────────────────────────────
async function getCachedToken(env) {
  try {
    const raw = await env.TOKENS.get(TOKEN_KV_KEY);
    if (!raw) return null;
    const { token, expiresAt } = JSON.parse(raw);
    if (Date.now() < expiresAt - TOKEN_BUFFER_MS) return token;
    return null; // expired
  } catch {
    return null;
  }
}
async function setCachedToken(env, token, expiresAt) {
  // KV TTL is in seconds from now — align it with the token expiry
  const ttlSeconds = Math.max(60, Math.floor((expiresAt - Date.now()) / 1000));
  await env.TOKENS.put(
    TOKEN_KV_KEY,
    JSON.stringify({ token, expiresAt }),
    { expirationTtl: ttlSeconds }
  );
}
async function clearCachedToken(env) {
  await env.TOKENS.delete(TOKEN_KV_KEY);
}
// ─── Authenticate ─────────────────────────────────────────────────────────────
async function authenticate(env) {
  const baseUrl   = env.SERITI_API_BASE_URL?.replace(/\/$/, '');
  const apiKeyId  = env.SERITI_API_KEY_ID;
  const apiSecret = env.SERITI_API_SECRET;
  if (!baseUrl || !apiKeyId || !apiSecret) {
    throw new Error('SERITI_API_BASE_URL, SERITI_API_KEY_ID and SERITI_API_SECRET must be set');
  }
  console.log('[seriti] Authenticating...');
  const res = await fetch(`${baseUrl}/Authentication/token`, {
    method:  'POST',
    headers: { 'Content-Type': 'application/json' },
    body:    JSON.stringify({ ApiKeyId: apiKeyId, ApiSecret: apiSecret }),
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Seriti auth failed (${res.status}): ${body}`);
  }
  const data = await res.json();
  // Handle common ASP.NET token response shapes
  const token =
    data.token        ||
    data.accessToken  ||
    data.access_token ||
    data.Token        ||
    data.AccessToken  ||
    (typeof data === 'string' ? data : null);
  if (!token) {
    throw new Error(`Seriti auth succeeded but no token found in response: ${JSON.stringify(data)}`);
  }
  // Parse JWT expiry — atob() replaces Buffer.from(..., 'base64') in Workers
  let expiryMs = 60 * 60 * 1000; // 1 hour default
  try {
    const parts   = token.split('.');
    // JWT uses base64url — pad and replace chars before decoding
    const b64     = parts[1].replace(/-/g, '+').replace(/_/g, '/');
    const padded  = b64 + '=='.slice((b64.length % 4 === 0) ? 4 : b64.length % 4);
    const payload = JSON.parse(atob(padded));
    if (payload.exp) {
      expiryMs = (payload.exp * 1000) - Date.now();
    }
  } catch {
    // Can't parse JWT — use default 1 hour
  }

  const expiresAt = Date.now() + expiryMs;
  await setCachedToken(env, token, expiresAt);
  console.log(`[seriti] Authenticated — token valid for ${Math.round(expiryMs / 60000)} min`);
  return token;
}
// ─── Get valid token (from KV cache or fresh auth) ────────────────────────────
async function getToken(env) {
  const cached = await getCachedToken(env);
  if (cached) return cached;
  return authenticate(env);
}
// ─── Fetch reporting data ─────────────────────────────────────────────────────
async function fetchReportingData(env, { startDate, endDate }) {
  const baseUrl = env.SERITI_API_BASE_URL?.replace(/\/$/, '');
  const token   = await getToken(env);
  const params = new URLSearchParams({ startDate, endDate });
  const url    = `${baseUrl}/Reporting?${params}`;
  console.log(`[seriti] Fetching reporting data (${startDate} → ${endDate})...`);
  const res = await fetch(url, {
    headers: {
      Authorization: `Bearer ${token}`,
      Accept:        'application/json',
    },
  });
  // Token rejected mid-session — refresh once and retry
  if (res.status === 401) {
    console.log('[seriti] Token rejected — refreshing and retrying...');
    await clearCachedToken(env);
    const freshToken = await authenticate(env);
    const retry = await fetch(url, {
      headers: {
        Authorization: `Bearer ${freshToken}`,
        Accept:        'application/json',
      },
    });
    if (!retry.ok) {
      const body = await retry.text();
      throw new Error(`Seriti API error after token refresh (${retry.status}): ${body}`);
    }
    return retry.json();
  }

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Seriti API error (${res.status}): ${body}`);
  }
  return res.json();
}
// ─── Normalise API row → processor shape ─────────────────────────────────────
function normaliseRow(row) {
  const NULL_GUID   = '00000000-0000-0000-0000-000000000000';
  const isNullGuid  = (v) => !v || v === NULL_GUID;
  const nullIfEmpty = (v) => (!v || v === '' || v === NULL_GUID) ? null : v;
  return {
    // Identity
    ClientName:          row.clientName             || null,
    ApplicantId:         row.applicantId            || null,
    FirstName:           (row.firstName || '').trim(),
    LastName:            (row.lastName  || '').trim(),
    MobileNumber:        row.mobileNumber           || null,
    EmailAddress:        nullIfEmpty(row.emailAddress),
    IdNumber:            nullIfEmpty(row.idNumber),
    Gender:              nullIfEmpty(row.gender),
    DateOfBirth:         row.dateOfBirth            || null,
    MaritalStatus:       row.maritalStatus          || null,
    Occupation:          nullIfEmpty(row.occupation),
    AgeGroup:            nullIfEmpty(row.ageGroup),
    // Dealer
    DealershipId:        row.dealershipId           || null,
    DealerShip:          row.dealerShip             || null,
    ClientId:            row.clientId               || null,
    // Finance / income
    GrossIncome:         row.grossIncome            ?? null,
    NetIncome:           row.netIncome              ?? null,
    LivingExpenses:      row.livingExpenses         ?? null,
    BureauExpenses:      row.bureauExpenses         ?? null,
    CalculatedGross:     row.calculatedGross        ?? null,
    CalculatedNet:       row.calculatedNet          ?? null,
    CalculatedLivingExpenses: row.calculatedLivingExpenses ?? null,
    CalculatedTotalExpenses:  row.calculatedTotalExpenses  ?? null,
    DisposableIncome:    row.disposableIncome       ?? null,
    MonthlyFinancingAmount: row.monthlyFinancingAmount ?? null,
    TotalFinancingAmount:   row.totalFinancingAmount   ?? null,
    Deposit:             row.deposit                ?? null,
    // Prediction / approval
    PredictorConfidence:     row.predictorConfidence    || null,
    IncomePredictionValue:   row.incomePredictionValue  ?? null,
    ChancesOfApproval:       row.chancesOfApproval      || null,
    EstimatedApprovalAmount: row.estimatedApprovalAmount || null,
    EstimatedFinanceSpend:   row.estimatedFinanceSpend  || null,
    EstimatedInsuranceSpend: row.estimatedInsuranceSpend || null,
    ImprovementSuggestion:   row.improvementSuggestion  || null,
    // Credit — null GUID means no credit check was run
    CreditScore:    isNullGuid(row.applicantCreditId) ? null : (row.creditScore ?? null),
    ScoreIndicator: isNullGuid(row.applicantCreditId) ? null : (row.scoreIndicator ?? null),
    RiskBand:       isNullGuid(row.applicantCreditId) ? null : (row.riskBand ?? null),
    // Application — null GUID means not submitted
    SubmittedOn:       isNullGuid(row.carFinanceApplicationId) ? null : (row.submittedOn ?? null),
    Status:            isNullGuid(row.carFinanceApplicationId) ? null : (row.status ?? null),
    StatusDescription: isNullGuid(row.carFinanceApplicationId) ? null : (row.statusDescription ?? null),
    Provider:          row.provider  || null,
    Reference:         row.reference || null,
    // Vehicle
    VehicleDescription: row.vehicleDescription || null,
    RetailPrice:        row.retailPrice        || null,
    // Timestamps
    CreatedAt: row.createdAt || null,
    CreatedOn: row.createdOn || null,
    // Profile
    LSM:                   row.lsm                   || null,
    ProfileContactAbility: row.profileContactAbility || null,
    HomeOwnership:         nullIfEmpty(row.homeOwnership),
  };
}
// ─── Exports ──────────────────────────────────────────────────────────────────
export async function fetchLeadData(env, { startDate, endDate }, onlyDealershipId = null) {
  const raw = await fetchReportingData(env, { startDate, endDate });
  if (!Array.isArray(raw)) {
    throw new Error(`Seriti API returned unexpected shape: ${JSON.stringify(raw).slice(0, 200)}`);
  }
  console.log(`[seriti] Received ${raw.length} rows`);

  // When targeting a single dealer, filter the RAW rows (plain objects,
  // cheap to check a field on) BEFORE running them through normaliseRow —
  // which builds a ~40-field object per row. Normalizing every row in the
  // account just to throw away all but one dealer's worth was still
  // expensive enough to trip the Worker's CPU time limit even after
  // report.js's per-dealer targeting, since this happens upstream of that.
  const filtered = onlyDealershipId
    ? raw.filter(row => row.dealershipId === onlyDealershipId)
    : raw;

  if (onlyDealershipId) {
    console.log(`[seriti] Filtered to ${filtered.length} row(s) for dealershipId=${onlyDealershipId} before normalising`);
  }

  return filtered.map(normaliseRow);
}

export function splitByClient(rows) {
  const map = {};
  rows.forEach(row => {
    // DealershipId is Seriti's stable GUID (carFinanceDealershipBranchId on
    // their branches endpoint) — unlike ClientName, which is free text and
    // was the root cause of a recurring class of bug: our own slugification
    // of ClientName ("FindAndDrive" → "findanddrive") silently drifting from
    // whatever got manually stored in D1 ("findndrive"), breaking access for
    // that dealer with no clear error. Falls back to ClientName only if a
    // row is somehow missing the GUID (shouldn't normally happen).
    const key = row.DealershipId || row.ClientName || 'Unknown';
    if (!map[key]) map[key] = [];
    map[key].push(row);
  });
  return map;
}

export async function testConnection(env) {
  try {
    await authenticate(env);
    return { ok: true, message: 'Seriti API authenticated successfully' };
  } catch (err) {
    return { ok: false, message: err.message };
  }
}
