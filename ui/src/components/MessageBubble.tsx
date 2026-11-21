import { useEffect, useRef, useState } from 'react';
import {
  CheckCheck,
  Download,
  ExternalLink,
  FileText,
  Image as ImageIcon,
  Loader2,
  MapPin,
  Maximize2,
  Mic,
  Play,
  Smile,
  User,
  Video,
} from 'lucide-react';
import { api, type Config, type Message } from '../lib/api';
import { clock } from '../lib/format';

const KIND_META: Record<string, { icon: typeof FileText; label: string }> = {
  image: { icon: ImageIcon, label: 'Photo' },
  video: { icon: Video, label: 'Video' },
  audio: { icon: Mic, label: 'Voice message' },
  document: { icon: FileText, label: 'Document' },
  sticker: { icon: Smile, label: 'Sticker' },
  location: { icon: MapPin, label: 'Location' },
  contact: { icon: User, label: 'Contact' },
};

function kindFor(type?: string) {
  const key = (type ?? '').replace(/Message$/, '');
  return KIND_META[key];
}

const URL_RE = /(https?:\/\/[^\s<>"']+)/g;

/** Text with clickable links. WhatsApp itself sends plain text, so this is the only way in. */
function linkedText(text: string) {
  const parts = text.split(URL_RE);
  return parts.map((part, index) => {
    if (index % 2 === 0) return part;
    const href = part.replace(/[),.;!?]+$/, '');
    const trailing = part.slice(href.length);
    return (
      <span key={`${href}-${index}`}>
        <a
          href={href}
          target="_blank"
          rel="noreferrer noopener"
          className="text-link underline decoration-link/40 underline-offset-2 hover:decoration-link"
        >
          {href}
        </a>
        {trailing}
      </span>
    );
  });
}

function hostOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return url;
  }
}

/** The Open Graph card WhatsApp attached, or a plain link card built from the message text. */
function PreviewCard({ message }: { message: Message }) {
  const preview = message.preview;
  const firstUrl = message.text?.match(URL_RE)?.[0];
  const url = preview?.url ?? firstUrl;
  if (!url) return null;
  const hasCard = Boolean(preview?.title || preview?.description || preview?.thumbnail);

  if (!hasCard) {
    // The text itself is linkified, so a bare URL needs no second card.
    return null;
  }

  return (
    <a
      href={url}
      target="_blank"
      rel="noreferrer noopener"
      className="mb-1 block overflow-hidden rounded-md border-l-4 border-link bg-black/[0.04] transition hover:bg-black/[0.07] dark:bg-white/[0.06] dark:hover:bg-white/[0.09]"
    >
      {preview?.thumbnail && (
        <img
          src={preview.thumbnail}
          alt=""
          className="max-h-40 w-full object-cover"
          loading="lazy"
        />
      )}
      <div className="px-2 py-1.5">
        {preview?.title && (
          <div className="line-clamp-2 text-[13px] font-semibold text-ink">{preview.title}</div>
        )}
        {preview?.description && (
          <div className="line-clamp-2 text-[12px] text-muted">{preview.description}</div>
        )}
        <div className="mt-0.5 truncate text-[11.5px] text-link">{hostOf(url)}</div>
      </div>
    </a>
  );
}

/**
 * Media is fetched on demand: only the WhatsApp thumbnail is stored with the message, and
 * the bytes come from `/media` when someone actually opens the file.
 */
function MediaBlock({
  message,
  config,
  sessionId,
}: {
  message: Message;
  config?: Config;
  sessionId?: string | null;
}) {
  const kind = kindFor(message.type);
  const media = message.media;
  const [blobUrl, setBlobUrl] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState<string | null>(null);
  const urlRef = useRef<string | null>(null);

  useEffect(
    () => () => {
      if (urlRef.current) URL.revokeObjectURL(urlRef.current);
    },
    [],
  );

  if (!kind || !media) return null;

  const type = (message.type ?? '').replace(/Message$/, '');
  const isImage = type === 'image';
  const size =
    typeof media.fileLength === 'number' && media.fileLength > 0
      ? `${Math.round(media.fileLength / 1024)} KB`
      : undefined;
  const seconds = typeof media.seconds === 'number' && media.seconds > 0
    ? `${Math.floor(media.seconds / 60)}:${String(Math.round(media.seconds % 60)).padStart(2, '0')}`
    : undefined;
  const canFetch = Boolean(message.id && config && sessionId);
  // WhatsApp ships a JPEG thumbnail with every photo; show it large and load the bytes only
  // when someone taps it. Older rows without a thumbnail keep the compact file row.
  const bigPreview = isImage && Boolean(media.thumbnail) && !blobUrl;

  async function load(download: boolean) {
    if (!message.id || !config || !sessionId) return;
    setBusy(true);
    setFailed(null);
    try {
      const blob = await api.mediaBlob(config, sessionId, message.id, download);
      if (urlRef.current) URL.revokeObjectURL(urlRef.current);
      const url = URL.createObjectURL(blob);
      urlRef.current = url;
      if (download) {
        const anchor = document.createElement('a');
        anchor.href = url;
        anchor.download = media?.fileName ?? `${message.id}`;
        anchor.click();
      } else {
        setBlobUrl(url);
      }
    } catch (err) {
      setFailed(err instanceof Error ? err.message : 'Could not load this file');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="mb-1">
      {blobUrl && type === 'video' && (
        <video src={blobUrl} controls className="max-h-80 w-full rounded-md bg-black" />
      )}
      {blobUrl && type === 'audio' && <audio src={blobUrl} controls className="w-full" />}

      {isImage && (blobUrl || bigPreview) ? (
        <div className="group relative">
          <img
            src={blobUrl ?? media.thumbnail}
            alt={media.fileName ?? 'Photo'}
            loading="lazy"
            className={
              blobUrl
                ? 'max-h-80 w-full rounded-md object-contain'
                : 'max-h-72 w-full rounded-md object-cover'
            }
          />
          {size && (
            <span className="absolute bottom-1.5 left-1.5 rounded bg-black/55 px-1.5 py-0.5 text-[10.5px] font-medium text-white">
              {size}
            </span>
          )}
          {canFetch && (
            <div className="absolute right-1.5 bottom-1.5 flex items-center gap-1 opacity-0 transition group-hover:opacity-100 focus-within:opacity-100">
              {!blobUrl && (
                <button
                  type="button"
                  onClick={() => void load(false)}
                  disabled={busy}
                  className="grid size-8 place-items-center rounded-full bg-black/55 text-white transition hover:bg-black/75 disabled:opacity-60"
                  title="Open photo"
                  aria-label="Open photo"
                >
                  {busy ? <Loader2 size={16} className="animate-spin" /> : <Maximize2 size={15} />}
                </button>
              )}
              <button
                type="button"
                onClick={() => void load(true)}
                disabled={busy}
                className="grid size-8 place-items-center rounded-full bg-black/55 text-white transition hover:bg-black/75 disabled:opacity-60"
                title="Download"
                aria-label="Download"
              >
                <Download size={16} />
              </button>
            </div>
          )}
        </div>
      ) : (
        <div className="flex items-center gap-2 rounded-md bg-black/5 px-2 py-2 dark:bg-white/5">
          {media.thumbnail && !blobUrl ? (
            <img src={media.thumbnail} alt="" className="size-11 shrink-0 rounded object-cover" />
          ) : (
            <kind.icon size={22} className="shrink-0 text-muted" />
          )}
          <div className="min-w-0 flex-1">
            <div className="truncate text-[13.5px] font-medium text-ink">
              {media.fileName ?? kind.label}
            </div>
            <div className="truncate text-[11.5px] text-muted">
              {[size, seconds, media.mimetype?.split('/')[1]?.toUpperCase()].filter(Boolean).join(' · ')}
            </div>
          </div>
          {canFetch && (
            <div className="flex shrink-0 items-center gap-1">
              {!blobUrl && (
                <button
                  type="button"
                  onClick={() => void load(false)}
                  disabled={busy}
                  className="grid size-8 place-items-center rounded-full text-muted transition hover:bg-black/10 hover:text-ink disabled:opacity-50 dark:hover:bg-white/10"
                  title={type === 'image' || type === 'video' || type === 'audio' ? 'Open' : 'Open in a new tab'}
                  aria-label="Open"
                >
                  {type === 'video' || type === 'audio' ? <Play size={16} /> : <ExternalLink size={16} />}
                </button>
              )}
              <button
                type="button"
                onClick={() => void load(true)}
                disabled={busy}
                className="grid size-8 place-items-center rounded-full text-muted transition hover:bg-black/10 hover:text-ink disabled:opacity-50 dark:hover:bg-white/10"
                title="Download"
                aria-label="Download"
              >
                <Download size={16} />
              </button>
            </div>
          )}
        </div>
      )}
      {failed && <div className="mt-1 text-[11.5px] text-danger">{failed}</div>}
    </div>
  );
}

export function MessageBubble({
  message,
  tail,
  showSender = false,
  config,
  sessionId,
}: {
  message: Message;
  tail: boolean;
  showSender?: boolean;
  config?: Config;
  sessionId?: string | null;
}) {
  const [expanded, setExpanded] = useState(false);
  const fromMe = Boolean(message.fromMe);
  const kind = kindFor(message.type);
  const text = message.text ?? '';
  const long = text.length > 1400;

  return (
    <div className={`flex w-full ${fromMe ? 'justify-end' : 'justify-start'}`}>
      <div
        className={[
          'relative my-[1px] max-w-[min(78%,560px)] rounded-lg px-2.5 pt-1.5 pb-1 text-[14.2px] leading-[19px] shadow-[0_1px_0.5px_rgba(11,20,26,0.13)]',
          fromMe ? 'bubble-out bg-bubble-out' : 'bubble-in bg-bubble-in',
          tail ? 'tail mt-2' : '',
        ].join(' ')}
      >
        {showSender && !fromMe && message.pushName && (
          <div className="mb-0.5 text-[12.5px] font-semibold text-accent">
            {message.pushName}
          </div>
        )}

        <MediaBlock message={message} config={config} sessionId={sessionId} />

        {kind && !message.media && !text && (
          <div className="mb-1 flex items-center gap-2 rounded-md bg-black/5 px-2 py-3 dark:bg-white/5">
            <kind.icon size={22} className="text-muted" />
            <div className="min-w-0">
              <div className="truncate text-[13.5px] font-medium text-ink">{kind.label}</div>
              <div className="text-[11.5px] text-muted">Not downloaded</div>
            </div>
          </div>
        )}

        {kind && text && (
          <div className="mb-1 flex items-center gap-1.5 text-[12.5px] text-muted">
            <kind.icon size={15} />
            {kind.label}
          </div>
        )}

        <PreviewCard message={message} />

        {text && (
          <>
            <span className={`whitespace-pre-wrap break-words ${long && !expanded ? 'line-clamp-[12]' : ''}`}>
              {linkedText(text)}
            </span>
            {long && !expanded && (
              <button
                type="button"
                onClick={() => setExpanded(true)}
                className="mt-1 block text-[12px] text-accent hover:underline"
              >
                Read more
              </button>
            )}
          </>
        )}

        <div className="mt-0.5 flex items-center justify-end gap-1 text-[11px] leading-none text-muted">
          <span>{clock(message.timestamp)}</span>
          {fromMe && (
            <span title="Sent to the gateway — delivery receipts are not available">
              <CheckCheck size={15} className="text-muted" />
            </span>
          )}
        </div>
      </div>
    </div>
  );
}
