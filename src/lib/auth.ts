import "server-only";
import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { nextCookies } from "better-auth/next-js";
import { db } from "@/shared/db/client";
import { accounts, sessions, users, verifications } from "@/shared/db/schema";
import { env } from "@/shared/env";

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
    disableSignUp: false,
    minPasswordLength: 8,
    requireEmailVerification: false,
  },
  socialProviders: {
    google: {
      clientId: env.GOOGLE_CLIENT_ID,
      clientSecret: env.GOOGLE_CLIENT_SECRET,
    },
    microsoft: {
      clientId: env.MICROSOFT_CLIENT_ID,
      clientSecret: env.MICROSOFT_CLIENT_SECRET,
      // "common" = any work, school, or personal Microsoft account (open reg).
      tenantId: "common",
    },
  },
  plugins: [nextCookies()],
});

export type Auth = typeof auth;
