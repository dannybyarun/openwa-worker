# Deployment and configuration

OpenWA Worker needs no databases, buckets, queues, or KV namespaces. The two Durable Object classes
are declared in `wrangler.toml`, so a fresh deploy creates everything it needs.

## Contents

- [One-click deploy](#one-click-deploy)
- [Deploy with Wrangler](#deploy-with-wrangler)
- [Deploy with an AI agent](#deploy-with-an-ai-agent)
- [Secrets and variables](#secrets-and-variables)
- [Custom domain](#custom-domain)
- [First run](#first-run)
- [Free-tier budgets](#free-tier-budgets)
- [Updating a deployment](#updating-a-deployment)
- [Hosting the UI separately](#hosting-the-ui-separately)

## One-click deploy

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/dannybyarun/openwa-worker)

The button clones the repo into a new Worker, runs `npm ci` (which patches baileys) and
`npm run build`, then deploys. Keep the worker name `openwa-worker` unless you also update any
links you have; the name itself is not load-bearing.

You will be asked for `API_TOKEN` because it is declared under `cloudflare.bindings` in
`package.json`. If you skip it, the API is open — set it afterwards:

```bash
npx wrangler secret put API_TOKEN --name openwa-worker
```

That token is also the browser login password. To use a different password for the UI (keeping the
token for scripts), add a second secret:

```bash
npx wrangler secret put UI_PASSWORD --name openwa-worker
```

## Deploy with Wrangler

```bash
git clone https://github.com/dannybyarun/openwa-worker
cd openwa-worker
npm ci
npx wrangler login
npm run deploy                 # vite build → ui/dist, then wrangler deploy
npx wrangler secret put API_TOKEN      # scripts + fallback login password
npx wrangler secret put UI_PASSWORD    # optional separate UI password
```

`wrangler.toml` has a `[build]` hook, so plain `npx wrangler deploy` also builds the UI. The
`postinstall` patch of `@whiskeysockets/baileys` is **required**; if it fails, the install fails on
purpose rather than deploying a worker whose socket cannot connect.

To run locally: `npm run dev` (see the README for the two-process UI workflow).

## Deploy with an AI agent

Paste into an agent that has terminal access:

```text
Deploy OpenWA Worker from https://github.com/dannybyarun/openwa-worker to my Cloudflare account.

1. Read README.md, docs/deployment.md and wrangler.toml first.
2. Ask me for a strong password using a secret input. Never print it, commit it, or pass it as a
   command-line argument.
3. Run `npm ci` exactly as written. Its postinstall patches @whiskeysockets/baileys for workerd; do
   not skip scripts, upgrade baileys, or patch around a guard failure.
4. Run `npm run deploy`.
5. Set the password with `npx wrangler secret put UI_PASSWORD`. It gates the UI and the API.
6. Give me the workers.dev URL. Tell me to sign in, create a session and scan the QR from WhatsApp →
   Linked devices. Do not attempt to pair WhatsApp yourself.
```

## Secrets and variables

Set production values with `wrangler secret put NAME`; put local values in `.dev.vars`
(gitignored — start from `.dev.vars.example`).

| Name | Required | Default | Purpose |
| --- | --- | --- | --- |
| `UI_PASSWORD` | recommended | falls back to `API_TOKEN` | Browser login password. Rotating it signs every browser out. |
| `SESSION_TTL_HOURS` | no | `168` | Browser login lifetime in hours (max 720). |
| `API_TOKEN` | recommended | unset = open | Bearer token for REST (`X-API-Key`, `Authorization: Bearer`), the events socket (`?token=`), and the login password when `UI_PASSWORD` is unset. |
| `IDLE_TTL_MS` | no | `60000` | How long a wake keeps the socket open (clamped 5 s – 15 min). |
| `DAILY_WAKE_LIMIT` | no | `300` | Connects per session per UTC day; `0` disables the cap. |
| `AI_MODEL` | no | `@cf/meta/llama-4-scout-17b-16e-instruct` | Workers AI model used by **Draft with AI** (`POST /api/sessions/:id/ai`). |
| `INBOUND_WEBHOOK_URL` | no | unset | POST inbound messages here as JSON. |
| `INBOUND_WEBHOOK_TOKEN` | no | unset | Sent as `Authorization: Bearer` on webhook deliveries. |
| `LOG_LEVEL` | no | `info` | baileys verbosity: `trace`, `debug`, `info`, `warn`, `error`, `fatal`. |

Changing bindings or vars in `wrangler.toml` means updating `src/env.ts` too, then
`npm run types` to refresh `worker-configuration.d.ts` (generated; never hand-edit).

## Custom domain

1. Add the domain to the same Cloudflare account.
2. In the dashboard: **Workers & Pages → openwa-worker → Settings → Domains & Routes → Add custom
   domain**, or add a route in `wrangler.toml`:

   ```toml
   routes = [{ pattern = "wa.example.com", custom_domain = true }]
   ```

3. Redeploy with `npm run deploy`.

WebSockets work on custom domains and workers.dev alike. Keep the UI on the worker's own origin —
the login cookie is same-origin, so a UI hosted elsewhere cannot sign in (see
[Hosting the UI separately](#hosting-the-ui-separately)).

## First run

1. Open the worker URL. If a password or token is set, the page shows **Sign in**; with neither it
   shows **Create a session**.
2. Sign in with `UI_PASSWORD` (or `API_TOKEN`), then create a session (letters, digits, `-`, `_`; max
   64 chars). The name is the Durable Object id.
3. Press **Show QR code**. The worker opens a pairing window and the UI renders the QR payload.
4. On your phone: **WhatsApp → Settings/Menu → Linked devices → Link a device** and scan.
5. The status turns `connected`, then `idle` after the window closes. Messages are queued by
   WhatsApp while idle and delivered on the next wake.

Sessions are also manageable over the API — see [API reference](api.md).

## Tokens and the website widget

`API_TOKEN` is a single shared secret. The app can also mint individual tokens under **Settings →
Website widget**, which is the better option once anything public is involved:

- **`full`** — admin-equivalent, accepted anywhere `API_TOKEN` is (`X-API-Key`,
  `Authorization: Bearer`, `?token=` on the events socket). Use it for scripts and rotate per client.
- **`embed`** — send-only, bound to one session and one chat, optionally restricted to a list of
  origins, capped at 50 messages per UTC day and an expiry you choose. This is what `embed.js` uses.

Only a SHA-256 hash of each token is stored in the `TokenStore` Durable Object, so the value is
shown exactly once. Revoking it deletes the hash; nothing else changes. The public endpoint is
`POST /api/embed/send` — it never reads history, settings, or other chats.

Note the migration: `wrangler.toml` now has a `v2` migration that creates `TokenStore`. Deploying
over an older worker applies it automatically; deleting the DO afterwards would revoke every token.

## Free-tier budgets

Two limits matter. Do the math before shortening your poll interval.

- **Durable Object duration:** 13,000 GB-s/day on the free plan. A DO is billed at 128 MB while it
  is doing work; an always-on session is ~10,800 GB-s/day. Lazy windows are why this project fits.
- **Worker requests:** 100,000/day. Each wake costs a handful of requests plus a WebSocket upgrade.

Rules of thumb (4 sessions, ~8 s per drain):

| Poll | Runs/day | DO GB-s/day | Notes |
| --- | --- | --- | --- |
| 5 min | 288 | ~1,150 | over the Apps Script 90 min/day runtime if you use Sheets |
| 10 min | 144 | ~575 | tight for Apps Script |
| **15 min** | **96** | **~385** | safe default for both quotas |
| 30 min | 48 | ~190 | lowest cost, highest latency |

`DAILY_WAKE_LIMIT` is per session, so 15-minute polling leaves room for manual wakes from the UI.
A 429 means the session hit the cap and will reset at 00:00 UTC.

Open **Free plan usage** in the app (or `GET /api/usage`) for a live estimate: it adds up each
session's wake counter, projects today's Durable Object GB-s, and warns before you cross 13,000. The
number is an estimate from the worker's own counters — the Cloudflare dashboard has the billed
figures. Workers AI (the chat assistant and auto-reply) has its own free daily Neuron allowance and
is only used when someone presses **Draft with AI** or auto-reply is enabled for a session.

### Choosing an AI provider

The default is Workers AI, which needs no key and stays inside the free plan. If you would rather
use another model, open **Settings → AI & auto-reply** and pick **OpenAI-compatible**: set the base
URL (`https://api.openai.com/v1`, `https://api.groq.com/openai/v1`,
`https://openrouter.ai/api/v1`, `http://localhost:11434/v1` for Ollama, …), the model name, and the
API key. The worker calls `POST {baseUrl}/chat/completions` with `Authorization: Bearer <key>`.

Keys set this way live in the session's Durable Object storage (Cloudflare encrypts DO storage at
rest) and are never returned by the API — `GET /settings` only reports `hasApiKey` and the last four
characters. Prefer a scoped/limited key. A session-level setting always wins over `AI_MODEL`.

## Updating a deployment

```bash
git pull
npm ci          # re-applies the baileys patches for the pinned version
npm run deploy
```

Secrets survive a deploy. If you change bindings (new DO class, new env var), the migration tags in
`wrangler.toml` must move forward — do not reuse a tag.

`package.json` pins baileys to an exact `7.0.0-rc14`. Upgrading it requires updating both patch
guards in `scripts/`; a failed guard is intentional protection against deploying an unpatched
socket.

## Hosting the UI separately

`npm run build` emits a fully static `ui/dist`. The normal setup is to let the worker serve it (the
`[assets]` binding does that), because the browser login is a same-origin HttpOnly cookie.

If you host the files elsewhere, the page loads but cannot sign in — the login cookie belongs to the
worker's origin. Use the default (worker-served UI) for browser access, and talk to the REST API from
your own frontend with `X-API-Key` instead. The API answers CORS for every origin.
