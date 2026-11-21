# Integrate WhatsApp into your app or website

The gateway is a plain HTTP API, so "sending an invoice from my app" is one `fetch` call. Pick the
credential by where the code runs:

| Where the code runs | Credential | Can do | Daily cap |
| --- | --- | --- | --- |
| Your backend (Node, PHP, Laravel, Django, Go…) | `send` token | text **and** documents (PDF invoices), one session, optional chat allowlist | 500 sends/UTC day |
| Your website in the browser (static site, no backend) | `embed` token | text only, one fixed chat, optional origin allowlist | 50 sends/UTC day |
| Admin scripts, dashboards | `full` token or `API_TOKEN` | everything, including reading chats | none |

Mint `send`/`embed` tokens in the dashboard: **Settings → Sending & widget**. The value is shown
once; only its SHA-256 hash is stored, so a lost token is revoked and replaced, never recovered.
Never put a `full` token (or `API_TOKEN`) in browser code — it can read every chat and manage
sessions.

## 1. Send an invoice from your backend

```bash
curl -X POST 'https://wa.example.com/api/send' \
  -H 'content-type: application/json' \
  -d '{
    "token": "owa_…",
    "chatId": "9779800000000",
    "text": "Invoice INV-42 — Rs 2500, due 30 Nov",
    "document": {
      "fileName": "invoice-INV-42.pdf",
      "mimetype": "application/pdf",
      "caption": "Invoice INV-42 — Rs 2500, due 30 Nov",
      "base64": "JVBERi0xLjQK…"
    }
  }'
```

```json
{ "ok": true, "kind": "document", "chatId": "9779800000000@s.whatsapp.net",
  "id": "3EB0…", "fileName": "invoice-INV-42.pdf", "bytes": 48112 }
```

Node (18+, no dependencies):

```ts
const pdf = await renderInvoicePdf(invoice);            // Buffer
const res = await fetch(`${WORKER}/api/send`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({
    token: process.env.WA_SEND_TOKEN,                    // owa_…
    chatId: invoice.phone,                               // digits or a full JID
    text: `Invoice ${invoice.number} — ${invoice.total}`,
    document: {
      fileName: `invoice-${invoice.number}.pdf`,
      mimetype: 'application/pdf',
      caption: `Invoice ${invoice.number} — ${invoice.total}`,
      base64: pdf.toString('base64'),
    },
  }),
});
if (!res.ok) throw new Error(`WhatsApp ${res.status}: ${(await res.json()).error}`);
const { id } = await res.json();                         // store it next to the invoice
```

PHP:

```php
$payload = json_encode([
  'token'  => getenv('WA_SEND_TOKEN'),
  'chatId' => $invoice['phone'],
  'text'   => "Invoice {$invoice['number']}",
  'document' => [
    'fileName' => "invoice-{$invoice['number']}.pdf",
    'mimetype' => 'application/pdf',
    'caption'  => "Invoice {$invoice['number']}",
    'base64'   => base64_encode($pdfBytes),
  ],
]);
$ch = curl_init('https://wa.example.com/api/send');
curl_setopt_array($ch, [
  CURLOPT_POST => true,
  CURLOPT_HTTPHEADER => ['content-type: application/json'],
  CURLOPT_POSTFIELDS => $payload,
  CURLOPT_RETURNTRANSFER => true,
]);
$response = curl_exec($ch);
```

Rules that matter:

- `chatId` accepts `9779800000000`, `+977 980-0000000`, or a full JID (`…@s.whatsapp.net`,
  `…@lid`, `…@g.us`).
- `text` alone sends a text message (≤ 4096 chars); `document` alone sends the file;
  both together uses `document.caption` (falling back to `text`).
- Documents are base64 in the body: 8 MiB decoded max (`413` past it).
- The endpoint owns the lazy lifecycle — it wakes the WhatsApp socket, waits for it, and retries
  once on a stale socket. You do not call `/wake` first.
- Sends made inside one open window (60 s) share the same connect, so a batch of invoices costs
  ~1 wake, not one per message. `DAILY_WAKE_LIMIT` (default 300) caps connects, not messages.
- `429` = the token's daily cap or the session's wake budget is spent (resets 00:00 UTC).
  `403` = token not allowed to send to that chat / origin mismatch. `401` = bad, expired or
  revoked token.

The `send` token is bound to one session (one WhatsApp number) and can be restricted to a static
list of chats at creation time. Leave the list empty when the token must reach arbitrary customers,
and keep that token on the server only.

`examples/invoice-send/` has a runnable version: a CLI (`send-invoice.mjs`) and a tiny
server + HTML form (`server.mjs`, `form.html`) that builds a sample PDF, sends it, and prints the
message id.

## 2. Sending from a static site (no backend)

An `embed` token is meant to be public: it can only send text to the one chat it was created for,
from the origins you allow, 50 messages a day, and it cannot read anything.

```html
<script src="https://wa.example.com/embed.js"
        data-token="owa_…"
        data-title="Chat with us"
        async></script>
```

Or call the API yourself:

```ts
await fetch('https://wa.example.com/api/embed/send', {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ token: 'owa_…', text: 'Hi, I need help with order 1234' }),
});
```

Because it is text-only, the usual invoice pattern is a link to the PDF on your own site (signed
URL, short expiry) rather than the PDF itself:

```ts
text: `Invoice ${number} is ready: https://shop.example.com/invoices/${token}`
```

If the site must send documents, or message many different customers, it needs a small backend (or
a serverless function) holding a `send` token — that is recipe 1.

## 3. Receiving replies

Two options, pick one:

- **Webhook** — set `INBOUND_WEBHOOK_URL` (and optionally `INBOUND_WEBHOOK_TOKEN`, sent as
  `Authorization: Bearer`). Every inbound message is POSTed as
  `{ session, at, message }`. Fire-and-forget: no retries, so make the handler quick and idempotent
  on `message.id`.
- **WebSocket** — `GET /api/sessions/:id/events?token=<full token or API_TOKEN>` streams
  `connection.update`, `message`, `chat-names` and `avatar` frames.

Useful patterns: a "paid" keyword that marks an invoice paid, a support inbox, or an auto-reply
(Settings → AI & auto-reply, which uses Workers AI or any OpenAI-compatible endpoint).

## 4. Automation: drain an outbox, don't loop a send

If something other than a human triggers the message — a nightly invoice run, an order event, a
payment reminder — do not fire `fetch('/api/send')` from the middle of that job. Write the message to
an **outbox** row and let a cron drain it. You get restarts, retries, backoff and a record of what
went out. [`examples/outbox-cron/`](../examples/outbox-cron/) is a runnable version (`node:sqlite`,
no dependencies):

```bash
OPENWA_URL=https://wa.example.com OPENWA_TOKEN=owa_… \
node enqueue.mjs --id invoice-INV-42 --phone 9779800000000 \
  --text "Invoice INV-42 — Rs 2500" --file invoices/INV-42.pdf

OPENWA_URL=https://wa.example.com OPENWA_TOKEN=owa_… node run.mjs   # cron calls this
```

The rules it encodes, worth copying even if you use your own queue:

- **Idempotency key.** `--id invoice-INV-42` makes a repeat enqueue a no-op, so a retried webhook
  cannot double-send. Store the returned WhatsApp `message_id` next to the invoice.
- **States.** `queued → sending → sent`, plus `failed` for permanent errors. A lease on `sending`
  recovers rows from a crashed process.
- **Retry classes.** `5xx`/network → exponential backoff (30 s → 1 h, jittered, a few attempts).
  `429` → wait for 00:00 UTC (the token quota and the wake budget both reset then) without burning an
  attempt. `400/401/403/413` → fail immediately and alert; retrying a bad token or a non-allowlisted
  chat never helps.
- **Batch, don't drip.** A drain of 20 invoices shares the session's 60 s window, so it costs about
  one wake. One send every few minutes is how you exhaust `DAILY_WAKE_LIMIT` (300 connects/day).
- **At-least-once.** A crash between "WhatsApp accepted it" and "row marked sent" can duplicate a
  message. Stable keys plus your own ledger make that harmless.

On Workers, put the same three operations on D1/KV and trigger the drain with a Cron Trigger; the
calls to `/api/send` do not change.

### Moving or preparing a queue offline

```bash
node run.mjs --export queue.json     # queued + failed rows
node run.mjs --export queue.csv      # same columns, editable in Sheets/Excel
node --no-warnings run.mjs --import queue.json
```

Import is idempotent on `id` and resets rows to `queued`, so a batch prepared on one machine can be
drained on another. `sent` rows are excluded by default (`--status` narrows further); paths in
`file_path` are host-relative, so move the documents too.

## 4.5 Google Sheets as the always-on half

The Apps Script in [`apps-script/`](../apps-script/) wakes a session, drains new messages into a
sheet, acks, sends the Outbox rows and idles again. It is configured entirely from Script Properties
— run **OpenWA → Setup…** in the sheet once:

| Property | Meaning |
| --- | --- |
| `OPENWA_URL` | deployed worker origin |
| `OPENWA_TOKEN` | API token / UI password (blank if none) |
| `OPENWA_SESSIONS` | comma-separated session names (or `OPENWA_SESSION`) |
| `OPENWA_POLL_MINUTES` | 1, 5, 10, 15 or 30 |
| `OPENWA_INBOX_SHEET` / `OPENWA_OUTBOX_SHEET` | tab names, default `Inbox` / `Outbox` |

The menu also offers **Drain now**, **Test connection**, **Queue a message…** and **Export XLSX**.
The Sending & widget tab and the Admin tab can mint the token and show the exact property block, so
there is nothing to hand-edit.


## 5. Operational notes

- **Retries:** on `5xx` or a network error, retry with backoff. The API returns the WhatsApp message
  id, so store it and skip invoices that already have one.
- **No delivery receipts:** you get the id, not "delivered/read". Do not build billing on that
  signal; reconcile payments through your own ledger or an inbound reply.
- **Rate limits:** a personal WhatsApp number is not the compliant path for bulk or marketing
  messaging; accounts can be banned. For high volume, move to Meta's Cloud API with approved
  templates — the same server-side shape applies (token, recipient, message payload).
- **Free tier:** sessions are lazy (60 s window per wake). Grouping sends into one batch keeps
  Durable Object duration and request counts low; `/api/usage` estimates the daily budget.
- **Token hygiene:** one token per integration, a label you recognise, an expiry date, and revoke
  from the same panel. Rotating `API_TOKEN` does not invalidate generated tokens (revoke those
  separately).

## API reference

- [API reference](api.md) — every route, payload and error code.
- [Deployment](deployment.md) — secrets, tokens, Workers AI.
- [Architecture](architecture.md) — Durable Objects, storage keys, lazy lifecycle.
