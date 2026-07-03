/**
 * persist-turns.ts — post-stream turn persistence (H3a / M11).
 *
 * Extracted from route.ts's after() body so it can be unit-tested without a
 * real server or DB. This is the ONLY place user + assistant turns and
 * lastActiveAt are written (ADR-0001 — conversations are persisted), and it
 * runs fire-and-forget AFTER the response stream has been handed to the client.
 *
 * Failure contract: a persistence failure must NEVER rethrow (the response is
 * already sent) — it emits a single `persistence_failure` analytics event so
 * the dropped turn is observable (H4) instead of being swallowed.
 */

import type { AnalyticsEvent } from "@/lib/analytics/events";
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
 * Persist the user turn, the assistant turn, and roll lastActiveAt forward.
 *
 * M11: the user and assistant turns are persisted together AFTER
 * finalMessage() resolves, so a healthy stream never leaves a user row without
 * its assistant reply. If finalMessage() rejects, we still record the user turn
 * (best effort) and ALWAYS roll lastActiveAt forward in a finally — so the next
 * turn never sees a stale lastActiveAt — and emit a single `persistence_failure`.
 *
 * Never throws.
 */
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

export async function persistTurns(
  deps: PersistTurnsDeps,
  args: {
    conversationId: string;
    message: string;
    stream: Pick<AdviceStream, "finalMessage">;
    /**
     * Set only when a credit was spent for THIS first-turn stream. If
     * finalMessage() rejects, the credit is refunded (a failed answer must not
     * consume a credit, ADR-0004). Absent on follow-ups / free / anon turns.
     */
    refundUserId?: string;
  },
): Promise<void> {
  const { conversationId, message, stream, refundUserId } = args;
  try {
    // Resolve the assistant text BEFORE writing, so the user+assistant pair is
    // persisted atomically-in-spirit (no dangling user row on a stream that
    // never produced a final message).
    const final = await stream.finalMessage();
    const assistantText = assistantTextOf(final);

    await deps.persistMessage({
      conversationId,
      role: "user",
      content: message,
    });
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
