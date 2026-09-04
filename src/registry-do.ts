import { DurableObject } from 'cloudflare:workers';
import { error, json } from './http';
import type { Env } from './env';

/**
 * Durable Objects cannot be enumerated, so this single global instance keeps the list of session
 * names. The worker consults it for GET /api/sessions and keeps it in sync on create/delete.
 */
export class SessionRegistry extends DurableObject<Env> {
  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const method = request.method;
    const name = decodeURIComponent(url.pathname.split('/').filter(Boolean).pop() ?? '');

    if (method === 'GET') {
      return json({ sessions: await this.names() });
    }

    if (method === 'POST') {
      if (!name) return error('session name is required', 400);
      const names = await this.names();
      if (!names.includes(name)) {
        names.push(name);
        await this.ctx.storage.put('names', names);
      }
      return json({ ok: true, name });
    }

    if (method === 'DELETE') {
      if (!name) return error('session name is required', 400);
      const names = (await this.names()).filter(n => n !== name);
      await this.ctx.storage.put('names', names);
      return json({ ok: true, name });
    }

    return error('method not allowed', 405);
  }

  private async names(): Promise<string[]> {
    return (await this.ctx.storage.get<string[]>('names')) ?? [];
  }
}