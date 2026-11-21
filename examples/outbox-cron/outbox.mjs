/**
 * A durable outbox for `POST /api/send`.
 *
 * Why an outbox instead of calling the gateway inline: a send can fail halfway (WhatsApp
 * disconnected, daily wake budget spent, a 5xx). Writing the intent to a row first means the
 * message survives restarts, is retried with backoff, and is never sent twice — the row keeps the
 * WhatsApp message id once it succeeds.
 *
 * Storage is `node:sqlite` (Node 22.5+, unflagged in 23.4). No dependencies. The table is small:
 * one row per message, a status, an attempt counter and the next time it may run.
 *
 * States:
 *   queued  → waiting (also where a crashed `sending` lease returns)
 *   sending → claimed by a drain; a lease (`next_attempt_at`) recovers it if the process dies
 *   sent    → done, `message_id` recorded, never retried
 *   failed  → permanent error or attempts exhausted; inspect and `requeueFailed()`
 */

import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { extname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

export const DEFAULTS = { batch: 50, maxAttempts: 5, leaseMs: 120_000 };

/** Errors that will not get better by retrying (bad token, chat not allowed, too large). */
const PERMANENT_STATUS = new Set([400, 401, 403, 404, 413, 415, 422]);

const MIME_BY_EXT = {
  '.pdf': 'application/pdf',
  '.csv': 'text/csv',
  '.txt': 'text/plain',
  '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  '.xls': 'application/vnd.ms-excel',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
};

/** Opens (and migrates) the outbox. Pass `':memory:'` for tests. */
export function openOutbox(path = './outbox.sqlite') {
  const db = new DatabaseSync(path);
  db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA busy_timeout = 5000');
  db.exec(`
    CREATE TABLE IF NOT EXISTS outbox (
      id             TEXT PRIMARY KEY,
      chat_id        TEXT NOT NULL,
      text           TEXT,
      file_path      TEXT,
      file_name      TEXT,
      mimetype       TEXT,
      caption        TEXT,
      status         TEXT NOT NULL DEFAULT 'queued',
      attempts       INTEGER NOT NULL DEFAULT 0,
      next_attempt_at INTEGER NOT NULL,
      message_id     TEXT,
      last_error     TEXT,
      created_at     INTEGER NOT NULL,
      updated_at     INTEGER NOT NULL
    )
  `);
  db.exec('CREATE INDEX IF NOT EXISTS outbox_due ON outbox(status, next_attempt_at)');
  return db;
}

/**
 * Adds one message. Reusing `id` (an invoice number is ideal) is the idempotency key: a second
 * enqueue is a no-op and reports the existing row, so a retried webhook cannot double-send.
 */
export function enqueue(db, input) {
  const chatId = String(input?.chatId ?? '').trim();
  const text = typeof input?.text === 'string' ? input.text.trim() : '';
  const filePath = typeof input?.filePath === 'string' ? input.filePath.trim() : '';
  if (!chatId) throw new Error('chatId is required');
  if (!text && !filePath) throw new Error('text or filePath is required');

  const now = Date.now();
  const id = (typeof input.id === 'string' && input.id.trim()) || randomUUID();
  const fileName = filePath ? String(input.fileName ?? filePath.split(/[\\/]/).pop() ?? 'document') : null;
  const mimetype = filePath
    ? String(input.mimetype ?? MIME_BY_EXT[extname(fileName).toLowerCase()] ?? 'application/octet-stream')
    : null;
  const caption = typeof input.caption === 'string' && input.caption.trim() ? input.caption.trim() : null;

  const info = db
    .prepare(
      `INSERT INTO outbox
         (id, chat_id, text, file_path, file_name, mimetype, caption, status, attempts,
          next_attempt_at, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'queued', 0, ?, ?, ?)
       ON CONFLICT(id) DO NOTHING`,
    )
    .run(id, chatId, text || null, filePath || null, fileName, mimetype, caption, now, now, now);

  const row = db.prepare('SELECT * FROM outbox WHERE id = ?').get(id);
  return { inserted: info.changes === 1, row };
}

/**
 * Claims due rows in one statement and leases them. A row stuck in `sending` whose lease has
 * expired (the process crashed mid-send) is picked up again — at the cost of a possible duplicate,
 * which is why the caller should keep `id` stable and reconcile on `message_id`.
 */
export function claimDue(db, { batch = DEFAULTS.batch, leaseMs = DEFAULTS.leaseMs, now = Date.now() } = {}) {
  return db
    .prepare(
      `UPDATE outbox
          SET status = 'sending', attempts = attempts + 1, next_attempt_at = ?, updated_at = ?
        WHERE id IN (
          SELECT id FROM outbox
           WHERE status = 'queued' OR (status = 'sending' AND next_attempt_at <= ?)
           ORDER BY created_at
           LIMIT ?
        )
        RETURNING *`,
    )
    .all(now + leaseMs, now, now, batch);
}

export function markSent(db, id, messageId, now = Date.now()) {
  db.prepare(
    `UPDATE outbox SET status = 'sent', message_id = ?, last_error = NULL,
        next_attempt_at = 0, updated_at = ? WHERE id = ?`,
  ).run(messageId ?? null, now, id);
}

/** Back to `queued`. `discountAttempt` is for quota 429s: waiting for the daily reset is not a failure. */
export function markRetry(db, id, { error, at, discountAttempt = false, now = Date.now() }) {
  if (discountAttempt) {
    db.prepare(
      `UPDATE outbox SET status = 'queued', last_error = ?, next_attempt_at = ?,
          attempts = MAX(0, attempts - 1), updated_at = ? WHERE id = ?`,
    ).run(error ?? 'retry', at, now, id);
    return;
  }
  db.prepare(
    `UPDATE outbox SET status = 'queued', last_error = ?, next_attempt_at = ?, updated_at = ?
      WHERE id = ?`,
  ).run(error ?? 'retry', at, now, id);
}

export function markFailed(db, id, error, now = Date.now()) {
  db.prepare(
    `UPDATE outbox SET status = 'failed', last_error = ?, updated_at = ? WHERE id = ?`,
  ).run(error ?? 'unknown error', now, id);
}

/** Moves every `failed` row back to `queued` (after fixing a token or a bad number). */
export function requeueFailed(db, now = Date.now()) {
  return db
    .prepare(
      `UPDATE outbox SET status = 'queued', attempts = 0, next_attempt_at = ?,
          last_error = NULL, updated_at = ? WHERE status = 'failed'`,
    )
    .run(now, now).changes;
}

export function stats(db) {
  const out = { queued: 0, sending: 0, sent: 0, failed: 0 };
  for (const row of db.prepare('SELECT status, COUNT(*) AS n FROM outbox GROUP BY status').all()) {
    out[row.status] = Number(row.n);
  }
  return out;
}

export function nextAttemptAt(db) {
  const row = db.prepare(`SELECT MIN(next_attempt_at) AS at FROM outbox WHERE status = 'queued'`).get();
  return row?.at ?? null;
}

export function listRows(db, limit = 20) {
  return db
    .prepare(`SELECT * FROM outbox ORDER BY created_at DESC LIMIT ?`)
    .all(limit)
    .map(row => ({ ...row }));
}

/* ---------- export / import ---------- */

/** Columns that travel between hosts; runtime fields (attempts, message_id) are rebuilt. */
const QUEUE_COLUMNS = [
  'id',
  'chat_id',
  'text',
  'file_path',
  'file_name',
  'mimetype',
  'caption',
  'status',
];

/**
 * Serializes the queue so a batch can be prepared offline (or moved between machines).
 * Import resets the rows to `queued`, so exporting `sent` history and re-importing it would
 * send again — that is why the default export is the pending work.
 */
export function exportQueue(db, { statuses = ['queued', 'sending', 'failed'] } = {}) {
  const placeholders = statuses.map(() => '?').join(', ');
  const rows = db
    .prepare(`SELECT * FROM outbox WHERE status IN (${placeholders}) ORDER BY created_at`)
    .all(...statuses);
  return {
    kind: 'openwa-outbox-export',
    version: 1,
    exportedAt: new Date().toISOString(),
    rows: rows.map(row => ({ ...row })),
  };
}

/** Adds rows from an export file. Existing ids are kept (idempotent), new ids are queued now. */
export function importQueue(db, payload) {
  const rows = Array.isArray(payload) ? payload : payload?.rows;
  if (!Array.isArray(rows)) throw new Error('expected a JSON export with a rows array');
  const insert = db.prepare(
    `INSERT INTO outbox
       (id, chat_id, text, file_path, file_name, mimetype, caption, status, attempts,
        next_attempt_at, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, 'queued', 0, ?, ?, ?)
     ON CONFLICT(id) DO NOTHING`,
  );
  const now = Date.now();
  let inserted = 0;
  let skipped = 0;
  for (const row of rows) {
    const chatId = String(row.chat_id ?? row.chatId ?? '').trim();
    const text = typeof row.text === 'string' && row.text ? row.text : null;
    const filePath = typeof row.file_path === 'string' && row.file_path ? row.file_path : null;
    if (!chatId || (!text && !filePath)) {
      skipped += 1;
      continue;
    }
    const id = String(row.id || randomUUID());
    const fileName = filePath
      ? String(row.file_name ?? filePath.split(/[\\/]/).pop() ?? 'document')
      : null;
    const mimetype = filePath
      ? String(row.mimetype ?? MIME_BY_EXT[extname(fileName).toLowerCase()] ?? 'application/octet-stream')
      : null;
    const caption = typeof row.caption === 'string' && row.caption.trim() ? row.caption.trim() : null;
    const info = insert.run(id, chatId, text, filePath, fileName, mimetype, caption, now, now, now);
    if (info.changes === 1) inserted += 1;
    else skipped += 1;
  }
  return { inserted, skipped };
}

/** One CSV cell with the quoting Sheets/Excel expect. */
function csvCell(value) {
  const text = value === null || value === undefined ? '' : String(value);
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

/** CSV for spreadsheet editing: one row per queued message. */
export function queueToCsv(queue) {
  const lines = [QUEUE_COLUMNS.join(',')];
  for (const row of queue.rows) {
    lines.push(QUEUE_COLUMNS.map(key => csvCell(row[key])).join(','));
  }
  return `${lines.join('\r\n')}\r\n`;
}

/** RFC 4180 reader: handles quoted cells, embedded commas, newlines and doubled quotes. */
export function csvToRows(text) {
  const rows = [];
  let row = [];
  let cell = '';
  let quoted = false;
  const source = String(text).replace(/^\uFEFF/, '');
  for (let i = 0; i < source.length; i += 1) {
    const char = source[i];
    if (quoted) {
      if (char === '"') {
        if (source[i + 1] === '"') {
          cell += '"';
          i += 1;
        } else {
          quoted = false;
        }
      } else {
        cell += char;
      }
      continue;
    }
    if (char === '"') quoted = true;
    else if (char === ',') {
      row.push(cell);
      cell = '';
    } else if (char === '\n' || char === '\r') {
      if (char === '\r' && source[i + 1] === '\n') i += 1;
      row.push(cell);
      if (row.some(value => value !== '')) rows.push(row);
      row = [];
      cell = '';
    } else {
      cell += char;
    }
  }
  row.push(cell);
  if (row.some(value => value !== '')) rows.push(row);
  if (rows.length === 0) return [];
  const headers = rows[0].map(header => header.trim());
  return rows.slice(1).map(values => {
    const out = {};
    headers.forEach((header, index) => {
      out[header] = values[index] ?? '';
    });
    return out;
  });
}

/** Next 00:00 UTC plus a little jitter: both the token quota and the wake budget reset then. */
export function nextUtcMidnight(now = Date.now()) {
  const date = new Date(now);
  const midnight = Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate() + 1);
  return midnight + Math.floor(Math.random() * 60_000);
}

/** 30 s, 60 s, 2 m, 4 m… capped at an hour, with jitter so parallel drains don't sync. */
export function backoff(now, attempt) {
  const seconds = Math.min(3600, 30 * 2 ** Math.max(0, attempt - 1));
  return now + seconds * 1000 + Math.floor(Math.random() * 5_000);
}

/**
 * Sends everything that is due, oldest first, and returns a summary. Batches share one
 * connected window because `/api/send` keeps the session awake for `IDLE_TTL_MS` after the first
 * call — so 20 invoices cost roughly one wake, not twenty.
 */
export async function drainOnce(db, options) {
  const {
    url,
    token,
    batch = DEFAULTS.batch,
    maxAttempts = DEFAULTS.maxAttempts,
    leaseMs = DEFAULTS.leaseMs,
    now = Date.now(),
    fetchImpl = fetch,
    log = () => {},
  } = options ?? {};
  if (!url) throw new Error('url is required');
  if (!token) throw new Error('token is required');

  const base = url.replace(/\/+$/, '');
  const claimed = claimDue(db, { batch, leaseMs, now });
  const summary = { claimed: claimed.length, sent: 0, retried: 0, failed: 0, nextAttemptAt: null };

  for (const row of claimed) {
    let file;
    if (row.file_path) {
      try {
        file = await readFile(row.file_path);
      } catch (error) {
        markFailed(db, row.id, `cannot read ${row.file_path}: ${error.message}`, now);
        summary.failed += 1;
        log(`failed ${row.id}: unreadable file`);
        continue;
      }
    }

    const payload = { token, chatId: row.chat_id };
    if (row.file_path) {
      payload.document = {
        fileName: row.file_name,
        mimetype: row.mimetype,
        caption: row.caption ?? row.text ?? undefined,
        base64: file.toString('base64'),
      };
    } else {
      payload.text = row.text;
    }

    let response;
    try {
      response = await fetchImpl(`${base}/api/send`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(payload),
      });
    } catch (error) {
      const message = `network: ${error.message}`;
      if (row.attempts >= maxAttempts) {
        markFailed(db, row.id, `giving up after ${row.attempts} attempts: ${message}`, now);
        summary.failed += 1;
      } else {
        const at = backoff(now, row.attempts);
        markRetry(db, row.id, { error: message, at, now });
        summary.retried += 1;
        summary.nextAttemptAt = Math.min(summary.nextAttemptAt ?? at, at);
      }
      log(`retry ${row.id}: ${message}`);
      continue;
    }

    const body = await response.json().catch(() => ({}));
    if (response.ok && body?.ok !== false) {
      markSent(db, row.id, body?.id, now);
      summary.sent += 1;
      log(`sent ${row.id} → ${row.chat_id}${body?.id ? ` (${body.id})` : ''}`);
      continue;
    }

    const message = String(body?.error ?? response.statusText ?? `HTTP ${response.status}`);
    if (PERMANENT_STATUS.has(response.status)) {
      markFailed(db, row.id, message, now);
      summary.failed += 1;
      log(`failed ${row.id}: ${message}`);
      continue;
    }
    if (response.status === 429) {
      const at = nextUtcMidnight(now);
      markRetry(db, row.id, { error: message, at, discountAttempt: true, now });
      summary.retried += 1;
      summary.nextAttemptAt = Math.min(summary.nextAttemptAt ?? at, at);
      log(`quota ${row.id}: retry after ${new Date(at).toISOString()}`);
      continue;
    }
    if (row.attempts >= maxAttempts) {
      markFailed(db, row.id, `giving up after ${row.attempts} attempts: ${message}`, now);
      summary.failed += 1;
      log(`failed ${row.id}: ${message}`);
      continue;
    }
    const at = backoff(now, row.attempts);
    markRetry(db, row.id, { error: message, at, now });
    summary.retried += 1;
    summary.nextAttemptAt = Math.min(summary.nextAttemptAt ?? at, at);
    log(`retry ${row.id}: ${message}`);
  }

  return summary;
}
