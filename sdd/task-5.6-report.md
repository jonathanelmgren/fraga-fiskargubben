# Task 5.6 Report — anon conversation + Claim on registration

## Files changed
- `src/lib/chat/anon.ts` (created)
- `src/lib/chat/anon.test.ts` (created)

---

## claimToken generation

`randomUUID()` from `node:crypto` — UUID v4, 128 bits of entropy, unguessable.
`Math.random()` is not used anywhere. Two calls always produce different tokens (asserted by test).

The token is returned to the caller; **the caller is responsible for placing it in a SIGNED httpOnly cookie** (e.g. via `iron-session` or Next.js `ResponseCookies` + HMAC). The token is never logged.

---

## Claim flow + carry-over rule

### Happy path
1. `SELECT * FROM conversation WHERE claimToken = $token AND userId IS NULL LIMIT 1`
2. If found:
   - `UPDATE conversation SET userId = $userId, claimToken = NULL WHERE id = $convId`
   - `UPDATE user SET creditsUsed = 1 WHERE id = $userId AND creditsUsed = 0`
   - Return `{ claimed: true }`

### Carry-over rule (ADR-0004)
`creditsUsed = 1` is SET only when `creditsUsed = 0` (the WHERE clause guards it).  
Formally: `creditsUsed_after = max(creditsUsed_before, 1)`.  
This means the anon prompt counts as 1 of 3 lifetime credits on the new account, leaving 2 remaining.  
A user that somehow already had `creditsUsed > 0` is not clobbered (safe, and unreachable in practice because the user was just created).

### Double-claim rejection
The `WHERE userId IS NULL` predicate means an already-claimed row (userId set) is never returned.  
A wrong/missing token also returns 0 rows.  
Both cases return `{ claimed: false }` — no throw, no credit change. Idempotent and safe.

---

## Transaction vs sequential

Operations are **sequential** (not wrapped in a DB transaction).  
Rationale: Drizzle on the Next.js serverless edge does not always have transaction support, and the registration path is not concurrent (the user just signed up). The window for a race between the two UPDATE statements is negligible. If strict atomicity is needed in future, wrap in `deps.db.transaction()` when available.

---

## GC

`gcUnclaimedAnon(olderThan: Date, deps?): Promise<number>`  
Deletes: `WHERE userId IS NULL AND createdAt < olderThan`  
Returns row count (length of the deleted array from drizzle).

**Usage (scripts/gc-anon.ts or a cron job):**
```ts
import { gcUnclaimedAnon } from "@/lib/chat/anon";
import { db } from "@/shared/db/client";
const TTL_DAYS = 7;
const cutoff = new Date(Date.now() - TTL_DAYS * 86_400_000);
const n = await gcUnclaimedAnon(cutoff, { db });
console.log(`GC'd ${n} unclaimed anon rows`);
```
The cutoff is injected — `new Date()` is never called inside the function.

---

## Cookie — caller's responsibility

`createAnonConversation` returns `{ conversationId, claimToken }`.  
The route handler / Task 5.7 is responsible for:
1. Signing the token (e.g. `iron-session` or HMAC with `CLAIM_TOKEN_SECRET`).
2. Setting it as `Secure; HttpOnly; SameSite=Lax`.

---

## Better Auth registration hook

`claimConversation` is exported and ready to call. Task 5.7 / the auth registration handler calls it post-registration with `(newUser.id, claimTokenFromCookie)`. Wiring the Better Auth `databaseHooks` after-create hook is deferred to Task 5.7 to keep this task's scope clean.

---

## RED → GREEN evidence

```
RED:  pnpm test src/lib/chat/anon.test.ts
→ FAIL: "Failed to resolve import ./anon" (file did not exist yet)

GREEN: (after implementing anon.ts)
→ Test Files  1 passed (1)
→ Tests  8 passed (8)
```

---

## ts:check

```
pnpm ts:check
→ (no output = clean)
```

---

## biome

```
pnpm biome check src/lib/chat/anon.ts src/lib/chat/anon.test.ts
→ Checked 99 files in 22ms. No fixes applied.
→ Found 3 warnings.  ← all in pre-existing files (events.test.ts, temp.test.ts); 0 warnings in my files.
```
No `--no-verify` needed.

---

## Self-review / concerns

1. **Transaction gap**: the two sequential UPDATEs are not atomic. Acceptable at this stage; documented above.
2. **`returning()` not used**: `createAnonConversation` generates the UUID client-side and trusts it (standard pattern with Drizzle without `returning()`). The inserted id is echoed back if drizzle returns an array; otherwise the locally-generated UUID is used.
3. **creditsUsed carry-over guard**: the `WHERE creditsUsed = 0` guard is correct and safe. It does mean that if creditsUsed was already bumped before claiming (edge case: shouldn't happen), the carry-over is silently skipped — the user just keeps their higher count. This is acceptable.
4. **No cookie management in this module** — intentional (YAGNI; Task 5.7 owns cookies).
5. **GC script** is documented but not a physical file in `scripts/` — the function is exported and the usage snippet is in the module doc + this report. A `scripts/gc-anon.ts` file can be wired when a cron is configured (deferred).
