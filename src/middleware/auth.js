/**
 * middleware/auth.js — JWT verification middleware
 *
 * Env vars required:
 *   JWT_SECRET
 */

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
    dealerId:    payload.dealer_id  || '',
    dealerName:  payload.dealer_name || '',
    financeType: payload.finance_type || 'vehicle',
    isAdmin:     payload.is_admin === true,
    groupId:     payload.group_id || null,
    role:        payload.role || 'user',
  };
}

// ── Middleware ─────────────────────────────────────────────────────────────────

export function withAuth(handler) {
  return async (request, env, ctx) => {
    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204 });
    }

    const authHeader = request.headers.get('Authorization');
    if (!authHeader?.startsWith('Bearer ')) {
      return new Response(JSON.stringify({ error: 'Missing Authorization header' }), {
        status: 401,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    if (!env.JWT_SECRET) {
      return new Response(JSON.stringify({ error: 'JWT_SECRET not configured' }), {
        status: 500,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    const token = authHeader.slice(7);

    try {
      const payload = await verifyJwt(token, env.JWT_SECRET);
      const dealer  = extractDealer(payload);
      return handler(request, env, ctx, dealer);
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Unauthorized';
      return new Response(JSON.stringify({ error: message }), {
        status: 401,
        headers: { 'Content-Type': 'application/json' },
      });
    }
  };
}
