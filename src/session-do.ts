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
import { normalizeSequences, pruneAcked, selectMessages, type StoredMessage } from './messages';
import type { Env } from './env';

const DEFAULT_IDLE_TTL_MS = 60_000; // connected window per wake; the /idle route closes sooner
const PAIRING_TTL_MULTIPLIER = 5; // Start gets a longer window so the QR can be scanned
const DEFAULT_DAILY_WAKE_LIMIT = 300; // ~288 polls/day at 5-min cadence; 0 disables the cap
const DEFAULT_WAIT_MS = 15_000;
const MAX_WAIT_MS = 20_000;
const DEFAULT_MESSAGE_LIMIT = 100;
const MAX_MESSAGE_LIMIT = 200;
const BASE_RECONNECT_DELAY_MS = 2_000;
const MAX_RECONNECT_DELAY_MS = 60_000;
const FALLBACK_WA_VERSION = [2, 3000, 0] as const;
const HISTORY_LIMIT = 200; // most recent unacked messages kept per session (storage key 'history')

export type SessionStatusName = 'new' | 'connecting' | 'qr' | 'connected' | 'idle' | 'closed' | 'loggedOut';

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

/** `?wait=` for /wake: how long to hold the request until the socket is open. */
function clampWait(raw: string | null): number {
  const value = Number(raw);
  if (!Number.isFinite(value) || value <= 0) return DEFAULT_WAIT_MS;
  return Math.min(Math.max(Math.floor(value), 0), MAX_WAIT_MS);
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
 * message cursor. UI clients subscribe to `GET /events` (WebSocket upgrade) and receive a JSON
 * event stream (`connection.update` + `message` events).
 *
 * Lazy mode (free-tier posture): nobody holds the socket open. `/wake`, `/start` and `/send-text`
 * open a short window (`IDLE_TTL_MS`), the puller drains with `GET /messages?after=`, and
 * `POST /ack` + `POST /idle` close it again. There is no recurring alarm. WhatsApp queues messages
 * while offline and delivers them on the next wake, so latency is bounded by the poll cadence
 * instead of burning Durable Object Duration 24/7.
 */
export class WhatsAppSession extends DurableObject<Env> {
  private sock?: WASocket;
  private auth?: DurableObjectAuthState;
  private connecting?: Promise<void>;
  private reconnectTimer?: ReturnType<typeof setTimeout>;
  private reconnectAttempts = 0;
  private intentionalClose = false;
  private idleTimer?: ReturnType<typeof setTimeout>;
  private activeUntil = 0;
  private cachedVersion?: [number, number, number];
  private statusCache?: SessionStatus;
  private historyBuf?: StoredMessage[];

  async fetch(request: Request): Promise<Response> {
    // The worker forwards /api/sessions/:id/:action RAW to this DO — preserving the WS
    // Upgrade headers for /events — so the pathname arrives with the /api/sessions/:id
    // prefix. Route on the last path segment instead of the full path; that matches both
    // raw-forwarded requests and the worker's own constructed stub URLs (/status, /qr, ...).
    const url = new URL(request.url);
    const segments = url.pathname.replace(/\/+$/, '').split('/').filter(Boolean);
    const action = segments[segments.length - 1] ?? '';
    try {
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
        const history = (await this.ctx.storage.get<StoredMessage[]>('history')) ?? [];
        return json({ id: this.ctx.id.name, messages: history.slice().reverse() });
      }
      // Lazy mode: connect for one drain window, then close. See /idle and /ack?close=1.
      if (request.method === 'POST' && action === 'wake') {
        const wait = clampWait(url.searchParams.get('wait'));
        const budget = await this.bumpWake(!this.sock?.ws.isOpen);
        if (!budget.allowed) return this.wakeLimitError(budget);
        await this.activate();
        await this.markConnecting();
        await this.ensureConnected();
        if (wait > 0) await this.waitForOpen(wait);
        return json({ id: this.ctx.id.name, ...(await this.getStatus()), wake: budget });
      }
      // Cursor API for Apps Script / any puller. Returns oldest-first, each message carrying `seq`.
      if (request.method === 'GET' && action === 'messages') {
        const after = Math.max(0, Math.floor(Number(url.searchParams.get('after')) || 0));
        const limitRaw = Math.floor(Number(url.searchParams.get('limit')) || DEFAULT_MESSAGE_LIMIT);
        const limit = Math.min(Math.max(limitRaw, 1), MAX_MESSAGE_LIMIT);
        return json(await this.listMessages(after, limit));
      }
      if (request.method === 'POST' && action === 'ack') {
        const body = (await request.json().catch(() => null)) as { upto?: number; close?: boolean } | null;
        const fromQuery = Number(url.searchParams.get('upto'));
        const upto = Number(body?.upto ?? (Number.isFinite(fromQuery) ? fromQuery : NaN));
        if (!Number.isFinite(upto) || upto < 0) {
          return error('upto is required (non-negative integer)', 400);
        }
        const result = await this.ackMessages(Math.floor(upto));
        const close = body?.close === true || url.searchParams.get('close') === '1';
        if (close) await this.goIdle();
        return json(result);
      }
      // Close the socket now instead of waiting for the idle timer — keeps free-tier duration low.
      if (request.method === 'POST' && action === 'idle') {
        await this.goIdle();
        return json({ id: this.ctx.id.name, ...(await this.getStatus()) });
      }
      if (request.method === 'POST' && action === 'start') {
        const budget = await this.bumpWake(!this.sock?.ws.isOpen);
        if (!budget.allowed) return this.wakeLimitError(budget);
        const status = await this.getStatus();
        const pairing = status.status !== 'connected';
        await this.activate(pairing ? this.idleTtlMs * PAIRING_TTL_MULTIPLIER : this.idleTtlMs);
        await this.markConnecting();
        await this.ensureConnected();
        return json({ id: this.ctx.id.name, ...(await this.getStatus()), wake: budget });
      }
      if (request.method === 'POST' && action === 'send-text') {
        const body = (await request.json().catch(() => null)) as {
          chatId?: string;
          text?: string;
        } | null;
        if (!body?.chatId || typeof body.text !== 'string') {
          return error('chatId and text are required', 400);
        }
        // Sending opens a window too, so it counts against the same budget when it has to connect.
        const budget = await this.bumpWake(!this.sock?.ws.isOpen);
        if (!budget.allowed) return this.wakeLimitError(budget);
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

  private get idleTtlMs(): number {
    const raw = Number(this.env.IDLE_TTL_MS);
    if (!Number.isFinite(raw) || raw < 5_000) return DEFAULT_IDLE_TTL_MS;
    return Math.min(Math.floor(raw), 15 * 60_000);
  }

  private get dailyWakeLimit(): number {
    const raw = Number(this.env.DAILY_WAKE_LIMIT);
    if (!Number.isFinite(raw) || raw < 0) return DEFAULT_DAILY_WAKE_LIMIT;
    return Math.floor(raw);
  }

  /** Surface intent in /status immediately — baileys only emits qr/connected after its handshake. */
  private async markConnecting(): Promise<void> {
    const status = await this.getStatus();
    if (status.status !== 'new' && status.status !== 'idle' && status.status !== 'closed') return;
    status.status = 'connecting';
    status.qr = undefined;
    await this.persistStatus(status);
    this.broadcast({ type: 'connection.update', data: { id: this.ctx.id.name, status: 'connecting' } });
  }

  /**
   * Arm (or extend) the connected window. This is the only thing that keeps the socket alive:
   * a wake/start/send sets a timer, and when it fires the DO closes the socket and goes idle.
   * There is no recurring alarm and no reconnect outside an active window — that is what keeps
   * free-tier Duration (13,000 GB-s/day) in reach for several sessions.
   */
  private async activate(ttlMs = this.idleTtlMs): Promise<void> {
    this.activeUntil = Date.now() + ttlMs;
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = setTimeout(() => {
      void this.goIdle().catch(() => {});
    }, ttlMs);
  }

  /** Close the socket and park the session. Safe to call when already idle. */
  private async goIdle(): Promise<void> {
    this.activeUntil = 0;
    if (this.idleTimer) {
      clearTimeout(this.idleTimer);
      this.idleTimer = undefined;
    }
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = undefined;
    }
    this.intentionalClose = true;
    const sock = this.sock;
    this.sock = undefined;
    if (sock) {
      try {
        sock.end(undefined);
      } catch {
        // already closed
      }
      try {
        sock.ws.close();
      } catch {
        // already closed
      }
    }
    const status = await this.getStatus();
    if (status.status !== 'loggedOut') {
      status.status = 'idle';
      status.qr = undefined;
      await this.persistStatus(status);
    }
    this.broadcast({ type: 'connection.update', data: { id: this.ctx.id.name, status: 'idle' } });
  }

  /** Count one connect attempt against the per-UTC-day budget (eviction-proof; no duration math). */
  private async bumpWake(count = true): Promise<{
    allowed: boolean;
    used: number;
    limit: number;
    date: string;
    counted: boolean;
  }> {
    const date = new Date().toISOString().slice(0, 10);
    const limit = this.dailyWakeLimit;
    if (limit === 0) return { allowed: true, used: 0, limit, date, counted: false };
    const stored = (await this.ctx.storage.get<{ date: string; count: number }>('wakes')) ?? {
      date,
      count: 0,
    };
    const used = stored.date === date ? stored.count : 0;
    if (!count) {
      // Already connected: waking only extends the window, so it must not eat the budget.
      return { allowed: true, used, limit, date, counted: false };
    }
    if (used >= limit) return { allowed: false, used, limit, date, counted: false };
    await this.ctx.storage.put('wakes', { date, count: used + 1 });
    return { allowed: true, used: used + 1, limit, date, counted: true };
  }

  private wakeLimitError(budget: { used: number; limit: number }): Response {
    return error(
      `daily wake limit reached (${budget.used}/${budget.limit}); resets at 00:00 UTC — ` +
        'raise DAILY_WAKE_LIMIT or lower the poll frequency',
      429,
    );
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
      void this.handleIncoming(messages).catch(() => {});
    });
  }

  /**
   * Persist first, then broadcast: the stored copy carries `seq`, so the live UI stream and
   * the Apps Script cursor see the same message ids and ordering.
   */
  private async handleIncoming(messages: WAMessage[]): Promise<void> {
    const mapped: Record<string, unknown>[] = [];
    for (const message of messages) {
      if (message.key?.remoteJid) mapped.push(mapMessage(message));
    }
    if (mapped.length === 0) return;
    const stored = await this.appendHistory(mapped);
    for (const message of stored) {
      this.broadcast({ type: 'message', data: message });
      void this.pushInboundWebhook(message).catch(() => {});
    }
  }

  /**
   * Persist messages with a monotonic per-session `seq` (the drain cursor) and return the stored
   * copies. Unacked messages are capped at HISTORY_LIMIT; a client that falls further behind than
   * the cap can recover via the `oldestSeq` returned by GET /messages.
   */
  private async appendHistory(messages: Record<string, unknown>[]): Promise<StoredMessage[]> {
    const snapshot = await this.ctx.storage.get<unknown>(['history', 'msgSeq']);
    const storedBuf = (snapshot.get('history') as StoredMessage[] | undefined) ?? [];
    const normalized = normalizeSequences(
      this.historyBuf ?? storedBuf,
      Number(snapshot.get('msgSeq') ?? 0),
    );
    const buf = normalized.rows;
    let seq = normalized.maxSeq;
    const added = messages.map(message => ({ ...message, seq: ++seq }));
    buf.push(...added);
    const trimmed = buf.length > HISTORY_LIMIT ? buf.slice(-HISTORY_LIMIT) : buf;
    this.historyBuf = trimmed;
    await this.ctx.storage.put({ history: trimmed, msgSeq: seq });
    return added;
  }

  /** Keyset pull: messages with seq > after, oldest first. `nextCursor` never goes backwards. */
  private async listMessages(after: number, limit: number): Promise<Record<string, unknown>> {
    const snapshot = await this.ctx.storage.get<unknown>(['history', 'msgSeq']);
    const rawHistory = (snapshot.get('history') as StoredMessage[] | undefined) ?? [];
    const msgSeq = Number(snapshot.get('msgSeq') ?? 0);
    const normalized = normalizeSequences(rawHistory, msgSeq);
    if (normalized.changed) {
      // One-time migration for sessions created before the cursor API existed.
      this.historyBuf = normalized.rows;
      await this.ctx.storage.put({ history: normalized.rows, msgSeq: normalized.maxSeq });
    }
    return { id: this.ctx.id.name, ...selectMessages(normalized.rows, normalized.maxSeq, after, limit) };
  }

  /** Drop messages at or below `upto`. Apps Script calls this only after the rows hit the sheet. */
  private async ackMessages(upto: number): Promise<Record<string, unknown>> {
    const snapshot = await this.ctx.storage.get<unknown>(['history', 'msgSeq']);
    const stored = (snapshot.get('history') as StoredMessage[] | undefined) ?? [];
    const normalized = normalizeSequences(stored, Number(snapshot.get('msgSeq') ?? 0));
    const remaining = pruneAcked(normalized.rows, upto);
    if (normalized.changed || remaining.length !== stored.length) {
      await this.ctx.storage.put('history', remaining);
    }
    this.historyBuf = remaining;
    return {
      id: this.ctx.id.name,
      upto,
      acked: stored.length - remaining.length,
      remaining: remaining.length,
    };
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
    // A replaced socket must not write status or schedule reconnects — /idle clears this.sock
    // before closing, so the resulting close event arrives here as a stale one.
    if (update.connection === 'close' && sock !== this.sock) return;

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
        status.status = 'idle';
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

  /**
   * Wait until the current socket is genuinely open, or until the deadline.
   * ensureConnected() resolves as soon as a socket exists — after a DO wake the
   * connection can still be establishing, and sends started too early fail or
   * hit a half-dead socket ("All encryptions failed").
   */
  private async waitForOpen(deadlineMs = 20_000): Promise<boolean> {
    const started = Date.now();
    while (Date.now() - started < deadlineMs) {
      if (this.sock?.ws.isOpen) return true;
      await new Promise(resolve => setTimeout(resolve, 250));
    }
    return Boolean(this.sock?.ws.isOpen);
  }

  private async sendText(chatId: string, text: string): Promise<Record<string, unknown>> {
    // Sending is a wake: hold the socket for at least one idle window while we send.
    await this.activate();
    await this.markConnecting();
    for (let attempt = 1; attempt <= 2; attempt += 1) {
      await this.ensureConnected();
      if (!(await this.waitForOpen())) {
        throw new Error('session is not connected — start it first');
      }
      const sock = this.sock;
      if (!sock) throw new Error('session is not connected — start it first');
      try {
        const sent = await sock.sendMessage(chatId, { text });
        return {
          id: sent?.key?.id ?? null,
          chatId,
          timestamp: new Date().toISOString(),
        };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        const retryable =
          /encrypt|stream errored|restart required|connection terminated|timed\s*out|closed|not connected/i.test(
            message,
          );
        if (attempt === 2 || !retryable) throw err;
        // The socket reported open but its stream was dead (a long-resident DO
        // can outlive a "Stream Errored"). Tear it down and reconnect once — a
        // fresh socket fixes stale-signal failures like "All encryptions failed".
        if (sock === this.sock) {
          this.sock = undefined;
          try {
            sock.ws.close();
          } catch {
            // already closed
          }
        }
        await new Promise(resolve => setTimeout(resolve, 1_000));
      }
    }
    throw new Error('send failed');
  }

  private async logout(): Promise<void> {
    this.intentionalClose = true;
    this.activeUntil = 0;
    if (this.idleTimer) {
      clearTimeout(this.idleTimer);
      this.idleTimer = undefined;
    }
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

  // --- connectivity -------------------------------------------------------------

  /**
   * Retry only inside an active window. Lazy mode never reconnects on its own: once the idle
   * window expires (or /idle is called), the next wake is what brings the socket back.
   */
  private scheduleReconnect(): void {
    if (this.reconnectTimer) return;
    if (Date.now() >= this.activeUntil) return;
    const delay = Math.min(MAX_RECONNECT_DELAY_MS, BASE_RECONNECT_DELAY_MS * 2 ** this.reconnectAttempts);
    this.reconnectAttempts += 1;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = undefined;
      if (Date.now() >= this.activeUntil) return;
      void this.ensureConnected().catch(() => {});
    }, delay);
  }

  /**
   * Migration tombstone: earlier versions armed a 2-minute reconnect alarm on every request.
   * Alarms are the expensive part of an always-on session, so lazy mode deletes any pending
   * one and never re-arms it.
   */
  async alarm(): Promise<void> {
    await this.ctx.storage.deleteAlarm();
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

  /** Lazy mode: UI socket traffic must not wake or extend the WhatsApp connection. */
  async webSocketMessage(_ws: WebSocket, _message: ArrayBuffer | string): Promise<void> {
    // intentionally empty — only /wake, /start and /send-text bring the socket up
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