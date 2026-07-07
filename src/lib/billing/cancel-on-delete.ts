import "server-only";
import { eq } from "drizzle-orm";
import type Stripe from "stripe";
import { db } from "@/shared/db/client";
import { subscriptions } from "@/shared/db/schema";

/**
 * Stripe cleanup when a user deletes their account.
 *
 * Without this, the Stripe subscription outlives the account: the card keeps
 * being charged yearly while the customer can no longer log in, reach the
 * billing portal, or use the service — a guaranteed dispute.
 *
 * Cancellation is IMMEDIATE, not at period end. That is safe refund-wise:
 * `subscriptions.cancel` with `prorate: false` (pinned explicitly below)
 * never refunds or credits anything, it just stops future billing. Decision
 * 2026-07-07: cancel directly as long as no refund is made — if that Stripe
 * behavior ever changes, switch to cancel_at_period_end instead.
 *
 * The Stripe customer is deleted too: GDPR cleanup ("delete my account"
 * should not leave PII in Stripe), and a safety net — deleting a customer
 * cancels any active subscription our local rows might have missed.
 * Invoices and charges survive customer deletion for accounting.
 *
 * Throws on unexpected Stripe failures so the caller can ABORT the account
 * deletion — an account must never be deleted while its billing might live on.
 */

/** Local statuses where a Stripe-side cancel call is meaningful. */
const CANCELABLE_STATUSES = new Set([
  "active",
  "trialing",
  "past_due",
  "unpaid",
  "incomplete",
  "paused",
]);

/**
 * True for "there is nothing left to cancel/delete" errors — the desired end
 * state is already reached, so they are tolerated, not propagated:
 * resource_missing (object gone, e.g. test-data purge) and Stripe's
 * "already canceled" invalid_request_error (which carries no error code).
 */
function isAlreadyGone(err: unknown): boolean {
  if (typeof err !== "object" || err === null) return false;
  const e = err as { code?: string; message?: string };
  if (e.code === "resource_missing") return true;
  return typeof e.message === "string" && /cancell?ed/i.test(e.message);
}

export async function cancelStripeOnAccountDelete(
  stripeClient: Stripe | null,
  user: { id: string; stripeCustomerId?: string | null },
): Promise<void> {
  // Stripe not configured (dev/CI boot pattern) — nothing to clean up.
  if (!stripeClient) return;

  const rows = await db
    .select({
      stripeSubscriptionId: subscriptions.stripeSubscriptionId,
      stripeCustomerId: subscriptions.stripeCustomerId,
      status: subscriptions.status,
    })
    .from(subscriptions)
    .where(eq(subscriptions.referenceId, user.id));

  for (const row of rows) {
    if (!row.stripeSubscriptionId) continue;
    if (!CANCELABLE_STATUSES.has(row.status)) continue;
    try {
      await stripeClient.subscriptions.cancel(row.stripeSubscriptionId, {
        // Pin the no-refund invariant: no proration credit, no final invoice.
        invoice_now: false,
        prorate: false,
      });
    } catch (err) {
      if (!isAlreadyGone(err)) throw err;
    }
  }

  const customerIds = new Set(
    [user.stripeCustomerId, ...rows.map((r) => r.stripeCustomerId)].filter(
      (id): id is string => typeof id === "string" && id.length > 0,
    ),
  );
  for (const customerId of customerIds) {
    try {
      await stripeClient.customers.del(customerId);
    } catch (err) {
      if (!isAlreadyGone(err)) throw err;
    }
  }
}
