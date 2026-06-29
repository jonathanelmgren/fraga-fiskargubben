import { db as realDb } from "@/shared/db/client";
import { analyticsEvents } from "@/shared/db/schema";

export type AnalyticsEventType =
  | "lake_resolved"
  | "lake_unresolved"
  | "source_miss"
  | "signals_built"
  | "credit_spent"
  | "topic_refused"
  | "chat_limit_hit";

export interface AnalyticsEvent {
  type: AnalyticsEventType;
  lakeId?: string;
  conversationId?: string;
  payload?: Record<string, unknown>;
}

interface EmitDeps {
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
    console.warn("[analytics] emit failed — swallowing error", err);
  }
}
