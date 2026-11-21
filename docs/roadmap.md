# Roadmap: what to integrate next

A deliberately opinionated list, filtered by the constraints this project already lives under:
**free tier, lazy sockets, no always-on Durable Object**. Effort is sized in working days for one
developer who knows the codebase; cost is what it adds to the monthly bill at small scale.

The Admin and Backup tabs (Settings → Admin / Backup) are the starting point for this list: worker
status, free-plan estimate, Google Sheets setup, credential backup and token restoration are already
there. The items below extend that surface rather than inventing a new one.

## Where the product stands

| Area | Today | Gap that hurts most |
| --- | --- | --- |
| Transports | Baileys (WhatsApp Web multi-device) | No official Cloud API path; number bans are a real risk for bulk |
| Storage | Durable Object storage, 200-message buffer + durable chat index | No long-term archive, no server-side search across history |
| Automation | Webhook out, AI drafts, opt-in auto-reply, outbox + cron | Webhooks are fire-and-forget, one URL, no signature or retry log |
| Integrations | Google Sheets drainer, send tokens, embed widget | No first-class n8n/Chatwoot connector, no queue primitive |
| Admin | Settings dialog with Connection / AI / Sending / Backup / Admin | No roles, audit log, webhook manager, or scheduled sends |
| UX | WhatsApp-Web-style React UI, country-aware new chat | No contact aliases/notes, no search, no canned replies, no i18n |

## Tier 1 — small, free, high leverage

These do not add a binding, a bill, or an always-on process.

1. **Contact aliases, notes and tags** (S, free).
   The chat index already knows every JID. Add a `contact:<jid>` DO record (`alias`, `note`, `tags`)
   and let the UI edit it from the chat header. Names survive WhatsApp's pushName churn and make
   exports readable. Import/export rides the existing Backup tab.
2. **Canned replies / quick replies** (S, free).
   A per-session `snippets` list (`/help` → three lines) with a `/` picker in the composer. This is
   the single most requested feature in every WhatsApp gateway and costs no runtime.
3. **In-UI search over the buffer + chat index** (S, free).
   `buildChats` already has the rows; a client-side filter over text, chat name and sender is
   enough for the 200-message window. Label it honestly ("recent messages") until the archive lands.
4. **Webhook hardening** (S, free).
   Sign the payload with HMAC-SHA256 (`X-OpenWA-Signature`, secret from an env var), add a 3-attempt
   retry with backoff inside the active window, and keep a small ring buffer of the last 20
   deliveries per session (`webhookLog`) so the Admin tab can show success/failure instead of
   silence.
5. **Audit log** (S, free).
   Append `{ at, actor: 'ui' | 'token:<id>' | 'auto-reply' | 'webhook', action, session, chatId }`
   to a capped `audit` list for sends, settings changes, token creation/revocation, credential
   export/import and logouts. Render it in Admin. This is the difference between "a gateway" and
   "something you can operate".
6. **Token roles beyond full admin** (S, free).
   `send` and `embed` already exist. Add `read` (messages/history for one session, no sends) and
   `admin` (today's `full`). `authorized()` keeps accepting `admin` only. It makes dashboards and
   Chatwoot-style inboxes possible without handing out the keys to the kingdom.
7. **Presence and typing** (S, free inside an active window).
   `sendPresenceUpdate('composing' | 'paused')` while the operator types, `presence.update` in the
   event stream. Only meaningful inside a wake window, which matches the UI's behaviour.
8. **Per-chat muting and archive in the UI** (S, free, local).
   Local-only flags in `localStorage` (like `readAt` today). Cheap and it stops the chat list from
   becoming unusable on a busy number.
9. **Nepali/English UI strings** (M, free).
   Extract the ~400 strings into a tiny dictionary and default from `navigator.language`. The country
   picker was step one; the rest of the UI is still English-only.
10. **Health and deploy badge** (S, free).
    `/health` already returns `{ ok }`. Add `version` (from `wrangler.toml`/`package.json`) and the
    git SHA at build time, then show it in Admin so "which build is live?" stops being a guess.

## Tier 2 — medium effort, still free-tier friendly

These add bindings but stay inside free allowances at personal scale. Verify current limits before
committing; Cloudflare changes them.

1. **D1 message archive + search** (M, D1 free tier).
   The DO stays the hot path; after `/ack` (or on a cap), forward rows to D1 (`messages`, `chats`,
   FTS5 virtual table). The UI gets a real search box and infinite scroll; exports no longer depend on
   the 200-message buffer. Add a retention setting (`archiveDays`) and a delete-by-chat call for
   privacy. This is the highest-value structural change on the list.
2. **R2 media archive** (M, R2 free tier, no egress fee).
   Today media is fetched on demand while the message row exists. Copy inbound media to R2 when it
   arrives (`media/<session>/<messageId>`), serve through a signed worker route, and keep the DO
   value as the pointer. Photos then survive ack/rollover, and exports can include them.
3. **Cron Trigger drainer** (M, Workers Cron + DO).
   The Apps Script drainer is clever but bound by Google's 90 min/day. A Worker Cron Trigger that
   wakes each session, pulls, forwards to D1/webhook/D1 queue, acks and idles replaces it for anyone
   who does not want a sheet. Keep the sheet as an option, not the only always-on half. Guard it
   behind a config flag so the free-tier wake budget stays explicit.
4. **Workers Queues for the outbox** (M, Queues free tier).
   `examples/outbox-cron` is the reference for correctness. A hosted version would enqueue into a
   Queue, consume with one Worker, and use the DO only for the send. Keep the SQLite example for
   self-hosters; document the mapping (enqueue → `send`, lease → message visibility timeout).
5. **Webhook subscription manager** (M, free).
   Replace the single `INBOUND_WEBHOOK_URL` with per-session subscriptions in DO storage
   (`{ url, events, secret, active }`), a test button, and the delivery log from Tier 1. This is what
   makes n8n/Make/Zapier integration self-service instead of a docs exercise.
6. **Scheduled messages** (M, free if bounded).
   Do **not** add a recurring alarm. Store `scheduled:<id>` rows and let the existing wake path flush
   anything due when someone is already awake (UI poll or cron). A scheduled send may therefore be
   late by one poll interval; say so in the UI.
7. **Chatwoot / n8n recipes** (M, free).
   Both speak generic webhooks + REST. Ship two copy-paste recipes under `docs/`: inbound webhook →
   Chatwoot inbox, and n8n "invoice paid → `/api/send`". The send-token allowlist already makes this
   safe.
8. **Reactions, polls and reply-to-send** (M, free).
   Baileys exposes all three; the mapper currently skips `reactionMessage` on purpose (it is not a
   bubble). Store reactions separately (`reactions:<chatId>:<messageId>`) and render them as chips,
   and add `quoted` to the message shape for replies. Polls can be sent, not just displayed.
9. **Worker-side rate limiting and abuse guards** (M, free).
   A small counter per token/IP in the DO: reject bursts on `/api/send` and `/api/embed/send` before
   the daily cap. The login gate already has per-IP failure blocking; this extends the same idea to
   sending.
10. **Offline-first UI** (M, free).
    Cache the last history page and chat index in IndexedDB (the same store the backup archive would
    use), show it instantly, and reconcile when the socket reconnects. Pairs well with the D1 archive.

## Tier 3 — product-level bets

1. **Meta Cloud API coexistence** (L, paid per message).
   Keep Baileys for the owner's own number, add a second transport for a verified business number:
   official webhooks, template messages, media upload, and the Graph API's message statuses. The
   session abstraction already isolates transport-ish concerns in `session-do.ts`; the token/session
   model would need a `transport` field. **Pricing changed on 1 October 2026:** service messages are
   no longer unlimited-free — Meta gives 1,000 free service messages per business number per month
   and charges after that, plus per-template pricing by category and country. Template-based
   marketing is a different product from this gateway; do not blur them.
2. **WhatsApp Flows and Calling** (L, paid/limited regions).
   Flows turn a chat into a form (signup, booking, order status). Calling is generally available
   since 2025 but needs explicit user permission and regional coverage. Both only make sense on the
   Cloud API path above.
3. **Team roles and multi-user login** (L, free).
   Today one password opens everything. Real teams need users, roles (`owner`, `agent`, `viewer`),
   per-session assignment and an invite flow. D1 + a `users` table, or DO records keyed by email.
   Prerequisite for selling this as a shared inbox.
4. **AI that does more than draft** (M–L, Workers AI free allocation + provider keys).
   Whisper transcription for voice notes, translation per chat, RAG over the D1 archive with
   Vectorize, and tool calls (look up an order, then draft). Keep the hard rule: the model drafts,
   a human or an explicit auto-reply setting sends.
5. **Billing and plans** (L, paid).
   Only worth it with teams. Stripe Checkout + a `plan` field in the token store; the free-plan
   estimate in Admin already gives you the numbers to gate on.

## Explicitly not on the list

- **A WhatsApp Web clone with calls.** WebRTC calling through Baileys is fragile, and the official
  path is the Calling API. Do not chase parity for its own sake.
- **Bulk marketing on a personal number.** It gets numbers banned and violates WhatsApp's terms.
  If someone needs campaigns, the honest answer is the Cloud API with approved templates.
- **An always-on Durable Object.** It costs ~10,800 GB-s/day, most of the free tier, and undoes the
  lazy design. Any "real-time" feature must fit inside a wake window or a cron.
- **Storing full media in the DO.** The 128 MB memory cap and 128 KiB value cap both bite. R2 or
  on-demand fetching only.

## Suggested next 30 days

1. Webhook signing + delivery log + Admin visibility (Tier 1.4/1.5) — makes every other integration
   debuggable.
2. Canned replies, contact aliases, and in-UI search (Tier 1.1–1.3) — the three things users ask for
   immediately.
3. D1 archive behind a flag, with the UI search box reading from it (Tier 2.1) — the structural win.
4. Two integration recipes (n8n + Chatwoot) written against the now-observable webhook.

Anything in Tier 3 should wait for a concrete user asking for it; the Cloud API in particular is a
different cost model and a different support burden.

## Sources and further reading

- Meta, *Pricing on the WhatsApp Business Platform* — per-message pricing, service-message allowance
  from 1 Oct 2026: <https://developers.facebook.com/documentation/business-messaging/whatsapp/pricing>
- Meta, *Cloud API Calling*: <https://developers.facebook.com/documentation/business-messaging/whatsapp/calling>
- Meta, *WhatsApp Flows*: <https://whatsappbusiness.com/products/whatsapp-flows/>
- Cloudflare, *D1*, *R2*, *Queues*, *Cron Triggers*, *Workers AI* pricing pages (check free
  allowances before adopting; they change).
