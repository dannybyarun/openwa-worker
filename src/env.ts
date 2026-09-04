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
}