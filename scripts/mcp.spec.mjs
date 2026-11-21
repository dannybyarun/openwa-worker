import assert from 'node:assert/strict';
import test from 'node:test';

import {
  handleMcpRequest,
  mcpTools,
  MCP_PROTOCOL_VERSION,
  MCP_SERVER_NAME,
} from '../src/mcp.ts';

const FULL = { kind: 'full' };
const CHAT = '9779800000000@s.whatsapp.net';
const OTHER = '120363000000000000@g.us';

function makeBackend(overrides = {}) {
  const calls = [];
  const backend = {
    async listSessions() {
      calls.push(['list_sessions']);
      return { sessions: [{ id: 'yona', status: 'idle' }] };
    },
    async sessionStatus(session) {
      calls.push(['session_status', session]);
      return { id: session, status: 'idle' };
    },
    async listChats(session, limit) {
      calls.push(['list_chats', session, limit]);
      return { session, chats: [] };
    },
    async readMessages(session, chatId, limit) {
      calls.push(['read_messages', session, chatId, limit]);
      return { session, chatId: chatId ?? null, messages: [] };
    },
    async sendText(session, chatId, text) {
      calls.push(['send_text', session, chatId, text]);
      return { id: 'ABC123' };
    },
    ...overrides,
  };
  return { backend, calls };
}

function rpc(method, params, id = 1) {
  return { jsonrpc: '2.0', id, method, ...(params === undefined ? {} : { params }) };
}

async function tool(name, args, scope = FULL, backend = makeBackend().backend) {
  return handleMcpRequest(rpc('tools/call', { name, arguments: args }), scope, backend);
}

test('initialize advertises the protocol version and server name', async () => {
  const res = await handleMcpRequest(rpc('initialize', { protocolVersion: '2025-06-18' }, 'a'), FULL, makeBackend().backend);
  assert.equal(res.id, 'a');
  assert.equal(res.result.protocolVersion, MCP_PROTOCOL_VERSION);
  assert.equal(res.result.serverInfo.name, MCP_SERVER_NAME);
  assert.ok(res.result.capabilities.tools);
});

test('notifications are not answered', async () => {
  const res = await handleMcpRequest(
    { jsonrpc: '2.0', method: 'notifications/initialized' },
    FULL,
    makeBackend().backend,
  );
  assert.equal(res, null);
});

test('a full token sees all five tools', () => {
  const names = mcpTools(FULL).map(tool => tool.name);
  assert.deepEqual(names, [
    'list_sessions',
    'session_status',
    'list_chats',
    'read_messages',
    'send_text',
  ]);
});

test('a send token only sees send_text, with no session parameter', () => {
  const tools = mcpTools({ kind: 'send', session: 'yona', chatIds: [] });
  assert.equal(tools.length, 1);
  assert.equal(tools[0].name, 'send_text');
  assert.equal(tools[0].inputSchema.properties.session, undefined);
  assert.match(tools[0].description, /yona/);
});

test('list_sessions returns the backend result as JSON text', async () => {
  const res = await tool('list_sessions', {});
  const payload = JSON.parse(res.result.content[0].text);
  assert.equal(payload.sessions[0].id, 'yona');
});

test('read_messages passes the default limit and an optional chatId', async () => {
  const { backend, calls } = makeBackend();
  await tool('read_messages', { session: 'yona' }, FULL, backend);
  await tool('read_messages', { session: 'yona', chatId: CHAT, limit: 5 }, FULL, backend);
  assert.deepEqual(calls[0], ['read_messages', 'yona', undefined, 20]);
  assert.deepEqual(calls[1], ['read_messages', 'yona', CHAT, 5]);
});

test('a send token is pinned to its session', async () => {
  const { backend, calls } = makeBackend();
  const res = await tool(
    'send_text',
    { chatId: CHAT, text: 'hello' },
    { kind: 'send', session: 'yona', chatIds: [] },
    backend,
  );
  assert.deepEqual(calls[0], ['send_text', 'yona', CHAT, 'hello']);
  assert.equal(JSON.parse(res.result.content[0].text).sent, true);
});

test('a send token cannot message a chat outside its allowlist', async () => {
  const { backend, calls } = makeBackend();
  const res = await tool(
    'send_text',
    { chatId: OTHER, text: 'hello' },
    { kind: 'send', session: 'yona', chatIds: [CHAT] },
    backend,
  );
  assert.equal(calls.length, 0);
  assert.equal(res.error.code, -32602);
  assert.match(res.error.message, /not allowed/);
});

test('a send token cannot read chats', async () => {
  const res = await tool('list_sessions', {}, { kind: 'send', session: 'yona', chatIds: [] });
  assert.equal(res.error.code, -32602);
  assert.match(res.error.message, /unknown tool/);
});

test('bad arguments are protocol errors', async () => {
  assert.equal((await tool('send_text', { chatId: 'nope', text: 'hi' })).error.code, -32602);
  assert.equal((await tool('send_text', { chatId: CHAT })).error.code, -32602);
  assert.equal((await tool('send_text', { chatId: CHAT, text: '   ' })).error.code, -32602);
  assert.equal((await tool('send_text', { chatId: CHAT, text: 'x'.repeat(4097) })).error.code, -32602);
  assert.equal((await tool('read_messages', { session: '../etc' })).error.code, -32602);
  assert.equal((await tool('read_messages', { session: 'yona', limit: 0 })).error.code, -32602);
  assert.equal((await tool('read_messages', { session: 'yona', limit: 51 })).error.code, -32602);
});

test('a backend failure becomes a tool error the model can read', async () => {
  const backend = makeBackend({
    async sendText() {
      throw new Error('daily wake limit reached');
    },
  }).backend;
  const res = await tool('send_text', { session: 'yona', chatId: CHAT, text: 'hi' }, FULL, backend);
  assert.equal(res.result.isError, true);
  assert.match(res.result.content[0].text, /daily wake limit reached/);
});

test('unknown methods and malformed requests are JSON-RPC errors', async () => {
  const unknown = await handleMcpRequest(rpc('resources/list'), FULL, makeBackend().backend);
  assert.equal(unknown.error.code, -32601);

  const malformed = await handleMcpRequest({ id: 3, method: 'ping' }, FULL, makeBackend().backend);
  assert.equal(malformed.error.code, -32600);
  assert.equal(malformed.id, 3);
});
