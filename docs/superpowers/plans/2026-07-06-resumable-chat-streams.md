# Resumable Chat Streams Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Decouple advice-stream generation from the HTTP connection so a client disconnect never loses a turn, and let the client re-attach mid-generation from any offset.

**Architecture:** An in-memory stream registry (single Node process on VPS) owns each in-flight advice stream via a detached consumer loop. The POST response and a new GET re-attach endpoint are both mere subscribers. The user turn is persisted before streaming; the assistant turn persists when `finalMessage()` resolves — independent of any client.

**Tech Stack:** Next.js 16 route handlers, Anthropic SDK MessageStream, Drizzle/Postgres, Vitest (+ Testing Library for chat.tsx).

**Spec:** `docs/superpowers/specs/2026-07-06-resumable-chat-streams-design.md`

## Global Constraints

- Offsets are UTF-16 code units (`string.length`) on both sides; wire is UTF-8, decoded with `TextDecoder(..., { stream: true })`.
- Registry state on `globalThis[Symbol.for("fiskargubben.stream-registry")]` (dev HMR safety).
- Grace eviction 5 min after done/error; hard TTL 15 min from start.
- Persistence helpers never throw (existing `persistence_failure` contract).
- All user-facing copy in Swedish, in persona.
- Verify with `npm run biome`, `npm run ts:check`, `npx vitest run`.
- Commit with `--no-verify` (pre-commit biome version drift).

---

### Task 1: Stream registry

**Files:**
- Create: `src/lib/chat/stream-registry.ts`
- Test: `src/lib/chat/stream-registry.test.ts`

**Interfaces (Produces):**
```ts
export class StreamConflictError extends Error {}
export function startStream(conversationId: string, source: ReadableStream<Uint8Array>): void; // throws StreamConflictError
export function subscribe(conversationId: string, offset: number): ReadableStream<Uint8Array> | null;
export function isActive(conversationId: string): boolean;   // status === "streaming"
export function resetRegistryForTests(): void;
```

Internal entry:
```ts
type ActiveStream = {
  text: string;
  status: "streaming" | "done" | "error";
  error?: unknown;
  subscribers: Set<Subscriber>;
  graceTimer?: ReturnType<typeof setTimeout>;
  ttlTimer: ReturnType<typeof setTimeout>;
};
```

Behavior:
- `startStream` registers entry (replacing a settled leftover; throws on active) and spawns a detached `consume()` loop: read source → decode → append `entry.text` → fan out to subscribers. Source end → `done`; source error / 15-min TTL → `error`. Settling closes/errors subscribers and schedules eviction after 5 min.
- `subscribe` enqueues `text.slice(offset)` immediately; settled entries close/error right after backlog; cancel only unsubscribes; a subscriber whose controller throws is dropped.

- [ ] Write failing tests (fake timers): accumulate+replay-from-offset, late subscribe after done (grace), subscriber cancel doesn't stop consumer, error propagation, double-start conflict, grace eviction, hard TTL.
- [ ] Run: `npx vitest run src/lib/chat/stream-registry.test.ts` → FAIL (module missing)
- [ ] Implement registry
- [ ] Tests pass
- [ ] Commit `feat(chat): add in-memory stream registry for resumable advice streams`

### Task 2: Persistence split

**Files:**
- Modify: `src/lib/chat/persist-turns.ts`
- Test: `src/lib/chat/persist-turns.test.ts`

**Interfaces (Produces):**
```ts
export function persistUserTurn(
  deps: Pick<PersistTurnsDeps, "persistMessage" | "emit">,
  args: { conversationId: string; message: string },
): Promise<void>; // never throws
export function persistAssistantTurn( // renamed persistTurns; `message` arg removed, no user write
  deps: PersistTurnsDeps,
  args: { conversationId: string; stream: Pick<AdviceStream, "finalMessage">; refundUserId?: string },
): Promise<void>;
```

- [ ] Update tests: user-turn helper (success + failure emits `persistence_failure`); assistant helper no longer writes user message; refund + lastActiveAt contracts unchanged.
- [ ] Run → FAIL
- [ ] Implement (rename `persistTurns` → `persistAssistantTurn`, extract `persistUserTurn`, update doc comments)
- [ ] Tests pass
- [ ] Commit `refactor(chat): split user-turn persistence from assistant-turn persistence`

### Task 3: POST /api/ask wiring

**Files:**
- Modify: `src/app/api/ask/route.ts` (stream branch, lines ~550-624)
- Test: existing route tests (locate `route.test.ts` / update imports of persistTurns)

Changes:
- Early 409 guard after conversationId validation:
```ts
if (conversationId && isActive(conversationId)) {
  return Response.json(
    { type: "busy", text: "Gubben håller redan på att svara i den här chatten. Vänta tills han pratat klart." },
    { status: 409 },
  );
}
```
- Stream branch: `startStream(streamConvId, readable)` (catch `StreamConflictError` → same 409); `await persistUserTurn(...)` before returning; `after(() => persistAssistantTurn(...))`; body = `subscribe(streamConvId, 0)` (null → `classifyError`).
- [ ] Update/extend route tests: user message persisted before response resolves; cancelling response body does NOT cancel the SDK source; 409 guard; headers/cookies unchanged.
- [ ] Run route tests → PASS
- [ ] Commit `feat(chat): serve advice stream from registry, persist user turn up-front`

### Task 4: GET /api/ask/stream

**Files:**
- Create: `src/app/api/ask/stream/route.ts`
- Test: `src/app/api/ask/stream/route.test.ts`

Behavior: validate `conversationId` UUID + clamp `offset` (default 0); ownership = logged-in owner OR anon claim-cookie match (same rule as `loadConversationView`); missing/foreign → 404; `subscribe(...)` null → 404; else `200 text/plain; charset=utf-8` with `X-Conversation-Id`.

- [ ] Failing tests (mock `getSession`, `cookies`, db): owner ok, anon claim ok, foreign 404, inactive 404, offset replay.
- [ ] Implement
- [ ] Tests pass
- [ ] Commit `feat(chat): add GET /api/ask/stream re-attach endpoint`

### Task 5: Server page handoff

**Files:**
- Modify: `src/app/ask/conversations.ts` (`ConversationView` + `loadConversationView`: `activeStream: isActive(id)`)
- Modify: `src/app/ask/[id]/page.tsx` (pass `initialActiveStream={view.activeStream}`)

- [ ] Implement + ts:check
- [ ] Commit `feat(chat): expose active-stream flag to conversation page`

### Task 6: Client resume (chat.tsx)

**Files:**
- Modify: `src/app/ask/chat.tsx`
- Test: `src/app/ask/chat.test.tsx`

Additions:
- `pumpStream(reader, msgId, progress, applyChunk)` shared read loop; `progress.offset += chunk.length`.
- `attachToStream(convId, msgId, progress, applyChunk): Promise<"done" | "gone" | "failed">` hitting `/api/ask/stream?conversationId&offset`.
- Recovery on POST read-loop failure (streaming message exists + conv id known): if `document.hidden` park `danglingRef` and wait for `visibilitychange`; else retry attach with 1s/2s/4s backoff. `"gone"` → `window.location.reload()` (DB has both turns). Exhausted → existing error bubble.
- `visibilitychange` listener resumes parked danglings.
- `initialActiveStream` prop: on mount append empty streaming bubble, attach from offset 0; `"gone"` → reload.
- POST loop refactored onto `pumpStream`; send stays disabled while streaming.

- [ ] Update/extend chat tests: re-attach path on read failure appends remainder (mock fetch), reload on 404, mount attach with `initialActiveStream`, error bubble only after retries exhausted.
- [ ] Run `npx vitest run src/app/ask/chat.test.tsx` → PASS
- [ ] Commit `feat(chat): client re-attach to in-flight advice streams`

### Task 7: Verify + PR

- [ ] `npm run biome:fix`, `npm run ts:check`, `npx vitest run` — all green
- [ ] Push branch `feat/resumable-chat-streams`, open PR with summary + test evidence
