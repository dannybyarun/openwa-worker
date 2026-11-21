# API reference

All routes live under `/api` (plus `/health`). Responses are JSON. CORS is enabled for every
origin, and the WebSocket upgrade is proxied to the session's Durable Object unchanged.

- Base URL: `https://<worker>.<subdomain>.workers.dev` or your custom domain.
- Session ids: letters, digits, `-` and `_`, 1–64 characters.
- `status`: `new`, `connecting`, `qr`, `connected`, `idle`, `closed`, `loggedOut`.

## Authentication

If `API_TOKEN` is unset, every request is allowed. If it is set:

| Client | How to send it |
| --- | --- |
| REST | `X-API-Key: <token>` or `Authorization: Bearer <token>` |
| WebSocket | `?token=<token>` (browsers cannot set headers on `new WebSocket(...)`) |

```bash
curl -H "X-API-Key: $TOKEN" https://example.workers.dev/api/sessions
```

Errors are `{ "error": "message" }` with a matching status code: `400` bad input, `401`
unauthorized, `404` unknown session/route, `413` document too large, `426` WebSocket upgrade
expected, `429` daily wake limit.

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
{ "id": "support-bot", "messages": [ { "chatId": "…@s.whatsapp.net", "text": "hi", "seq": 12 } ] }
```

Newest first, capped at the last 200 unacked messages. Intended for the UI; pullers should use
`/messages`.

### `POST /api/sessions/:id/logout` · `DELETE /api/sessions/:id`

Both remove the device link, wipe the session's stored credentials, and drop it from the registry.
`{ ok: true }`.

## Lazy windows and the cursor

A session does not keep its socket open. `POST /wake`, `POST /start` and `POST /send-text` open a
window (`IDLE_TTL_MS`, default 60 s) and count against `DAILY_WAKE_LIMIT` when they have to
connect. `POST /idle` (or `POST /ack` with `"close": true`) closes it immediately.

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

With auth: `wss://host/api/sessions/:id/events?token=<API_TOKEN>`.

Frames are JSON objects with a `type` and `data`:

```json
{ "type": "connection.update", "data": { "id": "support-bot", "status": "qr", "qr": "2@…" } }
{ "type": "message", "data": { "id": "3EB0…", "chatId": "…@s.whatsapp.net", "fromMe": false,
  "pushName": "Ada", "text": "hello", "timestamp": "2026-01-01T00:00:00.000Z", "seq": 42 } }
```

The UI renders `connection.update` into its status cache and appends `message` frames to the open
chat. Pairing flow: create → start → listen → render `data.qr` until `status === "connected"`.

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
  id?: string;          // WhatsApp message id
  chatId: string;       // …@s.whatsapp.net, …@g.us, …
  fromMe?: boolean;
  sender?: string;      // participant/remote jid
  pushName?: string;    // contact display name, when WhatsApp provides one
  timestamp?: string;   // ISO 8601
  type?: string;        // conversation, extendedTextMessage, imageMessage, documentMessage, …
  text?: string;        // text or caption; '' for media without a caption
  seq?: number;         // monotonic per session — the cursor
}
```
