import test from 'node:test';
import assert from 'node:assert/strict';

import {
  EMBED_DAILY_LIMIT,
  MAX_TOKEN_CHATS,
  MAX_TOKEN_DAYS,
  SEND_DAILY_LIMIT,
  chatAllowed,
  dailyLimitFor,
  expiryFor,
  hashToken,
  isTokenValue,
  newTokenValue,
  normalizeChatIds,
  normalizeOrigins,
  originAllowed,
  publicToken,
} from '../src/tokens.ts';

test('newTokenValue looks like an OpenWA token and is unique', () => {
  const first = newTokenValue();
  const second = newTokenValue();
  assert.equal(isTokenValue(first), true);
  assert.equal(isTokenValue(second), true);
  assert.notEqual(first, second);
  assert.equal(first.startsWith('owa_'), true);
});

test('isTokenValue rejects the shared API token shape and junk', () => {
  // A legacy/shared API_TOKEN shape: long, url-safe, but not a managed `owa_` token.
  assert.equal(isTokenValue('AbCdEfGhIjKlMnOpQrStUvWxYz0123456789-_abcd'), false);
  assert.equal(isTokenValue('owa_short'), false);
  assert.equal(isTokenValue(null), false);
  assert.equal(isTokenValue(123), false);
});

test('hashToken is stable, hex, and does not leak the value', async () => {
  const value = newTokenValue();
  const hash = await hashToken(value);
  assert.match(hash, /^[0-9a-f]{64}$/);
  assert.equal(await hashToken(value), hash);
  assert.notEqual(hash, value);
  assert.notEqual(await hashToken(newTokenValue()), hash);
});

test('normalizeOrigins keeps valid origins, deduped, and ignores wildcards', () => {
  assert.deepEqual(
    normalizeOrigins('https://example.com, http://shop.example.com/path, *, not a url'),
    ['https://example.com', 'http://shop.example.com'],
  );
  assert.deepEqual(normalizeOrigins(['https://a.test', 'https://a.test']), ['https://a.test']);
  assert.deepEqual(normalizeOrigins(undefined), []);
  assert.deepEqual(normalizeOrigins(['ftp://files.test']), []);
});

test('originAllowed: empty allowlist means any site, otherwise an exact match', () => {
  assert.equal(originAllowed([], 'https://anywhere.test'), true);
  assert.equal(originAllowed([], null), true);
  assert.equal(originAllowed(['https://example.com'], 'https://example.com'), true);
  assert.equal(originAllowed(['https://example.com'], 'https://example.com/'), true);
  assert.equal(originAllowed(['https://example.com'], 'https://evil.test'), false);
  assert.equal(originAllowed(['https://example.com'], null), false);
});

test('publicToken strips the hash and the daily counters', () => {
  const stored = {
    id: 't1',
    label: 'Website chat',
    kind: 'embed',
    prefix: 'owa_abcdefg',
    hash: 'deadbeef',
    origins: ['https://example.com'],
    createdAt: '2026-01-01T00:00:00.000Z',
    day: '2026-01-01',
    usesToday: 3,
  };
  const safe = publicToken(stored);
  assert.equal('hash' in safe, false);
  assert.equal('day' in safe, false);
  assert.equal('usesToday' in safe, false);
  assert.equal(safe.id, 't1');
  assert.equal(safe.kind, 'embed');
});

test('expiryFor clamps to a year and ignores non-positive values', () => {
  const now = Date.parse('2026-01-01T00:00:00.000Z');
  assert.equal(expiryFor(0, now), undefined);
  assert.equal(expiryFor(-5, now), undefined);
  assert.equal(expiryFor('nope', now), undefined);

  const tenDays = expiryFor(10, now);
  assert.equal(tenDays, new Date(now + 10 * 86_400_000).toISOString());

  const forever = expiryFor(10_000, now);
  assert.equal(forever, new Date(now + MAX_TOKEN_DAYS * 86_400_000).toISOString());
});

test('the embed daily limit is a small, documented number', () => {
  assert.equal(EMBED_DAILY_LIMIT, 50);
});

test('dailyLimitFor caps send at 500, embed at 50, and leaves full uncapped', () => {
  assert.equal(dailyLimitFor('send'), SEND_DAILY_LIMIT);
  assert.equal(dailyLimitFor('embed'), EMBED_DAILY_LIMIT);
  assert.equal(dailyLimitFor('full'), 0);
  assert.equal(SEND_DAILY_LIMIT, 500);
  assert.equal(SEND_DAILY_LIMIT > EMBED_DAILY_LIMIT, true);
});

test('normalizeChatIds turns numbers into JIDs and keeps full addresses', () => {
  assert.deepEqual(normalizeChatIds('9779800000000, +977 981-2345678'), [
    '9779800000000@s.whatsapp.net',
    '9779812345678@s.whatsapp.net',
  ]);
  assert.deepEqual(
    normalizeChatIds(['120363025246125497@g.us', '273272243511359@lid']),
    ['120363025246125497@g.us', '273272243511359@lid'],
  );
  assert.deepEqual(normalizeChatIds('9779800000000, 9779800000000'), ['9779800000000@s.whatsapp.net']);
  assert.deepEqual(normalizeChatIds('nope, @@@, ftp://x'), []);
  assert.deepEqual(normalizeChatIds(undefined), []);
});

test('normalizeChatIds caps the allowlist', () => {
  const many = Array.from({ length: MAX_TOKEN_CHATS + 10 }, (_, index) => `${9779800000000 + index}`);
  assert.equal(normalizeChatIds(many).length, MAX_TOKEN_CHATS);
});

test('chatAllowed: empty allowlist means any chat', () => {
  assert.equal(chatAllowed([], '9779800000000@s.whatsapp.net'), true);
  assert.equal(chatAllowed(undefined, '9779800000000@s.whatsapp.net'), true);
  assert.equal(chatAllowed(['9779800000000@s.whatsapp.net'], '9779800000000@s.whatsapp.net'), true);
  assert.equal(chatAllowed(['9779800000000@s.whatsapp.net'], '9779811111111@s.whatsapp.net'), false);
});
