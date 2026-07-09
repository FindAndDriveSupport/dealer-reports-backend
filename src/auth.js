/**
 * auth.js — Magic link authentication
 *
 * Routes:
 *   POST /api/auth/magic-link   — send magic link to email
 *   POST /api/auth/verify       — verify token, return JWT
 *   GET  /api/auth/me           — return current user from JWT
 *
 * Env vars required:
 *   RESEND_API_KEY
 *   JWT_SECRET          — secret for signing JWTs (set via wrangler secret put JWT_SECRET)
 *
 * D1 binding required:
 *   DB — postal-codes-db
 */

import { json } from './index.js';

const MAGIC_LINK_EXPIRY_MINUTES = 60;
const JWT_EXPIRY_SECONDS        = 60 * 60 * 24 * 7; // 7 days
const SITE_URL                  = 'https://analytics.findndrive.co.za';
const FROM_EMAIL                = 'noreply@findndrive.co.za';
const FROM_NAME                 = 'E-fficient Analytics';

// ── Crypto helpers ────────────────────────────────────────────────────────────

function generateToken(length = 32) {
  const bytes = new Uint8Array(length);
  crypto.getRandomValues(bytes);
  return Array.from(bytes).map(b => b.toString(16).padStart(2, '0')).join('');
}

function generateId() {
  return crypto.randomUUID();
}

// ── JWT helpers (Web Crypto — no npm deps) ────────────────────────────────────

async function signJwt(payload, secret) {
  const header  = { alg: 'HS256', typ: 'JWT' };
  const now     = Math.floor(Date.now() / 1000);
  const claims  = { ...payload, iat: now, exp: now + JWT_EXPIRY_SECONDS };

  const encode  = obj => btoa(JSON.stringify(obj)).replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');
  const data    = `${encode(header)}.${encode(claims)}`;

  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );

  const sig     = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(data));
  const sigB64  = btoa(String.fromCharCode(...new Uint8Array(sig)))
    .replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');

  return `${data}.${sigB64}`;
}

// ── Email helpers ─────────────────────────────────────────────────────────────

async function sendMagicLinkEmail(env, { email, token, dealerName }) {
  const link = `${SITE_URL}/auth/verify?token=${token}`;
  const name = dealerName || 'there';

  const html = `
    <!DOCTYPE html>
    <html>
    <body style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; background: #f8fafc; margin: 0; padding: 40px 20px;">
      <div style="max-width: 480px; margin: 0 auto; background: white; border-radius: 24px; padding: 40px; border: 1px solid #e2e8f0;">
        <div style="text-align: center; margin-bottom: 32px;">
          <div style="display: inline-flex; align-items: center; justify-content: center; width: 48px; height: 48px; background: #0f766e; border-radius: 16px; margin-bottom: 12px;">
            <span style="color: white; font-size: 20px; font-weight: 900;">E</span>
          </div>
          <p style="margin: 0; font-size: 13px; font-weight: 600; color: #475569; letter-spacing: 0.05em;">E-FFICIENT ANALYTICS</p>
        </div>

        <h1 style="font-size: 22px; font-weight: 700; color: #0f172a; margin: 0 0 8px;">Sign in to your dashboard</h1>
        <p style="font-size: 15px; color: #64748b; margin: 0 0 32px;">Hi ${name}, click the button below to sign in. This link expires in ${MAGIC_LINK_EXPIRY_MINUTES} minutes.</p>

        <a href="${link}" style="display: block; text-align: center; background: #0f766e; color: white; text-decoration: none; padding: 14px 24px; border-radius: 12px; font-size: 15px; font-weight: 600; margin-bottom: 24px;">
          Sign in to E-fficient Analytics
        </a>

        <p style="font-size: 13px; color: #94a3b8; margin: 0; text-align: center;">
          If you didn't request this, you can safely ignore this email.
        </p>

        <hr style="border: none; border-top: 1px solid #e2e8f0; margin: 24px 0;" />
        <p style="font-size: 12px; color: #cbd5e1; margin: 0; text-align: center;">
          Find &amp; Drive Group (Pty) Ltd · ${SITE_URL}
        </p>
      </div>
    </body>
    </html>
  `;

  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${env.RESEND_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      from: `${FROM_NAME} <${FROM_EMAIL}>`,
      to:   [email],
      subject: 'Your E-fficient Analytics sign-in link',
      html,
    }),
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Failed to send email: ${body}`);
  }
}

// ── Route handler ─────────────────────────────────────────────────────────────

export async function handleAuth(request, env, path, method) {
  const subPath = path.replace('/api/auth', '') || '/';

  // POST /api/auth/magic-link — send magic link
  if (subPath === '/magic-link' && method === 'POST') {
    let body = {};
    try { body = await request.json(); } catch {}

    const email = (body.email || '').toLowerCase().trim();
    if (!email || !email.includes('@')) {
      return json({ error: 'Valid email address required' }, 400);
    }

    if (!env.DB) return json({ error: 'Database not configured' }, 500);

    // Look up user
    const user = await env.DB.prepare(
      `SELECT id, email, dealer_name, status FROM users WHERE email = ?`
    ).bind(email).first();

    if (!user) {
      // Return success anyway to avoid email enumeration
      return json({ success: true, message: 'If this email is registered, a sign-in link has been sent.' });
    }

    // Generate token
    const token      = generateToken();
    const expiresAt  = new Date(Date.now() + MAGIC_LINK_EXPIRY_MINUTES * 60 * 1000).toISOString();

    await env.DB.prepare(
      `UPDATE users SET invite_token = ?, invite_expires_at = ? WHERE id = ?`
    ).bind(token, expiresAt, user.id).run();

    try {
      await sendMagicLinkEmail(env, {
        email,
        token,
        dealerName: user.dealer_name,
      });
    } catch (err) {
      console.error('[auth] email error:', err.message);
      return json({ error: 'Failed to send sign-in email. Please try again.' }, 502);
    }

    return json({ success: true, message: 'Sign-in link sent — check your inbox.' });
  }

  // POST /api/auth/verify — verify token, return JWT
  if (subPath === '/verify' && method === 'POST') {
    let body = {};
    try { body = await request.json(); } catch {}

    const token = (body.token || '').trim();
    if (!token) return json({ error: 'Token is required' }, 400);

    if (!env.DB) return json({ error: 'Database not configured' }, 500);
    if (!env.JWT_SECRET) return json({ error: 'JWT secret not configured' }, 500);

    // Look up token
    const user = await env.DB.prepare(
      `SELECT * FROM users WHERE invite_token = ?`
    ).bind(token).first();

    if (!user) {
      return json({ error: 'Invalid or expired sign-in link.' }, 401);
    }

    // Check expiry
    if (new Date(user.invite_expires_at) < new Date()) {
      return json({ error: 'This sign-in link has expired. Please request a new one.' }, 401);
    }

    // Clear token + update last sign in
    await env.DB.prepare(
      `UPDATE users SET invite_token = NULL, invite_expires_at = NULL, last_sign_in_at = datetime('now'), status = 'active' WHERE id = ?`
    ).bind(user.id).run();

    // Issue JWT
    const jwt = await signJwt({
      sub:          user.id,
      email:        user.email,
      dealer_id:    user.dealer_id,
      dealer_name:  user.dealer_name,
      finance_type: user.finance_type,
      is_admin:     user.is_admin === 1,
    }, env.JWT_SECRET);

    return json({
      success: true,
      token:   jwt,
      user: {
        id:          user.id,
        email:       user.email,
        dealerId:    user.dealer_id,
        dealerName:  user.dealer_name,
        financeType: user.finance_type,
        isAdmin:     user.is_admin === 1,
      },
    });
  }

  return json({ error: 'Not found' }, 404);
}
