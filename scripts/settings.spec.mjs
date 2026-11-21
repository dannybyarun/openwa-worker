import test from 'node:test';
import assert from 'node:assert/strict';

import {
  DEFAULT_AUTO_REPLY_COOLDOWN,
  DEFAULT_AUTO_REPLY_DAILY,
  MAX_AUTO_REPLY_COOLDOWN,
  MIN_AUTO_REPLY_COOLDOWN,
  normalizeBaseUrl,
  normalizeSettings,
  publicSettings,
  resolveAi,
  validCustomModel,
  validModel,
} from '../src/settings.ts';
import { chatCompletionsUrl } from '../src/ai.ts';

const FALLBACK = '@cf/meta/llama-4-scout-17b-16e-instruct';

test('validModel accepts Workers AI ids and rejects junk', () => {
  assert.equal(validModel('@cf/meta/llama-4-scout-17b-16e-instruct'), '@cf/meta/llama-4-scout-17b-16e-instruct');
  assert.equal(validModel('  @cf/openai/gpt-oss-20b  '), '@cf/openai/gpt-oss-20b');
  assert.equal(validModel('llama-4-scout'), undefined);
  assert.equal(validModel('@cf/'), undefined);
  assert.equal(validModel(42), undefined);
  assert.equal(validModel(null), undefined);
});

test('validCustomModel accepts OpenAI-compatible names', () => {
  assert.equal(validCustomModel('gpt-4o-mini'), 'gpt-4o-mini');
  assert.equal(validCustomModel(' llama3.1:8b '), 'llama3.1:8b');
  assert.equal(validCustomModel('meta-llama/Llama-3-8B'), 'meta-llama/Llama-3-8B');
  assert.equal(validCustomModel('@cf/meta/x'), '@cf/meta/x');
  assert.equal(validCustomModel('has spaces'), undefined);
  assert.equal(validCustomModel(''), undefined);
  assert.equal(validCustomModel(undefined), undefined);
});

test('normalizeBaseUrl keeps http(s) origins with the path and drops trailing slashes', () => {
  assert.equal(normalizeBaseUrl('https://api.openai.com/v1/'), 'https://api.openai.com/v1');
  assert.equal(normalizeBaseUrl('http://localhost:11434/v1'), 'http://localhost:11434/v1');
  assert.equal(normalizeBaseUrl('https://openrouter.ai/api/v1'), 'https://openrouter.ai/api/v1');
  assert.equal(normalizeBaseUrl('ftp://files.test/v1'), undefined);
  assert.equal(normalizeBaseUrl('not a url'), undefined);
  assert.equal(normalizeBaseUrl(null), undefined);
});

test('chatCompletionsUrl accepts a base URL or the full endpoint', () => {
  assert.equal(chatCompletionsUrl('https://api.openai.com/v1'), 'https://api.openai.com/v1/chat/completions');
  assert.equal(chatCompletionsUrl('https://api.openai.com/v1/'), 'https://api.openai.com/v1/chat/completions');
  assert.equal(
    chatCompletionsUrl('http://localhost:11434/v1/chat/completions'),
    'http://localhost:11434/v1/chat/completions',
  );
});

test('normalizeSettings keeps the previous AI block when the patch does not mention it', () => {
  const current = { ai: { provider: 'workers-ai', model: '@cf/meta/llama-3.3-70b-instruct-fp8-fast' } };
  const next = normalizeSettings(current, { autoReply: { enabled: true } });
  assert.equal(next.ai?.model, '@cf/meta/llama-3.3-70b-instruct-fp8-fast');
  assert.equal(next.autoReply?.enabled, true);
});

test('normalizeSettings switches to an OpenAI-compatible provider', () => {
  const next = normalizeSettings({}, {
    ai: {
      provider: 'openai',
      model: 'gpt-4o-mini',
      baseUrl: 'https://api.openai.com/v1/',
      apiKey: '  sk-test-1234  ',
    },
  });
  assert.deepEqual(next.ai, {
    provider: 'openai',
    model: 'gpt-4o-mini',
    baseUrl: 'https://api.openai.com/v1',
    apiKey: 'sk-test-1234',
  });
});

test('normalizeSettings drops a Workers AI model that is not an @scope/name id', () => {
  const next = normalizeSettings({}, { ai: { provider: 'workers-ai', model: 'gpt-4o-mini' } });
  assert.equal(next.ai?.model, undefined);
});

test('normalizeSettings keeps the stored API key unless the patch clears it', () => {
  const current = {
    ai: { provider: 'openai', model: 'gpt-4o-mini', baseUrl: 'https://x.test/v1', apiKey: 'sk-keep' },
  };
  const kept = normalizeSettings(current, { ai: { provider: 'openai', model: 'gpt-4.1-mini' } });
  assert.equal(kept.ai?.apiKey, 'sk-keep');

  const cleared = normalizeSettings(current, { ai: { provider: 'openai', apiKey: null } });
  assert.equal(cleared.ai?.apiKey, null);

  const blanked = normalizeSettings(current, { ai: { provider: 'openai', apiKey: '   ' } });
  assert.equal(blanked.ai?.apiKey, null);
});

test('normalizeSettings clears the AI block entirely on null', () => {
  const current = { ai: { provider: 'openai', model: 'gpt-4o-mini' } };
  assert.equal(normalizeSettings(current, { ai: null }).ai, undefined);
});

test('publicSettings never returns the API key', () => {
  const safe = publicSettings({
    ai: {
      provider: 'openai',
      model: 'gpt-4o-mini',
      baseUrl: 'https://api.openai.com/v1',
      apiKey: 'sk-secret-abcd',
    },
  });
  assert.equal('apiKey' in (safe.ai ?? {}), false);
  assert.equal(safe.ai?.hasApiKey, true);
  assert.equal(safe.ai?.apiKeyHint, '••••abcd');
  assert.equal(JSON.stringify(safe).includes('sk-secret'), false);
});

test('publicSettings reports no key for Workers AI', () => {
  const safe = publicSettings({ ai: { provider: 'workers-ai', model: '@cf/openai/gpt-oss-20b' } });
  assert.equal(safe.ai?.hasApiKey, false);
  assert.equal(safe.ai?.apiKeyHint, undefined);
});

test('normalizeSettings clamps auto-reply numbers into safe ranges', () => {
  const next = normalizeSettings({}, {
    autoReply: { enabled: true, cooldownSeconds: 1, dailyLimit: 9999 },
  });
  assert.equal(next.autoReply?.cooldownSeconds, MIN_AUTO_REPLY_COOLDOWN);
  assert.equal(next.autoReply?.dailyLimit, 200);

  const high = normalizeSettings({}, { autoReply: { enabled: true, cooldownSeconds: 99999 } });
  assert.equal(high.autoReply?.cooldownSeconds, MAX_AUTO_REPLY_COOLDOWN);

  const defaults = normalizeSettings({}, { autoReply: { enabled: true } });
  assert.equal(defaults.autoReply?.cooldownSeconds, DEFAULT_AUTO_REPLY_COOLDOWN);
  assert.equal(defaults.autoReply?.dailyLimit, DEFAULT_AUTO_REPLY_DAILY);
});

test('normalizeSettings trims the prompt and drops empty ones', () => {
  const withPrompt = normalizeSettings({}, {
    autoReply: { enabled: true, prompt: '  reply in Nepali  ' },
  });
  assert.equal(withPrompt.autoReply?.prompt, 'reply in Nepali');

  const cleared = normalizeSettings(withPrompt, { autoReply: { enabled: true, prompt: '   ' } });
  assert.equal(cleared.autoReply?.prompt, undefined);
});

test('normalizeSettings drops auto-reply entirely when the patch is not an object', () => {
  const current = { autoReply: { enabled: true, dailyLimit: 5 } };
  const next = normalizeSettings(current, { autoReply: null });
  assert.equal(next.autoReply, undefined);
});

test('auto-reply defaults to off and groups default to off', () => {
  const next = normalizeSettings({}, { autoReply: { enabled: 'yes' } });
  assert.equal(next.autoReply?.enabled, false);
  assert.equal(next.autoReply?.groups, false);
});

test('resolveAi prefers the session provider, then the env model, then the fallback', () => {
  assert.deepEqual(
    resolveAi(
      { ai: { provider: 'openai', model: 'gpt-4o-mini', baseUrl: 'https://api.openai.com/v1', apiKey: 'sk-1' } },
      '@cf/meta/llama-3.3-70b-instruct-fp8-fast',
      FALLBACK,
    ),
    { provider: 'openai', model: 'gpt-4o-mini', baseUrl: 'https://api.openai.com/v1', apiKey: 'sk-1' },
  );
  assert.deepEqual(
    resolveAi({ ai: { provider: 'workers-ai', model: '@cf/openai/gpt-oss-20b' } }, undefined, FALLBACK),
    { provider: 'workers-ai', model: '@cf/openai/gpt-oss-20b' },
  );
  assert.deepEqual(
    resolveAi({}, '@cf/meta/llama-3.3-70b-instruct-fp8-fast', FALLBACK),
    { provider: 'workers-ai', model: '@cf/meta/llama-3.3-70b-instruct-fp8-fast' },
  );
  assert.deepEqual(resolveAi({}, undefined, FALLBACK), { provider: 'workers-ai', model: FALLBACK });
});
