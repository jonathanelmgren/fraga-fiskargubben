import "server-only";
import { sql } from "drizzle-orm";
import { db as realDb } from "@/shared/db/client";
import { analyticsEvents, conversations, lakes } from "@/shared/db/schema";

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
 *   topic_refused      conversationId?, payload { prompt, userId? }
 *   chat_limit_hit     conversationId
 *   register_gate      payload { reason }
 *   lake_lock          conversationId, payload { lockKey, attemptedLake }
 *   out_of_credits     payload { userId, reason }
 *   persistence_failure conversationId, payload { reason }
 *   pipeline_error     conversationId?, payload { reason }
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
 * Share of lake-resolution attempts that failed.  Post-rebuild the terminal
 * failure event is `lake_unresolved_area` (the conversation continues in area
 * mode); `lake_unresolved` is the pre-rebuild name, counted too so historical
 * rows keep contributing.  Clarify rounds are neither — not terminal.
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
      count(*) FILTER (WHERE type = 'lake_resolved')::int AS resolved,
      count(*) FILTER (WHERE type IN ('lake_unresolved', 'lake_unresolved_area'))::int AS unresolved
    FROM ${analyticsEvents}
    WHERE type IN ('lake_resolved', 'lake_unresolved', 'lake_unresolved_area')
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
// LLM cost (llm_usage events — see lib/analytics/llm-cost.ts)
// ─────────────────────────────────────────────────────────────────────────────

export interface LlmCostByKindRow {
  /** payload.kind: extract | resolve | advise. */
  kind: string;
  model: string;
  calls: number;
  costUsd: number;
}

export interface LlmCostSummary {
  /** Sum of payload.costUsd across all llm_usage events in the window. */
  totalCostUsd: number;
  /** Total API calls recorded. */
  calls: number;
  /** Calls whose model had no price row (costUsd null) — should stay 0. */
  unpricedCalls: number;
  /** Distinct conversations that incurred any cost. */
  conversations: number;
  /** totalCostUsd / conversations (attributed rows only); 0 without traffic. */
  avgCostPerConversationUsd: number;
  byKind: LlmCostByKindRow[];
}

/**
 * Token-cost rollup from `llm_usage` events. costUsd is snapshotted at emit
 * time (price-table changes don't rewrite history). Rows without a
 * conversationId (refusals / out-of-credits on brand-new prompts) count toward
 * the totals but not the per-conversation average.
 */
export async function llmCostSummary(
  window?: Window,
  deps: QueryDeps = defaultDeps(),
): Promise<LlmCostSummary> {
  const [totals, byKind] = await Promise.all([
    deps.db.execute<{
      total_cost: number | null;
      calls: number;
      unpriced: number;
      conversations: number;
    }>(sql`
      SELECT
        sum((payload->>'costUsd')::float)                                AS total_cost,
        count(*)::int                                                    AS calls,
        count(*) FILTER (WHERE payload->>'costUsd' IS NULL)::int         AS unpriced,
        count(DISTINCT conversation_id)::int                             AS conversations
      FROM ${analyticsEvents}
      WHERE type = 'llm_usage'
        ${sinceClause(window)}
    `),
    deps.db.execute<{
      kind: string;
      model: string;
      calls: number;
      cost_usd: number | null;
    }>(sql`
      SELECT
        coalesce(payload->>'kind', 'unknown')       AS kind,
        coalesce(payload->>'model', 'unknown')      AS model,
        count(*)::int                               AS calls,
        sum((payload->>'costUsd')::float)           AS cost_usd
      FROM ${analyticsEvents}
      WHERE type = 'llm_usage'
        ${sinceClause(window)}
      GROUP BY 1, 2
      ORDER BY cost_usd DESC NULLS LAST, kind ASC
    `),
  ]);

  const t = totals[0];
  const totalCostUsd = t?.total_cost ?? 0;
  const convCount = t?.conversations ?? 0;
  return {
    totalCostUsd,
    calls: t?.calls ?? 0,
    unpricedCalls: t?.unpriced ?? 0,
    conversations: convCount,
    avgCostPerConversationUsd: convCount === 0 ? 0 : totalCostUsd / convCount,
    byKind: byKind.map((r) => ({
      kind: r.kind,
      model: r.model,
      calls: r.calls,
      costUsd: r.cost_usd ?? 0,
    })),
  };
}

export interface UserCostRow {
  /** null = anonymous conversations (no account). */
  userId: string | null;
  conversations: number;
  costUsd: number;
}

/**
 * Cost per account: llm_usage events joined to conversations for user_id.
 * The premium-pricing input — compare a user's monthly cost against the
 * subscription price. Anonymous traffic groups under userId null.
 */
export async function llmCostPerUser(
  limit = 50,
  window?: Window,
  deps: QueryDeps = defaultDeps(),
): Promise<UserCostRow[]> {
  // sinceClause is unqualified — ambiguous once conversations (which also has
  // created_at) is joined, so the window fragment is inlined qualified here.
  const since = window?.since
    ? sql`AND e.created_at >= ${window.since.toISOString()}`
    : sql``;
  const rows = await deps.db.execute<{
    user_id: string | null;
    conversations: number;
    cost_usd: number | null;
  }>(sql`
    SELECT
      c.user_id                              AS user_id,
      count(DISTINCT e.conversation_id)::int AS conversations,
      sum((e.payload->>'costUsd')::float)    AS cost_usd
    FROM ${analyticsEvents} e
    JOIN ${conversations} c ON c.id = e.conversation_id
    WHERE e.type = 'llm_usage'
      ${since}
    GROUP BY c.user_id
    ORDER BY cost_usd DESC NULLS LAST
    LIMIT ${limit}
  `);

  return rows.map((r) => ({
    userId: r.user_id,
    conversations: r.conversations,
    costUsd: r.cost_usd ?? 0,
  }));
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
// Recent-event feeds — troubleshooting views (raw payloads, newest first)
// ─────────────────────────────────────────────────────────────────────────────

export interface RecentRefusalRow {
  id: number;
  /** Stockholm wall-clock, "YYYY-MM-DD HH24:MI" (formatted in SQL). */
  createdAt: string;
  conversationId: string | null;
  /** The refused user prompt (payload.prompt); null on pre-capture rows. */
  prompt: string | null;
  /** payload.userId when the caller was logged in. */
  userId: string | null;
}

/**
 * Latest topic refusals WITH the refused prompt — the "what are people
 * actually trying?" feed.  Rows emitted before prompt capture landed have a
 * null prompt and still show up (the count stays honest).
 */
export async function recentTopicRefusals(
  limit = 20,
  window?: Window,
  deps: QueryDeps = defaultDeps(),
): Promise<RecentRefusalRow[]> {
  const rows = await deps.db.execute<{
    id: number;
    created_at: string;
    conversation_id: string | null;
    prompt: string | null;
    user_id: string | null;
  }>(sql`
    SELECT
      id,
      to_char(created_at AT TIME ZONE 'UTC' AT TIME ZONE 'Europe/Stockholm',
              'YYYY-MM-DD HH24:MI') AS created_at,
      conversation_id,
      payload->>'prompt'  AS prompt,
      payload->>'userId'  AS user_id
    FROM ${analyticsEvents}
    WHERE type = 'topic_refused'
      ${sinceClause(window)}
    ORDER BY id DESC
    LIMIT ${limit}
  `);
  return rows.map((r) => ({
    id: r.id,
    createdAt: r.created_at,
    conversationId: r.conversation_id,
    prompt: r.prompt,
    userId: r.user_id,
  }));
}

export interface RecentErrorRow {
  id: number;
  /** Stockholm wall-clock, "YYYY-MM-DD HH24:MI" (formatted in SQL). */
  createdAt: string;
  /** persistence_failure | pipeline_error */
  type: string;
  conversationId: string | null;
  /** payload.reason — both error events standardize on this key (L-rt1). */
  reason: string | null;
}

/**
 * Latest pipeline errors and persistence failures with their reasons — the
 * counts alone say "something broke"; this says WHAT broke, without shelling
 * into the database.
 */
export async function recentErrors(
  limit = 20,
  window?: Window,
  deps: QueryDeps = defaultDeps(),
): Promise<RecentErrorRow[]> {
  const rows = await deps.db.execute<{
    id: number;
    created_at: string;
    type: string;
    conversation_id: string | null;
    reason: string | null;
  }>(sql`
    SELECT
      id,
      to_char(created_at AT TIME ZONE 'UTC' AT TIME ZONE 'Europe/Stockholm',
              'YYYY-MM-DD HH24:MI') AS created_at,
      type,
      conversation_id,
      payload->>'reason' AS reason
    FROM ${analyticsEvents}
    WHERE type IN ('persistence_failure', 'pipeline_error')
      ${sinceClause(window)}
    ORDER BY id DESC
    LIMIT ${limit}
  `);
  return rows.map((r) => ({
    id: r.id,
    createdAt: r.created_at,
    type: r.type,
    conversationId: r.conversation_id,
    reason: r.reason,
  }));
}

// ─────────────────────────────────────────────────────────────────────────────
// Lake-resolution troubleshooting — failures with the resolver's actual input
// ─────────────────────────────────────────────────────────────────────────────

export interface ResolutionFailureRow {
  id: number;
  /** Stockholm wall-clock, "YYYY-MM-DD HH24:MI" (formatted in SQL). */
  createdAt: string;
  /** lake_clarify (still trying) | lake_unresolved_area (gave up). */
  type: string;
  conversationId: string | null;
  /** What the extractor heard (payload.lakeName / payload.askedLakeName). */
  lakeName: string | null;
  /** Resolver confidence 0–100 at this round; null on pre-capture rows. */
  confidence: number | null;
  /** Round number (payload.attempt / payload.attempts). */
  attempt: number | null;
  /** Terminal reason, only on lake_unresolved_area. */
  reason: string | null;
  /** Up to 5 "Name (Municipality)" strings Haiku chose from. */
  candidates: string[];
  candidateCount: number | null;
  /** The user prompt that round; null on pre-capture rows. */
  prompt: string | null;
}

/**
 * Latest clarify rounds + terminal unresolved outcomes, with the candidate
 * list the resolver saw.  This is the "why can't lake X be resolved?" feed:
 * a wrong candidate list points at candidateLakes (SQL/data), a good list
 * with low confidence points at the Haiku prompt.
 */
export async function recentResolutionFailures(
  limit = 20,
  window?: Window,
  deps: QueryDeps = defaultDeps(),
): Promise<ResolutionFailureRow[]> {
  const rows = await deps.db.execute<{
    id: number;
    created_at: string;
    type: string;
    conversation_id: string | null;
    lake_name: string | null;
    confidence: number | null;
    attempt: number | null;
    reason: string | null;
    candidates_json: string | null;
    candidate_count: number | null;
    prompt: string | null;
  }>(sql`
    SELECT
      id,
      to_char(created_at AT TIME ZONE 'UTC' AT TIME ZONE 'Europe/Stockholm',
              'YYYY-MM-DD HH24:MI') AS created_at,
      type,
      conversation_id,
      coalesce(payload->>'lakeName', payload->>'askedLakeName') AS lake_name,
      (payload->>'confidence')::float                           AS confidence,
      coalesce(payload->>'attempt', payload->>'attempts')::int  AS attempt,
      payload->>'reason'                                        AS reason,
      payload->>'candidates'                                    AS candidates_json,
      (payload->>'candidateCount')::int                         AS candidate_count,
      payload->>'prompt'                                        AS prompt
    FROM ${analyticsEvents}
    WHERE type IN ('lake_clarify', 'lake_unresolved_area')
      ${sinceClause(window)}
    ORDER BY id DESC
    LIMIT ${limit}
  `);
  return rows.map((r) => ({
    id: r.id,
    createdAt: r.created_at,
    type: r.type,
    conversationId: r.conversation_id,
    lakeName: r.lake_name,
    confidence: r.confidence,
    attempt: r.attempt,
    reason: r.reason,
    candidates: parseCandidates(r.candidates_json),
    candidateCount: r.candidate_count,
    prompt: r.prompt,
  }));
}

/** payload.candidates is a jsonb string array; anything else maps to []. */
function parseCandidates(json: string | null): string[] {
  if (!json) return [];
  try {
    const parsed = JSON.parse(json);
    return Array.isArray(parsed)
      ? parsed.filter((c) => typeof c === "string")
      : [];
  } catch {
    return [];
  }
}

export interface UnresolvedLakeNameRow {
  /** The asked-for name that could not be resolved. */
  lakeName: string;
  failures: number;
}

/**
 * Asked-for lake names ranked by terminal resolution failures — the shopping
 * list for missing/mis-named lakes in the `lakes` table.  Rows without a
 * lakeName (user never named a lake) are excluded; those are area-mode by
 * design, not data gaps.
 */
export async function topUnresolvedLakeNames(
  limit = 20,
  window?: Window,
  deps: QueryDeps = defaultDeps(),
): Promise<UnresolvedLakeNameRow[]> {
  const rows = await deps.db.execute<{
    lake_name: string;
    failures: number;
  }>(sql`
    SELECT
      payload->>'askedLakeName' AS lake_name,
      count(*)::int             AS failures
    FROM ${analyticsEvents}
    WHERE type = 'lake_unresolved_area'
      AND payload->>'askedLakeName' IS NOT NULL
      ${sinceClause(window)}
    GROUP BY payload->>'askedLakeName'
    ORDER BY failures DESC, lake_name ASC
    LIMIT ${limit}
  `);
  return rows.map((r) => ({ lakeName: r.lake_name, failures: r.failures }));
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
  /** Troubleshooting feeds — newest first. */
  recentRefusals: RecentRefusalRow[];
  recentErrors: RecentErrorRow[];
  /** Lake-resolution troubleshooting. */
  resolutionFailures: ResolutionFailureRow[];
  topUnresolvedNames: UnresolvedLakeNameRow[];
  byType: EventCount[];
  /** Token cost rollup (llm_usage). */
  llmCost: LlmCostSummary;
  /** Top accounts by LLM cost (premium-pricing input). */
  costPerUser: UserCostRow[];
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
    recentRefusals,
    recentErrorRows,
    resolutionFailures,
    topUnresolvedNames,
    byType,
    llmCost,
    costPerUser,
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
    recentTopicRefusals(20, window, deps),
    recentErrors(20, window, deps),
    recentResolutionFailures(20, window, deps),
    topUnresolvedLakeNames(20, window, deps),
    eventCountsByType(window, deps),
    llmCostSummary(window, deps),
    llmCostPerUser(20, window, deps),
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
    recentRefusals,
    recentErrors: recentErrorRows,
    resolutionFailures,
    topUnresolvedNames,
    byType,
    llmCost,
    costPerUser,
  };
}
