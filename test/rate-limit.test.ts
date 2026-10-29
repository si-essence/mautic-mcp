import { describe, expect, it } from "vitest";
import { ConnectorError } from "../src/errors.js";
import { DayWindow, SlidingWindowLimiter } from "../src/rate-limit.js";

describe("SlidingWindowLimiter", () => {
  it("blocks until the oldest hit leaves the window", () => {
    let now = 0;
    const limiter = new SlidingWindowLimiter(2, 1_000, () => now);
    limiter.acquire();
    limiter.acquire();
    expect(() => {
      limiter.acquire();
    }).toThrow(ConnectorError);
    try {
      limiter.acquire();
    } catch (error) {
      expect(error).toBeInstanceOf(ConnectorError);
      if (!(error instanceof ConnectorError)) throw error;
      expect(error.code).toBe("rate_limit");
      expect(error.retryAfterSeconds).toBe(1);
    }
    now = 1_000;
    limiter.acquire();
  });

  it("rejects a limit below 1", () => {
    expect(() => new SlidingWindowLimiter(0, 1_000, () => 0)).toThrow(ConnectorError);
  });
});

describe("DayWindow", () => {
  it("resets when the UTC date changes", () => {
    let now = Date.parse("2026-01-02T23:30:00.000Z");
    const window = new DayWindow(1, () => now);
    window.acquire();
    expect(window.blocked()).toBe(true);
    now = Date.parse("2026-01-03T00:00:00.000Z");
    expect(window.blocked()).toBe(false);
    window.acquire();
  });
});
