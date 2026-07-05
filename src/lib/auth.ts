import "server-only";
import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { APIError } from "better-auth/api";
import { nextCookies } from "better-auth/next-js";
import { emit } from "@/lib/analytics/events";
import {
  checkSignupAllowed,
  SIGNUP_IP_LIMIT_MESSAGE,
} from "@/lib/auth/signup-ip";
import { claimConversation } from "@/lib/chat/anon";
import { verifyClaimToken } from "@/lib/chat/claim-cookie";
import { notifyDiscord } from "@/lib/notify/discord";
import { db } from "@/shared/db/client";
import { accounts, sessions, users, verifications } from "@/shared/db/schema";
import { env } from "@/shared/env";

/** Cookie name must stay in sync with CLAIM_TOKEN_COOKIE in app/api/ask/route.ts. */
const CLAIM_TOKEN_COOKIE = "fiska_claim";

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
    },
  }),
  emailAndPassword: {
    enabled: true,
    // Open registration: anyone can sign up. No email sender wired yet, so
    // verification is off — turn on once a transactional mail path exists.
    // Abuse is bounded by the signup IP guard in the user.create.before hook.
    disableSignUp: false,
    minPasswordLength: 8,
    requireEmailVerification: false,
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
  plugins: [nextCookies()],
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
