import test from 'node:test';
import assert from 'node:assert/strict';

import { normalizeSequences, pruneAcked, selectMessages } from '../src/messages.ts';

/** Pure cursor contract used by the Apps Script drainer: deliver each message exactly once, in order. */

test('normalizeSequences numbers legacy rows in order and keeps existing seqs', () => {
  const result = normalizeSequences([{ id: 'a' }, { id: 'b', seq: 7 }, { id: 'c' }], 0);
  assert.deepEqual(result.rows.map(row => row.seq), [1, 7, 8]);
  assert.equal(result.maxSeq, 8);
  assert.equal(result.changed, true);
});

test('normalizeSequences is a no-op on already-numbered history', () => {
  const rows = [{ id: 'a', seq: 1 }, { id: 'b', seq: 5 }];
  const result = normalizeSequences(rows, 5);
  assert.equal(result.changed, false);
  assert.equal(result.maxSeq, 5);
  assert.deepEqual(result.rows, rows);
});

test('selectMessages returns only rows after the cursor, oldest first', () => {
  const history = [{ id: 'a', seq: 3 }, { id: 'b', seq: 4 }, { id: 'c', seq: 5 }];
  const page = selectMessages(history, 5, 3, 10);
  assert.deepEqual(page.messages.map(m => m.id), ['b', 'c']);
  assert.equal(page.nextCursor, 5);
  assert.equal(page.hasMore, false);
  assert.equal(page.oldestSeq, 3);
});

test('selectMessages caps at limit and reports hasMore', () => {
  const history = [{ id: 'a', seq: 1 }, { id: 'b', seq: 2 }, { id: 'c', seq: 3 }];
  const page = selectMessages(history, 3, 0, 2);
  assert.deepEqual(page.messages.map(m => m.id), ['a', 'b']);
  assert.equal(page.nextCursor, 2);
  assert.equal(page.hasMore, true);
});

test('nextCursor never moves backwards when nothing is pending', () => {
  const page = selectMessages([], 4, 9, 100);
  assert.deepEqual(page.messages, []);
  assert.equal(page.nextCursor, 9);
  assert.equal(page.oldestSeq, null);
});

test('nextCursor advances to msgSeq when the client has no cursor yet', () => {
  const page = selectMessages([], 12, 0, 100);
  assert.equal(page.nextCursor, 12);
});

test('pruneAcked drops rows at or below the acked sequence', () => {
  const history = [{ id: 'a', seq: 1 }, { id: 'b', seq: 2 }, { id: 'c', seq: 3 }];
  assert.deepEqual(pruneAcked(history, 2).map(m => m.id), ['c']);
  assert.deepEqual(pruneAcked(history, 0).map(m => m.id), ['a', 'b', 'c']);
});
