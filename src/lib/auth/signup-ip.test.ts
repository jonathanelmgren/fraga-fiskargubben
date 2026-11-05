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
  withClientIpOnly,
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
  it("takes the last hop of x-forwarded-for, the one nginx appended", () => {
    const h = new Headers({
      "x-forwarded-for": "198.51.100.99, 203.0.113.7",
    });
    expect(extractClientIp(h)).toBe("203.0.113.7");
  });

  it("is not fooled by a client rotating a forged x-forwarded-for prefix", () => {
    const ips = ["198.51.100.1", "198.51.100.2"].map((forged) =>
      extractClientIp(
        new Headers({ "x-forwarded-for": `${forged}, 203.0.113.7` }),
      ),
    );
    expect(ips).toEqual(["203.0.113.7", "203.0.113.7"]);
  });

  it("ignores empty x-forwarded-for hops", () => {
    const h = new Headers({ "x-forwarded-for": "203.0.113.7, " });
    expect(extractClientIp(h)).toBe("203.0.113.7");
  });

  it("falls back to x-real-ip", () => {
    expect(extractClientIp(new Headers({ "x-real-ip": "203.0.113.9" }))).toBe(
      "203.0.113.9",
    );
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

describe("withClientIpOnly", () => {
  it("reduces x-forwarded-for to the real client and keeps the body", async () => {
    const request = new Request("http://localhost/api/auth/sign-up/email", {
      method: "POST",
      headers: { "x-forwarded-for": "198.51.100.1, 203.0.113.7" },
      body: "payload",
    });

    // Next passes route handlers a Proxy around the Request.
    const proxied = new Proxy(request, {
      get(target, key) {
        const value = Reflect.get(target, key);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });

    const result = withClientIpOnly(proxied);

    expect(result.method).toBe("POST");
    expect(result.headers.get("x-forwarded-for")).toBe("203.0.113.7");
    expect(await result.text()).toBe("payload");
  });

  it("returns the request unchanged when no IP can be determined", () => {
    const request = new Request("http://localhost/api/auth/ok");
    expect(withClientIpOnly(request)).toBe(request);
  });

  it("returns the request unchanged when the header is already one hop", () => {
    const request = new Request("http://localhost/api/auth/ok", {
      headers: { "x-forwarded-for": "203.0.113.7" },
    });
    expect(withClientIpOnly(request)).toBe(request);
  });
});

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
