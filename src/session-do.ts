import { DurableObject } from 'cloudflare:workers';
import protobuf from 'protobufjs/minimal';
import qrcode from './qrcode';
import {
  Browsers,
  DisconnectReason,
  downloadMediaMessage,
  fetchLatestBaileysVersion,
  makeWASocket,
  proto,
  type AuthenticationState,
  type BaileysEventMap,
  type WAMessage,
  type WASocket,
} from '@whiskeysockets/baileys';
import { DurableObjectAuthState } from './auth-state';
import { createWorkerLogger } from './logger';
import { error, json } from './http';
import { normalizeSequences, pruneAcked, selectMessages, type StoredMessage } from './messages';
import {
  DEFAULT_AUTO_REPLY_COOLDOWN,
  DEFAULT_AUTO_REPLY_DAILY,
  normalizeSettings,
  publicSettings,
  resolveAi,
  validCustomModel,
  validModel,
  type AutoReplySettings,
  type SessionSettings,
} from './settings';
import { callOpenAiChat, type ChatMessage } from './ai';
import type { Env } from './env';

// protobufjs picks its Node Buffer writer when `Buffer` exists. On workerd that writer's
// `Buffer#utf8Write` rejects long strings (media messages carry a ~650 byte directPath), so
// documents failed with "All encryptions failed" while short text messages went through.
// Force the pure-JS Uint8Array writer instead: same bytes, no Buffer internals.
protobuf.Writer.create = function createWriter() {
  return new protobuf.Writer();
};

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
const MAX_DOCUMENT_BYTES = 8 * 1024 * 1024; // Apps Script relays statements as base64; keep the DO memory bounded
const HISTORY_LIMIT = 200; // most recent unacked messages kept per session (storage key 'history')
const CHAT_NAMES_TTL_MS = 6 * 60 * 60 * 1000; // refresh group subjects at most every 6 h
const CHAT_NAMES_TIMEOUT_MS = 15_000; // groupFetchAllParticipating can hang on a stale socket
const AI_CONTEXT_MESSAGES = 30; // messages handed to the model as context
const DEFAULT_AI_MODEL = '@cf/meta/llama-4-scout-17b-16e-instruct';
const MEDIA_TYPES = new Set([
  'imageMessage',
  'videoMessage',
  'audioMessage',
  'documentMessage',
  'stickerMessage',
]);
const MAX_MEDIA_BYTES = 20 * 1024 * 1024; // don't pull huge videos through a 128 MB DO
const THUMBNAIL_LIMIT_BYTES = 64 * 1024;

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

/** Reject a socket query that never answers, so a stale link cannot pin the DO. */
function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timed out after ${ms} ms`)), ms);
    promise.then(
      value => {
        clearTimeout(timer);
        resolve(value);
      },
      error => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

/**
 * Strict base64 → bytes. Apps Script always sends padded standard base64, but tolerate
 * whitespace/newlines and the URL-safe alphabet so a hand-written curl still works.
 * Returns null for input that is not decodable.
 */
function decodeBase64Document(raw: string): Uint8Array | null {
  const cleaned = raw.replace(/\s+/g, '').replace(/-/g, '+').replace(/_/g, '/');
  if (!cleaned || !/^[A-Za-z0-9+/]+={0,2}$/.test(cleaned)) return null;
  const padded = cleaned + '='.repeat((4 - (cleaned.length % 4)) % 4);
  try {
    const binary = atob(padded);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
    return bytes;
  } catch {
    return null;
  }
}

/**
 * Render the pairing QR as a GIF data URL in the worker, so Apps Script, the web app and
 * Android can all display it without shipping a QR library or exposing the worker token.
 */
function qrImageFor(text: string): string | undefined {
  if (!text) return undefined;
  try {
    const qr = qrcode(0, 'M');
    qr.addData(text);
    qr.make();
    return qr.createDataURL(6, 4);
  } catch {
    return undefined;
  }
}

/** Workers AI answers come back as { response } (older models) or a plain string. */
function extractAiText(answer: unknown): string {
  if (typeof answer === 'string') return answer.trim();
  if (answer && typeof answer === 'object') {
    const record = answer as Record<string, unknown>;
    const value = record.response ?? record.text ?? record.result;
    if (typeof value === 'string') return value.trim();
  }
  return '';
}

/** A thumbnail small enough for DO storage and WebSocket frames. */
function thumbDataUrl(value: unknown): string | undefined {
  const bytes = toBytes(value);
  if (!bytes || bytes.length === 0 || bytes.length > THUMBNAIL_LIMIT_BYTES) return undefined;
  return `data:image/jpeg;base64,${bytesToBase64(bytes)}`;
}

function toBytes(value: unknown): Uint8Array | undefined {
  if (value instanceof Uint8Array) return value;
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  if (value && typeof value === 'object') {
    const record = value as { type?: string; data?: unknown };
    if (record.type === 'Buffer' && Array.isArray(record.data)) {
      return new Uint8Array(record.data as number[]);
    }
  }
  return undefined;
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

/** protobuf Long fields arrive as objects, not numbers. */
function toNumber(value: unknown): number | undefined {
  if (typeof value === 'number') return Number.isFinite(value) ? value : undefined;
  if (value && typeof value === 'object' && 'toNumber' in value) {
    const n = (value as { toNumber: () => number }).toNumber();
    return Number.isFinite(n) ? n : undefined;
  }
  if (typeof value === 'string') {
    const n = Number(value);
    return Number.isFinite(n) ? n : undefined;
  }
  return undefined;
}

/** WhatsApp may already ship an Open Graph card with the message; reuse it. */
function linkPreviewFor(content: proto.IMessage): Record<string, unknown> | undefined {
  const ext = content.extendedTextMessage;
  if (!ext) return undefined;
  const url = (ext.matchedText || '').trim();
  const title = ext.title?.trim();
  const description = ext.description?.trim();
  const thumbnail = thumbDataUrl(ext.jpegThumbnail);
  if (!url || (!title && !description && !thumbnail)) return undefined;
  return { url, title, description, thumbnail };
}

function mediaFor(
  type: string,
  content: proto.IMessage,
): Record<string, unknown> | undefined {
  if (!MEDIA_TYPES.has(type)) return undefined;
  const raw = (content as Record<string, unknown>)[type] as Record<string, unknown> | undefined;
  if (!raw) return undefined;
  const mimetype = typeof raw.mimetype === 'string' ? raw.mimetype : undefined;
  const fileName = typeof raw.fileName === 'string' ? raw.fileName : undefined;
  const fileLength = toNumber(raw.fileLength);
  const seconds = toNumber(raw.seconds);
  const width = toNumber(raw.width);
  const height = toNumber(raw.height);
  const ptt = raw.ptt === true;
  return {
    mimetype,
    fileName,
    fileLength,
    seconds,
    width,
    height,
    ptt,
    thumbnail: thumbDataUrl(raw.jpegThumbnail),
  };
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
  const type = Object.keys(content)[0] ?? 'unknown';
  const timestamp =
    m.messageTimestamp === undefined
      ? undefined
      : new Date(Number(m.messageTimestamp) * 1000).toISOString();
  const preview = linkPreviewFor(content);
  const media = mediaFor(type, content);
  return {
    id: m.key?.id,
    chatId: m.key?.remoteJid,
    fromMe: m.key?.fromMe ?? false,
    sender: m.key?.participant ?? m.key?.remoteJid,
    pushName: m.pushName,
    timestamp,
    type,
    text,
    ...(preview ? { preview } : {}),
    ...(media ? { media } : {}),
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
  /** Group subjects (jid → name), cached in storage so groups survive idle windows. */
  private chatNamesCache?: { at: string; names: Record<string, string> };
  private fetchingChatNames = false;
  /** AI / auto-reply settings, cached after the first read. */
  private settingsCache?: SessionSettings;
  /**
   * True only after Baileys emits `connection: open`. The raw WebSocket being open is not
   * enough: the Noise handshake still has to finish, and sending into that window fails with
   * "Network connection lost" (notably on the first send after a cold wake).
   */
  private connected = false;

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
        const status = await this.getStatus();
        return json({
          id: this.ctx.id.name,
          ...status,
          ...(status.qr ? { qrImage: qrImageFor(status.qr) } : {}),
        });
      }
      if (request.method === 'GET' && action === 'qr') {
        const status = await this.getStatus();
        return json({
          id: this.ctx.id.name,
          status: status.status,
          qr: status.qr,
          ...(status.qr ? { qrImage: qrImageFor(status.qr) } : {}),
        });
      }
      if (request.method === 'GET' && action === 'history') {
        const history = (await this.ctx.storage.get<StoredMessage[]>('history')) ?? [];
        return json({
          id: this.ctx.id.name,
          messages: history.slice().reverse(),
          // Group subjects, so the UI can show "Family" instead of "Group · 750265".
          groups: await this.readChatNames(),
        });
      }
      // Per-session AI / auto-reply configuration. The API key is write-only: GET returns
      // `hasApiKey` and a masked hint, never the value.
      if (request.method === 'GET' && action === 'settings') {
        return json({
          id: this.ctx.id.name,
          settings: publicSettings(await this.readSettings()),
          defaults: this.settingsDefaults(),
        });
      }
      if (request.method === 'POST' && action === 'settings') {
        const body = (await request.json().catch(() => null)) as Partial<SessionSettings> | null;
        if (!body || typeof body !== 'object') return error('invalid JSON body', 400);
        const settings = await this.writeSettings(body);
        return json({ id: this.ctx.id.name, settings: publicSettings(settings), defaults: this.settingsDefaults() });
      }
      // On-demand media download. The raw protobuf is tiny; the bytes are fetched from WhatsApp.
      if (request.method === 'GET' && action === 'media') {
        return await this.getMedia(
          url.searchParams.get('id') ?? '',
          url.searchParams.get('download') === '1',
        );
      }
      // Local counters for the free-tier panel: wake budget per session plus the window length.
      if (request.method === 'GET' && action === 'usage') {
        const budget = await this.readWakeBudget();
        return json({
          id: this.ctx.id.name,
          status: (await this.getStatus()).status,
          idleTtlMs: this.idleTtlMs,
          wakes: {
            used: budget.used,
            limit: budget.limit,
            remaining: budget.limit > 0 ? Math.max(0, budget.limit - budget.used) : 0,
            limited: budget.limit > 0,
          },
        });
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
      // Documents (PDF/XLSX statements) travel as base64 so no R2 bucket is required.
      if (request.method === 'POST' && action === 'send-document') {
        const body = (await request.json().catch(() => null)) as {
          chatId?: string;
          base64?: string;
          fileName?: string;
          mimetype?: string;
          caption?: string;
        } | null;
        if (!body?.chatId || typeof body.base64 !== 'string' || !body.fileName) {
          return error('chatId, base64 and fileName are required', 400);
        }
        const buffer = decodeBase64Document(body.base64);
        if (!buffer) return error('base64 is not valid base64', 400);
        if (buffer.length === 0) return error('document is empty', 400);
        if (buffer.length > MAX_DOCUMENT_BYTES) {
          return error(`document is too large (max ${MAX_DOCUMENT_BYTES} bytes)`, 413);
        }
        const budget = await this.bumpWake(!this.sock?.ws.isOpen);
        if (!budget.allowed) return this.wakeLimitError(budget);
        return json(
          await this.sendDocument(body.chatId, {
            data: buffer,
            fileName: body.fileName,
            mimetype: body.mimetype || 'application/octet-stream',
            caption: typeof body.caption === 'string' ? body.caption : '',
          }),
        );
      }
      if (request.method === 'POST' && action === 'logout') {
        await this.logout();
        return json({ ok: true, id: this.ctx.id.name });
      }
      // AI assist: draft a reply for one chat from its stored history. Never sends anything.
      if (request.method === 'POST' && action === 'ai') {
        const body = (await request.json().catch(() => null)) as {
          chatId?: string;
          mode?: string;
          instruction?: string;
        } | null;
        if (!body?.chatId || typeof body.chatId !== 'string') {
          return error('chatId is required', 400);
        }
        const mode = body.mode === 'summary' ? 'summary' : 'reply';
        return await this.draftWithAI(body.chatId, mode, body.instruction);
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
    this.connected = false;
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
    const { date, limit, used } = await this.readWakeBudget();
    if (limit === 0) return { allowed: true, used: 0, limit, date, counted: false };
    if (!count) {
      // Already connected: waking only extends the window, so it must not eat the budget.
      return { allowed: true, used, limit, date, counted: false };
    }
    if (used >= limit) return { allowed: false, used, limit, date, counted: false };
    await this.ctx.storage.put('wakes', { date, count: used + 1 });
    return { allowed: true, used: used + 1, limit, date, counted: true };
  }

  /** Read-only view of today's wake budget, for the free-tier panel. */
  private async readWakeBudget(): Promise<{ date: string; limit: number; used: number }> {
    const date = new Date().toISOString().slice(0, 10);
    const limit = this.dailyWakeLimit;
    if (limit === 0) return { date, limit, used: 0 };
    const stored = (await this.ctx.storage.get<{ date: string; count: number }>('wakes')) ?? {
      date,
      count: 0,
    };
    return { date, limit, used: stored.date === date ? stored.count : 0 };
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
    this.connected = false;
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
    const rawMedia: Record<string, unknown> = {};
    for (const message of messages) {
      if (!message.key?.remoteJid) continue;
      const row = mapMessage(message);
      mapped.push(row);
      const type = String(row.type ?? '');
      if (MEDIA_TYPES.has(type) && message.key.id && message.message) {
        try {
          rawMedia[`media:${message.key.id}`] = {
            key: { ...message.key },
            bytes: proto.Message.encode(message.message).finish(),
          };
        } catch {
          // Keep the mapped row even if the protobuf cannot be re-encoded.
        }
      }
    }
    if (mapped.length === 0) return;
    const stored = await this.appendHistory(mapped);
    if (Object.keys(rawMedia).length > 0) await this.ctx.storage.put(rawMedia);
    for (const message of stored) {
      this.broadcast({ type: 'message', data: message });
      void this.pushInboundWebhook(message).catch(() => {});
      void this.maybeAutoReply(message).catch(() => {});
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
    const overflow = Math.max(0, buf.length - HISTORY_LIMIT);
    const dropped = overflow > 0 ? buf.slice(0, overflow) : [];
    const trimmed = overflow > 0 ? buf.slice(overflow) : buf;
    this.historyBuf = trimmed;
    await this.ctx.storage.put({ history: trimmed, msgSeq: seq });
    if (dropped.length > 0) await this.deleteMedia(dropped);
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
    const pruned = normalized.rows.slice(0, normalized.rows.length - remaining.length);
    if (pruned.length > 0) await this.deleteMedia(pruned);
    return {
      id: this.ctx.id.name,
      upto,
      acked: stored.length - remaining.length,
      remaining: remaining.length,
    };
  }

  // --- chat names ---------------------------------------------------------------

  private async readChatNames(): Promise<Record<string, string>> {
    if (!this.chatNamesCache) {
      const stored = await this.ctx.storage.get<{ at: string; names: Record<string, string> }>(
        'chatNames',
      );
      if (stored) this.chatNamesCache = stored;
    }
    return this.chatNamesCache?.names ?? {};
  }

  /**
   * Fetch group subjects while the socket happens to be open and cache them in DO storage.
   * Lazy mode means the socket only exists for a minute at a time, so this is best-effort:
   * a failure keeps the previous names and the next wake tries again.
   */
  private async refreshChatNames(sock: WASocket): Promise<void> {
    if (this.fetchingChatNames || sock !== this.sock || !this.connected) return;
    await this.readChatNames();
    const at = this.chatNamesCache ? Date.parse(this.chatNamesCache.at) : 0;
    if (Number.isFinite(at) && Date.now() - at < CHAT_NAMES_TTL_MS) return;
    this.fetchingChatNames = true;
    try {
      const all = await withTimeout(
        sock.groupFetchAllParticipating(),
        CHAT_NAMES_TIMEOUT_MS,
      );
      const names: Record<string, string> = {};
      for (const [jid, meta] of Object.entries(all)) {
        const subject = (meta as { subject?: string }).subject?.trim();
        if (subject) names[jid] = subject;
      }
      if (Object.keys(names).length === 0) return;
      this.chatNamesCache = { at: new Date().toISOString(), names };
      await this.ctx.storage.put('chatNames', this.chatNamesCache);
      this.broadcast({ type: 'chat-names', data: names });
    } catch {
      // Stale socket or timeout — keep what we had and retry on a later wake.
    } finally {
      this.fetchingChatNames = false;
    }
  }

  // --- settings ------------------------------------------------------------------

  private settingsDefaults(): {
    provider: 'workers-ai' | 'openai';
    aiModel: string;
    autoReply: Required<Pick<AutoReplySettings, 'cooldownSeconds' | 'dailyLimit' | 'groups'>>;
  } {
    return {
      provider: 'workers-ai',
      aiModel: validModel(this.env.AI_MODEL) ?? DEFAULT_AI_MODEL,
      autoReply: {
        cooldownSeconds: DEFAULT_AUTO_REPLY_COOLDOWN,
        dailyLimit: DEFAULT_AUTO_REPLY_DAILY,
        groups: false,
      },
    };
  }

  private async readSettings(): Promise<SessionSettings> {
    if (!this.settingsCache) {
      this.settingsCache = (await this.ctx.storage.get<SessionSettings>('settings')) ?? {};
    }
    return this.settingsCache;
  }

  private async writeSettings(input: Partial<SessionSettings>): Promise<SessionSettings> {
    const current = await this.readSettings();
    const next = normalizeSettings(current, input);
    this.settingsCache = next;
    await this.ctx.storage.put('settings', next);
    return next;
  }

  // --- media ---------------------------------------------------------------------

  private async deleteMedia(rows: StoredMessage[]): Promise<void> {
    const keys = rows
      .map(row => (row.id ? `media:${String(row.id)}` : ''))
      .filter(Boolean);
    if (keys.length > 0) await this.ctx.storage.delete(keys);
  }

  /**
   * Fetch one media message from WhatsApp on demand. Only the encrypted protobuf is kept in
   * storage (a few hundred bytes); the bytes never sit in the DO unless someone asks for them.
   */
  private async getMedia(id: string, download: boolean): Promise<Response> {
    if (!id) return error('media id is required', 400);
    const raw = await this.ctx.storage.get<{ key: Record<string, unknown>; bytes: Uint8Array }>(
      `media:${id}`,
    );
    if (!raw) return error('media not found (it may have been pruned)', 404);

    let content: proto.IMessage;
    try {
      content = proto.Message.decode(raw.bytes);
    } catch {
      return error('stored media metadata is unreadable', 500);
    }
    const type = Object.keys(content)[0] ?? '';
    const media = mediaFor(type, content);
    const fileLength = typeof media?.fileLength === 'number' ? media.fileLength : undefined;
    if (fileLength && fileLength > MAX_MEDIA_BYTES) {
      return error('this file is too large to open in the browser (20 MB limit)', 413);
    }

    let buffer: Uint8Array;
    try {
      const message = { key: raw.key, message: content } as WAMessage;
      const result = await downloadMediaMessage(
        message,
        'buffer',
        {},
        {
          logger: createWorkerLogger(`wa:${this.ctx.id.name}`, this.logLevel),
          reuploadRequest: async msg => msg,
        },
      );
      buffer = result as Uint8Array;
    } catch (err) {
      return error(
        `media download failed: ${err instanceof Error ? err.message : String(err)}`,
        502,
      );
    }
    if (buffer.byteLength > MAX_MEDIA_BYTES) {
      return error('this file is too large to open in the browser (20 MB limit)', 413);
    }

    const mimetype = typeof media?.mimetype === 'string' ? media.mimetype : 'application/octet-stream';
    const fileName = typeof media?.fileName === 'string' && media.fileName
      ? media.fileName.replace(/[^\w.\- ()]/g, '_').slice(0, 120)
      : `${id}`;
    const headers = new Headers({
      'content-type': mimetype,
      'content-length': String(buffer.byteLength),
      'cache-control': 'private, max-age=3600',
      'content-disposition': `${download ? 'attachment' : 'inline'}; filename="${fileName}"`,
      'x-content-type-options': 'nosniff',
    });
    return new Response(buffer, { headers });
  }

  // --- AI assist -----------------------------------------------------------------

  /**
   * Draft a reply (or summarise) for one chat from its stored history using Workers AI.
   * Read-only: the draft goes back to the caller, which shows it in the composer. Nothing
   * is sent on the user's behalf.
   */
  private async draftWithAI(
    chatId: string,
    mode: 'reply' | 'summary',
    instruction?: string,
  ): Promise<Response> {
    try {
      const result = await this.runDraft(chatId, mode, instruction);
      return json({
        session: this.ctx.id.name,
        chatId,
        mode,
        model: result.model,
        messages: result.messages,
        draft: result.draft,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const status = message.includes('not enabled')
        ? 501
        : message.includes('no stored messages')
          ? 400
          : 502;
      return error(message, status);
    }
  }

  /** Shared prompt/context builder for manual drafts and auto-replies. Throws on failure. */
  private async runDraft(
    chatId: string,
    mode: 'reply' | 'summary',
    instruction?: string,
    modelOverride?: string,
  ): Promise<{ draft: string; model: string; messages: number }> {
    const ai = this.env.AI;
    if (!ai) throw new Error('Workers AI is not enabled for this worker (missing [ai] binding)');

    const history = (await this.ctx.storage.get<StoredMessage[]>('history')) ?? [];
    const thread = history
      .filter(message => message.chatId === chatId)
      .slice(-AI_CONTEXT_MESSAGES);
    if (thread.length === 0) throw new Error('no stored messages in this chat yet');

    const isGroup = chatId.endsWith('@g.us');
    const names = await this.readChatNames();
    const chatLabel = names[chatId] ?? (isGroup ? 'a WhatsApp group' : 'a WhatsApp contact');
    const transcript = thread
      .map(message => {
        const text = typeof message.text === 'string' ? message.text.trim() : '';
        const kind = String(message.type ?? 'message').replace(/Message$/, '') || 'media';
        const body = text || `(${kind})`;
        const who = message.fromMe ? 'Me' : String(message.pushName ?? message.sender ?? 'Them');
        return `${who}: ${body}`;
      })
      .join('\n');

    const system =
      mode === 'summary'
        ? 'You summarise WhatsApp conversations. Answer with 3-5 short bullet points covering what the other side wants, decisions, and open questions. No preamble.'
        : `You draft WhatsApp replies in the language of the conversation. The user is "Me"; the other side is a contact${isGroup ? ' in a group chat' : ''}. Write one short, natural reply that can be sent as-is. No quotes, no explanation, no "Me:" prefix.`;
    const prompt = [
      `Chat: ${chatLabel}`,
      instruction?.trim() ? `Extra instruction: ${instruction.trim()}` : '',
      'Transcript (oldest first):',
      transcript,
      mode === 'summary' ? 'Summarise the thread.' : 'Draft my next reply.',
    ]
      .filter(Boolean)
      .join('\n\n');

    const settings = await this.readSettings();
    const resolved = resolveAi(settings, this.env.AI_MODEL, DEFAULT_AI_MODEL);
    const messages: ChatMessage[] = [
      { role: 'system', content: system },
      { role: 'user', content: prompt },
    ];
    const maxTokens = mode === 'summary' ? 500 : 300;

    let draft: string;
    let model: string;
    if (resolved.provider === 'openai') {
      model = validCustomModel(modelOverride) ?? resolved.model ?? '';
      draft = await callOpenAiChat({
        baseUrl: resolved.baseUrl,
        apiKey: resolved.apiKey,
        model,
        messages,
        maxTokens,
        temperature: 0.4,
      });
    } else {
      if (!this.env.AI) {
        throw new Error('Workers AI is not enabled for this worker (missing [ai] binding)');
      }
      model = validModel(modelOverride) ?? resolved.model ?? DEFAULT_AI_MODEL;
      const answer = await this.env.AI.run(model, {
        messages,
        max_tokens: maxTokens,
        temperature: 0.4,
      });
      draft = extractAiText(answer);
      if (!draft) throw new Error('the model returned an empty answer');
    }

    return { draft, model, messages: thread.length };
  }

  /**
   * Opt-in auto-reply. Runs only inside a connected window, reserves a per-chat slot before
   * spending a Neural call, and skips groups unless explicitly enabled.
   */
  private async maybeAutoReply(message: StoredMessage): Promise<void> {
    const settings = await this.readSettings();
    const cfg = settings.autoReply;
    if (!cfg?.enabled || message.fromMe) return;
    const chatId = String(message.chatId ?? '');
    if (!chatId || /(@broadcast|@newsletter|@status)/.test(chatId)) return;
    if (chatId.endsWith('@g.us') && !cfg.groups) return;
    const text = String(message.text ?? '').trim();
    if (!text) return;
    if (!this.sock || !this.connected) return;

    const day = new Date().toISOString().slice(0, 10);
    const stateKey = `autoReply:${chatId}`;
    const state = (await this.ctx.storage.get<{ at: number; day: string; count: number }>(stateKey)) ?? {
      at: 0,
      day,
      count: 0,
    };
    const cooldown = (cfg.cooldownSeconds ?? DEFAULT_AUTO_REPLY_COOLDOWN) * 1000;
    if (Date.now() - state.at < cooldown) return;
    const usedToday = state.day === day ? state.count : 0;
    const dailyLimit = cfg.dailyLimit ?? DEFAULT_AUTO_REPLY_DAILY;
    if (usedToday >= dailyLimit) return;

    // Reserve before the model call so a burst cannot fan out into parallel replies.
    await this.ctx.storage.put(stateKey, { at: Date.now(), day, count: usedToday + 1 });
    await this.activate(); // drafting takes a few seconds; keep the socket open long enough

    const draft = await this.runDraft(chatId, 'reply', cfg.prompt ?? undefined, cfg.model ?? undefined).catch(
      () => null,
    );
    if (!draft) return;
    const sock = this.sock;
    if (!sock || !this.connected) return;
    try {
      const sent = await sock.sendMessage(chatId, { text: draft.draft });
      if (sent) {
        const [row] = await this.appendHistory([mapMessage(sent)]);
        if (row) this.broadcast({ type: 'message', data: row });
      }
    } catch {
      // A failed auto-reply must never surface as a request error; the owner still sees the message.
    }
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
      this.connected = true;
      this.reconnectAttempts = 0;
      if (sock.user) {
        status.me = { id: sock.user.id, name: sock.user.name };
      }
      // Group subjects are only available while the socket is up; cache them now.
      void this.refreshChatNames(sock).catch(() => {});
    }
    if (connection === 'close') {
      this.connected = false;
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
      if (this.connected && this.sock?.ws.isOpen) return true;
      await new Promise(resolve => setTimeout(resolve, 250));
    }
    return Boolean(this.connected && this.sock?.ws.isOpen);
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
          /encrypt|stream errored|restart required|connection terminated|connection lost|network connection lost|timed\s*out|closed|not connected/i.test(
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

  private async sendDocument(
    chatId: string,
    doc: { data: Uint8Array; fileName: string; mimetype: string; caption: string },
  ): Promise<Record<string, unknown>> {
    // Same wake/retry contract as sendText: one idle window, one stale-socket retry.
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
        const sent = await sock.sendMessage(chatId, {
          // Baileys' media pipeline checks Buffer.isBuffer(); a plain Uint8Array
          // falls through to the URL branch and throws. Buffer is available via
          // nodejs_compat.
          document: Buffer.from(doc.data),
          fileName: doc.fileName,
          mimetype: doc.mimetype,
          ...(doc.caption ? { caption: doc.caption } : {}),
        });
        return {
          id: sent?.key?.id ?? null,
          chatId,
          fileName: doc.fileName,
          mimetype: doc.mimetype,
          bytes: doc.data.length,
          timestamp: new Date().toISOString(),
        };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        const retryable =
          /encrypt|stream errored|restart required|connection terminated|connection lost|network connection lost|timed\s*out|closed|not connected/i.test(
            message,
          );
        if (attempt === 2 || !retryable) throw err;
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