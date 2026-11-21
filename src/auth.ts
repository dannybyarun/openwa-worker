/**
 * Password login for the browser UI.
 *
 * A correct password buys a signed, expiring session cookie (HMAC-SHA256 over the
 * expiry, keyed with the same secret that gates the API). Nothing secret is stored
 * in the browser, rotating `UI_PASSWORD`/`API_TOKEN` invalidates every session, and
 * the cookie is HttpOnly so page scripts cannot read it.
 *
 * Scripts, Apps Script and cross-origin clients keep using `X-API-Key` (or
 * `?token=` for WebSocket upgrades) — this module only covers the cookie path.
 */
import type { Env } from './env';

export const SESSION_COOKIE = 'openwa_session';

const TOKEN_PREFIX = 'v1';
const DEFAULT_TTL_HOURS = 168; // 7 days
const MAX_TTL_HOURS = 720; // 30 days
const LOGIN_WINDOW_MS = 10 * 60 * 1000;
const MAX_LOGIN_FAILURES = 10;

/** Secret that gates the API; `UI_PASSWORD` wins so login can differ from the API token. */
export function authSecret(env: Env): string | undefined {
  return env.UI_PASSWORD || env.API_TOKEN || undefined;
}

/** The password accepted by `POST /api/login`. */
export function loginPassword(env: Env): string | undefined {
  return authSecret(env);
}

export function authRequired(env: Env): boolean {
  return authSecret(env) !== undefined;
}

export function sessionTtlSeconds(env: Env): number {
  const hours = Number(env.SESSION_TTL_HOURS);
  const safe = Number.isFinite(hours) && hours > 0 ? Math.min(hours, MAX_TTL_HOURS) : DEFAULT_TTL_HOURS;
  return Math.round(safe * 3600);
}

export async function createSessionToken(
  secret: string,
  ttlSeconds: number,
  nowMs = Date.now(),
): Promise<{ token: string; expiresAt: number }> {
  const exp = Math.floor(nowMs / 1000) + ttlSeconds;
  const payload = `${TOKEN_PREFIX}.${exp}`;
  const signature = await crypto.subtle.sign('HMAC', await hmacKey(secret), encoder.encode(payload));
  return { token: `${payload}.${base64Url(new Uint8Array(signature))}`, expiresAt: exp * 1000 };
}

export async function verifySessionToken(
  secret: string,
  token: string,
  nowMs = Date.now(),
): Promise<boolean> {
  const parts = token.split('.');
  if (parts.length !== 3) return false;
  const [prefix, expRaw, signatureRaw] = parts as [string, string, string];
  if (prefix !== TOKEN_PREFIX) return false;

  const exp = Number(expRaw);
  if (!Number.isInteger(exp) || exp * 1000 <= nowMs) return false;

  let signature: Uint8Array;
  try {
    signature = base64UrlDecode(signatureRaw);
  } catch {
    return false;
  }

  try {
    return await crypto.subtle.verify(
      'HMAC',
      await hmacKey(secret),
      signature,
      encoder.encode(`${prefix}.${expRaw}`),
    );
  } catch {
    return false;
  }
}

export function readCookie(request: Request, name: string): string | undefined {
  const header = request.headers.get('cookie');
  if (!header) return undefined;
  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq < 0) continue;
    if (part.slice(0, eq).trim() !== name) continue;
    const value = part.slice(eq + 1).trim();
    try {
      return decodeURIComponent(value);
    } catch {
      return value;
    }
  }
  return undefined;
}

export function sessionCookie(token: string, ttlSeconds: number, secure: boolean): string {
  const bits = [
    `${SESSION_COOKIE}=${encodeURIComponent(token)}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
    `Max-Age=${ttlSeconds}`,
  ];
  if (secure) bits.push('Secure');
  return bits.join('; ');
}

export function clearSessionCookie(secure: boolean): string {
  const bits = [`${SESSION_COOKIE}=`, 'Path=/', 'HttpOnly', 'SameSite=Lax', 'Max-Age=0'];
  if (secure) bits.push('Secure');
  return bits.join('; ');
}

export function clientIp(request: Request): string {
  return request.headers.get('cf-connecting-ip') ?? request.headers.get('x-real-ip') ?? 'unknown';
}

// Best-effort, per-isolate throttle on password guessing. Isolate-local state is
// enough here: the goal is to make online guessing useless, not to be a WAF.
const attempts = new Map<string, { failures: number; resetAt: number }>();

/** Seconds to wait before another attempt, or 0 when the caller may try. */
export function loginBlocked(ip: string, nowMs = Date.now()): number {
  const entry = attempts.get(ip);
  if (!entry) return 0;
  if (entry.resetAt <= nowMs) {
    attempts.delete(ip);
    return 0;
  }
  if (entry.failures < MAX_LOGIN_FAILURES) return 0;
  return Math.ceil((entry.resetAt - nowMs) / 1000);
}

export function recordLoginFailure(ip: string, nowMs = Date.now()): void {
  if (attempts.size > 2000) {
    for (const [key, entry] of attempts) {
      if (entry.resetAt <= nowMs) attempts.delete(key);
    }
  }
  const entry = attempts.get(ip);
  if (!entry || entry.resetAt <= nowMs) {
    attempts.set(ip, { failures: 1, resetAt: nowMs + LOGIN_WINDOW_MS });
    return;
  }
  entry.failures += 1;
}

export function clearLoginFailures(ip: string): void {
  attempts.delete(ip);
}

export function secureEquals(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diff === 0;
}

const encoder = new TextEncoder();

function hmacKey(secret: string): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    'raw',
    encoder.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign', 'verify'],
  );
}

function base64Url(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function base64UrlDecode(value: string): Uint8Array {
  const padded = value.replace(/-/g, '+').replace(/_/g, '/');
  const binary = atob(padded + '='.repeat((4 - (padded.length % 4)) % 4));
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}
