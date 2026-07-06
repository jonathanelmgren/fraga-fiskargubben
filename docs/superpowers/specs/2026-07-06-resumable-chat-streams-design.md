# Resumable chat streams — design

**Date:** 2026-07-06
**Status:** Approved (chat brainstorm)

## Problem

`POST /api/ask` pipes the Anthropic `MessageStream` straight into the HTTP
response body. When the client disconnects mid-stream (phone locked, tab
backgrounded, flaky network), body cancellation propagates back through
`toTextStream` into the SDK stream, the upstream request aborts,
`finalMessage()` rejects, and `persistTurns` saves **neither** the user nor the
assistant turn. The client shows "Något gick snett…" and the whole turn is
lost.

Goals:

1. Generation completes and is persisted regardless of client connection.
2. The client can seamlessly re-attach mid-generation (tab resume AND full
   page reload) and see text generated while away, then continue live.
3. The user message is never lost, even when the assistant turn fails.

Deployment context: **single long-running Node process on a VPS** (next
start / Docker). In-memory state is authoritative for in-flight streams; no
Redis. A process restart loses in-flight generations — accepted (rare;
client falls back gracefully).

## Architecture

### 1. Stream registry — `src/lib/chat/stream-registry.ts`

Module that owns all in-flight advice streams. State lives on
`globalThis[Symbol.for("fiskargubben.stream-registry")]` so dev HMR /
route-module re-evaluation does not duplicate it.

```ts
type ActiveStream = {
  conversationId: string;
  text: string;            // accumulated visible answer (UTF-16 string)
  status: "streaming" | "done" | "error";
  subscribers: Set<Subscriber>;
  // eviction bookkeeping (timers)
};
```

API:

- `startStream(conversationId, source: ReadableStream<Uint8Array>, hooks: { onFinish(): void })`
  Registers the entry and spawns a **detached consumer loop** that reads the
  (already text-only, post-`toTextStream`) source to completion, decoding to
  string and appending to `entry.text`, notifying subscribers per chunk. On
  source end → `status = "done"`, notify, call `hooks.onFinish()`. On source
  error → `status = "error"`, error subscribers. Client connections never
  influence this loop.
  Throws `StreamConflictError` if the conversation already has an active
  entry (double-submit lock).
- `subscribe(conversationId, offset): ReadableStream<Uint8Array> | null`
  `null` when no entry. Otherwise a stream that immediately enqueues
  `text.slice(offset)` (UTF-16 code-unit offset — matches the client's
  `message.text.length`), then live chunks until done. Cancelling it only
  unsubscribes. If the entry is/becomes `"error"`, the stream errors.
- `isActive(conversationId): boolean` — `status === "streaming"`.
- `hasEntry(conversationId): boolean` — includes done-but-not-evicted.

Eviction: entry removed **5 min after** reaching `done`/`error` (grace window
for late re-attach; DB is source of truth afterwards) and a hard 15-min TTL
from start as a safety net against a wedged upstream.

Offsets are UTF-16 code units on both sides (JS `string.length`); the wire is
UTF-8 bytes, decoded with `TextDecoder(stream: true)` — same as today.

### 2. `POST /api/ask` (route.ts) changes — stream branch only

- **409 double-submit guard:** before `handleAsk`, if a `conversationId` was
  supplied and `registry.isActive(conversationId)` → `409 { type: "busy" }`.
- **Persist the user turn immediately** (await, before returning the
  response) instead of inside `persistTurns`. A failed assistant turn no
  longer erases the user's question.
- Pipe `toTextStream(result.stream.toReadableStream())` into
  `registry.startStream(...)` instead of into the response body.
- Response body = `registry.subscribe(convId, 0)`. Headers (Content-Type,
  X-Conversation-Id, X-Signals, Set-Cookie claim token) unchanged.
- Persistence of the assistant turn moves from `after()` to the registry's
  `onFinish` hook (a detached task on a long-running Node server): it calls
  the refactored `persistTurns` which awaits `finalMessage()` (now resolves
  even when every client is gone), writes the assistant message, emits
  `llm_usage`, refunds the credit on failure, rolls `lastActiveAt` — same
  contract, minus the user-message write.
- Clarify + gate branches unchanged.

### 3. `GET /api/ask/stream` — new route `src/app/api/ask/stream/route.ts`

Query: `conversationId` (UUID-validated), `offset` (int ≥ 0, default 0).

- Ownership check identical to `loadConversationView`: logged-in owner OR
  anon with matching HMAC-verified `fiska_claim` cookie. Unknown/foreign →
  404 (no existence leak).
- `registry.subscribe(conversationId, offset)`; `null` → 404 (client falls
  back to reload-from-DB). Otherwise `200 text/plain; charset=utf-8` stream.
- Read-only, cookie-authed GET: SOP prevents cross-site reads; no CSRF guard
  needed.

### 4. Server page → client handoff

`loadConversationView` gains `activeStream: boolean` (from
`registry.isActive(id)`). `/ask/[id]/page.tsx` passes it to `Chat` as
`initialActiveStream`. On mount with that flag, Chat appends an empty
`streaming: true` assistant bubble and attaches via GET with `offset = 0`
(the user turn is already in `initialMessages` since it is persisted
up-front; the assistant turn is not yet in the DB, so no duplication).

### 5. Client (`chat.tsx`)

New shared helper `readStreamInto(reader, msgId)` used by both the POST body
and the GET re-attach reader loops (identical chunk-append logic).

`attachToStream(conversationId, msgId, offset)`:

- `fetch("/api/ask/stream?...")`; 404 → return `"gone"`; otherwise read to
  completion → `"done"`; throw/network error → `"failed"`.

Recovery policy (replaces the unconditional error bubble):

- POST read loop throws mid-stream (and a streaming message exists) → try
  `attachToStream` with `offset = currentText.length`, 3 attempts with
  1s/2s/4s backoff.
- If the document is hidden while attempts fail → park a `danglingStreamRef`
  and retry on `visibilitychange → visible` (phone unlocked).
- Re-attach `"gone"` (registry evicted — user was away past the grace
  window) → `window.location.reload()` when a `conversationId` exists: the
  server page re-renders the full conversation from the DB (both turns are
  persisted). No conversation id yet (first turn, POST failed before headers)
  → keep today's error bubble.
- All retries exhausted while visible → error bubble (existing copy), clear
  `streaming`.
- `visibilitychange` listener also covers the OS silently killing the fetch
  without throwing until resume — on visible, if a message is still
  `streaming: true` and no reader is actively reading, re-attach.

Send stays disabled while `streaming` (existing `isDisabled`), which
complements the server 409.

## Error handling summary

| Failure | Behaviour |
| --- | --- |
| Client disconnects mid-stream | Generation continues; both turns persisted; client re-attaches from offset |
| Anthropic stream errors | Registry entry → error; subscribers error; `persistence_failure` emitted; credit refunded (ADR-0004); user turn already saved |
| Re-attach after eviction | GET 404 → page reload → DB-rendered conversation |
| Server restart mid-stream | Registry empty → GET 404 → reload → user turn present, assistant missing; user can re-ask |
| Double submit for same conversation | 409, client keeps waiting on the active stream |

## Testing

- `stream-registry.test.ts`: consumer accumulation; subscribe from offset
  mid-stream; late subscribe after done (grace replay); subscriber cancel
  does not stop the consumer; error propagation; conflict on double start;
  eviction timers (fake timers).
- `persist-turns.test.ts`: updated — no user-message write; refund path
  unchanged.
- `route.test.ts`: user message persisted before response; body served from
  registry; cancelling the response body does not abort the source; 409
  guard.
- New GET route test: ownership (session / claim cookie / foreign → 404),
  offset replay, 404 when inactive.
- `chat.test.tsx`: re-attach on read failure; reload on `"gone"`;
  `initialActiveStream` mount attach; error bubble only after retries.
- Manual (phone): background mid-answer, reopen → text caught up + finishes
  live; kill tab, reopen /ask/[id] mid-generation → attaches.
