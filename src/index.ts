import { error, json } from './http';
import type { Env } from './env';

// Wrangler resolves Durable Object bindings by class name, so both classes must be exported here.
export { WhatsAppSession } from './session-do';
export { SessionRegistry } from './registry-do';

const NAME_RE = /^[a-zA-Z0-9_-]{1,64}$/;

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

    if (!authorized(request, env.API_TOKEN)) {
      return error('unauthorized', 401);
    }

    const parts = url.pathname.split('/').filter(Boolean); // e.g. ["api", "sessions", ":id", "qr"]
    if (parts[0] !== 'api' || parts[1] !== 'sessions') {
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

function authorized(request: Request, token: string | undefined): boolean {
  if (!token) return true; // API_TOKEN unset — local-dev posture
  // Browsers cannot set headers on WebSocket upgrades, so the token is also accepted as
  // ?token= (the static UI appends it for the events socket; REST calls use X-API-Key).
  const fromQuery = new URL(request.url).searchParams.get('token');
  const header = request.headers.get('x-api-key') ?? request.headers.get('authorization') ?? '';
  const provided = header.startsWith('Bearer ') ? header.slice(7) : header;
  return secureEquals(provided, token) || (fromQuery !== null && secureEquals(fromQuery, token));
}

function secureEquals(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diff === 0;
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