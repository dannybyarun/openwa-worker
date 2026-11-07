/**
 * Pure cursor/sequence helpers shared by the session DO and the specs in scripts/cursor.spec.mjs.
 * Keeping them free of Durable Object APIs is what makes the drain contract testable under `node --test`.
 */

/** A message as persisted in DO storage: mapMessage() output plus a per-session monotonic sequence. */
export type StoredMessage = Record<string, unknown> & { seq?: number };

export interface MessagePage {
  messages: StoredMessage[];
  nextCursor: number;
  hasMore: boolean;
  oldestSeq: number | null;
}

/**
 * Older deployments stored history rows without `seq`. Give those rows stable sequence numbers
 * (in array order) so the cursor API can deliver them exactly once too.
 */
export function normalizeSequences(
  history: StoredMessage[],
  base: number,
): { rows: StoredMessage[]; maxSeq: number; changed: boolean } {
  let max = base;
  let changed = false;
  const rows = history.map(row => {
    const seq = Number(row.seq);
    if (Number.isFinite(seq) && seq > 0) {
      max = Math.max(max, seq);
      return row;
    }
    changed = true;
    max += 1;
    return { ...row, seq: max };
  });
  return { rows, maxSeq: max, changed };
}

/**
 * Keyset pull: rows with seq > after, oldest first. `nextCursor` never moves backwards, so a
 * client that persists it can resume safely; `oldestSeq` exposes the cap boundary.
 */
export function selectMessages(
  history: StoredMessage[],
  msgSeq: number,
  after: number,
  limit: number,
): MessagePage {
  const selected = history.filter(message => Number(message.seq ?? 0) > after).slice(0, limit);
  const lastSelected = selected[selected.length - 1];
  return {
    messages: selected,
    nextCursor: lastSelected ? Number(lastSelected.seq) : Math.max(after, msgSeq),
    hasMore: selected.length === limit,
    oldestSeq: history.length > 0 ? Number(history[0].seq ?? 0) : null,
  };
}

/** Drop rows a consumer has persisted. Only call this after its write committed. */
export function pruneAcked(history: StoredMessage[], upto: number): StoredMessage[] {
  return history.filter(message => Number(message.seq ?? 0) > upto);
}
