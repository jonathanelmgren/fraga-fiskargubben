import "server-only";
import { stripe } from "@better-auth/stripe";
import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { APIError } from "better-auth/api";
import { nextCookies } from "better-auth/next-js";
import { eq } from "drizzle-orm";
import Stripe from "stripe";
import { emit } from "@/lib/analytics/events";
import {
  checkSignupAllowed,
  SIGNUP_IP_LIMIT_MESSAGE,
} from "@/lib/auth/signup-ip";
import { claimConversation } from "@/lib/chat/anon";
import { verifyClaimToken } from "@/lib/chat/claim-cookie";
import {
  sendExistingAccountEmail,
  sendPasswordResetEmail,
  sendVerificationEmail,
} from "@/lib/email";
import { notifyDiscord } from "@/lib/notify/discord";
import { db } from "@/shared/db/client";
import {
  accounts,
  sessions,
  subscriptions,
  users,
  verifications,
} from "@/shared/db/schema";
import { env } from "@/shared/env";

/** Cookie name must stay in sync with CLAIM_TOKEN_COOKIE in app/api/ask/route.ts. */
const CLAIM_TOKEN_COOKIE = "fiska_claim";

/**
 * Stripe subscription billing (@better-auth/stripe).
 *
 * Optional at boot (dev/CI without a Stripe account): when STRIPE_SECRET_KEY
 * is unset the plugin is not registered and every /api/auth/subscription/*
 * endpoint 404s — mirrors the RESEND_API_KEY pattern.
 *
 * The single plan ("premium") is resolved by Price lookup_key, so the price
 * can be changed from the Stripe Dashboard (create new Price with
 * transfer_lookup_key) without touching code or env.
 *
 * users.isPaid stays the app-side source of truth for quota (ADR-0004); the
 * subscription lifecycle hooks below keep it in sync. paid ⇔ subscription
 * status is active or trialing — past_due/unpaid (failed renewals after
 * Smart Retries) and canceled all drop back to free.
 */
const stripeClient = env.STRIPE_SECRET_KEY
  ? new Stripe(env.STRIPE_SECRET_KEY)
  : null;

async function setPaid(userId: string, isPaid: boolean) {
  await db.update(users).set({ isPaid }).where(eq(users.id, userId));
}

const PAID_STATUSES = ["active", "trialing"];

export const auth = betterAuth({
  secret: env.BETTER_AUTH_SECRET,
  baseURL: env.BETTER_AUTH_URL,
  database: drizzleAdapter(db, {
    provider: "pg",
    schema: {
      user: users,
      session: sessions,
      account: accounts,
      verification: verifications,
      subscription: subscriptions,
    },
  }),
  emailAndPassword: {
    enabled: true,
    // Open registration: anyone can sign up. Abuse is bounded by the signup
    // IP guard in the user.create.before hook.
    disableSignUp: false,
    minPasswordLength: 8,
    // Unverified accounts cannot sign in (403 EMAIL_NOT_VERIFIED); the mail
    // path is src/lib/email.ts (Resend). OAuth (Google/Microsoft) accounts
    // are treated as verified by better-auth and are unaffected.
    requireEmailVerification: true,
    // Password reset: mail a link that lands on /reset-password?token=…
    // (better-auth's GET /reset-password/:token callback appends the token).
    // Same never-throws contract as the other mails (src/lib/email.ts).
    sendResetPassword: async ({ user, url }) => {
      await sendPasswordResetEmail({ to: user.email, name: user.name, url });
    },
    // A reset proves control of the email — kick out anyone else holding a
    // session (e.g. a stolen cookie, or the reason the user is resetting).
    revokeSessionsOnPasswordReset: true,
    // With requireEmailVerification, a signup for an EXISTING email returns
    // the same generic "check your inbox" response as a fresh one (anti-
    // enumeration) and creates nothing — so without this hook the real owner
    // (e.g. a Google-SSO user re-registering with a password) waits for a
    // verification mail that never comes. Tell them by mail instead, with the
    // sign-in methods their account actually has.
    onExistingUserSignUp: async ({ user }) => {
      // Never throws: a failed notice mail must not turn the (deliberately
      // successful-looking) duplicate-signup response into a 500.
      try {
        const linked = await db
          .select({ providerId: accounts.providerId })
          .from(accounts)
          .where(eq(accounts.userId, user.id));
        await sendExistingAccountEmail({
          to: user.email,
          name: user.name,
          providers: linked.map((a) => a.providerId),
        });
      } catch (err) {
        console.error(
          `[auth] existing-account notice for ${user.email} failed:`,
          err,
        );
      }
    },
  },
  emailVerification: {
    sendVerificationEmail: async ({ user, url }) => {
      await sendVerificationEmail({ to: user.email, name: user.name, url });
    },
    // Mail on signup AND on every unverified login attempt — a lost first
    // mail is self-healing (the user just tries to log in again).
    sendOnSignUp: true,
    sendOnSignIn: true,
    // Clicking the link both verifies and signs in, landing on callbackURL.
    autoSignInAfterVerification: true,
    expiresIn: 3600, // 1 hour
  },
  user: {
    // signupIpHash is stamped by the before-create hook (never client input).
    additionalFields: {
      signupIpHash: {
        type: "string",
        required: false,
        input: false,
      },
    },
    // Profile page: self-service account deletion (cascades wipe sessions,
    // accounts and conversations via the FK on delete rules).
    deleteUser: {
      enabled: true,
    },
  },
  socialProviders: {
    google: {
      clientId: env.GOOGLE_CLIENT_ID,
      clientSecret: env.GOOGLE_CLIENT_SECRET,
    },
    microsoft: {
      clientId: env.MICROSOFT_CLIENT_ID,
      clientSecret: env.MICROSOFT_CLIENT_SECRET,
      // "consumers" = personal Microsoft accounts only (outlook/hotmail/live).
      // Entra app is registered as "personal accounts only" to avoid the
      // multitenant publisher-verification (MPN) consent gate.
      tenantId: "consumers",
    },
  },
  plugins: [
    ...(stripeClient
      ? [
          stripe({
            stripeClient,
            // env.ts superRefine guarantees this is set whenever
            // STRIPE_SECRET_KEY is (stripeClient non-null ⇒ secret present).
            stripeWebhookSecret: env.STRIPE_WEBHOOK_SECRET as string,
            // Customer is created lazily at first checkout — signup stays a
            // single-purpose flow (and works when Stripe is down).
            createCustomerOnSignUp: false,
            subscription: {
              enabled: true,
              plans: [{ name: "premium", lookupKey: "premium_yearly" }],
              onSubscriptionComplete: async ({ subscription }) => {
                await setPaid(subscription.referenceId, true);
                // Ops ping — fire-and-forget, never blocks the webhook (same
                // pattern as the signup ping below).
                void db
                  .select({ name: users.name, email: users.email })
                  .from(users)
                  .where(eq(users.id, subscription.referenceId))
                  .limit(1)
                  .then(([u]) =>
                    notifyDiscord(
                      "signups",
                      `💰 Ny premium-prenumerant: ${u ? `${u.name} (${u.email})` : subscription.referenceId}`,
                    ),
                  )
                  .catch(() => {});
              },
              onSubscriptionUpdate: async ({ subscription }) => {
                await setPaid(
                  subscription.referenceId,
                  PAID_STATUSES.includes(subscription.status),
                );
              },
              onSubscriptionDeleted: async ({ subscription }) => {
                await setPaid(subscription.referenceId, false);
              },
            },
          }),
        ]
      : []),
    nextCookies(),
  ],
  // C2: claim the anon conversation on registration so the credit carry-over
  // (ADR-0001/ADR-0004) is applied for every registration path (email+password,
  // Google SSO, Microsoft SSO).
  //
  // Implementation choice: databaseHooks.user.create.after is the correct hook
  // because it fires *after* the user row exists in the DB (so claimConversation
  // can write userId to the conversation) and it receives the request context
  // which exposes getCookie() — no need for next/headers, no async context
  // issues, and it covers all registration flows in one place.
  //
  // The hook is fire-and-forget (no throw on failure): a claim failure is
  // non-fatal — the user account is already created and the conversation row
  // remains unclaimed (will be GC'd by gcUnclaimedAnon).  A failed claim does
  // NOT prevent sign-in.
  databaseHooks: {
    user: {
      create: {
        // Signup abuse guard (rebuild spec D): reject when too many accounts
        // registered from the same (hashed) IP in the rolling window; stamp
        // the hash on the row otherwise. Runs BEFORE the insert so a blocked
        // registration never creates a row — and covers email + OAuth alike.
        // No determinable IP (context-less creation, odd proxies) → allow.
        async before(user, context) {
          const headers = context?.headers ?? context?.request?.headers;
          if (!headers) return { data: user };

          const { allowed, ipHash } = await checkSignupAllowed(headers);
          if (!allowed) {
            await emit({ type: "signup_ip_blocked" }).catch(() => {});
            throw new APIError("TOO_MANY_REQUESTS", {
              message: SIGNUP_IP_LIMIT_MESSAGE,
            });
          }
          return {
            data: ipHash ? { ...user, signupIpHash: ipHash } : user,
          };
        },
        async after(user, context) {
          // Ops ping — fire-and-forget, never blocks registration.
          void notifyDiscord(
            "signups",
            `🎣 Ny användare: ${user.name} (${user.email})`,
          );

          // context is null when the user is created outside of a request
          // (e.g. tests, seed scripts) — skip the claim in that case.
          if (!context) return;

          // The fiska_claim cookie is HMAC-signed on the set side (ADR-0001,
          // src/lib/chat/claim-cookie.ts).  verifyClaimToken returns the raw
          // token only if the signature checks out; a missing, malformed, or
          // tampered cookie yields null → treated as "no claim to carry over"
          // (no throw — the OAuth/registration flow proceeds normally).
          const signed = context.getCookie(CLAIM_TOKEN_COOKIE);
          const token = verifyClaimToken(signed);
          if (!token) return;

          try {
            const { claimed } = await claimConversation(user.id, token);
            // M7: expire the claim cookie after a successful claim so a stale
            // token can't be replayed and the anon-quota gate doesn't keep
            // tripping for the now-registered user.
            if (claimed) {
              try {
                const { cookies } = await import("next/headers");
                (await cookies()).delete(CLAIM_TOKEN_COOKIE);
              } catch {
                // Cookie store unavailable outside a request context — ignore.
              }
            }
          } catch (err) {
            // Claim failures are non-fatal: the user account was created
            // successfully; the unclaimed conversation will be GC'd by TTL.
            // L: log (don't swallow silently) so a lost carry-over credit is
            // debuggable rather than vanishing without a trace.
            console.warn(
              `[auth] claimConversation failed for user ${user.id} — carry-over credit not applied:`,
              err,
            );
          }
        },
      },
    },
  },
});

export type Auth = typeof auth;
