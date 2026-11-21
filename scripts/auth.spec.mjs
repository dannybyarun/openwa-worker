import test from 'node:test';
import assert from 'node:assert/strict';

import {
  authRequired,
  authSecret,
  clearLoginFailures,
  clearSessionCookie,
  createSessionToken,
  loginBlocked,
  loginPassword,
  readCookie,
  recordLoginFailure,
  SESSION_COOKIE,
  sessionCookie,
  sessionTtlSeconds,
  verifySessionToken,
} from '../src/auth.ts';

/**
 * The browser login gate: a password exchanged for an HMAC-signed, expiring cookie.
 * Nothing here touches the network, so these run anywhere.
 */

const NOW = Date.UTC(2026, 0, 1);

test('auth is optional until a secret is configured', () => {
  assert.equal(authRequired({}), false);
  assert.equal(authSecret({}), undefined);
  assert.equal(authRequired({ API_TOKEN: 'tok' }), true);
  assert.equal(authRequired({ UI_PASSWORD: 'pw' }), true);
});

test('UI_PASSWORD wins over API_TOKEN for the login and the signing key', () => {
  assert.equal(authSecret({ API_TOKEN: 'tok', UI_PASSWORD: 'pw' }), 'pw');
  assert.equal(loginPassword({ API_TOKEN: 'tok', UI_PASSWORD: 'pw' }), 'pw');
  assert.equal(loginPassword({ API_TOKEN: 'tok' }), 'tok');
});

test('session lifetime defaults to 7 days and is clamped', () => {
  assert.equal(sessionTtlSeconds({}), 168 * 3600);
  assert.equal(sessionTtlSeconds({ SESSION_TTL_HOURS: '12' }), 12 * 3600);
  assert.equal(sessionTtlSeconds({ SESSION_TTL_HOURS: '99999' }), 720 * 3600);
  assert.equal(sessionTtlSeconds({ SESSION_TTL_HOURS: 'nope' }), 168 * 3600);
  assert.equal(sessionTtlSeconds({ SESSION_TTL_HOURS: '-3' }), 168 * 3600);
});

test('a signed token verifies until it expires', async () => {
  const { token, expiresAt } = await createSessionToken('secret', 3600, NOW);
  assert.equal(expiresAt, NOW + 3600 * 1000);
  assert.equal(await verifySessionToken('secret', token, NOW), true);
  assert.equal(await verifySessionToken('secret', token, NOW + 3599 * 1000), true);
  assert.equal(await verifySessionToken('secret', token, NOW + 3600 * 1000), false);
});

test('tampered, malformed and foreign tokens are rejected', async () => {
  const { token } = await createSessionToken('secret', 3600, NOW);
  const [prefix, exp, signature] = token.split('.');
  assert.equal(await verifySessionToken('secret', `${prefix}.${Number(exp) + 60}.${signature}`, NOW), false);
  assert.equal(await verifySessionToken('other-secret', token, NOW), false);
  assert.equal(await verifySessionToken('secret', signature, NOW), false);
  assert.equal(await verifySessionToken('secret', 'v2.9999999999.abc', NOW), false);
  assert.equal(await verifySessionToken('secret', 'v1.notanumber.abc', NOW), false);
  // A forged expiry without a matching signature must not pass.
  const forged = `v1.${Math.floor(NOW / 1000) + 999}.${Buffer.from('nope').toString('base64url')}`;
  assert.equal(await verifySessionToken('secret', forged, NOW), false);
});

test('cookies round-trip and are HttpOnly', () => {
  const cookie = sessionCookie('v1.123.sig', 60, true);
  assert.match(cookie, new RegExp(`^${SESSION_COOKIE}=`));
  assert.match(cookie, /HttpOnly/);
  assert.match(cookie, /SameSite=Lax/);
  assert.match(cookie, /Max-Age=60/);
  assert.match(cookie, /Secure/);
  assert.doesNotMatch(sessionCookie('v1.123.sig', 60, false), /Secure/);

  const cleared = clearSessionCookie(false);
  assert.match(cleared, /Max-Age=0/);
  assert.doesNotMatch(cleared, /Secure/);
});

test('readCookie finds the session cookie among others', () => {
  const request = new Request('https://wa.example.com/api/sessions', {
    headers: { cookie: `theme=dark; ${SESSION_COOKIE}=v1.10.sig; other=1` },
  });
  assert.equal(readCookie(request, SESSION_COOKIE), 'v1.10.sig');
  assert.equal(readCookie(request, 'missing'), undefined);
  assert.equal(readCookie(new Request('https://wa.example.com/'), SESSION_COOKIE), undefined);
});

test('password guessing is throttled after ten failures', () => {
  const ip = '203.0.113.10';
  for (let i = 0; i < 9; i++) recordLoginFailure(ip, NOW);
  assert.equal(loginBlocked(ip, NOW), 0);
  recordLoginFailure(ip, NOW);
  assert.ok(loginBlocked(ip, NOW) > 0);
  // The window rolls over and the caller may try again.
  assert.equal(loginBlocked(ip, NOW + 10 * 60 * 1000), 0);
  assert.equal(loginBlocked(ip, NOW + 10 * 60 * 1000), 0);
});

test('a successful login clears earlier failures for that address', () => {
  const ip = '203.0.113.11';
  for (let i = 0; i < 10; i++) recordLoginFailure(ip, NOW);
  assert.ok(loginBlocked(ip, NOW) > 0);
  clearLoginFailures(ip);
  assert.equal(loginBlocked(ip, NOW), 0);
  assert.equal(loginBlocked('203.0.113.12', NOW), 0);
});
