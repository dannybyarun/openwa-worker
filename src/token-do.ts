import { DurableObject } from 'cloudflare:workers';
import { error, json } from './http';
import {
  EMBED_DAILY_LIMIT,
  SESSION_RE,
  expiryFor,
  hashToken,
  isTokenValue,
  newTokenValue,
  normalizeOrigins,
  publicToken,
  type StoredToken,
  type TokenKind,
} from './tokens';
import type { Env } from './env';

/**
 * One global instance (`idFromName('tokens')`) holds every generated API/embed token.
 * Raw values are returned once at creation and never stored.
 */
export class TokenStore extends DurableObject<Env> {
  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const parts = url.pathname.split('/').filter(Boolean);
    const action = parts[0] ?? '';
    const method = request.method;

    if (method === 'GET' && !action) {
      return json({ tokens: (await this.list()).map(publicToken) });
    }

    if (method === 'POST' && action === 'verify') {
      return this.verify(request);
    }

    if (method === 'POST' && !action) {
      return this.create(request);
    }

    if (method === 'DELETE' && action) {
      return this.remove(decodeURIComponent(action));
    }

    return error('not found', 404);
  }

  private async list(): Promise<StoredToken[]> {
    return (await this.ctx.storage.get<StoredToken[]>('tokens')) ?? [];
  }

  private async create(request: Request): Promise<Response> {
    const body = (await request.json().catch(() => null)) as {
      label?: unknown;
      kind?: unknown;
      session?: unknown;
      chatId?: unknown;
      origins?: unknown;
      expiresInDays?: unknown;
    } | null;
    if (!body || typeof body !== 'object') return error('invalid JSON body', 400);

    const kind: TokenKind = body.kind === 'embed' ? 'embed' : 'full';
    const label =
      (typeof body.label === 'string' ? body.label.trim().slice(0, 80) : '') ||
      (kind === 'embed' ? 'Website widget' : 'API token');
    const session = typeof body.session === 'string' ? body.session.trim() : '';
    const chatId = typeof body.chatId === 'string' ? body.chatId.trim().slice(0, 200) : '';
    if (kind === 'embed') {
      if (!SESSION_RE.test(session)) return error('a valid session is required for embed tokens', 400);
      if (!chatId) return error('a chatId is required for embed tokens', 400);
    }

    const value = newTokenValue();
    const token: StoredToken = {
      id: crypto.randomUUID(),
      label,
      kind,
      prefix: value.slice(0, 12),
      hash: await hashToken(value),
      session: kind === 'embed' ? session : undefined,
      chatId: kind === 'embed' ? chatId : undefined,
      origins: kind === 'embed' ? normalizeOrigins(body.origins) : [],
      createdAt: new Date().toISOString(),
      expiresAt: expiryFor(body.expiresInDays),
      day: new Date().toISOString().slice(0, 10),
      usesToday: 0,
    };

    const list = await this.list();
    list.push(token);
    await this.ctx.storage.put({
      tokens: list,
      [`t:${token.hash}`]: token,
    });
    return json({ token: value, record: publicToken(token) }, 201);
  }

  private async verify(request: Request): Promise<Response> {
    const body = (await request.json().catch(() => null)) as {
      token?: unknown;
      consume?: unknown;
    } | null;
    if (!body || !isTokenValue(body.token)) return error('invalid token', 401);

    const hash = await hashToken(body.token);
    const token = await this.ctx.storage.get<StoredToken>(`t:${hash}`);
    if (!token) return error('invalid token', 401);
    if (token.expiresAt && Date.parse(token.expiresAt) <= Date.now()) {
      return error('token expired', 401);
    }

    if (body.consume === true && token.kind === 'embed') {
      const day = new Date().toISOString().slice(0, 10);
      const used = token.day === day ? token.usesToday ?? 0 : 0;
      if (used >= EMBED_DAILY_LIMIT) {
        return error(`daily embed limit reached (${EMBED_DAILY_LIMIT}); it resets at 00:00 UTC`, 429);
      }
      token.day = day;
      token.usesToday = used + 1;
      await this.ctx.storage.put(`t:${hash}`, token);
    }

    return json({ token: publicToken(token) });
  }

  private async remove(id: string): Promise<Response> {
    const list = await this.list();
    const token = list.find(item => item.id === id);
    if (!token) return error('token not found', 404);
    const next = list.filter(item => item.id !== id);
    await this.ctx.storage.put('tokens', next);
    await this.ctx.storage.delete(`t:${token.hash}`);
    return json({ ok: true, id });
  }
}
