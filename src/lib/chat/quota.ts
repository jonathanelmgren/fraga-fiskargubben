/**
 * quota.ts — credit gate + chat-turn limit (Task 5.5, ADR-0004)
 *
 * Two independent quota mechanisms:
 *
 * 1. Credit gate: free users get FREE_CREDITS (3) lifetime Sonnet first-prompts.
 *    A Credit is spent once per new conversation (fresh Signals fetch).
 *    isPaid users are unlimited.
 *
 * 2. Chat-turn limit: a hard cap of MAX_CHAT_TURNS (5) user turns per
 *    conversation for FREE users (anon + logged-in non-paid). Paid users and
 *    admins are unlimited.  messageCount = number of user-role message rows already
 *    in the conversation (caller counts only role='user' rows — keeping it
 *    simple and consistent with what the user experiences as "turns").
 *    On hitting the limit the conversation is frozen and a plain, non-persona
 *    Swedish system alert is returned (CHAT_LIMIT_MESSAGE).
 *
 * Server-only: DB operations use drizzle with injectable deps for testing.
 */

import "server-only";

import { and, eq, or, sql } from "drizzle-orm";
import { type AnalyticsEvent, emit as realEmit } from "@/lib/analytics/events";
import type { Db } from "@/shared/db/client";
import { db as realDb } from "@/shared/db/client";
import { conversations, users } from "@/shared/db/schema";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Lifetime free Credits per user (ADR-0004). */
export const FREE_CREDITS = 3;

/**
 * Maximum user turns per conversation before it is frozen (ADR-0004) —
 * applies to FREE users only (anon + logged-in non-paid); paid users and
 * admins have no turn limit.
 * messageCount should be the count of role='user' message rows already stored.
 */
export const MAX_CHAT_TURNS = 5;

/**
 * Turn index at which the assistant starts "winding down" a conversation
 * (nudging toward a fresh chat). Free conversations freeze at MAX_CHAT_TURNS
 * long before this, so the taper only ever fires for paid/admin users.
 */
export const WINDING_DOWN_TURN = 15;

/**
 * Plain, non-persona system alert shown when the chat-turn limit is hit.
 * Deliberately NOT in Fiskargubben's gruff voice — this is a system boundary.
 * L8: defined in ./gate-messages; re-exported here for existing import sites.
 */
export { CHAT_LIMIT_MESSAGE } from "./gate-messages";

// ---------------------------------------------------------------------------
// Pure gate functions
// ---------------------------------------------------------------------------

/**
 * Returns true if the user is allowed to spend a Credit right now.
 * Pure function — no side-effects, safe to call in any context.
 *
 * Admins (ADMIN_EMAILS) bypass the cap entirely; the caller also skips
 * spendCredit for them so their counter never moves.
 */
export function canSpendCredit(
  user: {
    isPaid: boolean;
    creditsUsed: number;
  },
  opts?: { isAdmin?: boolean },
): boolean {
  if (opts?.isAdmin) return true;
  return user.isPaid || user.creditsUsed < FREE_CREDITS;
}

/**
 * Returns true if a new user turn is allowed in this conversation.
 * messageCount = number of user-role message rows already stored (does NOT
 * include the current incoming turn — the caller checks BEFORE persisting).
 * Pure function — no side-effects. Paid users and admins have no turn limit.
 */
export function chatTurnAllowed(
  messageCount: number,
  opts?: { isAdmin?: boolean; isPaid?: boolean },
): boolean {
  if (opts?.isAdmin || opts?.isPaid) return true;
  return messageCount < MAX_CHAT_TURNS;
}

// ---------------------------------------------------------------------------
// Injectable deps types
// ---------------------------------------------------------------------------

// L-q1: spendCredit and freezeConversation take the same dependency shape
// (`db.update` + `emit`), so they share one type. spendCredit additionally
// relies on `.returning()` being available on the update builder — that is a
// property of the concrete `db.update(...)` chain, not expressible by
// `Pick<Db, "update">`, so it is documented rather than separately typed.
interface QuotaDeps {
  db: Pick<Db, "update">;
  emit: (event: AnalyticsEvent) => Promise<void>;
}

function defaultDeps(): QuotaDeps {
  return { db: realDb, emit: realEmit };
}

// ---------------------------------------------------------------------------
// DB side-effects
// ---------------------------------------------------------------------------

/**
 * Atomically spends a Credit for the given user.
 *
 * E5 (check-then-spend race): the increment is GUARDED in the same statement —
 * it only fires when the user is still under the free limit (or paid). Two
 * concurrent free-tier requests can therefore not both succeed: the DB
 * serialises the conditional UPDATEs and only the ones that still match the
 * `creditsUsed < FREE_CREDITS` predicate affect a row. The caller MUST treat a
 * `false` return (zero rows affected) as out-of-credits.
 *
 * `credit_spent` is emitted only when a credit was actually spent.
 *
 * Call this after canSpendCredit returns true (cheap pre-check) — but rely on
 * the boolean return for the authoritative decision.
 *
 * @returns true if a credit was spent, false if the user was already at/over
 *          the free limit (and is not paid).
 */
export async function spendCredit(
  userId: string,
  deps: QuotaDeps = defaultDeps(),
): Promise<boolean> {
  const updated = await deps.db
    .update(users)
    .set({ creditsUsed: sql`${users.creditsUsed} + 1` })
    .where(
      and(
        eq(users.id, userId),
        or(eq(users.isPaid, true), sql`${users.creditsUsed} < ${FREE_CREDITS}`),
      ),
    )
    .returning({ id: users.id });

  const spent = updated.length > 0;
  if (spent) {
    await deps.emit({
      type: "credit_spent",
      payload: { userId },
    });
  }
  return spent;
}

/**
 * Refund a previously-spent credit (the inverse of spendCredit).
 *
 * Called when the first-turn Sonnet stream fails AFTER spendCredit committed:
 * ADR-0004 defines a Credit as "fresh fetch + a successful Sonnet answer", so a
 * failed answer must not consume one. The decrement is GUARDED with
 * `creditsUsed > 0` so a double-refund (or a refund racing a concurrent path)
 * can never drive the balance negative — the DB serialises the conditional
 * UPDATE and a redundant refund simply affects zero rows.
 *
 * Paid users don't consume credits, but the decrement is still safe for them
 * (their creditsUsed is not the gate); the guard only prevents underflow.
 *
 * `credit_refunded` is emitted only when a credit was actually returned.
 *
 * @returns true if a credit was refunded, false if there was nothing to refund.
 */
export async function refundCredit(
  userId: string,
  deps: QuotaDeps = defaultDeps(),
): Promise<boolean> {
  const updated = await deps.db
    .update(users)
    .set({ creditsUsed: sql`${users.creditsUsed} - 1` })
    .where(and(eq(users.id, userId), sql`${users.creditsUsed} > 0`))
    .returning({ id: users.id });

  const refunded = updated.length > 0;
  if (refunded) {
    await deps.emit({
      type: "credit_refunded",
      payload: { userId },
    });
  }
  return refunded;
}

/**
 * Freezes a conversation (sets frozen=true) and emits a chat_limit_hit event.
 * Call this when chatTurnAllowed returns false.
 */
export async function freezeConversation(
  conversationId: string,
  deps: QuotaDeps = defaultDeps(),
): Promise<void> {
  await deps.db
    .update(conversations)
    .set({ frozen: true })
    .where(eq(conversations.id, conversationId));

  await deps.emit({
    type: "chat_limit_hit",
    conversationId,
  });
}
