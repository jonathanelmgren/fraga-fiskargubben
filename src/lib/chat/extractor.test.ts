import { describe, expect, it, vi } from "vitest";
import { EXTRACTOR_MODEL } from "@/lib/claude/models";
import { ExternalServiceError, TimeoutError } from "@/lib/errors";
import { extract } from "./extractor";

// ---------------------------------------------------------------------------
// Helpers to build mock parsed_output values
// ---------------------------------------------------------------------------
function onTopicOutput(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    onTopic: true,
    lakeName: "Tolken",
    municipality: "Ulricehamn",
    time: "ikväll",
    intent: "fiska abborre",
    ...overrides,
  };
}

function offTopicOutput() {
  return {
    onTopic: false,
    lakeName: undefined,
    municipality: undefined,
    time: undefined,
    intent: undefined,
  };
}

// ---------------------------------------------------------------------------
// Build a minimal mock Anthropic client
// ---------------------------------------------------------------------------
function buildMockClient(parsedOutput: unknown) {
  const parseSpy = vi.fn().mockResolvedValue({
    parsed_output: parsedOutput,
    stop_reason: "end_turn",
    model: EXTRACTOR_MODEL,
  });

  return {
    messages: {
      parse: parseSpy,
    },
    _parseSpy: parseSpy,
  };
}

describe("extract()", () => {
  it("on-topic fishing message → onTopic true with parsed fields", async () => {
    const client = buildMockClient(onTopicOutput());
    const result = await extract(
      "i vill fiska i tolken ulricehamn ikväll",
      [],
      // biome-ignore lint/suspicious/noExplicitAny: test fake
      { client: client as any },
    );

    expect(result.onTopic).toBe(true);
    expect(result.lakeName).toBe("Tolken");
    expect(result.municipality).toBe("Ulricehamn");
    expect(result.time).toBe("ikväll");
    expect(result.intent).toBe("fiska abborre");
    expect(result.refusal).toBeUndefined();
  });

  it("off-topic message → onTopic false with in-persona refusal string", async () => {
    const client = buildMockClient(offTopicOutput());
    const result = await extract(
      "vad är huvudstaden i Frankrike",
      [],
      // biome-ignore lint/suspicious/noExplicitAny: test fake
      { client: client as any },
    );

    expect(result.onTopic).toBe(false);
    expect(result.refusal).toBeTruthy();
    expect(typeof result.refusal).toBe("string");
    // Should be in-persona — something gruff and fishing-related
    expect(result.refusal?.length).toBeGreaterThan(0);
  });

  it("parsed_output null → returns fallback off-topic with refusal, no crash", async () => {
    const client = buildMockClient(null);
    const result = await extract(
      "some message",
      [],
      // biome-ignore lint/suspicious/noExplicitAny: test fake
      { client: client as any },
    );

    expect(result.onTopic).toBe(false);
    expect(result.refusal).toBeTruthy();
  });

  it("uses EXTRACTOR_MODEL (claude-haiku-4-5)", async () => {
    const client = buildMockClient(onTopicOutput());
    await extract(
      "fiska gädda i Hjälmaren",
      [],
      // biome-ignore lint/suspicious/noExplicitAny: test fake
      { client: client as any },
    );

    expect(client._parseSpy).toHaveBeenCalledOnce();
    const callArg = client._parseSpy.mock.calls[0][0] as Record<
      string,
      unknown
    >;
    expect(callArg.model).toBe(EXTRACTOR_MODEL);
    expect(callArg.model).toBe("claude-haiku-4-5");
  });

  it("does NOT pass thinking/effort/prefill to Haiku", async () => {
    const client = buildMockClient(onTopicOutput());
    await extract(
      "fiska gädda i Hjälmaren",
      [],
      // biome-ignore lint/suspicious/noExplicitAny: test fake
      { client: client as any },
    );

    const callArg = client._parseSpy.mock.calls[0][0] as Record<
      string,
      unknown
    >;
    expect(callArg).not.toHaveProperty("thinking");

    // output_config is allowed (structured output) but must NOT have effort
    const outputConfig = callArg.output_config as
      | Record<string, unknown>
      | undefined;
    expect(outputConfig?.effort).toBeUndefined();

    // No assistant prefill in messages
    const messages = callArg.messages as Array<{ role: string }>;
    const lastMessage = messages[messages.length - 1];
    expect(lastMessage.role).not.toBe("assistant");
  });

  // H3c / M14: an API failure must throw a TYPED error so the route maps it to
  // 503 — it must NOT be swallowed into an off-topic refusal (which would mask
  // an extractor outage as the user being told they're off-topic).
  it("rejects with ExternalServiceError when the API call fails generically", async () => {
    const client = {
      messages: {
        parse: vi.fn().mockRejectedValue(new Error("boom")),
      },
    };

    await expect(
      // biome-ignore lint/suspicious/noExplicitAny: test fake
      extract("fiska i Tolken", [], { client: client as any }),
    ).rejects.toBeInstanceOf(ExternalServiceError);
  });

  it("tags the ExternalServiceError with service anthropic-extractor", async () => {
    const client = {
      messages: { parse: vi.fn().mockRejectedValue(new Error("boom")) },
    };

    try {
      // biome-ignore lint/suspicious/noExplicitAny: test fake
      await extract("fiska i Tolken", [], { client: client as any });
      throw new Error("expected extract to throw");
    } catch (err) {
      expect(err).toBeInstanceOf(ExternalServiceError);
      expect((err as ExternalServiceError).service).toBe("anthropic-extractor");
    }
  });

  it("threads the upstream status through ExternalServiceError (M12)", async () => {
    const rateLimited = Object.assign(new Error("rate limited"), {
      status: 429,
    });
    const client = {
      messages: { parse: vi.fn().mockRejectedValue(rateLimited) },
    };

    try {
      // biome-ignore lint/suspicious/noExplicitAny: test fake
      await extract("fiska i Tolken", [], { client: client as any });
      throw new Error("expected extract to throw");
    } catch (err) {
      expect(err).toBeInstanceOf(ExternalServiceError);
      expect((err as ExternalServiceError).status).toBe(429);
    }
  });

  it("rejects with TimeoutError when the request times out", async () => {
    const timeout = new DOMException("timed out", "TimeoutError");
    const client = {
      messages: { parse: vi.fn().mockRejectedValue(timeout) },
    };

    await expect(
      // biome-ignore lint/suspicious/noExplicitAny: test fake
      extract("fiska i Tolken", [], { client: client as any }),
    ).rejects.toBeInstanceOf(TimeoutError);
  });
});
