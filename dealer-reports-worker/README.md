# dealer-reports-backend — Cloudflare Worker

Seriti E-fficient API running on Cloudflare Workers.

## Project structure

```
src/
  index.js            ← Worker entry point + router
  seritiApiService.js ← Seriti API auth, fetch, normalise
  metricsProcessor.js ← Analytics engine (pure JS, unchanged)
  report.js           ← /api/report/* handlers
  mixpanel.js         ← /api/mixpanel/* handlers
  email.js            ← /api/email/* handlers (Resend)
wrangler.toml         ← Cloudflare config + KV bindings
.dev.vars             ← Local secrets (gitignored)
```

## First-time setup

### 1. Install Wrangler

```bash
npm install
```

### 2. Log in to Cloudflare

```bash
npx wrangler login
```

### 3. Create KV namespaces

```bash
# Production namespaces
npx wrangler kv:namespace create CACHE
npx wrangler kv:namespace create TOKENS

# Preview namespaces (for local dev)
npx wrangler kv:namespace create CACHE --preview
npx wrangler kv:namespace create TOKENS --preview
```

Each command prints an ID. Paste them into `wrangler.toml`:

```toml
[[kv_namespaces]]
binding    = "CACHE"
id         = "paste-production-id-here"
preview_id = "paste-preview-id-here"

[[kv_namespaces]]
binding    = "TOKENS"
id         = "paste-production-id-here"
preview_id = "paste-preview-id-here"
```

### 4. Set secrets (production)

Run these one at a time — Wrangler will prompt for the value:

```bash
npx wrangler secret put SERITI_API_BASE_URL
npx wrangler secret put SERITI_API_KEY_ID
npx wrangler secret put SERITI_API_SECRET
npx wrangler secret put ALLOWED_ORIGINS
npx wrangler secret put WEBHOOK_SECRET
npx wrangler secret put EMAIL_API_KEY
# Add Mixpanel secrets if needed
```

### 5. Local dev

Fill in `.dev.vars` with your actual secrets, then:

```bash
npm run dev
# Worker runs at http://localhost:8787
```

### 6. Deploy

```bash
npm run deploy
# Deploys to https://dealer-reports-backend.<your-subdomain>.workers.dev
```

## API endpoints

```
GET  /health
GET  /api/report/health
GET  /api/report/index
GET  /api/report/:clientSlug/:dealerSlug
POST /api/report/refresh          Body: { startDate, endDate }  Header: x-webhook-secret
POST /api/email                   Body: { to, subject, html, attachments? }
```

## Connecting the frontend

In your Lovable frontend repo, set:

```
VITE_API_URL=https://dealer-reports-backend.<your-subdomain>.workers.dev
```

Or if you've set up a custom domain:

```
VITE_API_URL=https://api.findndrive.co.za
```
