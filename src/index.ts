import { error, json } from './http';
import type { Env } from './env';
import { isTokenValue, originAllowed } from './tokens';
import {
  authRequired,
  authSecret,
  clearLoginFailures,
  clearSessionCookie,
  clientIp,
  createSessionToken,
  loginBlocked,
  loginPassword,
  readCookie,
  recordLoginFailure,
  SESSION_COOKIE,
  secureEquals,
  sessionCookie,
  sessionTtlSeconds,
  verifySessionToken,
} from './auth';

// Wrangler resolves Durable Object bindings by class name, so both classes must be exported here.
export { WhatsAppSession } from './session-do';
export { SessionRegistry } from './registry-do';
export { TokenStore } from './token-do';

const NAME_RE = /^[a-zA-Z0-9_-]{1,64}$/;

// Cloudflare free-plan allowances (Workers + Durable Objects), per UTC day.
const FREE_DO_GB_SECONDS = 13_000;
const FREE_REQUESTS = 100_000;
const DO_MEMORY_GB = 0.125; // a Durable Object bills 128 MB while it is running

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    try {
      return await handleFetch(request, env);
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error('handler crashed:', err);
      const detail = err instanceof Error ? `${err.message} — ${err.stack?.split('\n')[1] ?? ''}`.trim() : JSON.stringify(err);
      return error(`internal error: ${detail}`, 500);
    }
  },
} satisfies ExportedHandler<Env>;

async function handleFetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === '/health') {
      return json({ ok: true });
    }

    // Everything outside /api and /health is the static UI (./ui, assets binding).
    if (!url.pathname.startsWith('/api/')) {
      return env.ASSETS.fetch(request);
    }

    // CORS for the static UI when it is hosted elsewhere (browsers preflight the
    // REST calls; WebSocket upgrades need no CORS but are covered by the same headers).
    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: corsHeaders() });
    }

    // Browser login endpoints. These are unauthenticated by design: /api/auth is how
    // the UI learns whether a password is needed, /api/login exchanges it for a
    // signed session cookie, /api/logout drops that cookie.
    if (request.method === 'POST' && url.pathname === '/api/login') {
      return cors(await handleLogin(request, env));
    }
    if (request.method === 'POST' && url.pathname === '/api/logout') {
      return cors(handleLogout(request));
    }
    if (request.method === 'GET' && url.pathname === '/api/auth') {
      return cors(
        json({
          required: authRequired(env),
          authenticated: await authorized(request, env),
          expiresIn: authRequired(env) ? sessionTtlSeconds(env) : undefined,
        }),
      );
    }

    // Publishable website widget. Authenticated by a send-only embed token instead of the
    // admin secret, so it is handled before the general gate below. The token pins one
    // session and one chat; the widget can send, never read.
    if (request.method === 'POST' && url.pathname === '/api/embed/send') {
      return cors(await embedSend(request, env));
    }

    if (!(await authorized(request, env))) {
      return error('unauthorized', 401);
    }

    const parts = url.pathname.split('/').filter(Boolean); // e.g. ["api", "sessions", ":id", "qr"]

    // Generated API / widget tokens (admin-only, like everything below).
    if (parts[0] === 'api' && parts[1] === 'tokens') {
      const store = env.TOKEN_STORE.get(env.TOKEN_STORE.idFromName('tokens'));
      const target = parts[2]
        ? `https://tokens/${encodeURIComponent(parts[2])}`
        : 'https://tokens/';
      if (request.method === 'GET' && !parts[2]) {
        return cors(await store.fetch(new Request(target, { method: 'GET' })));
      }
      if (request.method === 'POST' && !parts[2]) {
        return cors(await store.fetch(new Request(target, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(await request.json().catch(() => null)),
        })));
      }
      if (request.method === 'DELETE' && parts[2]) {
        return cors(await store.fetch(new Request(target, { method: 'DELETE' })));
      }
      return cors(error('not found', 404));
    }

    if (parts[0] !== 'api' || parts[1] !== 'sessions') {
      if (request.method === 'GET' && url.pathname === '/api/usage') {
        return cors(await usageReport(env));
      }
      return error('not found', 404);
    }

    const sessionId = parts[2];
    const action = parts[3];

    // Collection routes -----------------------------------------------------
    if (request.method === 'GET' && parts.length === 2) {
      return cors(await listSessions(env));
    }
    if (request.method === 'POST' && parts.length === 2) {
      return cors(await createSession(request, env));
    }

    if (!sessionId || !NAME_RE.test(sessionId)) {
      return cors(error('invalid session id', 400));
    }
    const stub = env.WHATSAPP_SESSION.get(env.WHATSAPP_SESSION.idFromName(sessionId));

    // WebSocket upgrade — proxy the raw request so the DO can accept the pair.
    if (request.method === 'GET' && action === 'events') {
      if (request.headers.get('Upgrade') !== 'websocket') {
        return cors(error('expected Upgrade: websocket', 426));
      }
      return stub.fetch(request);
    }

    // Instance routes -------------------------------------------------------
    if (request.method === 'GET' && action === 'status') {
      return cors(await stub.fetch(new Request(`${stubUrl(request)}/status`, { method: 'GET' })));
    }
    if (request.method === 'GET' && action === 'qr') {
      return cors(await stub.fetch(new Request(`${stubUrl(request)}/qr`, { method: 'GET' })));
    }
    if (request.method === 'GET' && action === 'history') {
      return cors(await stub.fetch(new Request(`${stubUrl(request)}/history`, { method: 'GET' })));
    }
    // Lazy-session pull API. Query strings are forwarded verbatim (wait / after / limit / upto).
    if (request.method === 'POST' && action === 'wake') {
      return cors(await stub.fetch(new Request(`${stubUrl(request)}/wake${url.search}`, { method: 'POST' })));
    }
    if (request.method === 'GET' && action === 'messages') {
      return cors(await stub.fetch(new Request(`${stubUrl(request)}/messages${url.search}`, { method: 'GET' })));
    }
    if (request.method === 'POST' && action === 'ack') {
      return cors(await stub.fetch(new Request(`${stubUrl(request)}/ack${url.search}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(await request.json().catch(() => null)),
      })));
    }
    if (request.method === 'POST' && action === 'idle') {
      return cors(await stub.fetch(new Request(`${stubUrl(request)}/idle`, { method: 'POST' })));
    }
    if (request.method === 'POST' && action === 'start') {
      return cors(await stub.fetch(new Request(`${stubUrl(request)}/start`, { method: 'POST' })));
    }
    if (request.method === 'POST' && action === 'send-text') {
      return cors(await stub.fetch(new Request(`${stubUrl(request)}/send-text`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(await request.json().catch(() => null)),
      })));
    }
    if (request.method === 'POST' && action === 'send-document') {
      return cors(await stub.fetch(new Request(`${stubUrl(request)}/send-document`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(await request.json().catch(() => null)),
      })));
    }
    // AI draft/summary for one chat. Read-only: the DO returns text, nothing is sent.
    if (request.method === 'POST' && action === 'ai') {
      return cors(await stub.fetch(new Request(`${stubUrl(request)}/ai`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(await request.json().catch(() => null)),
      })));
    }
    // Per-session AI model / auto-reply configuration.
    if ((request.method === 'GET' || request.method === 'POST') && action === 'settings') {
      const init: RequestInit = { method: request.method };
      if (request.method === 'POST') {
        init.headers = { 'content-type': 'application/json' };
        init.body = JSON.stringify(await request.json().catch(() => null));
      }
      return cors(await stub.fetch(new Request(`${stubUrl(request)}/settings`, init)));
    }
    // Media is a binary stream, so the DO response goes back untouched (status, type,
    // filename, cache headers). Query strings are forwarded (`id`, `download`).
    if (request.method === 'GET' && action === 'media') {
      return cors(await stub.fetch(new Request(`${stubUrl(request)}/media${url.search}`, { method: 'GET' })));
    }
    if ((request.method === 'POST' || request.method === 'DELETE') && action === 'logout') {
      const doResult = await stub.fetch(new Request(`${stubUrl(request)}/logout`, { method: 'POST' }));
      await env.SESSION_REGISTRY.get(env.SESSION_REGISTRY.idFromName('registry')).fetch(
        new Request(`https://registry/sessions/${sessionId}`, { method: 'DELETE' }),
      );
      return cors(doResult);
    }
    if (request.method === 'DELETE' && parts.length === 3) {
      const doResult = await stub.fetch(new Request(`${stubUrl(request)}/logout`, { method: 'POST' }));
      await env.SESSION_REGISTRY.get(env.SESSION_REGISTRY.idFromName('registry')).fetch(
        new Request(`https://registry/sessions/${sessionId}`, { method: 'DELETE' }),
      );
      return cors(doResult);
    }

    return cors(error('not found', 404));
}

async function handleLogin(request: Request, env: Env): Promise<Response> {
  const secret = authSecret(env);
  if (!secret) {
    // Nothing configured, so every request is already allowed (local-dev posture).
    return json({ ok: true, required: false });
  }

  const ip = clientIp(request);
  const retryAfter = loginBlocked(ip);
  if (retryAfter > 0) {
    const response = error('too many attempts, try again later', 429);
    response.headers.set('retry-after', String(retryAfter));
    return response;
  }

  const body = (await request.json().catch(() => null)) as { password?: string } | null;
  const password = typeof body?.password === 'string' ? body.password : '';
  const expected = loginPassword(env) ?? '';

  if (!password || !secureEquals(password, expected)) {
    recordLoginFailure(ip);
    return error('invalid password', 401);
  }

  clearLoginFailures(ip);
  const ttl = sessionTtlSeconds(env);
  const { token, expiresAt } = await createSessionToken(secret, ttl);
  const response = json({ ok: true, required: true, expiresAt });
  response.headers.set('set-cookie', sessionCookie(token, ttl, isSecure(request)));
  return response;
}

function handleLogout(request: Request): Response {
  const response = json({ ok: true });
  response.headers.set('set-cookie', clearSessionCookie(isSecure(request)));
  return response;
}

function isSecure(request: Request): boolean {
  return new URL(request.url).protocol === 'https:';
}

async function listSessions(env: Env): Promise<Response> {
  const registry = env.SESSION_REGISTRY.get(env.SESSION_REGISTRY.idFromName('registry'));
  const listed = (await registry.fetch('https://registry/').then(r => r.json())) as { sessions: string[] };
  const sessions = await Promise.all(
    listed.sessions.map(async name => {
      const stub = env.WHATSAPP_SESSION.get(env.WHATSAPP_SESSION.idFromName(name));
      try {
        const status = (await stub.fetch('https://session/status').then(r => r.json())) as {
          status: string;
          me?: { id: string };
        };
        return { id: name, status: status.status, me: status.me };
      } catch {
        return { id: name, status: 'unknown' };
      }
    }),
  );
  return json({ sessions });
}

interface SessionUsage {
  id: string;
  status: string;
  idleTtlMs: number;
  wakes: { used: number; limit: number; remaining: number; limited: boolean };
}

/**
 * Free-plan usage panel: per-session wake budget plus an estimate of Durable Object
 * duration. The estimate is `wakes × idle window × 128 MB` — exactly the shape
 * Cloudflare bills — so it is a useful early warning, not a replacement for the
 * account dashboard.
 */
async function usageReport(env: Env): Promise<Response> {
  const registry = env.SESSION_REGISTRY.get(env.SESSION_REGISTRY.idFromName('registry'));
  const listed = (await registry.fetch('https://registry/').then(r => r.json())) as {
    sessions: string[];
  };

  const sessions: SessionUsage[] = await Promise.all(
    listed.sessions.map(async name => {
      const stub = env.WHATSAPP_SESSION.get(env.WHATSAPP_SESSION.idFromName(name));
      try {
        const data = (await stub.fetch('https://session/usage').then(r => r.json())) as SessionUsage;
        return {
          id: name,
          status: typeof data.status === 'string' ? data.status : 'unknown',
          idleTtlMs: Number(data.idleTtlMs) > 0 ? Number(data.idleTtlMs) : 60_000,
          wakes: {
            used: Math.max(0, Number(data.wakes?.used) || 0),
            limit: Math.max(0, Number(data.wakes?.limit) || 0),
            remaining: Math.max(0, Number(data.wakes?.remaining) || 0),
            limited: data.wakes?.limited === true,
          },
        };
      } catch {
        return {
          id: name,
          status: 'unknown',
          idleTtlMs: 60_000,
          wakes: { used: 0, limit: 0, remaining: 0, limited: false },
        };
      }
    }),
  );

  const idleTtlMs = sessions[0]?.idleTtlMs ?? 60_000;
  const perWakeGbSeconds = (idleTtlMs / 1000) * DO_MEMORY_GB;
  const wakes = sessions.reduce((sum, session) => sum + session.wakes.used, 0);
  const doGbSeconds = Math.round(wakes * perWakeGbSeconds * 10) / 10;

  const now = new Date();
  const dayStart = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  const elapsed = Math.min(1, Math.max(0, (now.getTime() - dayStart) / 86_400_000));
  const projectedDoGbSeconds =
    elapsed > 0.02 ? Math.round(doGbSeconds / elapsed) : Math.round(doGbSeconds);

  const warnings: string[] = [];
  if (projectedDoGbSeconds > FREE_DO_GB_SECONDS * 0.8) {
    warnings.push(
      `On pace for ~${projectedDoGbSeconds.toLocaleString()} GB-s of Durable Object duration today; ` +
        `the free plan allows ${FREE_DO_GB_SECONDS.toLocaleString()}. Lower DAILY_WAKE_LIMIT or poll less often.`,
    );
  }
  const exhausted = sessions.filter(session => session.wakes.limited && session.wakes.remaining === 0);
  if (exhausted.length > 0) {
    warnings.push(
      `Daily wake limit reached for ${exhausted.map(session => session.id).join(', ')}; it resets at 00:00 UTC.`,
    );
  }

  return json({
    date: now.toISOString().slice(0, 10),
    freeTier: {
      durableObjectGbSecondsPerDay: FREE_DO_GB_SECONDS,
      requestsPerDay: FREE_REQUESTS,
    },
    estimate: {
      wakes,
      perWakeGbSeconds: Math.round(perWakeGbSeconds * 100) / 100,
      doGbSeconds,
      projectedDoGbSeconds,
      doPercentOfFree: Math.round((projectedDoGbSeconds / FREE_DO_GB_SECONDS) * 100),
    },
    idleTtlMs,
    sessions,
    warnings,
    note: "Estimated from this worker's own wake counters. Cloudflare's dashboard has the billed numbers.",
  });
}

async function createSession(request: Request, env: Env): Promise<Response> {
  const body = (await request.json().catch(() => null)) as { name?: string } | null;
  const name = body?.name;
  if (!name || !NAME_RE.test(name)) {
    return error('name is required (letters, digits, - and _, max 64 chars)', 400);
  }
  const registry = env.SESSION_REGISTRY.get(env.SESSION_REGISTRY.idFromName('registry'));
  await registry.fetch(new Request(`https://registry/sessions/${encodeURIComponent(name)}`, { method: 'POST' }));

  const stub = env.WHATSAPP_SESSION.get(env.WHATSAPP_SESSION.idFromName(name));
  let status = 'new';
  try {
    const res = await stub.fetch('https://session/start', { method: 'POST' });
    const payload = (await res.json().catch(() => null)) as { status?: string } | null;
    // 429 means the session is registered but its daily wake budget is spent; it stays 'new'
    // and the next pull after 00:00 UTC will connect it.
    if (res.ok && payload?.status) status = payload.status;
  } catch {
    // registration already recorded; a later wake will connect it
  }
  return json({ id: name, status }, 201);
}

/** Stored token record as the TokenStore returns it (no hash, no counters). */
interface TokenRecord {
  id: string;
  label: string;
  kind: 'full' | 'embed';
  prefix: string;
  session?: string;
  chatId?: string;
  origins: string[];
  createdAt: string;
  expiresAt?: string;
}

function tokenStore(env: Env) {
  return env.TOKEN_STORE.get(env.TOKEN_STORE.idFromName('tokens'));
}

/** Ask the TokenStore about a generated token. `consume` counts an embed use. */
async function verifyManagedToken(
  env: Env,
  value: string,
  consume = false,
): Promise<{ ok: true; token: TokenRecord } | { ok: false; status: number; message: string }> {
  const res = await tokenStore(env).fetch(new Request('https://tokens/verify', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ token: value, consume }),
  }));
  const payload = (await res.json().catch(() => null)) as
    | { token?: TokenRecord; error?: string }
    | null;
  if (!res.ok || !payload?.token) {
    return { ok: false, status: res.status, message: payload?.error ?? 'invalid token' };
  }
  return { ok: true, token: payload.token };
}

/**
 * Publishable widget endpoint. A `kind: 'embed'` token can only send text to the one chat
 * it was minted for, from an allowlisted origin if one was given, and is rate-limited by
 * the TokenStore. It can never read history, settings, or tokens.
 */
async function embedSend(request: Request, env: Env): Promise<Response> {
  const body = (await request.json().catch(() => null)) as
    | { token?: unknown; chatId?: unknown; text?: unknown }
    | null;
  const token = typeof body?.token === 'string' ? body.token.trim() : '';
  const text = typeof body?.text === 'string' ? body.text.trim() : '';
  if (!isTokenValue(token)) return error('a widget token is required', 401);
  if (!text) return error('text is required', 400);
  if (text.length > 1000) return error('text is too long (1000 characters max)', 413);

  const verified = await verifyManagedToken(env, token, true);
  if (!verified.ok) return error(verified.message, verified.status);
  const record = verified.token;
  if (record.kind !== 'embed') return error('this token is not a website widget token', 403);
  if (!originAllowed(record.origins, request.headers.get('origin'))) {
    return error('this origin is not allowed to use this token', 403);
  }

  const chatId = record.chatId ?? '';
  const session = record.session ?? '';
  if (!chatId) return error('this token is not bound to a chat', 403);
  if (!NAME_RE.test(session)) return error('this token has no valid session', 403);
  const requested = typeof body?.chatId === 'string' ? body.chatId.trim() : '';
  if (requested && requested !== chatId) {
    return error('this token can only send to its own chat', 403);
  }

  const stub = env.WHATSAPP_SESSION.get(env.WHATSAPP_SESSION.idFromName(session));
  const res = await stub.fetch(new Request('https://session/send-text', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ chatId, text }),
  }));
  const payload = await res.json().catch(() => null);
  if (!res.ok) {
    return json(payload ?? { error: 'send failed' }, res.status);
  }
  return json({ ok: true, id: (payload as { id?: string } | null)?.id });
}

async function authorized(request: Request, env: Env): Promise<boolean> {
  const secret = authSecret(env);
  if (!secret) return true; // nothing configured — local-dev posture

  const fromQuery = new URL(request.url).searchParams.get('token');
  const header = request.headers.get('x-api-key') ?? request.headers.get('authorization') ?? '';
  const provided = (header.startsWith('Bearer ') ? header.slice(7) : header).trim();

  // Scripts and cross-origin clients: the bearer token, also accepted as ?token=
  // because browsers cannot set headers on WebSocket upgrades.
  if (env.API_TOKEN) {
    if (secureEquals(provided, env.API_TOKEN)) return true;
    if (fromQuery !== null && secureEquals(fromQuery, env.API_TOKEN)) return true;
  }

  // Browser: the signed cookie set by POST /api/login (also sent on same-origin
  // WebSocket upgrades, so the events socket needs no ?token= after signing in).
  const cookie = readCookie(request, SESSION_COOKIE);
  if (cookie && (await verifySessionToken(secret, cookie))) return true;

  // Generated `full` tokens are admin-equivalent, so scripts can rotate away from the
  // shared API_TOKEN. Embed tokens are deliberately rejected here.
  const candidate = [provided, fromQuery ?? ''].find(isTokenValue);
  if (candidate) {
    const verified = await verifyManagedToken(env, candidate);
    return verified.ok && verified.token.kind === 'full';
  }
  return false;
}

function corsHeaders(): Record<string, string> {
  return {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
    'Access-Control-Allow-Headers': 'content-type, x-api-key, authorization',
    'Access-Control-Max-Age': '86400',
  };
}

function cors(response: Response): Response {
  const headers = new Headers(response.headers);
  for (const [key, value] of Object.entries(corsHeaders())) {
    headers.set(key, value);
  }
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}

function stubUrl(request: Request): string {
  // The DOs don't care about the origin; keep the caller's so logs stay readable.
  return new URL(request.url).origin;
}