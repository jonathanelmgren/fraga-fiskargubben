/**
 * persist-turns.test.ts — covers the post-stream persistence helper (H3a/M11).
 *
 * The after() body in route.ts had zero tests despite being the ONLY place
 * user+assistant turns and lastActiveAt are written. These exercise the
 * branching: happy path, empty assistant text, finalMessage() rejection, and
 * the M11 contract that lastActiveAt always rolls forward.
 */

import { describe, expect, it, vi } from "vitest";
import { type PersistTurnsDeps, persistTurns } from "./persist-turns";

function makeDeps(overrides: Partial<PersistTurnsDeps> = {}): PersistTurnsDeps {
  return {
    persistMessage: vi.fn().mockResolvedValue(undefined),
    updateLastActive: vi.fn().mockResolvedValue(undefined),
    emit: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}

function streamReturning(text: string) {
  return {
    finalMessage: vi
      .fn()
      .mockResolvedValue({ content: [{ type: "text", text }] }),
  };
}

describe("persistTurns", () => {
  it("happy path persists user + assistant turns and rolls lastActiveAt", async () => {
    const deps = makeDeps();

    await persistTurns(deps, {
      conversationId: "conv-1",
      message: "Vad biter?",
      stream: streamReturning("Prova maskkroken."),
    });

    expect(deps.persistMessage).toHaveBeenCalledWith({
      conversationId: "conv-1",
      role: "user",
      content: "Vad biter?",
    });
    expect(deps.persistMessage).toHaveBeenCalledWith({
      conversationId: "conv-1",
      role: "assistant",
      content: "Prova maskkroken.",
    });
    expect(deps.updateLastActive).toHaveBeenCalledWith("conv-1");
    expect(deps.emit).not.toHaveBeenCalled();
  });

  it("skips the assistant insert when assistantText is empty", async () => {
    const deps = makeDeps();

    await persistTurns(deps, {
      conversationId: "conv-1",
      message: "Vad biter?",
      stream: streamReturning(""),
    });

    // user persisted, assistant skipped
    expect(deps.persistMessage).toHaveBeenCalledTimes(1);
    expect(deps.persistMessage).toHaveBeenCalledWith({
      conversationId: "conv-1",
      role: "user",
      content: "Vad biter?",
    });
    expect(deps.updateLastActive).toHaveBeenCalledWith("conv-1");
  });

  it("emits exactly one persistence_failure and does not throw when finalMessage rejects (M11)", async () => {
    const deps = makeDeps();
    const stream = {
      finalMessage: vi.fn().mockRejectedValue(new Error("stream broke")),
    };

    await expect(
      persistTurns(deps, {
        conversationId: "conv-1",
        message: "Vad biter?",
        stream,
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
    // M11: no user-without-assistant — nothing is persisted before finalMessage
    // resolves, so neither turn is written on a stream that never finalized.
    expect(deps.persistMessage).not.toHaveBeenCalled();
  });

  it("still rolls lastActiveAt forward even when finalMessage rejects (M11)", async () => {
    const deps = makeDeps();
    const stream = {
      finalMessage: vi.fn().mockRejectedValue(new Error("stream broke")),
    };

    await persistTurns(deps, {
      conversationId: "conv-1",
      message: "Vad biter?",
      stream,
    });

    expect(deps.updateLastActive).toHaveBeenCalledWith("conv-1");
  });

  it("emits persistence_failure with reason when persistMessage rejects", async () => {
    const deps = makeDeps({
      persistMessage: vi.fn().mockRejectedValue(new Error("db down")),
    });

    await persistTurns(deps, {
      conversationId: "conv-1",
      message: "Vad biter?",
      stream: streamReturning("svar"),
    });

    expect(deps.emit).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "persistence_failure",
        payload: expect.objectContaining({ reason: "db down" }),
      }),
    );
  });
});
