import { useCallback, useEffect, useState } from 'react';
import * as Dialog from '@radix-ui/react-dialog';
import {
  CheckCircle2,
  Copy,
  Loader2,
  LogOut,
  Moon,
  Plug,
  Plus,
  Sparkles,
  Sun,
  Trash2,
  X,
} from 'lucide-react';
import {
  api,
  apiBase,
  type AiProvider,
  type ChatSummaryLike,
  type Config,
  type SessionSettingsPage,
  type SessionStatus,
  type TokenRecord,
} from '../lib/api';
import { useToast } from './Toaster';

type Tab = 'connection' | 'automation' | 'embed';

interface SettingsDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  config: Config;
  onSave: (config: Config) => void;
  theme: 'dark' | 'light';
  onTheme: (theme: 'dark' | 'light') => void;
  status?: SessionStatus;
  /** Session the automation and widget settings apply to. */
  sessionId?: string | null;
  /** Chats of that session, so a widget can be pointed at one conversation. */
  chats?: ChatSummaryLike[];
  /** Present when the worker has a password set; drops the browser session cookie. */
  onSignOut?: () => void;
}

const MODEL_SUGGESTIONS = [
  '@cf/meta/llama-4-scout-17b-16e-instruct',
  '@cf/meta/llama-3.3-70b-instruct-fp8-fast',
  '@cf/openai/gpt-oss-20b',
  '@cf/qwen/qwen2.5-coder-32b-instruct',
  '@cf/mistralai/mistral-small-3.1-24b-instruct',
];

/** Names that work on the popular OpenAI-compatible endpoints (OpenAI, Groq, Ollama…). */
const CUSTOM_MODEL_SUGGESTIONS = [
  'gpt-4o-mini',
  'gpt-4.1-mini',
  'llama-3.3-70b-versatile',
  'meta-llama/llama-3.1-8b-instruct',
  'mistral-small-latest',
  'llama3.1:8b',
  'qwen2.5:7b',
];

export function SettingsDialog({
  open,
  onOpenChange,
  config,
  onSave,
  theme,
  onTheme,
  status,
  sessionId,
  chats = [],
  onSignOut,
}: SettingsDialogProps) {
  const [tab, setTab] = useState<Tab>('connection');
  const [base, setBase] = useState(config.base);
  const [testing, setTesting] = useState(false);
  const [healthy, setHealthy] = useState<boolean | null>(null);
  const toast = useToast();

  useEffect(() => {
    if (open) {
      setBase(config.base);
      setHealthy(null);
    }
  }, [open, config.base]);

  const test = async () => {
    setTesting(true);
    setHealthy(null);
    try {
      const target = apiBase({ base, token: '' });
      const res = await fetch(`${target}/health`);
      if (!res.ok) {
        setHealthy(false);
        toast.notify(`Health check returned ${res.status}.`, 'error');
        return;
      }
      await api.sessions({ base, token: '' });
      setHealthy(true);
      toast.notify('Worker is reachable and you are signed in.');
    } catch (error) {
      setHealthy(false);
      const status = (error as { status?: number }).status;
      toast.notify(
        status === 401
          ? 'Worker is reachable, but it rejected the request (401). Sign out and sign in again.'
          : `Cannot reach the worker: ${(error as Error).message}`,
        'error',
      );
    } finally {
      setTesting(false);
    }
  };

  const save = () => {
    onSave({ base: base.trim().replace(/\/+$/, ''), token: '' });
    toast.notify('Connection settings saved.');
    onOpenChange(false);
  };

  const wake = status?.wake;

  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="dialog-overlay" />
        <Dialog.Content className="dialog-content w-[min(94vw,560px)] p-5" aria-describedby={undefined}>
          <div className="flex items-start justify-between gap-4">
            <div>
              <Dialog.Title className="text-[17px] font-semibold text-ink">Settings</Dialog.Title>
              <p className="mt-1 text-[12.5px] leading-5 text-muted">
                Connection, automation and the website widget for this worker.
              </p>
            </div>
            <Dialog.Close asChild>
              <button
                type="button"
                className="grid size-8 place-items-center rounded-full text-muted transition hover:bg-hover hover:text-ink"
                aria-label="Close"
              >
                <X size={17} />
              </button>
            </Dialog.Close>
          </div>

          <div className="mt-4 flex gap-1 rounded-lg bg-panel-2 p-1" role="tablist">
            {(
              [
                ['connection', 'Connection', Plug],
                ['automation', 'AI & auto-reply', Sparkles],
                ['embed', 'Website widget', Copy],
              ] as const
            ).map(([key, label, Icon]) => (
              <button
                key={key}
                type="button"
                role="tab"
                aria-selected={tab === key}
                onClick={() => setTab(key)}
                className={`inline-flex flex-1 items-center justify-center gap-1.5 rounded-md px-2 py-1.5 text-[12.5px] font-medium transition ${
                  tab === key ? 'bg-panel text-ink shadow-sm' : 'text-muted hover:text-ink'
                }`}
              >
                <Icon size={14} />
                {label}
              </button>
            ))}
          </div>

          {tab === 'connection' && (
            <div className="mt-4 space-y-4">
              <div>
                <label htmlFor="worker-url" className="text-[12px] font-medium text-muted">
                  Worker URL
                </label>
                <input
                  id="worker-url"
                  value={base}
                  onChange={event => setBase(event.target.value)}
                  placeholder="https://openwa-worker.example.workers.dev"
                  className="mt-1.5 w-full rounded-lg bg-panel-2 px-3 py-2 text-[13.5px] text-ink outline-none ring-1 ring-transparent focus:ring-accent/60"
                />
                <p className="mt-1 text-[11.5px] text-muted">
                  Leave empty when the UI is served by the worker itself.
                </p>
              </div>

              <div className="flex items-center gap-2">
                <button
                  type="button"
                  onClick={() => void test()}
                  disabled={testing}
                  className="inline-flex items-center gap-1.5 rounded-lg border border-line px-3 py-1.5 text-[12.5px] font-medium text-ink transition hover:bg-hover disabled:opacity-60"
                >
                  {testing ? <Loader2 size={14} className="animate-spin" /> : null}
                  Test connection
                </button>
                {healthy === true && (
                  <span className="inline-flex items-center gap-1 text-[12px] text-accent">
                    <CheckCircle2 size={14} /> reachable
                  </span>
                )}
              </div>

              <div className="border-t border-line pt-4">
                <div className="text-[12px] font-medium text-muted">Appearance</div>
                <div className="mt-2 grid grid-cols-2 gap-2">
                  {(['dark', 'light'] as const).map(option => (
                    <button
                      key={option}
                      type="button"
                      onClick={() => onTheme(option)}
                      className={`flex items-center justify-center gap-2 rounded-lg px-3 py-2 text-[13px] capitalize ring-1 transition ${
                        theme === option
                          ? 'bg-accent/10 text-accent ring-accent/40'
                          : 'bg-panel-2 text-ink ring-line hover:bg-hover'
                      }`}
                    >
                      {option === 'dark' ? <Moon size={15} /> : <Sun size={15} />}
                      {option}
                    </button>
                  ))}
                </div>
              </div>

              {wake && (wake.used !== undefined || wake.limit !== undefined) && (
                <div className="rounded-lg bg-panel-2 px-3 py-2.5 text-[12px] text-muted">
                  Wake budget today: <b className="text-ink">{wake.used ?? 0}</b>
                  {wake.limit ? ` / ${wake.limit}` : ''} connects. Every wake holds the socket for one
                  idle window.
                </div>
              )}
            </div>
          )}

          {tab === 'automation' && (
            <AutomationTab config={config} sessionId={sessionId ?? null} active={open && tab === 'automation'} />
          )}

          {tab === 'embed' && (
            <EmbedTab
              config={config}
              sessionId={sessionId ?? null}
              chats={chats}
              active={open && tab === 'embed'}
            />
          )}

          <div className="mt-5 flex items-center gap-2">
            {onSignOut && (
              <button
                type="button"
                onClick={onSignOut}
                className="inline-flex items-center gap-1.5 rounded-lg px-2.5 py-2 text-[13px] font-medium text-danger transition hover:bg-danger/10"
              >
                <LogOut size={15} /> Sign out
              </button>
            )}
            <div className="flex-1" />
            {tab === 'connection' ? (
              <>
                <Dialog.Close asChild>
                  <button
                    type="button"
                    className="rounded-lg px-3 py-2 text-[13px] font-medium text-muted transition hover:bg-hover hover:text-ink"
                  >
                    Cancel
                  </button>
                </Dialog.Close>
                <button
                  type="button"
                  onClick={save}
                  className="rounded-lg bg-accent px-4 py-2 text-[13px] font-medium text-white transition hover:bg-accent-strong"
                >
                  Save
                </button>
              </>
            ) : (
              <Dialog.Close asChild>
                <button
                  type="button"
                  className="rounded-lg px-3 py-2 text-[13px] font-medium text-muted transition hover:bg-hover hover:text-ink"
                >
                  Done
                </button>
              </Dialog.Close>
            )}
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

function AutomationTab({
  config,
  sessionId,
  active,
}: {
  config: Config;
  sessionId: string | null;
  active: boolean;
}) {
  const toast = useToast();
  const [page, setPage] = useState<SessionSettingsPage | null>(null);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [provider, setProvider] = useState<AiProvider>('workers-ai');
  const [model, setModel] = useState('');
  const [baseUrl, setBaseUrl] = useState('');
  const [apiKey, setApiKey] = useState('');
  const [clearKey, setClearKey] = useState(false);
  const [enabled, setEnabled] = useState(false);
  const [prompt, setPrompt] = useState('');
  const [groups, setGroups] = useState(false);
  const [cooldown, setCooldown] = useState(120);
  const [dailyLimit, setDailyLimit] = useState(20);

  const load = useCallback(async () => {
    if (!sessionId) return;
    setLoading(true);
    try {
      const data = await api.settings(config, sessionId);
      setPage(data);
      setProvider(data.settings.ai?.provider ?? data.defaults.provider);
      setModel(data.settings.ai?.model ?? '');
      setBaseUrl(data.settings.ai?.baseUrl ?? '');
      setApiKey('');
      setClearKey(false);
      setEnabled(Boolean(data.settings.autoReply?.enabled));
      setPrompt(data.settings.autoReply?.prompt ?? '');
      setGroups(Boolean(data.settings.autoReply?.groups));
      setCooldown(data.settings.autoReply?.cooldownSeconds ?? data.defaults.autoReply.cooldownSeconds);
      setDailyLimit(data.settings.autoReply?.dailyLimit ?? data.defaults.autoReply.dailyLimit);
    } catch (error) {
      toast.notify(`Could not load settings: ${(error as Error).message}`, 'error');
    } finally {
      setLoading(false);
    }
  }, [config, sessionId, toast]);

  useEffect(() => {
    if (active) void load();
  }, [active, load]);

  const save = async () => {
    if (!sessionId) return;
    setSaving(true);
    try {
      const data = await api.saveSettings(config, sessionId, {
        ai: {
          provider,
          model: model.trim() || null,
          baseUrl: provider === 'openai' ? baseUrl.trim() || null : null,
          // Omit the key entirely to keep the stored one; null clears it.
          ...(clearKey
            ? { apiKey: null }
            : apiKey.trim()
              ? { apiKey: apiKey.trim() }
              : {}),
        },
        autoReply: {
          enabled,
          prompt: prompt.trim() || null,
          groups,
          cooldownSeconds: cooldown,
          dailyLimit,
        },
      });
      setPage(data);
      setApiKey('');
      setClearKey(false);
      toast.notify('Automation settings saved.');
    } catch (error) {
      toast.notify(`Save failed: ${(error as Error).message}`, 'error');
    } finally {
      setSaving(false);
    }
  };

  if (!sessionId) {
    return (
      <p className="mt-4 rounded-lg bg-panel-2 px-3 py-3 text-[12.5px] text-muted">
        Create or pick a WhatsApp session first — automation settings are stored per session.
      </p>
    );
  }

  return (
    <div className="mt-4 space-y-4">
      {loading && (
        <div className="flex items-center gap-2 text-[12.5px] text-muted">
          <Loader2 size={14} className="animate-spin" /> Loading settings…
        </div>
      )}

      <div className="rounded-lg border border-line p-3">
        <div className="text-[12px] font-medium text-muted">AI provider</div>
        <div className="mt-2 grid grid-cols-2 gap-2">
          {(
            [
              ['workers-ai', 'Workers AI', 'Runs on Cloudflare, uses your free Neuron allowance.'],
              ['openai', 'OpenAI-compatible', 'Any /chat/completions endpoint: OpenAI, Groq, OpenRouter, Ollama…'],
            ] as const
          ).map(([key, label, hint]) => (
            <button
              key={key}
              type="button"
              onClick={() => setProvider(key)}
              className={`rounded-lg px-3 py-2 text-left ring-1 transition ${
                provider === key
                  ? 'bg-accent/10 text-accent ring-accent/40'
                  : 'bg-panel-2 text-ink ring-line hover:bg-hover'
              }`}
            >
              <span className="block text-[12.5px] font-medium">{label}</span>
              <span className="mt-0.5 block text-[11px] leading-4 text-muted">{hint}</span>
            </button>
          ))}
        </div>

        <div className="mt-3">
          <label htmlFor="ai-model" className="text-[12px] font-medium text-muted">
            {provider === 'openai' ? 'Model name' : 'Workers AI model'}
          </label>
          <input
            id="ai-model"
            value={model}
            onChange={event => setModel(event.target.value)}
            list={provider === 'openai' ? 'custom-model-suggestions' : 'model-suggestions'}
            placeholder={
              provider === 'openai' ? 'gpt-4o-mini' : (page?.defaults.aiModel ?? MODEL_SUGGESTIONS[0])
            }
            className="mt-1.5 w-full rounded-lg bg-panel-2 px-3 py-2 text-[13px] text-ink outline-none ring-1 ring-transparent focus:ring-accent/60"
          />
          <datalist id="model-suggestions">
            {MODEL_SUGGESTIONS.map(item => (
              <option key={item} value={item} />
            ))}
          </datalist>
          <datalist id="custom-model-suggestions">
            {CUSTOM_MODEL_SUGGESTIONS.map(item => (
              <option key={item} value={item} />
            ))}
          </datalist>
          <p className="mt-1 text-[11.5px] text-muted">
            {provider === 'openai'
              ? 'Whatever the endpoint expects, e.g. gpt-4o-mini, llama-3.3-70b-versatile, llama3.1:8b.'
              : `Empty means the worker default (${page?.defaults.aiModel ?? 'AI_MODEL'}).`}{' '}
            Used by the AI draft button and auto-reply.
          </p>
        </div>

        {provider === 'openai' && (
          <>
            <div className="mt-3">
              <label htmlFor="ai-base-url" className="text-[12px] font-medium text-muted">
                Base URL
              </label>
              <input
                id="ai-base-url"
                value={baseUrl}
                onChange={event => setBaseUrl(event.target.value)}
                placeholder="https://api.openai.com/v1"
                className="mt-1.5 w-full rounded-lg bg-panel-2 px-3 py-2 text-[13px] text-ink outline-none ring-1 ring-transparent focus:ring-accent/60"
              />
              <p className="mt-1 text-[11.5px] text-muted">
                <code className="rounded bg-panel-2 px-1">/chat/completions</code> is appended unless the
                URL already ends with it. For a local model use, for example,
                <code className="ml-1 rounded bg-panel-2 px-1">http://localhost:11434/v1</code>.
              </p>
            </div>
            <div className="mt-3">
              <label htmlFor="ai-api-key" className="text-[12px] font-medium text-muted">
                API key
              </label>
              <input
                id="ai-api-key"
                type="password"
                autoComplete="off"
                value={apiKey}
                onChange={event => {
                  setApiKey(event.target.value);
                  if (event.target.value) setClearKey(false);
                }}
                placeholder={
                  page?.settings.ai?.hasApiKey
                    ? `Saved (${page.settings.ai.apiKeyHint ?? '••••'}) — leave empty to keep`
                    : 'sk-… (leave empty for local endpoints)'
                }
                className="mt-1.5 w-full rounded-lg bg-panel-2 px-3 py-2 text-[13px] text-ink outline-none ring-1 ring-transparent focus:ring-accent/60"
              />
              <div className="mt-1 flex items-center justify-between gap-2">
                <p className="text-[11.5px] text-muted">
                  Stored in this session&apos;s Durable Object and never sent back to the browser.
                </p>
                {page?.settings.ai?.hasApiKey && (
                  <label className="flex shrink-0 items-center gap-1 text-[11.5px] text-muted">
                    <input
                      type="checkbox"
                      checked={clearKey}
                      onChange={event => {
                        setClearKey(event.target.checked);
                        if (event.target.checked) setApiKey('');
                      }}
                      className="size-3.5 accent-[var(--c-accent)]"
                    />
                    clear
                  </label>
                )}
              </div>
            </div>
          </>
        )}
      </div>

      <div className="rounded-lg border border-line p-3">
        <label className="flex items-start gap-2">
          <input
            type="checkbox"
            checked={enabled}
            onChange={event => setEnabled(event.target.checked)}
            className="mt-0.5 size-4 accent-[var(--c-accent)]"
          />
          <span>
            <span className="block text-[13px] font-medium text-ink">Auto-reply</span>
            <span className="block text-[11.5px] leading-4 text-muted">
              Drafts and sends a reply for incoming messages while the session is awake. Rate-limited
              per chat; never replies to your own messages.
            </span>
          </span>
        </label>

        <label className="mt-3 flex items-start gap-2">
          <input
            type="checkbox"
            checked={groups}
            onChange={event => setGroups(event.target.checked)}
            className="mt-0.5 size-4 accent-[var(--c-accent)]"
          />
          <span className="text-[12.5px] text-ink">
            Also reply in group chats
            <span className="block text-[11.5px] leading-4 text-muted">
              Off by default — a bot answering every group message gets noisy fast.
            </span>
          </span>
        </label>

        <div className="mt-3">
          <label htmlFor="auto-prompt" className="text-[12px] font-medium text-muted">
            Extra instructions (optional)
          </label>
          <textarea
            id="auto-prompt"
            value={prompt}
            onChange={event => setPrompt(event.target.value)}
            rows={3}
            maxLength={2000}
            placeholder="Reply in Nepali, keep it under two sentences, mention our office hours if asked."
            className="mt-1.5 w-full resize-y rounded-lg bg-panel-2 px-3 py-2 text-[13px] text-ink outline-none ring-1 ring-transparent focus:ring-accent/60"
          />
        </div>

        <div className="mt-3 grid grid-cols-2 gap-3">
          <div>
            <label htmlFor="auto-cooldown" className="text-[12px] font-medium text-muted">
              Cooldown (seconds)
            </label>
            <input
              id="auto-cooldown"
              type="number"
              min={10}
              max={3600}
              value={cooldown}
              onChange={event => setCooldown(Number(event.target.value))}
              className="mt-1.5 w-full rounded-lg bg-panel-2 px-3 py-2 text-[13px] text-ink outline-none ring-1 ring-transparent focus:ring-accent/60"
            />
          </div>
          <div>
            <label htmlFor="auto-daily" className="text-[12px] font-medium text-muted">
              Replies per chat / day
            </label>
            <input
              id="auto-daily"
              type="number"
              min={1}
              max={200}
              value={dailyLimit}
              onChange={event => setDailyLimit(Number(event.target.value))}
              className="mt-1.5 w-full rounded-lg bg-panel-2 px-3 py-2 text-[13px] text-ink outline-none ring-1 ring-transparent focus:ring-accent/60"
            />
          </div>
        </div>
      </div>

      <button
        type="button"
        onClick={() => void save()}
        disabled={saving}
        className="inline-flex items-center gap-1.5 rounded-lg bg-accent px-4 py-2 text-[13px] font-medium text-white transition hover:bg-accent-strong disabled:opacity-60"
      >
        {saving && <Loader2 size={14} className="animate-spin" />}
        Save automation
      </button>
    </div>
  );
}

function EmbedTab({
  config,
  sessionId,
  chats,
  active,
}: {
  config: Config;
  sessionId: string | null;
  chats: ChatSummaryLike[];
  active: boolean;
}) {
  const toast = useToast();
  const [tokens, setTokens] = useState<TokenRecord[]>([]);
  const [loading, setLoading] = useState(false);
  const [creating, setCreating] = useState(false);
  const [chatId, setChatId] = useState('');
  const [label, setLabel] = useState('');
  const [origins, setOrigins] = useState('');
  const [days, setDays] = useState(90);
  const [fresh, setFresh] = useState<{ token: string; record: TokenRecord } | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const data = await api.tokens(config);
      setTokens(data.tokens);
    } catch (error) {
      toast.notify(`Could not load tokens: ${(error as Error).message}`, 'error');
    } finally {
      setLoading(false);
    }
  }, [config, toast]);

  useEffect(() => {
    if (active) void load();
  }, [active, load]);

  useEffect(() => {
    if (!chatId && chats.length > 0) setChatId(chats[0].chatId);
  }, [chats, chatId]);

  const create = async () => {
    if (!sessionId || !chatId) {
      toast.notify('Pick a session and a chat first.', 'error');
      return;
    }
    setCreating(true);
    try {
      const data = await api.createToken(config, {
        kind: 'embed',
        label: label.trim() || undefined,
        session: sessionId,
        chatId,
        origins: origins.trim() || undefined,
        expiresInDays: days,
      });
      setFresh(data);
      setLabel('');
      await load();
      toast.notify('Widget token created — copy it now, it is shown once.');
    } catch (error) {
      toast.notify(`Create failed: ${(error as Error).message}`, 'error');
    } finally {
      setCreating(false);
    }
  };

  const revoke = async (token: TokenRecord) => {
    try {
      await api.deleteToken(config, token.id);
      setTokens(current => current.filter(item => item.id !== token.id));
      if (fresh?.record.id === token.id) setFresh(null);
      toast.notify('Token revoked.');
    } catch (error) {
      toast.notify(`Revoke failed: ${(error as Error).message}`, 'error');
    }
  };

  const copy = async (text: string, what: string) => {
    try {
      await navigator.clipboard.writeText(text);
      toast.notify(`${what} copied.`);
    } catch {
      toast.notify('Copy failed — select the text manually.', 'error');
    }
  };

  const host = apiBase(config);
  const snippet = fresh
    ? `<script src="${host}/embed.js"\n        data-token="${fresh.token}"\n        data-title="Chat with us"\n        async></script>`
    : '';
  const embeds = tokens.filter(token => token.kind === 'embed');

  return (
    <div className="mt-4 space-y-4">
      <p className="rounded-lg bg-panel-2 px-3 py-2.5 text-[12px] leading-5 text-muted">
        A widget token can <b className="text-ink">only send</b> a message to one chat you pick, from
        the sites you allow, up to 50 messages a day. It cannot read your chats. Anyone with the token
        can post to that chat, so treat it as public and revoke it if it leaks.
      </p>

      {!sessionId ? (
        <p className="text-[12.5px] text-muted">Pick a session first.</p>
      ) : (
        <div className="space-y-3 rounded-lg border border-line p-3">
          <div>
            <label htmlFor="embed-chat" className="text-[12px] font-medium text-muted">
              Chat the widget writes to
            </label>
            <select
              id="embed-chat"
              value={chatId}
              onChange={event => setChatId(event.target.value)}
              className="mt-1.5 w-full rounded-lg bg-panel-2 px-3 py-2 text-[13px] text-ink outline-none ring-1 ring-transparent focus:ring-accent/60"
            >
              {chats.length === 0 && <option value="">Wake the session to load chats</option>}
              {chats.map(chat => (
                <option key={chat.chatId} value={chat.chatId}>
                  {chat.name} — {chat.chatId}
                </option>
              ))}
            </select>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label htmlFor="embed-label" className="text-[12px] font-medium text-muted">
                Label
              </label>
              <input
                id="embed-label"
                value={label}
                onChange={event => setLabel(event.target.value)}
                placeholder="Website chat"
                className="mt-1.5 w-full rounded-lg bg-panel-2 px-3 py-2 text-[13px] text-ink outline-none ring-1 ring-transparent focus:ring-accent/60"
              />
            </div>
            <div>
              <label htmlFor="embed-days" className="text-[12px] font-medium text-muted">
                Expires in (days)
              </label>
              <input
                id="embed-days"
                type="number"
                min={1}
                max={365}
                value={days}
                onChange={event => setDays(Number(event.target.value))}
                className="mt-1.5 w-full rounded-lg bg-panel-2 px-3 py-2 text-[13px] text-ink outline-none ring-1 ring-transparent focus:ring-accent/60"
              />
            </div>
          </div>
          <div>
            <label htmlFor="embed-origins" className="text-[12px] font-medium text-muted">
              Allowed sites (optional)
            </label>
            <input
              id="embed-origins"
              value={origins}
              onChange={event => setOrigins(event.target.value)}
              placeholder="https://example.com, https://shop.example.com"
              className="mt-1.5 w-full rounded-lg bg-panel-2 px-3 py-2 text-[13px] text-ink outline-none ring-1 ring-transparent focus:ring-accent/60"
            />
            <p className="mt-1 text-[11.5px] text-muted">
              Comma-separated origins. Empty means any site that has the token.
            </p>
          </div>
          <button
            type="button"
            onClick={() => void create()}
            disabled={creating || !chatId}
            className="inline-flex items-center gap-1.5 rounded-lg bg-accent px-4 py-2 text-[13px] font-medium text-white transition hover:bg-accent-strong disabled:opacity-60"
          >
            {creating ? <Loader2 size={14} className="animate-spin" /> : <Plus size={14} />}
            Create widget token
          </button>
        </div>
      )}

      {fresh && (
        <div className="rounded-lg border border-accent/40 bg-accent/5 p-3">
          <div className="text-[12px] font-medium text-ink">Token (shown once)</div>
          <div className="mt-1 flex items-center gap-2">
            <code className="min-w-0 flex-1 break-all rounded bg-panel px-2 py-1.5 text-[11.5px] text-ink">
              {fresh.token}
            </code>
            <button
              type="button"
              onClick={() => void copy(fresh.token, 'Token')}
              className="grid size-8 shrink-0 place-items-center rounded-lg text-muted transition hover:bg-hover hover:text-ink"
              aria-label="Copy token"
            >
              <Copy size={15} />
            </button>
          </div>
          <div className="mt-3 text-[12px] font-medium text-ink">Paste this on your site</div>
          <pre className="mt-1 overflow-auto rounded bg-panel px-2 py-2 text-[11px] leading-5 text-ink">
            {snippet}
          </pre>
          <button
            type="button"
            onClick={() => void copy(snippet, 'Snippet')}
            className="mt-2 inline-flex items-center gap-1.5 rounded-lg border border-line px-2.5 py-1.5 text-[12px] font-medium text-ink transition hover:bg-hover"
          >
            <Copy size={13} /> Copy snippet
          </button>
        </div>
      )}

      <div>
        <div className="flex items-center justify-between">
          <div className="text-[12px] font-medium text-muted">Widget tokens</div>
          {loading && <Loader2 size={13} className="animate-spin text-muted" />}
        </div>
        {embeds.length === 0 ? (
          <p className="mt-1.5 text-[12px] text-muted">None yet.</p>
        ) : (
          <ul className="mt-1.5 space-y-1.5">
            {embeds.map(token => (
              <li
                key={token.id}
                className="flex items-center gap-2 rounded-lg bg-panel-2 px-2.5 py-2 text-[12px]"
              >
                <div className="min-w-0 flex-1">
                  <div className="truncate font-medium text-ink">
                    {token.label} · <span className="font-normal text-muted">{token.prefix}…</span>
                  </div>
                  <div className="truncate text-[11px] text-muted">
                    {token.chatId}
                    {token.expiresAt ? ` · expires ${token.expiresAt.slice(0, 10)}` : ''}
                    {token.origins.length > 0 ? ` · ${token.origins.join(', ')}` : ''}
                  </div>
                </div>
                <button
                  type="button"
                  onClick={() => void revoke(token)}
                  className="grid size-7 shrink-0 place-items-center rounded-md text-muted transition hover:bg-danger/10 hover:text-danger"
                  aria-label={`Revoke ${token.label}`}
                >
                  <Trash2 size={14} />
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
