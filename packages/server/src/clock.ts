import type { Clock } from './app';

export const systemClock: Clock = { now: () => new Date() };

/** Demo-only clock that can "time travel" so live, final and upcoming states can be exercised. */
export class OffsetClock implements Clock {
  constructor(public offsetMs = 0) {}
  now() { return new Date(Date.now() + this.offsetMs); }
  set(offsetMs: number) { this.offsetMs = offsetMs; }
}
