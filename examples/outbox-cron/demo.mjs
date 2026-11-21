#!/usr/bin/env node
/**
 * End-to-end demo with an in-process mock gateway: no credentials, no network.
 *
 *   node demo.mjs
 *
 * Proves the properties the outbox exists for: idempotent enqueue, a PDF attachment, retry after a
 * 5xx, and a clean second drain that does not resend anything.
 */

import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildInvoicePdf } from '../invoice-send/pdf.mjs';
import { drainOnce, enqueue, listRows, openOutbox, stats } from './outbox.mjs';

const calls = [];
let failuresLeft = 1;

const server = createServer((request, response) => {
  const chunks = [];
  request.on('data', chunk => chunks.push(chunk));
  request.on('end', () => {
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
    calls.push({ chatId: body.chatId, kind: body.document ? 'document' : 'text' });

    if (body.chatId === '9779811111111@s.whatsapp.net' && failuresLeft-- > 0) {
      response.writeHead(500, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ error: 'mock gateway exploded' }));
      return;
    }
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ ok: true, id: `MOCK-${calls.length}`, chatId: body.chatId }));
  });
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const url = `http://127.0.0.1:${server.address().port}`;

const dir = await mkdtemp(join(tmpdir(), 'outbox-demo-'));
const pdfPath = join(dir, 'invoice-INV-7.pdf');
await writeFile(pdfPath, buildInvoicePdf({ number: 'INV-7', amount: '3200.00', customer: 'Demo' }));

const db = openOutbox(':memory:');

const first = enqueue(db, {
  id: 'invoice-INV-7',
  chatId: '9779800000000',
  text: 'Invoice INV-7 attached',
  filePath: pdfPath,
  caption: 'Invoice INV-7 — Rs 3200.00',
});
assert.equal(first.inserted, true);

const duplicate = enqueue(db, {
  id: 'invoice-INV-7',
  chatId: '9779800000000',
  text: 'Invoice INV-7 attached',
  filePath: pdfPath,
});
assert.equal(duplicate.inserted, false);
assert.equal(duplicate.row.id, 'invoice-INV-7');

enqueue(db, { id: 'receipt-9', chatId: '9779800000000', text: 'Receipt 9' });
enqueue(db, { id: 'flaky-1', chatId: '9779811111111@s.whatsapp.net', text: 'This one 500s once' });

assert.deepEqual(stats(db), { queued: 3, sending: 0, sent: 0, failed: 0 });

console.log('drain 1:');
const firstRun = await drainOnce(db, {
  url,
  token: 'owa_demo_only',
  log: line => console.log(`  ${line}`),
});
assert.deepEqual(
  { claimed: firstRun.claimed, sent: firstRun.sent, retried: firstRun.retried, failed: firstRun.failed },
  { claimed: 3, sent: 2, retried: 1, failed: 0 },
);
assert.deepEqual(stats(db), { queued: 1, sending: 0, sent: 2, failed: 0 });

console.log('drain 2 (jump 5 minutes ahead, retry is due):');
const secondRun = await drainOnce(db, {
  url,
  token: 'owa_demo_only',
  now: Date.now() + 5 * 60_000,
  log: line => console.log(`  ${line}`),
});
assert.equal(secondRun.claimed, 1);
assert.equal(secondRun.sent, 1);
assert.deepEqual(stats(db), { queued: 0, sending: 0, sent: 3, failed: 0 });

assert.equal(calls.length, 4, 'three first-pass calls plus one retry');
assert.equal(calls.filter(call => call.kind === 'document').length, 1, 'the PDF went out exactly once');

console.log('\nfinal outbox:');
for (const row of listRows(db, 10)) {
  console.log(`  ${row.id.padEnd(14)} ${row.status.padEnd(4)} attempts=${row.attempts} ${row.message_id ?? ''}`);
}

server.close();
db.close();
console.log(`\nOK — ${calls.length} gateway calls, mock server on ${url}`);
