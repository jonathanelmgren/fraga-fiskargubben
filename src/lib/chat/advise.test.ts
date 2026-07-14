import { describe, expect, it, vi } from "vitest";

// advise.ts imports WINDING_DOWN_TURN from ./quota, which has `import
// "server-only"`; stub it so the (Node) test environment can import the chain.
vi.mock("server-only", () => ({}));
vi.mock("@/shared/db/client", () => ({ db: {} }));

import { FISKARGUBBEN_SYSTEM } from "@/lib/chat/persona";
import { ADVICE_MODEL, FOLLOWUP_MODEL } from "@/lib/claude/models";
import type { Signals } from "@/lib/signals/types";
import { adviseFirst, adviseFollowup } from "./advise";

// ---------------------------------------------------------------------------
// Minimal Signals fixture
// ---------------------------------------------------------------------------
const baseSignals: Signals = {
  lake: "Tolken",
  lakeId: "tolken-1",
  timeLocal: "2026-06-29T10:00:00",
  airTempC: {
    value: 18,
    provenance: { source: "forecast", confidence: "high" },
  },
};

// ---------------------------------------------------------------------------
// Mock stream builder — returns an object that looks like a MessageStream
// finalMessage() resolves immediately; async iteration yields nothing (stream
// content is not what these tests assert on — they check call args only)
// ---------------------------------------------------------------------------
function buildMockStream(_streamSpy?: ReturnType<typeof vi.fn>) {
  const stream = {
    [Symbol.asyncIterator]: async function* () {
      // yield nothing — callers only test args, not content
    },
    finalMessage: vi.fn().mockResolvedValue({
      id: "msg_test",
      type: "message",
      role: "assistant",
      content: [{ type: "text", text: "Fiskargubben svarar." }],
      model: ADVICE_MODEL,
      stop_reason: "end_turn",
      usage: { input_tokens: 100, output_tokens: 50 },
    }),
    on: vi.fn().mockReturnThis(),
  };
  return stream;
}

function buildMockClient() {
  const streamSpy = vi.fn().mockReturnValue(buildMockStream());
  return {
    messages: {
      stream: streamSpy,
    },
    _streamSpy: streamSpy,
  };
}

// ---------------------------------------------------------------------------
// adviseFirst
// ---------------------------------------------------------------------------
describe("adviseFirst()", () => {
  it("calls ADVICE_MODEL (Sonnet 4.6)", async () => {
    const client = buildMockClient();
    adviseFirst({
      signals: baseSignals,
      message: "Vad biter idag?",
      // biome-ignore lint/suspicious/noExplicitAny: test fake
      deps: { client: client as any },
    });

    expect(client._streamSpy).toHaveBeenCalledOnce();
    const [args] = client._streamSpy.mock.calls[0];
    expect(args.model).toBe(ADVICE_MODEL);
  });

  it("uses adaptive thinking", () => {
    const client = buildMockClient();
    adviseFirst({
      signals: baseSignals,
      message: "Vad biter idag?",
      // biome-ignore lint/suspicious/noExplicitAny: test fake
      deps: { client: client as any },
    });

    const [args] = client._streamSpy.mock.calls[0];
    expect(args.thinking).toEqual({ type: "adaptive" });
  });

  it("sends frozen system prompt with cache_control ephemeral", () => {
    const client = buildMockClient();
    adviseFirst({
      signals: baseSignals,
      message: "Vad biter idag?",
      // biome-ignore lint/suspicious/noExplicitAny: test fake
      deps: { client: client as any },
    });

    const [args] = client._streamSpy.mock.calls[0];
    expect(Array.isArray(args.system)).toBe(true);
    expect(args.system[0]).toMatchObject({
      type: "text",
      text: FISKARGUBBEN_SYSTEM,
      cache_control: { type: "ephemeral" },
    });
  });

  it("includes Signals JSON and user message in user turn", () => {
    const client = buildMockClient();
    adviseFirst({
      signals: baseSignals,
      message: "Vad biter idag?",
      // biome-ignore lint/suspicious/noExplicitAny: test fake
      deps: { client: client as any },
    });

    const [args] = client._streamSpy.mock.calls[0];
    const userMessage = args.messages.find(
      (m: { role: string }) => m.role === "user",
    );
    expect(userMessage).toBeDefined();
    const content =
      typeof userMessage.content === "string"
        ? userMessage.content
        : JSON.stringify(userMessage.content);
    expect(content).toContain("Tolken");
    expect(content).toContain("Vad biter idag?");
  });

  it("returns the stream from client.messages.stream", () => {
    const client = buildMockClient();
    const result = adviseFirst({
      signals: baseSignals,
      message: "Vad biter idag?",
      // biome-ignore lint/suspicious/noExplicitAny: test fake
      deps: { client: client as any },
    });

    expect(result).toBe(client._streamSpy.mock.results[0].value);
  });

  it("strips internal bookkeeping fields (lakeId, bareLakeName) from the prompt", () => {
    const client = buildMockClient();
    adviseFirst({
      signals: { ...baseSignals, bareLakeName: "Tolken-bare" },
      message: "Vad biter idag?",
      // biome-ignore lint/suspicious/noExplicitAny: test fake
      deps: { client: client as any },
    });

    const [args] = client._streamSpy.mock.calls[0];
    const userMessage = args.messages.find(
      (m: { role: string }) => m.role === "user",
    );
    const content =
      typeof userMessage.content === "string"
        ? userMessage.content
        : JSON.stringify(userMessage.content);
    expect(content).not.toContain("lakeId");
    expect(content).not.toContain("tolken-1");
    expect(content).not.toContain("bareLakeName");
    expect(content).not.toContain("Tolken-bare");
    // The label the model should reason about is still there.
    expect(content).toContain("Tolken");
  });
});

// ---------------------------------------------------------------------------
// adviseFollowup
// ---------------------------------------------------------------------------
describe("adviseFollowup()", () => {
  const history = [
    { role: "user" as const, content: "Är abborre aktiv på djupet?" },
    { role: "assistant" as const, content: "Ja, håll dig på 4-6 meter." },
  ];

  it("calls FOLLOWUP_MODEL (Haiku 4.5)", () => {
    const client = buildMockClient();
    adviseFollowup({
      snapshot: baseSignals,
      message: "Vilket bete?",
      history,
      turnIndex: 3,
      // biome-ignore lint/suspicious/noExplicitAny: test fake
      deps: { client: client as any },
    });

    const [args] = client._streamSpy.mock.calls[0];
    expect(args.model).toBe(FOLLOWUP_MODEL);
  });

  it("does NOT include thinking param (Haiku has no thinking)", () => {
    const client = buildMockClient();
    adviseFollowup({
      snapshot: baseSignals,
      message: "Vilket bete?",
      history,
      turnIndex: 3,
      // biome-ignore lint/suspicious/noExplicitAny: test fake
      deps: { client: client as any },
    });

    const [args] = client._streamSpy.mock.calls[0];
    expect(args.thinking).toBeUndefined();
  });

  it("sends frozen system prompt with cache_control ephemeral", () => {
    const client = buildMockClient();
    adviseFollowup({
      snapshot: baseSignals,
      message: "Vilket bete?",
      history,
      turnIndex: 3,
      // biome-ignore lint/suspicious/noExplicitAny: test fake
      deps: { client: client as any },
    });

    const [args] = client._streamSpy.mock.calls[0];
    expect(args.system[0]).toMatchObject({
      type: "text",
      text: FISKARGUBBEN_SYSTEM,
      cache_control: { type: "ephemeral" },
    });
  });

  it("windingDown=false when turnIndex < 15", () => {
    const client = buildMockClient();
    adviseFollowup({
      snapshot: baseSignals,
      message: "Vilket bete?",
      history,
      turnIndex: 14,
      // biome-ignore lint/suspicious/noExplicitAny: test fake
      deps: { client: client as any },
    });

    const [args] = client._streamSpy.mock.calls[0];
    // The last message in the array is always the actual user query (not history)
    const lastMessage = args.messages[args.messages.length - 1];
    const content =
      typeof lastMessage.content === "string"
        ? lastMessage.content
        : JSON.stringify(lastMessage.content);
    expect(content).toContain("windingDown");
    expect(content).toContain("false");
  });

  it("windingDown=true at turnIndex >= 15", () => {
    const client = buildMockClient();
    adviseFollowup({
      snapshot: baseSignals,
      message: "Sista frågan.",
      history,
      turnIndex: 15,
      // biome-ignore lint/suspicious/noExplicitAny: test fake
      deps: { client: client as any },
    });

    const [args] = client._streamSpy.mock.calls[0];
    const lastMessage = args.messages[args.messages.length - 1];
    const content =
      typeof lastMessage.content === "string"
        ? lastMessage.content
        : JSON.stringify(lastMessage.content);
    expect(content).toContain("windingDown");
    expect(content).toContain("true");
  });

  it("includes history turns in messages array", () => {
    const client = buildMockClient();
    adviseFollowup({
      snapshot: baseSignals,
      message: "Vilket bete?",
      history,
      turnIndex: 3,
      // biome-ignore lint/suspicious/noExplicitAny: test fake
      deps: { client: client as any },
    });

    const [args] = client._streamSpy.mock.calls[0];
    expect(
      args.messages.some(
        (m: { content: string }) => m.content === "Är abborre aktiv på djupet?",
      ),
    ).toBe(true);
  });
});
