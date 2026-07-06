/**
 * route.test.ts — GET /api/ask/stream re-attach endpoint.
 *
 * Ownership mirrors loadConversationView (C1): logged-in owner OR anon with a
 * matching HMAC-verified claim cookie; unknown/foreign/inactive all 404
 * without revealing existence. The stream body itself is the real registry's
 * subscriber (offset replay + live continuation).
 */

import { vi } from "vitest";

vi.mock("server-only", () => ({}));
vi.mock("next/headers", () => ({ cookies: vi.fn() }));
vi.mock("@/shared/db/client", () => ({ db: { select: vi.fn() } }));
vi.mock("@/shared/db/schema", () => ({ conversations: {} }));
vi.mock("@/lib/get-session", () => ({ getSession: vi.fn() }));
vi.mock("@/lib/chat/claim-cookie", () => ({ verifyClaimToken: vi.fn() }));
vi.mock("drizzle-orm", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  eq: vi.fn(),
}));

import { cookies } from "next/headers";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { verifyClaimToken } from "@/lib/chat/claim-cookie";
import {
  resetRegistryForTests,
  startStream,
} from "@/lib/chat/stream-registry";
import { getSession } from "@/lib/get-session";
import { db } from "@/shared/db/client";
import { GET } from "./route";

const CONV_ID = "11111111-1111-4111-8111-111111111111";
const encoder = new TextEncoder();

function mockConversationRow(
  row: { userId: string | null; claimToken: string | null } | undefined,
) {
  vi.mocked(db.select).mockReturnValue({
    from: () => ({
      where: () => ({ limit: async () => (row ? [row] : []) }),
    }),
    // biome-ignore lint/suspicious/noExplicitAny: minimal drizzle chain stub
  } as any);
}

function session(userId: string | null) {
  vi.mocked(getSession).mockResolvedValue(
    // biome-ignore lint/suspicious/noExplicitAny: minimal session stub
    userId ? ({ user: { id: userId } } as any) : null,
  );
}

function activeStreamWith(text: string) {
  let controller!: ReadableStreamDefaultController<Uint8Array>;
  startStream(
    CONV_ID,
    new ReadableStream<Uint8Array>({
      start(c) {
        controller = c;
      },
    }),
  );
  if (text) controller.enqueue(encoder.encode(text));
  return { end: () => controller.close() };
}

function streamRequest(query: string) {
  return new Request(`https://app.example.com/api/ask/stream?${query}`);
}

beforeEach(() => {
  vi.mocked(cookies).mockResolvedValue({
    get: () => undefined,
    // biome-ignore lint/suspicious/noExplicitAny: minimal cookie-store stub
  } as any);
  vi.mocked(verifyClaimToken).mockReturnValue(null);
  session(null);
  mockConversationRow(undefined);
});

afterEach(() => {
  resetRegistryForTests();
  vi.mocked(getSession).mockReset();
  vi.mocked(verifyClaimToken).mockReset();
  vi.mocked(db.select).mockReset();
});

describe("GET /api/ask/stream", () => {
  it("400 on a malformed conversationId", async () => {
    const res = await GET(streamRequest("conversationId=not-a-uuid"));
    expect(res.status).toBe(400);
  });

  it("streams from the offset for the logged-in owner", async () => {
    session("user-1");
    mockConversationRow({ userId: "user-1", claimToken: null });
    const live = activeStreamWith("abcdef");
    // Let the registry consumer ingest the first chunk.
    await new Promise((r) => setTimeout(r, 0));

    const res = await GET(
      streamRequest(`conversationId=${CONV_ID}&offset=3`),
    );
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/plain");
    live.end();
    await expect(res.text()).resolves.toBe("def");
  });

  it("streams for an anon caller with a matching claim cookie", async () => {
    session(null);
    vi.mocked(verifyClaimToken).mockReturnValue("claim-abc");
    mockConversationRow({ userId: null, claimToken: "claim-abc" });
    const live = activeStreamWith("hejhej");
    await new Promise((r) => setTimeout(r, 0));

    const res = await GET(streamRequest(`conversationId=${CONV_ID}`));
    expect(res.status).toBe(200);
    live.end();
    await expect(res.text()).resolves.toBe("hejhej");
  });

  it("404 for a foreign conversation (no existence leak)", async () => {
    session("user-2");
    mockConversationRow({ userId: "user-1", claimToken: null });
    activeStreamWith("hemligt");

    const res = await GET(streamRequest(`conversationId=${CONV_ID}`));
    expect(res.status).toBe(404);
  });

  it("404 for an anon caller whose claim token does not match", async () => {
    session(null);
    vi.mocked(verifyClaimToken).mockReturnValue("wrong-claim");
    mockConversationRow({ userId: null, claimToken: "claim-abc" });
    activeStreamWith("hemligt");

    const res = await GET(streamRequest(`conversationId=${CONV_ID}`));
    expect(res.status).toBe(404);
  });

  it("404 when the conversation exists but has no registry entry", async () => {
    session("user-1");
    mockConversationRow({ userId: "user-1", claimToken: null });

    const res = await GET(streamRequest(`conversationId=${CONV_ID}`));
    expect(res.status).toBe(404);
  });

  it("ignores a malformed offset (falls back to 0)", async () => {
    session("user-1");
    mockConversationRow({ userId: "user-1", claimToken: null });
    const live = activeStreamWith("allt");
    await new Promise((r) => setTimeout(r, 0));

    const res = await GET(
      streamRequest(`conversationId=${CONV_ID}&offset=banan`),
    );
    expect(res.status).toBe(200);
    live.end();
    await expect(res.text()).resolves.toBe("allt");
  });
});
