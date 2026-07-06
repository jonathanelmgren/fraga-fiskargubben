import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { checkRateLimit, resetRateLimiter } from "./rate-limit";

describe("checkRateLimit", () => {
  afterEach(() => {
    resetRateLimiter();
    vi.useRealTimers();
  });

  it("allows up to the limit and blocks the next hit", () => {
    for (let i = 0; i < 5; i++) {
      expect(checkRateLimit("k", 5, 60_000).allowed).toBe(true);
    }
    const blocked = checkRateLimit("k", 5, 60_000);
    expect(blocked.allowed).toBe(false);
    expect(blocked.retryAfterSeconds).toBeGreaterThan(0);
  });

  it("resets after the window expires", () => {
    vi.useFakeTimers();
    for (let i = 0; i < 6; i++) checkRateLimit("k", 5, 60_000);
    expect(checkRateLimit("k", 5, 60_000).allowed).toBe(false);
    vi.advanceTimersByTime(61_000);
    expect(checkRateLimit("k", 5, 60_000).allowed).toBe(true);
  });

  it("tracks keys independently", () => {
    for (let i = 0; i < 6; i++) checkRateLimit("a", 5, 60_000);
    expect(checkRateLimit("a", 5, 60_000).allowed).toBe(false);
    expect(checkRateLimit("b", 5, 60_000).allowed).toBe(true);
  });
});
