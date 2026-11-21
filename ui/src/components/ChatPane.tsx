import { useEffect, useRef, useState } from 'react';
import QRCode from 'qrcode';
import {
  ArrowLeft,
  Loader2,
  Lock,
  MoreVertical,
  Paperclip,
  QrCode,
  Send,
  Smile,
  Smartphone,
  Sparkles,
  Zap,
} from 'lucide-react';
import type { SessionStatus } from '../lib/api';
import { chatIdToNumber } from '../lib/api';
import type { ChatSummary } from '../lib/format';
import { groupByDay } from '../lib/format';
import { useToast } from './Toaster';
import { Avatar } from './Avatar';
import { MessageBubble } from './MessageBubble';
import { StatusDot, statusLabel } from './StatusPill';

interface ChatPaneProps {
  status?: SessionStatus;
  sessionId: string | null;
  chat: ChatSummary | null;
  onBack: () => void;
  onWake: () => void;
  waking: boolean;
  onSend: (text: string) => Promise<void>;
  sending: boolean;
  /** Asks the worker's AI for a reply draft; returns null when it failed (already toasted). */
  onDraft: () => Promise<string | null>;
  onPair: () => void;
  pairing: boolean;
  onOpenSessions: () => void;
  onOpenSettings: () => void;
  onNewChat: () => void;
  onSkipPairing: () => void;
}

export function ChatPane(props: ChatPaneProps) {
  const { chat, status, sessionId } = props;
  const connected = status?.status === 'connected';
  const paired = status?.status === 'connected' || status?.status === 'idle';
  const unpaired = !paired;

  return (
    <section className="flex h-full min-h-0 flex-1 flex-col bg-panel">
      <header className="flex h-[60px] shrink-0 items-center gap-3 border-l border-line bg-header px-3">
        <button
          type="button"
          onClick={props.onBack}
          className="grid size-9 place-items-center rounded-full text-muted transition hover:bg-hover hover:text-ink md:hidden"
          aria-label="Back to chats"
        >
          <ArrowLeft size={20} />
        </button>

        {chat ? (
          <>
            <Avatar name={chat.name} seed={chat.chatId} size={40} group={chat.chatId.endsWith('@g.us')} />
            <div className="min-w-0 flex-1">
              <div className="truncate text-[15px] font-semibold text-ink">{chat.name}</div>
              <div className="flex items-center gap-1.5 text-[12px] text-muted">
                {connected ? (
                  <>
                    <span className="size-1.5 rounded-full bg-accent" />
                    online
                  </>
                ) : (
                  <>
                    <StatusDot status={status?.status} />
                    {status?.status === 'idle' ? 'idle · tap Wake to sync' : statusLabel(status?.status)}
                  </>
                )}
              </div>
            </div>
          </>
        ) : (
          <>
            <Avatar name={status?.me?.name || sessionId || 'OpenWA'} seed={sessionId ?? ''} size={40} />
            <div className="min-w-0 flex-1">
              <div className="truncate text-[15px] font-semibold text-ink">
                {status?.me?.name || sessionId || 'OpenWA'}
              </div>
              <div className="text-[12px] text-muted">
                {unpaired ? 'Device not linked' : 'WhatsApp gateway'}
              </div>
            </div>
          </>
        )}

        {paired && (
          <button
            type="button"
            onClick={props.onWake}
            disabled={props.waking}
            title="Wake the session (opens a short connected window)"
            className="hidden items-center gap-1.5 rounded-full bg-panel-2 px-3 py-1.5 text-[12px] font-medium text-ink transition hover:bg-hover disabled:opacity-60 sm:inline-flex"
          >
            {props.waking ? <Loader2 size={14} className="animate-spin" /> : <Zap size={14} />}
            {connected ? 'Keep awake' : 'Wake'}
          </button>
        )}

        <button
          type="button"
          onClick={props.onOpenSessions}
          className="grid size-9 place-items-center rounded-full text-muted transition hover:bg-hover hover:text-ink"
          aria-label="Sessions"
          title="Sessions"
        >
          <QrCode size={19} />
        </button>
        <button
          type="button"
          onClick={props.onOpenSettings}
          className="grid size-9 place-items-center rounded-full text-muted transition hover:bg-hover hover:text-ink"
          aria-label="Settings"
          title="Settings"
        >
          <MoreVertical size={19} />
        </button>
      </header>

      {unpaired ? (
        <PairingPanel
          status={status}
          onPair={props.onPair}
          pairing={props.pairing}
          onSkip={props.onSkipPairing}
        />
      ) : chat ? (
        <>
          <MessageList chat={chat} />
          <Composer onSend={props.onSend} sending={props.sending} onDraft={props.onDraft} />
        </>
      ) : (
        <EmptyThread status={status} onNewChat={props.onNewChat} />
      )}
    </section>
  );
}

function MessageList({ chat }: { chat: ChatSummary }) {
  const scroller = useRef<HTMLDivElement | null>(null);
  const count = chat.messages.length;

  useEffect(() => {
    const element = scroller.current;
    if (!element) return;
    element.scrollTop = element.scrollHeight;
  }, [chat.chatId, count]);

  const groups = groupByDay(chat.messages);

  return (
    <div
      ref={scroller}
      className="wallpaper min-h-0 flex-1 overflow-y-auto px-[4%] py-3"
      aria-label={`Messages with ${chat.name}`}
    >
      {groups.map(group => (
        <div key={group.label + group.messages[0]?.id}>
          <div className="my-3 flex justify-center">
            <span className="rounded-lg bg-panel/90 px-3 py-1 text-[11.5px] font-medium text-muted shadow-sm uppercase">
              {group.label}
            </span>
          </div>
          {group.messages.map((message, index) => {
            const previous = group.messages[index - 1];
            const tail = !previous || Boolean(previous.fromMe) !== Boolean(message.fromMe);
            return (
              <MessageBubble
                key={`${message.id ?? 'local'}-${message.seq ?? index}`}
                message={message}
                tail={tail}
                showSender={chat.chatId.endsWith('@g.us')}
              />
            );
          })}
        </div>
      ))}
    </div>
  );
}

function Composer({
  onSend,
  sending,
  onDraft,
}: {
  onSend: (text: string) => Promise<void>;
  sending: boolean;
  onDraft: () => Promise<string | null>;
}) {
  const [text, setText] = useState('');
  const [drafting, setDrafting] = useState(false);
  const area = useRef<HTMLTextAreaElement | null>(null);
  const toast = useToast();

  useEffect(() => {
    const element = area.current;
    if (!element) return;
    element.style.height = 'auto';
    element.style.height = `${Math.min(element.scrollHeight, 120)}px`;
  }, [text]);

  const submit = async () => {
    const value = text.trim();
    if (!value || sending) return;
    setText('');
    if (area.current) area.current.style.height = 'auto';
    try {
      await onSend(value);
    } catch {
      setText(value);
    }
  };

  const generate = async () => {
    if (drafting) return;
    setDrafting(true);
    try {
      const draft = await onDraft();
      if (!draft) return;
      setText(draft);
      area.current?.focus();
    } catch (error) {
      toast.notify(`AI draft failed: ${(error as Error).message}`, 'error');
    } finally {
      setDrafting(false);
    }
  };

  return (
    <footer className="flex shrink-0 items-end gap-2 bg-panel px-3 py-2.5">
      <button
        type="button"
        onClick={() => toast.notify('Attachments are not supported by this gateway yet.')}
        className="grid size-10 shrink-0 place-items-center rounded-full text-muted transition hover:bg-hover hover:text-ink"
        aria-label="Attach a file"
      >
        <Paperclip size={21} />
      </button>
      <button
        type="button"
        onClick={() => void generate()}
        disabled={drafting}
        title="Draft a reply with Workers AI"
        aria-label="Draft a reply with AI"
        className="grid size-10 shrink-0 place-items-center rounded-full text-muted transition hover:bg-hover hover:text-accent disabled:opacity-60"
      >
        {drafting ? <Loader2 size={19} className="animate-spin" /> : <Sparkles size={20} />}
      </button>
      <div className="flex min-h-[42px] flex-1 items-end rounded-lg bg-panel-2 px-3 py-2">
        <button
          type="button"
          onClick={() => toast.notify('Emoji picker is not built in — use your system keyboard.')}
          className="mb-0.5 mr-2 shrink-0 text-muted transition hover:text-ink"
          aria-label="Emoji"
        >
          <Smile size={20} />
        </button>
        <textarea
          ref={area}
          value={text}
          rows={1}
          onChange={event => {
            setText(event.target.value);
            const element = event.target;
            element.style.height = 'auto';
            element.style.height = `${Math.min(element.scrollHeight, 120)}px`;
          }}
          onKeyDown={event => {
            if (event.key === 'Enter' && !event.shiftKey) {
              event.preventDefault();
              void submit();
            }
          }}
          placeholder="Type a message"
          className="max-h-[120px] w-full resize-none bg-transparent py-0.5 text-[14.5px] leading-5 text-ink outline-none placeholder:text-muted"
        />
      </div>
      <button
        type="button"
        onClick={() => void submit()}
        disabled={!text.trim() || sending}
        className="grid size-10 shrink-0 place-items-center rounded-full bg-accent text-white transition hover:bg-accent-strong disabled:cursor-not-allowed disabled:bg-panel-2 disabled:text-muted"
        aria-label="Send message"
      >
        {sending ? <Loader2 size={19} className="animate-spin" /> : <Send size={19} />}
      </button>
    </footer>
  );
}

function EmptyThread({ status, onNewChat }: { status?: SessionStatus; onNewChat: () => void }) {
  return (
    <div className="wallpaper flex min-h-0 flex-1 flex-col items-center justify-center px-8 py-10 text-center">
      <img src="/logo.svg" alt="" width={92} height={92} className="mb-5 rounded-2xl shadow-lg" />
      <h2 className="text-[28px] font-light text-ink">OpenWA Web</h2>
      <p className="mt-2 max-w-md text-[13.5px] text-muted">
        Send and receive messages without keeping your phone online. Your session runs in a Cloudflare
        Durable Object — the socket only opens for short windows.
      </p>
      <div className="mt-6 flex items-center gap-2 text-[12px] text-muted">
        <Lock size={13} />
        {status?.me?.id ? `Linked as ${chatIdToNumber(status.me.id)}` : 'End-to-end encrypted by WhatsApp'}
      </div>
      <button
        type="button"
        onClick={onNewChat}
        className="mt-6 rounded-full border border-line px-5 py-2 text-[13px] font-medium text-ink transition hover:bg-hover"
      >
        Start a new chat
      </button>
    </div>
  );
}

function PairingPanel({
  status,
  onPair,
  pairing,
  onSkip,
}: {
  status?: SessionStatus;
  onPair: () => void;
  pairing: boolean;
  onSkip: () => void;
}) {
  const [qrSrc, setQrSrc] = useState<string>('');
  const qr = status?.qr;

  useEffect(() => {
    let cancelled = false;
    if (!qr) {
      setQrSrc('');
      return;
    }
    QRCode.toDataURL(qr, {
      margin: 1,
      width: 300,
      errorCorrectionLevel: 'M',
      color: { dark: '#111b21', light: '#ffffff' },
    })
      .then(url => {
        if (!cancelled) setQrSrc(url);
      })
      .catch(() => {
        if (!cancelled) setQrSrc('');
      });
    return () => {
      cancelled = true;
    };
  }, [qr]);

  const loggedOut = status?.status === 'loggedOut';

  return (
    <div className="min-h-0 flex-1 overflow-y-auto bg-panel-2">
      <div className="mx-auto flex w-full max-w-3xl flex-col items-center px-6 py-10 text-center">
        <div className="mb-4 grid size-14 place-items-center rounded-2xl bg-accent/10 text-accent">
          <Smartphone size={28} />
        </div>
        <h2 className="text-[22px] font-medium text-ink">
          {loggedOut ? 'This session was logged out' : 'Link a device'}
        </h2>
        <p className="mt-2 max-w-md text-[13.5px] leading-6 text-muted">
          {loggedOut
            ? 'The device link was removed and credentials were wiped. Start pairing again to reconnect.'
            : 'Pair this gateway with your phone to read chats and send messages from here.'}
        </p>

        <div className="mt-6 w-full max-w-md rounded-xl bg-panel p-6 shadow-sm ring-1 ring-line">
          {qrSrc ? (
            <div className="flex flex-col items-center">
              <img
                src={qrSrc}
                alt="WhatsApp pairing QR code"
                className="size-[260px] rounded-lg bg-white p-2"
              />
              <p className="mt-4 flex items-center gap-2 text-[12.5px] text-muted">
                <span className="size-2 animate-pulse-dot rounded-full bg-accent" />
                QR refreshes every ~20 seconds
              </p>
            </div>
          ) : (
            <div className="flex flex-col items-center py-6">
              <QrCode size={56} className="mb-3 text-muted" />
              <p className="text-[13px] text-muted">
                {pairing
                  ? 'Waking the session and requesting a QR code…'
                  : 'Press the button to open a pairing window and show the QR code.'}
              </p>
            </div>
          )}

          <button
            type="button"
            onClick={onPair}
            disabled={pairing}
            className="mt-5 flex w-full items-center justify-center gap-2 rounded-lg bg-accent px-4 py-2.5 text-[14px] font-medium text-white transition hover:bg-accent-strong disabled:opacity-60"
          >
            {pairing ? <Loader2 size={17} className="animate-spin" /> : <QrCode size={17} />}
            {qr ? 'Refresh QR code' : loggedOut ? 'Link again' : 'Show QR code'}
          </button>
        </div>

        <ol className="mt-8 w-full max-w-md space-y-3 text-left text-[13px] text-muted">
          <li className="flex gap-3">
            <span className="grid size-6 shrink-0 place-items-center rounded-full bg-panel text-[12px] font-semibold text-ink ring-1 ring-line">
              1
            </span>
            Open WhatsApp on your phone.
          </li>
          <li className="flex gap-3">
            <span className="grid size-6 shrink-0 place-items-center rounded-full bg-panel text-[12px] font-semibold text-ink ring-1 ring-line">
              2
            </span>
            <span>
              Open <b className="font-semibold text-ink">Linked devices</b> — Android: tap ⋮ Menu,
              then Linked devices. iPhone: Settings, then Linked devices.
            </span>
          </li>
          <li className="flex gap-3">
            <span className="grid size-6 shrink-0 place-items-center rounded-full bg-panel text-[12px] font-semibold text-ink ring-1 ring-line">
              3
            </span>
            Tap <b className="mx-1 font-semibold text-ink">Link a device</b> and scan the code above.
          </li>
        </ol>

        {status?.status === 'closed' && status.lastDisconnect && (
          <p className="mt-6 text-[12px] text-danger">
            Last disconnect: {status.lastDisconnect.code ?? '?'} — {status.lastDisconnect.message ?? ''}
          </p>
        )}

        <p className="mt-6 text-[12px] text-muted">
          {statusLabel(status?.status)} · the session sleeps again after the pairing window.
          <button type="button" onClick={onSkip} className="ml-1 text-accent hover:underline">
            Back to chats
          </button>
        </p>
      </div>
    </div>
  );
}
