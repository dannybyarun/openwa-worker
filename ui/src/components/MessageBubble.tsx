import { useState } from 'react';
import {
  CheckCheck,
  FileText,
  Image as ImageIcon,
  MapPin,
  Mic,
  Smile,
  User,
  Video,
} from 'lucide-react';
import type { Message } from '../lib/api';
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

export function MessageBubble({
  message,
  tail,
  showSender = false,
}: {
  message: Message;
  tail: boolean;
  showSender?: boolean;
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

        {kind && !text && (
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

        {text && (
          <>
            <span className={`whitespace-pre-wrap break-words ${long && !expanded ? 'line-clamp-[12]' : ''}`}>
              {text}
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
