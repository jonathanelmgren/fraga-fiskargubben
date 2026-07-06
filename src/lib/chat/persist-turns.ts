/**
 * persist-turns.ts — turn persistence helpers (H3a / M11, resumable streams).
 *
 * Extracted from route.ts so they can be unit-tested without a real server or
 * DB. This is the ONLY place user + assistant turns and lastActiveAt are
 * written (ADR-0001 — conversations are persisted).
 *
 * Resumable-streams split: the USER turn is written up-front by the route
 * (persistUserTurn, before the advice stream starts) so it survives a failed
 * or abandoned assistant stream. The ASSISTANT turn is written after
 * finalMessage() settles (persistAssistantTurn) — driven by the stream
 * registry's detached consumer, so it no longer depends on the client staying
 * connected.
 *
 * Failure contract: a persistence failure must NEVER rethrow (the response is
 * already sent) — it emits a single `persistence_failure` analytics event so
 * the dropped turn is observable (H4) instead of being swallowed.
 */

import type { AnalyticsEvent } from "@/lib/analytics/events";
import { llmUsagePayload, usageOf } from "@/lib/analytics/llm-cost";
import type { AdviceStream } from "@/lib/chat/ask-handler";

export type PersistTurnsDeps = {
  persistMessage(opts: {
    conversationId: string;
    role: "user" | "assistant";
    content: string;
  }): Promise<void>;
  updateLastActive(conversationId: string): Promise<void>;
  emit(event: AnalyticsEvent): Promise<void>;
  /** Refund a spent credit when the first-turn stream fails (ADR-0004). */
  refundCredit(userId: string): Promise<boolean>;
};

/**
 * Extract the assistant's text from a finalMessage() payload.
 * Concatenates all text blocks; non-text blocks (tool use, etc.) are ignored.
 */
function assistantTextOf(final: {
  content: Array<{ type: string; text?: string }>;
}): string {
  return final.content
    .filter((c) => c.type === "text")
    .map((c) => ("text" in c ? (c.text ?? "") : ""))
    .join("");
}

/**
 * Persist the user turn immediately (before the advice stream starts), so the
 * user's question survives even when the assistant stream later fails or the
 * client disconnects. Never throws — emits `persistence_failure` instead.
 */
export async function persistUserTurn(
  deps: Pick<PersistTurnsDeps, "persistMessage" | "emit">,
  args: { conversationId: string; message: string },
): Promise<void> {
  const { conversationId, message } = args;
  try {
    await deps.persistMessage({
      conversationId,
      role: "user",
      content: message,
    });
  } catch (err) {
    await deps.emit({
      type: "persistence_failure",
      conversationId,
      payload: {
        reason: `persistUserTurn: ${err instanceof Error ? err.message : String(err)}`,
      },
    });
  }
}

/**
 * Persist a clarify round (rebuild spec): the user turn plus the resolver's
 * clarify question as the assistant turn. No stream involved — the text is
 * already final. Same never-throws contract as persistTurns.
 */
export async function persistClarifyTurns(
  deps: Pick<PersistTurnsDeps, "persistMessage" | "updateLastActive" | "emit">,
  args: { conversationId: string; message: string; clarifyText: string },
): Promise<void> {
  const { conversationId, message, clarifyText } = args;
  try {
    await deps.persistMessage({
      conversationId,
      role: "user",
      content: message,
    });
    await deps.persistMessage({
      conversationId,
      role: "assistant",
      content: clarifyText,
    });
  } catch (err) {
    await deps.emit({
      type: "persistence_failure",
      conversationId,
      payload: { reason: err instanceof Error ? err.message : String(err) },
    });
  } finally {
    try {
      await deps.updateLastActive(conversationId);
    } catch (err) {
      await deps.emit({
        type: "persistence_failure",
        conversationId,
        payload: {
          reason: `updateLastActive: ${err instanceof Error ? err.message : String(err)}`,
        },
      });
    }
  }
}

/**
 * Persist the assistant turn and roll lastActiveAt forward.
 *
 * Awaits finalMessage() — which, with the stream registry's detached consumer,
 * settles regardless of client connection. If it rejects, no assistant row is
 * written, a single `persistence_failure` is emitted, the credit is refunded
 * when applicable, and lastActiveAt STILL rolls forward (M11). Never throws.
 */
export async function persistAssistantTurn(
  deps: PersistTurnsDeps,
  args: {
    conversationId: string;
    stream: Pick<AdviceStream, "finalMessage">;
    /**
     * Set only when a credit was spent for THIS first-turn stream. If
     * finalMessage() rejects, the credit is refunded (a failed answer must not
     * consume a credit, ADR-0004). Absent on follow-ups / free / anon turns.
     */
    refundUserId?: string;
  },
): Promise<void> {
  const { conversationId, stream, refundUserId } = args;
  try {
    const final = await stream.finalMessage();
    const assistantText = assistantTextOf(final);

    // Cost analytics: one llm_usage event per advice stream (Sonnet first
    // answer / Haiku follow-up — the model field tells them apart). Guarded:
    // test fakes and degenerate payloads may lack model/usage.
    if (final.model && final.usage) {
      await deps.emit({
        type: "llm_usage",
        conversationId,
        payload: llmUsagePayload(
          "advise",
          usageOf({ model: final.model, usage: final.usage }),
        ),
      });
    }

    if (assistantText) {
      await deps.persistMessage({
        conversationId,
        role: "assistant",
        content: assistantText,
      });
    }
  } catch (err) {
    // L-rt1: standardize on the `reason` payload key (ask-handler uses the same)
    // so a single event type doesn't carry two different shapes.
    await deps.emit({
      type: "persistence_failure",
      conversationId,
      payload: { reason: err instanceof Error ? err.message : String(err) },
    });
    // C-refund: finalMessage() rejected → the first-turn Sonnet answer failed.
    // ADR-0004 defines a Credit as a SUCCESSFUL answer, so refund the credit
    // that was spent before the stream. Guarded + idempotent (refundCredit only
    // decrements creditsUsed > 0), best-effort — never rethrows.
    if (refundUserId !== undefined) {
      try {
        await deps.refundCredit(refundUserId);
      } catch (refundErr) {
        await deps.emit({
          type: "persistence_failure",
          conversationId,
          payload: {
            reason: `refundCredit: ${refundErr instanceof Error ? refundErr.message : String(refundErr)}`,
          },
        });
      }
    }
  } finally {
    // M11: always roll lastActiveAt forward, even when finalMessage() rejected,
    // so a half-failed turn doesn't leave the conversation looking stale.
    try {
      await deps.updateLastActive(conversationId);
    } catch (err) {
      await deps.emit({
        type: "persistence_failure",
        conversationId,
        payload: {
          reason: `updateLastActive: ${err instanceof Error ? err.message : String(err)}`,
        },
      });
    }
  }
}
