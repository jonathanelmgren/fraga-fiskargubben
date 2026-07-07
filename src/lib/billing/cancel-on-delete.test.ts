/**
 * cancel-on-delete.test.ts — Stripe cleanup on account deletion.
 *
 * Invariants under test:
 *  1. No Stripe configured (null client) → no-op, no DB query.
 *  2. Cancelable subscriptions are canceled IMMEDIATELY with the no-refund
 *     params pinned (invoice_now: false, prorate: false).
 *  3. Already-terminal local rows (canceled) are not re-canceled.
 *  4. The Stripe customer is deleted (GDPR + safety net), deduped across the
 *     user row and subscription rows.
 *  5. "Already gone" Stripe errors (resource_missing / already-canceled) are
 *     tolerated; anything else propagates so the account deletion aborts.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const { whereMock } = vi.hoisted(() => ({
  whereMock: vi.fn(),
}));

vi.mock("@/shared/db/client", () => ({
  db: {
    select: vi.fn(() => ({
      from: vi.fn(() => ({ where: whereMock })),
    })),
  },
}));

import type Stripe from "stripe";
import { cancelStripeOnAccountDelete } from "./cancel-on-delete";

function fakeStripe() {
  const client = {
    subscriptions: { cancel: vi.fn().mockResolvedValue({}) },
    customers: { del: vi.fn().mockResolvedValue({}) },
  };
  return { client, asStripe: client as unknown as Stripe };
}

const NO_REFUND_PARAMS = { invoice_now: false, prorate: false };

beforeEach(() => {
  whereMock.mockReset();
  whereMock.mockResolvedValue([]);
});

describe("cancelStripeOnAccountDelete", () => {
  it("is a no-op when Stripe is not configured (null client)", async () => {
    await expect(
      cancelStripeOnAccountDelete(null, {
        id: "u1",
        stripeCustomerId: "cus_1",
      }),
    ).resolves.toBeUndefined();
    expect(whereMock).not.toHaveBeenCalled();
  });

  it("cancels an active subscription immediately with no-refund params and deletes the customer", async () => {
    const { client, asStripe } = fakeStripe();
    whereMock.mockResolvedValue([
      {
        stripeSubscriptionId: "sub_1",
        stripeCustomerId: "cus_1",
        status: "active",
      },
    ]);

    await cancelStripeOnAccountDelete(asStripe, {
      id: "u1",
      stripeCustomerId: "cus_1",
    });

    expect(client.subscriptions.cancel).toHaveBeenCalledWith(
      "sub_1",
      NO_REFUND_PARAMS,
    );
    // Deduped: same customer on the user row and the subscription row.
    expect(client.customers.del).toHaveBeenCalledTimes(1);
    expect(client.customers.del).toHaveBeenCalledWith("cus_1");
  });

  it("skips Stripe cancel for locally-terminal rows but still deletes the customer", async () => {
    const { client, asStripe } = fakeStripe();
    whereMock.mockResolvedValue([
      {
        stripeSubscriptionId: "sub_old",
        stripeCustomerId: "cus_1",
        status: "canceled",
      },
    ]);

    await cancelStripeOnAccountDelete(asStripe, { id: "u1" });

    expect(client.subscriptions.cancel).not.toHaveBeenCalled();
    expect(client.customers.del).toHaveBeenCalledWith("cus_1");
  });

  it("deletes the user-row customer even with no subscription rows (abandoned checkout)", async () => {
    const { client, asStripe } = fakeStripe();

    await cancelStripeOnAccountDelete(asStripe, {
      id: "u1",
      stripeCustomerId: "cus_orphan",
    });

    expect(client.subscriptions.cancel).not.toHaveBeenCalled();
    expect(client.customers.del).toHaveBeenCalledWith("cus_orphan");
  });

  it("tolerates already-gone Stripe errors (resource_missing, already-canceled)", async () => {
    const { client, asStripe } = fakeStripe();
    whereMock.mockResolvedValue([
      {
        stripeSubscriptionId: "sub_1",
        stripeCustomerId: "cus_1",
        status: "active",
      },
    ]);
    client.subscriptions.cancel.mockRejectedValue(
      Object.assign(new Error("This subscription has been canceled."), {
        code: undefined,
      }),
    );
    client.customers.del.mockRejectedValue(
      Object.assign(new Error("No such customer: cus_1"), {
        code: "resource_missing",
      }),
    );

    await expect(
      cancelStripeOnAccountDelete(asStripe, { id: "u1" }),
    ).resolves.toBeUndefined();
  });

  it("propagates unexpected Stripe errors so the account deletion aborts", async () => {
    const { client, asStripe } = fakeStripe();
    whereMock.mockResolvedValue([
      {
        stripeSubscriptionId: "sub_1",
        stripeCustomerId: "cus_1",
        status: "active",
      },
    ]);
    client.subscriptions.cancel.mockRejectedValue(
      Object.assign(new Error("Stripe is down"), { code: "api_error" }),
    );

    await expect(
      cancelStripeOnAccountDelete(asStripe, { id: "u1" }),
    ).rejects.toThrow("Stripe is down");
    // Must not proceed to customer deletion after an unexplained failure.
    expect(client.customers.del).not.toHaveBeenCalled();
  });
});
