/**
 * middleware/auth.js — JWT verification middleware
 *
 * Verifies JWTs signed by our own worker (auth.js signJwt).
 * No longer depends on Supabase.
 *
 * Env vars required:
 *   JWT_SECRET — same secret used to sign tokens in auth.js
 */

export interface DealerContext {
  userId: string;
  email: string;
  dealerId: string;
  dealerName: string;
  financeType: 'vehicle' | 'bike';
  isAdmin: boolean;
}

// ── JWT verification (Web Crypto) ─────────────────────────────────────────────

function base64UrlDecode(str) {
  const base64 = str.replace(/-/g, '+').replace(/_/g, '/');
  const padded = base64.padEnd(base64.length + ((4 - (base64.length % 4)) % 4), '=');
  const binary = atob(padded);
  return Uint8Array.from(binary, c => c.charCodeAt(0));
}

async function verifyJwt(token, secret) {
  const [headerB64, payloadB64, signatureB64] = token.split('.');
  if (!headerB64 || !payloadB64 || !signatureB64) {
    throw new Error('Malformed JWT');
  }

  const keyData   = new TextEncoder().encode(secret);
  const cryptoKey = await crypto.subtle.importKey(
    'raw', keyData, { name: 'HMAC', hash: 'SHA-256' }, false, ['verify']
  );

  const data      = new TextEncoder().encode(`${headerB64}.${payloadB64}`);
  const signature = base64UrlDecode(signatureB64);
  const valid     = await crypto.subtle.verify('HMAC', cryptoKey, signature, data);

  if (!valid) throw new Error('Invalid JWT signature');

  const payloadJson = new TextDecoder().decode(base64UrlDecode(payloadB64));
  const payload     = JSON.parse(payloadJson);

  if (payload.exp && Date.now() / 1000 > payload.exp) {
    throw new Error('JWT expired');
  }

  return payload;
}

function extractDealer(payload) {
  return {
    userId:      payload.sub,
    email:       payload.email,
    dealerId:    payload.dealer_id || '',
    dealerName:  payload.dealer_name || '',
    financeType: payload.finance_type || 'vehicle',
    isAdmin:     payload.is_admin === true,
  };
}

// ── CORS helpers ──────────────────────────────────────────────────────────────

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, PUT, OPTIONS',
  'Access-Control-Allow-Headers': 'Authorization, Content-Type',
};

function corsResponse(body, status, extra = {}) {
  return new Response(body, {
    status,
    headers: { 'Content-Type': 'application/json', ...CORS_HEADERS, ...extra },
  });
}

// ── Middleware ─────────────────────────────────────────────────────────────────

export function withAuth(handler) {
  return async (request, env, ctx) => {
    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: CORS_HEADERS });
    }

    const authHeader = request.headers.get('Authorization');
    if (!authHeader?.startsWith('Bearer ')) {
      return corsResponse(JSON.stringify({ error: 'Missing Authorization header' }), 401);
    }

    if (!env.JWT_SECRET) {
      return corsResponse(JSON.stringify({ error: 'JWT_SECRET not configured' }), 500);
    }

    const token = authHeader.slice(7);

    try {
      const payload = await verifyJwt(token, env.JWT_SECRET);
      const dealer  = extractDealer(payload);
      return handler(request, env, ctx, dealer);
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Unauthorized';
      return corsResponse(JSON.stringify({ error: message }), 401);
    }
  };
}
