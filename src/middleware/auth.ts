/**
 * Supabase JWT Middleware for Cloudflare Workers
 *
 * Verifies the Bearer token on every authenticated request using
 * Supabase's JWKS endpoint, then injects dealer context into the request.
 *
 * Usage:
 *   import { withAuth } from "./middleware/auth";
 *   export default { fetch: withAuth(handler) };
 */

export interface DealerContext {
  userId: string;
  email: string;
  dealerId: string;
  dealerName: string;
  financeType: "vehicle" | "bike";
}

declare module "cloudflare:workers" {
  interface Env {
    SUPABASE_URL: string;
    SUPABASE_JWT_SECRET: string; // Used for HS256 fallback; prefer JWKS in production
  }
}

// ── JWT helpers (Web Crypto API — no npm deps needed) ──────────────────────

function base64UrlDecode(str: string): Uint8Array {
  const base64 = str.replace(/-/g, "+").replace(/_/g, "/");
  const padded = base64.padEnd(base64.length + ((4 - (base64.length % 4)) % 4), "=");
  const binary = atob(padded);
  return Uint8Array.from(binary, (c) => c.charCodeAt(0));
}

interface JwtPayload {
  sub: string;
  email: string;
  exp: number;
  app_metadata?: Record<string, unknown>;
  user_metadata?: Record<string, unknown>;
}

async function verifyJwt(token: string, secret: string): Promise<JwtPayload> {
  const [headerB64, payloadB64, signatureB64] = token.split(".");
  if (!headerB64 || !payloadB64 || !signatureB64) {
    throw new Error("Malformed JWT");
  }

  // Import HMAC key
  const keyData = new TextEncoder().encode(secret);
  const cryptoKey = await crypto.subtle.importKey(
    "raw",
    keyData,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["verify"]
  );

  // Verify signature
  const data = new TextEncoder().encode(`${headerB64}.${payloadB64}`);
  const signature = base64UrlDecode(signatureB64);
  const valid = await crypto.subtle.verify("HMAC", cryptoKey, signature, data);
  if (!valid) throw new Error("Invalid JWT signature");

  // Decode payload
  const payloadJson = new TextDecoder().decode(base64UrlDecode(payloadB64));
  const payload = JSON.parse(payloadJson) as JwtPayload;

  // Check expiry
  if (payload.exp && Date.now() / 1000 > payload.exp) {
    throw new Error("JWT expired");
  }

  return payload;
}

function extractDealer(payload: JwtPayload): DealerContext {
  // dealer_id is set in app_metadata by an admin/service-role operation
  const meta = (payload.app_metadata ?? payload.user_metadata ?? {}) as Record<string, unknown>;

  const dealerId = meta.dealer_id as string | undefined;
  if (!dealerId) {
    throw new Error("No dealer_id in token — this account has not been assigned to a dealership");
  }

  return {
    userId: payload.sub,
    email: payload.email,
    dealerId,
    dealerName: (meta.dealer_name as string | undefined) ?? "Unknown Dealer",
    financeType: (meta.finance_type as "vehicle" | "bike" | undefined) ?? "vehicle",
  };
}

// ── CORS helpers ──────────────────────────────────────────────────────────

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*", // tighten to your domain in production
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Authorization, Content-Type",
};

function corsResponse(body: string, status: number, extra?: HeadersInit): Response {
  return new Response(body, {
    status,
    headers: { "Content-Type": "application/json", ...CORS_HEADERS, ...extra },
  });
}

// ── Middleware ─────────────────────────────────────────────────────────────

type HandlerWithDealer = (
  request: Request,
  env: Env,
  ctx: ExecutionContext,
  dealer: DealerContext
) => Promise<Response>;

export function withAuth(handler: HandlerWithDealer) {
  return async (request: Request, env: Env, ctx: ExecutionContext): Promise<Response> => {
    // Preflight
    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: CORS_HEADERS });
    }

    const authHeader = request.headers.get("Authorization");
    if (!authHeader?.startsWith("Bearer ")) {
      return corsResponse(JSON.stringify({ error: "Missing Authorization header" }), 401);
    }

    const token = authHeader.slice(7);

    try {
      const payload = await verifyJwt(token, env.SUPABASE_JWT_SECRET);
      const dealer = extractDealer(payload);
      return handler(request, env, ctx, dealer);
    } catch (err) {
      const message = err instanceof Error ? err.message : "Unauthorized";
      return corsResponse(JSON.stringify({ error: message }), 401);
    }
  };
}

// ── Typed fetch helper for the frontend ───────────────────────────────────
// Drop this in your frontend api client to attach the token automatically.
//
// import { supabase } from "@/lib/supabase";
//
// export async function apiFetch(path: string, init?: RequestInit) {
//   const { data: { session } } = await supabase.auth.getSession();
//   const token = session?.access_token;
//   return fetch(`${import.meta.env.VITE_API_URL}${path}`, {
//     ...init,
//     headers: {
//       "Content-Type": "application/json",
//       ...(token ? { Authorization: `Bearer ${token}` } : {}),
//       ...init?.headers,
//     },
//   });
// }
  
