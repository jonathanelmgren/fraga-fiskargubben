/**
 * persist-turns.test.ts — covers the turn-persistence helpers.
 *
 * Resumable-streams split: the user turn is persisted up-front by the route
 * (persistUserTurn), the assistant turn after finalMessage() settles
 * (persistAssistantTurn). These exercise the branching: happy path, empty
 * assistant text, finalMessage() rejection, the credit-refund contract
 * (ADR-0004) and the M11 contract that lastActiveAt always rolls forward.
 */

import { describe, expect, it, vi } from "vitest";
import {
  type PersistTurnsDeps,
  persistAssistantTurn,
  persistUserTurn,
} from "./persist-turns";

function makeDeps(overrides: Partial<PersistTurnsDeps> = {}): PersistTurnsDeps {
  return {
    persistMessage: vi.fn().mockResolvedValue(undefined),
    updateLastActive: vi.fn().mockResolvedValue(undefined),
    emit: vi.fn().mockResolvedValue(undefined),
    refundCredit: vi.fn().mockResolvedValue(true),
    ...overrides,
  };
}

function streamRejecting(err = new Error("stream boom")) {
  return { finalMessage: vi.fn().mockRejectedValue(err) };
}

function streamReturning(text: string) {
  return {
    finalMessage: vi
      .fn()
      .mockResolvedValue({ content: [{ type: "text", text }] }),
  };
}

describe("persistUserTurn", () => {
  it("persists the user message", async () => {
    const deps = makeDeps();

    await persistUserTurn(deps, {
      conversationId: "conv-1",
      message: "Vad biter?",
    });

    expect(deps.persistMessage).toHaveBeenCalledWith({
      conversationId: "conv-1",
      role: "user",
      content: "Vad biter?",
    });
    expect(deps.emit).not.toHaveBeenCalled();
  });

  it("never throws — emits persistence_failure when the write fails", async () => {
    const deps = makeDeps({
      persistMessage: vi.fn().mockRejectedValue(new Error("db down")),
    });

    await expect(
      persistUserTurn(deps, { conversationId: "conv-1", message: "Vad biter?" }),
    ).resolves.toBeUndefined();

    expect(deps.emit).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "persistence_failure",
        conversationId: "conv-1",
        payload: expect.objectContaining({
          reason: expect.stringContaining("db down"),
        }),
      }),
    );
  });
});

describe("persistAssistantTurn", () => {
  it("happy path persists the assistant turn and rolls lastActiveAt", async () => {
    const deps = makeDeps();

    await persistAssistantTurn(deps, {
      conversationId: "conv-1",
      stream: streamReturning("Prova maskkroken."),
    });

    // ONLY the assistant turn — the user turn is written up-front by the route.
    expect(deps.persistMessage).toHaveBeenCalledTimes(1);
    expect(deps.persistMessage).toHaveBeenCalledWith({
      conversationId: "conv-1",
      role: "assistant",
      content: "Prova maskkroken.",
    });
    expect(deps.updateLastActive).toHaveBeenCalledWith("conv-1");
    expect(deps.emit).not.toHaveBeenCalled();
  });

  it("skips the insert when assistantText is empty", async () => {
    const deps = makeDeps();

    await persistAssistantTurn(deps, {
      conversationId: "conv-1",
      stream: streamReturning(""),
    });

    expect(deps.persistMessage).not.toHaveBeenCalled();
    expect(deps.updateLastActive).toHaveBeenCalledWith("conv-1");
  });

  it("emits exactly one persistence_failure and does not throw when finalMessage rejects", async () => {
    const deps = makeDeps();

    await expect(
      persistAssistantTurn(deps, {
        conversationId: "conv-1",
        stream: streamRejecting(new Error("stream broke")),
      }),
    ).resolves.toBeUndefined();

    expect(deps.emit).toHaveBeenCalledTimes(1);
    expect(deps.emit).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "persistence_failure",
        conversationId: "conv-1",
        payload: expect.objectContaining({ reason: "stream broke" }),
      }),
    );
    expect(deps.persistMessage).not.toHaveBeenCalled();
  });

  it("still rolls lastActiveAt forward even when finalMessage rejects (M11)", async () => {
    const deps = makeDeps();

    await persistAssistantTurn(deps, {
      conversationId: "conv-1",
      stream: streamRejecting(),
    });

    expect(deps.updateLastActive).toHaveBeenCalledWith("conv-1");
  });

  it("emits persistence_failure with reason when persistMessage rejects", async () => {
    const deps = makeDeps({
      persistMessage: vi.fn().mockRejectedValue(new Error("db down")),
    });

    await persistAssistantTurn(deps, {
      conversationId: "conv-1",
      stream: streamReturning("svar"),
    });

    expect(deps.emit).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "persistence_failure",
        payload: expect.objectContaining({ reason: "db down" }),
      }),
    );
  });

  // C-refund: a failed first-turn Sonnet answer must not consume a credit.
  it("refunds the credit when the stream fails and refundUserId is set", async () => {
    const deps = makeDeps();

    await persistAssistantTurn(deps, {
      conversationId: "conv-1",
      stream: streamRejecting(),
      refundUserId: "user-42",
    });

    expect(deps.refundCredit).toHaveBeenCalledWith("user-42");
  });

  it("does NOT refund when the stream SUCCEEDS", async () => {
    const deps = makeDeps();

    await persistAssistantTurn(deps, {
      conversationId: "conv-1",
      stream: streamReturning("Prova maskkroken."),
      refundUserId: "user-42",
    });

    expect(deps.refundCredit).not.toHaveBeenCalled();
  });

  it("does NOT refund when refundUserId is absent (follow-up / free turn)", async () => {
    const deps = makeDeps();

    await persistAssistantTurn(deps, {
      conversationId: "conv-1",
      stream: streamRejecting(),
    });

    expect(deps.refundCredit).not.toHaveBeenCalled();
  });

  it("does not throw when refundCredit itself rejects; emits persistence_failure", async () => {
    const deps = makeDeps({
      refundCredit: vi.fn().mockRejectedValue(new Error("refund down")),
    });

    await persistAssistantTurn(deps, {
      conversationId: "conv-1",
      stream: streamRejecting(),
      refundUserId: "user-42",
    });

    expect(deps.emit).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "persistence_failure",
        payload: expect.objectContaining({
          reason: expect.stringContaining("refundCredit"),
        }),
      }),
    );
  });
});
