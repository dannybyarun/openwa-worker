import * as Dialog from '@radix-ui/react-dialog';
import { AlertTriangle, Gauge, Loader2, X } from 'lucide-react';
import { apiBase, type Config } from '../lib/api';
import { useUsage } from '../hooks/useGateway';

interface UsageDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  config: Config;
}

/** Free-plan guard rail: wake budget per session plus an estimated DO duration for today. */
export function UsageDialog({ open, onOpenChange, config }: UsageDialogProps) {
  const usage = useUsage(config, open);
  const data = usage.data;

  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="dialog-overlay" />
        <Dialog.Content className="dialog-content p-5" aria-describedby={undefined}>
          <div className="flex items-start justify-between gap-4">
            <div className="flex items-start gap-3">
              <div className="grid size-10 shrink-0 place-items-center rounded-full bg-accent/10 text-accent">
                <Gauge size={20} />
              </div>
              <div>
                <Dialog.Title className="text-[17px] font-semibold text-ink">Free plan usage</Dialog.Title>
                <p className="mt-1 text-[12.5px] leading-5 text-muted">
                  {data ? `${data.date} · ${apiBase(config) || 'this worker'}` : 'Checking this worker…'}
                </p>
              </div>
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

          {usage.isLoading && (
            <div className="mt-6 flex items-center gap-2 text-[13px] text-muted">
              <Loader2 size={15} className="animate-spin" /> Reading session counters…
            </div>
          )}

          {usage.isError && (
            <p className="mt-6 text-[12.5px] text-danger">
              Could not read usage: {(usage.error as Error).message}
            </p>
          )}

          {data && (
            <>
              <div className="mt-5 space-y-4">
                <Meter
                  label="Durable Object duration"
                  detail={`${data.estimate.doGbSeconds.toLocaleString()} GB-s today · on pace for ${data.estimate.projectedDoGbSeconds.toLocaleString()} GB-s`}
                  used={data.estimate.projectedDoGbSeconds}
                  limit={data.freeTier.durableObjectGbSecondsPerDay}
                  unit="GB-s"
                  hint={`${data.estimate.perWakeGbSeconds} GB-s per ${Math.round(data.idleTtlMs / 1000)} s wake window (128 MB)`}
                />
                <Meter
                  label="Wake budget today"
                  detail={`${data.estimate.wakes.toLocaleString()} connects used across ${data.sessions.length || 0} session${data.sessions.length === 1 ? '' : 's'}`}
                  used={data.estimate.wakes}
                  limit={data.sessions.reduce((sum, session) => sum + (session.wakes.limit || 0), 0) || 1}
                  unit="wakes"
                  hint="Resets at 00:00 UTC. DAILY_WAKE_LIMIT is per session."
                />
              </div>

              {data.warnings.length > 0 && (
                <div className="mt-4 space-y-2">
                  {data.warnings.map(warning => (
                    <p
                      key={warning}
                      className="flex items-start gap-2 rounded-lg bg-danger/10 px-3 py-2 text-[12px] leading-5 text-danger"
                    >
                      <AlertTriangle size={14} className="mt-0.5 shrink-0" />
                      {warning}
                    </p>
                  ))}
                </div>
              )}

              <div className="mt-5 border-t border-line pt-4">
                <div className="text-[12px] font-medium text-muted">Per session</div>
                <ul className="mt-2 divide-y divide-line/60">
                  {data.sessions.length === 0 && (
                    <li className="py-2 text-[12.5px] text-muted">No sessions yet.</li>
                  )}
                  {data.sessions.map(session => {
                    const spent = session.wakes.used * data.estimate.perWakeGbSeconds;
                    return (
                      <li key={session.id} className="flex items-center gap-3 py-2 text-[12.5px]">
                        <span className="min-w-0 flex-1 truncate text-ink">{session.id}</span>
                        <span className="shrink-0 text-muted">{session.status}</span>
                        <span className="w-[128px] shrink-0 text-right text-muted">
                          {session.wakes.limited
                            ? `${session.wakes.used}/${session.wakes.limit} wakes`
                            : 'no wake cap'}
                        </span>
                        <span className="w-[74px] shrink-0 text-right text-muted">
                          {spent ? `${Math.round(spent * 10) / 10} GB-s` : '—'}
                        </span>
                      </li>
                    );
                  })}
                </ul>
              </div>

              <p className="mt-4 text-[11.5px] leading-4 text-muted">
                {data.note} The free plan also includes{' '}
                {data.freeTier.requestsPerDay.toLocaleString()} requests/day; the Cloudflare dashboard shows
                the billed totals for both.
              </p>
            </>
          )}
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

function Meter({
  label,
  detail,
  used,
  limit,
  unit,
  hint,
}: {
  label: string;
  detail: string;
  used: number;
  limit: number;
  unit: string;
  hint: string;
}) {
  const percent = limit > 0 ? Math.min(100, Math.round((used / limit) * 100)) : 0;
  const color = percent >= 80 ? 'bg-danger' : percent >= 50 ? 'bg-amber-500' : 'bg-accent';
  return (
    <div>
      <div className="flex items-baseline justify-between gap-2">
        <span className="text-[12.5px] font-medium text-ink">{label}</span>
        <span className="text-[12px] text-muted">
          {percent}% of {limit.toLocaleString()} {unit}
        </span>
      </div>
      <div className="mt-1.5 h-2 w-full overflow-hidden rounded-full bg-panel-2">
        <div className={`h-full rounded-full transition-[width] ${color}`} style={{ width: `${percent}%` }} />
      </div>
      <p className="mt-1 text-[11.5px] leading-4 text-muted">{detail}</p>
      <p className="text-[11px] leading-4 text-muted/80">{hint}</p>
    </div>
  );
}
