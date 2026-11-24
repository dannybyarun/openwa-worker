/**
 * Connected-window arithmetic, deliberately free of Durable Object imports so `scripts/window.spec.mjs`
 * can import it under plain Node.
 *
 * A window opens on `/wake`, `/start` or `/send-text` and closes when the idle timer fires. Activity
 * inside a live window slides the close time out (`slideWindow`), but sliding stops at
 * `windowStart + maxMs`: a drain that takes 90 s should not be cut off, and a puller on a tight loop
 * should not be able to pin the object for the day.
 */

export interface WindowState {
  /** When the current window opened. `0` means no window is open. */
  windowStart: number;
  /** When the window closes. `0` means no window is open. */
  activeUntil: number;
}

export interface SlideInput extends WindowState {
  /** Current time in ms. */
  now: number;
  /** Base length of one window, in ms. */
  ttlMs: number;
  /** Hard ceiling for one window measured from `windowStart`, in ms. */
  maxMs: number;
  /**
   * `true` when this call opens the window rather than poking a live one (i.e. `/wake`).
   * A forced open restarts both the window and its ceiling.
   */
  fresh?: boolean;
}

/** Slide (or open) the connected window and report the state plus how long until it closes. */
export function slideWindow(input: SlideInput): WindowState & { delayMs: number } {
  const { now, ttlMs, maxMs, fresh } = input;
  // Live-ness is decided by the deadline, not by `windowStart`: a window is live while it has time
  // left on it. `windowStart > 0` is only a guard against an unopened state.
  const live = !fresh && input.activeUntil > now && input.windowStart > 0;
  const start = live ? input.windowStart : now;
  // `maxMs` is clamped to at least one ttl so a bad config cannot close the window immediately.
  const ceiling = start + Math.max(maxMs, ttlMs);
  const activeUntil = Math.min(now + Math.max(ttlMs, 0), ceiling);
  return { windowStart: start, activeUntil, delayMs: Math.max(0, activeUntil - now) };
}
