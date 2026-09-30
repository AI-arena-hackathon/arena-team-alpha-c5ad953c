/**
 * Injectable clock. Every time-dependent decision (document expiry, wallet age,
 * ledger entries, report windows) reads time through this interface so tests can
 * pin "now" instead of sleeping or asserting on the wall clock.
 */
export interface Clock {
  now(): Date;
}

export const systemClock: Clock = {
  now: () => new Date(),
};

/** A clock frozen at `instant`, optionally advanceable via `advance()`. */
export function fixedClock(instant: Date | string): Clock & { advance(ms: number): void } {
  let current = new Date(instant).getTime();
  return {
    now: () => new Date(current),
    advance: (ms: number) => {
      current += ms;
    },
  };
}

export const MS_PER_DAY = 24 * 60 * 60 * 1000;

export function daysBetween(from: Date, to: Date): number {
  return (to.getTime() - from.getTime()) / MS_PER_DAY;
}

/** Full days from `from` until `until`; negative once the date is in the past. */
export function wholeDaysUntil(from: Date, until: Date): number {
  return Math.floor(daysBetween(from, until));
}