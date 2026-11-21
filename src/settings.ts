/**
 * Per-session automation settings, deliberately free of Durable Object APIs so
 * `scripts/settings.spec.mjs` can exercise normalization without a worker.
 *
 * Two AI providers are supported:
 *  - `workers-ai` — the `[ai]` binding, model ids like `@cf/meta/…`.
 *  - `openai`     — any OpenAI-compatible `/chat/completions` endpoint (OpenAI, Groq,
 *                   OpenRouter, Together, Ollama, LM Studio, vLLM, …), configured per
 *                   session with a base URL, a model name, and an optional bearer key.
 */

export type AiProvider = 'workers-ai' | 'openai';

export interface AiSettings {
  provider: AiProvider;
  /** Workers AI id (`@cf/…`) or the OpenAI-compatible model name. */
  model?: string | null;
  /** OpenAI-compatible base URL, e.g. `https://api.openai.com/v1`. Ignored by Workers AI. */
  baseUrl?: string | null;
  /** Bearer key for the OpenAI-compatible endpoint. Write-only: never echoed by GET. */
  apiKey?: string | null;
}

export interface AutoReplySettings {
  enabled: boolean;
  prompt?: string | null;
  model?: string | null;
  groups?: boolean;
  cooldownSeconds?: number;
  dailyLimit?: number;
}

export interface SessionSettings {
  ai?: AiSettings;
  autoReply?: AutoReplySettings;
}

export const DEFAULT_AUTO_REPLY_COOLDOWN = 120; // seconds per chat
export const DEFAULT_AUTO_REPLY_DAILY = 20; // replies per chat per UTC day
export const MAX_AUTO_REPLY_DAILY = 200;
export const MIN_AUTO_REPLY_COOLDOWN = 10;
export const MAX_AUTO_REPLY_COOLDOWN = 3600;
export const MAX_BASE_URL_LENGTH = 300;
export const MAX_API_KEY_LENGTH = 400;

const WORKER_MODEL_RE = /^@[a-zA-Z0-9._-]+\/[a-zA-Z0-9._:/-]{1,120}$/;
const CUSTOM_MODEL_RE = /^@?[a-zA-Z0-9._:/-]{1,120}$/;

/** Workers AI model ids look like `@cf/meta/llama-4-scout-17b-16e-instruct`. */
export function validModel(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return WORKER_MODEL_RE.test(trimmed) ? trimmed : undefined;
}

/** OpenAI-compatible model names: `gpt-4o-mini`, `llama3.1:8b`, `meta-llama/Llama-3-8B`. */
export function validCustomModel(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return CUSTOM_MODEL_RE.test(trimmed) ? trimmed : undefined;
}

/** `https://api.openai.com/v1/` → `https://api.openai.com/v1`, with http(s) only. */
export function normalizeBaseUrl(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > MAX_BASE_URL_LENGTH) return undefined;
  try {
    const url = new URL(trimmed);
    if (url.protocol !== 'https:' && url.protocol !== 'http:') return undefined;
    return `${url.origin}${url.pathname.replace(/\/+$/, '')}`;
  } catch {
    return undefined;
  }
}

function clamp(value: unknown, min: number, max: number, fallback: number): number {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.round(n)));
}

function cleanText(value: unknown, max: number): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed ? trimmed.slice(0, max) : undefined;
}

/** Merge a partial update into the current settings, dropping anything invalid. */
export function normalizeSettings(
  current: SessionSettings,
  input: Partial<SessionSettings>,
): SessionSettings {
  const next: SessionSettings = { ...current };

  if ('ai' in input) {
    const raw = input.ai;
    if (raw === null || typeof raw !== 'object') {
      delete next.ai;
      return next;
    }
    const previous: AiSettings = current.ai ?? { provider: 'workers-ai' };
    const merged = { ...previous, ...raw };
    const provider: AiProvider = merged.provider === 'openai' ? 'openai' : 'workers-ai';
    const ai: AiSettings = {
      provider,
      model:
        provider === 'openai'
          ? validCustomModel(merged.model)
          : validModel(merged.model),
      baseUrl: provider === 'openai' ? normalizeBaseUrl(merged.baseUrl) : null,
    };
    // A missing `apiKey` keeps the stored one; `null`/empty clears it.
    ai.apiKey = 'apiKey' in raw
      ? (cleanText(raw.apiKey, MAX_API_KEY_LENGTH) ?? null)
      : (previous.apiKey ?? null);
    next.ai = ai;
  }

  if ('autoReply' in input) {
    const raw = input.autoReply;
    if (!raw || typeof raw !== 'object') {
      delete next.autoReply;
      return next;
    }
    const merged: AutoReplySettings = { ...(current.autoReply ?? { enabled: false }), ...raw };
    const autoReply: AutoReplySettings = {
      enabled: merged.enabled === true,
      prompt: cleanText(merged.prompt, 2000),
      model: validCustomModel(merged.model) ?? validModel(merged.model),
      groups: merged.groups === true,
      cooldownSeconds: clamp(
        merged.cooldownSeconds,
        MIN_AUTO_REPLY_COOLDOWN,
        MAX_AUTO_REPLY_COOLDOWN,
        DEFAULT_AUTO_REPLY_COOLDOWN,
      ),
      dailyLimit: clamp(merged.dailyLimit, 1, MAX_AUTO_REPLY_DAILY, DEFAULT_AUTO_REPLY_DAILY),
    };
    next.autoReply = autoReply;
  }

  return next;
}

/** What the API is allowed to return: the key is replaced by a boolean plus its last four chars. */
export interface PublicAiSettings {
  provider: AiProvider;
  model?: string;
  baseUrl?: string;
  hasApiKey: boolean;
  apiKeyHint?: string;
}

export interface PublicSessionSettings {
  ai: PublicAiSettings | null;
  autoReply?: AutoReplySettings;
}

export function publicSettings(settings: SessionSettings): PublicSessionSettings {
  const ai = settings.ai;
  return {
    ai: ai
      ? {
          provider: ai.provider,
          model: ai.model ?? undefined,
          baseUrl: ai.baseUrl ?? undefined,
          hasApiKey: Boolean(ai.apiKey),
          apiKeyHint: ai.apiKey ? `••••${ai.apiKey.slice(-4)}` : undefined,
        }
      : null,
    autoReply: settings.autoReply,
  };
}

export interface ResolvedAi {
  provider: AiProvider;
  model?: string;
  baseUrl?: string;
  apiKey?: string;
}

/** Effective AI config: session setting first, then AI_MODEL, then the built-in default. */
export function resolveAi(
  settings: SessionSettings,
  envModel: string | undefined,
  fallbackModel: string,
): ResolvedAi {
  const ai = settings.ai;
  if (ai?.provider === 'openai') {
    return {
      provider: 'openai',
      model: validCustomModel(ai.model),
      baseUrl: normalizeBaseUrl(ai.baseUrl),
      apiKey: ai.apiKey ?? undefined,
    };
  }
  return {
    provider: 'workers-ai',
    model: validModel(ai?.model) ?? validModel(envModel) ?? fallbackModel,
  };
}
