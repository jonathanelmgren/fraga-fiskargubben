import "server-only";
import { sql } from "drizzle-orm";
import { db as realDb } from "@/shared/db/client";
import { analyticsEvents, lakes } from "@/shared/db/schema";

/**
 * Read-side aggregation layer over the append-only `analytics_event` table
 * (ADR-0005).  These are the "dashboards later" deliverable — every query is a
 * pure read; nothing here touches the emit pipeline (`./events.ts`) or writes
 * rows.  The event taxonomy + payload shapes these queries assume come straight
 * from the emit sites:
 *
 *   lake_resolved      lakeId
 *   lake_unresolved    —
 *   source_miss        lakeId, payload { source, reason: error|empty|no_row }
 *   signals_built      lakeId
 *   credit_spent       payload { userId }
 *   topic_refused      —
 *   chat_limit_hit     conversationId
 *   register_gate      —
 *   lake_lock          conversationId
 *   out_of_credits     —
 *   persistence_failure conversationId, payload { error }
 *
 * Query style matches `lib/lakes/resolve.ts`: raw `db.execute<Row>(sql\`\`)` with
 * `${table}` interpolation.  `deps` is injectable (mirrors `EmitDeps` in
 * events.ts) so the aggregations are unit-testable against a stubbed executor.
 */
export interface QueryDeps {
  db: Pick<typeof realDb, "execute">;
}

const defaultDeps = (): QueryDeps => ({ db: realDb });

/** A time window, inclusive of `since`, applied as `created_at >= since`. */
export interface Window {
  /** Only count events at or after this instant. Omit for all-time. */
  since?: Date;
}

/** Renders the optional `AND created_at >= ...` fragment for a window. */
function sinceClause(window: Window | undefined) {
  return window?.since
    ? sql`AND created_at >= ${window.since.toISOString()}`
    : sql``;
}

// ─────────────────────────────────────────────────────────────────────────────
// Top lakes asked
// ─────────────────────────────────────────────────────────────────────────────

export interface TopLakeRow {
  lakeId: string;
  /** Nullable: an unnamed water body still resolves and gets asked about. */
  name: string | null;
  municipality: string | null;
  county: string | null;
  /** Distinct-conversation count would need a conversationId on lake_resolved;
   * we only have per-resolution rows, so this is resolution count. */
  resolvedCount: number;
}

/**
 * Lakes ranked by how often they were successfully resolved (`lake_resolved`).
 * Joined to `lakes` for a human label; a missing join (lake later deleted)
 * still surfaces the id with null name.
 */
export async function topLakesAsked(
  limit = 20,
  window?: Window,
  deps: QueryDeps = defaultDeps(),
): Promise<TopLakeRow[]> {
  const rows = await deps.db.execute<{
    lake_id: string;
    name: string | null;
    municipality: string | null;
    county: string | null;
    resolved_count: number;
  }>(sql`
    SELECT
      e.lake_id                         AS lake_id,
      l.name                            AS name,
      l.municipality                    AS municipality,
      l.county                          AS county,
      count(*)::int                     AS resolved_count
    FROM ${analyticsEvents} e
    LEFT JOIN ${lakes} l ON l.id = e.lake_id
    WHERE e.type = 'lake_resolved'
      AND e.lake_id IS NOT NULL
      ${sinceClause(window)}
    GROUP BY e.lake_id, l.name, l.municipality, l.county
    ORDER BY resolved_count DESC, e.lake_id ASC
    LIMIT ${limit}
  `);

  return rows.map((r) => ({
    lakeId: r.lake_id,
    name: r.name,
    municipality: r.municipality,
    county: r.county,
    resolvedCount: r.resolved_count,
  }));
}

// ─────────────────────────────────────────────────────────────────────────────
// Unresolved-lake rate
// ─────────────────────────────────────────────────────────────────────────────

export interface ResolutionRate {
  resolved: number;
  unresolved: number;
  /** unresolved / (resolved + unresolved); 0 when there is no traffic. */
  unresolvedRate: number;
}

/**
 * Share of lake-resolution attempts that failed.  `lake_resolved` and
 * `lake_unresolved` are the two mutually-exclusive outcomes of a resolution
 * attempt (see ask-handler), so their counts form the denominator.
 */
export async function unresolvedLakeRate(
  window?: Window,
  deps: QueryDeps = defaultDeps(),
): Promise<ResolutionRate> {
  const rows = await deps.db.execute<{
    resolved: number;
    unresolved: number;
  }>(sql`
    SELECT
      count(*) FILTER (WHERE type = 'lake_resolved')::int   AS resolved,
      count(*) FILTER (WHERE type = 'lake_unresolved')::int AS unresolved
    FROM ${analyticsEvents}
    WHERE type IN ('lake_resolved', 'lake_unresolved')
      ${sinceClause(window)}
  `);

  const { resolved = 0, unresolved = 0 } = rows[0] ?? {};
  const total = resolved + unresolved;
  return {
    resolved,
    unresolved,
    unresolvedRate: total === 0 ? 0 : unresolved / total,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Per-source miss rate
// ─────────────────────────────────────────────────────────────────────────────

export interface SourceMissRow {
  /** `payload.source` from source_miss (e.g. "weather", "water_temp"). */
  source: string;
  /** Total misses for this source across all reasons. */
  misses: number;
  /** Breakdown by `payload.reason`. */
  errorCount: number;
  emptyCount: number;
  noRowCount: number;
}

/**
 * `source_miss` events grouped by `payload.source`, split by `payload.reason`
 * (error | empty | no_row — see signals/build.ts `missFire`).  A "rate" needs a
 * denominator of resolution attempts per source, which we do not record
 * per-source; this reports absolute miss volume, which is the actionable signal
 * ("which source fails most / how").
 */
export async function sourceMissBreakdown(
  window?: Window,
  deps: QueryDeps = defaultDeps(),
): Promise<SourceMissRow[]> {
  const rows = await deps.db.execute<{
    source: string;
    misses: number;
    error_count: number;
    empty_count: number;
    no_row_count: number;
  }>(sql`
    SELECT
      coalesce(payload->>'source', 'unknown')                          AS source,
      count(*)::int                                                    AS misses,
      count(*) FILTER (WHERE payload->>'reason' = 'error')::int        AS error_count,
      count(*) FILTER (WHERE payload->>'reason' = 'empty')::int        AS empty_count,
      count(*) FILTER (WHERE payload->>'reason' = 'no_row')::int       AS no_row_count
    FROM ${analyticsEvents}
    WHERE type = 'source_miss'
      ${sinceClause(window)}
    GROUP BY 1
    ORDER BY misses DESC, source ASC
  `);

  return rows.map((r) => ({
    source: r.source,
    misses: r.misses,
    errorCount: r.error_count,
    emptyCount: r.empty_count,
    noRowCount: r.no_row_count,
  }));
}

// ─────────────────────────────────────────────────────────────────────────────
// Credit spend
// ─────────────────────────────────────────────────────────────────────────────

export interface CreditSpend {
  /** Total `credit_spent` events = total credits burned. */
  totalCredits: number;
  /** Distinct `payload.userId` values that spent at least one credit. */
  distinctUsers: number;
}

/**
 * Credit consumption from `credit_spent` (payload { userId }).  One event = one
 * new conversation = one fresh Signals fetch (ADR-0004).
 */
export async function creditSpend(
  window?: Window,
  deps: QueryDeps = defaultDeps(),
): Promise<CreditSpend> {
  const rows = await deps.db.execute<{
    total_credits: number;
    distinct_users: number;
  }>(sql`
    SELECT
      count(*)::int                               AS total_credits,
      count(DISTINCT payload->>'userId')::int     AS distinct_users
    FROM ${analyticsEvents}
    WHERE type = 'credit_spent'
      ${sinceClause(window)}
  `);

  const { total_credits = 0, distinct_users = 0 } = rows[0] ?? {};
  return { totalCredits: total_credits, distinctUsers: distinct_users };
}

// ─────────────────────────────────────────────────────────────────────────────
// Simple per-type counts (topic refusals, chat-limit hits, gate funnel, …)
// ─────────────────────────────────────────────────────────────────────────────

export interface EventCount {
  type: string;
  count: number;
}

/**
 * Raw count for a single event type in the window.  Backs the topic-refusals
 * and chat-limit-hit tiles as well as the gate-funnel figures.
 */
export async function countByType(
  type: string,
  window?: Window,
  deps: QueryDeps = defaultDeps(),
): Promise<number> {
  const rows = await deps.db.execute<{ count: number }>(sql`
    SELECT count(*)::int AS count
    FROM ${analyticsEvents}
    WHERE type = ${type}
      ${sinceClause(window)}
  `);
  return rows[0]?.count ?? 0;
}

/**
 * Full histogram of event volume by `type` — the catch-all overview tile.  Any
 * new emit-site `type` shows up here automatically (no schema change needed),
 * which is the point of the free-form `type text` column in ADR-0005.
 */
export async function eventCountsByType(
  window?: Window,
  deps: QueryDeps = defaultDeps(),
): Promise<EventCount[]> {
  const rows = await deps.db.execute<{ type: string; count: number }>(sql`
    SELECT type, count(*)::int AS count
    FROM ${analyticsEvents}
    WHERE TRUE
      ${sinceClause(window)}
    GROUP BY type
    ORDER BY count DESC, type ASC
  `);
  return rows.map((r) => ({ type: r.type, count: r.count }));
}

// ─────────────────────────────────────────────────────────────────────────────
// Dashboard bundle — one round-trip-friendly aggregate for the admin page
// ─────────────────────────────────────────────────────────────────────────────

export interface AnalyticsOverview {
  window: { since: string | null };
  topLakes: TopLakeRow[];
  resolution: ResolutionRate;
  sourceMisses: SourceMissRow[];
  credits: CreditSpend;
  topicRefusals: number;
  chatLimitHits: number;
  /** H7 gate funnel. */
  registerGates: number;
  lakeLocks: number;
  outOfCredits: number;
  /** H4 dropped assistant turns. */
  persistenceFailures: number;
  byType: EventCount[];
}

/**
 * Runs every dashboard aggregation for the given window.  Queries are
 * independent reads, so they fan out concurrently.
 */
export async function analyticsOverview(
  window?: Window,
  deps: QueryDeps = defaultDeps(),
): Promise<AnalyticsOverview> {
  const [
    topLakes,
    resolution,
    sourceMisses,
    credits,
    topicRefusals,
    chatLimitHits,
    registerGates,
    lakeLocks,
    outOfCredits,
    persistenceFailures,
    byType,
  ] = await Promise.all([
    topLakesAsked(20, window, deps),
    unresolvedLakeRate(window, deps),
    sourceMissBreakdown(window, deps),
    creditSpend(window, deps),
    countByType("topic_refused", window, deps),
    countByType("chat_limit_hit", window, deps),
    countByType("register_gate", window, deps),
    countByType("lake_lock", window, deps),
    countByType("out_of_credits", window, deps),
    countByType("persistence_failure", window, deps),
    eventCountsByType(window, deps),
  ]);

  return {
    window: { since: window?.since?.toISOString() ?? null },
    topLakes,
    resolution,
    sourceMisses,
    credits,
    topicRefusals,
    chatLimitHits,
    registerGates,
    lakeLocks,
    outOfCredits,
    persistenceFailures,
    byType,
  };
}
