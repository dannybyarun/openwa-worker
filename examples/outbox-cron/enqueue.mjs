#!/usr/bin/env node
/**
 * Queue one message for the cron to send. Safe to re-run: pass the same `--id` (an invoice
 * number works well) and the second call is a no-op instead of a duplicate.
 *
 *   node enqueue.mjs --id invoice-INV-42 --phone 9779800000000 \
 *     --text "Invoice INV-42 — Rs 2500" --file invoices/INV-42.pdf
 *
 * Reads OPENWA_* only for consistency with the other scripts; enqueueing needs no credentials.
 */

import { openOutbox, enqueue } from './outbox.mjs';

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i += 1) {
    const item = argv[i];
    if (!item.startsWith('--')) continue;
    const key = item.slice(2);
    const next = argv[i + 1];
    if (!next || next.startsWith('--')) args[key] = 'true';
    else {
      args[key] = next;
      i += 1;
    }
  }
  return args;
}

const args = parseArgs(process.argv.slice(2));

if (args.help) {
  console.log(`Usage: node enqueue.mjs --phone <number> [options]

  --id <key>          idempotency key (default: random UUID)
  --phone / --chat    recipient number or JID (required)
  --text <body>       message text, or the document caption
  --file <path>       attach this file (PDF, XLSX, CSV…)
  --caption <text>    caption for the attachment (falls back to --text)
  --mimetype <type>   override the guessed MIME type
  --db <path>         outbox database (default ./outbox.sqlite)
`);
  process.exit(0);
}

const chatId = args.chat ?? args.phone ?? '';
const dbPath = args.db ?? process.env.OUTBOX_DB ?? './outbox.sqlite';

let result;
const db = openOutbox(dbPath);
try {
  result = enqueue(db, {
    id: args.id,
    chatId,
    text: args.text,
    filePath: args.file,
    caption: args.caption,
    mimetype: args.mimetype,
  });
} catch (error) {
  console.error(`enqueue failed: ${error.message}`);
  db.close();
  process.exit(2);
}
db.close();

const { inserted, row } = result;
console.log(
  inserted
    ? `queued ${row.id} → ${row.chat_id} (${row.file_path ? 'document' : 'text'})`
    : `already queued ${row.id} → ${row.chat_id} (status ${row.status})`,
);
console.log(JSON.stringify({ id: row.id, chatId: row.chat_id, status: row.status }, null, 2));
process.exitCode = 0;
