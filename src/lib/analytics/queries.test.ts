import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
vi.mock("@/shared/db/client", () => ({ db: {} }));

import type { QueryDeps } from "./queries";
import {
  analyticsOverview,
  countByType,
  creditSpend,
  recentErrors,
  recentResolutionFailures,
  recentTopicRefusals,
  sourceMissBreakdown,
  topLakesAsked,
  topUnresolvedLakeNames,
  unresolvedLakeRate,
} from "./queries";

/**
 * Stub executor: returns queued result sets in call order.  We assert on the
 * shape/mapping the query functions produce, not on SQL text (that is the DB's
 * job and is covered by the integration path).
 */
function stubDb(results: unknown[][]): QueryDeps {
  const execute = vi.fn();
  for (const r of results) execute.mockResolvedValueOnce(r);
  return { db: { execute } as unknown as QueryDeps["db"] };
}

describe("topLakesAsked", () => {
  it("maps snake_case rows to camelCase, keeping null names", async () => {
    const deps = stubDb([
      [
        {
          lake_id: "SE123",
          name: null,
          municipality: "Berg",
          county: "Jämtland",
          resolved_count: 12,
        },
      ],
    ]);
    const out = await topLakesAsked(20, undefined, deps);
    expect(out).toEqual([
      {
        lakeId: "SE123",
        name: null,
        municipality: "Berg",
        county: "Jämtland",
        resolvedCount: 12,
      },
    ]);
  });
});

describe("unresolvedLakeRate", () => {
  it("computes the rate from resolved/unresolved counts", async () => {
    const deps = stubDb([[{ resolved: 3, unresolved: 1 }]]);
    const out = await unresolvedLakeRate(undefined, deps);
    expect(out).toEqual({ resolved: 3, unresolved: 1, unresolvedRate: 0.25 });
  });

  it("returns rate 0 (not NaN) when there is no traffic", async () => {
    const deps = stubDb([[{ resolved: 0, unresolved: 0 }]]);
    const out = await unresolvedLakeRate(undefined, deps);
    expect(out.unresolvedRate).toBe(0);
  });

  it("survives an empty result set", async () => {
    const deps = stubDb([[]]);
    const out = await unresolvedLakeRate(undefined, deps);
    expect(out).toEqual({ resolved: 0, unresolved: 0, unresolvedRate: 0 });
  });
});

describe("sourceMissBreakdown", () => {
  it("splits misses by reason", async () => {
    const deps = stubDb([
      [
        {
          source: "weather",
          misses: 5,
          error_count: 2,
          empty_count: 1,
          no_row_count: 2,
        },
      ],
    ]);
    const out = await sourceMissBreakdown(undefined, deps);
    expect(out).toEqual([
      {
        source: "weather",
        misses: 5,
        errorCount: 2,
        emptyCount: 1,
        noRowCount: 2,
      },
    ]);
  });
});

describe("creditSpend", () => {
  it("returns totals, defaulting to 0 on empty", async () => {
    const deps = stubDb([[]]);
    const out = await creditSpend(undefined, deps);
    expect(out).toEqual({ totalCredits: 0, distinctUsers: 0 });
  });
});

describe("countByType", () => {
  it("returns the scalar count", async () => {
    const deps = stubDb([[{ count: 7 }]]);
    expect(await countByType("topic_refused", undefined, deps)).toBe(7);
  });

  it("defaults to 0 when the row is missing", async () => {
    const deps = stubDb([[]]);
    expect(await countByType("topic_refused", undefined, deps)).toBe(0);
  });
});

describe("recentTopicRefusals", () => {
  it("maps rows, keeping null prompt for pre-capture events", async () => {
    const deps = stubDb([
      [
        {
          id: 42,
          created_at: "2026-07-06 12:30",
          conversation_id: "conv-1",
          prompt: "Skriv min läxa",
          user_id: "user-1",
        },
        {
          id: 41,
          created_at: "2026-07-05 09:00",
          conversation_id: null,
          prompt: null,
          user_id: null,
        },
      ],
    ]);
    const out = await recentTopicRefusals(20, undefined, deps);
    expect(out).toEqual([
      {
        id: 42,
        createdAt: "2026-07-06 12:30",
        conversationId: "conv-1",
        prompt: "Skriv min läxa",
        userId: "user-1",
      },
      {
        id: 41,
        createdAt: "2026-07-05 09:00",
        conversationId: null,
        prompt: null,
        userId: null,
      },
    ]);
  });
});

describe("recentErrors", () => {
  it("maps both error types with their reasons", async () => {
    const deps = stubDb([
      [
        {
          id: 7,
          created_at: "2026-07-06 12:00",
          type: "pipeline_error",
          conversation_id: null,
          reason: "boom",
        },
      ],
    ]);
    const out = await recentErrors(20, undefined, deps);
    expect(out).toEqual([
      {
        id: 7,
        createdAt: "2026-07-06 12:00",
        type: "pipeline_error",
        conversationId: null,
        reason: "boom",
      },
    ]);
  });
});

describe("recentResolutionFailures", () => {
  it("parses the candidates json array and coalesced fields", async () => {
    const deps = stubDb([
      [
        {
          id: 9,
          created_at: "2026-07-06 13:00",
          type: "lake_unresolved_area",
          conversation_id: "conv-9",
          lake_name: "Trollsjön",
          confidence: 20,
          attempt: 3,
          reason: "attempts_exhausted",
          candidates_json: '["Trollsjön (Kiruna)","Trollsjön (Åre)"]',
          candidate_count: 7,
          prompt: "abborre i trollsjön",
        },
      ],
    ]);
    const out = await recentResolutionFailures(20, undefined, deps);
    expect(out).toEqual([
      {
        id: 9,
        createdAt: "2026-07-06 13:00",
        type: "lake_unresolved_area",
        conversationId: "conv-9",
        lakeName: "Trollsjön",
        confidence: 20,
        attempt: 3,
        reason: "attempts_exhausted",
        candidates: ["Trollsjön (Kiruna)", "Trollsjön (Åre)"],
        candidateCount: 7,
        prompt: "abborre i trollsjön",
      },
    ]);
  });

  it("maps null/malformed candidates json to an empty list", async () => {
    const deps = stubDb([
      [
        {
          id: 8,
          created_at: "2026-07-05 08:00",
          type: "lake_clarify",
          conversation_id: null,
          lake_name: null,
          confidence: null,
          attempt: null,
          reason: null,
          candidates_json: "not json",
          candidate_count: null,
          prompt: null,
        },
      ],
    ]);
    const out = await recentResolutionFailures(20, undefined, deps);
    expect(out[0]?.candidates).toEqual([]);
  });
});

describe("topUnresolvedLakeNames", () => {
  it("maps name/failure rows", async () => {
    const deps = stubDb([[{ lake_name: "Trollsjön", failures: 4 }]]);
    const out = await topUnresolvedLakeNames(20, undefined, deps);
    expect(out).toEqual([{ lakeName: "Trollsjön", failures: 4 }]);
  });
});

describe("analyticsOverview", () => {
  it("assembles every tile from the fan-out reads", async () => {
    // The queries fan out via Promise.all — queue a result per execute() in
    // invocation order (llmCostSummary issues two executes itself).
    const deps = stubDb([
      [], // topLakesAsked
      [{ resolved: 10, unresolved: 2 }], // unresolvedLakeRate
      [], // sourceMissBreakdown
      [{ total_credits: 4, distinct_users: 3 }], // creditSpend
      [{ count: 1 }], // topic_refused
      [{ count: 2 }], // chat_limit_hit
      [{ count: 3 }], // register_gate
      [{ count: 4 }], // lake_lock
      [{ count: 5 }], // out_of_credits
      [{ count: 6 }], // persistence_failure
      [
        {
          id: 1,
          created_at: "2026-07-06 12:30",
          conversation_id: null,
          prompt: "Skriv min läxa",
          user_id: null,
        },
      ], // recentTopicRefusals
      [], // recentErrors
      [], // recentResolutionFailures
      [{ lake_name: "Trollsjön", failures: 4 }], // topUnresolvedLakeNames
      [{ type: "lake_resolved", count: 10 }], // eventCountsByType
      [{ total_cost: 0.5, calls: 10, unpriced: 0, conversations: 4 }], // llmCostSummary totals
      [{ kind: "advise", model: "claude-sonnet-4-6", calls: 4, cost_usd: 0.4 }], // llmCostSummary byKind
      [{ user_id: "user-1", conversations: 4, cost_usd: 0.5 }], // llmCostPerUser
    ]);

    const out = await analyticsOverview(
      { since: new Date("2026-06-01") },
      deps,
    );

    expect(out.window.since).toBe(new Date("2026-06-01").toISOString());
    expect(out.resolution.resolved).toBe(10);
    expect(out.credits).toEqual({ totalCredits: 4, distinctUsers: 3 });
    expect(out.topicRefusals).toBe(1);
    expect(out.chatLimitHits).toBe(2);
    expect(out.registerGates).toBe(3);
    expect(out.lakeLocks).toBe(4);
    expect(out.outOfCredits).toBe(5);
    expect(out.persistenceFailures).toBe(6);
    expect(out.recentRefusals).toHaveLength(1);
    expect(out.recentRefusals[0]?.prompt).toBe("Skriv min läxa");
    expect(out.recentErrors).toEqual([]);
    expect(out.resolutionFailures).toEqual([]);
    expect(out.topUnresolvedNames).toEqual([
      { lakeName: "Trollsjön", failures: 4 },
    ]);
    expect(out.byType).toEqual([{ type: "lake_resolved", count: 10 }]);
    expect(out.llmCost).toEqual({
      totalCostUsd: 0.5,
      calls: 10,
      unpricedCalls: 0,
      conversations: 4,
      avgCostPerConversationUsd: 0.125,
      byKind: [
        { kind: "advise", model: "claude-sonnet-4-6", calls: 4, costUsd: 0.4 },
      ],
    });
    expect(out.costPerUser).toEqual([
      { userId: "user-1", conversations: 4, costUsd: 0.5 },
    ]);
  });
});
