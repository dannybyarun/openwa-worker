import { useEffect, useState } from 'react';
import * as Dialog from '@radix-ui/react-dialog';
import { CheckCircle2, Loader2, LogOut, Moon, Sun, X } from 'lucide-react';
import { api, apiBase, type Config, type SessionStatus } from '../lib/api';
import { useToast } from './Toaster';

interface SettingsDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  config: Config;
  onSave: (config: Config) => void;
  theme: 'dark' | 'light';
  onTheme: (theme: 'dark' | 'light') => void;
  status?: SessionStatus;
  /** Present when the worker has a password set; drops the browser session cookie. */
  onSignOut?: () => void;
}

export function SettingsDialog({
  open,
  onOpenChange,
  config,
  onSave,
  theme,
  onTheme,
  status,
  onSignOut,
}: SettingsDialogProps) {
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
        <Dialog.Content className="dialog-content p-5" aria-describedby={undefined}>
          <div className="flex items-start justify-between gap-4">
            <div>
              <Dialog.Title className="text-[17px] font-semibold text-ink">Settings</Dialog.Title>
              <p className="mt-1 text-[12.5px] leading-5 text-muted">
                You are signed in with the worker password; the browser only holds a signed session
                cookie. Scripts and other clients use <code className="rounded bg-panel-2 px-1">X-API-Key</code>.
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

          <div className="mt-5 space-y-4">
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
              <p className="mt-1 text-[11.5px] text-muted">Leave empty when the UI is served by the worker itself.</p>
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
                      theme === option ? 'bg-accent/10 text-accent ring-accent/40' : 'bg-panel-2 text-ink ring-line hover:bg-hover'
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
                {wake.limit ? ` / ${wake.limit}` : ''} connects. Every wake holds the socket for one idle
                window.
              </div>
            )}
          </div>

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
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
