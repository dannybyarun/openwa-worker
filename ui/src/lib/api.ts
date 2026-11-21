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

export interface HistoryPage {
  id: string;
  messages: Message[];
  /** Group subjects (jid → name), cached by the session while its socket is open. */
  groups?: Record<string, string>;
  /** Cached profile pictures (jid → data URL, null when WhatsApp hides it). */
  avatars?: Record<string, string | null>;
}

export interface UsageSession {
  id: string;
  status: string;
  idleTtlMs: number;
  wakes: { used: number; limit: number; remaining: number; limited: boolean };
}

export interface UsageReport {
  date: string;
  freeTier: { durableObjectGbSecondsPerDay: number; requestsPerDay: number };
  estimate: {
    wakes: number;
    perWakeGbSeconds: number;
    doGbSeconds: number;
    projectedDoGbSeconds: number;
    doPercentOfFree: number;
  };
  idleTtlMs: number;
  sessions: UsageSession[];
  warnings: string[];
  note: string;
}

export interface AiDraft {
  session: string;
  chatId: string;
  mode: 'reply' | 'summary';
  model: string;
  messages: number;
  draft: string;
}

/** Open Graph card WhatsApp itself attached to the message. */
export interface LinkPreview {
  url: string;
  title?: string;
  description?: string;
  /** Small JPEG data URL sent inline by WhatsApp. */
  thumbnail?: string;
}

export interface MessageMedia {
  mimetype?: string;
  fileName?: string;
  fileLength?: number;
  seconds?: number;
  width?: number;
  height?: number;
  ptt?: boolean;
  /** Small JPEG data URL — the full file is fetched on demand. */
  thumbnail?: string;
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
  preview?: LinkPreview;
  media?: MessageMedia;
}

export type AiProvider = 'workers-ai' | 'openai';

/** Read shape — the API key is never echoed, only `hasApiKey` and a masked hint. */
export interface AiSettings {
  provider: AiProvider;
  model?: string;
  baseUrl?: string;
  hasApiKey?: boolean;
  apiKeyHint?: string;
}

/** Write shape; `null` clears a stored value. */
export interface AiSettingsPatch {
  provider: AiProvider;
  model?: string | null;
  baseUrl?: string | null;
  apiKey?: string | null;
}

export interface AutoReplySettings {
  enabled: boolean;
  /** `null` clears a previously stored value. */
  prompt?: string | null;
  model?: string | null;
  groups?: boolean;
  cooldownSeconds?: number;
  dailyLimit?: number;
}

export interface SessionSettings {
  ai?: AiSettings | null;
  autoReply?: AutoReplySettings;
}

export interface SessionSettingsPatch {
  ai?: AiSettingsPatch | null;
  autoReply?: Partial<AutoReplySettings> | null;
}

/** Minimal chat shape for the widget picker (the full ChatSummary lives in lib/format). */
export interface ChatSummaryLike {
  chatId: string;
  name: string;
}

export interface SessionSettingsPage {
  id: string;
  settings: SessionSettings;
  defaults: {
    provider: AiProvider;
    aiModel: string;
    autoReply: { cooldownSeconds: number; dailyLimit: number; groups: boolean };
  };
}

export interface TokenRecord {
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

export interface Config {
  /** Worker origin; empty means "the origin serving this page". */
  base: string;
  /**
   * Reserved for API clients. The browser UI always leaves this empty and signs
   * in with the password cookie instead, so no secret sits in localStorage.
   */
  token: string;
}

/** What the worker says about its login gate. */
export interface AuthState {
  required: boolean;
  authenticated: boolean;
  /** Session lifetime in seconds, when a password is configured. */
  expiresIn?: number;
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
  /** Public: tells the UI whether to show a login screen. */
  auth: (c: Config) => request<AuthState>(c, '/api/auth'),
  /** Exchanges the worker password for a signed HttpOnly session cookie. */
  login: (c: Config, password: string) =>
    request<{ ok: boolean; required?: boolean; expiresAt?: number }>(c, '/api/login', {
      method: 'POST',
      body: JSON.stringify({ password }),
    }),
  /** Drops the browser session cookie (does not unlink WhatsApp). */
  signOut: (c: Config) => request<{ ok: boolean }>(c, '/api/logout', { method: 'POST' }),
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
    request<HistoryPage>(c, `/api/sessions/${seg(id)}/history`),
  ai: (c: Config, id: string, chatId: string, mode: 'reply' | 'summary' = 'reply', instruction?: string) =>
    request<AiDraft>(c, `/api/sessions/${seg(id)}/ai`, {
      method: 'POST',
      body: JSON.stringify({ chatId, mode, ...(instruction ? { instruction } : {}) }),
    }),
  /** Free-plan usage estimate for every session plus the worker's own budget counters. */
  usage: (c: Config) => request<UsageReport>(c, '/api/usage'),
  settings: (c: Config, id: string) =>
    request<SessionSettingsPage>(c, `/api/sessions/${seg(id)}/settings`),
  saveSettings: (c: Config, id: string, patch: SessionSettingsPatch) =>
    request<SessionSettingsPage>(c, `/api/sessions/${seg(id)}/settings`, {
      method: 'POST',
      body: JSON.stringify(patch),
    }),
  tokens: (c: Config) => request<{ tokens: TokenRecord[] }>(c, '/api/tokens'),
  createToken: (
    c: Config,
    input: {
      label?: string;
      kind: 'full' | 'embed';
      session?: string;
      chatId?: string;
      origins?: string;
      expiresInDays?: number;
    },
  ) =>
    request<{ token: string; record: TokenRecord }>(c, '/api/tokens', {
      method: 'POST',
      body: JSON.stringify(input),
    }),
  deleteToken: (c: Config, id: string) =>
    request<{ ok: boolean }>(c, `/api/tokens/${seg(id)}`, { method: 'DELETE' }),
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
  /**
   * Fetch one media file on demand. The session DO downloads it from WhatsApp, so this
   * is why the UI shows a thumbnail first and only loads bytes when someone opens it.
   */
  mediaBlob: async (c: Config, id: string, messageId: string, download = false) => {
    const url = new URL(`${apiBase(c)}/api/sessions/${seg(id)}/media`);
    url.searchParams.set('id', messageId);
    if (download) url.searchParams.set('download', '1');
    const headers = new Headers();
    if (c.token) headers.set('x-api-key', c.token);
    const res = await fetch(url.toString(), { headers, credentials: 'include' });
    if (!res.ok) {
      throw new ApiError(res.status, (await res.text().catch(() => '')) || res.statusText);
    }
    return res.blob();
  },
  /** Cached profile picture for one chat; `null` when WhatsApp hides it or the socket is idle. */
  avatar: (c: Config, id: string, jid: string) =>
    request<{ jid: string; url: string | null; cached: boolean }>(
      c,
      `/api/sessions/${seg(id)}/avatar?jid=${encodeURIComponent(jid)}`,
    ),
};

/** `+977 980-0000000` / `9779800000000` → `9779800000000@s.whatsapp.net`. */export function toChatId(raw: string): string {
  const value = raw.trim();
  if (!value) return '';
  if (value.includes('@')) return value;
  const digits = value.replace(/[^\d]/g, '');
  return digits ? `${digits}@s.whatsapp.net` : value;
}

/** `15551234567:33@s.whatsapp.net` → `15551234567@s.whatsapp.net` (device suffix removed). */
export function jidKey(raw: string): string {
  return raw.replace(/:\d+(?=@)/, '');
}

/** `15551234567:33@s.whatsapp.net` → `+15551234567` (drop the device suffix). */
export function chatIdToNumber(chatId: string): string {
  const jid = (chatId.split('@')[0] ?? chatId).split(':')[0] ?? '';
  return jid ? `+${jid.replace(/[^\d]/g, '')}` : chatId;
}
