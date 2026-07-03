import { vi } from "vitest";

vi.mock("server-only", () => ({}));
vi.mock("@/shared/db/client", () => ({ db: {} }));
vi.mock("@/shared/env", () => ({
  env: {
    BETTER_AUTH_SECRET: "test-secret-that-is-at-least-32-chars!!",
    // SIGNUP_IP_LIMIT deliberately unset → default 3
  },
}));

import { describe, expect, it } from "vitest";
import {
  checkSignupAllowed,
  DEFAULT_SIGNUP_IP_LIMIT,
  extractClientIp,
  hashSignupIp,
  SIGNUP_IP_WINDOW_MS,
} from "./signup-ip";

describe("hashSignupIp", () => {
  it("is deterministic and does not contain the raw IP", () => {
    const a = hashSignupIp("203.0.113.7");
    const b = hashSignupIp("203.0.113.7");
    expect(a).toBe(b);
    expect(a).toMatch(/^[0-9a-f]{64}$/);
    expect(a).not.toContain("203");
  });

  it("differs per IP and trims whitespace", () => {
    expect(hashSignupIp("203.0.113.7")).not.toBe(hashSignupIp("203.0.113.8"));
    expect(hashSignupIp(" 203.0.113.7 ")).toBe(hashSignupIp("203.0.113.7"));
  });
});

describe("extractClientIp", () => {
  it("takes the first hop of x-forwarded-for", () => {
    const h = new Headers({
      "x-forwarded-for": "203.0.113.7, 10.0.0.1, 172.16.0.1",
    });
    expect(extractClientIp(h)).toBe("203.0.113.7");
  });

  it("falls back to x-real-ip", () => {
    expect(
      extractClientIp(new Headers({ "x-real-ip": "203.0.113.9" })),
    ).toBe("203.0.113.9");
  });

  it("returns null when no header is present", () => {
    expect(extractClientIp(new Headers())).toBeNull();
  });
});

// deps fake: db.select().from().where() resolving to a count row
function fakeDb(n: number) {
  return {
    select: () => ({
      from: () => ({
        where: () => Promise.resolve([{ n }]),
      }),
    }),
    // biome-ignore lint/suspicious/noExplicitAny: test fake
  } as any;
}

const NOW = new Date("2026-07-03T10:00:00Z");

describe("checkSignupAllowed", () => {
  it("allows when under the limit and returns the ip hash to stamp", async () => {
    const headers = new Headers({ "x-forwarded-for": "203.0.113.7" });
    const result = await checkSignupAllowed(headers, {
      db: fakeDb(DEFAULT_SIGNUP_IP_LIMIT - 1),
      now: NOW,
    });
    expect(result.allowed).toBe(true);
    expect(result.ipHash).toBe(hashSignupIp("203.0.113.7"));
  });

  it("blocks when the limit is reached", async () => {
    const headers = new Headers({ "x-forwarded-for": "203.0.113.7" });
    const result = await checkSignupAllowed(headers, {
      db: fakeDb(DEFAULT_SIGNUP_IP_LIMIT),
      now: NOW,
    });
    expect(result.allowed).toBe(false);
  });

  it("allows with a null hash when no IP can be determined", async () => {
    const result = await checkSignupAllowed(new Headers(), {
      db: fakeDb(999),
      now: NOW,
    });
    expect(result).toEqual({ allowed: true, ipHash: null });
  });

  it("window constant is 30 days", () => {
    expect(SIGNUP_IP_WINDOW_MS).toBe(30 * 24 * 60 * 60 * 1000);
  });
});
