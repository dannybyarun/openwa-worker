# AGENTS.md

WhatsApp gateway for Cloudflare Workers: one Durable Object per session driving `baileys`, plus a REST API, a WebSocket event stream, and a React UI. Wrangler bundles `src/index.ts` directly (no worker build step); the UI is a Vite app in `ui/` that builds to `ui/dist` and is served by the assets binding.

## Commands (repo root; this repo *is* the worker)

- `npm ci` — must be run first; its `postinstall` patches `node_modules/@whiskeysockets/baileys` (required, see below).
- `npm run dev` — builds the UI, then local Miniflare on `http://localhost:8787`.
- `npm run dev:ui` — Vite dev server for the UI on `:5173` (proxies `/api` and `/health` to `:8787`; run `npm run dev:worker` alongside it).
- `npm run dev:worker` — `wrangler dev` only (expects `ui/dist` to exist; `npm run build` once first).
- `npm run build` — `vite build` → `ui/dist` (wrangler's `[build]` hook runs this on deploy too).
- `npm test` — `node:test` specs for the patchers, the login gate, the cursor helpers, settings and
  tokens (50 tests, no network).
- `npm run typecheck` — `tsc --noEmit` for the worker plus `tsc --noEmit -p ui` for the UI; the only static check (there is no lint/format config).
- Single spec: `node --test scripts/patch-baileys-worker-socket.spec.js`, `node --test scripts/auth.spec.mjs` or `node --test scripts/cursor.spec.mjs`, optionally `--test-name-pattern`.
- `npm run deploy` — `wrangler deploy` (the `[build]` hook compiles the UI first).
- `npm run types` — regenerate `worker-configuration.d.ts` (checked in, ~580 KB, generated — never hand-edit). It is currently stale (`wrangler types --check` fails); regenerate after any binding change.

## Architecture facts that are easy to get wrong

- `src/index.ts` must re-export both DO classes — Wrangler resolves Durable Object bindings by exported class name. It now exports three: `WhatsAppSession`, `SessionRegistry`, `TokenStore`.
- DO request routing keys on the **last** path segment, not the full path. The worker forwards `/api/sessions/:id/events` raw so the WebSocket `Upgrade` headers survive. Don't add prefix-matching routes inside `session-do.ts`.
- `WhatsAppSession` (id = session name) owns the socket, auth state, history and cursor. A single `SessionRegistry` (`idFromName('registry')`) holds the session-name list because DOs cannot be enumerated — keep it updated on create/delete.
- **Lazy lifecycle is the contract:** `/wake`, `/start` and `/send-text` open a short connected window (`IDLE_TTL_MS`, default 60 s); `/idle` (or `/ack?close=1`) closes it; the session then reports `idle`. There is no recurring alarm and no reconnect outside an active window — `alarm()` only deletes a leftover alarm from older deployments. Do not reintroduce `setAlarm()` reconnect loops: an always-on DO costs ~10,800 GB-s/day, most of the free tier's 13,000.
- `DAILY_WAKE_LIMIT` (default 300 connects/session/UTC day) guards the free tier; `/wake`, `/start` and `/send-text` return 429 past it when they would have to open a socket. `/messages?after=<seq>` is the puller cursor API (oldest-first, `nextCursor` never moves backwards, `oldestSeq` detects falling behind the 200-message cap); `/ack` prunes only after the consumer persisted the rows.
- All persistence is DO storage: `auth:*` (chunked at 60 KB because of the 128 KiB per-value cap), `status`, `history` (unacked, capped at 200, each row carries `seq`), `msgSeq`, the `wakes` counter, `chatNames` (group jid → subject, 6 h TTL, refreshed only while the socket is open), `settings` (per-session `{ ai: { provider, model, baseUrl, apiKey }, autoReply }`, normalized in `src/settings.ts`), `media:<messageId>` (the encrypted protobuf of one media message, a few hundred bytes) and `autoReply:<chatId>` (cooldown + daily count). Media rows are deleted when the history row is trimmed or acked.
- Media is **on demand**: `mapMessage()` only stores a JPEG thumbnail (`media.thumbnail`, ≤64 KB) and metadata; `GET /api/sessions/:id/media?id=<messageId>` calls `downloadMediaMessage()` and streams the bytes. Never store full media in the DO — the 128 MB memory cap and the 128 KiB value cap both bite.
- Group names: `refreshChatNames()` runs after `connection.open`, calls `groupFetchAllParticipating()` behind a 15 s timeout, caches the map in `chatNames`, includes it as `groups` in `/history`, and broadcasts `chat-names`. Never call it outside an open socket — a lazy session has no other time to fetch.
- `GET /api/usage` is the free-plan panel: it sums each session's `/usage` wake counter and estimates Durable Object duration as `wakes × idleTtl × 128 MB` against 13,000 GB-s/day. It is an estimate from our own counters (no Cloudflare analytics token); say so in docs and keep the wording honest.
- AI assist is `POST /api/sessions/:id/ai` → DO `/ai` → `draftWithAI()`. Two providers, chosen per session in settings: `workers-ai` uses the `[ai]` binding and `AI_MODEL` (default `@cf/meta/llama-4-scout-17b-16e-instruct`); `openai` posts to any OpenAI-compatible `{baseUrl}/chat/completions` through `src/ai.ts` (`callOpenAiChat`), so no binding is needed. It only returns a draft; it must never send. `501` = Workers AI binding missing, `502` = model/provider failure. Cloudflare retires models on a schedule — if drafts start failing with "deprecated", pick a current one from the Workers AI catalogue (or switch the session to an OpenAI-compatible endpoint).
- Per-session automation lives in `settings` (DO route `/settings`, pure logic in `src/settings.ts`). The `ai` block is `{ provider, model, baseUrl, apiKey }`; the key is **write-only** — `publicSettings()` strips it and the DO returns only `hasApiKey`/`apiKeyHint`. Never echo `apiKey` from a handler. `autoReply` is **opt-in**, off by default, and `maybeAutoReply()` refuses `fromMe`, `@broadcast`/`@newsletter`/`@status`, and groups unless `groups: true`; it reserves the per-chat slot (cooldown, daily cap) *before* the model call, extends the window with `activate()`, and never surfaces a failed send as a request error.
- Tokens: `TOKEN_STORE` (`idFromName('tokens')`, class `TokenStore`, migration tag `v2`) holds generated tokens. `full` = admin-equivalent (checked in `authorized()`); `embed` = send-only, pinned to one session + `chatId`, optional origin allowlist, 50 sends/UTC day. Only SHA-256 hashes are stored (`t:<hash>`), the raw value is shown once, and `POST /api/embed/send` is handled *before* `authorized()` because the widget has no admin credential. Pure helpers live in `src/tokens.ts`; never weaken `embed` tokens into read access.
- `ui/` is a React 19 + Vite + Tailwind 4 SPA (TanStack Query for the API cache, Radix for dialogs, `qrcode` for pairing). Source lives in `ui/src`; `ui/dist` is build output (gitignored) and is what the `[assets]` binding serves for everything outside `/api` and `/health`. Its worker URL lives in `localStorage` (`openwa:worker-url`); the browser holds no token — sign-in is the `openwa_session` cookie. Old builds stored an API token under `openwa:worker-token`; `loadConfig()` deletes it. `?demo` is not a thing, don't invent one.
- `apps-script/` holds the Google Sheets drainer (`Code.gs` + setup notes). Keep it in sync with the API: it calls `/wake`, `/messages`, `/ack`, `/send-text` and `/idle`.
- `src/messages.ts` is deliberately Durable-Object-free (sequence normalization, keyset selection, ack pruning) so `scripts/cursor.spec.mjs` can import it directly; Node 24 runs the `.ts` import, no build step. Put new cursor logic there, not in `session-do.ts`. The same rule applies to `src/settings.ts` and `src/tokens.ts` (specs `settings.spec.mjs`, `tokens.spec.mjs`).
- New binding/env var: add to `wrangler.toml` **and** `src/env.ts`, then `npm run types`. Production secrets via `wrangler secret put NAME`; local values in `.dev.vars` (gitignored).
- `API_TOKEN` unset **and** `UI_PASSWORD` unset means every request is allowed (local-dev posture). With either set, `src/auth.ts` gates the API: the browser posts the password to `/api/login` and gets a signed HttpOnly cookie (`openwa_session`, HMAC over its expiry, TTL from `SESSION_TTL_HOURS`); scripts still send `X-API-Key`/`Authorization: Bearer`, and WebSocket upgrades accept `?token=` because browsers can't set headers. `/api/auth`, `/api/login` and `/api/logout` are the only unauthenticated admin routes; `/api/embed/send` is the one public route and carries its own widget token. Rotating the secret invalidates every cookie.

## baileys patches — the main footgun

- `package.json` pins baileys to **exactly** `7.0.0-rc14`, and both patchers match that dist's exact source. Bumping baileys without updating the guards fails the install loudly — that is intentional, not a bug to bypass.
- `scripts/patch-baileys-worker-socket.js` swaps the `ws` client for a `fetch()`-upgrade WebSocket (workerd has no `net`/`tls`). It encodes hard-won workerd quirks — `accept()`, exactly-one `open` emit, numeric error codes, `binaryType='arraybuffer'`, no `AbortSignal` on the upgrade fetch. Read its header before changing it. Requires `nodejs_compat`.
- `scripts/patch-baileys-link-preview.js` makes `getUrlInfo` return `undefined`; otherwise every message containing a URL fails to send on Workers ("All encryptions failed").
- Patches live only in `node_modules`, applied by `postinstall`; they are not in git. Re-running is safe and idempotent.

## Gotchas

- The worker's own README documents the lazy model; when it and the code disagree, check `src/session-do.ts` — the lifecycle (`/wake` → `/messages` → `/ack` → `/idle`) is the executable truth.
- Deploy artifact is ~7.5 MiB raw / ~1.5 MiB gzip — under the free plan's 3 MiB compressed limit.
- Pairing needs a phone QR scan; the API returns the raw QR payload string, rendered client-side.
- The `test` script lists spec files explicitly (no glob) — a new spec must be added to it to run.
