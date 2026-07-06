/**
 * stream-registry.test.ts — in-memory registry for resumable advice streams.
 *
 * Covers the contracts the resumable-streams design leans on: the detached
 * consumer keeps reading regardless of subscribers, offset replay matches
 * UTF-16 string semantics, settled entries stay replayable through the grace
 * window, and double-starts are rejected (the registry doubles as the
 * double-submit lock).
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import {
  isActive,
  resetRegistryForTests,
  startStream,
  StreamConflictError,
  subscribe,
} from "./stream-registry";

const encoder = new TextEncoder();
const decoder = new TextDecoder();

/** A manually driven Uint8Array source (the post-toTextStream readable). */
function manualSource() {
  let controller!: ReadableStreamDefaultController<Uint8Array>;
  const stream = new ReadableStream<Uint8Array>({
    start(c) {
      controller = c;
    },
  });
  return {
    stream,
    push: (text: string) => controller.enqueue(encoder.encode(text)),
    end: () => controller.close(),
    fail: (err: unknown) => controller.error(err),
  };
}

/** Drain a subscriber stream to a string (resolves when it closes). */
async function drain(stream: ReadableStream<Uint8Array>): Promise<string> {
  const reader = stream.getReader();
  let out = "";
  for (;;) {
    const { value, done } = await reader.read();
    if (done) return out;
    out += decoder.decode(value, { stream: true });
  }
}

/** Let queued microtasks/consumer reads settle. */
async function tick() {
  await new Promise((r) => setTimeout(r, 0));
}

beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
});

afterEach(() => {
  resetRegistryForTests();
  vi.useRealTimers();
});

describe("startStream / consumer", () => {
  it("accumulates chunks and closes subscribers when the source ends", async () => {
    const src = manualSource();
    startStream("conv-1", src.stream);

    const sub = subscribe("conv-1", 0);
    expect(sub).not.toBeNull();
    // biome-ignore lint/style/noNonNullAssertion: asserted above
    const drained = drain(sub!);

    src.push("Prova ");
    src.push("maskkroken.");
    src.end();

    await expect(drained).resolves.toBe("Prova maskkroken.");
  });

  it("keeps consuming when the only subscriber cancels (client disconnect)", async () => {
    const src = manualSource();
    startStream("conv-1", src.stream);

    const sub = subscribe("conv-1", 0);
    // biome-ignore lint/style/noNonNullAssertion: entry just registered
    const reader = sub!.getReader();
    src.push("Första biten. ");
    await tick();
    await reader.cancel();

    // Generation continues after the disconnect…
    src.push("Andra biten.");
    src.end();
    await tick();

    // …and a late subscriber replays the FULL text.
    const late = subscribe("conv-1", 0);
    expect(late).not.toBeNull();
    // biome-ignore lint/style/noNonNullAssertion: asserted above
    await expect(drain(late!)).resolves.toBe("Första biten. Andra biten.");
  });

  it("rejects a second start while the first is streaming", async () => {
    const src = manualSource();
    startStream("conv-1", src.stream);
    expect(() => startStream("conv-1", manualSource().stream)).toThrow(
      StreamConflictError,
    );
    src.end();
  });

  it("allows a new start after the previous stream settled", async () => {
    const first = manualSource();
    startStream("conv-1", first.stream);
    first.end();
    await tick();

    const second = manualSource();
    expect(() => startStream("conv-1", second.stream)).not.toThrow();
    second.push("ny runda");
    second.end();
    // biome-ignore lint/style/noNonNullAssertion: entry just registered
    await expect(drain(subscribe("conv-1", 0)!)).resolves.toBe("ny runda");
  });
});

describe("subscribe", () => {
  it("returns null for an unknown conversation", () => {
    expect(subscribe("nope", 0)).toBeNull();
  });

  it("replays from a UTF-16 offset then continues live", async () => {
    const src = manualSource();
    startStream("conv-1", src.stream);
    src.push("abcdef");
    await tick();

    const sub = subscribe("conv-1", 3);
    // biome-ignore lint/style/noNonNullAssertion: entry just registered
    const drained = drain(sub!);
    src.push("ghi");
    src.end();

    await expect(drained).resolves.toBe("defghi");
  });

  it("clamps an offset past the end to an empty backlog", async () => {
    const src = manualSource();
    startStream("conv-1", src.stream);
    src.push("kort");
    src.end();
    await tick();

    // biome-ignore lint/style/noNonNullAssertion: entry in grace window
    await expect(drain(subscribe("conv-1", 999)!)).resolves.toBe("");
  });

  it("errors subscribers when the source fails, and late subscribers too", async () => {
    const src = manualSource();
    startStream("conv-1", src.stream);
    const sub = subscribe("conv-1", 0);
    // biome-ignore lint/style/noNonNullAssertion: entry just registered
    const drained = drain(sub!);

    src.fail(new Error("upstream boom"));
    await expect(drained).rejects.toThrow("upstream boom");
    await tick();

    const late = subscribe("conv-1", 0);
    expect(late).not.toBeNull();
    // biome-ignore lint/style/noNonNullAssertion: asserted above
    await expect(drain(late!)).rejects.toThrow("upstream boom");
  });
});

describe("lifecycle / eviction", () => {
  it("isActive is true only while streaming", async () => {
    const src = manualSource();
    startStream("conv-1", src.stream);
    expect(isActive("conv-1")).toBe(true);
    src.end();
    await tick();
    expect(isActive("conv-1")).toBe(false);
  });

  it("evicts the entry after the grace window", async () => {
    const src = manualSource();
    startStream("conv-1", src.stream);
    src.push("klart");
    src.end();
    await tick();

    expect(subscribe("conv-1", 0)).not.toBeNull();
    await vi.advanceTimersByTimeAsync(5 * 60_000 + 1000);
    expect(subscribe("conv-1", 0)).toBeNull();
  });

  it("force-errors a wedged stream at the hard TTL", async () => {
    const src = manualSource();
    startStream("conv-1", src.stream);
    src.push("halvvägs");
    await tick();

    await vi.advanceTimersByTimeAsync(15 * 60_000 + 1000);
    expect(isActive("conv-1")).toBe(false);
    const sub = subscribe("conv-1", 0);
    // Entry is in error grace: backlog replays, then the stream errors.
    expect(sub).not.toBeNull();
    // biome-ignore lint/style/noNonNullAssertion: asserted above
    await expect(drain(sub!)).rejects.toThrow();
  });
});
