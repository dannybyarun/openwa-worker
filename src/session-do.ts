import { DurableObject } from 'cloudflare:workers';
import {
  Browsers,
  DisconnectReason,
  fetchLatestBaileysVersion,
  makeWASocket,
  type AuthenticationState,
  type BaileysEventMap,
  type WAMessage,
  type WASocket,
} from '@whiskeysockets/baileys';
import { DurableObjectAuthState } from './auth-state';
import { createWorkerLogger } from './logger';
import { error, json } from './http';
import type { Env } from './env';

const ALARM_INTERVAL_MS = 2 * 60_000; // bound the disconnected window after a DO eviction
const BASE_RECONNECT_DELAY_MS = 2_000;
const MAX_RECONNECT_DELAY_MS = 60_000;
const FALLBACK_WA_VERSION = [2, 3000, 0] as const;
const HISTORY_LIMIT = 200; // most recent messages kept per session (storage key 'history')

export type SessionStatusName = 'new' | 'connecting' | 'qr' | 'connected' | 'closed' | 'loggedOut';

export interface SessionStatus {
  status: SessionStatusName;
  qr?: string;
  me?: { id: string; name?: string };
  lastDisconnect?: { code?: number; message?: string; at: string };
  updatedAt: string;
}

function lastDisconnectCode(error: unknown): number | undefined {
  const boom = error as { output?: { statusCode?: number }; statusCode?: number };
  return boom?.output?.statusCode ?? boom?.statusCode;
}

function mapMessage(m: WAMessage): Record<string, unknown> {
  const content = m.message ?? {};
  const text =
    content.conversation ??
    content.extendedTextMessage?.text ??
    content.imageMessage?.caption ??
    content.videoMessage?.caption ??
    content.documentMessage?.caption ??
    '';
  const timestamp =
    m.messageTimestamp === undefined
      ? undefined
      : new Date(Number(m.messageTimestamp) * 1000).toISOString();
  return {
    id: m.key?.id,
    chatId: m.key?.remoteJid,
    fromMe: m.key?.fromMe ?? false,
    sender: m.key?.participant ?? m.key?.remoteJid,
    pushName: m.pushName,
    timestamp,
    type: Object.keys(content)[0] ?? 'unknown',
    text,
  };
}

/**
 * One WhatsApp session = one Durable Object instance (idFromName(sessionName)).
 *
 * The DO owns the baileys socket, the auth state (creds + signal keys) in its storage, and the
 * reconnect loop. UI clients subscribe to `GET /events` (WebSocket upgrade) and receive a JSON
 * event stream (`connection.update` + `message` events).
 *
 * Platform caveat (documented in README): an *outbound* WebSocket keeps a Durable Object resident
 * for up to 15 minutes, then stops preventing eviction. After an eviction the WA socket is gone, so
 * this DO re-arms a 2-minute alarm that reconnects, and baileys reconnects on its own while
 * resident. WhatsApp queues pending messages and delivers them after reconnect, so nothing is lost.
 */
export class WhatsAppSession extends DurableObject<Env> {
  private sock?: WASocket;
  private auth?: DurableObjectAuthState;
  private connecting?: Promise<void>;
  private reconnectTimer?: ReturnType<typeof setTimeout>;
  private reconnectAttempts = 0;
  private intentionalClose = false;
  private alarmsArmed = false;
  private cachedVersion?: [number, number, number];
  private statusCache?: SessionStatus;
  private historyBuf?: Record<string, unknown>[];

  async fetch(request: Request): Promise<Response> {
    // The worker forwards /api/sessions/:id/:action RAW to this DO — preserving the WS
    // Upgrade headers for /events — so the pathname arrives with the /api/sessions/:id
    // prefix. Route on the last path segment instead of the full path; that matches both
    // raw-forwarded requests and the worker's own constructed stub URLs (/status, /qr, ...).
    const url = new URL(request.url);
    const segments = url.pathname.replace(/\/+$/, '').split('/').filter(Boolean);
    const action = segments[segments.length - 1] ?? '';
    try {
      await this.armAlarm();

      if (request.method === 'GET' && action === 'events') {
        return this.handleEventsUpgrade(request);
      }
      if (request.method === 'GET' && action === 'status') {
        return json({ id: this.ctx.id.name, ...(await this.getStatus()) });
      }
      if (request.method === 'GET' && action === 'qr') {
        const status = await this.getStatus();
        return json({ id: this.ctx.id.name, status: status.status, qr: status.qr });
      }
      if (request.method === 'GET' && action === 'history') {
        const history = (await this.ctx.storage.get<Record<string, unknown>[]>('history')) ?? [];
        return json({ id: this.ctx.id.name, messages: history.slice().reverse() });
      }
      if (request.method === 'POST' && action === 'start') {
        await this.ensureConnected();
        return json({ id: this.ctx.id.name, ...(await this.getStatus()) });
      }
      if (request.method === 'POST' && action === 'send-text') {
        const body = (await request.json().catch(() => null)) as {
          chatId?: string;
          text?: string;
        } | null;
        if (!body?.chatId || typeof body.text !== 'string') {
          return error('chatId and text are required', 400);
        }
        return json(await this.sendText(body.chatId, body.text));
      }
      if (request.method === 'POST' && action === 'logout') {
        await this.logout();
        return json({ ok: true, id: this.ctx.id.name });
      }
      return error('not found', 404);
    } catch (err) {
      return error(err instanceof Error ? err.message : 'internal error', 500);
    }
  }

  // --- lifecycle -------------------------------------------------------------

  private async getAuth(): Promise<DurableObjectAuthState> {
    if (!this.auth) this.auth = new DurableObjectAuthState(this.ctx.storage);
    return this.auth;
  }

  async ensureConnected(): Promise<void> {
    if (this.sock?.ws.isOpen) return;
    await this.establish();
  }

  private get logLevel(): 'trace' | 'debug' | 'info' | 'warn' | 'error' | 'fatal' {
    const level = this.env.LOG_LEVEL as string | undefined;
    return level === 'trace' || level === 'debug' || level === 'warn' || level === 'error' || level === 'fatal'
      ? level
      : 'info';
  }

  /** Create a fresh baileys socket (the old one is unusable after a close). */
  private establish(): Promise<void> {
    if (!this.connecting) {
      this.connecting = this.doConnect().finally(() => {
        this.connecting = undefined;
      });
    }
    return this.connecting;
  }

  private async doConnect(): Promise<void> {
    const auth = await this.getAuth();
    const state: AuthenticationState = await auth.get();
    const version = await this.resolveVersion();
    const logger = createWorkerLogger(`wa:${this.ctx.id.name}`, this.logLevel);

    const sock = makeWASocket({
      version,
      browser: Browsers.ubuntu('Chrome'),
      auth: state,
      logger,
      printQRInTerminal: false,
      syncFullHistory: false,
      markOnlineOnConnect: true,
      generateHighQualityLinkPreview: false,
      fireInitQueries: true,
      getMessage: async () => undefined,
      cachedGroupMetadata: async () => undefined,
    });
    this.sock = sock;
    this.intentionalClose = false;
    this.wire(sock);
    // Errors are surfaced through connection.update('close'); do not throw here.
    await sock.waitForSocketOpen().catch(() => {});
  }

  private async resolveVersion(): Promise<[number, number, number]> {
    if (this.cachedVersion) return this.cachedVersion;
    try {
      const { version } = await fetchLatestBaileysVersion();
      this.cachedVersion = version;
      return version;
    } catch {
      this.cachedVersion = [...FALLBACK_WA_VERSION];
      return this.cachedVersion;
    }
  }

  private wire(sock: WASocket): void {
    sock.ev.on('connection.update', update => {
      void this.onConnectionUpdate(sock, update).catch(() => {});
    });
    sock.ev.on('creds.update', () => {
      void this.auth?.persist().catch(() => {});
    });
    sock.ev.on('messages.upsert', ({ messages }) => {
      const mapped: Record<string, unknown>[] = [];
      for (const message of messages) {
        if (message.key?.remoteJid) {
          mapped.push(mapMessage(message));
          this.broadcast({ type: 'message', data: mapped[mapped.length - 1] });
        }
      }
      if (mapped.length > 0) {
        void this.appendHistory(mapped).catch(() => {});
      }
      for (const message of mapped) {
        void this.pushInboundWebhook(message).catch(() => {});
      }
    });
  }

  /** Persist the last HISTORY_LIMIT messages so a (re)loading UI can render chat history. */
  private async appendHistory(messages: Record<string, unknown>[]): Promise<void> {
    const buf =
      this.historyBuf ?? ((await this.ctx.storage.get<Record<string, unknown>[]>('history')) ?? []);
    this.historyBuf = buf;
    buf.push(...messages);
    const trimmed = buf.length > HISTORY_LIMIT ? buf.slice(-HISTORY_LIMIT) : buf;
    await this.ctx.storage.put('history', trimmed);
  }

  /**
   * Fire-and-forget delivery of inbound messages to an optional external webhook.
   * Deliberately generic: filters only self-messages, protocol/system noise and
   * broadcast/newsletter/status jids; every consumer decides what to do with the rest.
   */
  private async pushInboundWebhook(message: Record<string, unknown>): Promise<void> {
    const url = this.env.INBOUND_WEBHOOK_URL;
    if (!url) return;
    if (message.fromMe) return;
    const chatId = String(message.chatId ?? '');
    if (/(@broadcast|@newsletter|@status)/.test(chatId)) return;
    if (String(message.type ?? '') === 'protocolMessage') return;
    const headers: Record<string, string> = { 'content-type': 'application/json' };
    const token = this.env.INBOUND_WEBHOOK_TOKEN;
    if (token) headers.authorization = `Bearer ${token}`;
    await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        session: this.ctx.id.name,
        at: new Date().toISOString(),
        message,
      }),
    });
  }

  private async onConnectionUpdate(
    sock: WASocket,
    update: BaileysEventMap['connection.update'],
  ): Promise<void> {
    const status = await this.getStatus();
    const { qr, connection, lastDisconnect, isNewLogin } = update;

    if (qr) {
      status.status = 'qr';
      status.qr = qr;
    }
    if (connection === 'open' || isNewLogin) {
      status.status = 'connected';
      status.qr = undefined;
      this.reconnectAttempts = 0;
      if (sock.user) {
        status.me = { id: sock.user.id, name: sock.user.name };
      }
    }
    if (connection === 'close') {
      const code = lastDisconnectCode(lastDisconnect?.error);
      status.lastDisconnect = {
        code,
        message: lastDisconnect?.error?.message,
        at: new Date().toISOString(),
      };
      if (code === DisconnectReason.loggedOut || code === DisconnectReason.forbidden) {
        status.status = 'loggedOut';
        status.qr = undefined;
      } else if (this.intentionalClose) {
        status.status = 'closed';
      } else {
        status.status = 'closed';
        this.scheduleReconnect();
      }
    }

    await this.persistStatus(status);
    this.broadcast({
      type: 'connection.update',
      data: { id: this.ctx.id.name, status: status.status, qr: status.qr },
    });
  }

  // --- commands ---------------------------------------------------------------

  private async sendText(chatId: string, text: string): Promise<Record<string, unknown>> {
    await this.ensureConnected();
    const sock = this.sock;
    if (!sock?.ws.isOpen) {
      throw new Error('session is not connected — start it first');
    }
    const sent = await sock.sendMessage(chatId, { text });
    return {
      id: sent?.key?.id ?? null,
      chatId,
      timestamp: new Date().toISOString(),
    };
  }

  private async logout(): Promise<void> {
    this.intentionalClose = true;
    const sock = this.sock;
    if (sock) {
      try {
        await sock.logout();
      } catch {
        // already closed or never connected
      }
    }
    this.sock = undefined;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = undefined;
    }
    this.reconnectAttempts = 0;
    await this.ctx.storage.deleteAlarm();
    await this.getAuth().then(auth => auth.clear());
    this.statusCache = { status: 'loggedOut', updatedAt: new Date().toISOString() };
    await this.ctx.storage.put('status', this.statusCache);
    this.broadcast({ type: 'connection.update', data: { id: this.ctx.id.name, status: 'loggedOut' } });
  }

  // --- reconnection & alarm -----------------------------------------------------

  private scheduleReconnect(): void {
    if (this.reconnectTimer) return;
    const delay = Math.min(MAX_RECONNECT_DELAY_MS, BASE_RECONNECT_DELAY_MS * 2 ** this.reconnectAttempts);
    this.reconnectAttempts += 1;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = undefined;
      void this.ensureConnected().catch(() => {});
    }, delay);
  }

  private async armAlarm(): Promise<void> {
    if (this.alarmsArmed) return;
    this.alarmsArmed = true;
    await this.ctx.storage.setAlarm(Date.now() + ALARM_INTERVAL_MS);
  }

  /** Fires while resident (reconnect if the socket died) or wakes an evicted DO (reconnect). */
  async alarm(): Promise<void> {
    await this.ensureConnected().catch(() => {});
    await this.ctx.storage.setAlarm(Date.now() + ALARM_INTERVAL_MS);
  }

  // --- UI event stream ------------------------------------------------------------

  private handleEventsUpgrade(request: Request): Response {
    if (request.headers.get('Upgrade') !== 'websocket') {
      return error('expected Upgrade: websocket', 426);
    }
    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);
    this.ctx.acceptWebSocket(server);
    // Greet the fresh client with the current status so the UI can render immediately.
    void this.getStatus()
      .then(status =>
        server.send(JSON.stringify({ type: 'connection.update', data: { id: this.ctx.id.name, ...status } })),
      )
      .catch(() => {});
    return new Response(null, { status: 101, webSocket: client });
  }

  /** A message from a UI socket wakes an evicted DO — use it to reconnect and re-arm. */
  async webSocketMessage(_ws: WebSocket, _message: ArrayBuffer | string): Promise<void> {
    void this.ensureConnected().catch(() => {});
  }

  async webSocketClose(_ws: WebSocket, _code: number, _reason: string, _wasClean: boolean): Promise<void> {
    // Nothing to clean up: hibernation sockets are tracked by the runtime.
  }

  private broadcast(payload: unknown): void {
    const message = JSON.stringify(payload);
    for (const ws of this.ctx.getWebSockets()) {
      try {
        ws.send(message);
      } catch {
        // a dying socket must not break the loop
      }
    }
  }

  // --- status persistence -----------------------------------------------------------

  private async getStatus(): Promise<SessionStatus> {
    if (!this.statusCache) {
      this.statusCache =
        (await this.ctx.storage.get<SessionStatus>('status')) ?? {
          status: 'new',
          updatedAt: new Date().toISOString(),
        };
    }
    return this.statusCache;
  }

  private async persistStatus(status: SessionStatus): Promise<void> {
    status.updatedAt = new Date().toISOString();
    this.statusCache = status;
    await this.ctx.storage.put('status', status);
  }
}