# Architecture

```
Worker (src/index.ts)
  ├─ routing + login cookie / API_TOKEN auth + CORS
  ├─ SessionRegistry (one Durable Object)
  │    └─ the list of session names, because Durable Objects cannot be enumerated
  └─ WhatsAppSession (one Durable Object per session)
       ├─ socket      → patched baileys WebSocket client (fetch + Upgrade)
       ├─ auth state  → DO storage: creds + signal keys, BufferJSON, chunked
       ├─ history     → DO storage: last 200 unacked messages with `seq`
       ├─ wake budget → DO storage: connects per UTC day
       └─ events      → hibernating WebSockets to UI clients
```

## Why a Durable Object per session

A WhatsApp session needs a single writable owner of its socket and credentials. A Durable Object
gives exactly that: one instance, serialized requests, and durable storage in the same place. The
worker resolves a session name with `idFromName(name)`, so a session's identity is its name — no
mapping table, no account-side setup.

The cost is that Durable Objects are billed for wall-clock duration while active. That constraint
drives the whole lifecycle design.

## Lazy lifecycle (read this before adding reconnects)

The contract is `/wake → /messages → /ack → /idle`:

1. `POST /wake` opens a short connected window (`IDLE_TTL_MS`, default 60 s).
2. The consumer pulls with `GET /messages?after=<seq>`.
3. It persists the rows, then calls `POST /ack { upto, close: true }`.
4. The session goes idle and the socket closes.

`/start` and `/send-text` also open a window. Nothing reconnects outside one: there is no recurring
alarm, and `alarm()` only deletes a leftover alarm from older deployments.

This is deliberate. An always-connected session is ~10,800 GB-s/day (128 MB × 24 h), most of the
free plan's 13,000 GB-s/day. With a 15-minute poll and an immediate close, four sessions use a few
hundred GB-s/day. Do not reintroduce `setAlarm()` reconnect loops in a PR.

`DAILY_WAKE_LIMIT` (default 300 connects per session per UTC day) protects the remaining budget from
a bug or a too-eager poller. It returns 429 rather than silently burning quota.

## Storage layout

| Key | Contents |
| --- | --- |
| `auth:*` | baileys credentials and signal keys, `BufferJSON`-encoded and chunked at 60 KB (the per-value cap is 128 KiB). |
| `status` | the last `SessionStatus` document (`status`, `qr`, `me`, `lastDisconnect`, `updatedAt`). |
| `history` | unacked messages, oldest first, capped at 200, each with a monotonic `seq`. |
| `msgSeq` | the highest `seq` handed out. |
| `wakes` | `{ date, count }` for the daily connect budget. |

`src/messages.ts` holds the pure cursor logic (`normalizeSequences`, `selectMessages`,
`pruneAcked`) and is tested by `scripts/cursor.spec.mjs` without a Durable Object or network.

## The baileys patches

`@whiskeysockets/baileys` 7.0.0-rc14 hard-codes the `ws` package, which needs Node `net`/`tls`
sockets that workerd does not have. Two `postinstall` scripts patch the installed dist:

### `scripts/patch-baileys-worker-socket.js`

Replaces the WebSocket client with one that connects through `fetch()` and `Upgrade: websocket` —
the only Workers primitive that lets you set `Origin: https://web.whatsapp.com`, which WhatsApp's
handshake requires.

It encodes several workerd quirks that cost real debugging time:

- `accept()` must be called exactly once, and exactly one `open` event must be emitted.
- WebSocket error codes arrive as numbers, not strings.
- `binaryType` must be `'arraybuffer'`; modern workerd defaults to `blob` and baileys' noise
  decoder cannot read a Blob, so the handshake silently times out.
- No `AbortSignal.timeout()` on the upgrade `fetch()` — it keeps governing the established socket
  and aborts a healthy connection ~20 s in (surfacing as code 428). The patch races the fetch
  against a plain timer instead.

The patch is exact-match against the pinned dist and self-disabling. If baileys ships an injectable
socket, delete it.

### `scripts/patch-baileys-link-preview.js`

Makes `getUrlInfo` return `undefined`. Without it, every message containing a URL fails on Workers
with "All encryptions failed".

Both patches are idempotent and covered by `node:test`. They live only in `node_modules`, so
`npm ci` must run before anything else, and a baileys bump requires updating both guards.

## Pairing on workerd

✅ Verified against the real edge: a session links by QR from a deployed Worker, and sends and
receives messages. The two failure modes above (Blob frames, aborting upgrade fetch) were
diagnosed on a live deploy with a temporary DO-side socket trace. If pairing breaks again, suspect
those first, then TLS fingerprinting.

The QR is returned as the raw payload string. The UI renders it with `qrcode`; any QR library works.

## The UI

`ui/` is a React 19 + Vite + Tailwind 4 SPA:

- `ui/src/App.tsx` — session/chat selection, dialogs, wake/pair/send actions.
- `ui/src/hooks/useGateway.ts` — TanStack Query hooks and the events WebSocket, which writes
  directly into the query cache.
- `ui/src/components/` — chat list, chat pane, bubbles, pairing panel, Radix dialogs, toasts.
- `ui/src/lib/` — typed API client, formatting/grouping helpers, `localStorage` config.

`npm run build` emits `ui/dist`, which `wrangler.toml` serves through the `[assets]` binding for
everything outside `/api` and `/health`. Wrangler's `[build]` hook runs the build on deploy, so
`wrangler deploy` alone is enough. The build output is gitignored.

Config lives in the browser: `openwa:worker-url`, `openwa:theme`, `openwa:last-session`, and
per-chat read marks in `openwa:read`. No secret is stored there — the signed `openwa_session` cookie
(HttpOnly) is the credential, and `loadConfig()` deletes the `openwa:worker-token` older builds wrote.

## Routing detail

Inside `session-do.ts`, routing keys on the **last** path segment. The worker forwards
`/api/sessions/:id/events` as-is so the WebSocket `Upgrade` headers survive; do not add
prefix-matching routes inside the DO.
