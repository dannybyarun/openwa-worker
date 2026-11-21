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
- **An API token** (`API_TOKEN`) that grants full control of every session on the worker.
- **Message content**, stored only as the last 200 unacked messages per session, plus whatever your
  own puller persists.

## Operator guidance

- **Always set `API_TOKEN` in production.** Without it every route is open to anyone with the URL.
  Prefer a long random value (`openssl rand -hex 32`).
- Keep the token out of URLs you share: the WebSocket uses `?token=`, and URLs land in logs and
  browser history.
- The UI stores the token in `localStorage`. Anyone with script execution on that origin can read
  it — do not host untrusted scripts alongside the UI.
- Log out or delete sessions you no longer use; that wipes the stored credentials.
- Remember that linking a device grants full access to that WhatsApp account's messages. Use a
  number you are prepared to lose, and review Linked Devices on the phone regularly.
- This is an unofficial client (WhatsApp Web protocol via baileys). It is not endorsed by WhatsApp
  or Meta, and automating a personal account can lead to a ban.

## In scope

- The worker API, Durable Object lifecycle, token checks, and the baileys transport patches in this
  repository.
- The UI (XSS, token handling, QR rendering).
- Deployment defaults that would expose a worker unexpectedly.

## Out of scope

- Vulnerabilities in WhatsApp, baileys, Cloudflare, or a browser — report those upstream.
- Account bans or rate limits imposed by WhatsApp.
- Findings that require the `API_TOKEN` or physical access to the paired phone.
