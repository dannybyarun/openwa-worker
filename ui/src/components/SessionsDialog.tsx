import { useState } from 'react';
import * as Dialog from '@radix-ui/react-dialog';
import { useQueryClient } from '@tanstack/react-query';
import { Loader2, LogOut, Plus, QrCode, Trash2, X } from 'lucide-react';
import { api, type Config, type SessionSummary } from '../lib/api';
import { StatusDot, statusLabel } from './StatusPill';
import { useToast } from './Toaster';

interface SessionsDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  config: Config;
  sessions: SessionSummary[];
  activeId: string | null;
  onSelect: (id: string) => void;
  onPair: (id: string) => void;
  onOpenSettings: () => void;
}

const NAME_RE = /^[a-zA-Z0-9_-]{1,64}$/;

export function SessionsDialog({
  open,
  onOpenChange,
  config,
  sessions,
  activeId,
  onSelect,
  onPair,
  onOpenSettings,
}: SessionsDialogProps) {
  const [name, setName] = useState('');
  const [creating, setCreating] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const toast = useToast();
  const queryClient = useQueryClient();

  const refresh = () =>
    queryClient.invalidateQueries({ queryKey: ['sessions', config.base, config.token] });

  const create = async () => {
    const value = name.trim();
    if (!NAME_RE.test(value)) {
      toast.notify('Session names use letters, digits, - and _ (max 64).', 'error');
      return;
    }
    setCreating(true);
    try {
      const created = await api.createSession(config, value);
      setName('');
      await refresh();
      onSelect(created.id);
      toast.notify(`Session "${created.id}" created — link a device to start.`);
    } catch (error) {
      toast.notify(`Create failed: ${(error as Error).message}`, 'error');
    } finally {
      setCreating(false);
    }
  };

  const check = async (target: SessionSummary, action: 'wake' | 'logout' | 'delete') => {
    if (action === 'logout' && !window.confirm(`Log out "${target.id}"? The device link is removed and credentials wiped.`)) return;
    if (action === 'delete' && !window.confirm(`Delete session "${target.id}"? Its stored history is wiped.`)) return;
    setBusy(target.id + action);
    try {
      if (action === 'wake') await api.start(config, target.id);
      if (action === 'logout') await api.logout(config, target.id);
      if (action === 'delete') await api.deleteSession(config, target.id);
      await refresh();
    } catch (error) {
      toast.notify(`${action} failed: ${(error as Error).message}`, 'error');
    } finally {
      setBusy(null);
    }
  };

  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="dialog-overlay" />
        <Dialog.Content className="dialog-content p-5" aria-describedby={undefined}>
          <div className="flex items-start justify-between gap-4">
            <div>
              <Dialog.Title className="text-[17px] font-semibold text-ink">Devices &amp; sessions</Dialog.Title>
              <p className="mt-1 text-[12.5px] leading-5 text-muted">
                One session is one linked WhatsApp account. Pick the one this page should show.
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

          <div className="mt-4 space-y-2">
            {sessions.length === 0 && (
              <p className="rounded-lg bg-panel-2 px-3 py-4 text-center text-[12.5px] text-muted">
                No sessions on this worker yet. Create one below.
              </p>
            )}
            {sessions.map(session => {
              const active = session.id === activeId;
              return (
                <div
                  key={session.id}
                  className={`rounded-lg px-3 py-2.5 ring-1 ${active ? 'bg-panel-2 ring-accent/40' : 'ring-line'}`}
                >
                  <div className="flex items-center gap-2">
                    <StatusDot status={session.status} />
                    <button
                      type="button"
                      onClick={() => {
                        onSelect(session.id);
                        onOpenChange(false);
                      }}
                      className="min-w-0 flex-1 truncate text-left text-[14px] font-medium text-ink hover:underline"
                    >
                      {session.id}
                    </button>
                    <span className="shrink-0 text-[11px] text-muted">{statusLabel(session.status)}</span>
                  </div>
                  <div className="mt-2 flex flex-wrap gap-1.5">
                    {session.status !== 'connected' && (
                      <button
                        type="button"
                        onClick={() => {
                          onSelect(session.id);
                          onPair(session.id);
                          onOpenChange(false);
                        }}
                        className="inline-flex items-center gap-1 rounded-full bg-accent/10 px-2.5 py-1 text-[11.5px] font-medium text-accent hover:bg-accent/20"
                      >
                        <QrCode size={13} /> Pair
                      </button>
                    )}
                    <button
                      type="button"
                      onClick={() => void check(session, 'wake')}
                      className="inline-flex items-center gap-1 rounded-full bg-panel-2 px-2.5 py-1 text-[11.5px] text-ink hover:bg-hover"
                    >
                      {busy === session.id + 'wake' ? <Loader2 size={13} className="animate-spin" /> : null}
                      Wake
                    </button>
                    <button
                      type="button"
                      onClick={() => void check(session, 'logout')}
                      className="inline-flex items-center gap-1 rounded-full bg-panel-2 px-2.5 py-1 text-[11.5px] text-ink hover:bg-hover"
                    >
                      {busy === session.id + 'logout' ? <Loader2 size={13} className="animate-spin" /> : <LogOut size={13} />}
                      Logout
                    </button>
                    <button
                      type="button"
                      onClick={() => void check(session, 'delete')}
                      className="inline-flex items-center gap-1 rounded-full px-2.5 py-1 text-[11.5px] text-danger hover:bg-danger/10"
                    >
                      {busy === session.id + 'delete' ? <Loader2 size={13} className="animate-spin" /> : <Trash2 size={13} />}
                      Delete
                    </button>
                  </div>
                </div>
              );
            })}
          </div>

          <div className="mt-5 border-t border-line pt-4">
            <label className="text-[12px] font-medium text-muted" htmlFor="new-session">
              New session
            </label>
            <div className="mt-1.5 flex gap-2">
              <input
                id="new-session"
                value={name}
                onChange={event => setName(event.target.value)}
                onKeyDown={event => {
                  if (event.key === 'Enter') void create();
                }}
                placeholder="e.g. support-bot"
                className="min-w-0 flex-1 rounded-lg bg-panel-2 px-3 py-2 text-[13.5px] text-ink outline-none ring-1 ring-transparent focus:ring-accent/60"
              />
              <button
                type="button"
                onClick={() => void create()}
                disabled={creating}
                className="inline-flex items-center gap-1.5 rounded-lg bg-accent px-3 py-2 text-[13px] font-medium text-white transition hover:bg-accent-strong disabled:opacity-60"
              >
                {creating ? <Loader2 size={15} className="animate-spin" /> : <Plus size={15} />}
                Create
              </button>
            </div>
            <button
              type="button"
              onClick={() => {
                onOpenChange(false);
                onOpenSettings();
              }}
              className="mt-3 text-[11.5px] text-accent hover:underline"
            >
              Wrong worker URL or signed out? Open settings
            </button>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
