import { useCallback, useEffect, useState } from 'react';
import { Check, Copy, Loader2, RefreshCw, ShieldCheck, FileSpreadsheet } from 'lucide-react';
import {
  api,
  apiBase,
  type AuthState,
  type Config,
  type SessionSummary,
  type UsageReport,
} from '../lib/api';
import { useToast } from './Toaster';

interface AdminTabProps {
  config: Config;
  sessionId: string | null;
}

export function AdminTab({ config, sessionId }: AdminTabProps) {
  const toast = useToast();
  const [loading, setLoading] = useState(false);
  const [usage, setUsage] = useState<UsageReport | null>(null);
  const [sessions, setSessions] = useState<SessionSummary[]>([]);
  const [auth, setAuth] = useState<AuthState | null>(null);
  const [sheetSession, setSheetSession] = useState(sessionId ?? '');
  const [creating, setCreating] = useState(false);
  const [sheetToken, setSheetToken] = useState<string | null>(null);
  const [copied, setCopied] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [usageReport, sessionList, authState] = await Promise.all([
        api.usage(config),
        api.sessions(config),
        api.auth(config),
      ]);
      setUsage(usageReport);
      setSessions(sessionList.sessions);
      setAuth(authState);
      setSheetSession(current => current || sessionList.sessions[0]?.id || '');
    } catch (error) {
      toast.notify((error as Error).message || 'Could not load the admin overview.', 'error');
    } finally {
      setLoading(false);
    }
  }, [config, toast]);

  useEffect(() => {
    void load();
    // Reload when the dialog reopens against another worker.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [config.base, config.token]);

  const copy = async (value: string, key: string) => {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(key);
      setTimeout(() => setCopied(current => (current === key ? null : current)), 1_500);
    } catch {
      toast.notify('Could not copy — select the text and copy it manually.', 'error');
    }
  };

  const createSheetToken = async () => {
    setCreating(true);
    try {
      const result = await api.createToken(config, {
        kind: 'full',
        label: `Google Sheets — ${sheetSession || 'all sessions'}`,
        expiresInDays: 365,
      });
      setSheetToken(result.token);
      toast.notify('Sheet token created. Copy it into Script Properties now — it is shown once.');
    } catch (error) {
      toast.notify((error as Error).message || 'Could not create the token.', 'error');
    } finally {
      setCreating(false);
    }
  };

  const scriptProperties = [
    `OPENWA_URL = ${apiBase(config)}`,
    `OPENWA_TOKEN = ${sheetToken ?? '<paste the token you generated>'}`,
    `OPENWA_SESSION = ${sheetSession || '<session name>'}`,
    'OPENWA_POLL_MINUTES = 5',
    'OPENWA_INBOX_SHEET = Inbox',
    'OPENWA_OUTBOX_SHEET = Outbox',
  ].join('\n');

  const estimate = usage?.estimate;

  return (
    <div className="mt-4 space-y-4">
      {/* Worker -------------------------------------------------------------- */}
      <section className="rounded-lg border border-line p-3">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <ShieldCheck size={15} className="text-accent" />
            <h3 className="text-[13px] font-semibold text-ink">Worker</h3>
          </div>
          <button
            type="button"
            onClick={() => void load()}
            disabled={loading}
            className="inline-flex items-center gap-1.5 rounded-lg border border-line px-2.5 py-1 text-[11.5px] font-medium text-ink transition hover:bg-hover disabled:opacity-60"
          >
            {loading ? <Loader2 size={12} className="animate-spin" /> : <RefreshCw size={12} />}
            Refresh
          </button>
        </div>
        <dl className="mt-2 grid grid-cols-2 gap-x-3 gap-y-1.5 text-[12px]">
          <dt className="text-muted">Origin</dt>
          <dd className="truncate text-ink">{apiBase(config)}</dd>
          <dt className="text-muted">Login gate</dt>
          <dd className="text-ink">
            {auth?.required ? 'Password + signed cookie' : 'Open (local-dev posture)'}
          </dd>
          <dt className="text-muted">Sessions</dt>
          <dd className="text-ink">
            {sessions.length === 0
              ? 'none yet'
              : sessions.map(session => `${session.id} (${session.status})`).join(', ')}
          </dd>
          <dt className="text-muted">Free-plan estimate</dt>
          <dd className="text-ink">
            {estimate
              ? `${estimate.wakes} wakes · ${estimate.projectedDoGbSeconds.toFixed(0)} GB-s/day · ${estimate.doPercentOfFree.toFixed(1)}% of the free tier`
              : 'unavailable'}
          </dd>
        </dl>
        <p className="mt-1.5 text-[11px] leading-4 text-muted">
          The estimate comes from this worker's own wake counters, not Cloudflare analytics.
        </p>
      </section>

      {/* Google Sheets ------------------------------------------------------- */}
      <section className="rounded-lg border border-line p-3">
        <div className="flex items-center gap-2">
          <FileSpreadsheet size={15} className="text-accent" />
          <h3 className="text-[13px] font-semibold text-ink">Google Sheets drainer</h3>
        </div>
        <p className="mt-1 text-[11.5px] leading-5 text-muted">
          The Apps Script in <code className="rounded bg-panel-2 px-1 text-ink">apps-script/</code>{' '}
          wakes a session, drains new messages into a sheet, then acks and idles it. Configure it
          entirely from script properties — no editing the code.
        </p>

        <div className="mt-2 grid gap-2 sm:grid-cols-[1fr_auto]">
          <label className="text-[12px] font-medium text-muted">
            Session to drain
            <select
              value={sheetSession}
              onChange={event => setSheetSession(event.target.value)}
              className="mt-1 w-full rounded-lg bg-panel-2 px-3 py-2 text-[13px] text-ink outline-none ring-1 ring-transparent focus:ring-accent/60"
            >
              {sessions.length === 0 && <option value="">No sessions yet</option>}
              {sessions.map(session => (
                <option key={session.id} value={session.id}>
                  {session.id} — {session.status}
                </option>
              ))}
            </select>
          </label>
          <button
            type="button"
            onClick={() => void createSheetToken()}
            disabled={creating}
            className="mt-auto inline-flex items-center justify-center gap-1.5 rounded-lg bg-accent px-3 py-2 text-[12.5px] font-medium text-white transition hover:bg-accent-strong disabled:opacity-60"
          >
            {creating ? <Loader2 size={14} className="animate-spin" /> : <ShieldCheck size={14} />}
            Create sheet token
          </button>
        </div>
        <p className="mt-1.5 text-[11px] leading-4 text-muted">
          A sheet token is a full admin token: it can read chats and send messages. Keep it in Apps
          Script properties, never in a cell, and delete it when the sheet is retired.
        </p>

        <ol className="mt-3 list-decimal space-y-1 pl-4 text-[11.5px] leading-5 text-muted">
          <li>Open the sheet → Extensions → Apps Script.</li>
          <li>
            Paste <code className="rounded bg-panel-2 px-1 text-ink">apps-script/Code.gs</code>, then
            run <code className="rounded bg-panel-2 px-1 text-ink">setup()</code> once and approve the
            permissions.
          </li>
          <li>Fill Script Properties with the block below (Project Settings → Script properties).</li>
          <li>
            Add a time-driven trigger for{' '}
            <code className="rounded bg-panel-2 px-1 text-ink">drainAll</code> every 5 minutes —
            the Setup… menu installs it for you.
          </li>
          <li>
            Run <code className="rounded bg-panel-2 px-1 text-ink">testConnection()</code> to check
            the URL, token and session before walking away.
          </li>
        </ol>

        <div className="mt-2 rounded-lg bg-panel-2 p-2.5">
          <div className="flex items-center justify-between">
            <span className="text-[11.5px] font-medium text-muted">Script properties</span>
            <button
              type="button"
              onClick={() => void copy(scriptProperties, 'props')}
              className="inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[11.5px] text-muted transition hover:bg-hover hover:text-ink"
            >
              {copied === 'props' ? <Check size={12} /> : <Copy size={12} />} Copy
            </button>
          </div>
          <pre className="mt-1 overflow-auto text-[11px] leading-5 text-ink">{scriptProperties}</pre>
        </div>
        {sheetToken && (
          <div className="mt-2 rounded-lg border border-accent/40 bg-accent/5 p-2.5">
            <div className="text-[11.5px] font-medium text-ink">New sheet token (shown once)</div>
            <div className="mt-1 flex items-center gap-2">
              <code className="min-w-0 flex-1 break-all rounded bg-panel px-2 py-1 text-[11px] text-ink">
                {sheetToken}
              </code>
              <button
                type="button"
                onClick={() => void copy(sheetToken, 'token')}
                className="grid size-7 shrink-0 place-items-center rounded text-muted transition hover:bg-hover hover:text-ink"
                aria-label="Copy token"
              >
                {copied === 'token' ? <Check size={13} /> : <Copy size={13} />}
              </button>
            </div>
          </div>
        )}

        <p className="mt-2 text-[11.5px] leading-5 text-muted">
          Full setup notes live in <code className="rounded bg-panel-2 px-1 text-ink">apps-script/README.md</code>.
        </p>
      </section>

      {/* Pointers so the admin surface answers "what else can I connect?" */}
      <section className="rounded-lg border border-line p-3">
        <h3 className="text-[13px] font-semibold text-ink">Integrations</h3>
        <ul className="mt-1.5 space-y-1 text-[11.5px] leading-5 text-muted">
          <li>
            <b className="text-ink">Webhook</b> — set <code className="rounded bg-panel-2 px-1 text-ink">INBOUND_WEBHOOK_URL</code>{' '}
            to POST every inbound message to n8n, Make or your own service.
          </li>
          <li>
            <b className="text-ink">Send tokens</b> — the Sending tab creates server tokens for
            invoices and notifications; the examples folder has Node and curl callers.
          </li>
          <li>
            <b className="text-ink">Outbox + cron</b> — <code className="rounded bg-panel-2 px-1 text-ink">examples/outbox-cron</code>{' '}
            queues messages in SQLite and drains them on a schedule.
          </li>
        </ul>
      </section>
    </div>
  );
}
