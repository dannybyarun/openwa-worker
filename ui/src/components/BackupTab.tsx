import { useRef, useState } from 'react';
import {
  AlertTriangle,
  Check,
  Copy,
  Download,
  FileJson,
  FileText,
  KeyRound,
  Loader2,
  Upload,
} from 'lucide-react';
import {
  api,
  type AuthBackup,
  type Config,
  type SessionSettings,
  type SessionSettingsPatch,
  type SessionStatus,
  type TokenRecord,
} from '../lib/api';
import { buildChats, mergeChatIndex, type ChatSummary } from '../lib/format';
import { useToast } from './Toaster';

interface BackupTabProps {
  config: Config;
  sessionId: string | null;
  status?: SessionStatus;
}

/** Beautiful-adjacent but boring on purpose: these files leave the browser, so keep them plain. */
interface SettingsBackup {
  kind: 'openwa-settings-backup';
  version: 1;
  session: string;
  exportedAt: string;
  settings: SessionSettings;
  tokens: Array<{
    label: string;
    kind: TokenRecord['kind'];
    session?: string;
    chatId?: string;
    chatIds?: string[];
    origins: string[];
    expiresAt?: string;
    createdAt: string;
  }>;
}

interface ChatBackup {
  kind: 'openwa-chat-export';
  version: 1;
  session: string;
  exportedAt: string;
  chats: Array<{
    chatId: string;
    name: string;
    messages: ChatSummary['messages'];
  }>;
}

const stamp = () => new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');

function saveFile(name: string, body: string, mime: string): void {
  const blob = new Blob([body], { type: mime });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = name;
  anchor.click();
  // Give the browser a moment to start the download before revoking.
  setTimeout(() => URL.revokeObjectURL(url), 1_000);
}

async function readJson<T>(file: File): Promise<T> {
  const text = await file.text();
  return JSON.parse(text) as T;
}

function readableTime(iso?: string): string {
  if (!iso) return '';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(
    date.getHours(),
  )}:${pad(date.getMinutes())}`;
}

export function BackupTab({ config, sessionId, status }: BackupTabProps) {
  const toast = useToast();
  const [busy, setBusy] = useState<string | null>(null);
  const [copied, setCopied] = useState<string | null>(null);

  const settingsFile = useRef<HTMLInputElement>(null);
  const authFile = useRef<HTMLInputElement>(null);

  const [confirmName, setConfirmName] = useState('');
  const [authAck, setAuthAck] = useState(false);
  const [restored, setRestored] = useState<Array<{ label: string; kind: string; token: string }>>([]);

  const connectionOpen = Boolean(
    status && (status.status === 'connected' || status.status === 'connecting'),
  );

  const copy = async (value: string, key: string) => {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(key);
      setTimeout(() => setCopied(current => (current === key ? null : current)), 1_500);
    } catch {
      toast.notify('Could not copy — select the text and copy it manually.', 'error');
    }
  };

  const loadChats = async (): Promise<{ chats: ChatSummary[]; id: string }> => {
    if (!sessionId) throw new Error('Pick a session first.');
    const history = await api.history(config, sessionId);
    const messages = mergeChatIndex(history.messages ?? [], history.chats);
    return { chats: buildChats(messages, {}, history.groups), id: sessionId };
  };

  const exportChats = async (format: 'json' | 'txt') => {
    setBusy(`chats-${format}`);
    try {
      const { chats, id } = await loadChats();
      const exportedAt = new Date().toISOString();
      if (format === 'json') {
        const payload: ChatBackup = {
          kind: 'openwa-chat-export',
          version: 1,
          session: id,
          exportedAt,
          chats: chats.map(chat => ({
            chatId: chat.chatId,
            name: chat.name,
            messages: chat.messages,
          })),
        };
        saveFile(
          `openwa-${id}-chats-${stamp()}.json`,
          JSON.stringify(payload, null, 2),
          'application/json',
        );
      } else {
        const lines: string[] = [
          `OpenWA chat export — session ${id}`,
          `Exported ${exportedAt}`,
          '',
        ];
        for (const chat of chats) {
          lines.push(`===== ${chat.name} (${chat.chatId}) =====`, '');
          for (const message of chat.messages) {
            const who = message.fromMe
              ? 'Me'
              : message.pushName?.trim() || message.sender || chat.chatId;
            const text = message.text?.trim() || `(${message.type ?? 'message'})`;
            lines.push(`[${readableTime(message.timestamp)}] ${who}: ${text}`);
          }
          lines.push('');
        }
        saveFile(`openwa-${id}-chats-${stamp()}.txt`, lines.join('\n'), 'text/plain');
      }
      toast.notify(
        `Exported ${chats.length} chat${chats.length === 1 ? '' : 's'} as ${format.toUpperCase()}.`,
      );
    } catch (error) {
      toast.notify((error as Error).message || 'Export failed.', 'error');
    } finally {
      setBusy(null);
    }
  };

  const exportSettings = async () => {
    if (!sessionId) return;
    setBusy('settings-export');
    try {
      const [page, tokens] = await Promise.all([
        api.settings(config, sessionId),
        api.tokens(config),
      ]);
      const payload: SettingsBackup = {
        kind: 'openwa-settings-backup',
        version: 1,
        session: sessionId,
        exportedAt: new Date().toISOString(),
        settings: page.settings,
        // Token values are never stored, so only the definitions travel. Import re-creates them.
        tokens: tokens.tokens.map(token => ({
          label: token.label,
          kind: token.kind,
          session: token.session,
          chatId: token.chatId,
          chatIds: token.chatIds,
          origins: token.origins,
          expiresAt: token.expiresAt,
          createdAt: token.createdAt,
        })),
      };
      saveFile(
        `openwa-${sessionId}-settings-${stamp()}.json`,
        JSON.stringify(payload, null, 2),
        'application/json',
      );
      toast.notify('Settings and token definitions exported. API keys are not included.');
    } catch (error) {
      toast.notify((error as Error).message || 'Export failed.', 'error');
    } finally {
      setBusy(null);
    }
  };

  const importSettings = async (file: File) => {
    if (!sessionId) return;
    setBusy('settings-import');
    try {
      const backup = await readJson<SettingsBackup>(file);
      if (backup.kind !== 'openwa-settings-backup' || !backup.settings) {
        throw new Error('That is not an OpenWA settings backup.');
      }
      const ai = backup.settings.ai;
      const patch: SessionSettingsPatch = {
        ai: ai
          ? {
              provider: ai.provider,
              model: ai.model ?? null,
              baseUrl: ai.baseUrl ?? null,
              // The key is write-only and never exported; keep the stored one instead.
              apiKey: null,
            }
          : null,
        autoReply: backup.settings.autoReply ?? null,
      };
      await api.saveSettings(config, sessionId, patch);

      const existing = await api.tokens(config);
      const known = new Set(existing.tokens.map(token => `${token.kind}:${token.label}`));
      const created: Array<{ label: string; kind: string; token: string }> = [];
      const skipped: string[] = [];
      for (const token of backup.tokens ?? []) {
        if (token.kind === 'embed' && !token.chatId) {
          skipped.push(`${token.label || 'widget'} (no chat in the backup)`);
          continue;
        }
        const key = `${token.kind}:${token.label}`;
        if (known.has(key)) {
          skipped.push(`${token.label || token.kind} (already present)`);
          continue;
        }
        try {
          const days = token.expiresAt
            ? Math.max(1, Math.ceil((Date.parse(token.expiresAt) - Date.now()) / 86_400_000))
            : 90;
          const result = await api.createToken(config, {
            kind: token.kind,
            label: token.label || `Restored ${token.kind}`,
            session: token.session || sessionId,
            chatId: token.chatId,
            chatIds: token.chatIds?.join(', '),
            origins: token.origins.join(', '),
            expiresInDays: days,
          });
          created.push({ label: result.record.label, kind: result.record.kind, token: result.token });
          known.add(key);
        } catch (error) {
          skipped.push(`${token.label || token.kind} (${(error as Error).message})`);
        }
      }
      setRestored(created);
      toast.notify(
        `Settings restored. ${created.length} token${created.length === 1 ? '' : 's'} re-created${
          skipped.length ? `, ${skipped.length} skipped` : ''
        }. Re-enter the AI API key if you use one.`,
      );
    } catch (error) {
      toast.notify((error as Error).message || 'Import failed.', 'error');
    } finally {
      setBusy(null);
      if (settingsFile.current) settingsFile.current.value = '';
    }
  };

  const exportAuth = async () => {
    if (!sessionId) return;
    setBusy('auth-export');
    try {
      const backup = await api.authExport(config, sessionId);
      saveFile(
        `openwa-${sessionId}-credentials-${stamp()}.json`,
        JSON.stringify(backup, null, 2),
        'application/json',
      );
      toast.notify('Credentials exported. Treat that file like the phone itself.');
    } catch (error) {
      toast.notify((error as Error).message || 'Export failed.', 'error');
    } finally {
      setBusy(null);
    }
  };

  const importAuth = async (file: File) => {
    if (!sessionId) return;
    if (!authAck) {
      toast.notify('Tick the acknowledgement first.', 'error');
      return;
    }
    setBusy('auth-import');
    try {
      const backup = await readJson<AuthBackup>(file);
      if (backup.kind !== 'openwa-auth-backup' || !backup.entries) {
        throw new Error('That is not an OpenWA credential backup.');
      }
      const result = await api.authImport(config, sessionId, backup.entries);
      toast.notify(
        `Credentials restored (${result.restored} keys). Wake the session to reconnect as the imported account.`,
      );
      setConfirmName('');
      setAuthAck(false);
    } catch (error) {
      toast.notify((error as Error).message || 'Import failed.', 'error');
    } finally {
      setBusy(null);
      if (authFile.current) authFile.current.value = '';
    }
  };

  if (!sessionId) {
    return (
      <p className="mt-4 rounded-lg bg-panel-2 px-3 py-3 text-[12.5px] text-muted">
        Create or pick a WhatsApp session first — backups are per session.
      </p>
    );
  }

  return (
    <div className="mt-4 space-y-4">
      {/* Chats ---------------------------------------------------------------- */}
      <section className="rounded-lg border border-line p-3">
        <div className="flex items-center gap-2">
          <FileJson size={15} className="text-accent" />
          <h3 className="text-[13px] font-semibold text-ink">Chats</h3>
        </div>
        <p className="mt-1 text-[11.5px] leading-5 text-muted">
          Download every chat this session remembers (the live buffer plus the durable chat index).
          JSON is for machines; the text file is a readable transcript.
        </p>
        <div className="mt-2 flex flex-wrap gap-2">
          <button
            type="button"
            onClick={() => void exportChats('json')}
            disabled={busy !== null}
            className="inline-flex items-center gap-1.5 rounded-lg border border-line px-3 py-1.5 text-[12px] font-medium text-ink transition hover:bg-hover disabled:opacity-60"
          >
            {busy === 'chats-json' ? (
              <Loader2 size={13} className="animate-spin" />
            ) : (
              <Download size={13} />
            )}
            JSON
          </button>
          <button
            type="button"
            onClick={() => void exportChats('txt')}
            disabled={busy !== null}
            className="inline-flex items-center gap-1.5 rounded-lg border border-line px-3 py-1.5 text-[12px] font-medium text-ink transition hover:bg-hover disabled:opacity-60"
          >
            {busy === 'chats-txt' ? (
              <Loader2 size={13} className="animate-spin" />
            ) : (
              <FileText size={13} />
            )}
            Text transcript
          </button>
        </div>
      </section>

      {/* Settings + tokens ---------------------------------------------------- */}
      <section className="rounded-lg border border-line p-3">
        <div className="flex items-center gap-2">
          <KeyRound size={15} className="text-accent" />
          <h3 className="text-[13px] font-semibold text-ink">Settings &amp; tokens</h3>
        </div>
        <p className="mt-1 text-[11.5px] leading-5 text-muted">
          AI model, auto-reply rules and token definitions. Token values are never stored, so an
          import re-creates equivalent tokens and shows each new value once. AI API keys are not
          exported — re-enter them after a restore.
        </p>
        <div className="mt-2 flex flex-wrap gap-2">
          <button
            type="button"
            onClick={() => void exportSettings()}
            disabled={busy !== null}
            className="inline-flex items-center gap-1.5 rounded-lg border border-line px-3 py-1.5 text-[12px] font-medium text-ink transition hover:bg-hover disabled:opacity-60"
          >
            {busy === 'settings-export' ? (
              <Loader2 size={13} className="animate-spin" />
            ) : (
              <Download size={13} />
            )}
            Export
          </button>
          <button
            type="button"
            onClick={() => settingsFile.current?.click()}
            disabled={busy !== null}
            className="inline-flex items-center gap-1.5 rounded-lg border border-line px-3 py-1.5 text-[12px] font-medium text-ink transition hover:bg-hover disabled:opacity-60"
          >
            {busy === 'settings-import' ? (
              <Loader2 size={13} className="animate-spin" />
            ) : (
              <Upload size={13} />
            )}
            Import
          </button>
          <input
            ref={settingsFile}
            type="file"
            accept="application/json,.json"
            className="hidden"
            onChange={event => {
              const file = event.target.files?.[0];
              if (file) void importSettings(file);
            }}
          />
        </div>
        {restored.length > 0 && (
          <div className="mt-3 rounded-lg border border-accent/40 bg-accent/5 p-2.5">
            <div className="text-[12px] font-medium text-ink">New token values (shown once)</div>
            <ul className="mt-1.5 space-y-1.5">
              {restored.map(item => (
                <li key={item.token} className="flex items-center gap-2">
                  <span className="w-28 shrink-0 truncate text-[11.5px] text-muted">
                    {item.label}
                  </span>
                  <code className="min-w-0 flex-1 truncate rounded bg-panel px-2 py-1 text-[11px] text-ink">
                    {item.token}
                  </code>
                  <button
                    type="button"
                    onClick={() => void copy(item.token, item.token)}
                    className="grid size-7 shrink-0 place-items-center rounded text-muted transition hover:bg-hover hover:text-ink"
                    aria-label="Copy token"
                  >
                    {copied === item.token ? <Check size={13} /> : <Copy size={13} />}
                  </button>
                </li>
              ))}
            </ul>
          </div>
        )}
      </section>

      {/* Session credentials -------------------------------------------------- */}
      <section className="rounded-lg border border-line p-3">
        <div className="flex items-center gap-2">
          <AlertTriangle size={15} className="text-danger" />
          <h3 className="text-[13px] font-semibold text-ink">Session credentials</h3>
        </div>
        <p className="mt-1 text-[11.5px] leading-5 text-muted">
          Moves the linked WhatsApp account to another deployment without scanning a QR again. The
          file holds the device keys: anyone with it controls the number. Export only while the
          session is idle, store it encrypted, and delete it afterwards.
        </p>
        <div className="mt-2 flex flex-wrap gap-2">
          <button
            type="button"
            onClick={() => void exportAuth()}
            disabled={busy !== null || connectionOpen}
            className="inline-flex items-center gap-1.5 rounded-lg border border-line px-3 py-1.5 text-[12px] font-medium text-ink transition hover:bg-hover disabled:opacity-60"
            title={connectionOpen ? 'Send the session to idle first' : undefined}
          >
            {busy === 'auth-export' ? (
              <Loader2 size={13} className="animate-spin" />
            ) : (
              <Download size={13} />
            )}
            Export credentials
          </button>
        </div>
        {connectionOpen && (
          <p className="mt-1.5 text-[11.5px] text-danger">
            The socket is open. Close it from the Connection tab (or let the idle window expire)
            before exporting.
          </p>
        )}

        <div className="mt-3 space-y-2 border-t border-line pt-3">
          <label className="flex items-start gap-2 text-[11.5px] leading-5 text-muted">
            <input
              type="checkbox"
              checked={authAck}
              onChange={event => setAuthAck(event.target.checked)}
              className="mt-1 accent-accent"
            />
            <span>
              I understand that importing replaces this session's credentials and signs out whatever
              account is linked now.
            </span>
          </label>
          <div className="flex flex-wrap items-center gap-2">
            <input
              value={confirmName}
              onChange={event => setConfirmName(event.target.value)}
              placeholder={`Type "${sessionId}" to confirm`}
              className="min-w-0 flex-1 rounded-lg bg-panel-2 px-3 py-1.5 text-[12px] text-ink outline-none ring-1 ring-transparent focus:ring-accent/60"
            />
            <button
              type="button"
              onClick={() => authFile.current?.click()}
              disabled={busy !== null || !authAck || confirmName !== sessionId}
              className="inline-flex items-center gap-1.5 rounded-lg border border-line px-3 py-1.5 text-[12px] font-medium text-ink transition hover:bg-hover disabled:opacity-60"
            >
              {busy === 'auth-import' ? (
                <Loader2 size={13} className="animate-spin" />
              ) : (
                <Upload size={13} />
              )}
              Import credentials
            </button>
            <input
              ref={authFile}
              type="file"
              accept="application/json,.json"
              className="hidden"
              onChange={event => {
                const file = event.target.files?.[0];
                if (file) void importAuth(file);
              }}
            />
          </div>
        </div>
      </section>

      <p className="text-[11.5px] leading-5 text-muted">
        The outbox queue is exported from the example worker instead:{' '}
        <code className="rounded bg-panel-2 px-1 text-ink">node run.mjs --export queue.json</code> in{' '}
        <code className="rounded bg-panel-2 px-1 text-ink">examples/outbox-cron</code>.
      </p>
    </div>
  );
}
