import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
vi.mock("@/shared/db/client", () => ({ db: {} }));

import type { Db } from "@/shared/db/client";
import {
  claimConversation,
  createAnonConversation,
  gcUnclaimedAnon,
} from "./anon";

// ---------------------------------------------------------------------------
// Shared type alias for mock db
// ---------------------------------------------------------------------------

type MockDb = Pick<Db, "insert" | "update" | "delete" | "select">;

// ---------------------------------------------------------------------------
// createAnonConversation
// ---------------------------------------------------------------------------

describe("createAnonConversation", () => {
  it("inserts a conversations row with userId=null and a non-empty claimToken", async () => {
    const mockValues = vi.fn().mockResolvedValue([{ id: "conv-new" }]);
    const mockInsert = vi.fn().mockReturnValue({ values: mockValues });
    const mockDb = { insert: mockInsert } as unknown as MockDb;

    const result = await createAnonConversation({}, { db: mockDb });

    expect(result.conversationId).toBe("conv-new");
    expect(result.claimToken).toBeTruthy();
    expect(result.claimToken.length).toBeGreaterThan(10);

    // Assert the insert was called with userId=null
    expect(mockInsert).toHaveBeenCalledTimes(1);
    const insertedValues = mockValues.mock.calls[0][0] as Record<
      string,
      unknown
    >;
    expect(insertedValues.userId).toBeNull();
    expect(insertedValues.claimToken).toBe(result.claimToken);
  });

  it("generates different tokens on each call (unguessable)", async () => {
    const makeMock = () => {
      const mockValues = vi.fn().mockResolvedValue([{ id: "conv-x" }]);
      const mockInsert = vi.fn().mockReturnValue({ values: mockValues });
      return { mockInsert };
    };

    const { mockInsert: ins1 } = makeMock();
    const { mockInsert: ins2 } = makeMock();

    const db1 = { insert: ins1 } as unknown as MockDb;
    const db2 = { insert: ins2 } as unknown as MockDb;

    const r1 = await createAnonConversation({}, { db: db1 });
    const r2 = await createAnonConversation({}, { db: db2 });

    expect(r1.claimToken).not.toBe(r2.claimToken);

    // Tokens should look like UUIDs or hex strings
    expect(r1.claimToken).toMatch(/^[0-9a-f-]{32,}$/i);
    expect(r2.claimToken).toMatch(/^[0-9a-f-]{32,}$/i);
  });

  it("passes lakeId and targetTime into the insert when provided", async () => {
    const mockValues = vi.fn().mockResolvedValue([{ id: "conv-lake" }]);
    const mockInsert = vi.fn().mockReturnValue({ values: mockValues });
    const mockDb = { insert: mockInsert } as unknown as MockDb;

    const targetTime = new Date("2026-07-01T10:00:00Z");
    await createAnonConversation(
      { lakeId: "SE123", targetTime },
      { db: mockDb },
    );

    const inserted = mockValues.mock.calls[0][0] as Record<string, unknown>;
    expect(inserted.lakeId).toBe("SE123");
    expect(inserted.targetTime).toEqual(targetTime);
  });
});

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

    // Track two update calls: first for conversation, second for user
    const convWhere = vi.fn().mockResolvedValue(undefined);
    const convSet = vi.fn().mockReturnValue({ where: convWhere });
    const userWhere = vi.fn().mockResolvedValue(undefined);
    const userSet = vi.fn().mockReturnValue({ where: userWhere });

    let callCount = 0;
    const mockUpdateFn = vi.fn().mockImplementation(() => {
      callCount++;
      return { set: callCount === 1 ? convSet : userSet };
    });

    const mockDb = {
      select: mockSelect,
      update: mockUpdateFn,
    } as unknown as MockDb;

    const result = await claimConversation("user-42", "tok-1", { db: mockDb });

    expect(result).toEqual({ claimed: true });

    // Two updates: one for conversation, one for user
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

    const mockDb = {
      select: mockSelect,
      update: mockUpdateFn,
    } as unknown as MockDb;

    const result = await claimConversation("user-42", "tok-wrong", {
      db: mockDb,
    });

    expect(result).toEqual({ claimed: false });
    expect(mockUpdateFn).not.toHaveBeenCalled();
  });

  it("does not throw when given an already-claimed token: returns {claimed:false}", async () => {
    // WHERE userId IS NULL means an already-claimed row won't match — select returns []
    const mockLimit = vi.fn().mockResolvedValue([]);
    const mockWhere2 = vi.fn().mockReturnValue({ limit: mockLimit });
    const mockFrom = vi.fn().mockReturnValue({ where: mockWhere2 });
    const mockSelect = vi.fn().mockReturnValue({ from: mockFrom });
    const mockUpdateFn = vi.fn();

    const mockDb = {
      select: mockSelect,
      update: mockUpdateFn,
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
  it("deletes unclaimed rows older than the cutoff and returns the count", async () => {
    const mockWhere = vi.fn().mockResolvedValue([{}, {}]); // 2 deleted rows
    const mockDelete = vi.fn().mockReturnValue({ where: mockWhere });

    const mockDb = { delete: mockDelete } as unknown as MockDb;

    const cutoff = new Date("2026-01-01T00:00:00Z");
    const count = await gcUnclaimedAnon(cutoff, { db: mockDb });

    expect(count).toBe(2);
    expect(mockDelete).toHaveBeenCalledTimes(1);
    expect(mockWhere).toHaveBeenCalledTimes(1);
  });

  it("returns 0 when no rows are deleted", async () => {
    const mockWhere = vi.fn().mockResolvedValue([]);
    const mockDelete = vi.fn().mockReturnValue({ where: mockWhere });
    const mockDb = { delete: mockDelete } as unknown as MockDb;

    const count = await gcUnclaimedAnon(new Date(), { db: mockDb });
    expect(count).toBe(0);
  });
});
