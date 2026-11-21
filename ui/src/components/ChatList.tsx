import { useMemo, useState } from 'react';
import { Gauge, MessageSquarePlus, QrCode, Search, Settings2 } from 'lucide-react';
import type { Config, SessionStatus } from '../lib/api';
import { jidKey } from '../lib/api';
import type { ChatSummary } from '../lib/format';
import { listTime, messagePreview } from '../lib/format';
import { Avatar } from './Avatar';
import { StatusDot, statusLabel } from './StatusPill';

interface ChatListProps {
  accountName: string;
  accountId: string;
  status?: SessionStatus;
  /** Worker connection, so avatar lookups can be made per chat. */
  config?: Config;
  /** Session the chats belong to. */
  sessionId?: string | null;
  /** Profile pictures already cached by the session (jid → data URL). */
  avatars?: Record<string, string | null>;
  chats: ChatSummary[];
  activeChatId: string | null;
  onPick: (chatId: string) => void;
  onNewChat: () => void;
  onSessions: () => void;
  onSettings: () => void;
  onUsage: () => void;
}

export function ChatList({
  accountName,
  accountId,
  status,
  config,
  sessionId,
  avatars,
  chats,
  activeChatId,
  onPick,
  onNewChat,
  onSessions,
  onSettings,
  onUsage,
}: ChatListProps) {
  const [query, setQuery] = useState('');

  const filtered = useMemo(() => {
    const needle = query.trim().toLowerCase();
    if (!needle) return chats;
    return chats.filter(chat =>
      `${chat.name} ${chat.chatId} ${messagePreview(chat.last)}`.toLowerCase().includes(needle),
    );
  }, [chats, query]);

  return (
    <div className="flex h-full min-h-0 flex-col bg-panel">
      <header className="flex items-center gap-2 px-4 pt-3 pb-2">
        <button type="button" onClick={onSessions} className="flex min-w-0 flex-1 items-center gap-3 text-left">
          <Avatar
            name={accountName}
            seed={accountId}
            size={40}
            online={status?.status === 'connected'}
            jid={status?.me?.id ? jidKey(status.me.id) : undefined}
            photo={status?.me?.id ? avatars?.[jidKey(status.me.id)] : undefined}
            config={config}
            sessionId={sessionId}
            live={status?.status === 'connected'}
          />
          <div className="min-w-0">
            <div className="truncate text-[15px] font-semibold text-ink">{accountName}</div>
            <div className="flex items-center gap-1.5 text-[12px] text-muted">
              <StatusDot status={status?.status} />
              <span className="truncate">{statusLabel(status?.status)}</span>
            </div>
          </div>
        </button>
        <button
          type="button"
          onClick={onNewChat}
          title="New chat"
          aria-label="New chat"
          className="grid size-9 place-items-center rounded-full text-muted transition hover:bg-hover hover:text-ink"
        >
          <MessageSquarePlus size={20} />
        </button>
        <button
          type="button"
          onClick={onSessions}
          title="Sessions and devices"
          aria-label="Sessions and devices"
          className="grid size-9 place-items-center rounded-full text-muted transition hover:bg-hover hover:text-ink"
        >
          <QrCode size={19} />
        </button>
        <button
          type="button"
          onClick={onUsage}
          title="Free plan usage"
          aria-label="Free plan usage"
          className="grid size-9 place-items-center rounded-full text-muted transition hover:bg-hover hover:text-ink"
        >
          <Gauge size={19} />
        </button>
        <button
          type="button"
          onClick={onSettings}
          title="Settings"
          aria-label="Settings"
          className="grid size-9 place-items-center rounded-full text-muted transition hover:bg-hover hover:text-ink"
        >
          <Settings2 size={19} />
        </button>
      </header>

      <div className="px-3 pb-2">
        <label className="flex items-center gap-2 rounded-lg bg-panel-2 px-3 py-1.5">
          <Search size={16} className="text-muted" />
          <input
            value={query}
            onChange={event => setQuery(event.target.value)}
            placeholder="Search or start a new chat"
            className="w-full bg-transparent py-1 text-[13.5px] text-ink outline-none placeholder:text-muted"
          />
        </label>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto">
        {filtered.length === 0 && (
          <div className="px-5 py-10 text-center text-[13px] text-muted">
            {chats.length === 0
              ? 'No conversations yet. Link a device, then messages will appear here.'
              : 'No chats match that search.'}
          </div>
        )}

        {filtered.map(chat => {
          const active = chat.chatId === activeChatId;
          return (
            <button
              key={chat.chatId}
              type="button"
              onClick={() => onPick(chat.chatId)}
              className={`flex w-full items-center gap-3 px-3 py-2.5 text-left transition ${
                active ? 'bg-hover' : 'hover:bg-hover/70'
              }`}
            >
              <Avatar
                name={chat.name}
                seed={chat.chatId}
                size={47}
                group={chat.chatId.endsWith('@g.us')}
                jid={chat.chatId}
                photo={avatars?.[chat.chatId]}
                config={config}
                sessionId={sessionId}
                live={status?.status === 'connected'}
              />
              <div className="min-w-0 flex-1 border-b border-line/60 pb-2.5">
                <div className="flex items-baseline gap-2">
                  <span className="min-w-0 flex-1 truncate text-[15px] text-ink">{chat.name}</span>
                  <span className={`shrink-0 text-[11.5px] ${chat.unread ? 'text-accent' : 'text-muted'}`}>
                    {listTime(chat.last?.timestamp)}
                  </span>
                </div>
                <div className="mt-0.5 flex items-center gap-2">
                  <span className="min-w-0 flex-1 truncate text-[13px] text-muted">
                    {messagePreview(chat.last)}
                  </span>
                  {chat.unread > 0 && (
                    <span className="grid min-w-5 shrink-0 place-items-center rounded-full bg-badge px-1.5 text-[11px] font-semibold text-black/80">
                      {chat.unread > 99 ? '99+' : chat.unread}
                    </span>
                  )}
                </div>
              </div>
            </button>
          );
        })}
      </div>
    </div>
  );
}
