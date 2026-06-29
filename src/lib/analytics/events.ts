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
  // H7: previously-invisible gate paths — the anon→register funnel,
  // lake-lock redirects, and credit exhaustion all emit now.
  | "register_gate"
  | "lake_lock"
  | "out_of_credits"
  // H4: surfaced when post-stream assistant-turn persistence fails so the
  // dropped turn is observable instead of being swallowed by catch {}.
  | "persistence_failure";

export interface AnalyticsEvent {
  type: AnalyticsEventType;
  lakeId?: string;
  conversationId?: string;
  /**
   * L10: free-form payload — permits emit-site drift.  A discriminated union
   * keyed on `type` would be tighter, but that is a broader refactor across
   * every emit site.  [~] deferred: discriminated payload union.
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
    // L10: analytics writes are non-fatal and only console.warn on failure —
    // acceptable, but note that observability goes dark silently if the
    // analytics_event insert itself fails (no secondary alerting path).
    console.warn("[analytics] emit failed — swallowing error", err);
  }
}
