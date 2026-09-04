'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const {
  applyWorkerSocketPatch,
  isApplied,
  UPSTREAM_GUARDS,
  MARKER,
  V1_HEADER,
  REPLACED_FILE,
} = require('./patch-baileys-worker-socket');

/**
 * Same contract as the sibling patcher specs: the patcher rewrites a file this repository does not
 * own, so it must fire only on the exact shape it was written for, refuse loudly on anything else,
 * and be safe to run twice (postinstall runs on every install).
 */

/** The exact upstream 7.0.0-rc14 lib/Socket/Client/websocket.js body, verbatim. */
const UPSTREAM_WEBSOCKET_JS = `import WebSocket from 'ws';
import { DEFAULT_ORIGIN } from '../../Defaults/index.js';
import { AbstractSocketClient } from './types.js';
export class WebSocketClient extends AbstractSocketClient {
    constructor() {
        super(...arguments);
        this.socket = null;
    }
    get isOpen() {
        return this.socket?.readyState === WebSocket.OPEN;
    }
    get isClosed() {
        return this.socket === null || this.socket?.readyState === WebSocket.CLOSED;
    }
    get isClosing() {
        return this.socket === null || this.socket?.readyState === WebSocket.CLOSING;
    }
    get isConnecting() {
        return this.socket?.readyState === WebSocket.CONNECTING;
    }
    connect() {
        if (this.socket) {
            return;
        }
        this.socket = new WebSocket(this.url, {
            origin: DEFAULT_ORIGIN,
            headers: this.config.options?.headers,
            handshakeTimeout: this.config.connectTimeoutMs,
            timeout: this.config.connectTimeoutMs,
            agent: this.config.agent
        });
        this.socket.setMaxListeners(0);
        const events = ['close', 'error', 'upgrade', 'message', 'open', 'ping', 'pong', 'unexpected-response'];
        for (const event of events) {
            this.socket?.on(event, (...args) => this.emit(event, ...args));
        }
    }
    async close() {
        if (!this.socket) {
            return;
        }
        const closePromise = new Promise(resolve => {
            this.socket?.once('close', resolve);
        });
        this.socket.close();
        await closePromise;
        this.socket = null;
    }
    send(str, cb) {
        this.socket?.send(str, cb);
        return Boolean(this.socket);
    }
}
`;

function fakeBaileys(overrides = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'baileys-worker-socket-'));
  fs.mkdirSync(path.join(dir, 'lib', 'Socket', 'Client'), { recursive: true });
  // The real package declares ESM; mirror that so the patched websocket.js can be imported.
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ type: 'module' }), 'utf8');
  const file = path.join(dir, 'lib', 'Socket', 'Client', 'websocket.js');
  fs.writeFileSync(file, overrides.content ?? UPSTREAM_WEBSOCKET_JS, 'utf8');
  return { dir, file };
}

test('CONTROL — the fixture reproduces the exact guards the patcher keys on', () => {
  for (const guard of UPSTREAM_GUARDS) {
    const occurrences = UPSTREAM_WEBSOCKET_JS.split(guard).length - 1;
    assert.equal(occurrences, 1, `guard \`${guard}\` must appear exactly once in the fixture`);
  }
});

test('re-patches its own v1 output (upgrade path, idempotent per version)', () => {
  const v1Output = REPLACED_FILE.replace(MARKER, V1_HEADER);
  const { dir, file } = fakeBaileys({ content: v1Output });
  const result = applyWorkerSocketPatch(dir);
  assert.equal(result.skipped, undefined);
  const patched = fs.readFileSync(file, 'utf8');
  assert.ok(patched.startsWith(`// ${MARKER}`)); // upgraded to the current version
  assert.ok(patched.includes('openFired'), 'exactly-once open guard present');
  // and the current version is a no-op
  const second = applyWorkerSocketPatch(dir);
  assert.equal(second.skipped, true);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('replaces the ws import with the Workers fetch()-upgrade client', () => {
  const { dir, file } = fakeBaileys();
  const result = applyWorkerSocketPatch(dir);
  assert.equal(result.skipped, undefined);

  const patched = fs.readFileSync(file, 'utf8');
  assert.ok(patched.includes(MARKER));
  assert.ok(!patched.includes("from 'ws'"), 'no trace of the ws package may remain');
  assert.ok(patched.includes("import { AbstractSocketClient } from './types.js'"));
  assert.ok(patched.includes("fetch(httpUrl"), 'connect() must go through fetch upgrade');
  assert.ok(patched.includes("origin: DEFAULT_ORIGIN"), 'the WhatsApp Origin header must survive');
  assert.ok(patched.includes("socket.binaryType = 'arraybuffer'"), 'binary frames must be pinned to ArrayBuffer');
  assert.ok(patched.includes('data instanceof Blob'), 'Blob frames must be handled as a fallback');
  assert.ok(!patched.includes('AbortSignal.timeout('), 'no abort timeout may govern the fetch upgrade (it would kill the socket at connectTimeoutMs)');
  assert.ok(patched.includes('export class WebSocketClient extends AbstractSocketClient'), 'class shape unchanged');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('is idempotent — a second run does not double-patch', () => {
  const { dir, file } = fakeBaileys();
  applyWorkerSocketPatch(dir);
  const once = fs.readFileSync(file, 'utf8');
  const second = applyWorkerSocketPatch(dir);
  assert.equal(second.skipped, true);
  assert.equal(second.reason, 'already patched');
  assert.equal(fs.readFileSync(file, 'utf8'), once);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('refuses an unknown shape rather than shipping unpatched', () => {
  const { dir } = fakeBaileys({ content: "export const answer = 42;\n" });
  assert.throws(() => applyWorkerSocketPatch(dir), /found a different shape/);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('skips a tree with no baileys rather than failing the install', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'baileys-worker-socket-'));
  const result = applyWorkerSocketPatch(dir);
  assert.equal(result.skipped, true);
  assert.match(result.reason, /not found/);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('isApplied is false on a pristine tree and true once the patch has run', () => {
  const { dir } = fakeBaileys();
  assert.equal(isApplied(dir), false);
  applyWorkerSocketPatch(dir);
  assert.equal(isApplied(dir), true);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('the replacement is syntactically valid ESM', async () => {
  const { dir } = fakeBaileys();
  applyWorkerSocketPatch(dir);
  const file = path.join(dir, 'lib', 'Socket', 'Client', 'websocket.js');
  // Import the patched module with a stub of the abstract base so we can at least instantiate the
  // class and check the getters behave like the upstream ones did.
  const typesFile = path.join(dir, 'lib', 'Socket', 'Client', 'types.js');
  fs.mkdirSync(path.dirname(typesFile), { recursive: true });
  fs.writeFileSync(
    typesFile,
    `import { EventEmitter } from 'events';
export class AbstractSocketClient extends EventEmitter {
  constructor(url, config) { super(); this.url = url; this.config = config; this.setMaxListeners(0); }
}
`,
  );
  // The patched client imports DEFAULT_ORIGIN from ../../Defaults/index.js.
  fs.mkdirSync(path.join(dir, 'lib', 'Defaults'), { recursive: true });
  fs.writeFileSync(
    path.join(dir, 'lib', 'Defaults', 'index.js'),
    `export const DEFAULT_ORIGIN = 'https://web.whatsapp.com';\n`,
  );
  // The patched file is ESM; import it through a data: URL won't resolve relative imports, so use
  // a tiny wrapper that makes the ESM module loadable via dynamic import with a real path.
  const { pathToFileURL } = require('url');
  const mod = await import(pathToFileURL(file).href + '?t=' + Date.now());
  const client = new mod.WebSocketClient(new URL('wss://example.com/ws'), {
    connectTimeoutMs: 5000,
    options: {},
  });
  assert.equal(client.isClosed, true);
  assert.equal(client.isOpen, false);
  assert.equal(client.isConnecting, false);
  assert.equal(client.send(Buffer.from('x')), false); // no socket yet, must not throw
  fs.rmSync(dir, { recursive: true, force: true });
});

test('REPLACED_FILE is what the apply function writes (drift guard)', () => {
  const { dir, file } = fakeBaileys();
  applyWorkerSocketPatch(dir);
  assert.equal(fs.readFileSync(file, 'utf8'), REPLACED_FILE);
  fs.rmSync(dir, { recursive: true, force: true });
});