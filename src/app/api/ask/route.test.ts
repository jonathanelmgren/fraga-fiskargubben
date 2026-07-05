/**
 * route.test.ts — unit tests for the POST /api/ask route's pure helpers.
 *
 * The findings (H3a, H2, M12, M13) call out that classifyError, the claim
 * cookie, and the new origin/CSRF guard had zero tests. These exercise the
 * exported helpers without booting the full handler (which needs a DB +
 * next/headers). The fire-and-forget persistence is covered by
 * persist-turns.test.ts.
 */

import { vi } from "vitest";

// Mock the heavy module-load dependencies so importing route.ts is cheap.
vi.mock("server-only", () => ({}));
vi.mock("next/headers", () => ({ cookies: vi.fn() }));
vi.mock("next/server", () => ({ after: vi.fn() }));
vi.mock("@/shared/db/client", () => ({ db: {} }));
vi.mock("@/shared/db/schema", () => ({
  conversations: {},
  messages: {},
  users: {},
}));
vi.mock("@/shared/env", () => ({
  env: { BETTER_AUTH_URL: "https://app.example.com" },
}));
vi.mock("@/lib/get-session", () => ({ getSession: vi.fn() }));
vi.mock("@/lib/analytics/events", () => ({ emit: vi.fn() }));

import { describe, expect, it } from "vitest";
import { ExternalServiceError, TimeoutError } from "@/lib/errors";
import {
  classifyError,
  isSameOriginRequest,
  parseLocation,
  serializeClaimCookie,
} from "./route";

// ─────────────────────────────────────────────────────────────────────────────
// classifyError (H3a / M12)
// ─────────────────────────────────────────────────────────────────────────────

describe("classifyError", () => {
  it("maps a typed ExternalServiceError with status 429 to 503 (M12)", () => {
    const res = classifyError(
      new ExternalServiceError("rate limited", {
        service: "anthropic-extractor",
        status: 429,
      }),
    );
    expect(res.status).toBe(503);
  });

  it("maps a generic ExternalServiceError (no status) to 503", () => {
    const res = classifyError(
      new ExternalServiceError("smhi down", { service: "smhi-forecast" }),
    );
    expect(res.status).toBe(503);
  });

  it("maps a TimeoutError to 503", () => {
    const res = classifyError(new TimeoutError("timed out"));
    expect(res.status).toBe(503);
  });

  it("maps an unknown error to 500", () => {
    const res = classifyError(new Error("boom"));
    expect(res.status).toBe(500);
  });

  it("returns an in-persona gate body the chat UI can render", async () => {
    const res = classifyError(new Error("boom"));
    const body = (await res.json()) as { type: string; text: string };
    expect(body.type).toBe("lake_unresolved");
    expect(typeof body.text).toBe("string");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// serializeClaimCookie (H2)
// ─────────────────────────────────────────────────────────────────────────────

describe("serializeClaimCookie", () => {
  it("produces an HttpOnly, SameSite=Lax, Path=/ cookie", () => {
    const cookie = serializeClaimCookie("fiska_claim", "abc-123");
    expect(cookie).toContain("fiska_claim=abc-123");
    expect(cookie).toContain("Path=/");
    expect(cookie).toContain("HttpOnly");
    expect(cookie).toContain("SameSite=Lax");
  });

  it("omits Secure outside production (L3)", () => {
    const prev = process.env.NODE_ENV;
    // @ts-expect-error override for the test
    process.env.NODE_ENV = "development";
    expect(serializeClaimCookie("fiska_claim", "x")).not.toContain("Secure");
    // @ts-expect-error restore
    process.env.NODE_ENV = prev;
  });

  it("includes Secure in production (L3)", () => {
    const prev = process.env.NODE_ENV;
    // @ts-expect-error override for the test
    process.env.NODE_ENV = "production";
    expect(serializeClaimCookie("fiska_claim", "x")).toContain("Secure");
    // @ts-expect-error restore
    process.env.NODE_ENV = prev;
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// isSameOriginRequest (M13)
// ─────────────────────────────────────────────────────────────────────────────

const APP = "https://app.example.com";

describe("isSameOriginRequest", () => {
  it("allows Sec-Fetch-Site: same-origin", () => {
    const h = new Headers({ "sec-fetch-site": "same-origin" });
    expect(isSameOriginRequest(h, APP)).toBe(true);
  });

  it("allows Sec-Fetch-Site: same-site", () => {
    const h = new Headers({ "sec-fetch-site": "same-site" });
    expect(isSameOriginRequest(h, APP)).toBe(true);
  });

  it("rejects Sec-Fetch-Site: cross-site", () => {
    const h = new Headers({ "sec-fetch-site": "cross-site" });
    expect(isSameOriginRequest(h, APP)).toBe(false);
  });

  it("falls back to Origin and allows a same-origin Origin header", () => {
    const h = new Headers({ origin: "https://app.example.com" });
    expect(isSameOriginRequest(h, APP)).toBe(true);
  });

  it("falls back to Origin and rejects a cross-origin Origin header", () => {
    const h = new Headers({ origin: "https://evil.example.net" });
    expect(isSameOriginRequest(h, APP)).toBe(false);
  });

  it("allows a request with neither header (non-browser caller)", () => {
    expect(isSameOriginRequest(new Headers(), APP)).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// parseLocation (rebuild: optional browser geolocation)
// ─────────────────────────────────────────────────────────────────────────────

describe("parseLocation", () => {
  it("accepts a valid Swedish coordinate", () => {
    expect(parseLocation({ lat: 57.79, lon: 13.42 })).toEqual({
      lat: 57.79,
      lon: 13.42,
    });
  });

  it("rejects non-objects, missing fields and non-numbers", () => {
    expect(parseLocation(undefined)).toBeUndefined();
    expect(parseLocation(null)).toBeUndefined();
    expect(parseLocation("57,13")).toBeUndefined();
    expect(parseLocation({ lat: "57" })).toBeUndefined();
    expect(parseLocation({ lat: Number.NaN, lon: 13 })).toBeUndefined();
  });

  it("rejects coordinates outside the Sweden-ish bounding box", () => {
    expect(parseLocation({ lat: 48.8, lon: 2.3 })).toBeUndefined(); // Paris
    expect(parseLocation({ lat: 0, lon: 0 })).toBeUndefined();
    expect(parseLocation({ lat: 71, lon: 20 })).toBeUndefined();
  });
});
