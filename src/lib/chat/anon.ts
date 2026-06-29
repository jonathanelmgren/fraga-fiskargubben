/**
 * anon.ts — anonymous conversation creation, claim-on-registration, and GC.
 *
 * ADR-0001 / ADR-0004 plumbing:
 *
 *  - An anonymous conversation is a `conversations` row with userId=null
 *    and a cryptographically random `claimToken`.
 *
 *  - The claimToken is returned by `createAnonConversation`; the CALLER is
 *    responsible for storing it in a SIGNED httpOnly cookie.  This module
 *    never reads or writes cookies.
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
 *    and createdAt < olderThan.  Call from a cron / `scripts/gc-anon.ts`
 *    (see below).  The cutoff is injected — do NOT call `new Date()` inside.
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

import { randomUUID } from "node:crypto";
import { and, eq, isNull, lt } from "drizzle-orm";
import type { Db } from "@/shared/db/client";
import { db as realDb } from "@/shared/db/client";
import { conversations, users } from "@/shared/db/schema";

// ---------------------------------------------------------------------------
// Injectable deps
// ---------------------------------------------------------------------------

interface AnonDeps {
  db: Pick<Db, "insert" | "update" | "delete" | "select">;
}

function defaultDeps(): AnonDeps {
  return { db: realDb };
}

// ---------------------------------------------------------------------------
// createAnonConversation
// ---------------------------------------------------------------------------

export interface CreateAnonOptions {
  lakeId?: string;
  targetTime?: Date;
}

export interface AnonConversationResult {
  conversationId: string;
  /**
   * Unguessable claim token (UUID v4).
   * The CALLER must place this in a SIGNED httpOnly cookie.
   * Never log this value.
   */
  claimToken: string;
}

/**
 * Creates an anonymous conversation row (userId=null) and returns the id +
 * a fresh claim token.
 *
 * The caller is responsible for storing the token in a SIGNED httpOnly cookie.
 */
export async function createAnonConversation(
  opts: CreateAnonOptions,
  deps: AnonDeps = defaultDeps(),
): Promise<AnonConversationResult> {
  const id = randomUUID();
  const claimToken = randomUUID();

  const row = {
    id,
    userId: null,
    claimToken,
    lakeId: opts.lakeId ?? null,
    targetTime: opts.targetTime ?? null,
  };

  const inserted = await deps.db.insert(conversations).values(row);

  // Drizzle returning() gives the row; if not used, fall back to the generated id.
  const conversationId =
    Array.isArray(inserted) && inserted.length > 0
      ? (inserted[0] as { id: string }).id
      : id;

  return { conversationId, claimToken };
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
 * Note: operations are sequential (not wrapped in a DB transaction) because
 * Next.js / Drizzle on the serverless edge does not always have transaction
 * support.  The window for a race is negligible at registration time; if
 * strict atomicity is needed, wrap in deps.db.transaction() when available.
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

  // 2a. Claim the conversation: set userId, clear token
  await deps.db
    .update(conversations)
    .set({ userId, claimToken: null })
    .where(eq(conversations.id, conv.id));

  // 2b. Carry-over: creditsUsed = max(creditsUsed, 1)
  //     Only set to 1 if currently 0 — prevents clobbering a higher count.
  //     In practice a brand-new user always has creditsUsed=0, but the guard
  //     is correct and documented (ADR-0004).
  await deps.db
    .update(users)
    .set({ creditsUsed: 1 })
    .where(and(eq(users.id, userId), eq(users.creditsUsed, 0)));

  return { claimed: true };
}

// ---------------------------------------------------------------------------
// gcUnclaimedAnon
// ---------------------------------------------------------------------------

/**
 * Deletes anonymous conversation rows that have never been claimed and were
 * created before `olderThan`.
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
  const deleted = await deps.db
    .delete(conversations)
    .where(
      and(isNull(conversations.userId), lt(conversations.createdAt, olderThan)),
    );

  return Array.isArray(deleted) ? deleted.length : 0;
}
