import test from 'node:test';
import assert from 'node:assert/strict';

import {
  csvToRows,
  enqueue,
  exportQueue,
  importQueue,
  openOutbox,
  queueToCsv,
  stats,
} from '../examples/outbox-cron/outbox.mjs';

/** Queue export/import is the "prepare a batch elsewhere" path; it must round-trip exactly. */

function fresh() {
  const db = openOutbox(':memory:');
  enqueue(db, { id: 'a', chatId: '9779800000000', text: 'hello, world' });
  enqueue(db, { id: 'b', chatId: '120363000000000001@g.us', text: 'line 1\nline 2 "quoted"' });
  return db;
}

test('exportQueue carries pending rows and skips sent history', () => {
  const db = fresh();
  db.prepare("UPDATE outbox SET status = 'sent' WHERE id = 'a'").run();
  const queue = exportQueue(db);
  assert.equal(queue.kind, 'openwa-outbox-export');
  assert.deepEqual(
    queue.rows.map(row => row.id),
    ['b'],
  );
  db.close();
});

test('importQueue is idempotent on id and queues the rows', () => {
  const source = fresh();
  const queue = exportQueue(source);
  source.close();

  const target = openOutbox(':memory:');
  const first = importQueue(target, queue);
  assert.equal(first.inserted, 2);
  assert.equal(first.skipped, 0);
  assert.deepEqual(stats(target), { queued: 2, sending: 0, sent: 0, failed: 0 });

  const second = importQueue(target, queue);
  assert.equal(second.inserted, 0);
  assert.equal(second.skipped, 2);
  target.close();
});

test('importQueue refuses rows without a chat or a body', () => {
  const db = openOutbox(':memory:');
  const result = importQueue(db, {
    rows: [
      { id: 'x', chat_id: '', text: 'no chat' },
      { id: 'y', chat_id: '9779800000000' },
      { id: 'z', chat_id: '9779800000000', text: 'ok' },
    ],
  });
  assert.deepEqual(result, { inserted: 1, skipped: 2 });
  db.close();
});

test('CSV export/import keeps commas, quotes and newlines intact', () => {
  const source = fresh();
  const csv = queueToCsv(exportQueue(source));
  source.close();

  const rows = csvToRows(csv);
  assert.equal(rows.length, 2);
  assert.equal(rows[0].text, 'hello, world');
  assert.equal(rows[1].text, 'line 1\nline 2 "quoted"');

  const target = openOutbox(':memory:');
  const result = importQueue(target, { rows });
  assert.deepEqual(result, { inserted: 2, skipped: 0 });
  const stored = target.prepare('SELECT text FROM outbox WHERE id = ?').get('b');
  assert.equal(stored.text, 'line 1\nline 2 "quoted"');
  target.close();
});

test('csvToRows tolerates a BOM and CRLF', () => {
  const rows = csvToRows('\uFEFFid,chat_id,text\r\n1,9779800000000,"hi, there"\r\n');
  assert.equal(rows.length, 1);
  assert.equal(rows[0].chat_id, '9779800000000');
  assert.equal(rows[0].text, 'hi, there');
});
