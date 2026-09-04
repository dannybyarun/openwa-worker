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
| Reconnect + bounded downtime after DO evictions (2-min alarm loop) | ✅ |
| Real-time events to your UI over WebSocket (`connection.update`, `message`) | ✅ |
| Session list / create / status / logout REST API | ✅ |
| `whatsapp-web.js` engine, media sending, webhooks, pairing code | ❌ not in v1 |

Everything the NestJS app uses that cannot run on a Worker (Chromium, `better-sqlite3`, `sharp`,
`pg`, Redis/BullMQ, local disk, Docker, socket.io) is intentionally absent. This is the *connection
layer only*.

## Quick start

```bash
cd cloudflare-worker
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
POST   /api/sessions/:id/send-text       { "chatId": "628...@c.us", "text": "hi" } → { id, chatId, timestamp }
POST   /api/sessions/:id/logout          → { ok }                       (also removes from registry)
DELETE /api/sessions/:id                 → { ok }
GET    /api/sessions/:id/events          WebSocket upgrade → live event stream
GET    /health                           → { ok }
```

Session names: letters, digits, `-` and `_`, max 64 chars.

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
       ├─ reconnect   → backoff + 2-min alarm (DOs get evicted; alarms wake + reconnect)
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

Messages are written to the session DO's storage as they arrive (`history` key, capped at 200),
so reloading the page or reconnecting the socket restores the log; history is per-session and
shared across UI clients.

The `ui/` folder is fully portable: host it anywhere (GitHub Pages, an S3 bucket, `wrangler pages
deploy ui`, ...) and point it at the worker URL in the header bar. The API answers CORS for all
origins, and the header bar stores the worker URL + API token in `localStorage`:

- REST calls send the token as `X-API-Key` (or `Authorization: Bearer`).
- Browsers cannot set headers on `WebSocket`, so the events socket appends `?token=` — the worker
  accepts the token there too (see `authorized()` in `src/index.ts`).
- With no token configured (local-dev posture) both paths are open.

Swap `./ui` for your own frontend build at any time by changing `wrangler.toml` → `[assets]`.

## Platform caveats

- **Outbound WebSockets and eviction.** An outbound WebSocket keeps a Durable Object resident for
  at most 15 minutes, then stops preventing eviction. This DO re-arms a 2-minute alarm that wakes
  it and reconnects, and baileys reconnects on its own while resident. WhatsApp queues pending
  messages and delivers them after reconnect, so nothing is lost — but expect a brief gap if the DO
  is evicted mid-session.
- **Bundle size.** The worker uploads ~7.5 MiB (gzip ~1.5 MiB) — fine on the paid plan; check the
  free-plan 3 MiB compressed limit before deploying there.
- **Pairing requires a phone scan**; the QR is a raw string — render it client-side with any QR
  library.
- `LOG_LEVEL` (trace/debug/info/warn/error/fatal) tunes baileys' log verbosity — set it to `trace`
  when debugging the connection.

## Next steps (natural extensions)

- `POST /api/sessions/:id/pairing-code` (`sock.requestPairingCode`)
- Media sending (upload via baileys' `uploadMedia` / R2 passthrough)
- Webhooks instead of / in addition to the WebSocket event stream
- Session-scoped API keys (mirror the OpenWA model)

See the root `README.md` for the full OpenWA project, and the upstream
[baileys docs](https://baileys.wiki) for engine capabilities.