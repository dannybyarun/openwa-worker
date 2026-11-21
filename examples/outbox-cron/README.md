# Outbox + cron — reliable sending for automation

Sending inline (`await fetch('/api/send')`) is fine for a one-off. Automation needs more: the job
must survive a restart, retry when WhatsApp is reconnecting or the daily budget is spent, and never
send the same invoice twice. That is an **outbox**: write the intent to a row, let a cron drain it.

```
examples/outbox-cron/
  outbox.mjs    schema, enqueue/claim/retry helpers, drainOnce()  ← import this from your app
  enqueue.mjs   CLI: add one message (idempotent with --id)
  run.mjs       CLI: drain once, --watch, --list, --retry-failed, --export/--import
  demo.mjs      end-to-end proof against an in-process mock gateway (no credentials)
```

Storage is `node:sqlite` (Node 22.5+; unflagged in 23.4), so there are no dependencies. A row is a
message: `chat_id`, text or a file path, status, attempt count, next attempt time, and the WhatsApp
message id once sent.

## Try it

```bash
node demo.mjs
```

That enqueues a PDF invoice plus two texts, runs one drain against a mock gateway (one message fails
with a 500 on purpose), jumps five minutes to run the retry, and asserts the PDF went out exactly
once. No token, no network.

Then against your worker:

```bash
OPENWA_URL=https://wa.example.com \
OPENWA_TOKEN=owa_… \
node enqueue.mjs --id invoice-INV-42 --phone 9779800000000 \
  --text "Invoice INV-42 — Rs 2500" --file invoices/INV-42.pdf

OPENWA_URL=https://wa.example.com OPENWA_TOKEN=owa_… node run.mjs
```

```json
{ "claimed": 1, "sent": 1, "retried": 0, "failed": 0, "nextAttemptAt": null,
  "stats": { "queued": 0, "sending": 0, "sent": 1, "failed": 0 } }
```

Inspect and repair:

```bash
node run.mjs --list            # newest 25 rows + counters
node run.mjs --retry-failed    # move failed rows back to queued, then drain
```

### Moving a batch between hosts

```bash
node run.mjs --export queue.json         # queued/sending/failed rows
node run.mjs --export queue.csv          # same rows, editable in Sheets
node run.mjs --export queue.json --status failed
node --no-warnings run.mjs --import queue.json
```

Export leaves `sent` rows out by default (they are history, not work); `--status` narrows it
further. Import is idempotent on `id` and resets each row to `queued` with a fresh attempt count —
"run this batch on the other machine". `file_path` is host-relative, so copy the files too.

Exit codes: `0` nothing failed, `1` at least one permanent failure, `2` config/DB problem. A cron
that alerts on non-zero gets both.

## Scheduling it

One-shot drains (recommended — no long-running process to babysit):

```cron
# every 2 minutes
*/2 * * * * cd /srv/openwa/examples/outbox-cron && \
  OPENWA_URL=https://wa.example.com OPENWA_TOKEN=owa_… \
  node run.mjs >> /var/log/openwa-outbox.log 2>&1
```

Windows Task Scheduler: action `node`, arguments `run.mjs` (or `--watch 60`), "Start in" the
example folder, and put `OPENWA_URL`/`OPENWA_TOKEN` in the user/system environment.

Prefer a resident process? `node run.mjs --watch 60` drains every minute and handles Ctrl+C
(systemd unit, pm2, Docker). It still uses the same retry table, so a crash loses nothing.

On **Cloudflare Workers** you would swap `node:sqlite` for D1 (or KV) behind the same three
operations — enqueue, claim, mark — and trigger the drain from a Cron Trigger. The HTTP calls to
`/api/send` are identical.

## How it behaves

| Situation | What happens |
| --- | --- |
| `enqueue` with an `--id` that already exists | No-op; prints the existing row and status (idempotent) |
| Send succeeds | Row → `sent`, WhatsApp `message_id` stored, never retried |
| `5xx` / network error | Exponential backoff (30 s → 1 h, jittered), up to `--max-attempts` (5), then `failed` |
| `429` (daily cap or wake budget) | Retried after the next 00:00 UTC, attempt counter not consumed |
| `400`/`401`/`403`/`413` | Permanent; row → `failed` (bad token, chat not allowed, too large) |
| Process dies mid-send | The `sending` lease expires (`--lease-ms`, default 120 s) and the row is claimed again |

Batching matters for the free tier: `/api/send` keeps the session's 60 s window open, so a drain of
20 invoices costs roughly one wake. Still, a `send` token is capped at **500 sends/UTC day** and the
session at `DAILY_WAKE_LIMIT` (300 connects) — a drain every 2 minutes is ~720 runs/day but only
wakes when there is something to send.

### The one caveat: at-least-once delivery

If the process is killed *after* WhatsApp accepted a message but *before* `markSent` commits, the
lease expires and the row is sent again. That is unavoidable without an idempotency key on the
WhatsApp side, which the gateway does not have. Keep sends idempotent on your side: use a stable
`--id`, store the returned `message_id`, and treat "already sent" as success. For invoices, a
duplicate PDF is annoying but not dangerous; for money movement, reconcile through your ledger.

## Using it from your own code

```js
import { openOutbox, enqueue, drainOnce } from './outbox.mjs';

const db = openOutbox('./outbox.sqlite');

// after committing the invoice in your own database
enqueue(db, {
  id: `invoice-${invoice.number}`,     // idempotency key
  chatId: invoice.phone,
  text: `Invoice ${invoice.number} — ${invoice.total}`,
  filePath: pdfPath,
  caption: `Invoice ${invoice.number} — ${invoice.total}`,
});

await drainOnce(db, { url: process.env.OPENWA_URL, token: process.env.OPENWA_TOKEN });
```

Files are read at send time, so a PDF can be generated by another process as long as it exists
before the drain picks the row up. Keep the paths stable (or copy into an `outbox-files/` folder).

Full API walkthrough: [`docs/integrations.md`](../../docs/integrations.md).
