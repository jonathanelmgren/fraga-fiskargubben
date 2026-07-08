/**
 * ask-handler.test.ts — unit tests for the POST /api/ask orchestration logic.
 *
 * These tests exercise the branching (gate ordering + resolution lifecycle)
 * of `handleAsk` without a real server, DB, or Claude API. All leaf modules
 * are injected as mocks.
 *
 * Rebuild coverage:
 *  - anon gate blocks only NEW conversations; anon follow-ups allowed
 *  - chat-turn limit / frozen (+ admin bypass)
 *  - loosened topic gate passthrough
 *  - resolution lifecycle: confident → resolved; low confidence → clarify
 *    (attempts bump, no credit); 3 strikes / noSuchLake → unresolved_area
 *  - credit spent EXACTLY once, at the transition (not for clarify rounds,
 *    not for anon, not for admins)
 *  - area coords fallback: user location → candidate centroid → none
 *  - follow-ups on resolved (lake-lock) and unresolved_area (no lock)
 *  - IDOR ownership binding unchanged
 */

import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
vi.mock("@/shared/db/client", () => ({ db: {} }));

import { ortClarifyMessage } from "@/lib/chat/gate-messages";
import { CHAT_LIMIT_MESSAGE } from "@/lib/chat/quota";
import type { CandidateLake } from "@/lib/lakes/candidates";
import type { Signals } from "@/lib/signals/types";
import {
  type AskHandlerDeps,
  type AskResult,
  areaLabel,
  type ConversationRow,
  centroidOf,
  handleAsk,
  PAID_ANNUAL_COST_BUDGET_USD,
  toBadges,
} from "./ask-handler";

// ---------------------------------------------------------------------------
// Helpers + fixtures
// ---------------------------------------------------------------------------

function asType<T extends AskResult["type"]>(
  result: AskResult,
  type: T,
): Extract<AskResult, { type: T }> {
  if (result.type !== type) {
    throw new Error(`Expected result.type="${type}", got "${result.type}"`);
  }
  return result as Extract<AskResult, { type: T }>;
}

const BASE_SIGNALS: Signals = {
  lake: "Tolken (Borås, Västra Götaland)",
  lakeId: "tolken-1",
  bareLakeName: "Tolken",
  timeLocal: "2026-06-29T10:00:00",
  airTempC: {
    value: 17,
    provenance: { source: "forecast", confidence: "high" },
  },
  windMs: {
    value: 4.2,
    provenance: { source: "forecast", confidence: "high" },
  },
};

const TOLKEN: CandidateLake = {
  id: "tolken-1",
  name: "Tolken",
  municipality: "Borås",
  county: "Västra Götaland",
  lat: 57.7,
  lon: 13.0,
  areaHa: 1200,
};

const ASUNDEN: CandidateLake = {
  id: "asunden-1",
  name: "Åsunden",
  municipality: "Borås",
  county: "Västra Götaland",
  lat: 57.71,
  lon: 13.4,
  areaHa: 3300,
};

function resolvedConversation(
  overrides: Partial<ConversationRow> = {},
): ConversationRow {
  return {
    id: "conv-1",
    userId: "user-1",
    claimToken: null,
    frozen: false,
    status: "resolved",
    resolveAttempts: 0,
    userLat: null,
    userLon: null,
    signalsSnapshot: BASE_SIGNALS,
    lakeId: "tolken-1",
    bareLakeName: "Tolken",
    pendingLakeName: null,
    ...overrides,
  };
}

function pendingConversation(
  overrides: Partial<ConversationRow> = {},
): ConversationRow {
  return {
    id: "conv-pending",
    userId: "user-1",
    claimToken: null,
    frozen: false,
    status: "lake_pending",
    resolveAttempts: 0,
    userLat: null,
    userLon: null,
    signalsSnapshot: null,
    lakeId: null,
    bareLakeName: null,
    pendingLakeName: null,
    ...overrides,
  };
}

function makeStream() {
  return {
    toReadableStream: vi.fn().mockReturnValue(new ReadableStream()),
    finalMessage: vi.fn().mockResolvedValue({
      content: [{ type: "text", text: "Prova maskkroken." }],
    }),
  };
}

function confidentResolution(lakeId = "tolken-1") {
  return {
    lakeId,
    confidence: 90,
    noSuchLake: false,
    clarifyQuestion: "Vilken sjö menar du?",
  };
}

function unsureResolution() {
  return {
    lakeId: null,
    confidence: 30,
    noSuchLake: false,
    clarifyQuestion: "Vilken kommun ligger sjön i?",
  };
}

function makeDeps(overrides: Partial<AskHandlerDeps> = {}): AskHandlerDeps {
  return {
    getSession: vi.fn().mockResolvedValue(null),
    getConversation: vi.fn().mockResolvedValue(null),
    countUserMessages: vi.fn().mockResolvedValue(0),
    getHistoryMessages: vi.fn().mockResolvedValue([]),
    getUserRow: vi.fn().mockResolvedValue({ isPaid: false, creditsUsed: 0 }),
    extract: vi.fn().mockResolvedValue({ onTopic: true, lakeName: "Tolken" }),
    candidateLakes: vi.fn().mockResolvedValue([TOLKEN]),
    resolveLakeWithHaiku: vi.fn().mockResolvedValue(confidentResolution()),
    buildSignals: vi.fn().mockResolvedValue(BASE_SIGNALS),
    buildAreaSignals: vi.fn().mockResolvedValue({
      lake: "trakten kring Borås",
      lakeId: "area",
      areaOnly: true,
      timeLocal: "2026-06-29T10:00:00",
    } satisfies Signals),
    adviseFirst: vi.fn().mockReturnValue(makeStream()),
    adviseFollowup: vi.fn().mockReturnValue(makeStream()),
    isLakeLockViolation: vi.fn().mockReturnValue(false),
    getLakeLockRedirect: vi.fn().mockReturnValue("lake-lock redirect"),
    canSpendCredit: vi.fn().mockReturnValue(true),
    spendCredit: vi.fn().mockResolvedValue(true),
    chatTurnAllowed: vi.fn().mockReturnValue(true),
    freezeConversation: vi.fn().mockResolvedValue(undefined),
    createPendingConversation: vi.fn().mockResolvedValue("new-conv-id"),
    transitionConversation: vi.fn().mockResolvedValue(undefined),
    recordClarifyRound: vi.fn().mockResolvedValue(undefined),
    emit: vi.fn().mockResolvedValue(undefined),
    now: new Date("2026-06-29T10:00:00Z"),
    ...overrides,
  };
}

function loggedIn(id = "user-1", isAdmin = false) {
  return vi.fn().mockResolvedValue({ user: { id, isAdmin } });
}

// ---------------------------------------------------------------------------
// 1. Anon gate — blocks new conversations only
// ---------------------------------------------------------------------------

describe("anon quota gate", () => {
  it("blocks a NEW conversation when the anon already has a claim token", async () => {
    const deps = makeDeps();
    const result = await handleAsk(
      { message: "Vad biter?", claimToken: "token-xyz" },
      deps,
    );
    expect(result.type).toBe("register_to_continue");
    expect(deps.extract).not.toHaveBeenCalled();
    expect(deps.createPendingConversation).not.toHaveBeenCalled();
  });

  it("ALLOWS an anon follow-up on their own conversation (clarify loop needs it)", async () => {
    const deps = makeDeps({
      getConversation: vi
        .fn()
        .mockResolvedValue(
          resolvedConversation({ userId: null, claimToken: "token-abc" }),
        ),
      countUserMessages: vi.fn().mockResolvedValue(1),
    });
    const result = await handleAsk(
      {
        message: "Vilket djup?",
        conversationId: "conv-1",
        claimToken: "token-abc",
      },
      deps,
    );
    expect(result.type).toBe("stream");
    expect(deps.adviseFollowup).toHaveBeenCalledOnce();
  });
});

// ---------------------------------------------------------------------------
// 2. Chat-turn limit / frozen — with admin bypass
// ---------------------------------------------------------------------------

describe("chat-turn limit", () => {
  it("freezes conversation and returns CHAT_LIMIT_MESSAGE without calling Claude", async () => {
    const deps = makeDeps({
      getSession: loggedIn(),
      getConversation: vi.fn().mockResolvedValue(resolvedConversation()),
      countUserMessages: vi.fn().mockResolvedValue(20),
      chatTurnAllowed: vi.fn().mockReturnValue(false),
    });
    const result = await handleAsk(
      { message: "Ännu ett meddelande", conversationId: "conv-1" },
      deps,
    );
    const r = asType(result, "chat_limit");
    expect(r.text).toBe(CHAT_LIMIT_MESSAGE);
    expect(deps.freezeConversation).toHaveBeenCalledWith("conv-1");
    expect(deps.extract).not.toHaveBeenCalled();
  });

  it("passes isAdmin to chatTurnAllowed so admins bypass the limit (no user-row fetch)", async () => {
    const deps = makeDeps({
      getSession: loggedIn("admin-1", true),
      getConversation: vi
        .fn()
        .mockResolvedValue(resolvedConversation({ userId: "admin-1" })),
      countUserMessages: vi.fn().mockResolvedValue(25),
    });
    await handleAsk({ message: "Mer?", conversationId: "conv-1" }, deps);
    expect(deps.chatTurnAllowed).toHaveBeenCalledWith(25, {
      isAdmin: true,
      isPaid: false,
    });
    expect(deps.getUserRow).not.toHaveBeenCalled();
  });

  it("passes isPaid to chatTurnAllowed so paid users bypass the limit", async () => {
    const deps = makeDeps({
      getSession: loggedIn(),
      getConversation: vi.fn().mockResolvedValue(resolvedConversation()),
      countUserMessages: vi.fn().mockResolvedValue(25),
      getUserRow: vi.fn().mockResolvedValue({ isPaid: true, creditsUsed: 99 }),
    });
    await handleAsk({ message: "Mer?", conversationId: "conv-1" }, deps);
    expect(deps.chatTurnAllowed).toHaveBeenCalledWith(25, {
      isAdmin: false,
      isPaid: true,
    });
  });

  it("anon follow-ups are checked as free tier (isPaid: false)", async () => {
    const deps = makeDeps({
      getConversation: vi
        .fn()
        .mockResolvedValue(
          resolvedConversation({ userId: null, claimToken: "token-abc" }),
        ),
      countUserMessages: vi.fn().mockResolvedValue(2),
    });
    await handleAsk(
      { message: "Mer?", conversationId: "conv-1", claimToken: "token-abc" },
      deps,
    );
    expect(deps.chatTurnAllowed).toHaveBeenCalledWith(2, {
      isAdmin: false,
      isPaid: false,
    });
    expect(deps.getUserRow).not.toHaveBeenCalled();
  });

  it("returns CHAT_LIMIT_MESSAGE immediately when already frozen", async () => {
    const deps = makeDeps({
      getSession: loggedIn(),
      getConversation: vi
        .fn()
        .mockResolvedValue(resolvedConversation({ frozen: true })),
    });
    const result = await handleAsk(
      { message: "Hej igen", conversationId: "conv-1" },
      deps,
    );
    expect(result.type).toBe("chat_limit");
    expect(deps.freezeConversation).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// 2b. Paid fair-use gate — new conversations only
// ---------------------------------------------------------------------------

describe("paid fair-use gate", () => {
  it("blocks a NEW conversation once the paid user hits the window cap", async () => {
    const deps = makeDeps({
      getSession: loggedIn(),
      getUserRow: vi.fn().mockResolvedValue({ isPaid: true, creditsUsed: 0 }),
      countRecentConversationsByUser: vi.fn().mockResolvedValue(20),
    });
    const result = await handleAsk({ message: "Vad biter i Tolken?" }, deps);
    expect(result.type).toBe("rate_limited");
    expect(deps.createPendingConversation).not.toHaveBeenCalled();
    expect(deps.emit).toHaveBeenCalledWith(
      expect.objectContaining({ type: "fair_use_limit" }),
    );
  });

  it("allows a paid user under the cap", async () => {
    const deps = makeDeps({
      getSession: loggedIn(),
      getUserRow: vi.fn().mockResolvedValue({ isPaid: true, creditsUsed: 0 }),
      countRecentConversationsByUser: vi.fn().mockResolvedValue(19),
    });
    const result = await handleAsk({ message: "Vad biter i Tolken?" }, deps);
    expect(result.type).toBe("stream");
  });

  it("does not apply to free users (they are credit-capped instead)", async () => {
    const deps = makeDeps({
      getSession: loggedIn(),
      countRecentConversationsByUser: vi.fn().mockResolvedValue(999),
    });
    const result = await handleAsk({ message: "Vad biter i Tolken?" }, deps);
    expect(result.type).toBe("stream");
    expect(deps.countRecentConversationsByUser).not.toHaveBeenCalled();
  });

  it("blocks a paid user whose tracked LLM cost exceeds the annual budget", async () => {
    const deps = makeDeps({
      getSession: loggedIn(),
      getUserRow: vi.fn().mockResolvedValue({ isPaid: true, creditsUsed: 0 }),
      getRecentLlmCostUsdByUser: vi
        .fn()
        .mockResolvedValue(PAID_ANNUAL_COST_BUDGET_USD + 0.01),
    });
    const result = await handleAsk({ message: "Vad biter i Tolken?" }, deps);
    const r = asType(result, "rate_limited");
    expect(r.text).toContain("användningstaket");
    expect(deps.createPendingConversation).not.toHaveBeenCalled();
    expect(deps.emit).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "fair_use_limit",
        payload: expect.objectContaining({ reason: "cost_budget" }),
      }),
    );
  });

  it("allows a paid user under the cost budget", async () => {
    const deps = makeDeps({
      getSession: loggedIn(),
      getUserRow: vi.fn().mockResolvedValue({ isPaid: true, creditsUsed: 0 }),
      getRecentLlmCostUsdByUser: vi
        .fn()
        .mockResolvedValue(PAID_ANNUAL_COST_BUDGET_USD - 0.5),
    });
    const result = await handleAsk({ message: "Vad biter i Tolken?" }, deps);
    expect(result.type).toBe("stream");
  });
});

// ---------------------------------------------------------------------------
// 3. Topic gate
// ---------------------------------------------------------------------------

describe("topic gate", () => {
  it("off-topic → topic_refused, no credit, no Sonnet, no conversation row", async () => {
    const deps = makeDeps({
      getSession: loggedIn(),
      extract: vi.fn().mockResolvedValue({
        onTopic: false,
        refusal: "Sånt kan jag inget om, hörru.",
      }),
    });
    const result = await handleAsk({ message: "Skriv min läxa" }, deps);
    const r = asType(result, "topic_refused");
    expect(r.text).toContain("hörru");
    expect(deps.spendCredit).not.toHaveBeenCalled();
    expect(deps.createPendingConversation).not.toHaveBeenCalled();
    expect(deps.adviseFirst).not.toHaveBeenCalled();
  });

  it("captures the refused prompt (and userId) in the event payload", async () => {
    const deps = makeDeps({
      getSession: loggedIn(),
      extract: vi.fn().mockResolvedValue({ onTopic: false }),
    });
    await handleAsk({ message: "Skriv min läxa" }, deps);
    expect(deps.emit).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "topic_refused",
        payload: expect.objectContaining({
          prompt: "Skriv min läxa",
          userId: "user-1",
        }),
      }),
    );
  });
});

// ---------------------------------------------------------------------------
// 4. New conversation — confident resolution → resolved + stream
// ---------------------------------------------------------------------------

describe("new conversation, confident resolution", () => {
  it("creates pending row, resolves, charges once, transitions, streams Sonnet", async () => {
    const deps = makeDeps({ getSession: loggedIn() });
    const result = await handleAsk(
      { message: "Vad biter i Tolken imorgon?" },
      deps,
    );

    const r = asType(result, "stream");
    expect(r.conversationId).toBe("new-conv-id");
    expect(r.refundUserId).toBe("user-1");
    expect(r.badges?.lake).toBe(BASE_SIGNALS.bareLakeName);
    expect(r.badges?.status).toBe("resolved");

    expect(deps.createPendingConversation).toHaveBeenCalledOnce();
    expect(deps.candidateLakes).toHaveBeenCalledWith("Tolken", undefined);
    expect(deps.buildSignals).toHaveBeenCalledOnce();
    expect(deps.spendCredit).toHaveBeenCalledExactlyOnceWith("user-1");
    expect(deps.transitionConversation).toHaveBeenCalledWith(
      expect.objectContaining({
        id: "new-conv-id",
        status: "resolved",
        lakeId: "tolken-1",
        signalsSnapshot: BASE_SIGNALS,
      }),
    );
    expect(deps.adviseFirst).toHaveBeenCalledOnce();
    expect(deps.emit).toHaveBeenCalledWith(
      expect.objectContaining({ type: "lake_resolved" }),
    );
  });

  it("builds signals with the formatted label", async () => {
    const deps = makeDeps({ getSession: loggedIn() });
    await handleAsk({ message: "Vad biter i Tolken?" }, deps);
    // biome-ignore lint/suspicious/noExplicitAny: vi.Mock internals
    const [signalsInput] = (deps.buildSignals as any).mock.calls[0];
    expect(signalsInput.lake.label).toBe("Tolken (Borås, Västra Götaland)");
  });

  it("stores browser location on the pending row and passes it to candidates + resolver", async () => {
    const deps = makeDeps({ getSession: loggedIn() });
    const loc = { lat: 57.79, lon: 13.42 };
    await handleAsk({ message: "Vad biter i Åsunden?", location: loc }, deps);
    expect(deps.createPendingConversation).toHaveBeenCalledWith(
      expect.objectContaining({ userLat: 57.79, userLon: 13.42 }),
    );
    expect(deps.candidateLakes).toHaveBeenCalledWith("Tolken", loc);
    expect(deps.resolveLakeWithHaiku).toHaveBeenCalledWith(
      expect.objectContaining({ userLoc: loc }),
    );
  });

  it("returns claimToken for a new anon conversation and spends NO credit", async () => {
    const deps = makeDeps();
    const result = await handleAsk({ message: "Vad biter i Tolken?" }, deps);
    const r = asType(result, "stream");
    expect(r.claimToken).toBeDefined();
    expect(deps.createPendingConversation).toHaveBeenCalledWith(
      expect.objectContaining({ claimToken: r.claimToken }),
    );
    expect(deps.spendCredit).not.toHaveBeenCalled();
    expect(r.refundUserId).toBeUndefined();
  });

  it("admin: streams without spending a credit", async () => {
    const deps = makeDeps({ getSession: loggedIn("admin-1", true) });
    const result = await handleAsk({ message: "Vad biter i Tolken?" }, deps);
    const r = asType(result, "stream");
    expect(deps.spendCredit).not.toHaveBeenCalled();
    expect(deps.getUserRow).not.toHaveBeenCalled();
    expect(r.refundUserId).toBeUndefined();
  });

  it("treats a raced-out spendCredit=false as out_of_credits (no stream)", async () => {
    const deps = makeDeps({
      getSession: loggedIn(),
      spendCredit: vi.fn().mockResolvedValue(false),
    });
    const result = await handleAsk({ message: "Vad biter i Tolken?" }, deps);
    expect(result.type).toBe("out_of_credits");
    expect(deps.adviseFirst).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// 5. Out-of-credits pre-check before any resolution work
// ---------------------------------------------------------------------------

describe("out-of-credits pre-check", () => {
  it("blocks a new conversation before creating rows or calling the resolver", async () => {
    const deps = makeDeps({
      getSession: loggedIn(),
      getUserRow: vi.fn().mockResolvedValue({ isPaid: false, creditsUsed: 3 }),
      canSpendCredit: vi.fn().mockReturnValue(false),
    });
    const result = await handleAsk({ message: "Vad biter i Tolken?" }, deps);
    expect(result.type).toBe("out_of_credits");
    expect(deps.createPendingConversation).not.toHaveBeenCalled();
    expect(deps.resolveLakeWithHaiku).not.toHaveBeenCalled();
    expect(deps.spendCredit).not.toHaveBeenCalled();
  });

  it("admin skips the pre-check entirely", async () => {
    const deps = makeDeps({
      getSession: loggedIn("admin-1", true),
      canSpendCredit: vi.fn().mockReturnValue(false),
    });
    const result = await handleAsk({ message: "Vad biter i Tolken?" }, deps);
    expect(result.type).toBe("stream");
    expect(deps.canSpendCredit).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// 6. Clarify rounds — free, attempts bump
// ---------------------------------------------------------------------------

describe("clarify rounds", () => {
  it("low confidence → clarify result, attempts++, NO credit, NO Sonnet", async () => {
    const deps = makeDeps({
      getSession: loggedIn(),
      candidateLakes: vi.fn().mockResolvedValue([TOLKEN, ASUNDEN]),
      resolveLakeWithHaiku: vi.fn().mockResolvedValue(unsureResolution()),
    });
    const result = await handleAsk({ message: "Vad biter i sjön?" }, deps);

    const r = asType(result, "clarify");
    expect(r.text).toBe("Vilken kommun ligger sjön i?");
    expect(r.conversationId).toBe("new-conv-id");
    expect(deps.recordClarifyRound).toHaveBeenCalledWith("new-conv-id", {
      attempts: 1,
      pendingLakeName: "Tolken",
    });
    expect(deps.spendCredit).not.toHaveBeenCalled();
    expect(deps.adviseFirst).not.toHaveBeenCalled();
    expect(deps.transitionConversation).not.toHaveBeenCalled();
    expect(deps.emit).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "lake_clarify",
        payload: expect.objectContaining({
          prompt: "Vad biter i sjön?",
          candidateCount: 2,
          candidates: ["Tolken (Borås)", "Åsunden (Borås)"],
          clarifyQuestion: "Vilken kommun ligger sjön i?",
        }),
      }),
    );
  });

  it("clarify for a new anon conversation carries the claimToken", async () => {
    const deps = makeDeps({
      resolveLakeWithHaiku: vi.fn().mockResolvedValue(unsureResolution()),
    });
    const result = await handleAsk({ message: "Vad biter?" }, deps);
    const r = asType(result, "clarify");
    expect(r.claimToken).toBeDefined();
  });

  it("a pending follow-up resolves confidently → transition + stream", async () => {
    const deps = makeDeps({
      getSession: loggedIn(),
      getConversation: vi
        .fn()
        .mockResolvedValue(pendingConversation({ resolveAttempts: 1 })),
      extract: vi.fn().mockResolvedValue({
        onTopic: true,
        lakeName: "Åsunden",
        municipality: "Ulricehamn",
      }),
      candidateLakes: vi.fn().mockResolvedValue([ASUNDEN]),
      resolveLakeWithHaiku: vi
        .fn()
        .mockResolvedValue(confidentResolution("asunden-1")),
    });
    const result = await handleAsk(
      { message: "Åsunden i Ulricehamn", conversationId: "conv-pending" },
      deps,
    );
    const r = asType(result, "stream");
    expect(r.conversationId).toBe("conv-pending");
    expect(deps.createPendingConversation).not.toHaveBeenCalled();
    expect(deps.transitionConversation).toHaveBeenCalledWith(
      expect.objectContaining({ id: "conv-pending", lakeId: "asunden-1" }),
    );
    expect(deps.spendCredit).toHaveBeenCalledExactlyOnceWith("user-1");
  });
});

describe("pivot strike-reset (pending phase)", () => {
  it("resets strikes when the clarify target pivots to a new lake", async () => {
    const deps = makeDeps({
      getSession: loggedIn(),
      getConversation: vi.fn().mockResolvedValue(
        pendingConversation({
          resolveAttempts: 2,
          pendingLakeName: "Puttern",
        }),
      ),
      countUserMessages: vi.fn().mockResolvedValue(2),
      extract: vi
        .fn()
        .mockResolvedValue({ onTopic: true, lakeName: "Hjälmaren" }),
      resolveLakeWithHaiku: vi.fn().mockResolvedValue(unsureResolution()),
    });
    const result = await handleAsk(
      { message: "Hjälmaren då?", conversationId: "conv-pending" },
      deps,
    );
    // 2 strikes on Puttern + this unsure round would have exhausted the
    // attempts — the pivot to Hjälmaren resets them, so this stays a free
    // clarify round instead of an unresolved_area transition.
    expect(result.type).toBe("clarify");
    expect(deps.transitionConversation).not.toHaveBeenCalled();
    expect(deps.spendCredit).not.toHaveBeenCalled();
    expect(deps.recordClarifyRound).toHaveBeenCalledWith("conv-pending", {
      attempts: 1,
      pendingLakeName: "Hjälmaren",
    });
  });

  it("keeps counting strikes when the same lake stays the target", async () => {
    const deps = makeDeps({
      getSession: loggedIn(),
      getConversation: vi.fn().mockResolvedValue(
        pendingConversation({
          resolveAttempts: 2,
          pendingLakeName: "Tolken",
        }),
      ),
      countUserMessages: vi.fn().mockResolvedValue(2),
      extract: vi.fn().mockResolvedValue({ onTopic: true, lakeName: "Tolken" }),
      resolveLakeWithHaiku: vi.fn().mockResolvedValue(unsureResolution()),
    });
    const result = await handleAsk(
      { message: "Tolken sa jag", conversationId: "conv-pending" },
      deps,
    );
    // Third strike on the SAME target → unresolved_area transition as before.
    expect(result.type).toBe("stream");
    expect(deps.transitionConversation).toHaveBeenCalledWith(
      expect.objectContaining({ status: "unresolved_area" }),
    );
  });
});

// ---------------------------------------------------------------------------
// 7. Unresolved-area transitions
// ---------------------------------------------------------------------------

describe("unresolved_area transitions", () => {
  it("third failed attempt → area mode with candidate-centroid coords", async () => {
    const deps = makeDeps({
      getSession: loggedIn(),
      getConversation: vi.fn().mockResolvedValue(
        pendingConversation({
          resolveAttempts: 2,
          pendingLakeName: "Gösputten",
        }),
      ),
      extract: vi.fn().mockResolvedValue({
        onTopic: true,
        lakeName: "Gösputten",
        municipality: "Ulricehamn",
      }),
      candidateLakes: vi.fn().mockResolvedValue([TOLKEN, ASUNDEN]),
      resolveLakeWithHaiku: vi.fn().mockResolvedValue(unsureResolution()),
    });
    const result = await handleAsk(
      { message: "Gösputten alltså", conversationId: "conv-pending" },
      deps,
    );

    const r = asType(result, "stream");
    expect(r.badges?.status).toBe("unresolved_area");
    const centroid = centroidOf([TOLKEN, ASUNDEN]);
    expect(deps.buildAreaSignals).toHaveBeenCalledWith(
      expect.objectContaining({
        label: "trakten kring Ulricehamn",
        lat: centroid?.lat,
        lon: centroid?.lon,
        askedLakeName: "Gösputten",
      }),
    );
    expect(deps.transitionConversation).toHaveBeenCalledWith(
      expect.objectContaining({
        id: "conv-pending",
        status: "unresolved_area",
        lakeId: null,
      }),
    );
    expect(deps.spendCredit).toHaveBeenCalledExactlyOnceWith("user-1");
    expect(deps.adviseFirst).toHaveBeenCalledOnce();
    expect(deps.emit).toHaveBeenCalledWith(
      expect.objectContaining({ type: "lake_unresolved_area" }),
    );
  });

  it("confident noSuchLake → area mode immediately (no 3 strikes needed)", async () => {
    const deps = makeDeps({
      getSession: loggedIn(),
      extract: vi
        .fn()
        .mockResolvedValue({ onTopic: true, lakeName: "Atlantis" }),
      candidateLakes: vi.fn().mockResolvedValue([]),
      resolveLakeWithHaiku: vi.fn().mockResolvedValue({
        lakeId: null,
        confidence: 95,
        noSuchLake: true,
        clarifyQuestion: "?",
      }),
    });
    const result = await handleAsk({ message: "Fiska i Atlantis?" }, deps);
    const r = asType(result, "stream");
    expect(r.badges?.status).toBe("unresolved_area");
    expect(deps.recordClarifyRound).not.toHaveBeenCalled();
  });

  it("named river (waterKind älv) → area mode WITHOUT lake resolution", async () => {
    // Rivers are not in the lake register — running candidate SQL + Haiku
    // resolver against it wastes a call and risks a false lake match.
    const deps = makeDeps({
      getSession: loggedIn(),
      extract: vi.fn().mockResolvedValue({
        onTopic: true,
        lakeName: "Fjällsjöälven",
        waterKind: "älv",
        municipality: "Strömsund",
      }),
    });
    const result = await handleAsk(
      {
        message: "Ska fiska i Fjällsjöälven",
        location: { lat: 64.1, lon: 15.9 },
      },
      deps,
    );

    const r = asType(result, "stream");
    expect(r.badges?.status).toBe("unresolved_area");
    expect(deps.candidateLakes).not.toHaveBeenCalled();
    expect(deps.resolveLakeWithHaiku).not.toHaveBeenCalled();
    expect(deps.buildAreaSignals).toHaveBeenCalledWith(
      expect.objectContaining({
        askedLakeName: "Fjällsjöälven",
        askedWaterKind: "älv",
        lat: 64.1,
        lon: 15.9,
      }),
    );
    expect(deps.emit).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "lake_unresolved_area",
        payload: expect.objectContaining({
          reason: "non_lake_water",
          waterKind: "älv",
        }),
      }),
    );
  });

  it("named town/coast (waterKind ort) already set as pendingLakeName → area mode (non_lake_water)", async () => {
    // First message with an ort now gets a free clarify round (isPivot=true).
    // The non_lake_water / area transition fires only when the user INSISTS on
    // the same ort (isPivot=false — pendingLakeName already matches).
    const deps = makeDeps({
      getSession: loggedIn(),
      getConversation: vi.fn().mockResolvedValue(
        pendingConversation({
          resolveAttempts: 1,
          pendingLakeName: "Kalmar",
          userLat: 56.66,
          userLon: 16.36,
        }),
      ),
      countUserMessages: vi.fn().mockResolvedValue(1),
      extract: vi.fn().mockResolvedValue({
        onTopic: true,
        lakeName: "Kalmar",
        waterKind: "ort",
      }),
    });
    const result = await handleAsk(
      {
        message: "Kalmar sa jag",
        conversationId: "conv-pending",
      },
      deps,
    );

    const r = asType(result, "stream");
    expect(r.badges?.status).toBe("unresolved_area");
    expect(deps.resolveLakeWithHaiku).not.toHaveBeenCalled();
    expect(deps.buildAreaSignals).toHaveBeenCalledWith(
      expect.objectContaining({ askedWaterKind: "ort" }),
    );
    expect(deps.emit).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "lake_unresolved_area",
        payload: expect.objectContaining({ reason: "non_lake_water" }),
      }),
    );
  });

  it("waterKind sjö goes through the normal resolution path", async () => {
    const deps = makeDeps({
      getSession: loggedIn(),
      extract: vi.fn().mockResolvedValue({
        onTopic: true,
        lakeName: "Tolken",
        waterKind: "sjö",
      }),
    });
    const result = await handleAsk({ message: "Fiska i Tolken" }, deps);
    asType(result, "stream");
    expect(deps.candidateLakes).toHaveBeenCalledWith("Tolken", undefined);
    expect(deps.resolveLakeWithHaiku).toHaveBeenCalled();
  });

  it("prefers the user's browser location over the candidate centroid", async () => {
    const deps = makeDeps({
      getSession: loggedIn(),
      getConversation: vi.fn().mockResolvedValue(
        pendingConversation({
          resolveAttempts: 2,
          pendingLakeName: "Tolken",
          userLat: 57.79,
          userLon: 13.42,
        }),
      ),
      candidateLakes: vi.fn().mockResolvedValue([TOLKEN, ASUNDEN]),
      resolveLakeWithHaiku: vi.fn().mockResolvedValue(unsureResolution()),
    });
    await handleAsk(
      { message: "vet inte, den lilla sjön", conversationId: "conv-pending" },
      deps,
    );
    expect(deps.buildAreaSignals).toHaveBeenCalledWith(
      expect.objectContaining({ lat: 57.79, lon: 13.42 }),
    );
  });

  it("no coords at all → minimal honest snapshot, still charged + streamed", async () => {
    const deps = makeDeps({
      getSession: loggedIn(),
      extract: vi
        .fn()
        .mockResolvedValue({ onTopic: true, lakeName: "Gösputten" }),
      candidateLakes: vi.fn().mockResolvedValue([]),
      resolveLakeWithHaiku: vi.fn().mockResolvedValue({
        lakeId: null,
        confidence: 92,
        noSuchLake: true,
        clarifyQuestion: "?",
      }),
    });
    const result = await handleAsk({ message: "Gösputten?" }, deps);
    const r = asType(result, "stream");
    expect(deps.buildAreaSignals).not.toHaveBeenCalled();
    expect(deps.spendCredit).toHaveBeenCalledOnce();
    // The snapshot passed to adviseFirst is the minimal area one.
    // biome-ignore lint/suspicious/noExplicitAny: vi.Mock internals
    const [adviseArgs] = (deps.adviseFirst as any).mock.calls[0];
    expect(adviseArgs.signals.areaOnly).toBe(true);
    expect(adviseArgs.signals.askedLakeName).toBe("Gösputten");
    expect(adviseArgs.signals.lake).toBe("okänt vatten");
    expect(r.badges?.status).toBe("unresolved_area");
  });
});

// ---------------------------------------------------------------------------
// 8. Follow-ups on transitioned conversations
// ---------------------------------------------------------------------------

describe("follow-ups", () => {
  it("resolved: adviseFollowup with frozen snapshot, no refetch, no credit", async () => {
    const deps = makeDeps({
      getSession: loggedIn(),
      getConversation: vi.fn().mockResolvedValue(resolvedConversation()),
      countUserMessages: vi.fn().mockResolvedValue(3),
    });
    const result = await handleAsk(
      { message: "Vilket djup?", conversationId: "conv-1" },
      deps,
    );
    expect(result.type).toBe("stream");
    expect(deps.adviseFollowup).toHaveBeenCalledOnce();
    expect(deps.buildSignals).not.toHaveBeenCalled();
    expect(deps.spendCredit).not.toHaveBeenCalled();
    expect(deps.resolveLakeWithHaiku).not.toHaveBeenCalled();
    // biome-ignore lint/suspicious/noExplicitAny: vi.Mock internals
    const [args] = (deps.adviseFollowup as any).mock.calls[0];
    expect(args.snapshot).toEqual(BASE_SIGNALS);
    expect(args.turnIndex).toBe(4);
  });

  it("resolved: lake-lock violation → redirect", async () => {
    const deps = makeDeps({
      getSession: loggedIn(),
      getConversation: vi.fn().mockResolvedValue(resolvedConversation()),
      countUserMessages: vi.fn().mockResolvedValue(2),
      extract: vi
        .fn()
        .mockResolvedValue({ onTopic: true, lakeName: "Vättern" }),
      isLakeLockViolation: vi.fn().mockReturnValue(true),
      getLakeLockRedirect: vi
        .fn()
        .mockReturnValue("Jag känner bara till Tolken"),
    });
    const result = await handleAsk(
      { message: "Vad biter i Vättern?", conversationId: "conv-1" },
      deps,
    );
    const r = asType(result, "lake_lock");
    expect(r.text).toContain("Tolken");
    // Lock key is the BARE name.
    // biome-ignore lint/suspicious/noExplicitAny: vi.Mock internals
    const [, lockKey] = (deps.isLakeLockViolation as any).mock.calls[0];
    expect(lockKey).toBe("Tolken");
    expect(deps.adviseFollowup).not.toHaveBeenCalled();
  });

  it("unresolved_area: NO lake-lock even when a lake is named", async () => {
    const areaSnapshot: Signals = {
      lake: "trakten kring Ulricehamn",
      lakeId: "area",
      areaOnly: true,
      timeLocal: "2026-06-29T10:00:00",
    };
    const deps = makeDeps({
      getSession: loggedIn(),
      getConversation: vi.fn().mockResolvedValue(
        resolvedConversation({
          status: "unresolved_area",
          lakeId: null,
          bareLakeName: null,
          signalsSnapshot: areaSnapshot,
        }),
      ),
      countUserMessages: vi.fn().mockResolvedValue(1),
      extract: vi
        .fn()
        .mockResolvedValue({ onTopic: true, lakeName: "Vättern" }),
      isLakeLockViolation: vi.fn().mockReturnValue(true),
    });
    const result = await handleAsk(
      { message: "Vättern då?", conversationId: "conv-1" },
      deps,
    );
    expect(result.type).toBe("stream");
    expect(deps.isLakeLockViolation).not.toHaveBeenCalled();
    expect(deps.adviseFollowup).toHaveBeenCalledOnce();
  });

  it("missing snapshot on a transitioned conversation → observable anomaly gate", async () => {
    const deps = makeDeps({
      getSession: loggedIn(),
      getConversation: vi
        .fn()
        .mockResolvedValue(resolvedConversation({ signalsSnapshot: null })),
      countUserMessages: vi.fn().mockResolvedValue(2),
    });
    const result = await handleAsk(
      { message: "Vilket djup?", conversationId: "conv-1" },
      deps,
    );
    expect(result.type).toBe("lake_unresolved");
    expect(deps.emit).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "persistence_failure",
        payload: expect.objectContaining({
          reason: "missing_signals_snapshot",
        }),
      }),
    );
  });
});

// ---------------------------------------------------------------------------
// 9. IDOR — ownership binding unchanged
// ---------------------------------------------------------------------------

describe("C1: conversation-ownership enforcement", () => {
  it("rejects a logged-in caller following up on another user's conversation", async () => {
    const deps = makeDeps({
      getSession: loggedIn("attacker"),
      getConversation: vi
        .fn()
        .mockResolvedValue(resolvedConversation({ userId: "victim" })),
    });
    const result = await handleAsk(
      { message: "Vad biter?", conversationId: "conv-1" },
      deps,
    );
    expect(result.type).toBe("lake_unresolved");
    expect(deps.countUserMessages).not.toHaveBeenCalled();
    expect(deps.extract).not.toHaveBeenCalled();
  });

  it("rejects a tokenless anon caller supplying another anon's conversationId", async () => {
    const deps = makeDeps({
      getConversation: vi
        .fn()
        .mockResolvedValue(
          resolvedConversation({ userId: null, claimToken: "real-token" }),
        ),
    });
    const result = await handleAsk(
      { message: "Vad biter?", conversationId: "conv-1" },
      deps,
    );
    expect(result.type).toBe("lake_unresolved");
    expect(deps.adviseFollowup).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// 10. Swedish free-text time still resolves at the transition
// ---------------------------------------------------------------------------

describe("Swedish free-text extraction.time", () => {
  it("resolves 'på lördag' to the next Saturday relative to deps.now", async () => {
    const now = new Date("2026-06-29T10:00:00Z");
    const deps = makeDeps({
      getSession: loggedIn(),
      extract: vi.fn().mockResolvedValue({
        onTopic: true,
        lakeName: "Tolken",
        time: "på lördag",
      }),
      now,
    });
    await handleAsk({ message: "Vad biter på lördag?" }, deps);
    // biome-ignore lint/suspicious/noExplicitAny: vi.Mock internals
    const [signalsInput] = (deps.buildSignals as any).mock.calls[0];
    const target: Date = signalsInput.targetTime;
    expect(target.getDay()).toBe(6);
    expect(target.getDate()).toBe(4);
  });

  it("falls back to deps.now for unparseable time and emits time_parse_fallback", async () => {
    const now = new Date("2026-06-29T10:00:00Z");
    const deps = makeDeps({
      getSession: loggedIn(),
      extract: vi.fn().mockResolvedValue({
        onTopic: true,
        lakeName: "Tolken",
        time: "någon gång snart",
      }),
      now,
    });
    await handleAsk({ message: "Vad biter snart?" }, deps);
    // biome-ignore lint/suspicious/noExplicitAny: vi.Mock internals
    const [signalsInput] = (deps.buildSignals as any).mock.calls[0];
    expect(signalsInput.targetTime).toEqual(now);
    expect(deps.emit).toHaveBeenCalledWith(
      expect.objectContaining({ type: "time_parse_fallback" }),
    );
  });
});

// ---------------------------------------------------------------------------
// 11. Small pure helpers
// ---------------------------------------------------------------------------

describe("helpers", () => {
  it("centroidOf averages candidate positions", () => {
    const c = centroidOf([TOLKEN, ASUNDEN]);
    expect(c?.lat).toBeCloseTo((57.7 + 57.71) / 2);
    expect(c?.lon).toBeCloseTo((13.0 + 13.4) / 2);
    expect(centroidOf([])).toBeUndefined();
  });

  it("areaLabel prefers the spoken municipality", () => {
    expect(areaLabel({ onTopic: true, municipality: "Ulricehamn" }, true)).toBe(
      "trakten kring Ulricehamn",
    );
    expect(areaLabel({ onTopic: true }, true)).toBe("trakten där du är");
    expect(areaLabel({ onTopic: true }, false)).toBe("okänt vatten");
  });

  it("toBadges unwraps provenance values and shows the bare lake name", () => {
    const badges = toBadges(BASE_SIGNALS, "resolved");
    expect(badges).toEqual({
      lake: "Tolken",
      status: "resolved",
      airTempC: 17,
      windMs: 4.2,
    });
  });
});

// ---------------------------------------------------------------------------
// 12. Ort clarify round
// ---------------------------------------------------------------------------

describe("ort clarify round", () => {
  const ortExtraction = {
    onTopic: true,
    lakeName: "Stallarholmen",
    waterKind: "ort" as const,
  };

  it("gives a named ort one free clarify round instead of an instant area transition", async () => {
    const deps = makeDeps({
      getSession: loggedIn(),
      extract: vi.fn().mockResolvedValue(ortExtraction),
    });
    const result = await handleAsk(
      { message: "Kan man fiska vid Stallarholmen?" },
      deps,
    );
    expect(result.type).toBe("clarify");
    if (result.type === "clarify") {
      expect(result.text).toBe(ortClarifyMessage("Stallarholmen"));
    }
    expect(deps.spendCredit).not.toHaveBeenCalled();
    expect(deps.transitionConversation).not.toHaveBeenCalled();
    // The register holds only lakes — candidate SQL and the resolver are
    // both skipped for an ort.
    expect(deps.candidateLakes).not.toHaveBeenCalled();
    expect(deps.resolveLakeWithHaiku).not.toHaveBeenCalled();
    expect(deps.recordClarifyRound).toHaveBeenCalledWith("new-conv-id", {
      attempts: 1,
      pendingLakeName: "Stallarholmen",
    });
  });

  it("insisting on the SAME ort transitions to unresolved_area as before", async () => {
    const deps = makeDeps({
      getSession: loggedIn(),
      getConversation: vi.fn().mockResolvedValue(
        pendingConversation({
          resolveAttempts: 1,
          pendingLakeName: "Stallarholmen",
        }),
      ),
      countUserMessages: vi.fn().mockResolvedValue(1),
      extract: vi.fn().mockResolvedValue(ortExtraction),
    });
    const result = await handleAsk(
      { message: "Stallarholmen sa jag", conversationId: "conv-pending" },
      deps,
    );
    expect(result.type).toBe("stream");
    expect(deps.transitionConversation).toHaveBeenCalledWith(
      expect.objectContaining({ status: "unresolved_area" }),
    );
    expect(deps.emit).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "lake_unresolved_area",
        payload: expect.objectContaining({ reason: "non_lake_water" }),
      }),
    );
    expect(deps.recordClarifyRound).not.toHaveBeenCalled();
  });

  it("ort clarify then a real lake resolves with one credit", async () => {
    const deps = makeDeps({
      getSession: loggedIn(),
      getConversation: vi.fn().mockResolvedValue(
        pendingConversation({
          resolveAttempts: 1,
          pendingLakeName: "Stallarholmen",
        }),
      ),
      countUserMessages: vi.fn().mockResolvedValue(1),
      extract: vi.fn().mockResolvedValue({ onTopic: true, lakeName: "Tolken" }),
    });
    const result = await handleAsk(
      { message: "Jag menar Tolken", conversationId: "conv-pending" },
      deps,
    );
    expect(result.type).toBe("stream");
    expect(deps.spendCredit).toHaveBeenCalledTimes(1);
    expect(deps.transitionConversation).toHaveBeenCalledWith(
      expect.objectContaining({ status: "resolved", lakeId: "tolken-1" }),
    );
  });
});
