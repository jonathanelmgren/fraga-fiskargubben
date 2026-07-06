/**
 * llm-cost.ts — token usage → USD cost for the LLM calls in the ask pipeline.
 *
 * Every Anthropic response carries `usage` (token counts) and `model`. The
 * emit sites (ask-handler for extract/resolve, persist-turns for the advice
 * streams) turn that into one `llm_usage` analytics event per API call:
 *
 *   llm_usage → payload {
 *     kind: "extract" | "resolve" | "advise",
 *     model, inputTokens, outputTokens,
 *     cacheCreationInputTokens, cacheReadInputTokens,
 *     costUsd,
 *   } + conversationId (when the conversation exists at emit time)
 *
 * costUsd is computed AT EVENT TIME from the price table below, so historical
 * rows stay correct when prices change — the tokens are the source of truth,
 * the dollar figure is a convenience snapshot.
 *
 * Prices (USD per 1M tokens, verified against the Anthropic model catalog
 * 2026-07): cache writes bill at 1.25× input (5-minute TTL), cache reads at
 * 0.1× input.
 */

/** Normalized usage from one Anthropic API call. */
export type LlmCallUsage = {
  /** The model id as returned by the API (e.g. "claude-haiku-4-5-20251001"). */
  model: string;
  inputTokens: number;
  outputTokens: number;
  cacheCreationInputTokens: number;
  cacheReadInputTokens: number;
};

/** USD per 1M tokens. Keyed by model-id PREFIX (API ids may carry a date suffix). */
const PRICES_USD_PER_MTOK: Array<{
  prefix: string;
  input: number;
  output: number;
}> = [
  { prefix: "claude-sonnet-4-6", input: 3, output: 15 },
  { prefix: "claude-haiku-4-5", input: 1, output: 5 },
];

const CACHE_WRITE_MULTIPLIER = 1.25;
const CACHE_READ_MULTIPLIER = 0.1;

/**
 * USD cost of one call, or null when the model is not in the price table
 * (a model swap without a price row must not silently report 0 — null keeps
 * the gap visible in queries via costUsd IS NULL).
 */
export function llmCostUsd(usage: LlmCallUsage): number | null {
  const price = PRICES_USD_PER_MTOK.find((p) =>
    usage.model.startsWith(p.prefix),
  );
  if (!price) return null;
  const perTokIn = price.input / 1_000_000;
  const perTokOut = price.output / 1_000_000;
  return (
    usage.inputTokens * perTokIn +
    usage.cacheCreationInputTokens * perTokIn * CACHE_WRITE_MULTIPLIER +
    usage.cacheReadInputTokens * perTokIn * CACHE_READ_MULTIPLIER +
    usage.outputTokens * perTokOut
  );
}

/**
 * Normalize the SDK's snake_case usage block (cache fields are nullable) into
 * LlmCallUsage. Shape-typed so both `messages.parse` responses and
 * `finalMessage()` payloads fit without importing SDK types here.
 */
export function usageOf(response: {
  model: string;
  usage: {
    input_tokens: number;
    output_tokens: number;
    cache_creation_input_tokens?: number | null;
    cache_read_input_tokens?: number | null;
  };
}): LlmCallUsage {
  return {
    model: response.model,
    inputTokens: response.usage.input_tokens,
    outputTokens: response.usage.output_tokens,
    cacheCreationInputTokens: response.usage.cache_creation_input_tokens ?? 0,
    cacheReadInputTokens: response.usage.cache_read_input_tokens ?? 0,
  };
}

export type LlmUsageKind = "extract" | "resolve" | "advise";

/** The llm_usage event payload — one shape for every emit site. */
export function llmUsagePayload(
  kind: LlmUsageKind,
  usage: LlmCallUsage,
): Record<string, unknown> {
  return {
    kind,
    model: usage.model,
    inputTokens: usage.inputTokens,
    outputTokens: usage.outputTokens,
    cacheCreationInputTokens: usage.cacheCreationInputTokens,
    cacheReadInputTokens: usage.cacheReadInputTokens,
    costUsd: llmCostUsd(usage),
  };
}
