/**
 * advice calls — Task 5.4
 *
 * adviseFirst   — Sonnet 4.6, adaptive thinking, streamed (ADR-0003)
 * adviseFollowup — Haiku 4.5, streamed, no thinking, windingDown at turn 15 (ADR-0004)
 *
 * Both functions return the MessageStream directly so callers can iterate
 * events or call .finalMessage() as needed.
 *
 * Cache prefix rule: FISKARGUBBEN_SYSTEM is passed as the system block with
 * cache_control: { type: "ephemeral" } so Anthropic caches the frozen prompt.
 * Runtime variables (Signals, message, history, gender, windingDown) go in the
 * user turn — NOT interpolated into the system text.
 */

import Anthropic from "@anthropic-ai/sdk";
import { FISKARGUBBEN_SYSTEM } from "@/lib/chat/persona";
import { ADVICE_MODEL, FOLLOWUP_MODEL } from "@/lib/claude/models";
import type { Signals } from "@/lib/signals/types";
import type { Extraction, HistoryMessage } from "./extractor";

// ---------------------------------------------------------------------------
// Shared types
// ---------------------------------------------------------------------------

/**
 * M9: type the client's `messages` surface honestly to include `.stream`
 * (and `.parse`, used by the extractor's sibling deps) rather than casting
 * `client.messages as Anthropic["messages"]` at the call sites — the cast hid
 * whether the injected test fake matched the real `.stream` signature.
 */
export type AdviseDeps = {
  client: { messages: Pick<Anthropic["messages"], "stream"> };
};

// ---------------------------------------------------------------------------
// Dependency injection — lazy to avoid module-level env reads in tests
// ---------------------------------------------------------------------------

function defaultClient(): AdviseDeps["client"] {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { env } = require("@/shared/env") as typeof import("@/shared/env");
  return new Anthropic({ apiKey: env.ANTHROPIC_API_KEY });
}

// ---------------------------------------------------------------------------
// Shared system block (frozen prompt + cache prefix)
// ---------------------------------------------------------------------------

const SYSTEM_BLOCK = [
  {
    type: "text" as const,
    text: FISKARGUBBEN_SYSTEM,
    cache_control: { type: "ephemeral" as const },
  },
];

// ---------------------------------------------------------------------------
// adviseFirst
// ---------------------------------------------------------------------------

export type AdviseFirstParams = {
  signals: Signals;
  message: string;
  history?: HistoryMessage[];
  gender?: string;
  deps?: AdviseDeps;
};

/**
 * First-turn advice — Sonnet 4.6 with adaptive thinking, streamed.
 *
 * Builds a user turn containing:
 *   - Signals JSON snapshot (lake context, weather, water, fish)
 *   - The user's message
 *   - Optional prior history (for context on first turn)
 *   - Optional gender hint (for gendered tilltal per FISKARGUBBEN_SYSTEM rules)
 */
export function adviseFirst({
  signals,
  message,
  history = [],
  gender,
  deps,
}: AdviseFirstParams) {
  const client = deps?.client ?? defaultClient();

  const userContent = buildUserContent({ signals, message, gender });

  const messages: Array<{ role: "user" | "assistant"; content: string }> = [
    ...history.map((h) => ({ role: h.role, content: h.content })),
    { role: "user", content: userContent },
  ];

  return client.messages.stream({
    model: ADVICE_MODEL,
    max_tokens: 1024,
    thinking: { type: "adaptive" },
    system: SYSTEM_BLOCK,
    messages,
  });
}

// ---------------------------------------------------------------------------
// adviseFollowup
// ---------------------------------------------------------------------------

export type AdviseFollowupParams = {
  snapshot: Signals;
  message: string;
  history?: HistoryMessage[];
  turnIndex: number;
  gender?: string;
  deps?: AdviseDeps;
};

/**
 * Follow-up advice — Haiku 4.5, streamed, no thinking.
 *
 * Uses the frozen signals snapshot from the first turn (no re-fetch).
 * Sets windingDown = turnIndex >= 15 and injects it into the user turn
 * so the persona can naturally wind down per ADR-0004.
 */
export function adviseFollowup({
  snapshot,
  message,
  history = [],
  turnIndex,
  gender,
  deps,
}: AdviseFollowupParams) {
  const client = deps?.client ?? defaultClient();

  const windingDown = turnIndex >= 15;
  const userContent = buildUserContent({
    signals: snapshot,
    message,
    gender,
    windingDown,
  });

  const messages: Array<{ role: "user" | "assistant"; content: string }> = [
    ...history.map((h) => ({ role: h.role, content: h.content })),
    { role: "user", content: userContent },
  ];

  return client.messages.stream({
    model: FOLLOWUP_MODEL,
    max_tokens: 1024,
    system: SYSTEM_BLOCK,
    messages,
  });
}

// ---------------------------------------------------------------------------
// Lake-lock helpers (pure)
// ---------------------------------------------------------------------------

/**
 * Returns true if the extraction names a lake that differs from the
 * conversation's locked lake.
 *
 * v1 scope: only lake name mismatch (no time/date comparison per YAGNI).
 * Case-insensitive comparison for robustness.
 */
export function isLakeLockViolation(
  extraction: Extraction,
  conversationLakeName: string,
): boolean {
  if (!extraction.lakeName) return false;
  return (
    extraction.lakeName.toLowerCase() !== conversationLakeName.toLowerCase()
  );
}

/**
 * In-persona redirect string for lake-lock violations (ADR-0004).
 */
export function getLakeLockRedirect(lakeName: string): string {
  return `jag känner bara till ${lakeName}, grabben — dra igång en ny chatt för ett annat vatten`;
}

// ---------------------------------------------------------------------------
// Internal helper — build user turn content
// ---------------------------------------------------------------------------

type UserContentParams = {
  signals: Signals;
  message: string;
  gender?: string;
  windingDown?: boolean;
};

function buildUserContent({
  signals,
  message,
  gender,
  windingDown,
}: UserContentParams): string {
  const parts: string[] = [];

  parts.push(`[SIGNALER]\n${JSON.stringify(signals, null, 2)}`);

  if (gender) {
    parts.push(`[KÖN] ${gender}`);
  }

  if (windingDown !== undefined) {
    parts.push(`[windingDown] ${windingDown}`);
  }

  parts.push(`[MEDDELANDE]\n${message}`);

  return parts.join("\n\n");
}
