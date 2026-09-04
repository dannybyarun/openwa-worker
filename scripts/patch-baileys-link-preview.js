/**
 * Disable baileys link-preview generation, which breaks sends on Cloudflare Workers.
 *
 * When a text message contains a URL, baileys calls `getUrlInfo` (lib/Utils/link-preview.js) during
 * `generateWAMessage`, which fetches the URL through `link-preview-js`. On workerd those fetches
 * fail (private/localhost URLs, TLS, thumbnail streaming) and — critically — the function's own
 * catch **rethrows** anything that does not include 'receive a valid':
 *
 *     catch (error) {
 *         if (!error.message.includes('receive a valid')) {
 *             throw error;
 *         }
 *     }
 *
 * So a failed preview breaks the whole send, observed live as "All encryptions failed" /
 * "internal error" for every message containing a URL while URL-free messages send instantly.
 * The invoice/reminder messages from sajilo-next always carry a share URL, so every send failed.
 *
 * The replacement keeps the same export shape (`getUrlInfo` is imported by
 * lib/Socket/messages-send.js) but returns undefined immediately, which is exactly what baileys
 * treats as "no URL / no preview". The message text is unchanged — only the preview is skipped.
 *
 * Exact and self-disabling, like the sibling patcher: it targets the pinned 7.0.0-rc14 shape and
 * refuses loudly if the file matches neither the pristine upstream shape nor its own previous
 * output, rather than silently shipping an unpatched library.
 *
 * **RETIRE this, do not keep it.** It exists only because baileys has no SocketConfig flag to turn
 * link previews off (only `generateHighQualityLinkPreview` and `linkPreviewImageThumbnailWidth`,
 * which do not stop the preview fetch). If upstream ever supports `linkPreview: false`,
 * delete this patcher and set the flag instead.
 */
'use strict';

const fs = require('fs');
const path = require('path');

const DEFAULT_BAILEYS = path.join(__dirname, '..', 'node_modules', '@whiskeysockets', 'baileys');
const LINK_PREVIEW_PATH = path.join('lib', 'Utils', 'link-preview.js');

/** Marker for the CURRENT patch version. isApplied() keys on this. */
const MARKER = 'OpenWA: Cloudflare Workers link previews disabled — v1';
/** A file carrying this header (any prior patch version) is this patcher's own output and must be re-patchable. */
const V1_HEADER = 'OpenWA: Cloudflare Workers link previews disabled';

/** The exact upstream 7.0.0-rc14 getUrlInfo function, verbatim. */
const UPSTREAM_FN = `export const getUrlInfo = async (text, opts = {
    thumbnailWidth: THUMBNAIL_WIDTH_PX,
    fetchOpts: { timeout: 3000 }
}) => {
    try {
        // retries
        let retries = 0;
        const maxRetry = 5;
        const { getLinkPreview } = await import('link-preview-js');
        let previewLink = text;
        if (!text.startsWith('https://') && !text.startsWith('http://')) {
            previewLink = 'https://' + previewLink;
        }
        const info = await getLinkPreview(previewLink, {
            ...opts.fetchOpts,
            followRedirects: 'follow',
            handleRedirects: (baseURL, forwardedURL) => {
                const urlObj = new URL(baseURL);
                const forwardedURLObj = new URL(forwardedURL);
                if (retries >= maxRetry) {
                    return false;
                }
                if (forwardedURLObj.hostname === urlObj.hostname ||
                    forwardedURLObj.hostname === 'www.' + urlObj.hostname ||
                    'www.' + forwardedURLObj.hostname === urlObj.hostname) {
                    retries += 1;
                    return true;
                }
                else {
                    return false;
                }
            },
            headers: opts.fetchOpts?.headers
        });
        if (info && 'title' in info && info.title) {
            const [image] = info.images;
            const urlInfo = {
                'canonical-url': info.url,
                'matched-text': text,
                title: info.title,
                description: info.description,
                originalThumbnailUrl: image
            };
            if (opts.uploadImage) {
                const { imageMessage } = await prepareWAMessageMedia({ image: { url: image } }, {
                    upload: opts.uploadImage,
                    mediaTypeOverride: 'thumbnail-link',
                    options: opts.fetchOpts
                });
                urlInfo.jpegThumbnail = imageMessage?.jpegThumbnail ? Buffer.from(imageMessage.jpegThumbnail) : undefined;
                urlInfo.highQualityThumbnail = imageMessage || undefined;
            }
            else {
                try {
                    urlInfo.jpegThumbnail = image ? (await getCompressedJpegThumbnail(image, opts)).buffer : undefined;
                }
                catch (error) {
                    opts.logger?.debug({ err: error.stack, url: previewLink }, 'error in generating thumbnail');
                }
            }
            return urlInfo;
        }
    }
    catch (error) {
        if (!error.message.includes('receive a valid')) {
            throw error;
        }
    }
};`;

/** The replacement: keep the export, skip the fetch entirely. */
const REPLACED_FN = `// ${MARKER}
// Link previews are disabled for Cloudflare Workers. baileys' getUrlInfo fetches the message
// URL via link-preview-js during message generation, and on workerd those fetches fail in
// ways the catch below RETHROWS (anything not matching 'receive a valid'), failing the whole
// send — live-observed as "All encryptions failed" / "internal error" for every message that
// contains a URL while URL-free messages sent instantly. Returning undefined makes baileys
// treat the text as having no URL: the message text is unchanged, only the preview is skipped.
// See cloudflare-worker/scripts/patch-baileys-link-preview.js — RETIRE when baileys supports
// disabling previews via SocketConfig.
export const getUrlInfo = async () => undefined;`;

/** Guards that must each appear exactly once in a pristine upstream file. */
const UPSTREAM_GUARDS = [
  "export const getUrlInfo = async (text, opts = {",
  "const { getLinkPreview } = await import('link-preview-js');",
  "if (!error.message.includes('receive a valid')) {",
];

/** Apply the transform. Returns {skipped, reason} or {note} — never a partial write. */
function applyLinkPreviewPatch(baileysDir = DEFAULT_BAILEYS) {
  const file = path.join(baileysDir, LINK_PREVIEW_PATH);
  if (!fs.existsSync(file)) {
    return { skipped: true, reason: `${LINK_PREVIEW_PATH} not found — nothing to patch` };
  }
  const source = fs.readFileSync(file, 'utf8');
  if (source.includes(MARKER)) {
    return { skipped: true, reason: 'already patched' };
  }
  const pristine =
    UPSTREAM_GUARDS.every(guard => source.split(guard).length - 1 === 1) &&
    !source.includes(V1_HEADER);
  const previousPatch = source.includes(V1_HEADER);
  if (!pristine && !previousPatch) {
    const guard = UPSTREAM_GUARDS.find(g => source.split(g).length - 1 !== 1) ?? '(unknown)';
    throw new Error(
      `expected the pristine 7.0.0-rc14 link-preview.js (or a previous version of this patch), ` +
        `found a different shape (guard \`${guard}\` mismatch) — the upstream shape changed; ` +
        're-check the baileys getUrlInfo before removing this patcher',
    );
  }
  if (previousPatch) {
    // Our own earlier output: swap the marked region for the current replacement, keeping
    // whatever surrounds it (imports, sibling helpers, trailing sourcemap comment). The marker
    // comment starts the region; the `export const getUrlInfo` line (single-line in current and
    // previous versions) ends it.
    const lines = source.split('\n');
    const markerIdx = lines.findIndex(l => l.includes(V1_HEADER));
    const fnIdx = lines.findIndex(l => l.trim().startsWith('export const getUrlInfo'));
    if (markerIdx === -1 || fnIdx === -1 || fnIdx < markerIdx) {
      throw new Error('previous patch marker present but getUrlInfo body not found');
    }
    const before = lines.slice(0, markerIdx).join('\n');
    const after = lines.slice(fnIdx + 1).join('\n');
    fs.writeFileSync(file, `${before}${REPLACED_FN}${after ? '\n' + after : ''}`, 'utf8');
    return { note: 'upgraded link-preview patch to the current version' };
  }
  fs.writeFileSync(file, source.replace(UPSTREAM_FN, REPLACED_FN), 'utf8');
  return { note: 'disabled baileys link-preview generation (getUrlInfo → immediate undefined)' };
}

function run() {
  const bestEffort = process.argv.includes('--best-effort');
  try {
    const result = applyLinkPreviewPatch();
    console.log(`patch-baileys-link-preview: ${result.skipped ? `skipped — ${result.reason}` : result.note}`);
  } catch (error) {
    if (bestEffort) {
      console.warn(`patch-baileys-link-preview: skipped — ${error.message}`);
      return;
    }
    console.error(`patch-baileys-link-preview: ${error.message}`);
    process.exitCode = 1;
  }
}

if (require.main === module) run();

/** The stand-down branch above as a predicate, for the worker's own boot guard. */
function isApplied(baileysDir = DEFAULT_BAILEYS) {
  try {
    return fs.readFileSync(path.join(baileysDir, LINK_PREVIEW_PATH), 'utf8').includes(MARKER);
  } catch {
    return true;
  }
}

module.exports = { applyLinkPreviewPatch, isApplied, UPSTREAM_GUARDS, MARKER, V1_HEADER, REPLACED_FN, UPSTREAM_FN };