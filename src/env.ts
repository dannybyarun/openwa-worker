import type { SessionRegistry } from './registry-do';
import type { WhatsAppSession } from './session-do';
import type { TokenStore } from './token-do';

/** Bindings declared in wrangler.toml, plus secrets set via `wrangler secret put`. */
export interface Env {
  WHATSAPP_SESSION: DurableObjectNamespace<WhatsAppSession>;
  SESSION_REGISTRY: DurableObjectNamespace<SessionRegistry>;
  /** Generated API/embed tokens (one global instance). */
  TOKEN_STORE: DurableObjectNamespace<TokenStore>;
  /** Static UI served from ./ui (assets binding). */
  ASSETS: Fetcher;
  /**
   * Optional bearer/header token for scripts, Apps Script and cross-origin clients.
   * When both this and `UI_PASSWORD` are unset, every request is allowed (local-dev
   * posture); when set, requests must carry it as `X-API-Key` or
   * `Authorization: Bearer <token>` (or `?token=` on WebSocket upgrades).
   */
  API_TOKEN?: string;
  /**
   * Password for the browser login (`POST /api/login` → signed HttpOnly cookie).
   * Falls back to `API_TOKEN` when unset, so one secret can gate both. Rotating the
   * value logs every browser out.
   */
  UI_PASSWORD?: string;
  /** How long a login cookie stays valid, in hours. Default 168 (7 days), max 720. */
  SESSION_TTL_HOURS?: string;
  /** Optional baileys log verbosity (trace | debug | info | warn | error | fatal). Defaults to info. */
  LOG_LEVEL?: string;
  /** Workers AI binding (wrangler.toml `[ai]`). Powers "Draft with AI" in a chat. */
  AI: Ai;
  /** Optional Workers AI model id. Defaults to @cf/meta/llama-4-scout-17b-16e-instruct. */
  AI_MODEL?: string;
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