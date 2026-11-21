export type SessionStatusName =
  | 'new'
  | 'connecting'
  | 'qr'
  | 'connected'
  | 'idle'
  | 'closed'
  | 'loggedOut';

export interface WakeBudget {
  used?: number;
  limit?: number;
  remaining?: number;
}

export interface Me {
  id?: string;
  name?: string;
}

export interface SessionStatus {
  id: string;
  status: SessionStatusName;
  qr?: string;
  me?: Me;
  lastDisconnect?: { code?: number; message?: string; at?: string };
  updatedAt?: string;
  wake?: WakeBudget;
}

export interface SessionSummary {
  id: string;
  status: SessionStatusName;
  me?: Me;
}

export interface Message {
  id?: string;
  chatId: string;
  fromMe?: boolean;
  sender?: string;
  pushName?: string;
  timestamp?: string;
  type?: string;
  text?: string;
  seq?: number;
}

export interface Config {
  base: string;
  token: string;
}

export class ApiError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

export function apiBase(config: Config): string {
  return config.base.replace(/\/+$/, '') || window.location.origin;
}

export async function request<T>(
  config: Config,
  path: string,
  init: RequestInit = {},
): Promise<T> {
  const headers = new Headers(init.headers);
  if (config.token) headers.set('x-api-key', config.token);
  if (init.body) headers.set('content-type', 'application/json');
  const res = await fetch(apiBase(config) + path, { ...init, headers });
  const raw = await res.text().catch(() => '');
  if (!res.ok) throw new ApiError(res.status, raw || res.statusText);
  return (raw ? JSON.parse(raw) : null) as T;
}

const seg = (id: string) => encodeURIComponent(id);

export const api = {
  sessions: (c: Config) => request<{ sessions: SessionSummary[] }>(c, '/api/sessions'),
  createSession: (c: Config, name: string) =>
    request<{ id: string; status: SessionStatusName }>(c, '/api/sessions', {
      method: 'POST',
      body: JSON.stringify({ name }),
    }),
  deleteSession: (c: Config, id: string) =>
    request<{ ok: boolean }>(c, `/api/sessions/${seg(id)}`, { method: 'DELETE' }),
  status: (c: Config, id: string) =>
    request<SessionStatus>(c, `/api/sessions/${seg(id)}/status`),
  qr: (c: Config, id: string) =>
    request<{ id: string; status: SessionStatusName; qr?: string }>(c, `/api/sessions/${seg(id)}/qr`),
  start: (c: Config, id: string) =>
    request<SessionStatus>(c, `/api/sessions/${seg(id)}/start`, { method: 'POST' }),
  wake: (c: Config, id: string, wait = 15000) =>
    request<SessionStatus>(c, `/api/sessions/${seg(id)}/wake?wait=${wait}`, { method: 'POST' }),
  idle: (c: Config, id: string) =>
    request<SessionStatus>(c, `/api/sessions/${seg(id)}/idle`, { method: 'POST' }),
  logout: (c: Config, id: string) =>
    request<{ ok: boolean }>(c, `/api/sessions/${seg(id)}/logout`, { method: 'POST' }),
  history: (c: Config, id: string) =>
    request<{ id: string; messages: Message[] }>(c, `/api/sessions/${seg(id)}/history`),
  sendText: (c: Config, id: string, chatId: string, text: string) =>
    request<{ id?: string; chatId: string; timestamp?: string }>(
      c,
      `/api/sessions/${seg(id)}/send-text`,
      { method: 'POST', body: JSON.stringify({ chatId, text }) },
    ),
  eventsUrl: (c: Config, id: string) => {
    const url = new URL(`${apiBase(c)}/api/sessions/${seg(id)}/events`);
    url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
    if (c.token) url.searchParams.set('token', c.token);
    return url.toString();
  },
};

/** `+977 980-0000000` / `9779800000000` → `9779800000000@s.whatsapp.net`. */
export function toChatId(raw: string): string {
  const value = raw.trim();
  if (!value) return '';
  if (value.includes('@')) return value;
  const digits = value.replace(/[^\d]/g, '');
  return digits ? `${digits}@s.whatsapp.net` : value;
}

/** Human phone number from a jid, keeping the prefix WhatsApp Web shows. */
export function chatIdToNumber(chatId: string): string {
  const jid = chatId.split('@')[0] ?? chatId;
  return jid ? `+${jid.replace(/[^\d]/g, '')}` : chatId;
}
