import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
vi.mock("@/shared/db/client", () => ({ db: {} }));

import type { Db } from "@/shared/db/client";
import { claimConversation, gcUnclaimedAnon } from "./anon";

// ---------------------------------------------------------------------------
// Shared type alias for mock db
// ---------------------------------------------------------------------------

type MockDb = Pick<Db, "update" | "delete" | "select" | "transaction">;

// ---------------------------------------------------------------------------
// claimConversation
// ---------------------------------------------------------------------------

describe("claimConversation", () => {
  it("claims an unclaimed conversation: sets userId, clears token, sets creditsUsed=1, returns {claimed:true}", async () => {
    // select returns one unclaimed row
    const mockLimit = vi
      .fn()
      .mockResolvedValue([
        { id: "conv-abc", userId: null, claimToken: "tok-1" },
      ]);
    const mockWhere2 = vi.fn().mockReturnValue({ limit: mockLimit });
    const mockFrom = vi.fn().mockReturnValue({ where: mockWhere2 });
    const mockSelect = vi.fn().mockReturnValue({ from: mockFrom });

    // Track two update calls: first for conversation, second for user.
    // M7: the conversation UPDATE is self-guarding and ends in .returning();
    // a non-empty array means the row was claimed (race won).
    const convReturning = vi.fn().mockResolvedValue([{ id: "conv-abc" }]);
    const convWhere = vi.fn().mockReturnValue({ returning: convReturning });
    const convSet = vi.fn().mockReturnValue({ where: convWhere });
    const userWhere = vi.fn().mockResolvedValue(undefined);
    const userSet = vi.fn().mockReturnValue({ where: userWhere });

    let callCount = 0;
    const mockUpdateFn = vi.fn().mockImplementation(() => {
      callCount++;
      return { set: callCount === 1 ? convSet : userSet };
    });

    // transaction mock: invoke callback with a tx that has the same update chain
    const mockTransaction = vi
      .fn()
      .mockImplementation(async (cb: (tx: unknown) => Promise<void>) => {
        await cb({ update: mockUpdateFn });
      });

    const mockDb = {
      select: mockSelect,
      update: mockUpdateFn,
      transaction: mockTransaction,
    } as unknown as MockDb;

    const result = await claimConversation("user-42", "tok-1", { db: mockDb });

    expect(result).toEqual({ claimed: true });

    // Transaction was used for the two updates
    expect(mockTransaction).toHaveBeenCalledTimes(1);

    // Two updates inside the transaction: one for conversation, one for user
    expect(mockUpdateFn).toHaveBeenCalledTimes(2);

    // Conversation update: sets userId and clears claimToken
    expect(convSet).toHaveBeenCalledWith(
      expect.objectContaining({ userId: "user-42", claimToken: null }),
    );

    // User update: carry-over sets creditsUsed=1
    expect(userSet).toHaveBeenCalledWith(
      expect.objectContaining({ creditsUsed: 1 }),
    );
  });

  it("rejects a double-claim (no matching unclaimed row): returns {claimed:false}, no updates", async () => {
    const mockLimit = vi.fn().mockResolvedValue([]); // no row found
    const mockWhere2 = vi.fn().mockReturnValue({ limit: mockLimit });
    const mockFrom = vi.fn().mockReturnValue({ where: mockWhere2 });
    const mockSelect = vi.fn().mockReturnValue({ from: mockFrom });

    const mockUpdateFn = vi.fn();
    const mockTransaction = vi.fn();

    const mockDb = {
      select: mockSelect,
      update: mockUpdateFn,
      transaction: mockTransaction,
    } as unknown as MockDb;

    const result = await claimConversation("user-42", "tok-wrong", {
      db: mockDb,
    });

    expect(result).toEqual({ claimed: false });
    expect(mockUpdateFn).not.toHaveBeenCalled();
    expect(mockTransaction).not.toHaveBeenCalled();
  });

  it("M7: treats a lost race (self-guarded UPDATE affects 0 rows) as not-claimed and skips the credit carry-over", async () => {
    // SELECT finds an unclaimed row...
    const mockLimit = vi
      .fn()
      .mockResolvedValue([
        { id: "conv-race", userId: null, claimToken: "tok-race" },
      ]);
    const mockWhere2 = vi.fn().mockReturnValue({ limit: mockLimit });
    const mockFrom = vi.fn().mockReturnValue({ where: mockWhere2 });
    const mockSelect = vi.fn().mockReturnValue({ from: mockFrom });

    // ...but the self-guarded UPDATE (AND userId IS NULL) affects 0 rows
    // because a concurrent claim won the race → returning() yields [].
    const convReturning = vi.fn().mockResolvedValue([]);
    const convWhere = vi.fn().mockReturnValue({ returning: convReturning });
    const convSet = vi.fn().mockReturnValue({ where: convWhere });
    const userSet = vi.fn(); // must NOT be called

    let callCount = 0;
    const mockUpdateFn = vi.fn().mockImplementation(() => {
      callCount++;
      return { set: callCount === 1 ? convSet : userSet };
    });

    const mockTransaction = vi
      .fn()
      .mockImplementation(async (cb: (tx: unknown) => Promise<void>) => {
        await cb({ update: mockUpdateFn });
      });

    const mockDb = {
      select: mockSelect,
      update: mockUpdateFn,
      transaction: mockTransaction,
    } as unknown as MockDb;

    const result = await claimConversation("user-late", "tok-race", {
      db: mockDb,
    });

    // Race-safe: not claimed, and the credit carry-over update never ran.
    expect(result).toEqual({ claimed: false });
    expect(convSet).toHaveBeenCalledTimes(1);
    expect(userSet).not.toHaveBeenCalled();
  });

  it("does not throw when given an already-claimed token: returns {claimed:false}", async () => {
    // WHERE userId IS NULL means an already-claimed row won't match — select returns []
    const mockLimit = vi.fn().mockResolvedValue([]);
    const mockWhere2 = vi.fn().mockReturnValue({ limit: mockLimit });
    const mockFrom = vi.fn().mockReturnValue({ where: mockWhere2 });
    const mockSelect = vi.fn().mockReturnValue({ from: mockFrom });
    const mockUpdateFn = vi.fn();
    const mockTransaction = vi.fn();

    const mockDb = {
      select: mockSelect,
      update: mockUpdateFn,
      transaction: mockTransaction,
    } as unknown as MockDb;

    await expect(
      claimConversation("user-99", "already-claimed-token", { db: mockDb }),
    ).resolves.toEqual({ claimed: false });
  });
});

// ---------------------------------------------------------------------------
// gcUnclaimedAnon
// ---------------------------------------------------------------------------

describe("gcUnclaimedAnon", () => {
  it("deletes inactive unclaimed rows older than the cutoff and returns the count", async () => {
    // L5: the delete now ends in .returning() so the count is truthful.
    const mockReturning = vi.fn().mockResolvedValue([{ id: "a" }, { id: "b" }]);
    const mockWhere = vi.fn().mockReturnValue({ returning: mockReturning });
    const mockDelete = vi.fn().mockReturnValue({ where: mockWhere });

    const mockDb = { delete: mockDelete } as unknown as MockDb;

    const cutoff = new Date("2026-01-01T00:00:00Z");
    const count = await gcUnclaimedAnon(cutoff, { db: mockDb });

    expect(count).toBe(2);
    expect(mockDelete).toHaveBeenCalledTimes(1);
    expect(mockWhere).toHaveBeenCalledTimes(1);
    expect(mockReturning).toHaveBeenCalledTimes(1);
    // Assert a composed WHERE predicate was passed (not a no-op undefined/null)
    expect(mockWhere.mock.calls[0][0]).toBeTruthy();
  });

  it("returns 0 when no rows are deleted", async () => {
    const mockReturning = vi.fn().mockResolvedValue([]);
    const mockWhere = vi.fn().mockReturnValue({ returning: mockReturning });
    const mockDelete = vi.fn().mockReturnValue({ where: mockWhere });
    const mockDb = { delete: mockDelete } as unknown as MockDb;

    const count = await gcUnclaimedAnon(new Date(), { db: mockDb });
    expect(count).toBe(0);
  });
});
