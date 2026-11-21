# Apps Script drainer (free-tier mode)

The worker no longer keeps a WhatsApp socket open. It connects for a few seconds when asked, and
this script is what asks. Everything lands in a Google Sheet; no R2, D1, or paid KV is involved.

```
Google Sheet trigger (every N min)
  → POST /wake?wait=8000          connect + hold the socket briefly
  → GET  /messages?after=<seq>    pull unacked messages (oldest first)
  → append rows to "Inbox"        + dedupe on msg_id
  → POST /ack { upto }            prune what is now in the sheet
  → send pending rows from "Outbox"
  → POST /idle                    close the socket immediately
```

## Setup

1. Create a Google Sheet, then **Extensions → Apps Script**.
2. Replace `Code.gs` with [`Code.gs`](./Code.gs) and save.
3. Reload the sheet. A **WhatsFlare** menu appears; choose **Setup…**. It prompts for:
   - **Worker URL** — your deployed worker origin, no trailing slash.
   - **API token** — the `API_TOKEN` / UI password (blank when the worker has none).
   - **Session(s)** — comma-separated names created in the worker.
   - **Poll interval** — 1, 5, 10, 15 or 30 minutes (15 is the safe 4-session default).

   Setup stores these in **Script Properties** (`OPENWA_URL`, `OPENWA_TOKEN`, `OPENWA_SESSIONS`,
   `OPENWA_POLL_MINUTES`), creates the `Inbox` and `Outbox` tabs, installs the trigger and runs a
   connection check. Re-run it whenever the worker or session changes.
4. Run **WhatsFlare → Test connection** to confirm the URL, token and session before walking away.
5. Send yourself a test message; it should appear in `Inbox` within one cycle.

The same keys can be set by hand in **Project Settings → Script properties**, which is useful when
you deploy the script from `clasp` instead of the editor. Properties always beat the fallback
`CONFIG` object at the top of the file.

The **WhatsFlare** menu also gives you *Drain now*, *Queue a message…* (writes a pending `Outbox` row),
*Install/replace trigger*, and *Export XLSX*. `enqueueMessage(session, chatId, body)` is callable from
any other Apps Script in the same project.

## Sheet schema

**Inbox** (written by the script, one row per message):

```
msg_id | drained_at | sent_at | session | chat_id | from_me | sender | push_name | type | text | seq
```

**Outbox** (written by you or another script):

```
id | session | chat_id | body | status | attempts | last_error | next_try_at
```

Add a row with `status = pending`; the next drain sends it and updates `status` to `sent` or
`failed` (3 attempts, exponential backoff in `next_try_at`). `id` is your own reference.

## Cadence vs the two free quotas

Two quotas matter, and the **Apps Script one binds first** for 3–4 sessions:

- Apps Script consumer: **90 min/day of trigger runtime**, 6 min/execution.
- Cloudflare Workers Free: 13,000 GB-s/day of Durable Object duration.

Per session per run, lazy mode costs roughly `wake handshake + pull + ack ≈ 5–10 s`. With
`OPENWA_POLL_MINUTES` and 4 sessions:

| Poll | Runs/day | Apps Script runtime (4 sessions × ~8 s) | CF duration/day |
|---|---|---|---|
| 5 min | 288 | ~154 min ❌ over 90 | ~1,150 GB-s ✅ |
| 10 min | 144 | ~77 min ⚠️ tight | ~575 GB-s ✅ |
| **15 min** | **96** | **~51 min ✅** | **~385 GB-s ✅** |
| 30 min | 48 | ~26 min ✅ | ~190 GB-s ✅ |

So: **15 min is the safe default for 4 sessions**, 10 min if you watch the execution log and it
stays short, 5 min only for 1–2 sessions. Latency is the poll interval; WhatsApp queues messages
while the socket is closed, so none are lost.

`DAILY_WAKE_LIMIT` on the worker defaults to 300. A 5-min cadence uses 288 of those per session;
raise it (`wrangler secret put DAILY_WAKE_LIMIT` → e.g. `400`) if you also wake manually from the UI.

## Notes and failure modes

- **Ack after write.** The script appends rows, then acks. If it dies between the two, the next run
  re-reads the same range and `msg_id` dedupe prevents duplicated rows.
- **Wake limit (HTTP 429).** Means the session used its daily connects (00:00 UTC reset). The script
  logs and skips; it does not retry in a loop.
- **Formula injection.** `safeCell_` prefixes `=`, `+`, `-`, `@` with `'` so WhatsApp text cannot
  become a live formula. Keep it.
- **Idle close.** `/idle` runs in a `finally` block, so a failed pull still closes the socket. The
  worker's `IDLE_TTL_MS` (default 60 s) is only the safety net.
- **Unacked backlog.** The worker keeps the last 200 unacked messages. If the script is off for
  longer than that, use `oldestSeq` from `/messages` to detect a gap.
- **QR pairing.** Pair from the worker UI (or `POST /start` then poll `/qr`). `start` holds a
  5× longer window so the QR can be scanned; after pairing the normal idle window applies.
- **XLSX.** `exportXlsx()` writes a real `.xlsx` snapshot to Drive. Don't use the file as the live
  store — Sheets is the database; XLSX is an export.
