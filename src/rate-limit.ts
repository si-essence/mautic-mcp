import { ConnectorError } from "./errors.js";

export interface RateLimiter {
  /** Throws ConnectorError with code `rate_limit` when the call must not proceed. */
  acquire(): void;
}

/**
 * Sliding window. `blockedFor` does not consume a slot.
 * `acquire` checks, then commits only when the call proceeds.
 */
export class SlidingWindowLimiter implements RateLimiter {
  private hits: number[] = [];

  constructor(
    readonly limit: number,
    private readonly windowMs: number,
    private readonly now: () => number,
  ) {
    if (!Number.isInteger(limit) || limit < 1) {
      throw new ConnectorError("config", "Rate limit must be a positive integer.");
    }
    if (!Number.isInteger(windowMs) || windowMs < 1) {
      throw new ConnectorError("config", "Rate limit window must be a positive integer.");
    }
  }

  blockedFor(): number | null {
    const now = this.now();
    this.hits = this.hits.filter((hit) => now - hit < this.windowMs);
    if (this.hits.length < this.limit) return null;
    const oldest = this.hits[0];
    if (oldest === undefined) return null;
    return Math.max(1, Math.ceil((this.windowMs - (now - oldest)) / 1000));
  }

  commit(): void {
    this.hits.push(this.now());
  }

  acquire(): void {
    const wait = this.blockedFor();
    if (wait !== null) {
      const seconds = Math.round(this.windowMs / 1000);
      throw new ConnectorError(
        "rate_limit",
        `Local rate limit reached (${this.limit} per ${seconds}s). Retry in ~${wait}s. Cached results are still served.`,
        wait,
      );
    }
    this.commit();
  }
}

/** UTC calendar-day counter. Resets when the UTC date changes. */
export class DayWindow implements RateLimiter {
  private stamp = "";
  private count = 0;

  constructor(
    readonly limit: number,
    private readonly now: () => number,
  ) {
    if (!Number.isInteger(limit) || limit < 1) {
      throw new ConnectorError("config", "Daily limit must be a positive integer.");
    }
  }

  private roll(): void {
    const day = new Date(this.now()).toISOString().slice(0, 10);
    if (day !== this.stamp) {
      this.stamp = day;
      this.count = 0;
    }
  }

  blocked(): boolean {
    this.roll();
    return this.count >= this.limit;
  }

  commit(): void {
    this.roll();
    this.count += 1;
  }

  acquire(): void {
    if (this.blocked()) {
      throw new ConnectorError(
        "rate_limit",
        `Daily request budget exhausted (${this.limit}/day). Resets at 00:00 UTC. Cached results are still served.`,
        null,
      );
    }
    this.commit();
  }
}
