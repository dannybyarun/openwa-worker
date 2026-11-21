# MCP server

WhatsFlare speaks the [Model Context Protocol](https://modelcontextprotocol.io) at `POST /mcp`, so
Claude Desktop, Cursor, VS Code or any agent framework can list chats, read messages and send texts
against your linked WhatsApp account.

It is **stateless Streamable HTTP**: one JSON-RPC message per request, one JSON response, no SSE
stream and no session id. Nothing stays connected between calls, and no extra Durable Object is
created — an agent costs one Worker request per tool call, plus the normal wake window when it sends.

## Authentication

| Where | Value |
|---|---|
| `Authorization: Bearer <token>` | preferred |
| `X-API-Key: <token>` | same token |
| `?token=<token>` | for clients that cannot set headers |

Cookies are ignored: the browser login cannot be replayed against `/mcp`.

| Token | Tools |
|---|---|
| `API_TOKEN` or a generated **full** token | all five tools |
| generated **send** token | `send_text` only, pinned to its session and chat allowlist, 500 sends/day |
| **embed** token | rejected (401) |

If the worker sets only `UI_PASSWORD`, no plain secret works here: create a **full** token in
Settings → Sending, or set `API_TOKEN`.

## Tools

| Tool | Arguments | Returns |
|---|---|---|
| `list_sessions` | — | session names, status, linked account |
| `session_status` | `session` | status, `me`, last disconnect |
| `list_chats` | `session`, `limit` (1–50, default 20) | newest chats with last-message preview and timestamp |
| `read_messages` | `session`, `chatId` (optional), `limit` | newest-first messages; falls back to the durable chat index when the buffer rolled over |
| `send_text` | `session`, `chatId`, `text` (≤4096) | `{ sent, session, chatId, id }` |

A `send` token sees a single `send_text` tool with no `session` argument — it always uses the
session the token was minted for, and refuses chats outside its allowlist.

Read tools only touch Durable Object storage, so they never open the WhatsApp socket. `send_text`
goes through the same path as `POST /api/sessions/:id/send-text`: it opens a short window, counts
against `DAILY_WAKE_LIMIT`, and reports a limit as a tool error (`isError: true`) the model can read.

## Client setup

**HTTP clients (Cursor, VS Code, agent SDKs).** Point them at the endpoint and add the header:

```json
{
  "mcpServers": {
    "whatsflare": {
      "url": "https://wa.example.com/mcp",
      "headers": { "Authorization": "Bearer owa_your_token" }
    }
  }
}
```

Some clients want `"type": "http"` alongside `url`; both are accepted by the protocol.

**stdio-only clients (Claude Desktop).** Use the bundled bridge, which needs Node 24:

```json
{
  "mcpServers": {
    "whatsflare": {
      "command": "node",
      "args": [
        "/absolute/path/to/whatsflare/scripts/mcp-stdio.mjs",
        "--url", "https://wa.example.com",
        "--token", "owa_your_token"
      ]
    }
  }
}
```

The bridge also reads `WHATSFLARE_URL` / `WHATSFLARE_TOKEN` (or `MCP_URL` / `MCP_TOKEN`), so a
machine-wide env var can keep the token out of the config file.

**Smoke test:**

```bash
curl -s https://wa.example.com/mcp \
  -H "authorization: Bearer $TOKEN" \
  -H 'content-type: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'
```

## Limits

- `limit` is clamped to 1–50 (default 20); tool results are truncated at 40k characters.
- Text is capped at 4096 characters, the same as the REST API.
- `GET /mcp` returns `405`: this deployment offers no server-initiated stream.
- Responses are `application/json`; notifications get `202` with no body.

## Security notes

- A **full** token is admin-equivalent. Give agents a **send** token when they only need to message
  people; it cannot read a single chat.
- Message text and contact names flow into the model's context. Use a token whose session and chats
  you are comfortable exposing to that client.
- `?token=` works but ends up in logs and proxies; prefer the header.
- Adding a tool means updating `src/mcp.ts` and `scripts/mcp.spec.mjs`. Keep the module import-free so
  the spec runs under plain Node.
