import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import {
  AlertTriangle,
  Loader2,
  MessageCircle,
  Moon,
  QrCode,
  Settings2,
  Smartphone,
  Sun,
} from 'lucide-react';
import { api, type Config, type Message } from './lib/api';
import { buildChats, displayName } from './lib/format';
import {
  loadConfig,
  loadLastSession,
  loadRead,
  loadTheme,
  markRead,
  saveConfig,
  saveLastSession,
  saveTheme,
  type Theme,
} from './lib/storage';
import { useEvents, useHistory, useSessions, useStatus } from './hooks/useGateway';
import { ChatList } from './components/ChatList';
import { ChatPane } from './components/ChatPane';
import { SessionsDialog } from './components/SessionsDialog';
import { SettingsDialog } from './components/SettingsDialog';
import { NewChatDialog } from './components/NewChatDialog';
import { useToast } from './components/Toaster';

type DialogName = 'sessions' | 'settings' | 'new-chat' | null;

export function App() {
  const toast = useToast();
  const queryClient = useQueryClient();

  const [config, setConfig] = useState<Config>(() => loadConfig());
  const [theme, setTheme] = useState<Theme>(() => loadTheme());
  const [sessionId, setSessionId] = useState<string>(() => loadLastSession());
  const [chatId, setChatId] = useState<string | null>(null);
  const [mobileChat, setMobileChat] = useState(false);
  const [extras, setExtras] = useState<Record<string, string[]>>({});
  const [readAt, setReadAt] = useState<Record<string, string>>({});
  const [dialog, setDialog] = useState<DialogName>(null);
  const [pairing, setPairing] = useState(false);
  const [waking, setWaking] = useState(false);
  const [sending, setSending] = useState(false);

  const sessionsQuery = useSessions(config);
  const sessions = sessionsQuery.data?.sessions ?? [];
  const statusQuery = useStatus(config, sessionId || null);
  const historyQuery = useHistory(config, sessionId || null);
  const status = statusQuery.data;

  useEvents(config, sessionId || null);

  useEffect(() => {
    document.documentElement.classList.toggle('dark', theme === 'dark');
    saveTheme(theme);
  }, [theme]);

  useEffect(() => {
    const list = sessionsQuery.data?.sessions;
    if (!list) return;
    if (list.length === 0) {
      if (sessionId) setSessionId('');
      return;
    }
    if (!list.some(session => session.id === sessionId)) setSessionId(list[0].id);
  }, [sessionsQuery.data, sessionId]);

  useEffect(() => {
    saveLastSession(sessionId);
  }, [sessionId]);

  useEffect(() => {
    setChatId(null);
    setMobileChat(false);
    setReadAt(sessionId ? loadRead(sessionId) : {});
  }, [sessionId]);

  const messages = historyQuery.data?.messages ?? [];
  const chatList = useMemo(() => {
    const base = buildChats(messages, readAt);
    const known = new Set(base.map(chat => chat.chatId));
    const drafts = (extras[sessionId] ?? [])
      .filter(id => !known.has(id))
      .map(id => ({ chatId: id, name: displayName(id), messages: [] as Message[], unread: 0 }));
    return [...drafts, ...base];
  }, [messages, readAt, extras, sessionId]);

  const activeChat = chatId ? (chatList.find(chat => chat.chatId === chatId) ?? null) : null;

  useEffect(() => {
    if (!sessionId || !chatId) return;
    markRead(sessionId, [chatId], new Date().toISOString());
    setReadAt(loadRead(sessionId));
  }, [sessionId, chatId, messages.length]);

  const pickChat = (id: string) => {
    setChatId(id);
    setMobileChat(true);
  };

  const startChat = (id: string) => {
    setExtras(current => {
      const list = current[sessionId] ?? [];
      return list.includes(id) ? current : { ...current, [sessionId]: [...list, id] };
    });
    pickChat(id);
  };

  const applyConfig = (next: Config) => {
    setConfig(next);
    saveConfig(next);
    queryClient.clear();
  };

  const wake = async () => {
    if (!sessionId) return;
    setWaking(true);
    try {
      const next = await api.wake(config, sessionId, 12000);
      queryClient.setQueryData(['status', config.base, config.token, sessionId], next);
      await queryClient.invalidateQueries({ queryKey: ['sessions', config.base, config.token] });
      toast.notify(
        next.status === 'connected'
          ? 'Session is connected for one idle window.'
          : `Session woke up as "${next.status}".`,
      );
    } catch (error) {
      const message = (error as Error).message.includes('429')
        ? 'Daily wake limit reached — the session resets at 00:00 UTC.'
        : `Wake failed: ${(error as Error).message}`;
      toast.notify(message, 'error');
    } finally {
      setWaking(false);
    }
  };

  const pair = async (targetId = sessionId) => {
    if (!targetId) {
      setDialog('sessions');
      return;
    }
    setPairing(true);
    setMobileChat(true);
    try {
      const next = await api.start(config, targetId);
      queryClient.setQueryData(['status', config.base, config.token, targetId], next);
      toast.notify('Pairing window open — scan the QR with your phone.');
    } catch (error) {
      toast.notify(`Could not start pairing: ${(error as Error).message}`, 'error');
    } finally {
      setPairing(false);
    }
  };

  const send = async (text: string) => {
    if (!sessionId || !chatId) return;
    setSending(true);
    try {
      const result = await api.sendText(config, sessionId, chatId, text);
      queryClient.setQueryData<{ id: string; messages: Message[] }>(
        ['history', config.base, config.token, sessionId],
        previous => {
          const message: Message = {
            id: result.id,
            chatId,
            fromMe: true,
            text,
            type: 'conversation',
            timestamp: result.timestamp ?? new Date().toISOString(),
          };
          if (!previous) return { id: sessionId, messages: [message] };
          return { ...previous, messages: [...previous.messages, message] };
        },
      );
      void queryClient.invalidateQueries({ queryKey: ['sessions', config.base, config.token] });
    } catch (error) {
      toast.notify(`Send failed: ${(error as Error).message}`, 'error');
      throw error;
    } finally {
      setSending(false);
    }
  };

  const accountName = status?.me?.name || sessionId || 'OpenWA';
  // A 401 means the worker answered but rejected the token; anything else is a
  // transport problem. Telling them apart saves a lot of "is it down?" guessing.
  const unauthorized = (sessionsQuery.error as { status?: number } | null)?.status === 401;
  return (
    <div className="flex h-dvh w-full overflow-hidden bg-app">
      <nav className="hidden w-16 shrink-0 flex-col items-center gap-1 border-r border-line bg-panel-2 py-4 lg:flex">
        <img src="/logo.svg" alt="OpenWA" width={34} height={34} className="mb-4 rounded-lg" />
        <RailButton label="Chats" active onClick={() => setMobileChat(false)}>
          <MessageCircle size={22} />
        </RailButton>
        <RailButton label="Devices" onClick={() => setDialog('sessions')}>
          <QrCode size={21} />
        </RailButton>
        <div className="flex-1" />
        <RailButton
          label={theme === 'dark' ? 'Light theme' : 'Dark theme'}
          onClick={() => setTheme(theme === 'dark' ? 'light' : 'dark')}
        >
          {theme === 'dark' ? <Sun size={20} /> : <Moon size={20} />}
        </RailButton>
        <RailButton label="Settings" onClick={() => setDialog('settings')}>
          <Settings2 size={20} />
        </RailButton>
      </nav>

      <aside
        className={`h-full w-full shrink-0 border-r border-line md:w-[400px] lg:w-[420px] ${
          mobileChat ? 'hidden md:flex' : 'flex'
        }`}
      >
        <div className="flex h-full w-full flex-col">
          {sessionsQuery.isError && (
            <div className="flex items-start gap-2 border-b border-line bg-danger/10 px-4 py-2.5 text-[12px] text-danger">
              <AlertTriangle size={15} className="mt-0.5 shrink-0" />
              <div className="flex-1">
                {unauthorized
                  ? 'This worker requires an API token. Paste it in Settings to connect.'
                  : 'Cannot reach the worker. Check the URL and token.'}
                <button
                  type="button"
                  onClick={() => setDialog('settings')}
                  className="ml-1 font-medium underline"
                >
                  Settings
                </button>
              </div>
            </div>
          )}
          <ChatList
            accountName={accountName}
            accountId={sessionId}
            status={status}
            chats={chatList}
            activeChatId={chatId}
            onPick={pickChat}
            onNewChat={() => setDialog('new-chat')}
            onSessions={() => setDialog('sessions')}
            onSettings={() => setDialog('settings')}
          />
        </div>
      </aside>

      <main className={`h-full min-w-0 flex-1 ${mobileChat ? 'flex' : 'hidden md:flex'}`}>
        {!sessionId ? (
          <FirstRun
            error={
              sessionsQuery.isError
                ? unauthorized
                  ? 'The worker is reachable but rejected the request: an API token is required. Open Connection settings and paste it.'
                  : (sessionsQuery.error as Error).message
                : ''
            }
            loading={sessionsQuery.isLoading}
            onCreate={() => setDialog('sessions')}
            onSettings={() => setDialog('settings')}
          />
        ) : (
          <ChatPane
            sessionId={sessionId}
            status={status}
            chat={activeChat}
            onBack={() => setMobileChat(false)}
            onWake={() => void wake()}
            waking={waking}
            onSend={send}
            sending={sending}
            onPair={() => void pair()}
            pairing={pairing}
            onOpenSessions={() => setDialog('sessions')}
            onOpenSettings={() => setDialog('settings')}
            onNewChat={() => setDialog('new-chat')}
            onSkipPairing={() => setMobileChat(false)}
          />
        )}
      </main>

      <SessionsDialog
        open={dialog === 'sessions'}
        onOpenChange={open => setDialog(open ? 'sessions' : null)}
        config={config}
        sessions={sessions}
        activeId={sessionId}
        onSelect={id => {
          setSessionId(id);
          setMobileChat(false);
        }}
        onPair={id => {
          setSessionId(id);
          void pair(id);
        }}
        onOpenSettings={() => setDialog('settings')}
      />

      <SettingsDialog
        open={dialog === 'settings'}
        onOpenChange={open => setDialog(open ? 'settings' : null)}
        config={config}
        onSave={applyConfig}
        theme={theme}
        onTheme={setTheme}
        status={status}
      />

      <NewChatDialog
        open={dialog === 'new-chat'}
        onOpenChange={open => setDialog(open ? 'new-chat' : null)}
        onStart={startChat}
      />
    </div>
  );
}

function RailButton({
  label,
  active = false,
  onClick,
  children,
}: {
  label: string;
  active?: boolean;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      title={label}
      aria-label={label}
      className={`grid size-11 place-items-center rounded-full transition ${
        active ? 'bg-accent/15 text-accent' : 'text-muted hover:bg-hover hover:text-ink'
      }`}
    >
      {children}
    </button>
  );
}

function FirstRun({
  loading,
  error,
  onCreate,
  onSettings,
}: {
  loading: boolean;
  error: string;
  onCreate: () => void;
  onSettings: () => void;
}) {
  return (
    <div className="wallpaper flex h-full w-full flex-col items-center justify-center px-8 text-center">
      <img src="/logo.svg" alt="" width={96} height={96} className="mb-5 rounded-2xl shadow-lg" />
      <h1 className="text-[30px] font-light text-ink">OpenWA for Cloudflare Workers</h1>
      <p className="mt-2 max-w-md text-[13.5px] leading-6 text-muted">
        A WhatsApp gateway that sleeps when idle. Create a session, link your phone, and this page
        becomes a WhatsApp Web client for it.
      </p>
      {loading ? (
        <div className="mt-6 flex items-center gap-2 text-[13px] text-muted">
          <Loader2 size={16} className="animate-spin" /> Looking for sessions…
        </div>
      ) : (
        <>
          {error && <p className="mt-5 max-w-md text-[12px] text-danger">{error}</p>}
          <div className="mt-6 flex flex-wrap items-center justify-center gap-2">
            <button
              type="button"
              onClick={onCreate}
              className="inline-flex items-center gap-2 rounded-full bg-accent px-5 py-2.5 text-[13.5px] font-medium text-white transition hover:bg-accent-strong"
            >
              <Smartphone size={17} /> Create a session
            </button>
            <button
              type="button"
              onClick={onSettings}
              className="inline-flex items-center gap-2 rounded-full border border-line px-5 py-2.5 text-[13.5px] font-medium text-ink transition hover:bg-hover"
            >
              <Settings2 size={16} /> Connection settings
            </button>
          </div>
        </>
      )}
    </div>
  );
}
