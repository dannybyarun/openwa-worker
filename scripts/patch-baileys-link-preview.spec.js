'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const {
  applyLinkPreviewPatch,
  isApplied,
  UPSTREAM_GUARDS,
  MARKER,
  V1_HEADER,
  REPLACED_FN,
  UPSTREAM_FN,
} = require('./patch-baileys-link-preview');

/**
 * Same contract as the sibling patcher specs: the patcher rewrites a file this repository does not
 * own, so it must fire only on the exact shape it was written for, refuse loudly on anything else,
 * and be safe to run twice (postinstall runs on every install).
 */

/** A minimal pristine lib/Utils/link-preview.js fixture. */
const PRISTINE_LINK_PREVIEW_JS = `import { prepareWAMessageMedia } from './messages.js';\nimport { extractImageThumb, getHttpStream } from './messages-media.js';\nconst THUMBNAIL_WIDTH_PX = 192;\nconst getCompressedJpegThumbnail = async (url, { thumbnailWidth, fetchOpts }) => {\n    const stream = await getHttpStream(url, fetchOpts);\n    const result = await extractImageThumb(stream, thumbnailWidth);\n    return result;\n};\n${UPSTREAM_FN}\n`;

function fakeBaileys(overrides = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'baileys-link-preview-'));
  fs.mkdirSync(path.join(dir, 'lib', 'Utils'), { recursive: true });
  const file = path.join(dir, 'lib', 'Utils', 'link-preview.js');
  fs.writeFileSync(file, overrides.content ?? PRISTINE_LINK_PREVIEW_JS, 'utf8');
  // Stub the imports the module top-level needs so the patched file can be imported.
  fs.writeFileSync(path.join(dir, 'lib', 'Utils', 'messages.js'), 'export const prepareWAMessageMedia = async () => ({});\n');
  fs.writeFileSync(
    path.join(dir, 'lib', 'Utils', 'messages-media.js'),
    'export const extractImageThumb = async () => undefined;\nexport const getHttpStream = async () => undefined;\n',
  );
  return { dir, file };
}

test('CONTROL — the fixture reproduces the exact guards the patcher keys on', () => {
  for (const guard of UPSTREAM_GUARDS) {
    const occurrences = PRISTINE_LINK_PREVIEW_JS.split(guard).length - 1;
    assert.equal(occurrences, 1, `guard \`${guard}\` must appear exactly once in the fixture`);
  }
});

test('re-patches its own v1 output (upgrade path, idempotent per version)', () => {
  const v1Output = REPLACED_FN.replace(MARKER, V1_HEADER);
  const { dir, file } = fakeBaileys({ content: v1Output });
  const result = applyLinkPreviewPatch(dir);
  assert.equal(result.skipped, undefined);
  const patched = fs.readFileSync(file, 'utf8');
  assert.ok(patched.startsWith(`// ${MARKER}`)); // upgraded to the current version
  assert.ok(patched.includes('export const getUrlInfo = async () => undefined;'));
  // and the current version is a no-op
  const second = applyLinkPreviewPatch(dir);
  assert.equal(second.skipped, true);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('replaces getUrlInfo with the immediate-undefined no-op', () => {
  const { dir, file } = fakeBaileys();
  const result = applyLinkPreviewPatch(dir);
  assert.equal(result.skipped, undefined);

  const patched = fs.readFileSync(file, 'utf8');
  assert.ok(patched.includes(MARKER));
  assert.ok(!patched.includes("import('link-preview-js')"), 'no trace of the preview fetch may remain');
  assert.ok(!patched.includes("error.message.includes('receive a valid')"), 'the rethrow branch must be gone');
  assert.ok(patched.includes('export const getUrlInfo = async () => undefined;'));
  // the rest of the module stays intact
  assert.ok(patched.includes('getCompressedJpegThumbnail'), 'sibling helpers must be preserved');
  assert.ok(patched.includes("from './messages.js'"), 'imports must be preserved');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('is idempotent — a second run does not double-patch', () => {
  const { dir, file } = fakeBaileys();
  applyLinkPreviewPatch(dir);
  const once = fs.readFileSync(file, 'utf8');
  const second = applyLinkPreviewPatch(dir);
  assert.equal(second.skipped, true);
  assert.equal(second.reason, 'already patched');
  assert.equal(fs.readFileSync(file, 'utf8'), once);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('refuses an unknown shape rather than shipping unpatched', () => {
  const { dir } = fakeBaileys({ content: "export const answer = 42;\n" });
  assert.throws(() => applyLinkPreviewPatch(dir), /different shape/);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('skips a tree with no baileys rather than failing the install', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'baileys-link-preview-'));
  const result = applyLinkPreviewPatch(dir);
  assert.equal(result.skipped, true);
  assert.match(result.reason, /not found/);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('isApplied is false on a pristine tree and true once the patch has run', () => {
  const { dir } = fakeBaileys();
  assert.equal(isApplied(dir), false);
  applyLinkPreviewPatch(dir);
  assert.equal(isApplied(dir), true);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('the replacement is syntactically valid and returns undefined', async () => {
  const { dir } = fakeBaileys();
  applyLinkPreviewPatch(dir);
  const file = path.join(dir, 'lib', 'Utils', 'link-preview.js');
  const { pathToFileURL } = require('url');
  const mod = await import(pathToFileURL(file).href + '?t=' + Date.now());
  const result = await mod.getUrlInfo('https://example.com/some-url', { fetchOpts: { timeout: 1 } });
  assert.equal(result, undefined);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('REPLACED_FN is what the apply function writes (drift guard)', () => {
  const { dir, file } = fakeBaileys();
  applyLinkPreviewPatch(dir);
  assert.ok(fs.readFileSync(file, 'utf8').includes(REPLACED_FN));
  fs.rmSync(dir, { recursive: true, force: true });
});