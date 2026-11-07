import type { SessionRegistry } from './registry-do';
import type { WhatsAppSession } from './session-do';

/** Bindings declared in wrangler.toml, plus secrets set via `wrangler secret put`. */
export interface Env {
  WHATSAPP_SESSION: DurableObjectNamespace<WhatsAppSession>;
  SESSION_REGISTRY: DurableObjectNamespace<SessionRegistry>;
  /** Static UI served from ./ui (assets binding). */
  ASSETS: Fetcher;
  /**
   * Optional bearer/header token. When unset, every request is allowed (local-dev posture);
   * when set, requests must carry it as `X-API-Key` or `Authorization: Bearer <token>`.
   */
  API_TOKEN?: string;
  /** Optional baileys log verbosity (trace | debug | info | warn | error | fatal). Defaults to info. */
  LOG_LEVEL?: string;
  /**
   * How long a /wake window keeps the socket open, in ms. Default 60000 (min 5000, max 15 min).
   * Apps Script should call /ack?close=1 or /idle when its drain finishes; this is the safety net.
   */
  IDLE_TTL_MS?: string;
  /**
   * Max connects per session per UTC day. Default 300 (≈5-min polling with slack). 0 disables.
   * Guards the free plan against a runaway reconnect loop before the 00:00 UTC reset.
   */
  DAILY_WAKE_LIMIT?: string;
  /**
   * Optional: when set, inbound (non-self) messages are POSTed here as JSON webhooks
   * ({ session, at, message }) — the generic way any backend consumes the gateway.
   */
  INBOUND_WEBHOOK_URL?: string;
  /** Optional bearer token sent with webhook deliveries (Authorization: Bearer). */
  INBOUND_WEBHOOK_TOKEN?: string;
}