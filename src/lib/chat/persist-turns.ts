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
export async function persistTurns(
  deps: PersistTurnsDeps,
  args: {
    conversationId: string;
    message: string;
    stream: Pick<AdviceStream, "finalMessage">;
  },
): Promise<void> {
  const { conversationId, message, stream } = args;
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
