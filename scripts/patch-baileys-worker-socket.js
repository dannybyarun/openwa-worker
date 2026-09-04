/**
 * Swap baileys' `ws`-based WebSocketClient for one that works on Cloudflare Workers.
 *
 * `lib/Socket/Client/websocket.js` hard-codes `new WebSocket(this.url, { origin, headers,
 * handshakeTimeout, timeout, agent })` from the `ws` npm package. `ws` needs Node's `net`/`tls`
 * sockets, which Cloudflare Workers (even with `nodejs_compat`) do not provide — so baileys can
 * never connect there unmodified.
 *
 * The replacement keeps the exact same class shape (`WebSocketClient extends AbstractSocketClient`,
 * same getters, same events) but connects through workerd's fetch()-upgrade WebSocket, which is the
 * only Workers primitive that lets us set the `Origin` header WhatsApp's handshake requires:
 *
 *     const response = await fetch('https://web.whatsapp.com/ws/chat', {
 *       headers: { origin: 'https://web.whatsapp.com', upgrade: 'websocket' },
 *     })
 *     const socket = response.webSocket
 *
 * Three workerd-specific behaviours are compensated for, all learned the hard way on a live
 * deploy:
 *
 * 1. **accept() is required before the socket delivers messages.** The fetch()-upgrade socket
 *    errors with "You must call one of accept()..." until accept() is called, so the noise
 *    handshake stalls. Safe on an already-open client socket.
 *
 * 2. **'open' must fire exactly once.** The fetch() promise resolves after the TLS/WS handshake, so
 *    when listeners are attached the socket is often already OPEN and workerd's 'open' event may
 *    already have been delivered (lost) or may still be queued. Emitting 'open' both manually and
 *    from the listener makes baileys run `validateConnection` twice — the second run sends a
 *    duplicate noise clientHello, which WhatsApp answers by terminating the connection (observed as
 *    CLOSE_NOTIFY locally and clean ~10 s drops on the real edge, never reaching the QR stanza).
 *    A guard flag makes 'open' fire exactly once either way.
 *
 * 3. **Errors are normalized to message-only Errors.** baileys' `getCodeFromWSError` calls
 *    `error?.code?.startsWith(...)`, but workerd error events carry a NUMERIC `code`, which throws
 *    a TypeError inside baileys' error mapper and corrupts its close bookkeeping.
 *
 * 4. **binaryType is pinned to 'arraybuffer' and Blob is handled as a fallback.** Modern workerd
 *    delivers binary frames as Blob (the WHATWG default); Miniflare and older workerd used
 *    ArrayBuffer. A Blob passed to baileys' noise decoder throws, so `validateConnection` never
 *    sees the server's handshake response and times out after `connectTimeoutMs` (20 s), by which
 *    point WhatsApp has already killed the half-open connection (~11 s). Pinning `binaryType`
 *    keeps frames synchronous ArrayBuffers; the Blob branch is a belt-and-braces fallback.
 *
 * 5. **The fetch upgrade must NOT carry an AbortSignal.** In workerd, the initiating request's
 *    abort signal keeps governing the WebSocket after the 101 upgrade: an
 *    `AbortSignal.timeout(connectTimeoutMs)` fires 20 s later, aborts the (perfectly healthy)
 *    connection with "The operation was aborted due to timeout", and baileys sees code 428
 *    `Connection Terminated` every 20 s — even when paired. Node's `ws` client scopes its
 *    handshakeTimeout to the handshake only. A race against a plain timer reproduces that
 *    semantics: the fetch itself is never aborted, and a hung handshake still fails fast.
 *
 * The runtime auto-replies to protocol ping frames, so baileys' keep-alive pings are unaffected.
 * Binary frames arrive as ArrayBuffer and are converted back to Buffer (nodejs_compat) because
 * baileys' noise decoder expects one.
 *
 * Exact and self-disabling, like the other patchers: it targets the pinned 7.0.0-rc14 dist shape
 * and refuses loudly if the file matches neither the pristine upstream shape nor a previous version
 * of this patch, rather than silently shipping an unpatched library.
 *
 * **RETIRE THIS, do not keep it.** It exists only because baileys has no injectable socket option
 * (SocketConfig has no `socket` field in 7.x). If upstream ever supports a custom WebSocket client
 * (there is prior art in older adiwajshing/baileys), delete this patcher and pass it in config.
 */
'use strict';

const fs = require('fs');
const path = require('path');

const DEFAULT_BAILEYS = path.join(__dirname, '..', 'node_modules', '@whiskeysockets', 'baileys');
const CLIENT_PATH = path.join('lib', 'Socket', 'Client', 'websocket.js');

/** Marker for the CURRENT patch version. isApplied() keys on this. */
const MARKER = 'OpenWA: Cloudflare Workers WebSocket client (fetch upgrade) — v5';
/** A file carrying this header (any prior patch version) is this patcher's own output and must be re-patchable. */
const V1_HEADER = 'OpenWA: Cloudflare Workers WebSocket client (fetch upgrade)';

/** The exact upstream 7.0.0-rc14 body this patcher was written against. */
const UPSTREAM_GUARDS = [
  "import WebSocket from 'ws';",
  'this.socket = new WebSocket(this.url, {',
  "const events = ['close', 'error', 'upgrade', 'message', 'open', 'ping', 'pong', 'unexpected-response'];",
];

const REPLACED_FILE = `// ${MARKER}
// Replaces the \`ws\`-based client with workerd's fetch()-upgrade WebSocket so baileys can run on
// Cloudflare Workers. Requires \`nodejs_compat\` in wrangler.toml (Buffer, events, url).
// See cloudflare-worker/scripts/patch-baileys-worker-socket.js — RETIRE when baileys supports an
// injectable socket.
import { DEFAULT_ORIGIN } from '../../Defaults/index.js';
import { AbstractSocketClient } from './types.js';

const CF_WS = { CONNECTING: 0, OPEN: 1, CLOSING: 2, CLOSED: 3 };

export class WebSocketClient extends AbstractSocketClient {
    constructor() {
        super(...arguments);
        this.socket = null;
    }
    get isOpen() {
        return this.socket?.readyState === CF_WS.OPEN;
    }
    get isClosed() {
        return this.socket === null || this.socket?.readyState === CF_WS.CLOSED;
    }
    get isClosing() {
        return this.socket === null || this.socket?.readyState === CF_WS.CLOSING;
    }
    get isConnecting() {
        return this.socket?.readyState === CF_WS.CONNECTING;
    }
    async connect() {
        if (this.socket) {
            return;
        }
        const raw = this.url.href;
        const httpUrl = raw.startsWith('wss://') ? \`https://\${raw.slice(6)}\` : raw.replace(/^ws:/, 'http:');
        // No abort timeout on the fetch: workerd keeps the request's signal attached to the
        // upgraded WebSocket, so a connect-timeout abort would kill the established connection
        // 20 s in (see doc comment, point 5). Race against a plain timer instead — it only fails
        // a HUNG handshake, never the resulting socket.
        const handshake = fetch(httpUrl, { headers: { origin: DEFAULT_ORIGIN, upgrade: 'websocket' } });
        handshake.catch(() => {}); // the race below observes the result; silence a late settlement
        const timeout = new Promise((_, reject) =>
            setTimeout(() => reject(new Error('WebSocket connect timed out')), this.config.connectTimeoutMs),
        );
        let response;
        try {
            response = await Promise.race([handshake, timeout]);
        } catch (error) {
            this.emit('error', error instanceof Error ? error : new Error('WebSocket connect failed'));
            return;
        }
        const socket = response?.webSocket;
        if (!socket) {
            this.emit('error', new Error(\`WebSocket upgrade failed (HTTP \${response?.status ?? 'unknown'})\`));
            return;
        }
        this.socket = socket;
        // Pin binary frames to ArrayBuffer: workerd's WHATWG default is Blob, which baileys'
        // noise decoder cannot read (see doc comment, point 4). Set before accept()/messages.
        try {
            socket.binaryType = 'arraybuffer';
        } catch {
            // older runtimes may not expose the setter; the Blob branch below still covers it
        }
        // workerd's fetch()-upgrade sockets require accept() before they start delivering
        // messages — without it the runtime errors with "You must call one of accept()..." and
        // the noise handshake never completes. Safe on an already-open client socket.
        if (socket.readyState === CF_WS.OPEN || socket.readyState === CF_WS.CONNECTING) {
            try {
                socket.accept();
            } catch {
                // already accepted
            }
        }
        // 'open' must fire EXACTLY once. The fetch promise resolves after the handshake, so the
        // socket is often already OPEN here: workerd's 'open' event may already have been delivered
        // (and is lost to listeners attached now) or may still be queued. Emitting both the manual
        // and the real event makes baileys validate the connection twice, and the duplicate noise
        // clientHello gets the connection killed by WhatsApp. The flag makes either path the only
        // one.
        let openFired = false;
        const onOpen = () => {
            if (!openFired) {
                openFired = true;
                this.emit('open');
            }
        };
        socket.addEventListener('open', onOpen);
        if (socket.readyState === CF_WS.OPEN) {
            onOpen();
        }
        socket.addEventListener('message', event => {
            let data = event.data;
            if (data instanceof Blob) {
                // binaryType pin failed or frames arrived before it took effect: convert async.
                void data.arrayBuffer().then(buf => this.emit('message', Buffer.from(buf))).catch(() => {});
                return;
            }
            if (data instanceof ArrayBuffer) {
                data = Buffer.from(data);
            } else if (typeof data === 'string') {
                data = Buffer.from(data);
            }
            this.emit('message', data);
        });
        // baileys' getCodeFromWSError calls error.code?.startsWith(...) — workerd error events carry
        // a NUMERIC code, so pass a message-only Error or the mapper throws a TypeError.
        socket.addEventListener('error', event => {
            const raw = event?.error;
            this.emit('error', new Error(raw instanceof Error ? raw.message : 'WebSocket error'));
        });
        socket.addEventListener('close', event => this.emit('close', event));
        // The socket can already be dead when the fetch resolves (server closed right after the
        // 101); its 'close' event is then lost too, and baileys would wait forever.
        if (socket.readyState === CF_WS.CLOSED) {
            this.emit('close', { code: 1006, reason: 'socket closed before connect completed' });
        }
    }
    async close() {
        if (!this.socket) {
            return;
        }
        const socket = this.socket;
        this.socket = null;
        if (socket.readyState === CF_WS.OPEN || socket.readyState === CF_WS.CONNECTING) {
            try {
                socket.close();
            } catch {
                // already closing/closed
            }
        }
    }
    send(str, cb) {
        try {
            this.socket?.send(str);
            cb?.();
        } catch (error) {
            cb?.(error instanceof Error ? error : new Error('WebSocket send failed'));
        }
        return Boolean(this.socket);
    }
}
`;

/** Apply the transform. Returns {skipped, reason} or {note} — never a partial write. */
function applyWorkerSocketPatch(baileysDir = DEFAULT_BAILEYS) {
  const file = path.join(baileysDir, CLIENT_PATH);
  if (!fs.existsSync(file)) {
    return { skipped: true, reason: `${CLIENT_PATH} not found — nothing to patch` };
  }
  const source = fs.readFileSync(file, 'utf8');
  if (source.includes(MARKER)) {
    return { skipped: true, reason: 'already patched' };
  }
  const pristine =
    UPSTREAM_GUARDS.every(guard => source.split(guard).length - 1 === 1) &&
    !source.includes(V1_HEADER);
  const previousPatch = source.includes(V1_HEADER);
  if (!pristine && !previousPatch) {
    const guard = UPSTREAM_GUARDS.find(g => source.split(g).length - 1 !== 1) ?? '(unknown)';
    throw new Error(
      `expected the pristine 7.0.0-rc14 websocket.js (or a previous version of this patch), ` +
        `found a different shape (guard \`${guard}\` mismatch) — the upstream shape changed; ` +
        're-check the baileys WebSocketClient before removing this patcher',
    );
  }
  fs.writeFileSync(file, REPLACED_FILE, 'utf8');
  return { note: 'swapped the ws-based WebSocketClient for a Workers fetch()-upgrade client' };
}

function run() {
  const bestEffort = process.argv.includes('--best-effort');
  try {
    const result = applyWorkerSocketPatch();
    console.log(`patch-baileys-worker-socket: ${result.skipped ? `skipped — ${result.reason}` : result.note}`);
  } catch (error) {
    if (bestEffort) {
      console.warn(`patch-baileys-worker-socket: skipped — ${error.message}`);
      return;
    }
    console.error(`patch-baileys-worker-socket: ${error.message}`);
    process.exitCode = 1;
  }
}

if (require.main === module) run();

/**
 * The stand-down branch above as a predicate, for the worker's own boot guard. Unreadable reads as
 * applied: a tree we cannot inspect is not evidence of a broken one, and the apply function treats
 * a missing websocket.js as nothing to patch rather than a fault.
 */
function isApplied(baileysDir = DEFAULT_BAILEYS) {
  try {
    return fs.readFileSync(path.join(baileysDir, CLIENT_PATH), 'utf8').includes(MARKER);
  } catch {
    return true;
  }
}

module.exports = { applyWorkerSocketPatch, isApplied, UPSTREAM_GUARDS, MARKER, V1_HEADER, REPLACED_FILE };