# API reference

All routes live under `/api` (plus `/health`). Responses are JSON. CORS is enabled for every
origin, and the WebSocket upgrade is proxied to the session's Durable Object unchanged.

- Base URL: `https://<worker>.<subdomain>.workers.dev` or your custom domain.
- Session ids: letters, digits, `-` and `_`, 1–64 characters.
- `status`: `new`, `connecting`, `qr`, `connected`, `idle`, `closed`, `loggedOut`.

## Authentication

Authentication is required when `UI_PASSWORD` or `API_TOKEN` is set. With neither, every request is
allowed (the local-dev posture).

**Browser UI.** Load the worker URL and sign in with `UI_PASSWORD` (or `API_TOKEN` when no separate
password is set). The password is exchanged for a signed, expiring cookie:

| Route | Body | Result |
| --- | --- | --- |
| `GET /api/auth` | — | `{ required, authenticated, expiresIn }` |
| `POST /api/login` | `{ "password": "..." }` | `{ ok, expiresAt }` and `Set-Cookie: openwa_session=…` |
| `POST /api/logout` | — | Clears the cookie |

The cookie is `HttpOnly; SameSite=Lax` (plus `Secure` over HTTPS), signed with HMAC-SHA256 over its
expiry and keyed from the same secret, and valid for `SESSION_TTL_HOURS` (default 168). It is also
sent on the same-origin WebSocket upgrade, so the UI needs no `?token=` once signed in. Rotating the
password/token invalidates every session. Failed logins are throttled (10 per 10 minutes per IP,
best effort per isolate) and return `429` with `Retry-After`.

**Scripts and API clients** keep using the bearer token:

| Client | How to send it |
| --- | --- |
| REST | `X-API-Key: <API_TOKEN>` or `Authorization: Bearer <API_TOKEN>` |
| WebSocket | `?token=<API_TOKEN>` (browsers cannot set headers on `new WebSocket(...)`) |

```bash
curl -H "X-API-Key: $TOKEN" https://example.workers.dev/api/sessions
```

Errors are `{ "error": "message" }` with a matching status code: `400` bad input, `401`
unauthorized, `404` unknown session/route, `413` document too large, `426` WebSocket upgrade
expected, `429` daily wake limit or login throttle.

## Sessions

### `GET /api/sessions`

```json
{
  "sessions": [
    {
      "id": "support-bot",
      "status": "idle",
      "me": { "id": "9779800000000:12@s.whatsapp.net", "name": "Support" }
    }
  ]
}
```

### `POST /api/sessions`

```json
{ "name": "support-bot" }
```

Creates the session's Durable Object and adds it to the registry. `201` with `{ id, status }`;
`400` for an invalid name or a duplicate.

### `GET /api/sessions/:id/status`

```json
{
  "id": "support-bot",
  "status": "qr",
  "qr": "2@abc...",
  "me": { "id": "9779800000000:12@s.whatsapp.net", "name": "Support" },
  "lastDisconnect": { "code": 428, "message": "Connection Terminated", "at": "2026-01-01T00:00:00.000Z" },
  "updatedAt": "2026-01-01T00:00:00.000Z"
}
```

`qr` is the raw pairing payload (a string, not an image) and is only present while pairing.

### `GET /api/sessions/:id/qr`

`{ id, status, qr? }` — the same payload without the rest of the status document. Poll this if you
only need the QR; otherwise prefer the events socket.

### `POST /api/sessions/:id/start`

Opens a pairing window (5× the idle TTL when the session is not paired yet) and starts the socket.
Returns the current status. The QR appears asynchronously; read it from `/qr`, `/status`, or the
events stream.

### `GET /api/sessions/:id/history`

```json
{
  "id": "support-bot",
  "messages": [ { "chatId": "…@s.whatsapp.net", "text": "hi", "seq": 12 } ],
  "chats": { "…@s.whatsapp.net": [ { "chatId": "…", "text": "hi", "timestamp": "…" } ] },
  "groups": { "120363025246125497@g.us": "Family" },
  "avatars": { "9779800000000@s.whatsapp.net": "data:image/jpeg;base64,…" }
}
```

Newest first, capped at the last 200 unacked messages. Intended for the UI; pullers should use
`/messages`. `groups` maps group and channel JIDs (`@g.us`, `@newsletter`) to their WhatsApp subject, cached in the session while it was connected (refreshed at most every 6 h). Channels are resolved one by one with `newsletterMetadata`, so only the 12 most recently active ones are looked up per refresh. It is empty until the session has connected at least once; a `chat-names` event delivers the same map when it refreshes.

`chats` is the durable chat index: up to 80 chats, each with its three most recent displayable
messages. It survives `/ack` and buffer rollover, so the chat list does not lose a conversation when
a puller drains the message queue. The UI merges it with `messages` (rows already in the page win).
Transport envelopes (`protocolMessage`, receipts, `messageContextInfo`) and empty unknown payloads
are never stored, and view-once/ephemeral/edited/device-sent wrappers are unwrapped to the real
message before mapping.

`avatars` holds cached profile pictures as small JPEG data URLs (`null` when WhatsApp reports no
photo). They are refreshed while the socket is open, at most once a day each, and a missing entry
can be resolved per chat with `/avatar` below.

### `GET /api/usage`

Free-plan guard rail, no Cloudflare API token needed. It asks every session for its own counters and
estimates Durable Object duration as `wakes × IDLE_TTL_MS × 128 MB`, which is the shape Cloudflare
bills. Because a drain that keeps pulling slides one window, the report also carries the ceiling for a
single wake (`perWakeCeilingGbSeconds`, using `WAKE_WINDOW_MAX_MS`):

```json
{
  "date": "2026-01-01",
  "freeTier": { "durableObjectGbSecondsPerDay": 13000, "requestsPerDay": 100000 },
  "estimate": {
    "wakes": 84, "perWakeGbSeconds": 7.68, "perWakeCeilingGbSeconds": 38.4,
    "doGbSeconds": 645.1, "projectedDoGbSeconds": 1290, "doPercentOfFree": 9
  },
  "idleTtlMs": 60000,
  "wakeWindowMaxMs": 300000,
  "sessions": [
    { "id": "support-bot", "status": "idle", "idleTtlMs": 60000, "wakeWindowMaxMs": 300000,
      "wakes": { "used": 84, "limit": 300, "remaining": 216, "limited": true } }
  ],
  "warnings": [],
  "note": "Estimated from this worker's own wake counters. Cloudflare's dashboard has the billed numbers."
}
```

Treat the numbers as an early warning, not billing truth: the dashboard's analytics are the only
authoritative source (the worker has no analytics token).

### `POST /api/sessions/:id/ai`

Drafts a reply (or a summary) for one chat from the stored history. It never sends anything — you get
text back and decide. The default backend is Workers AI through the `[ai]` binding; a session can
switch to any OpenAI-compatible endpoint (see settings below).

```json
{ "chatId": "9779800000000@s.whatsapp.net", "mode": "reply", "instruction": "say I'll call tonight" }
```

```json
{
  "session": "support-bot",
  "chatId": "9779800000000@s.whatsapp.net",
  "mode": "reply",
  "model": "@cf/meta/llama-4-scout-17b-16e-instruct",
  "messages": 12,
  "draft": "Sounds good — I'll call you tonight."
}
```

`mode` is `reply` (default) or `summary`; `instruction` is optional. It uses the last 30 stored
messages for the chat, so a chat with no history returns `400`. `501` means Workers AI was selected
but the worker was deployed without the `[ai]` binding, `502` the model call failed. Override the
model with `AI_MODEL`, or per session with `POST /api/sessions/:id/settings`.

### `GET` · `POST /api/sessions/:id/settings`

Per-session automation, stored in the session's Durable Object.

```json
{
  "id": "support-bot",
  "settings": {
    "ai": {
      "provider": "workers-ai",
      "model": "@cf/openai/gpt-oss-20b",
      "hasApiKey": false
    },
    "autoReply": {
      "enabled": true,
      "prompt": "Reply in Nepali, two sentences max.",
      "groups": false,
      "cooldownSeconds": 120,
      "dailyLimit": 20
    }
  },
  "defaults": {
    "provider": "workers-ai",
    "aiModel": "@cf/meta/llama-4-scout-17b-16e-instruct",
    "autoReply": { "cooldownSeconds": 120, "dailyLimit": 20, "groups": false }
  }
}
```

`POST` takes a partial patch and returns the merged result:

```json
{
  "ai": {
    "provider": "openai",
    "model": "gpt-4o-mini",
    "baseUrl": "https://api.openai.com/v1",
    "apiKey": "sk-…"
  },
  "autoReply": { "enabled": true }
}
```

Provider rules:

- `workers-ai` — `model` must be an `@scope/name` id; empty falls back to `AI_MODEL`, then the built-in
  default. `baseUrl`/`apiKey` are ignored (stored as null).
- `openai` — anything that speaks `POST {baseUrl}/chat/completions` (OpenAI, Groq, OpenRouter,
  Together, Fireworks, Ollama, LM Studio, vLLM). `baseUrl` must be `http(s)`; a full
  `…/chat/completions` URL is accepted as-is.
- The API key is **write-only**: `GET` returns `hasApiKey` plus `apiKeyHint` (`••••abcd`), never the
  value. Sending `apiKey: null` (or an empty string) clears it; omitting it keeps the stored key.

`ai: null` clears the block, as does `autoReply: null`. Numbers are clamped: `cooldownSeconds`
10–3600, `dailyLimit` 1–200. Auto-reply only runs inside a connected window, never answers `fromMe`,
status broadcasts or newsletters, skips groups unless `groups: true`, and reserves its slot before
calling the model so a burst cannot fan out.

### `GET /api/sessions/:id/media?id=<messageId>&download=1`

Streams the actual bytes of one media message (image, video, audio, sticker, document). The message
row only carries a small JPEG thumbnail; the file is downloaded from WhatsApp when this route is
called, then returned with its `content-type` and filename. `download=1` sets
`content-disposition: attachment`. `404` means the row was pruned from the 200-message history,
`413` means the file is over 20 MB (tested against `fileLength` before downloading).

### `GET /api/sessions/:id/avatar?jid=<jid>`

The profile picture for one chat, as a small JPEG data URL:

```json
{ "jid": "9779800000000@s.whatsapp.net", "url": "data:image/jpeg;base64,…", "cached": true }
```

`url` is `null` when WhatsApp reports no photo (hidden privacy setting, or a chat that never had
one) — clients should fall back to initials. Avatars are cached in the session for 24 h (a missing
one is retried after 6 h) and refreshed while the socket is open, so an idle session returns
`cached: true` with whatever it already knows. `400` means the `jid` is not a WhatsApp address;
`@g.us` (group) and `@lid` addresses work too.

### `POST /api/sessions/:id/logout` · `DELETE /api/sessions/:id`

Both remove the device link, wipe the session's stored credentials, chat index, history, cached
photos and group names, and drop it from the registry. `{ ok: true }`.

### `GET /api/sessions/:id/auth-export` · `POST /api/sessions/:id/auth-import`

Credential backup, for moving a linked WhatsApp account to another deployment without a new QR scan.
Both require the session to be closed (send `/idle` first; a connected window returns `409`).

`GET` returns the raw `auth:*` storage layout:

```json
{
  "kind": "openwa-auth-backup",
  "version": 1,
  "session": "support-bot",
  "exportedAt": "2026-01-01T00:00:00.000Z",
  "entries": { "auth:creds": { "v": "…" }, "auth:key:session:…": { "v": "…" } }
}
```

`POST` takes `{ "confirm": "<session name>", "entries": { … } }` — the exact session name is required,
every key must start with `auth:`, `auth:creds` must be present, and the payload is capped at 5 MB.
Import wipes the existing credentials first and also clears chats, photos and group names, because a
different account must not inherit them. The session reports `closed`; `POST /wake` reconnects as
the imported account.

**This file is the device.** Anyone holding it can read and send as the linked number. Store it
encrypted and delete it after the move. The UI exposes both calls under Settings → Backup, behind a
typed confirmation.

## Lazy windows and the cursor

A session does not keep its socket open. `POST /wake`, `POST /start` and `POST /send-text` open a
window (`IDLE_TTL_MS`, default 60 s) and count against `DAILY_WAKE_LIMIT` when they have to
connect. A pull (`GET /messages`) taken while that window is live slides it by another `IDLE_TTL_MS`,
up to `WAKE_WINDOW_MAX_MS` (default 5 min) from the wake, so a drain that runs past 60 s is not cut in
half — but a pull cannot open a window by itself. `POST /idle` (or `POST /ack` with `"close": true`)
closes it immediately.

### `POST /api/sessions/:id/wake?wait=15000`

Wakes the session and optionally waits up to `wait` ms (default 15000, max 20000) for the socket to
open. Returns the status plus `wake`:

```json
{
  "id": "support-bot",
  "status": "connected",
  "wake": { "used": 12, "limit": 300, "date": "2026-01-01", "counted": true }
}
```

`429` with a message like `daily wake limit reached (300/300); resets at 00:00 UTC` when the cap is
hit. `DAILY_WAKE_LIMIT=0` disables the cap.

### `GET /api/sessions/:id/messages?after=<seq>&limit=100`

Oldest-first page of messages with `seq > after`. `limit` defaults to 100, max 200.

```json
{
  "id": "support-bot",
  "messages": [ { "seq": 41, "chatId": "…@s.whatsapp.net", "text": "hi" } ],
  "nextCursor": 41,
  "hasMore": false,
  "oldestSeq": 12
}
```

- Persist `nextCursor` and pass it back as `after`. It never moves backwards, even when a page is
  empty.
- Strictly-greater semantics: `after=41` returns `seq 42…`.
- `oldestSeq` is the oldest row still stored. If `oldestSeq > nextCursor + 1`, the consumer fell
  further behind than the 200-row cap and some messages were dropped.
- Messages are only removed by `/ack`; reading does not delete anything.

### `POST /api/sessions/:id/ack`

```json
{ "upto": 41, "close": true }
```

Deletes rows with `seq <= upto` — call it **after** the consumer has persisted them. Returns
`{ id, upto, acked, remaining }`. `close: true` also ends the wake window.

### `POST /api/sessions/:id/idle`

Closes the socket now. The session reports `idle`. This is what the Apps Script drainer calls in a
`finally` block.

## Sending

### `POST /api/sessions/:id/send-text`

```json
{ "chatId": "9779800000000@s.whatsapp.net", "text": "hello" }
```

Opens/extends a wake window, waits for the socket, sends, and retries once on a stale socket.
Returns `{ id, chatId, timestamp }` (`id` is the WhatsApp message id).

### `POST /api/sessions/:id/send-document`

```json
{
  "chatId": "9779800000000@s.whatsapp.net",
  "fileName": "statement.pdf",
  "mimetype": "application/pdf",
  "caption": "January",
  "base64": "JVBERi0xLjQK…"
}
```

Base64 payloads avoid needing R2. Max 8 MiB after decoding; the bytes are held in the Durable
Object's memory for the upload. Returns `{ id, chatId, fileName, mimetype, bytes, timestamp }`.
URL-safe base64 and embedded newlines are accepted.

## Events (WebSocket)

```
GET /api/sessions/:id/events        Upgrade: websocket
```

Scripts authenticate with `wss://host/api/sessions/:id/events?token=<API_TOKEN>`. A browser on the
worker's own origin does not need it: the login cookie goes out with the upgrade.

Frames are JSON objects with a `type` and `data`:

```json
{ "type": "connection.update", "data": { "id": "support-bot", "status": "qr", "qr": "2@…" } }
{ "type": "message", "data": { "id": "3EB0…", "chatId": "…@s.whatsapp.net", "fromMe": false,
  "pushName": "Ada", "text": "hello", "timestamp": "2026-01-01T00:00:00.000Z", "seq": 42 } }
{ "type": "chat-names", "data": { "120363025246125497@g.us": "Family" } }
```

The UI renders `connection.update` into its status cache, appends `message` frames to the open
chat, and merges `chat-names` into the group-name map. Pairing flow: create → start → listen →
render `data.qr` until `status === "connected"`.

## Webhooks

Set `INBOUND_WEBHOOK_URL` to receive inbound messages (`INBOUND_WEBHOOK_TOKEN` becomes an
`Authorization: Bearer` header). Deliveries are fire-and-forget, retried by no one, and skip
self-messages, protocol noise, and `@broadcast`/`@newsletter`/`@status` chats:

```json
{ "session": "support-bot", "at": "2026-01-01T00:00:00.000Z", "message": { "chatId": "…", "text": "hi" } }
```

## Message shape

```ts
interface Message {
  id?: string;          // WhatsApp message id — also the media handle
  chatId: string;       // …@s.whatsapp.net, …@g.us, …
  fromMe?: boolean;
  sender?: string;      // participant/remote jid
  pushName?: string;    // contact display name, when WhatsApp provides one
  timestamp?: string;   // ISO 8601
  type?: string;        // conversation, extendedTextMessage, imageMessage, documentMessage, …
  text?: string;        // text or caption; '' for media without a caption
  seq?: number;         // monotonic per session — the cursor
  preview?: {           // Open Graph card WhatsApp attached, when present
    url: string;
    title?: string;
    description?: string;
    thumbnail?: string; // small JPEG as a data URL
  };
  media?: {             // metadata only; bytes come from /media
    mimetype?: string;
    fileName?: string;
    fileLength?: number;
    seconds?: number;
    width?: number;
    height?: number;
    ptt?: boolean;      // voice note
    thumbnail?: string; // small JPEG as a data URL
  };
}
```

## Tokens: sending, embedding and admin

Admin routes — every one requires the login cookie or an admin token.

| Route | Purpose |
| --- | --- |
| `GET /api/tokens` | List generated tokens (never the value, only an `owa_…` prefix) |
| `POST /api/tokens` | Create one; the raw value is returned once |
| `DELETE /api/tokens/:id` | Revoke |

Three kinds, chosen at creation:

| Kind | Use | Can send | Daily cap |
| --- | --- | --- | --- |
| `embed` | public website widget | text, one pinned chat | 50 |
| `send` | your backend / app | text **and** documents, one session, optional chat allowlist | 500 |
| `full` | scripts, dashboards | everything `API_TOKEN` can do | none |

```json
{ "kind": "embed", "label": "Website chat", "session": "support-bot",
  "chatId": "9779800000000@s.whatsapp.net", "origins": "https://example.com", "expiresInDays": 90 }
```

```json
{ "kind": "send", "label": "Invoices", "session": "support-bot",
  "chatIds": "9779800000000, 9779811111111", "expiresInDays": 365 }
```

`kind: "embed"` needs `session` and `chatId`. `kind: "send"` needs `session`; `chatIds` is optional
(a comma string or array, phone numbers or JIDs, max 50) and an empty list means "any chat". Its
`origins` stay empty for server use — a non-empty list would require a browser `Origin` header.
`kind: "full"` is admin-equivalent and can be used anywhere `API_TOKEN` is accepted (`X-API-Key`,
`Authorization: Bearer`, `?token=`). Either way the response is `{ "token": "owa_…", "record": { … } }`;
only a SHA-256 hash of the value is stored, so copy it immediately.

### `POST /api/send` (public, token-authenticated)

Sending for your own backend, without holding the admin credential. The token must be
`kind: "send"`; it is bound to one session and can never read history, settings or tokens.

```json
{
  "token": "owa_…",
  "chatId": "9779800000000",
  "text": "Invoice INV-42 — Rs 2500, due 30 Nov",
  "document": {
    "fileName": "invoice-INV-42.pdf",
    "mimetype": "application/pdf",
    "caption": "Invoice INV-42 — Rs 2500, due 30 Nov",
    "base64": "JVBERi0xLjQK…"
  }
}
```

```json
{ "ok": true, "kind": "document", "chatId": "9779800000000@s.whatsapp.net",
  "id": "3EB0…", "fileName": "invoice-INV-42.pdf", "bytes": 48112 }
```

- `chatId` accepts digits (`9779800000000`), a formatted number, or a full JID. When the token has a
  `chatIds` allowlist, any other target is `403`.
- Send text only, a document only, or both (`document.caption`, falling back to `text`). Text is
  capped at 4096 characters, captions at 1024, documents at 8 MiB decoded (`413`).
- The route opens the lazy window itself and retries once on a stale socket.
- `401` invalid/expired token, `403` wrong kind / chat not allowed / origin, `429` daily send cap
  (500/UTC day) or the session's wake budget, `502` WhatsApp refused the send.

See [Integrations](integrations.md) for the server, PHP and static-site recipes, and
`examples/invoice-send/` for a runnable invoice flow.

### `POST /api/embed/send` (public, token-authenticated)

The endpoint behind `embed.js`. No cookie, no API key — the widget token is the credential.

```json
{ "token": "owa_…", "text": "Do you deliver to Lalitpur?" }
```

```json
{ "ok": true, "id": "3EB0…" }
```

Restrictions: the token must be `kind: "embed"`, the request `Origin` must match its allowlist when
one was set, the message goes to the token's own `chatId` only (a different `chatId` in the body is
`403`), text is capped at 1000 characters, and each token gets 50 sends per UTC day (`429` after
that). Errors are `401` invalid/expired token, `403` wrong kind/origin/chat, `429` daily limit, and
`502` if WhatsApp refused the send.

## MCP

`POST /mcp` is a Model Context Protocol endpoint over stateless Streamable HTTP (JSON-RPC 2.0, no
SSE, no session id, no extra Durable Object). It authenticates with `Authorization: Bearer`,
`X-API-Key` or `?token=` and never with cookies: `API_TOKEN`/`full` tokens get all five tools, a
`send` token gets `send_text` only (pinned session and chat allowlist, same 500/day budget), and
`embed` tokens are refused. Tools, client configuration and limits: [MCP server](mcp.md).
