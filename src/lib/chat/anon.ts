/**
 * anon.ts — anonymous conversation claim-on-registration and GC.
 *
 * ADR-0001 / ADR-0004 plumbing:
 *
 *  - An anonymous conversation is a `conversations` row with userId=null
 *    and a cryptographically random `claimToken`.  The row + token are created
 *    inline by the /api/ask route (see route.ts createConversation), which
 *    stores the token in an httpOnly cookie.  This module never reads or
 *    writes cookies.
 *
 *  - On registration, `claimConversation(userId, claimToken)` is called
 *    (by Task 5.7 / the Better Auth after-user-create hook, or the
 *    registration route handler after the user row exists).  It finds the
 *    unclaimed row (userId IS NULL AND claimToken = token), sets userId,
 *    clears the token, and applies the ADR-0004 carry-over rule.
 *
 *  - Carry-over rule (ADR-0004): the anon prompt counts as 1 of 3 lifetime
 *    Credits.  `claimConversation` sets `creditsUsed = 1` on the user row
 *    IFF the user's current `creditsUsed` is 0 (brand-new account, has not
 *    spent any credits yet).  This avoids clobbering a higher count in the
 *    unlikely edge case where something already incremented it.  In practice
 *    the user was just created so 0 is guaranteed, but the guard is correct.
 *    Formally: creditsUsed_after = max(creditsUsed_before, 1).
 *
 *  - Double-claim: if no unclaimed row matches the token the function returns
 *    { claimed: false } — safe no-op, no throw, no credit change.
 *
 *  - GC: `gcUnclaimedAnon(olderThan)` deletes all rows with userId IS NULL
 *    and lastActiveAt < olderThan (inactive, not merely old).  Call from a
 *    cron / `scripts/gc-anon.ts` (see below).  The cutoff is injected — do
 *    NOT call `new Date()` inside.
 *
 * Cookie responsibility note:
 *   The caller (Task 5.7 / route handler) must:
 *     1. Receive the claimToken returned here.
 *     2. Sign it with a secret (e.g. `iron-session` / `jose` / Next.js
 *        `ResponseCookies` + a HMAC).
 *     3. Set it as a Secure, HttpOnly, SameSite=Lax cookie.
 *   Do NOT log the claimToken.
 *
 * GC script stub:
 *   `scripts/gc-anon.ts` (or a cron job) should call:
 *     import { gcUnclaimedAnon } from "@/lib/chat/anon";
 *     import { db } from "@/shared/db/client";
 *     const TTL_DAYS = 7;
 *     const cutoff = new Date(Date.now() - TTL_DAYS * 86_400_000);
 *     const n = await gcUnclaimedAnon(cutoff, { db });
 *     console.log(`GC'd ${n} unclaimed anon rows`);
 */

import "server-only";

import { and, eq, isNull, lt } from "drizzle-orm";
import type { Db } from "@/shared/db/client";
import { db as realDb } from "@/shared/db/client";
import { conversations, users } from "@/shared/db/schema";

// ---------------------------------------------------------------------------
// Injectable deps
// ---------------------------------------------------------------------------

interface AnonDeps {
  db: Pick<Db, "update" | "delete" | "select" | "transaction">;
}

function defaultDeps(): AnonDeps {
  return { db: realDb };
}

// ---------------------------------------------------------------------------
// claimConversation
// ---------------------------------------------------------------------------

export interface ClaimResult {
  claimed: boolean;
}

/**
 * Claims an anonymous conversation on behalf of a newly registered user.
 *
 * Flow:
 *   1. Find conversations WHERE claimToken = token AND userId IS NULL.
 *   2. If found: set userId on the conversation, clear claimToken.
 *      Apply carry-over: set creditsUsed=1 on the user IFF creditsUsed=0.
 *      Return { claimed: true }.
 *   3. If not found: return { claimed: false } — safe no-op (double-claim
 *      rejected, wrong token, row already claimed).
 *
 * The conversation update and the carry-over credit update are wrapped in a
 * single DB transaction so that a crash between them cannot leave the
 * conversation claimed but the credit un-spent (or vice-versa).
 */
export async function claimConversation(
  userId: string,
  claimToken: string,
  deps: AnonDeps = defaultDeps(),
): Promise<ClaimResult> {
  // 1. Find the unclaimed row
  const rows = await deps.db
    .select()
    .from(conversations)
    .where(
      and(
        eq(conversations.claimToken, claimToken),
        isNull(conversations.userId),
      ),
    )
    .limit(1);

  if (rows.length === 0) {
    return { claimed: false };
  }

  const conv = rows[0] as { id: string };

  // 2. Atomically: claim the conversation + apply carry-over credit.
  //    Both updates run inside a transaction so a crash between them cannot
  //    leave a partial state (conversation claimed but credit un-spent).
  let claimed = false;
  await deps.db.transaction(async (tx) => {
    // 2a. Claim the conversation: set userId, clear token.
    //     M7: the UPDATE is SELF-GUARDING — it includes `AND userId IS NULL`
    //     so a concurrent claim that already set userId between our SELECT and
    //     this UPDATE cannot be clobbered (last-writer-wins reassigning the
    //     conversation between users).  `.returning()` lets us treat zero
    //     affected rows as "already claimed" → idempotent, race-safe no-op.
    const updated = await tx
      .update(conversations)
      .set({ userId, claimToken: null })
      .where(and(eq(conversations.id, conv.id), isNull(conversations.userId)))
      .returning({ id: conversations.id });

    if (!Array.isArray(updated) || updated.length === 0) {
      // Lost the race — another claim already took this conversation.  Do NOT
      // apply the credit carry-over; leave the transaction with no net change.
      return;
    }

    // 2b. Carry-over: creditsUsed = max(creditsUsed, 1)
    //     Only set to 1 if currently 0 — prevents clobbering a higher count.
    //     In practice a brand-new user always has creditsUsed=0, but the guard
    //     is correct and documented (ADR-0004).
    await tx
      .update(users)
      .set({ creditsUsed: 1 })
      .where(and(eq(users.id, userId), eq(users.creditsUsed, 0)));

    claimed = true;
  });

  return { claimed };
}

// ---------------------------------------------------------------------------
// gcUnclaimedAnon
// ---------------------------------------------------------------------------

/**
 * Deletes anonymous conversation rows that have never been claimed and have
 * been INACTIVE since before `olderThan`.
 *
 * M-gc: filter on `lastActiveAt` (maintained by the /api/ask route on every
 * turn) rather than `createdAt`, so an anon conversation that is still being
 * actively used is not purged just because it was first created long ago.
 *
 * Returns the number of rows deleted.
 *
 * Call from a scheduled job or `scripts/gc-anon.ts` — see module doc for
 * example.  The `olderThan` cutoff is injected; never call new Date() here.
 */
export async function gcUnclaimedAnon(
  olderThan: Date,
  deps: AnonDeps = defaultDeps(),
): Promise<number> {
  // L5: a delete WITHOUT .returning() resolves to a driver result object, not a
  // row array, so the old Array.isArray(...).length always returned 0. Use
  // .returning() so the count is truthful and the GC log is meaningful.
  const deleted = await deps.db
    .delete(conversations)
    .where(
      and(
        isNull(conversations.userId),
        lt(conversations.lastActiveAt, olderThan),
      ),
    )
    .returning({ id: conversations.id });

  return deleted.length;
}
