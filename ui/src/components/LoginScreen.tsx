import { useState, type FormEvent } from 'react';
import { ArrowRight, Eye, EyeOff, Link2, Loader2, Lock } from 'lucide-react';
import { api, ApiError, apiBase, type Config } from '../lib/api';

interface LoginScreenProps {
  config: Config;
  onConfig: (config: Config) => void;
  onSignedIn: () => void;
  /** Set when /api/auth could not be reached at all. */
  unreachable?: string;
}

/**
 * Full-screen gate shown until the worker hands out a session cookie.
 * The password never lands in localStorage; the cookie is HttpOnly.
 */
export function LoginScreen({ config, onConfig, onSignedIn, unreachable }: LoginScreenProps) {
  const [password, setPassword] = useState('');
  const [reveal, setReveal] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [showConnection, setShowConnection] = useState(Boolean(unreachable));
  const [base, setBase] = useState(config.base);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!password.trim() || busy) return;
    setBusy(true);
    setError('');
    try {
      const result = await api.login(config, password);
      if (result.required === false) {
        // Nothing is configured on the worker, so there is nothing to sign in to.
        onSignedIn();
        return;
      }
      setPassword('');
      onSignedIn();
    } catch (failure) {
      if (failure instanceof ApiError && failure.status === 401) {
        setError('Wrong password.');
      } else if (failure instanceof ApiError && failure.status === 429) {
        setError('Too many attempts. Wait a few minutes and try again.');
      } else {
        setError(`Could not sign in: ${(failure as Error).message}`);
      }
    } finally {
      setBusy(false);
    }
  };

  const saveConnection = () => {
    onConfig({ ...config, base: base.trim().replace(/\/+$/, '') });
    setShowConnection(false);
    setError('');
  };

  return (
    <div className="wallpaper flex min-h-dvh w-full items-center justify-center px-5 py-10">
      <div className="w-full max-w-[420px] rounded-2xl bg-panel p-7 shadow-2xl">
        <div className="flex items-center gap-3">
          <img src="/logo.svg" alt="" width={46} height={46} className="rounded-xl shadow-sm" />
          <div>
            <h1 className="text-[19px] font-semibold text-ink">Sign in to OpenWA</h1>
            <p className="text-[12.5px] text-muted">This gateway is password protected.</p>
          </div>
        </div>

        {unreachable && (
          <p className="mt-5 rounded-lg bg-danger/10 px-3 py-2.5 text-[12.5px] leading-5 text-danger">
            Cannot reach the worker at <b>{apiBase(config)}</b>: {unreachable}
          </p>
        )}

        <form onSubmit={submit} className="mt-6 space-y-4">
          <div>
            <label htmlFor="password" className="text-[12px] font-medium text-muted">
              Password
            </label>
            <div className="relative mt-1.5">
              <Lock size={15} className="absolute top-1/2 left-3 -translate-y-1/2 text-muted" />
              <input
                id="password"
                type={reveal ? 'text' : 'password'}
                value={password}
                onChange={event => setPassword(event.target.value)}
                autoFocus
                autoComplete="current-password"
                placeholder="UI_PASSWORD"
                className="w-full rounded-lg bg-panel-2 py-2.5 pr-10 pl-9 text-[14px] text-ink outline-none ring-1 ring-transparent focus:ring-accent/60"
              />
              <button
                type="button"
                onClick={() => setReveal(value => !value)}
                aria-label={reveal ? 'Hide password' : 'Show password'}
                className="absolute top-1/2 right-2.5 -translate-y-1/2 text-muted transition hover:text-ink"
              >
                {reveal ? <EyeOff size={16} /> : <Eye size={16} />}
              </button>
            </div>
            <p className="mt-1.5 text-[11.5px] leading-4 text-muted">
              The worker&apos;s <code className="rounded bg-panel-2 px-1">UI_PASSWORD</code> secret (or{' '}
              <code className="rounded bg-panel-2 px-1">API_TOKEN</code> when no separate password is set).
            </p>
          </div>

          {error && <p className="text-[12.5px] text-danger">{error}</p>}

          <button
            type="submit"
            disabled={busy || !password.trim()}
            className="flex w-full items-center justify-center gap-2 rounded-lg bg-accent px-4 py-2.5 text-[14px] font-medium text-white transition hover:bg-accent-strong disabled:opacity-60"
          >
            {busy ? <Loader2 size={16} className="animate-spin" /> : null}
            Sign in
            {!busy && <ArrowRight size={16} />}
          </button>
        </form>

        <div className="mt-5 border-t border-line pt-4">
          <button
            type="button"
            onClick={() => setShowConnection(value => !value)}
            className="inline-flex items-center gap-1.5 text-[12px] font-medium text-muted transition hover:text-ink"
          >
            <Link2 size={13} /> {showConnection ? 'Hide connection details' : 'Connection details'}
          </button>
          {showConnection && (
            <div className="mt-3">
              <label htmlFor="login-worker-url" className="text-[12px] font-medium text-muted">
                Worker URL
              </label>
              <input
                id="login-worker-url"
                value={base}
                onChange={event => setBase(event.target.value)}
                placeholder="https://openwa-worker.example.workers.dev"
                className="mt-1.5 w-full rounded-lg bg-panel-2 px-3 py-2 text-[13px] text-ink outline-none ring-1 ring-transparent focus:ring-accent/60"
              />
              <div className="mt-2 flex items-center justify-between gap-2">
                <p className="text-[11.5px] text-muted">Leave empty when the UI is served by this worker.</p>
                <button
                  type="button"
                  onClick={saveConnection}
                  className="shrink-0 rounded-lg border border-line px-3 py-1.5 text-[12px] font-medium text-ink transition hover:bg-hover"
                >
                  Save
                </button>
              </div>
            </div>
          )}
        </div>

        <p className="mt-5 text-[11.5px] leading-4 text-muted">
          Signing in stores a signed, expiring cookie in this browser — never your password. Scripts
          keep using <code className="rounded bg-panel-2 px-1">X-API-Key</code>.
        </p>
      </div>
    </div>
  );
}
