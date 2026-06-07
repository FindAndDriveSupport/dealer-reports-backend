/**
 * email.js — Cloudflare Worker edition
 *
 * Handles /api/email/* routes.
 * Uses Resend (or SMTP fallback) for PDF email delivery.
 *
 * Env vars available:
 *   env.EMAIL_PROVIDER   (resend | smtp)
 *   env.EMAIL_FROM
 *   env.EMAIL_FROM_NAME
 *   env.EMAIL_API_KEY    (Resend API key)
 *
 * Note: Workers support fetch() to Resend's REST API natively.
 * SMTP is NOT supported in Workers — use Resend or similar HTTP-based provider.
 */

import { json } from './index.js';

export async function handleEmail(request, env, path, method) {
  if (method !== 'POST') {
    return json({ error: 'Method not allowed' }, 405);
  }

  const apiKey   = env.EMAIL_API_KEY;
  const from     = env.EMAIL_FROM;
  const fromName = env.EMAIL_FROM_NAME || 'Seriti E-fficient';

  if (!apiKey || !from) {
    return json({ error: 'Email not configured — set EMAIL_API_KEY and EMAIL_FROM' }, 503);
  }

  let body;
  try { body = await request.json(); } catch {
    return json({ error: 'Invalid JSON body' }, 400);
  }

  const { to, subject, html, attachments } = body;

  if (!to || !subject || !html) {
    return json({ error: 'to, subject and html are required' }, 400);
  }

  // Send via Resend REST API (works natively in Workers)
  const res = await fetch('https://api.resend.com/emails', {
    method:  'POST',
    headers: {
      Authorization:  `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      from:        `${fromName} <${from}>`,
      to:          Array.isArray(to) ? to : [to],
      subject,
      html,
      attachments: attachments || [],
    }),
  });

  if (!res.ok) {
    const err = await res.text();
    console.error(`[email] Resend error (${res.status}): ${err}`);
    return json({ error: `Email send failed: ${err}` }, 502);
  }

  const result = await res.json();
  return json({ success: true, id: result.id });
}
