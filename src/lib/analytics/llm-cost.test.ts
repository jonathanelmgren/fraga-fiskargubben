import { describe, expect, it } from "vitest";
import { llmCostUsd, llmUsagePayload, usageOf } from "./llm-cost";

describe("llmCostUsd", () => {
  it("prices a Sonnet 4.6 call ($3/$15 per MTok)", () => {
    expect(
      llmCostUsd({
        model: "claude-sonnet-4-6",
        inputTokens: 1_000_000,
        outputTokens: 1_000_000,
        cacheCreationInputTokens: 0,
        cacheReadInputTokens: 0,
      }),
    ).toBeCloseTo(18, 10);
  });

  it("prices a Haiku 4.5 call, matching the date-suffixed API model id", () => {
    expect(
      llmCostUsd({
        model: "claude-haiku-4-5-20251001",
        inputTokens: 2000,
        outputTokens: 500,
        cacheCreationInputTokens: 0,
        cacheReadInputTokens: 0,
      }),
    ).toBeCloseTo(2000 * 1e-6 + 500 * 5e-6, 10);
  });

  it("bills cache writes at 1.25x and reads at 0.1x of input", () => {
    expect(
      llmCostUsd({
        model: "claude-sonnet-4-6",
        inputTokens: 0,
        outputTokens: 0,
        cacheCreationInputTokens: 1_000_000,
        cacheReadInputTokens: 1_000_000,
      }),
    ).toBeCloseTo(3 * 1.25 + 3 * 0.1, 10);
  });

  it("returns null for a model without a price row (never silent 0)", () => {
    expect(
      llmCostUsd({
        model: "claude-opus-4-8",
        inputTokens: 100,
        outputTokens: 100,
        cacheCreationInputTokens: 0,
        cacheReadInputTokens: 0,
      }),
    ).toBeNull();
  });
});

describe("usageOf", () => {
  it("normalizes the SDK's snake_case usage, defaulting nullable cache fields", () => {
    expect(
      usageOf({
        model: "claude-haiku-4-5",
        usage: {
          input_tokens: 10,
          output_tokens: 20,
          cache_creation_input_tokens: null,
        },
      }),
    ).toEqual({
      model: "claude-haiku-4-5",
      inputTokens: 10,
      outputTokens: 20,
      cacheCreationInputTokens: 0,
      cacheReadInputTokens: 0,
    });
  });
});

describe("llmUsagePayload", () => {
  it("carries kind, tokens and a computed costUsd", () => {
    const payload = llmUsagePayload("advise", {
      model: "claude-sonnet-4-6",
      inputTokens: 1000,
      outputTokens: 1000,
      cacheCreationInputTokens: 0,
      cacheReadInputTokens: 0,
    });
    expect(payload).toMatchObject({
      kind: "advise",
      model: "claude-sonnet-4-6",
      inputTokens: 1000,
      outputTokens: 1000,
    });
    expect(payload.costUsd).toBeCloseTo(0.018, 10);
  });
});
