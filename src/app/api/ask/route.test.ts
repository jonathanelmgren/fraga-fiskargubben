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
vi.mock("@/lib/notify/discord", () => ({ notifyDiscord: vi.fn() }));
// Resumable streams: mock the orchestrator + persistence so the POST stream
// branch can be exercised end-to-end against the REAL stream registry.
vi.mock("@/lib/chat/ask-handler", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@/lib/chat/ask-handler")>();
  return { ...actual, handleAsk: vi.fn() };
});
vi.mock("@/lib/chat/persist-turns", () => ({
  persistUserTurn: vi.fn().mockResolvedValue(undefined),
  persistAssistantTurn: vi.fn().mockResolvedValue(undefined),
  persistClarifyTurns: vi.fn().mockResolvedValue(undefined),
}));

import { cookies } from "next/headers";
import { after } from "next/server";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { handleAsk } from "@/lib/chat/ask-handler";
import {
  persistAssistantTurn,
  persistUserTurn,
} from "@/lib/chat/persist-turns";
import { resetRegistryForTests, subscribe } from "@/lib/chat/stream-registry";
import { ExternalServiceError, TimeoutError } from "@/lib/errors";
import {
  classifyError,
  isSameOriginRequest,
  POST,
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

// ─────────────────────────────────────────────────────────────────────────────
// POST stream branch (resumable streams)
// ─────────────────────────────────────────────────────────────────────────────

const CONV_ID = "11111111-1111-4111-8111-111111111111";

/** SDK-shaped event source: the raw newline-delimited JSON MessageStream emits. */
function fakeAdviceStream() {
  const encoder = new TextEncoder();
  let controller!: ReadableStreamDefaultController<Uint8Array>;
  const readable = new ReadableStream<Uint8Array>({
    start(c) {
      controller = c;
    },
  });
  const line = (event: object) =>
    controller.enqueue(encoder.encode(`${JSON.stringify(event)}\n`));
  return {
    stream: {
      toReadableStream: () => readable,
      finalMessage: vi.fn().mockResolvedValue({ content: [] }),
    },
    pushText(text: string) {
      line({
        type: "content_block_start",
        index: 0,
        content_block: { type: "text" },
      });
      line({
        type: "content_block_delta",
        index: 0,
        delta: { type: "text_delta", text },
      });
    },
    end: () => controller.close(),
  };
}

function askRequest(body: object) {
  return new Request("https://app.example.com/api/ask", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

async function drainBody(res: Response): Promise<string> {
  const reader = res.body?.getReader();
  if (!reader) return "";
  const decoder = new TextDecoder();
  let out = "";
  for (;;) {
    const { value, done } = await reader.read();
    if (done) return out;
    out += decoder.decode(value, { stream: true });
  }
}

describe("POST /api/ask stream branch (resumable streams)", () => {
  beforeEach(() => {
    vi.mocked(cookies).mockResolvedValue({
      get: () => undefined,
      // biome-ignore lint/suspicious/noExplicitAny: minimal cookie-store stub
    } as any);
  });

  afterEach(() => {
    resetRegistryForTests();
    vi.mocked(handleAsk).mockReset();
    vi.mocked(persistUserTurn).mockClear();
    vi.mocked(persistAssistantTurn).mockClear();
    vi.mocked(after).mockClear();
  });

  it("persists the user turn before returning and streams via the registry", async () => {
    const fake = fakeAdviceStream();
    vi.mocked(handleAsk).mockResolvedValue({
      type: "stream",
      // biome-ignore lint/suspicious/noExplicitAny: minimal AdviceStream stub
      stream: fake.stream as any,
      conversationId: CONV_ID,
    });

    const res = await POST(askRequest({ message: "Vad biter?" }));

    // The user turn is written up-front — before any client reads the body.
    expect(persistUserTurn).toHaveBeenCalledWith(expect.anything(), {
      conversationId: CONV_ID,
      message: "Vad biter?",
    });
    expect(res.headers.get("X-Conversation-Id")).toBe(CONV_ID);

    fake.pushText("Prova maskkroken.");
    fake.end();
    await expect(drainBody(res)).resolves.toBe("Prova maskkroken.");

    // Assistant persistence is scheduled via after() with the advice stream.
    expect(after).toHaveBeenCalledTimes(1);
    const scheduled = vi.mocked(after).mock.calls[0][0] as () => unknown;
    await scheduled();
    expect(persistAssistantTurn).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        conversationId: CONV_ID,
        stream: fake.stream,
      }),
    );
  });

  it("keeps generating after the response body is cancelled (client disconnect)", async () => {
    const fake = fakeAdviceStream();
    vi.mocked(handleAsk).mockResolvedValue({
      type: "stream",
      // biome-ignore lint/suspicious/noExplicitAny: minimal AdviceStream stub
      stream: fake.stream as any,
      conversationId: CONV_ID,
    });

    const res = await POST(askRequest({ message: "Vad biter?" }));
    fake.pushText("Första ");
    // biome-ignore lint/style/noNonNullAssertion: stream response has a body
    const reader = res.body!.getReader();
    await reader.read();
    await reader.cancel(); // phone locked mid-stream

    fake.pushText("resten.");
    fake.end();
    await new Promise((r) => setTimeout(r, 0));

    // A late re-attach (offset 0) replays the FULL text — generation survived.
    const late = subscribe(CONV_ID, 0);
    expect(late).not.toBeNull();
    // biome-ignore lint/style/noNonNullAssertion: asserted above
    await expect(drainBody(new Response(late!))).resolves.toBe(
      "Första resten.",
    );
  });

  it("rejects a double submit for a conversation that is still streaming (409)", async () => {
    const fake = fakeAdviceStream();
    vi.mocked(handleAsk).mockResolvedValue({
      type: "stream",
      // biome-ignore lint/suspicious/noExplicitAny: minimal AdviceStream stub
      stream: fake.stream as any,
      conversationId: CONV_ID,
    });

    await POST(askRequest({ message: "Vad biter?" }));
    fake.pushText("genererar…");

    const second = await POST(
      askRequest({ message: "Hallå?", conversationId: CONV_ID }),
    );
    expect(second.status).toBe(409);
    const body = (await second.json()) as { type: string };
    expect(body.type).toBe("busy");
    // The guard fired before the orchestrator (no double token spend).
    expect(handleAsk).toHaveBeenCalledTimes(1);

    fake.end();
  });
});

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
