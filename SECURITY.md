# Security

## Reporting a vulnerability

Open a private security advisory on the repository (Security → Advisories → New draft advisory) or
email the maintainer listed in the repository profile. Please do not open a public issue with
exploit details, worker URLs, API tokens, or QR payloads.

Expect an acknowledgement within a few days. This is a small project maintained in spare time; there
is no bounty program.

## What this project handles

- **WhatsApp credentials** for every linked session, stored in that session's Durable Object storage
  (encrypted at rest by Cloudflare, not by this code).
- **A password/token** (`UI_PASSWORD`, or `API_TOKEN` when no separate password is set) that grants
  full control of every session on the worker, and the signed session cookies issued in exchange.
- **Message content**, stored only as the last 200 unacked messages per session, plus whatever your
  own puller persists.

## Authentication model

- The browser signs in at `POST /api/login` and gets an `HttpOnly`, `SameSite=Lax` cookie (plus
  `Secure` over HTTPS) holding an expiry and an HMAC-SHA256 signature keyed from the configured
  secret. The password itself is never stored in the browser.
- The cookie lasts `SESSION_TTL_HOURS` (default 7 days). Sign out clears it in the browser; rotating
  `UI_PASSWORD`/`API_TOKEN` invalidates every issued cookie at once.
- Scripts and API clients use the `API_TOKEN` bearer header (`X-API-Key`/`Authorization`, or
  `?token=` for WebSocket upgrades).
- Failed logins are throttled per IP, best effort, inside each isolate.

## Operator guidance

- **Always set `UI_PASSWORD` or `API_TOKEN` in production.** Without either, every route is open to
  anyone with the URL. Prefer a long random value (`openssl rand -hex 32`).
- Set `UI_PASSWORD` to a password you do not use anywhere else; leaving it unset makes the API token
  the login password, which is fine but means the token must be typed into a browser.
- Keep the token out of URLs you share: the WebSocket uses `?token=`, and URLs land in logs and
  browser history. The UI served by the worker uses the cookie instead.
- The UI no longer keeps a token in `localStorage`; older builds did, and this version removes any
  leftover `openwa:worker-token` on load.
- Log out or delete sessions you no longer use; deleting a session wipes the stored WhatsApp
  credentials.
- Remember that linking a device grants full access to that WhatsApp account's messages. Use a
  number you are prepared to lose, and review Linked Devices on the phone regularly.
- This is an unofficial client (WhatsApp Web protocol via baileys). It is not endorsed by WhatsApp
  or Meta, and automating a personal account can lead to a ban.

## In scope

- The worker API, Durable Object lifecycle, login/cookie and token checks, and the baileys transport
  patches in this repository.
- The UI (XSS, session handling, QR rendering).
- Deployment defaults that would expose a worker unexpectedly.

## Out of scope

- Vulnerabilities in WhatsApp, baileys, Cloudflare, or a browser — report those upstream.
- Account bans or rate limits imposed by WhatsApp.
- Findings that require the `UI_PASSWORD`/`API_TOKEN` or physical access to the paired phone.
