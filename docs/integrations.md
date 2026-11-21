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

## 4. Operational notes

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
