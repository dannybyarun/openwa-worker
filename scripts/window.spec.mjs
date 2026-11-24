import test from 'node:test';
import assert from 'node:assert/strict';

import { slideWindow } from '../src/window.ts';

const TTL = 60_000;
const MAX = 5 * 60_000;
// Real clocks are nowhere near zero; using a plausible epoch keeps `windowStart` distinguishable
// from the "no window open" sentinel.
const BASE = 1_763_000_000_000;
const open = (now = BASE) =>
  slideWindow({ now, windowStart: 0, activeUntil: 0, ttlMs: TTL, maxMs: MAX });

test('a fresh window opens for one ttl', () => {
  const w = open();
  assert.equal(w.windowStart, BASE);
  assert.equal(w.activeUntil, BASE + TTL);
  assert.equal(w.delayMs, TTL);
});

test('activity inside a live window slides the close time', () => {
  const opened = open();
  const poked = slideWindow({ now: BASE + 45_000, ...opened, ttlMs: TTL, maxMs: MAX });
  assert.equal(poked.windowStart, BASE, 'the window itself did not restart');
  assert.equal(poked.activeUntil, BASE + 105_000, 'now + ttl');
  assert.equal(poked.delayMs, TTL);
});

test('sliding stops at the ceiling', () => {
  let state = open();
  // A pull every 30 s: the window slides, but never past opened-at + 5 minutes.
  for (let t = 30_000; t <= 290_000; t += 30_000) {
    state = slideWindow({ now: BASE + t, ...state, ttlMs: TTL, maxMs: MAX });
  }
  assert.equal(state.activeUntil, BASE + MAX);
});

test('a puller on a tight loop cannot extend past the ceiling', () => {
  let state = open();
  let highest = state.activeUntil;
  for (let t = 5_000; t < 295_000; t += 5_000) {
    if (t >= state.activeUntil) continue; // a closed window cannot be reopened by a pull
    state = slideWindow({ now: BASE + t, ...state, ttlMs: TTL, maxMs: MAX });
    highest = Math.max(highest, state.activeUntil);
  }
  assert.equal(highest, BASE + MAX, '58 pulls inside one wake never pass the cap');
});

test('an expired window starts a fresh one with a fresh ceiling', () => {
  const old = { windowStart: BASE - 90_000, activeUntil: BASE - 30_000 };
  const rere = slideWindow({ now: BASE, ...old, ttlMs: TTL, maxMs: MAX });
  assert.equal(rere.windowStart, BASE);
  assert.equal(rere.activeUntil, BASE + TTL);
});

test('fresh: true restarts the ceiling even inside a live window', () => {
  const opened = open();
  const rewoken = slideWindow({ now: BASE + 200_000, ...opened, ttlMs: TTL, maxMs: MAX, fresh: true });
  assert.equal(rewoken.windowStart, BASE + 200_000);
  assert.equal(rewoken.activeUntil, BASE + 260_000);
});

test('a ceiling below one ttl is raised to the ttl', () => {
  const w = slideWindow({ now: BASE, windowStart: 0, activeUntil: 0, ttlMs: TTL, maxMs: 1_000 });
  assert.equal(w.activeUntil, BASE + TTL);
});

test('a window already past its deadline never reports a negative delay', () => {
  const stale = { windowStart: BASE, activeUntil: BASE - 1 };
  const w = slideWindow({ now: BASE + 5_000, ...stale, ttlMs: TTL, maxMs: MAX });
  assert.ok(w.delayMs >= 0);
  assert.equal(w.windowStart, BASE + 5_000, 'a stale window is reopened, not resurrected');
});
