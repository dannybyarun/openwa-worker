#!/usr/bin/env node
/**
 * Stdio → Streamable HTTP bridge for MCP clients that cannot talk HTTP directly
 * (older Claude Desktop builds, some editors).
 *
 *   node scripts/mcp-stdio.mjs --url https://wa.example.com --token owa_...
 *
 * Environment fallbacks: WHATSFLARE_URL / WHATSFLARE_TOKEN, then MCP_URL / MCP_TOKEN.
 * Lines are newline-delimited JSON-RPC, as the MCP stdio transport requires.
 */
import { createInterface } from 'node:readline';

const argv = process.argv.slice(2);
const valueAfter = flag => {
  const i = argv.indexOf(flag);
  return i >= 0 ? argv[i + 1] : undefined;
};

if (argv.includes('--help') || argv.includes('-h')) {
  console.log(`Usage: node scripts/mcp-stdio.mjs --url <worker origin> [--token <token>]

Bridges MCP stdio to the worker's POST /mcp endpoint.
The URL may be the origin (https://wa.example.com) or include /mcp.
Token falls back to WHATSFLARE_TOKEN, then MCP_TOKEN.`);
  process.exit(0);
}

const url = valueAfter('--url') ?? process.env.WHATSFLARE_URL ?? process.env.MCP_URL;
const token = valueAfter('--token') ?? process.env.WHATSFLARE_TOKEN ?? process.env.MCP_TOKEN;
if (!url) {
  console.error(
    'mcp-stdio: pass --url https://your-worker.example.com (or set WHATSFLARE_URL)',
  );
  process.exit(2);
}
const endpoint = url.endsWith('/mcp') ? url : `${url.replace(/\/+$/, '')}/mcp`;

const write = message => process.stdout.write(`${JSON.stringify(message)}\n`);
const idOf = request =>
  typeof request?.id === 'string' || typeof request?.id === 'number' ? request.id : null;

async function forward(line) {
  let request;
  try {
    request = JSON.parse(line);
  } catch {
    write({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'parse error' } });
    return;
  }
  const isNotification = request?.id === undefined;
  try {
    const response = await fetch(endpoint, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
        ...(token ? { authorization: `Bearer ${token}` } : {}),
      },
      body: line,
    });
    const text = await response.text();
    // Notifications are answered with 202 and no body.
    if (isNotification) return;
    if (!response.ok) {
      let message = `HTTP ${response.status}`;
      try {
        const parsed = JSON.parse(text);
        message = parsed?.error?.message ?? message;
      } catch {
        // keep the status line
      }
      write({ jsonrpc: '2.0', id: idOf(request), error: { code: -32603, message } });
      return;
    }
    if (!text) {
      write({
        jsonrpc: '2.0',
        id: idOf(request),
        error: { code: -32603, message: 'empty response' },
      });
      return;
    }
    process.stdout.write(text.endsWith('\n') ? text : `${text}\n`);
  } catch (error) {
    if (isNotification) return;
    write({
      jsonrpc: '2.0',
      id: idOf(request),
      error: {
        code: -32603,
        message: error instanceof Error ? error.message : String(error),
      },
    });
  }
}

// Serialize forwarding so responses cannot interleave on stdout.
let queue = Promise.resolve();
const lines = createInterface({ input: process.stdin });
lines.on('line', line => {
  if (!line.trim()) return;
  queue = queue.then(() => forward(line));
});
