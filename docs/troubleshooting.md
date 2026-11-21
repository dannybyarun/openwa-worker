# Troubleshooting

## The UI says it cannot reach the worker (401 or network error)

- With `UI_PASSWORD` or `API_TOKEN` set, the UI asks for a password. Sign in again from the login
  screen; **Sign out** lives in **Settings**.
- `401` on a REST call from a script means `X-API-Key` (or `Authorization: Bearer`) is missing or
  wrong. The events socket takes `?token=`.
- If you host the UI separately, check the worker URL in Settings — it must be the origin, no
  trailing slash and no `/api`. A separately hosted UI cannot use the cookie login.
- `curl https://<worker>/health` should return `{"ok":true}`. If it does not, the worker is not
  deployed or the URL is wrong.

## 429 — daily wake limit reached

The session used `DAILY_WAKE_LIMIT` connects (default 300) in the current UTC day. This is the guard
against runaway polling, not a bug. Options:

- Wait for the 00:00 UTC reset.
- Lower the poll frequency (15 minutes uses 96/day).
- Raise the limit: `npx wrangler secret put DAILY_WAKE_LIMIT` → e.g. `400`.

The same cap applies to `/wake`, `/start` and `/send-text` when they would have to connect.

## No QR code appears

1. `POST /api/sessions/:id/start` opens a pairing window (5× the normal TTL when unpaired).
2. The QR arrives asynchronously — poll `/qr` or listen on the events socket.
3. QR payloads rotate roughly every 20 seconds. A stale screenshot will not scan.
4. Check `LOG_LEVEL=trace` and the worker logs if `status` stays `connecting`.

## Pairing scans but never connects

Look for the two workerd transport quirks first (`docs/architecture.md`):

- **Binary frames as Blob** — the noise handshake times out.
- **`AbortSignal.timeout()` on the upgrade fetch** — the healthy socket dies ~20 s in with code
  428.

Both are handled by `scripts/patch-baileys-worker-socket.js`. Verify the patch actually applied:
`npm ci` must run without `--ignore-scripts`, and its output should mention both patch scripts. If a
guard failed, the install fails on purpose.

If the patches are applied and pairing still fails, check custom-domain/proxy interference and try
`LOG_LEVEL=debug`. TLS fingerprinting by WhatsApp is the remaining suspicion, not something this
repo can fix.

## "All encryptions failed" when sending a message with a URL

The link-preview patch did not apply. Run `npm ci` again (it is idempotent) and confirm
`node_modules/@whiskeysockets/baileys/lib/Utils/link-preview.js` returns `undefined` from
`getUrlInfo`.

## Send fails with "session is not connected"

`/send-text` wakes the session, but pairing must have completed at least once. Check status:

- `new` / `loggedOut` → link the device (QR).
- `qr` → scan the code; the window is time-limited.
- `closed` → inspect `lastDisconnect.code`. `401` means the device was removed from the phone;
  link again.

Sending retries once on a stale socket by design. It will not loop beyond that.

## Messages are missing from the UI

- The session keeps the last **200 unacked** messages. If a puller acks aggressively, older rows
  are gone by design.
- For pullers, compare `oldestSeq` with your cursor from `GET /messages`; a gap means you fell
  behind the cap.
- History is per session and per Durable Object. Switching sessions in the UI switches histories.

## Groups still show `Group · 750265`

Group subjects are only available from WhatsApp while the socket is open, so the first fetch happens
on the next wake. Press the status chip to wake the session (or send a message) and reload; the names
are then cached for 6 hours. If a group is very new or you just joined it, the fetch may lag behind
the message itself.

## "Draft with AI" fails

- `AI is not enabled on this worker (missing [ai] binding)` — the deploy was built without the `[ai]`
  block in `wrangler.toml`, or the binding was removed. Redeploy with `npm run deploy`.
- `AI request failed: …` — Workers AI rejected the call (model id, daily Neuron allowance, or a
  transient error). Check `AI_MODEL` and the Workers AI section of the dashboard.
- `no stored messages in this chat yet` — the assistant only reads the session's last 200 unacked
  messages; an empty thread has nothing to draft from.

The assistant never sends by itself: it fills the composer, and you press send.

## Usage numbers look low or jumpy

`GET /api/usage` is an estimate from each session's own wake counter, not Cloudflare's billing. A
session that was idle all day reports zero, and counters reset at 00:00 UTC. Use the Cloudflare
dashboard for billed GB-s and request counts.

## Local `npm run dev` serves a 404 or a blank page

The assets binding points at `ui/dist`, which only exists after a build. Use `npm run dev` (builds
first) or run `npm run build` once before `npm run dev:worker`.

## Deploy fails

- **`postinstall` guard failure** — baileys was upgraded or the patch was edited. Restore the pinned
  `7.0.0-rc14` and reinstall; do not bypass the guard.
- **Bundle too large** — the free plan allows 3 MiB compressed. The default build is ~1.5 MiB gzip;
  check anything you add to `src/`.
- **`wrangler types --check` fails** — `worker-configuration.d.ts` is generated and currently
  stale. Run `npm run types` after binding changes; the failure does not block deploys.
- **Node too old** — Vite needs Node 20.19+ or 22.12+.

## Durable Object storage errors

- Auth values are chunked at 60 KB because a single value is capped at 128 KiB. If you add storage
  writes, respect that.
- A session's storage is wiped on logout/delete, including history and credentials.

## WebSocket events do not arrive

- Browsers cannot set headers on `new WebSocket(...)`; scripts pass `?token=` when `API_TOKEN` is
  set. The UI served by the worker sends its login cookie with the upgrade instead.
- The upgrade must reach the Durable Object unchanged — the worker proxies `/events` raw. Don't
  put a proxy in front that strips `Upgrade`.
- The UI reconnects with exponential backoff (1 s → 30 s). If status is `idle`, the socket in the
  DO is closed; wake the session to resume live traffic.
