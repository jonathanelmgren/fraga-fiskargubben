import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
vi.mock("@/shared/db/client", () => ({ db: {} }));

import {
  CHAT_LIMIT_MESSAGE,
  canSpendCredit,
  chatTurnAllowed,
  FREE_CREDITS,
  freezeConversation,
  MAX_CHAT_TURNS,
  refundCredit,
  spendCredit,
} from "./quota";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

describe("constants", () => {
  it("FREE_CREDITS is 3", () => {
    expect(FREE_CREDITS).toBe(3);
  });

  it("MAX_CHAT_TURNS is 20", () => {
    expect(MAX_CHAT_TURNS).toBe(20);
  });
});

// ---------------------------------------------------------------------------
// canSpendCredit — pure gate
// ---------------------------------------------------------------------------

describe("canSpendCredit", () => {
  it("allows creditsUsed=0 (free, none spent)", () => {
    expect(canSpendCredit({ isPaid: false, creditsUsed: 0 })).toBe(true);
  });

  it("allows creditsUsed=1", () => {
    expect(canSpendCredit({ isPaid: false, creditsUsed: 1 })).toBe(true);
  });

  it("allows creditsUsed=2 (one credit remaining)", () => {
    expect(canSpendCredit({ isPaid: false, creditsUsed: 2 })).toBe(true);
  });

  it("blocks creditsUsed=3 (all free credits spent)", () => {
    expect(canSpendCredit({ isPaid: false, creditsUsed: 3 })).toBe(false);
  });

  it("blocks creditsUsed=10 (well over limit)", () => {
    expect(canSpendCredit({ isPaid: false, creditsUsed: 10 })).toBe(false);
  });

  it("allows isPaid=true even with creditsUsed=99", () => {
    expect(canSpendCredit({ isPaid: true, creditsUsed: 99 })).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// chatTurnAllowed — pure gate
// messageCount = number of user turns already in the conversation (count of
// user-role message rows). The caller counts only user messages so the limit
// means MAX_CHAT_TURNS user turns before the conversation is frozen.
// ---------------------------------------------------------------------------

describe("chatTurnAllowed", () => {
  it("allows messageCount=0 (fresh conversation)", () => {
    expect(chatTurnAllowed(0)).toBe(true);
  });

  it("allows messageCount at MAX_CHAT_TURNS-1 (last allowed turn)", () => {
    expect(chatTurnAllowed(MAX_CHAT_TURNS - 1)).toBe(true);
  });

  it("blocks messageCount at MAX_CHAT_TURNS (limit reached)", () => {
    expect(chatTurnAllowed(MAX_CHAT_TURNS)).toBe(false);
  });

  it("blocks messageCount above MAX_CHAT_TURNS", () => {
    expect(chatTurnAllowed(MAX_CHAT_TURNS + 5)).toBe(false);
  });

  it("wind-down turn 15 is NOT blocked (soft taper, handled elsewhere)", () => {
    expect(chatTurnAllowed(15)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// CHAT_LIMIT_MESSAGE — plain non-persona Swedish system alert
// ---------------------------------------------------------------------------

describe("CHAT_LIMIT_MESSAGE", () => {
  it("is non-empty", () => {
    expect(CHAT_LIMIT_MESSAGE.length).toBeGreaterThan(0);
  });

  it("mentions starting a new chat (ny chatt)", () => {
    expect(CHAT_LIMIT_MESSAGE.toLowerCase()).toContain("ny chatt");
  });
});

// ---------------------------------------------------------------------------
// spendCredit — DB update + analytics emit
// ---------------------------------------------------------------------------

describe("spendCredit", () => {
  it("issues a guarded DB increment, returns true, and emits credit_spent when a row is affected", async () => {
    // E5: the spend is a guarded atomic UPDATE that ends in .returning(); a
    // non-empty result means a credit was actually spent.
    const mockReturning = vi.fn().mockResolvedValue([{ id: "user-abc" }]);
    const mockWhere = vi.fn().mockReturnValue({ returning: mockReturning });
    const mockSet = vi.fn().mockReturnValue({ where: mockWhere });
    const mockUpdate = vi.fn().mockReturnValue({ set: mockSet });
    const mockDb = { update: mockUpdate } as unknown as Pick<
      import("@/shared/db/client").Db,
      "update"
    >;

    const mockEmit = vi.fn().mockResolvedValue(undefined);

    const spent = await spendCredit("user-abc", { db: mockDb, emit: mockEmit });

    expect(spent).toBe(true);

    // DB update was called
    expect(mockUpdate).toHaveBeenCalledTimes(1);
    expect(mockSet).toHaveBeenCalledTimes(1);
    expect(mockWhere).toHaveBeenCalledTimes(1);
    expect(mockReturning).toHaveBeenCalledTimes(1);

    // analytics emit called with correct event type and userId in payload
    expect(mockEmit).toHaveBeenCalledTimes(1);
    const emittedEvent = mockEmit.mock.calls[0][0] as {
      type: string;
      payload: Record<string, unknown>;
    };
    expect(emittedEvent.type).toBe("credit_spent");
    expect(emittedEvent.payload).toMatchObject({ userId: "user-abc" });
  });

  it("E5: returns false and does NOT emit when the guarded UPDATE affects 0 rows (already at limit)", async () => {
    const mockReturning = vi.fn().mockResolvedValue([]);
    const mockWhere = vi.fn().mockReturnValue({ returning: mockReturning });
    const mockSet = vi.fn().mockReturnValue({ where: mockWhere });
    const mockUpdate = vi.fn().mockReturnValue({ set: mockSet });
    const mockDb = { update: mockUpdate } as unknown as Pick<
      import("@/shared/db/client").Db,
      "update"
    >;

    const mockEmit = vi.fn().mockResolvedValue(undefined);

    const spent = await spendCredit("user-maxed", {
      db: mockDb,
      emit: mockEmit,
    });

    expect(spent).toBe(false);
    expect(mockReturning).toHaveBeenCalledTimes(1);
    expect(mockEmit).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// refundCredit — guarded DB decrement + analytics emit (inverse of spendCredit)
// ---------------------------------------------------------------------------

describe("refundCredit", () => {
  it("issues a guarded decrement, returns true, and emits credit_refunded when a row is affected", async () => {
    const mockReturning = vi.fn().mockResolvedValue([{ id: "user-abc" }]);
    const mockWhere = vi.fn().mockReturnValue({ returning: mockReturning });
    const mockSet = vi.fn().mockReturnValue({ where: mockWhere });
    const mockUpdate = vi.fn().mockReturnValue({ set: mockSet });
    const mockDb = { update: mockUpdate } as unknown as Pick<
      import("@/shared/db/client").Db,
      "update"
    >;
    const mockEmit = vi.fn().mockResolvedValue(undefined);

    const refunded = await refundCredit("user-abc", {
      db: mockDb,
      emit: mockEmit,
    });

    expect(refunded).toBe(true);
    expect(mockUpdate).toHaveBeenCalledTimes(1);
    expect(mockReturning).toHaveBeenCalledTimes(1);
    const emitted = mockEmit.mock.calls[0][0] as {
      type: string;
      payload: Record<string, unknown>;
    };
    expect(emitted.type).toBe("credit_refunded");
    expect(emitted.payload).toMatchObject({ userId: "user-abc" });
  });

  it("returns false and does NOT emit when the guard affects 0 rows (nothing to refund)", async () => {
    const mockReturning = vi.fn().mockResolvedValue([]);
    const mockWhere = vi.fn().mockReturnValue({ returning: mockReturning });
    const mockSet = vi.fn().mockReturnValue({ where: mockWhere });
    const mockUpdate = vi.fn().mockReturnValue({ set: mockSet });
    const mockDb = { update: mockUpdate } as unknown as Pick<
      import("@/shared/db/client").Db,
      "update"
    >;
    const mockEmit = vi.fn().mockResolvedValue(undefined);

    const refunded = await refundCredit("user-zero", {
      db: mockDb,
      emit: mockEmit,
    });

    expect(refunded).toBe(false);
    expect(mockEmit).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// freezeConversation — DB update + analytics emit
// ---------------------------------------------------------------------------

describe("freezeConversation", () => {
  it("sets frozen=true and emits chat_limit_hit", async () => {
    const mockWhere = vi.fn().mockResolvedValue(undefined);
    const mockSet = vi.fn().mockReturnValue({ where: mockWhere });
    const mockUpdate = vi.fn().mockReturnValue({ set: mockSet });
    const mockDb = { update: mockUpdate } as unknown as Pick<
      import("@/shared/db/client").Db,
      "update"
    >;

    const mockEmit = vi.fn().mockResolvedValue(undefined);

    await freezeConversation("conv-xyz", { db: mockDb, emit: mockEmit });

    expect(mockUpdate).toHaveBeenCalledTimes(1);
    expect(mockSet).toHaveBeenCalledTimes(1);
    expect(mockWhere).toHaveBeenCalledTimes(1);

    expect(mockEmit).toHaveBeenCalledTimes(1);
    const emittedEvent = mockEmit.mock.calls[0][0] as {
      type: string;
      conversationId: string;
    };
    expect(emittedEvent.type).toBe("chat_limit_hit");
    expect(emittedEvent.conversationId).toBe("conv-xyz");
  });
});
