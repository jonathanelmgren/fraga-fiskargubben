import { db as realDb } from "@/shared/db/client";
import { analyticsEvents } from "@/shared/db/schema";

export type AnalyticsEventType =
  | "lake_resolved"
  | "lake_unresolved"
  | "source_miss"
  | "signals_built"
  | "credit_spent"
  | "topic_refused"
  | "chat_limit_hit"
  // M6: emitted on every attempt against an ALREADY-frozen conversation, kept
  // distinct from chat_limit_hit (the one-time transition emitted by
  // freezeConversation) so a dashboard counting chat_limit_hit measures chats
  // that hit the limit, not retries against frozen chats.
  | "chat_limit_retry"
  // H7: previously-invisible gate paths — the anon→register funnel,
  // lake-lock redirects, and credit exhaustion all emit now.
  | "register_gate"
  | "lake_lock"
  | "out_of_credits"
  // H4: surfaced when post-stream assistant-turn persistence fails so the
  // dropped turn is observable instead of being swallowed by catch {}.
  | "persistence_failure"
  // L-rt1: an exception escaping handleAsk in the POST handler — makes
  // "where did the pipeline fail" queryable instead of an invisible 5xx.
  | "pipeline_error"
  // L-ah1: the Extractor returned a relative Swedish time (e.g. "ikväll") that
  // new Date() can't parse, so Signals fell back to `now`. Emitted so the
  // prevalence of this silent degradation is visible.
  | "time_parse_fallback";

export interface AnalyticsEvent {
  type: AnalyticsEventType;
  lakeId?: string;
  conversationId?: string;
  /**
   * L10 / M10(b): free-form payload — permits emit-site drift. A discriminated
   * union keyed on `type` with a required payload shape per variant would be
   * tighter, but it is a mechanical refactor across every emit site (~30 sites)
   * with no behavioural change. [~] deferred: discriminated payload union (wide
   * ripple). The most drift-prone payloads are kept consistent by convention:
   * source_miss → { source, reason }; credit_spent → { userId };
   * persistence_failure / pipeline_error → { reason }.
   */
  payload?: Record<string, unknown>;
}

export interface EmitDeps {
  db: Pick<typeof realDb, "insert">;
}

export async function emit(
  event: AnalyticsEvent,
  deps: EmitDeps = { db: realDb },
): Promise<void> {
  try {
    await deps.db.insert(analyticsEvents).values({
      type: event.type,
      lakeId: event.lakeId ?? null,
      conversationId: event.conversationId ?? null,
      payload: event.payload ?? {},
    });
  } catch (err) {
    // M10(a): analytics writes are non-fatal, but the insert failing is the one
    // case where observability goes dark — so log a STRUCTURED single line at
    // error level with a stable prefix a log-based alert can match on, instead
    // of a free-text console.warn. (A discriminated payload union — M10(b) — is
    // deferred: see AnalyticsEvent.payload.)
    console.error(
      `[analytics] emit failed type=${event.type}: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}
