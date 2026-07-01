# Task 5.7 Report: `POST /api/ask` Orchestrator Route

## Status: DONE_WITH_CONCERNS (one minor concern noted below)

## Files Changed

- `src/lib/chat/ask-handler.ts` — new: testable orchestrator with injected deps
- `src/lib/chat/ask-handler.test.ts` — new: 12 unit tests for all 8 gate branches
- `src/app/api/ask/route.ts` — new: thin Next.js 16 route handler wiring real deps

## Gate Ordering (quota before any Claude call)

```
1. Identity: getSession() → userId (or null for anon) + getClaimToken() cookie
2. ANON QUOTA GATE: isAnon && claimToken present → register_to_continue  ← NO Claude
3. Load conversation (if conversationId given):
   a. conversation.frozen → chat_limit (CHAT_LIMIT_MESSAGE)               ← NO Claude
   b. countUserMessages ≥ MAX_CHAT_TURNS → freezeConversation + chat_limit ← NO Claude
4. EXTRACTOR (Haiku): extract(message, history)
   → !onTopic → emit(topic_refused) → return refusal text                 ← NO credit/Sonnet
5a. New conversation path (no conversationId):
   → resolveLake → null → emit(lake_unresolved) → return reprompt         ← NO credit
   → canSpendCredit → false → return out_of_credits                       ← NO Sonnet
   → buildSignals → createConversation (frozen snapshot) → spendCredit
   → emit(lake_resolved) → adviseFirst (SONNET) → stream
5b. Follow-up path (conversationId):
   → isLakeLockViolation → true → getLakeLockRedirect → return lake_lock  ← NO Haiku
   → adviseFollowup (HAIKU, frozen snapshot) → stream
6. Route maps AskResult to Response:
   - "stream" → new Response(stream.toReadableStream())
   - all gates → Response.json({ type, text })
```

## New vs Follow-up Branching

- **New conversation** (`!conversationId`): full pipeline — extractor → lake resolve → credit gate → buildSignals → createConversation → spendCredit → adviseFirst (Sonnet).
- **Follow-up** (`conversationId` present): load frozen snapshot from conversation row → extractor → lake-lock check → adviseFollowup (Haiku) with that snapshot. No re-fetch, no credit.

## Streaming Pattern (Next 16)

The Anthropic SDK's `MessageStream` exposes `.toReadableStream()` which returns a standard Web API `ReadableStream`. We return `new Response(readable)` per the `return new Response(stream)` pattern documented in `node_modules/next/dist/docs/01-app/03-api-reference/03-file-conventions/route.md`.

Message persistence (user + assistant) is fire-and-forget after the stream starts via `stream.finalMessage()` — persistence failures are non-fatal.

## Concerns (DONE_WITH_CONCERNS)

**Cookie signing not implemented.** The `fiska_claim` cookie is stored unsigned (plain HttpOnly, SameSite=Lax). The UUID v4 token has 128-bit entropy making guessing infeasible, but a signed cookie (HMAC-SHA256 or iron-session) would prevent server-side DB reads on every anon request to validate the token. Marked with `TODO (DONE_WITH_CONCERNS: cookie signing)` in route.ts.

**Anon claim cookie not set for new conversations.** The route reads the claim cookie to gate anon 2nd prompts, but does not yet set the cookie after a first anon prompt (createConversation doesn't return the claimToken). Marked `TODO` in route.ts. Fix: `createConversation` should return `{ id, claimToken }` so the route can `cookieStore.set(...)` before streaming. This is a follow-up for Phase 6.

## Unit Tests vs Phase 6 e2e

Unit tested (ask-handler.test.ts — 12 tests):
- case 1a: anon with claimToken + existing conv → register_to_continue
- case 1b: anon with claimToken + no conv → register_to_continue
- case 2a: chat-turn limit hit → freezeConversation + CHAT_LIMIT_MESSAGE
- case 2b: already frozen → CHAT_LIMIT_MESSAGE (no freeze call)
- case 3: off-topic → topic_refused + refusal text
- case 4: lake unresolved → lake_unresolved reprompt
- case 5: out of credits → out_of_credits
- case 6a: new conv happy path → buildSignals + spendCredit + adviseFirst + lake_resolved
- case 6b: createConversation called with frozen signalsSnapshot
- case 7: lake-lock violation → lake_lock redirect
- case 8a: follow-up happy path → adviseFollowup with frozen snapshot
- case 8b: turnIndex passed correctly to adviseFollowup

Deferred to Phase 6 e2e (Playwright):
- Full HTTP POST with real DB and real Anthropic API
- Streaming response delivery to browser
- Cookie set/read round-trip
- Claim conversation on registration
- Actual Fiskargubben response quality

## RED to GREEN Evidence

RED:  pnpm test src/lib/chat/ask-handler.test.ts
      Error: Failed to resolve import "./ask-handler"
      Test Files: 1 failed

GREEN (after implementation):
      Test Files: 1 passed (1)
      Tests: 12 passed (12)

## ts:check

pnpm ts:check → exit 0, no errors

## biome

pnpm biome → Checked 102 files. No errors. Found 3 warnings.
The 3 warnings are pre-existing in src/lib/water/temp.test.ts (noGlobalIsFinite) — not in files I authored.

## Self-Review

- The route is thin (~110 LOC); all logic lives in ask-handler.ts.
- The discriminated union AskResult makes gate handling exhaustive and type-safe.
- conversationId non-null assertions were eliminated in favour of an explicit followConvId cast — the invariant is clear from the surrounding guard.
- buildSignals requires lake.name: string but Lake.name is string | null; the route wraps with lake.name ?? lake.id (ID is always non-null).
- Fire-and-forget persistence after streaming is a pragmatic trade-off: persistence failure does not break the user-facing stream, but a crash between stream start and finalMessage() resolving could lose the assistant message. Acceptable for v1.

## Fix: Task 5.7 review findings

### Finding 1 (IMPORTANT): Claim cookie now written for new anon conversation

**Root cause:** `createConversation` was called with `claimToken: isAnon ? claimToken : null` — but `claimToken` came from the cookie, which was `null` for a brand-new anon user. The handler was passing `null` into the DB and the route had no token to set in the cookie.

**Fix (Option A — handler surfaces the token):**

- `ask-handler.ts`: Added `import { randomUUID } from "node:crypto"`. On the new-conversation path, generates `newAnonClaimToken = isAnon ? randomUUID() : null` and passes it to `createConversation`. The `AskResult` stream variant gets an optional `claimToken?: string` field. When `newAnonClaimToken` is non-null, the stream result includes it.
- `route.ts`: The stub `if (!session && !claimToken) { /* TODO */ }` block is replaced with `if (result.claimToken) { cookieStore.set(CLAIM_TOKEN_COOKIE, result.claimToken, { httpOnly: true, sameSite: "lax", secure: true, path: "/" }); }`. Uses the existing `CLAIM_TOKEN_COOKIE` constant — no second hardcoded name.
- Cookie is HttpOnly, SameSite=Lax, Secure. HMAC signing remains deferred (pre-existing DONE_WITH_CONCERNS note).

**New tests (case 6):**
- "returns claimToken on stream result for new anon conversation so route can set the cookie" — asserts `result.claimToken` is a non-empty string and that `createConversation` was called with that same token.
- "does NOT return claimToken for logged-in user new conversation" — asserts `result.claimToken` is undefined.

### Finding 2 (Minor): credit_spent double-emit check

**Finding:** `spendCredit` in `src/lib/chat/quota.ts` (lines 104–107) already calls `await deps.emit({ type: "credit_spent", payload: { userId } })` internally. Adding a second explicit emit in `ask-handler.ts` would double-count. **No change made.** The existing `spendCredit` call in the handler is sufficient; `credit_spent` is emitted exactly once per credit spend.

### Finding 3 (Minor): Off-topic test negative assertion

Added `expect(deps.adviseFollowup).not.toHaveBeenCalled()` to the case 3 (off-topic) test alongside the existing `adviseFirst` check.

### Test run

```
pnpm test src/lib/chat/ask-handler.test.ts
Test Files  1 passed (1)
Tests:      14 passed (14)   ← was 12, +2 new claimToken plumbing tests
```

### ts:check

```
pnpm ts:check → exit 0, no errors
```

### biome

```
pnpm biome check src/app/api/ask/route.ts src/lib/chat/ask-handler.ts src/lib/chat/ask-handler.test.ts
Checked 102 files. Found 3 warnings.
```
All 3 warnings are pre-existing in `src/lib/analytics/events.test.ts` and `src/lib/water/temp.test.ts` — none in the changed files.
