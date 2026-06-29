/**
 * ask-handler.test.ts — unit tests for the POST /api/ask orchestration logic.
 *
 * These tests exercise the branching (gate ordering) of `handleAsk` without
 * a real server, DB, or Claude API.  All leaf modules are injected as mocks.
 *
 * The 8 cases:
 *  1. Anon 2nd prompt → register-to-continue (no extract/Claude called)
 *  2. Chat-turn limit hit → freezeConversation + CHAT_LIMIT_MESSAGE (no Claude)
 *  3. Off-topic → topic_refused + refusal text (no credit/Sonnet)
 *  4. New convo, lake unresolved → reprompt (no credit)
 *  5. New convo, out of credits → upgrade response (no Sonnet)
 *  6. New convo, happy path → buildSignals + spendCredit + adviseFirst called
 *  7. Follow-up, lake-lock violation → redirect (no Haiku/refetch)
 *  8. Follow-up, happy path → adviseFollowup called with frozen snapshot
 */

import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
vi.mock("@/shared/db/client", () => ({ db: {} }));

import { CHAT_LIMIT_MESSAGE } from "@/lib/chat/quota";
import type { Signals } from "@/lib/signals/types";
import {
  type AskHandlerDeps,
  type AskInput,
  type AskResult,
  handleAsk,
} from "./ask-handler";

// ---------------------------------------------------------------------------
// Type helper
// ---------------------------------------------------------------------------

/** Narrow an AskResult to a specific type. Throws if it doesn't match. */
function asType<T extends AskResult["type"]>(
  result: AskResult,
  type: T,
): Extract<AskResult, { type: T }> {
  if (result.type !== type) {
    throw new Error(`Expected result.type="${type}", got "${result.type}"`);
  }
  return result as Extract<AskResult, { type: T }>;
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const BASE_SIGNALS: Signals = {
  lake: "Tolken",
  lakeId: "tolken-1",
  timeLocal: "2026-06-29T10:00:00",
};

const BASE_LAKE = {
  id: "tolken-1",
  name: "Tolken",
  municipality: "Borås",
  county: "Västra Götaland",
  lat: 57.7,
  lon: 13.0,
  areaHa: 1200,
};

/** A minimal mock stream that satisfies the interface the route needs */
function makeStream() {
  return {
    toReadableStream: vi.fn().mockReturnValue(new ReadableStream()),
    finalMessage: vi.fn().mockResolvedValue({
      content: [{ type: "text", text: "Prova maskkroken." }],
    }),
  };
}

// ---------------------------------------------------------------------------
// Helper: build a full deps object with sensible defaults; override per test
// ---------------------------------------------------------------------------

function makeDeps(overrides: Partial<AskHandlerDeps> = {}): AskHandlerDeps {
  return {
    getSession: vi.fn().mockResolvedValue(null),
    getConversation: vi.fn().mockResolvedValue(null),
    countUserMessages: vi.fn().mockResolvedValue(0),
    getHistoryMessages: vi.fn().mockResolvedValue([]),
    getUserRow: vi.fn().mockResolvedValue({ isPaid: false, creditsUsed: 0 }),
    extract: vi.fn().mockResolvedValue({
      onTopic: true,
      lakeName: "Tolken",
    }),
    resolveLake: vi.fn().mockResolvedValue(BASE_LAKE),
    buildSignals: vi.fn().mockResolvedValue(BASE_SIGNALS),
    adviseFirst: vi.fn().mockReturnValue(makeStream()),
    adviseFollowup: vi.fn().mockReturnValue(makeStream()),
    isLakeLockViolation: vi.fn().mockReturnValue(false),
    getLakeLockRedirect: vi.fn().mockReturnValue("lake-lock redirect"),
    canSpendCredit: vi.fn().mockReturnValue(true),
    // E5: spendCredit now returns true when a credit was actually spent
    // (guarded atomic UPDATE matched a row).
    spendCredit: vi.fn().mockResolvedValue(true),
    chatTurnAllowed: vi.fn().mockReturnValue(true),
    freezeConversation: vi.fn().mockResolvedValue(undefined),
    createConversation: vi.fn().mockResolvedValue("new-conv-id"),
    persistMessage: vi.fn().mockResolvedValue(undefined),
    updateLastActive: vi.fn().mockResolvedValue(undefined),
    emit: vi.fn().mockResolvedValue(undefined),
    now: new Date("2026-06-29T10:00:00Z"),
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// 1. Anon 2nd prompt → register-to-continue
// ---------------------------------------------------------------------------

describe("case 1: anon 2nd prompt", () => {
  it("returns register-to-continue without calling extract or advise", async () => {
    const deps = makeDeps({
      // anon: no session, but they have a claimToken + existing conversation
      getSession: vi.fn().mockResolvedValue(null),
      getConversation: vi.fn().mockResolvedValue({
        id: "anon-conv-1",
        userId: null,
        claimToken: "token-abc",
        frozen: false,
        signalsSnapshot: BASE_SIGNALS,
        lakeId: "tolken-1",
      }),
    });

    const input: AskInput = {
      message: "Vad biter ikväll?",
      conversationId: "anon-conv-1",
      claimToken: "token-abc",
    };

    const result = await handleAsk(input, deps);

    expect(result.type).toBe("register_to_continue");
    expect(deps.extract).not.toHaveBeenCalled();
    expect(deps.adviseFirst).not.toHaveBeenCalled();
    expect(deps.adviseFollowup).not.toHaveBeenCalled();
  });

  it("returns register-to-continue even for a NEW conversation if anon has used their slot", async () => {
    const deps = makeDeps({
      getSession: vi.fn().mockResolvedValue(null),
      // no conversationId → first thing: check anon quota
      getConversation: vi.fn().mockResolvedValue(null),
    });

    // claimToken present means they've started a convo before
    const input: AskInput = { message: "Vad biter?", claimToken: "token-xyz" }; // no conversationId

    const result = await handleAsk(input, deps);

    // anon with token but no existing conversationId — they already used their
    // free slot (token was issued for a previous convo), block
    expect(result.type).toBe("register_to_continue");
    expect(deps.extract).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// 2. Chat-turn limit hit
// ---------------------------------------------------------------------------

describe("case 2: chat-turn limit", () => {
  it("freezes conversation and returns CHAT_LIMIT_MESSAGE without calling Claude", async () => {
    const deps = makeDeps({
      getSession: vi.fn().mockResolvedValue({ user: { id: "user-1" } }),
      getConversation: vi.fn().mockResolvedValue({
        id: "conv-1",
        userId: "user-1",
        frozen: false,
        signalsSnapshot: BASE_SIGNALS,
        lakeId: "tolken-1",
      }),
      countUserMessages: vi.fn().mockResolvedValue(20),
      chatTurnAllowed: vi.fn().mockReturnValue(false),
    });

    const input: AskInput = {
      message: "Ännu ett meddelande",
      conversationId: "conv-1",
    };

    const result = await handleAsk(input, deps);

    const r = asType(result, "chat_limit");
    expect(r.text).toBe(CHAT_LIMIT_MESSAGE);
    expect(deps.freezeConversation).toHaveBeenCalledWith("conv-1");
    expect(deps.extract).not.toHaveBeenCalled();
    expect(deps.adviseFollowup).not.toHaveBeenCalled();
  });

  it("returns CHAT_LIMIT_MESSAGE immediately if conversation is already frozen", async () => {
    const deps = makeDeps({
      getSession: vi.fn().mockResolvedValue({ user: { id: "user-1" } }),
      getConversation: vi.fn().mockResolvedValue({
        id: "conv-1",
        userId: "user-1",
        frozen: true,
        signalsSnapshot: BASE_SIGNALS,
        lakeId: "tolken-1",
      }),
    });

    const input: AskInput = {
      message: "Hej igen",
      conversationId: "conv-1",
    };

    const result = await handleAsk(input, deps);

    const r = asType(result, "chat_limit");
    expect(r.text).toBe(CHAT_LIMIT_MESSAGE);
    expect(deps.freezeConversation).not.toHaveBeenCalled();
    expect(deps.extract).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// 3. Off-topic → topic_refused
// ---------------------------------------------------------------------------

describe("case 3: off-topic message", () => {
  it("emits topic_refused, returns refusal text, no credit spent, no Sonnet", async () => {
    const deps = makeDeps({
      getSession: vi.fn().mockResolvedValue({ user: { id: "user-1" } }),
      getConversation: vi.fn().mockResolvedValue(null),
      extract: vi.fn().mockResolvedValue({
        onTopic: false,
        refusal: "Jag snackar bara fiske, hörru. Fråga mig om sjöar istället.",
      }),
    });

    const input: AskInput = { message: "Vad är meningen med livet?" };

    const result = await handleAsk(input, deps);

    const r = asType(result, "topic_refused");
    expect(r.text).toContain("fiske");
    expect(deps.emit).toHaveBeenCalledWith(
      expect.objectContaining({ type: "topic_refused" }),
    );
    expect(deps.spendCredit).not.toHaveBeenCalled();
    expect(deps.adviseFirst).not.toHaveBeenCalled();
    expect(deps.adviseFollowup).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// 4. New convo, lake unresolved → reprompt
// ---------------------------------------------------------------------------

describe("case 4: new conversation, lake not resolved", () => {
  it("emits lake_unresolved, returns reprompt, no credit spent", async () => {
    const deps = makeDeps({
      getSession: vi.fn().mockResolvedValue({ user: { id: "user-1" } }),
      getConversation: vi.fn().mockResolvedValue(null),
      extract: vi.fn().mockResolvedValue({
        onTopic: true,
        lakeName: "Fantasisjön",
      }),
      resolveLake: vi.fn().mockResolvedValue(null),
    });

    const input: AskInput = { message: "Vad biter i Fantasisjön?" };

    const result = await handleAsk(input, deps);

    const r = asType(result, "lake_unresolved");
    expect(r.text).toBeDefined();
    expect(deps.emit).toHaveBeenCalledWith(
      expect.objectContaining({ type: "lake_unresolved" }),
    );
    expect(deps.spendCredit).not.toHaveBeenCalled();
    expect(deps.adviseFirst).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// 5. New convo, out of credits → upgrade response
// ---------------------------------------------------------------------------

describe("case 5: new conversation, out of credits", () => {
  it("returns upgrade response without calling Sonnet or spending credit", async () => {
    const deps = makeDeps({
      getSession: vi.fn().mockResolvedValue({ user: { id: "user-1" } }),
      getConversation: vi.fn().mockResolvedValue(null),
      getUserRow: vi.fn().mockResolvedValue({ isPaid: false, creditsUsed: 3 }),
      canSpendCredit: vi.fn().mockReturnValue(false),
    });

    const input: AskInput = { message: "Vad biter i Tolken?" };

    const result = await handleAsk(input, deps);

    expect(result.type).toBe("out_of_credits");
    expect(deps.spendCredit).not.toHaveBeenCalled();
    expect(deps.adviseFirst).not.toHaveBeenCalled();
    expect(deps.buildSignals).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// 6. New convo, happy path
// ---------------------------------------------------------------------------

describe("case 6: new conversation, happy path", () => {
  it("calls buildSignals, spendCredit, adviseFirst; emits lake_resolved + credit_spent", async () => {
    const mockStream = makeStream();
    const deps = makeDeps({
      getSession: vi.fn().mockResolvedValue({ user: { id: "user-1" } }),
      getConversation: vi.fn().mockResolvedValue(null),
      getUserRow: vi.fn().mockResolvedValue({ isPaid: false, creditsUsed: 0 }),
      canSpendCredit: vi.fn().mockReturnValue(true),
      adviseFirst: vi.fn().mockReturnValue(mockStream),
    });

    const input: AskInput = { message: "Vad biter i Tolken imorgon?" };

    const result = await handleAsk(input, deps);

    expect(result.type).toBe("stream");
    expect(deps.buildSignals).toHaveBeenCalledOnce();
    expect(deps.spendCredit).toHaveBeenCalledWith("user-1");
    expect(deps.adviseFirst).toHaveBeenCalledOnce();
    expect(deps.adviseFollowup).not.toHaveBeenCalled();
    expect(deps.emit).toHaveBeenCalledWith(
      expect.objectContaining({ type: "lake_resolved" }),
    );
    expect(deps.createConversation).toHaveBeenCalledOnce();
  });

  it("creates conversation with frozen signalsSnapshot before streaming", async () => {
    const deps = makeDeps({
      getSession: vi.fn().mockResolvedValue({ user: { id: "user-1" } }),
      getConversation: vi.fn().mockResolvedValue(null),
    });

    await handleAsk({ message: "Vad biter i Tolken?" }, deps);

    expect(deps.createConversation).toHaveBeenCalledWith(
      expect.objectContaining({
        signalsSnapshot: BASE_SIGNALS,
        lakeId: "tolken-1",
      }),
    );
  });

  it("returns claimToken on stream result for new anon conversation so route can set the cookie", async () => {
    // Anon: no session, no prior claimToken
    const deps = makeDeps({
      getSession: vi.fn().mockResolvedValue(null),
      getConversation: vi.fn().mockResolvedValue(null),
    });

    const result = await handleAsk({ message: "Vad biter i Tolken?" }, deps);

    // Must be a stream result
    const r = asType(result, "stream");
    // claimToken must be present and non-empty (a UUID v4)
    expect(r.claimToken).toBeDefined();
    expect(typeof r.claimToken).toBe("string");
    expect(r.claimToken?.length).toBeGreaterThan(0);
    // createConversation must have been called with that same claimToken
    expect(deps.createConversation).toHaveBeenCalledWith(
      expect.objectContaining({ claimToken: r.claimToken }),
    );
  });

  it("does NOT return claimToken for logged-in user new conversation", async () => {
    const deps = makeDeps({
      getSession: vi.fn().mockResolvedValue({ user: { id: "user-1" } }),
      getConversation: vi.fn().mockResolvedValue(null),
    });

    const result = await handleAsk({ message: "Vad biter i Tolken?" }, deps);

    const r = asType(result, "stream");
    // Logged-in users don't get a claimToken
    expect(r.claimToken).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// 7. Follow-up, lake-lock violation
// ---------------------------------------------------------------------------

describe("case 7: follow-up, lake-lock violation", () => {
  it("returns lake-lock redirect without calling Haiku or refetching", async () => {
    const deps = makeDeps({
      getSession: vi.fn().mockResolvedValue({ user: { id: "user-1" } }),
      getConversation: vi.fn().mockResolvedValue({
        id: "conv-1",
        userId: "user-1",
        frozen: false,
        signalsSnapshot: BASE_SIGNALS,
        lakeId: "tolken-1",
        lakeName: "Tolken",
      }),
      countUserMessages: vi.fn().mockResolvedValue(2),
      extract: vi.fn().mockResolvedValue({
        onTopic: true,
        lakeName: "Vättern",
      }),
      isLakeLockViolation: vi.fn().mockReturnValue(true),
      getLakeLockRedirect: vi
        .fn()
        .mockReturnValue(
          "Jag känner bara till Tolken, hörru — dra igång en ny chatt",
        ),
    });

    const input: AskInput = {
      message: "Vad biter i Vättern?",
      conversationId: "conv-1",
    };

    const result = await handleAsk(input, deps);

    const r = asType(result, "lake_lock");
    expect(r.text).toContain("Tolken");
    expect(deps.adviseFollowup).not.toHaveBeenCalled();
    expect(deps.resolveLake).not.toHaveBeenCalled();
    expect(deps.buildSignals).not.toHaveBeenCalled();
    expect(deps.spendCredit).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// 8. Follow-up, happy path
// ---------------------------------------------------------------------------

describe("case 8: follow-up, happy path", () => {
  it("calls adviseFollowup with the frozen snapshot, not a fresh fetch", async () => {
    const mockStream = makeStream();
    const deps = makeDeps({
      getSession: vi.fn().mockResolvedValue({ user: { id: "user-1" } }),
      getConversation: vi.fn().mockResolvedValue({
        id: "conv-1",
        userId: "user-1",
        frozen: false,
        signalsSnapshot: BASE_SIGNALS,
        lakeId: "tolken-1",
        lakeName: "Tolken",
      }),
      countUserMessages: vi.fn().mockResolvedValue(3),
      extract: vi.fn().mockResolvedValue({
        onTopic: true,
        lakeName: "Tolken",
      }),
      isLakeLockViolation: vi.fn().mockReturnValue(false),
      adviseFollowup: vi.fn().mockReturnValue(mockStream),
    });

    const input: AskInput = {
      message: "Vilket djup bör jag fiska på?",
      conversationId: "conv-1",
    };

    const result = await handleAsk(input, deps);

    expect(result.type).toBe("stream");
    expect(deps.adviseFollowup).toHaveBeenCalledOnce();
    expect(deps.adviseFirst).not.toHaveBeenCalled();
    expect(deps.buildSignals).not.toHaveBeenCalled();
    expect(deps.spendCredit).not.toHaveBeenCalled();

    // The snapshot passed to adviseFollowup should be the frozen one
    // biome-ignore lint/suspicious/noExplicitAny: accessing vi.Mock internals
    const [args] = (deps.adviseFollowup as any).mock.calls[0];
    expect(args.snapshot).toEqual(BASE_SIGNALS);
  });

  it("passes turnIndex = persisted user count + 1 (inclusive of current turn) to adviseFollowup", async () => {
    const deps = makeDeps({
      getSession: vi.fn().mockResolvedValue({ user: { id: "user-1" } }),
      getConversation: vi.fn().mockResolvedValue({
        id: "conv-1",
        userId: "user-1",
        frozen: false,
        signalsSnapshot: BASE_SIGNALS,
        lakeId: "tolken-1",
        lakeName: "Tolken",
      }),
      countUserMessages: vi.fn().mockResolvedValue(5),
      isLakeLockViolation: vi.fn().mockReturnValue(false),
    });

    await handleAsk({ message: "Djupare?", conversationId: "conv-1" }, deps);

    // M3: countUserMessages=5 persisted rows + the in-flight turn = 6.
    // biome-ignore lint/suspicious/noExplicitAny: accessing vi.Mock internals
    const [args] = (deps.adviseFollowup as any).mock.calls[0];
    expect(args.turnIndex).toBe(6);
  });
});

// ---------------------------------------------------------------------------
// C1: IDOR — follow-up with another caller's conversationId is rejected
// ---------------------------------------------------------------------------

describe("C1: conversation-ownership enforcement", () => {
  it("rejects a logged-in caller following up on another user's conversation", async () => {
    const deps = makeDeps({
      getSession: vi.fn().mockResolvedValue({ user: { id: "attacker" } }),
      getConversation: vi.fn().mockResolvedValue({
        id: "victim-conv",
        userId: "victim", // owned by someone else
        frozen: false,
        signalsSnapshot: BASE_SIGNALS,
        lakeId: "tolken-1",
        lakeName: "Tolken",
      }),
    });

    const result = await handleAsk(
      { message: "Vad biter?", conversationId: "victim-conv" },
      deps,
    );

    // Not-found-style gate (reuses lake_unresolved) — existence not revealed,
    // never a 500, and no Claude/credit/turn consumption on the victim's convo.
    expect(result.type).toBe("lake_unresolved");
    expect(deps.adviseFollowup).not.toHaveBeenCalled();
    expect(deps.countUserMessages).not.toHaveBeenCalled();
    expect(deps.extract).not.toHaveBeenCalled();
  });

  it("rejects a tokenless anon caller supplying another anon's conversationId", async () => {
    // No claimToken on the caller (so the anon-quota gate does NOT fire), but
    // they pass someone else's anon conversationId.  Ownership requires a
    // matching non-null claimToken → rejected (no existence leak, no 500).
    const deps = makeDeps({
      getSession: vi.fn().mockResolvedValue(null),
      getConversation: vi.fn().mockResolvedValue({
        id: "anon-conv",
        userId: null,
        claimToken: "real-token",
        frozen: false,
        signalsSnapshot: BASE_SIGNALS,
        lakeId: "tolken-1",
        lakeName: "Tolken",
      }),
    });

    const result = await handleAsk(
      {
        message: "Vad biter?",
        conversationId: "anon-conv",
        // no claimToken
      },
      deps,
    );

    expect(result.type).toBe("lake_unresolved");
    expect(deps.adviseFollowup).not.toHaveBeenCalled();
  });

  it("allows a logged-in caller to follow up on their OWN conversation", async () => {
    const deps = makeDeps({
      getSession: vi.fn().mockResolvedValue({ user: { id: "owner" } }),
      getConversation: vi.fn().mockResolvedValue({
        id: "own-conv",
        userId: "owner",
        frozen: false,
        signalsSnapshot: BASE_SIGNALS,
        lakeId: "tolken-1",
        lakeName: "Tolken",
      }),
      countUserMessages: vi.fn().mockResolvedValue(2),
      isLakeLockViolation: vi.fn().mockReturnValue(false),
    });

    const result = await handleAsk(
      { message: "Vilket djup?", conversationId: "own-conv" },
      deps,
    );

    expect(result.type).toBe("stream");
    expect(deps.adviseFollowup).toHaveBeenCalledOnce();
  });
});

// ---------------------------------------------------------------------------
// C1: Swedish free-text time ("ikväll") must not throw a 500
// ---------------------------------------------------------------------------

describe("C1: unparseable extraction.time falls back to deps.now (never throws)", () => {
  it("does NOT throw when extraction.time is a Swedish free-text string like 'ikväll'", async () => {
    const deps = makeDeps({
      getSession: vi.fn().mockResolvedValue({ user: { id: "user-1" } }),
      getConversation: vi.fn().mockResolvedValue(null),
      extract: vi.fn().mockResolvedValue({
        onTopic: true,
        lakeName: "Tolken",
        // Swedish free-text time — new Date("ikväll") → Invalid Date
        time: "ikväll",
      }),
    });

    // Must resolve, never reject
    await expect(
      handleAsk({ message: "Vad biter ikväll?" }, deps),
    ).resolves.toBeDefined();
  });

  it("calls buildSignals with deps.now when extraction.time is unparseable", async () => {
    const now = new Date("2026-06-29T10:00:00Z");
    const deps = makeDeps({
      getSession: vi.fn().mockResolvedValue({ user: { id: "user-1" } }),
      getConversation: vi.fn().mockResolvedValue(null),
      extract: vi.fn().mockResolvedValue({
        onTopic: true,
        lakeName: "Tolken",
        time: "på lördag", // another typical unparseable Swedish time
      }),
      now,
    });

    await handleAsk({ message: "Vad biter på lördag?" }, deps);

    // biome-ignore lint/suspicious/noExplicitAny: accessing vi.Mock internals
    const [signalsInput] = (deps.buildSignals as any).mock.calls[0];
    // targetTime must be exactly deps.now (the fallback), not an Invalid Date
    expect(signalsInput.targetTime).toEqual(now);
    expect(Number.isNaN(signalsInput.targetTime.getTime())).toBe(false);
  });

  it("uses the parsed date when extraction.time is a valid ISO string", async () => {
    const deps = makeDeps({
      getSession: vi.fn().mockResolvedValue({ user: { id: "user-1" } }),
      getConversation: vi.fn().mockResolvedValue(null),
      extract: vi.fn().mockResolvedValue({
        onTopic: true,
        lakeName: "Tolken",
        time: "2026-07-04T18:00:00Z", // parseable ISO string
      }),
    });

    await handleAsk({ message: "Vad biter den 4 juli?" }, deps);

    // biome-ignore lint/suspicious/noExplicitAny: accessing vi.Mock internals
    const [signalsInput] = (deps.buildSignals as any).mock.calls[0];
    expect(signalsInput.targetTime).toEqual(new Date("2026-07-04T18:00:00Z"));
  });
});

// ---------------------------------------------------------------------------
// I1: Signals.lake is the full formatted label; lake-lock still works
// ---------------------------------------------------------------------------

describe("I1: Signals.lake uses formatted label; lake-lock compares bare name", () => {
  it("calls buildSignals with a formatted label (name + municipality + county)", async () => {
    const deps = makeDeps({
      getSession: vi.fn().mockResolvedValue({ user: { id: "user-1" } }),
      getConversation: vi.fn().mockResolvedValue(null),
      resolveLake: vi.fn().mockResolvedValue(BASE_LAKE),
    });

    await handleAsk({ message: "Vad biter i Tolken?" }, deps);

    // biome-ignore lint/suspicious/noExplicitAny: accessing vi.Mock internals
    const [signalsInput] = (deps.buildSignals as any).mock.calls[0];
    // label must be the canonical "name (municipality, county)" format
    expect(signalsInput.lake.label).toBe("Tolken (Borås, Västra Götaland)");
    // NOT the bare name
    expect(signalsInput.lake.label).not.toBe("Tolken");
  });

  it("lake-lock fires correctly when extraction.lakeName differs from the bare stored name", async () => {
    // The conversation snapshot stores lake label (formatted), but lakeName
    // passed to isLakeLockViolation should be the BARE name, not the label.
    const deps = makeDeps({
      getSession: vi.fn().mockResolvedValue({ user: { id: "user-1" } }),
      getConversation: vi.fn().mockResolvedValue({
        id: "conv-1",
        userId: "user-1",
        frozen: false,
        signalsSnapshot: {
          ...BASE_SIGNALS,
          // Simulate a new snapshot with formatted label and bareLakeName
          lake: "Tolken (Borås, Västra Götaland)",
          bareLakeName: "Tolken",
        },
        lakeId: "tolken-1",
        // lakeName is the bare name (as route.ts would derive from bareLakeName)
        lakeName: "Tolken",
      }),
      countUserMessages: vi.fn().mockResolvedValue(2),
      extract: vi.fn().mockResolvedValue({
        onTopic: true,
        lakeName: "Vättern", // different lake → should trigger lock
      }),
      isLakeLockViolation: vi
        .fn()
        .mockImplementation(
          (extraction, locked) =>
            extraction.lakeName?.toLowerCase() !== locked.toLowerCase(),
        ),
      getLakeLockRedirect: vi.fn().mockReturnValue("lock-redirect"),
    });

    const result = await handleAsk(
      { message: "Vad biter i Vättern?", conversationId: "conv-1" },
      deps,
    );

    // Lock should fire
    expect(result.type).toBe("lake_lock");
    // isLakeLockViolation must be called with the BARE lake name, not the formatted label
    // biome-ignore lint/suspicious/noExplicitAny: accessing vi.Mock internals
    const [, lockedNameArg] = (deps.isLakeLockViolation as any).mock.calls[0];
    expect(lockedNameArg).toBe("Tolken");
    expect(lockedNameArg).not.toContain("(");
  });

  it("lake-lock passes when extraction.lakeName matches the bare stored name", async () => {
    const mockStream = makeStream();
    const deps = makeDeps({
      getSession: vi.fn().mockResolvedValue({ user: { id: "user-1" } }),
      getConversation: vi.fn().mockResolvedValue({
        id: "conv-1",
        userId: "user-1",
        frozen: false,
        signalsSnapshot: {
          ...BASE_SIGNALS,
          lake: "Tolken (Borås, Västra Götaland)",
          bareLakeName: "Tolken",
        },
        lakeId: "tolken-1",
        lakeName: "Tolken",
      }),
      countUserMessages: vi.fn().mockResolvedValue(2),
      extract: vi.fn().mockResolvedValue({
        onTopic: true,
        lakeName: "Tolken", // same lake → no lock
      }),
      isLakeLockViolation: vi.fn().mockReturnValue(false),
      adviseFollowup: vi.fn().mockReturnValue(mockStream),
    });

    const result = await handleAsk(
      { message: "Vilket djup?", conversationId: "conv-1" },
      deps,
    );

    expect(result.type).toBe("stream");
    expect(deps.adviseFollowup).toHaveBeenCalledOnce();
  });
});
