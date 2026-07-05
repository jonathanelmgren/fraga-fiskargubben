/**
 * signup-ip.ts — registration abuse guard (rebuild spec, section D).
 *
 * MAC addresses are not obtainable from a browser, so the guard is IP-based:
 * at user-creation time the client IP is HMAC-hashed (keyed with
 * BETTER_AUTH_SECRET — no raw IPs at rest) and stored on the user row; a
 * registration is rejected when SIGNUP_IP_LIMIT (default 3) accounts already
 * registered from the same hash within the last 30 days.
 *
 * Wired into Better Auth's databaseHooks.user.create.before (auth.ts), which
 * covers every registration path: email+password, Google SSO, Microsoft SSO.
 * No determinable IP → allow (never lock out users behind odd proxies).
 */

import "server-only";

import { createHmac } from "node:crypto";
import { and, count, eq, gt } from "drizzle-orm";
import type { Db } from "@/shared/db/client";
import { db as realDb } from "@/shared/db/client";
import { users } from "@/shared/db/schema";
import { env } from "@/shared/env";

/** Default max accounts per IP hash per rolling window. */
export const DEFAULT_SIGNUP_IP_LIMIT = 3;

/** Rolling window the limit applies to. */
export const SIGNUP_IP_WINDOW_MS = 30 * 24 * 60 * 60 * 1000;

/** Honest Swedish rejection shown by the signup form. */
export const SIGNUP_IP_LIMIT_MESSAGE =
  "För många konton har redan skapats från din uppkoppling. Logga in på ditt befintliga konto istället.";

export function signupIpLimit(): number {
  return env.SIGNUP_IP_LIMIT ?? DEFAULT_SIGNUP_IP_LIMIT;
}

/**
 * HMAC-SHA256 of the client IP, keyed with the auth secret — comparable for
 * counting but not reversible to the raw IP.
 */
export function hashSignupIp(ip: string): string {
  return createHmac("sha256", env.BETTER_AUTH_SECRET)
    .update(ip.trim())
    .digest("hex");
}

/**
 * Best-effort client IP from proxy headers: first hop of x-forwarded-for,
 * then x-real-ip. Returns null when no plausible IP is present.
 */
export function extractClientIp(headers: Headers): string | null {
  const forwarded = headers.get("x-forwarded-for");
  if (forwarded) {
    const first = forwarded.split(",")[0]?.trim();
    if (first) return first;
  }
  const real = headers.get("x-real-ip")?.trim();
  return real || null;
}

export interface SignupIpDeps {
  db: Pick<Db, "select">;
  now: Date;
}

/**
 * Count accounts created from this IP hash within the rolling window.
 */
export async function countRecentSignups(
  ipHash: string,
  deps: SignupIpDeps,
): Promise<number> {
  const windowStart = new Date(deps.now.getTime() - SIGNUP_IP_WINDOW_MS);
  const rows = await deps.db
    .select({ n: count() })
    .from(users)
    .where(
      and(eq(users.signupIpHash, ipHash), gt(users.createdAt, windowStart)),
    );
  return rows[0]?.n ?? 0;
}

/**
 * Decide whether a registration from `headers` is allowed.
 *
 * Returns the ipHash to stamp on the new user row (null when no IP could be
 * determined), or `{ allowed: false }` when the limit is hit.
 */
export async function checkSignupAllowed(
  headers: Headers,
  deps: SignupIpDeps = { db: realDb, now: new Date() },
): Promise<{ allowed: boolean; ipHash: string | null }> {
  const ip = extractClientIp(headers);
  if (!ip) return { allowed: true, ipHash: null };

  const ipHash = hashSignupIp(ip);
  const recent = await countRecentSignups(ipHash, deps);
  if (recent >= signupIpLimit()) {
    return { allowed: false, ipHash };
  }
  return { allowed: true, ipHash };
}
