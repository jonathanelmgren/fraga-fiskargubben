/**
 * stream-registry.ts — in-memory registry for resumable advice streams.
 *
 * Decouples advice generation from the HTTP connection: startStream() spawns a
 * detached consumer that reads the (already text-only, post-toTextStream)
 * source to completion, so a client disconnect never aborts the Anthropic
 * stream — persistAssistantTurn's finalMessage() always settles. The POST
 * response body and the GET /api/ask/stream re-attach endpoint are both plain
 * subscribers created via subscribe().
 *
 * Deployment assumption (see the resumable-chat-streams design spec): a single
 * long-running Node process. State lives on a globalThis symbol so dev HMR /
 * route-module re-evaluation reuses one map instead of duplicating it. A
 * process restart drops in-flight entries; clients fall back to the DB view.
 *
 * Offsets are UTF-16 code units (`string.length`) — the same unit the client
 * measures its partially rendered message in. Bytes only exist on the wire.
 */

import "server-only";

/** Thrown when a conversation already has a live stream (double-submit). */
export class StreamConflictError extends Error {
  constructor(conversationId: string) {
    super(`conversation ${conversationId} already has an active stream`);
    this.name = "StreamConflictError";
  }
}

type Subscriber = {
  enqueue(text: string): void;
  close(): void;
  error(err: unknown): void;
};

type ActiveStream = {
  text: string;
  status: "streaming" | "done" | "error";
  error?: unknown;
  subscribers: Set<Subscriber>;
  graceTimer?: ReturnType<typeof setTimeout>;
  ttlTimer: ReturnType<typeof setTimeout>;
  /** Cancels the consumer's source read on hard-TTL force-error. */
  abort: AbortController;
};

/** Keep settled entries replayable for late re-attach before DB fallback. */
const GRACE_MS = 5 * 60_000;
/** Safety net against a wedged upstream that never ends its stream. */
const HARD_TTL_MS = 15 * 60_000;

const REGISTRY_KEY = Symbol.for("fiskargubben.stream-registry");

type GlobalWithRegistry = typeof globalThis & {
  [REGISTRY_KEY]?: Map<string, ActiveStream>;
};

function registry(): Map<string, ActiveStream> {
  const g = globalThis as GlobalWithRegistry;
  g[REGISTRY_KEY] ??= new Map();
  return g[REGISTRY_KEY];
}

/**
 * Register a conversation's advice stream and start the detached consumer.
 * Throws StreamConflictError while a previous stream is still live; a settled
 * leftover entry (done/error within its grace window) is replaced.
 */
export function startStream(
  conversationId: string,
  source: ReadableStream<Uint8Array>,
): void {
  const map = registry();
  const existing = map.get(conversationId);
  if (existing) {
    if (existing.status === "streaming") {
      throw new StreamConflictError(conversationId);
    }
    evict(conversationId, existing);
  }

  const entry: ActiveStream = {
    text: "",
    status: "streaming",
    subscribers: new Set(),
    abort: new AbortController(),
    ttlTimer: setTimeout(() => {
      entry.abort.abort();
      settle(
        conversationId,
        entry,
        "error",
        new Error("advice stream exceeded hard TTL"),
      );
    }, HARD_TTL_MS),
  };
  map.set(conversationId, entry);
  void consume(conversationId, entry, source);
}

/**
 * Subscribe from a UTF-16 offset: the backlog is enqueued immediately, then
 * live chunks until the entry settles. Cancelling only unsubscribes — the
 * consumer is unaffected. Returns null when the conversation has no entry
 * (never started, restarted process, or evicted after the grace window).
 */
export function subscribe(
  conversationId: string,
  offset: number,
): ReadableStream<Uint8Array> | null {
  const entry = registry().get(conversationId);
  if (!entry) return null;

  const encoder = new TextEncoder();
  let sub: Subscriber | null = null;

  return new ReadableStream<Uint8Array>({
    start(controller) {
      const backlog = entry.text.slice(Math.max(0, offset));
      if (backlog) controller.enqueue(encoder.encode(backlog));
      if (entry.status === "done") {
        controller.close();
        return;
      }
      if (entry.status === "error") {
        controller.error(entry.error);
        return;
      }
      sub = {
        enqueue: (text) => controller.enqueue(encoder.encode(text)),
        close: () => controller.close(),
        error: (err) => controller.error(err),
      };
      entry.subscribers.add(sub);
    },
    cancel() {
      if (sub) entry.subscribers.delete(sub);
    },
  });
}

/** True while the conversation's stream is still generating. */
export function isActive(conversationId: string): boolean {
  return registry().get(conversationId)?.status === "streaming";
}

/** Test hook: drop all entries and their timers. */
export function resetRegistryForTests(): void {
  const map = registry();
  for (const [id, entry] of map) {
    clearTimeout(entry.ttlTimer);
    if (entry.graceTimer) clearTimeout(entry.graceTimer);
    entry.abort.abort();
    map.delete(id);
  }
}

async function consume(
  conversationId: string,
  entry: ActiveStream,
  source: ReadableStream<Uint8Array>,
): Promise<void> {
  const decoder = new TextDecoder();
  const reader = source.getReader();
  const onAbort = () => void reader.cancel().catch(() => {});
  entry.abort.signal.addEventListener("abort", onAbort, { once: true });
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      append(entry, decoder.decode(value, { stream: true }));
    }
    append(entry, decoder.decode());
    settle(conversationId, entry, "done");
  } catch (err) {
    settle(conversationId, entry, "error", err);
  } finally {
    entry.abort.signal.removeEventListener("abort", onAbort);
  }
}

function append(entry: ActiveStream, text: string): void {
  if (!text) return;
  entry.text += text;
  for (const sub of entry.subscribers) {
    try {
      sub.enqueue(text);
    } catch {
      // Subscriber's controller is gone (cancelled mid-enqueue) — drop it.
      entry.subscribers.delete(sub);
    }
  }
}

function settle(
  conversationId: string,
  entry: ActiveStream,
  status: "done" | "error",
  err?: unknown,
): void {
  if (entry.status !== "streaming") return;
  entry.status = status;
  entry.error = err;
  clearTimeout(entry.ttlTimer);
  for (const sub of entry.subscribers) {
    try {
      if (status === "done") sub.close();
      else sub.error(err);
    } catch {
      // controller already closed/errored — nothing to do
    }
  }
  entry.subscribers.clear();
  entry.graceTimer = setTimeout(
    () => evict(conversationId, entry),
    GRACE_MS,
  );
}

function evict(conversationId: string, entry: ActiveStream): void {
  clearTimeout(entry.ttlTimer);
  if (entry.graceTimer) clearTimeout(entry.graceTimer);
  // Only remove the map slot if it still holds THIS entry (a replacement may
  // have taken the key in the meantime).
  const map = registry();
  if (map.get(conversationId) === entry) map.delete(conversationId);
}
