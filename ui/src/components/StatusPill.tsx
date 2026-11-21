import type { SessionStatusName } from '../lib/api';

const LABELS: Record<SessionStatusName, string> = {
  new: 'Not paired',
  connecting: 'Connecting',
  qr: 'Waiting for scan',
  connected: 'Connected',
  idle: 'Idle',
  closed: 'Disconnected',
  loggedOut: 'Logged out',
};

const TONES: Record<SessionStatusName, string> = {
  new: 'bg-muted',
  connecting: 'bg-amber-400 animate-pulse-dot',
  qr: 'bg-amber-400 animate-pulse-dot',
  connected: 'bg-accent',
  idle: 'bg-sky-400',
  closed: 'bg-danger',
  loggedOut: 'bg-danger',
};

export function statusLabel(status?: SessionStatusName): string {
  return status ? LABELS[status] : 'Unknown';
}

export function StatusDot({ status }: { status?: SessionStatusName }) {
  return (
    <span
      className={`inline-block size-2 rounded-full ${status ? TONES[status] : 'bg-muted'}`}
      aria-hidden="true"
    />
  );
}

export function StatusPill({ status }: { status?: SessionStatusName }) {
  return (
    <span className="inline-flex items-center gap-1.5 rounded-full bg-panel-2 px-2.5 py-1 text-[11px] font-medium text-muted">
      <StatusDot status={status} />
      {statusLabel(status)}
    </span>
  );
}
