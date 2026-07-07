/**
 * auth.test.ts — C2: verifies the anon→register claim wire in auth.ts.
 *
 * We verify that:
 *  1. The auth config has a databaseHooks.user.create.after hook.
 *  2. When the hook fires with a context that has a VALID SIGNED fiska_claim
 *     cookie, it calls claimConversation with (userId, rawToken).
 *  3. When context is null (seeding / test) or the cookie is absent,
 *     claimConversation is NOT called.
 *  4. When the cookie is present but its signature is INVALID (tampered /
 *     unsigned), claimConversation is NOT called — the hook treats it as
 *     "no claim" and never throws (Issue #5 — signed cookie).
 *  5. A claim failure (DB error) is swallowed — the hook never throws.
 */

import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

// Stub env so Zod parsing doesn't blow up in CI.  claim-cookie.ts reads the
// same BETTER_AUTH_SECRET, so signing below uses this exact value.
vi.mock("@/shared/env", () => ({
  env: {
    DATABASE_URL: "postgres://x:x@localhost:5432/x",
    ANTHROPIC_API_KEY: "sk-test",
    BETTER_AUTH_SECRET: "00000000000000000000000000000000",
    BETTER_AUTH_URL: "http://localhost:3000",
    GOOGLE_CLIENT_ID: "x",
    GOOGLE_CLIENT_SECRET: "x",
    MICROSOFT_CLIENT_ID: "x",
    MICROSOFT_CLIENT_SECRET: "x",
  },
}));

// Stub DB to prevent actual connection attempts
vi.mock("@/shared/db/client", () => ({ db: {} }));

// Mock claimConversation so we can assert it's called (or not)
vi.mock("@/lib/chat/anon", () => ({
  claimConversation: vi.fn().mockResolvedValue({ claimed: true }),
}));

// Mock the mail sender so the verification wire can be asserted.
vi.mock("@/lib/email", () => ({
  sendVerificationEmail: vi.fn().mockResolvedValue(undefined),
}));

// Mock the Stripe cleanup so the deleteUser.beforeDelete wire can be asserted.
vi.mock("@/lib/billing/cancel-on-delete", () => ({
  cancelStripeOnAccountDelete: vi.fn().mockResolvedValue(undefined),
}));

// Stub betterAuth + adapters: we don't test their internals, only the hook
vi.mock("better-auth", () => ({
  betterAuth: (opts: unknown) => ({ _opts: opts }),
}));
vi.mock("better-auth/adapters/drizzle", () => ({
  drizzleAdapter: vi.fn().mockReturnValue({}),
}));
vi.mock("better-auth/next-js", () => ({
  nextCookies: vi.fn().mockReturnValue({}),
}));

import { cancelStripeOnAccountDelete } from "@/lib/billing/cancel-on-delete";
import { claimConversation } from "@/lib/chat/anon";
// The REAL signer — the hook uses the real verifier, so we sign with the real
// signer (both keyed on the stubbed BETTER_AUTH_SECRET) to exercise the true
// sign→verify roundtrip through the auth hook.
import { signClaimToken } from "@/lib/chat/claim-cookie";
import { sendVerificationEmail } from "@/lib/email";

// Import auth AFTER all mocks are in place
import { auth } from "./auth";

// biome-ignore lint/suspicious/noExplicitAny: we need to introspect the stubbed auth config
const opts = (auth as unknown as { _opts: any })._opts;
const afterHook = opts?.databaseHooks?.user?.create?.after as
  | ((
      user: { id: string },
      context: { getCookie: (k: string) => string | null } | null,
    ) => Promise<void>)
  | undefined;

describe("C2: auth databaseHooks.user.create.after — claim wire", () => {
  it("the auth config has databaseHooks.user.create.after defined", () => {
    expect(typeof afterHook).toBe("function");
  });

  it("calls claimConversation(userId, token) when a VALID SIGNED fiska_claim cookie is present", async () => {
    vi.mocked(claimConversation).mockClear();
    vi.mocked(claimConversation).mockResolvedValue({ claimed: true });

    const rawToken = "test-claim-token-uuid";
    const fakeContext = {
      getCookie: vi.fn().mockReturnValue(signClaimToken(rawToken)),
    };

    await afterHook?.({ id: "user-123" }, fakeContext);

    // The hook must unwrap the signature and pass the RAW token downstream.
    expect(claimConversation).toHaveBeenCalledWith("user-123", rawToken);
  });

  it("does NOT call claimConversation when context is null (seed / non-request creation)", async () => {
    vi.mocked(claimConversation).mockClear();

    await afterHook?.({ id: "user-456" }, null);

    expect(claimConversation).not.toHaveBeenCalled();
  });

  it("does NOT call claimConversation when fiska_claim cookie is absent", async () => {
    vi.mocked(claimConversation).mockClear();

    const fakeContext = {
      getCookie: vi.fn().mockReturnValue(null),
    };

    await afterHook?.({ id: "user-789" }, fakeContext);

    expect(claimConversation).not.toHaveBeenCalled();
  });

  it("does NOT call claimConversation when the cookie signature is INVALID (tampered / unsigned)", async () => {
    vi.mocked(claimConversation).mockClear();

    // A raw, UNSIGNED token (no `.signature`) — the old pre-Issue-#5 format.
    // The signed-cookie verifier must reject it as "no valid claim".
    const fakeContext = {
      getCookie: vi.fn().mockReturnValue("unsigned-raw-token"),
    };

    await expect(
      afterHook?.({ id: "user-222" }, fakeContext),
    ).resolves.toBeUndefined();
    expect(claimConversation).not.toHaveBeenCalled();
  });

  it("does NOT call claimConversation when the signature is present but wrong (tampered token)", async () => {
    vi.mocked(claimConversation).mockClear();

    // Sign one token, then swap the token half — the signature no longer
    // matches the (attacker-chosen) token, so verification must fail.
    const signed = signClaimToken("original-token");
    const sig = signed.slice(signed.lastIndexOf(".") + 1);
    const tampered = `attacker-token.${sig}`;

    const fakeContext = {
      getCookie: vi.fn().mockReturnValue(tampered),
    };

    await expect(
      afterHook?.({ id: "user-333" }, fakeContext),
    ).resolves.toBeUndefined();
    expect(claimConversation).not.toHaveBeenCalled();
  });

  it("swallows claimConversation errors — the hook never throws", async () => {
    vi.mocked(claimConversation).mockClear();
    vi.mocked(claimConversation).mockRejectedValue(new Error("DB down"));

    const fakeContext = {
      getCookie: vi.fn().mockReturnValue(signClaimToken("some-token")),
    };

    // Must not throw
    await expect(
      afterHook?.({ id: "user-111" }, fakeContext),
    ).resolves.toBeUndefined();
  });
});

describe("deleteUser.beforeDelete — Stripe subscription cleanup", () => {
  const beforeDelete = opts?.user?.deleteUser?.beforeDelete as
    | ((user: {
        id: string;
        stripeCustomerId?: string | null;
      }) => Promise<void>)
    | undefined;

  it("deleteUser stays enabled and has a beforeDelete hook", () => {
    expect(opts?.user?.deleteUser?.enabled).toBe(true);
    expect(typeof beforeDelete).toBe("function");
  });

  it("passes the user id and stripeCustomerId to the Stripe cleanup", async () => {
    vi.mocked(cancelStripeOnAccountDelete).mockClear();
    vi.mocked(cancelStripeOnAccountDelete).mockResolvedValue(undefined);

    await beforeDelete?.({ id: "user-1", stripeCustomerId: "cus_123" });

    // stripeClient is null in this test env (no STRIPE_SECRET_KEY) — the
    // cleanup module owns the null guard.
    expect(cancelStripeOnAccountDelete).toHaveBeenCalledWith(null, {
      id: "user-1",
      stripeCustomerId: "cus_123",
    });
  });

  it("ABORTS the deletion (throws) when the Stripe cleanup fails", async () => {
    // The invariant: an account must never be deleted while its subscription
    // might live on — otherwise the card keeps being charged with no way to
    // log in and cancel.
    vi.mocked(cancelStripeOnAccountDelete).mockRejectedValue(
      new Error("Stripe is down"),
    );

    await expect(beforeDelete?.({ id: "user-2" })).rejects.toThrow();
  });
});

describe("email verification config (spec 2026-07-06)", () => {
  it("requires email verification for email/password", () => {
    expect(opts?.emailAndPassword?.requireEmailVerification).toBe(true);
  });

  it("sends on signup and on unverified sign-in, auto-signs-in after verify, 1h expiry", () => {
    expect(opts?.emailVerification?.sendOnSignUp).toBe(true);
    expect(opts?.emailVerification?.sendOnSignIn).toBe(true);
    expect(opts?.emailVerification?.autoSignInAfterVerification).toBe(true);
    expect(opts?.emailVerification?.expiresIn).toBe(3600);
  });

  it("wires sendVerificationEmail to the Resend module with to/name/url", async () => {
    vi.mocked(sendVerificationEmail).mockClear();

    await opts?.emailVerification?.sendVerificationEmail?.({
      user: { email: "anna@example.com", name: "Anna" },
      url: "http://localhost:3000/api/auth/verify-email?token=t",
      token: "t",
    });

    expect(sendVerificationEmail).toHaveBeenCalledWith({
      to: "anna@example.com",
      name: "Anna",
      url: "http://localhost:3000/api/auth/verify-email?token=t",
    });
  });
});
