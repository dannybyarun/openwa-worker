# OpenWA Worker — WhatsApp gateway for Cloudflare Workers

A WhatsApp connection layer that runs on Cloudflare Workers: one Durable Object per WhatsApp
session, driving the [`baileys`](https://github.com/WhiskeySockets/Baileys) engine with a minimal
REST API, a WebSocket event stream, and a small static UI (served from the same worker, or host it
anywhere). **Verified: linking a device via QR works from the real Cloudflare edge.**

---

## What this is

| Capability | Status |
| --- | --- |
| One WhatsApp session per Durable Object (`baileys` engine only) | ✅ |
| Link via QR code, persisted auth state (creds + signal keys) in DO storage | ✅ |
| Send text messages | ✅ |
| Lazy connect windows + idle close (`/wake`, `/ack`, `/idle`) for free-tier budgets | ✅ |
| Cursor API for pullers (`GET /messages?after=`) | ✅ |
| Inbound webhook push (`INBOUND_WEBHOOK_URL`) | ✅ |
| Real-time events to your UI over WebSocket (`connection.update`, `message`) | ✅ |
| Session list / create / status / logout REST API | ✅ |
| Google Apps Script / Sheets drainer (works with no R2 or D1) | ✅ `apps-script/` |
| `whatsapp-web.js` engine, media sending, pairing code | ❌ not in v1 |

Everything the NestJS app uses that cannot run on a Worker (Chromium, `better-sqlite3`, `sharp`,
`pg`, Redis/BullMQ, local disk, Docker, socket.io) is intentionally absent. This is the *connection
layer only*.

## Quick start

```bash
npm ci          # installs baileys + patches its WebSocket client for Workers (postinstall)
npm test        # patch-script specs
npm run typecheck
npm run dev     # local Miniflare on http://localhost:8787
```

Deploy:

```bash
npx wrangler login
npx wrangler deploy
npx wrangler secret put API_TOKEN   # optional but recommended
```

## API

All routes under `/api`, CORS-enabled for all origins. When `API_TOKEN` is set, send it as
`X-API-Key: <token>` or `Authorization: Bearer <token>` (for WebSocket upgrades, `?token=` —
browsers can't set headers on `new WebSocket(...)`); when unset (local dev) every request is
allowed.

```
POST   /api/sessions                     { "name": "my-bot" }          → 201 { id, status }
GET    /api/sessions                     → { sessions: [{ id, status, me? }] }
GET    /api/sessions/:id/status          → { id, status, qr?, me?, lastDisconnect?, updatedAt }
GET    /api/sessions/:id/qr              → { id, status, qr? }          (raw QR payload string)
GET    /api/sessions/:id/history         → { id, messages: [...] }      (last 200, newest first)
POST   /api/sessions/:id/start           → { id, status }               (starts connecting / QR flow)
POST   /api/sessions/:id/wake?wait=15000 → { id, status, wake }         (connect for one idle window)
GET    /api/sessions/:id/messages?after=0&limit=100
                                         → { messages, nextCursor, hasMore, oldestSeq }
POST   /api/sessions/:id/ack             { "upto": 123, "close": true } → prune acked messages
POST   /api/sessions/:id/idle            → { id, status }               (close the socket now)
POST   /api/sessions/:id/send-text       { "chatId": "628...@c.us", "text": "hi" } → { id, chatId, timestamp }
POST   /api/sessions/:id/logout          → { ok }                       (also removes from registry)
DELETE /api/sessions/:id                 → { ok }
GET    /api/sessions/:id/events          WebSocket upgrade → live event stream
GET    /health                           → { ok }
```

Session names: letters, digits, `-` and `_`, max 64 chars. `status` is one of `new`, `connecting`,
`qr`, `connected`, `idle`, `closed`, `loggedOut`.

### Lazy connect windows

The worker does **not** keep the socket open. Every connect attempt is counted per session per UTC
day (`DAILY_WAKE_LIMIT`, default 300; 429 after that):

```
POST /wake  → opens a window (IDLE_TTL_MS, default 60 s) and optionally waits for the socket
POST /send-text → also opens/extends a window (and counts if it had to connect)
GET  /messages?after=<seq> → unacked messages, oldest first, each with a monotonic `seq`
POST /ack {upto} → delete rows you have stored; add "close": true to idle immediately
POST /idle → close now (this is what the Apps Script drainer calls in its finally block)
```

`messages` is the puller API: `nextCursor` is safe to persist, never moves backwards, and
`oldestSeq` lets a client detect that it fell further behind than the 200-message cap. `start`
uses a 5× longer window when the session is not paired yet, so the QR can be scanned.

### Apps Script + Google Sheets (no R2 / D1)

[`apps-script/`](./apps-script/) contains a ready `Code.gs` that wakes each session on a time
trigger, drains `GET /messages`, appends to an `Inbox` sheet, acks, sends pending `Outbox` rows, and
closes with `/idle`. That keeps free-tier Durable Object duration in the hundreds of GB-s/day
instead of tens of thousands. See [`apps-script/README.md`](./apps-script/README.md) for the
cadence-vs-quota math.

### Real-time events (for your static UI)

Connect to the WebSocket, then render the QR from `connection.update` events and live messages from
`message` events:

```js
const ws = new WebSocket(`wss://your-worker.example.com/api/sessions/${id}/events`);
ws.onmessage = (e) => {
  const { type, data } = JSON.parse(e.data);
  if (type === 'connection.update' && data.qr) renderQr(data.qr);   // data.qr is the raw payload
  if (type === 'message') appendMessage(data);                       // { id, chatId, fromMe, sender, text, ... }
};
```

A typical pairing flow: `POST /api/sessions {name}` → `POST /api/sessions/:id/start` → open the
events WebSocket (or poll `/qr`) → show `data.qr` until `status === 'connected'`.

## Architecture

```
Worker (src/index.ts)                 ── REST + WS upgrade routing, API_TOKEN auth
  ├─ SessionRegistry (DO, single)     ── the list of session names (DOs can't be enumerated)
  └─ WhatsAppSession (DO, per session)── owns the baileys socket
       ├─ auth state  → DO storage    ── creds + signal keys, BufferJSON-encoded, chunked >60 KiB
       ├─ socket      → patched baileys WebSocketClient (fetch()-upgrade, see below)
       ├─ lifecycle   → /wake opens a window, /idle closes it; no recurring alarm
       └─ events      → hibernation WebSockets to UI clients
```

### The baileys patch (`scripts/patch-baileys-worker-socket.js`)

`@whiskeysockets/baileys` 7.0.0-rc14 hard-codes the `ws` npm package for its WebSocket
(`lib/Socket/Client/websocket.js`), and `ws` needs Node `net`/`tls` sockets that Workers don't
have. The postinstall patch swaps that one file for an equivalent client that connects through
workerd's `fetch()` + `Upgrade: websocket` (the only Workers primitive that lets you set the
`Origin: https://web.whatsapp.com` header WhatsApp's handshake requires):

```js
const response = await fetch('https://web.whatsapp.com/ws/chat', {
  headers: { origin: DEFAULT_ORIGIN, upgrade: 'websocket' },
});
const socket = response.webSocket;
```

The patch is exact-match and self-disabling (same house style as the root repo's `scripts/patch-*.js`),
pinned to the 7.0.0-rc14 dist shape, and covered by `node:test` specs. **Retire it** if baileys
ever ships an injectable socket.

## Pairing status on Cloudflare Workers

✅ **Working — verified against the real edge.** A session links via QR from a deployed Worker.
The transport works because the postinstall patch compensates for two workerd behaviors that
plain Node (`ws`) never had:

1. **Binary frames arrive as `Blob`.** Modern workerd defaults `WebSocket.binaryType` to `blob`
   (the WHATWG default); Miniflare and older workerd used `arraybuffer`. Baileys' noise decoder
   cannot read a Blob, so `validateConnection` never saw the server's handshake response and timed
   out after `connectTimeoutMs` — by which point WhatsApp had already killed the half-open
   connection. The patch pins `socket.binaryType = 'arraybuffer'` and converts Blobs as a fallback.
2. **An `AbortSignal.timeout()` on the upgrade `fetch()` keeps governing the socket.** The timer
   fired 20 s after every connect and aborted the (healthy) established connection with
   "The operation was aborted due to timeout", surfacing as code 428 `Connection Terminated` on a
   20-second cycle. The patch races the fetch against a plain timer instead, so the timeout only
   applies to a *hung handshake*.

Both were diagnosed on a live deploy with a temporary DO-side trace of socket events (open/close/
error + frame sizes), removed once fixed. If WhatsApp ever starts refusing pairing again, first
suspect these two, then the TLS-fingerprint angle (the community's
[`whatsapp-cloudflare-workers`](https://github.com/rafaelsg-01/whatsapp-cloudflare-workers) project
worked on Workers before mid-2025 and may carry a workaround).

## Static UI

The worker serves a small single-page UI from `./ui` (Cloudflare's static-assets pipeline) on `/`
— session management (auto-refreshing every 5 s), live QR rendering, a real-time message stream
over the events WebSocket, chat history (the last 200 messages per session, persisted in DO
storage), a per-chat filter, and sending text. Open your deployed worker URL and you're on it.
The **Wake** button opens a connected window; the session returns to `idle` when it closes.

Messages are written to the session DO's storage as they arrive (`history` key, capped at 200 and
pruned by `POST /ack`), so reloading the page or reconnecting the socket restores the log; history
is per-session and shared across UI clients.

The `ui/` folder is fully portable: host it anywhere (GitHub Pages, an S3 bucket, `wrangler pages
deploy ui`, ...) and point it at the worker URL in the header bar. The API answers CORS for all
origins, and the header bar stores the worker URL + API token in `localStorage`:

- REST calls send the token as `X-API-Key` (or `Authorization: Bearer`).
- Browsers cannot set headers on `WebSocket`, so the events socket appends `?token=` — the worker
  accepts the token there too (see `authorized()` in `src/index.ts`).
- With no token configured (local-dev posture) both paths are open.

Swap `./ui` for your own frontend build at any time by changing `wrangler.toml` → `[assets]`.

## Platform caveats

- **Lazy sockets are the default.** `/wake`, `/start` and `/send-text` open a short connected window
  (`IDLE_TTL_MS`, default 60 s); `/ack?close=1` or `/idle` closes it immediately and the session
  goes to `idle`. There is no recurring alarm and no reconnection outside an active window. This is
  deliberate: an always-connected Durable Object burns ~10,800 GB-s/day (128 MB × 24 h), which is
  most of the free plan's 13,000 GB-s/day for a single session. With a 15-min poll and an immediate
  close, four sessions use only a few hundred GB-s/day.
- **`DAILY_WAKE_LIMIT`** (default 300 connects per session per UTC day) bounds a runaway loop. A
  5-min poll uses 288; 429 responses mean the session waits for the 00:00 UTC reset.
- **Latency is the poll interval.** WhatsApp queues messages while the socket is closed and delivers
  them on the next wake, so nothing is lost if the puller is slow. The 200-message unacked cap and
  `oldestSeq` are how a client detects that it fell too far behind.
- **Bundle size.** The worker uploads ~7.5 MiB (gzip ~1.5 MiB) — under the free-plan 3 MiB
  compressed limit, but check it after dependency changes.
- **Pairing requires a phone scan**; the QR is a raw string — render it client-side with any QR
  library. Pressing Wake/Start on an unpaired session keeps a 5× longer window so you have time.
- `LOG_LEVEL` (trace/debug/info/warn/error/fatal) tunes baileys' log verbosity — set it to `trace`
  when debugging the connection. `IDLE_TTL_MS` and `DAILY_WAKE_LIMIT` are optional vars/secrets.

## Next steps (natural extensions)

- `POST /api/sessions/:id/pairing-code` (`sock.requestPairingCode`)
- Media sending (upload via baileys' `uploadMedia`; the cursor API can carry the metadata)
- Session-scoped API keys (mirror the OpenWA model)

See the root `README.md` for the full OpenWA project, and the upstream
[baileys docs](https://baileys.wiki) for engine capabilities.