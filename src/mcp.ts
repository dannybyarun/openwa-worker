/**
 * MCP (Model Context Protocol) endpoint logic, deliberately free of imports so
 * `scripts/mcp.spec.mjs` can exercise it under plain Node.
 *
 * Transport: Streamable HTTP, stateless. A client POSTs one JSON-RPC message and gets one JSON
 * response; there is no SSE stream and no session id, so nothing is kept alive between calls.
 * That is what keeps the free-tier posture: an MCP client costs a Worker request per tool call
 * and nothing else.
 *
 * Scopes mirror the token kinds:
 *   - `full` (API_TOKEN or a generated full token): every tool.
 *   - `send` token: `send_text` only, pinned to its session and optional chat allowlist.
 * Embed tokens are refused before they reach here.
 */

export const MCP_PROTOCOL_VERSION = '2025-06-18';
export const MCP_SERVER_NAME = 'whatsflare';
export const MCP_SERVER_VERSION = '0.1.0';

const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 50;
const MAX_TEXT_CHARS = 4096;
const MAX_RESULT_CHARS = 40_000;
const SESSION_RE = /^[a-zA-Z0-9_-]{1,64}$/;
const CHAT_ID_RE = /^[0-9][0-9-]{3,30}@(s\.whatsapp\.net|g\.us|lid|broadcast|newsletter)$/;

export type McpScope =
  | { kind: 'full' }
  | { kind: 'send'; session: string; chatIds: string[] };

export interface McpBackend {
  listSessions(): Promise<unknown>;
  sessionStatus(session: string): Promise<unknown>;
  listChats(session: string, limit: number): Promise<unknown>;
  readMessages(session: string, chatId: string | undefined, limit: number): Promise<unknown>;
  sendText(session: string, chatId: string, text: string): Promise<unknown>;
}

export interface McpTool {
  name: string;
  description: string;
  inputSchema: {
    type: 'object';
    properties: Record<string, unknown>;
    required?: string[];
    additionalProperties: boolean;
  };
}

export interface McpToolResult {
  content: Array<{ type: 'text'; text: string }>;
  isError?: boolean;
}

export interface JsonRpcResponse {
  jsonrpc: '2.0';
  id: string | number | null;
  result?: unknown;
  error?: { code: number; message: string };
}

/** A protocol-level failure (bad params, unknown tool). Runtime failures become `isError`. */
export class McpError extends Error {
  readonly code: number;

  constructor(code: number, message: string) {
    super(message);
    this.name = 'McpError';
    this.code = code;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Tools visible to a scope. A `send` token never sees the read tools. */
export function mcpTools(scope: McpScope): McpTool[] {
  if (scope.kind === 'send') {
    return [
      {
        name: 'send_text',
        description: `Send a WhatsApp text message as session "${scope.session}". This token cannot read chats.`,
        inputSchema: {
          type: 'object',
          properties: {
            chatId: {
              type: 'string',
              description: 'WhatsApp chat id, e.g. 9779800000000@s.whatsapp.net or 1203630…@g.us.',
            },
            text: { type: 'string', description: 'Message body, at most 4096 characters.' },
          },
          required: ['chatId', 'text'],
          additionalProperties: false,
        },
      },
    ];
  }

  const limit = {
    type: 'integer',
    minimum: 1,
    maximum: MAX_LIMIT,
    default: DEFAULT_LIMIT,
    description: `How many rows to return (1-${MAX_LIMIT}).`,
  };
  const session = {
    type: 'string',
    description: 'Session name, as returned by list_sessions.',
  };

  return [
    {
      name: 'list_sessions',
      description: 'List the WhatsApp sessions on this worker with their connection status.',
      inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    },
    {
      name: 'session_status',
      description: 'Connection status for one session: status, linked account and last disconnect.',
      inputSchema: {
        type: 'object',
        properties: { session },
        required: ['session'],
        additionalProperties: false,
      },
    },
    {
      name: 'list_chats',
      description: 'Most recent chats for a session, newest first, with the last message preview.',
      inputSchema: {
        type: 'object',
        properties: { session, limit },
        required: ['session'],
        additionalProperties: false,
      },
    },
    {
      name: 'read_messages',
      description:
        'Recent messages, newest first. Filter by chatId, or omit it for messages across chats.',
      inputSchema: {
        type: 'object',
        properties: {
          session,
          chatId: { type: 'string', description: 'Optional WhatsApp chat id to filter by.' },
          limit,
        },
        required: ['session'],
        additionalProperties: false,
      },
    },
    {
      name: 'send_text',
      description:
        'Send a WhatsApp text message. Opens a short connection window and counts against the session daily wake budget.',
      inputSchema: {
        type: 'object',
        properties: {
          session,
          chatId: { type: 'string', description: 'WhatsApp chat id to send to.' },
          text: { type: 'string', description: 'Message body, at most 4096 characters.' },
        },
        required: ['session', 'chatId', 'text'],
        additionalProperties: false,
      },
    },
  ];
}

/**
 * Handle one JSON-RPC message. Returns `null` for notifications (no response is allowed).
 * Never throws for protocol problems; they come back as an `error` member.
 */
export async function handleMcpRequest(
  payload: unknown,
  scope: McpScope,
  backend: McpBackend,
): Promise<JsonRpcResponse | null> {
  const record = isRecord(payload) ? payload : undefined;
  const id =
    record && (typeof record.id === 'string' || typeof record.id === 'number') ? record.id : null;

  if (!record) return rpcError(null, -32600, 'invalid JSON-RPC request');
  // A notification (no `id`) must not be answered.
  if (record.id === undefined) return null;
  if (record.jsonrpc !== '2.0' || typeof record.method !== 'string') {
    return rpcError(id, -32600, 'invalid JSON-RPC request');
  }

  try {
    switch (record.method) {
      case 'initialize':
        return rpcResult(id, {
          protocolVersion: MCP_PROTOCOL_VERSION,
          capabilities: { tools: { listChanged: false } },
          serverInfo: { name: MCP_SERVER_NAME, version: MCP_SERVER_VERSION },
        });
      case 'ping':
        return rpcResult(id, {});
      case 'tools/list':
        return rpcResult(id, { tools: mcpTools(scope) });
      case 'tools/call':
        return rpcResult(id, await callTool(record.params, scope, backend));
      default:
        throw new McpError(-32601, `method not found: ${record.method}`);
    }
  } catch (error) {
    if (error instanceof McpError) return rpcError(id, error.code, error.message);
    return rpcError(id, -32603, 'internal error');
  }
}

async function callTool(
  rawParams: unknown,
  scope: McpScope,
  backend: McpBackend,
): Promise<McpToolResult> {
  const params = isRecord(rawParams) ? rawParams : {};
  const name = typeof params.name === 'string' ? params.name : '';
  if (!name) throw new McpError(-32602, 'tools/call needs a tool name');
  if (!mcpTools(scope).some(tool => tool.name === name)) {
    throw new McpError(-32602, `unknown tool for this token: ${name}`);
  }
  const args = isRecord(params.arguments) ? params.arguments : {};

  try {
    switch (name) {
      case 'list_sessions':
        return textResult(await backend.listSessions());
      case 'session_status': {
        const session = requireSession(scope, args);
        return textResult(await backend.sessionStatus(session));
      }
      case 'list_chats': {
        const session = requireSession(scope, args);
        return textResult(await backend.listChats(session, limitArg(args.limit)));
      }
      case 'read_messages': {
        const session = requireSession(scope, args);
        const chatId = args.chatId === undefined ? undefined : requireChatId(args.chatId);
        return textResult(await backend.readMessages(session, chatId, limitArg(args.limit)));
      }
      case 'send_text': {
        const session = scope.kind === 'send' ? scope.session : requireSession(scope, args);
        const chatId = requireChatId(args.chatId);
        if (scope.kind === 'send' && !scopeChatAllowed(scope.chatIds, chatId)) {
          throw new McpError(-32602, 'this token is not allowed to send to that chat');
        }
        const text = requireText(args.text);
        const sent = await backend.sendText(session, chatId, text);
        return textResult({ sent: true, session, chatId, ...(isRecord(sent) ? sent : {}) });
      }
      default:
        throw new McpError(-32602, `unknown tool: ${name}`);
    }
  } catch (error) {
    // Argument mistakes are protocol errors; a send that WhatsApp rejects is a tool error the
    // model can read and react to.
    if (error instanceof McpError) throw error;
    const message = error instanceof Error ? error.message : String(error);
    return { content: [{ type: 'text', text: `Error: ${message}` }], isError: true };
  }
}

/** Mirrors `chatAllowed` in `tokens.ts`; duplicated so this module stays import-free for tests. */
function scopeChatAllowed(chatIds: string[], chatId: string): boolean {
  return chatIds.length === 0 || chatIds.includes(chatId);
}

function requireSession(scope: McpScope, args: Record<string, unknown>): string {
  if (scope.kind === 'send') return scope.session;
  return requireString(args.session, 'session', 64, SESSION_RE);
}

function requireChatId(value: unknown): string {
  const chatId = requireString(value, 'chatId', 200, CHAT_ID_RE);
  return chatId;
}

function requireText(value: unknown): string {
  const text = requireString(value, 'text', MAX_TEXT_CHARS);
  if (!text.trim()) throw new McpError(-32602, 'text must not be empty');
  return text;
}

function requireString(value: unknown, field: string, max: number, pattern?: RegExp): string {
  if (typeof value !== 'string' || !value.trim()) {
    throw new McpError(-32602, `${field} is required`);
  }
  if (value.length > max) {
    throw new McpError(-32602, `${field} is too long (${max} characters max)`);
  }
  if (pattern && !pattern.test(value)) {
    throw new McpError(-32602, `${field} is invalid`);
  }
  return value;
}

function limitArg(value: unknown): number {
  if (value === undefined) return DEFAULT_LIMIT;
  const n = typeof value === 'string' ? Number(value) : value;
  if (typeof n !== 'number' || !Number.isInteger(n) || n < 1 || n > MAX_LIMIT) {
    throw new McpError(-32602, `limit must be an integer between 1 and ${MAX_LIMIT}`);
  }
  return n;
}

function textResult(value: unknown): McpToolResult {
  let text: string;
  try {
    text = JSON.stringify(value, null, 2) ?? 'null';
  } catch {
    text = String(value);
  }
  if (text.length > MAX_RESULT_CHARS) text = `${text.slice(0, MAX_RESULT_CHARS)}\n… (truncated)`;
  return { content: [{ type: 'text', text }] };
}

function rpcResult(id: string | number | null, result: unknown): JsonRpcResponse {
  return { jsonrpc: '2.0', id, result };
}

function rpcError(id: string | number | null, code: number, message: string): JsonRpcResponse {
  return { jsonrpc: '2.0', id, error: { code, message } };
}
