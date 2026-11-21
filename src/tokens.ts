/**
 * API / embed tokens. Pure helpers only — the Durable Object that stores them lives in
 * `token-do.ts`, so `scripts/tokens.spec.mjs` can test generation and origin rules directly.
 *
 * Three kinds:
 *  - `full`  — admin-equivalent: every route the API_TOKEN can reach.
 *  - `send`  — server-side sending only (text + documents), one session, optional chat allowlist.
 *  - `embed` — the public website widget: text only, pinned to one chat, origin-allowlisted.
 *
 * Token values are shown exactly once. Only their SHA-256 hash is stored.
 */

export type TokenKind = 'full' | 'send' | 'embed';

export interface PublicToken {
  id: string;
  label: string;
  kind: TokenKind;
  prefix: string;
  session?: string;
  /** `embed` tokens can only ever send here. */
  chatId?: string;
  /** `send` tokens: when non-empty, only these chats may be messaged. */
  chatIds?: string[];
  origins: string[];
  createdAt: string;
  expiresAt?: string;
}

export interface StoredToken extends PublicToken {
  hash: string;
  /** Daily counter for send/embed tokens (kept on the hashed record, reset at 00:00 UTC). */
  day?: string;
  usesToday?: number;
}

export const EMBED_DAILY_LIMIT = 50;
export const SEND_DAILY_LIMIT = 500;
export const MAX_TOKEN_ORIGINS = 20;
export const MAX_TOKEN_CHATS = 50;
export const MAX_TOKEN_DAYS = 365;
export const MAX_CHAT_ID_LENGTH = 200;
export const SESSION_RE = /^[a-zA-Z0-9_-]{1,64}$/;
export const TOKEN_RE = /^owa_[A-Za-z0-9_-]{32,64}$/;
const CHAT_ID_RE = /^[0-9][0-9-]{3,30}@(s\.whatsapp\.net|g\.us|lid|broadcast|newsletter)$/;

export function isTokenValue(value: unknown): value is string {
  return typeof value === 'string' && TOKEN_RE.test(value);
}

export function newTokenValue(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return `owa_${btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')}`;
}

export async function hashToken(value: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, '0')).join('');
}

/** Accepts a comma-separated string or an array; keeps valid http(s) origins, deduped. */
export function normalizeOrigins(input: unknown): string[] {
  const raw = Array.isArray(input) ? input : typeof input === 'string' ? input.split(',') : [];
  const origins: string[] = [];
  for (const item of raw) {
    if (typeof item !== 'string') continue;
    const trimmed = item.trim();
    if (!trimmed || trimmed === '*') continue;
    try {
      const url = new URL(trimmed);
      if (url.protocol !== 'http:' && url.protocol !== 'https:') continue;
      if (!origins.includes(url.origin)) origins.push(url.origin);
    } catch {
      // Ignore malformed entries rather than failing the whole token.
    }
    if (origins.length >= MAX_TOKEN_ORIGINS) break;
  }
  return origins;
}

/**
 * Empty allowlist means any site may embed; otherwise the browser Origin must match.
 * Server-to-server callers send no Origin header, so leave the list empty for those.
 */
export function originAllowed(origins: string[], origin: string | null): boolean {
  if (origins.length === 0) return true;
  if (!origin) return false;
  const normalized = origin.replace(/\/+$/, '');
  return origins.some(item => item.replace(/\/+$/, '') === normalized);
}

/** Days→ISO expiry, clamped to a sane range; `undefined` means no expiry. */
export function expiryFor(days: unknown, nowMs = Date.now()): string | undefined {
  const n = Number(days);
  if (!Number.isFinite(n) || n <= 0) return undefined;
  const safe = Math.min(MAX_TOKEN_DAYS, Math.max(1, Math.round(n)));
  return new Date(nowMs + safe * 86_400_000).toISOString();
}

/** Sends allowed per UTC day for a kind; `full` is uncapped. */
export function dailyLimitFor(kind: TokenKind): number {
  if (kind === 'embed') return EMBED_DAILY_LIMIT;
  if (kind === 'send') return SEND_DAILY_LIMIT;
  return 0;
}

/**
 * `send`-token allowlist. Accepts an array or comma-separated string, a bare number
 * (`9779800000000` becomes a `@s.whatsapp.net` address), deduped and capped.
 */
export function normalizeChatIds(input: unknown): string[] {
  const raw = Array.isArray(input) ? input : typeof input === 'string' ? input.split(',') : [];
  const chatIds: string[] = [];
  for (const item of raw) {
    if (typeof item !== 'string') continue;
    let value = item.trim().slice(0, MAX_CHAT_ID_LENGTH);
    if (!value) continue;
    if (!value.includes('@')) {
      const digits = value.replace(/[^\d]/g, '');
      if (!digits) continue;
      value = `${digits}@s.whatsapp.net`;
    }
    if (!CHAT_ID_RE.test(value)) continue;
    if (!chatIds.includes(value)) chatIds.push(value);
    if (chatIds.length >= MAX_TOKEN_CHATS) break;
  }
  return chatIds;
}

/** An empty allowlist means "any chat"; otherwise the target must be listed. */
export function chatAllowed(chatIds: string[] | undefined, chatId: string): boolean {
  if (!chatIds || chatIds.length === 0) return true;
  return chatIds.includes(chatId);
}

export function publicToken(token: StoredToken): PublicToken {
  const { hash: _hash, day: _day, usesToday: _uses, ...rest } = token;
  return rest;
}
