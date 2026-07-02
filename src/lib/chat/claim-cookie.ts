/**
 * claim-cookie.ts — HMAC signing + verification for the `fiska_claim` cookie.
 *
 * ADR-0001 specified the anon claimToken must live in a SIGNED httpOnly cookie.
 * This module is the sign/verify primitive; the caller (app/api/ask/route.ts on
 * the set side, lib/auth.ts + route.ts on the read side) owns the cookie flags.
 *
 * Wire format:  <token>.<signature>
 *   - <token>     the raw claimToken (a UUID v4 — no dots, so the last "." is an
 *                 unambiguous separator).
 *   - <signature> base64url(HMAC-SHA256(secret, token)).
 *
 * The signature does NOT encrypt the token — it authenticates it.  The token is
 * already unguessable (128-bit UUID); signing lets the server reject a tampered
 * or forged cookie WITHOUT a DB round-trip, which is the whole point of ADR-0001
 * ("prevent server-side DB reads on every request to verify the token").
 *
 * The secret is the existing `BETTER_AUTH_SECRET` (min 32 chars, already used to
 * sign Better Auth's own session cookies) — we deliberately reuse it rather than
 * introduce a new env var.
 *
 * Verification is designed to NEVER throw: a missing, malformed, or tampered
 * cookie returns `null` ("no valid claim").  Callers on the OAuth carry-over
 * path treat `null` exactly like an absent cookie, so a bad signature degrades
 * to "anonymous, unclaimed" rather than breaking sign-in.
 */

import "server-only";

import { createHmac, timingSafeEqual } from "node:crypto";
import { env } from "@/shared/env";

/** Separator between the token and its signature in the cookie value. */
const SEP = ".";

/**
 * Compute base64url(HMAC-SHA256(secret, token)).
 *
 * base64url (no padding) keeps the value cookie-safe — no `=`, `+`, or `/` that
 * would need percent-encoding.
 */
function sign(token: string, secret: string): string {
  return createHmac("sha256", secret).update(token).digest("base64url");
}

/**
 * Wrap a raw claimToken into its signed cookie value: `<token>.<signature>`.
 *
 * The secret defaults to BETTER_AUTH_SECRET; it is injectable for tests so the
 * roundtrip can be exercised without touching the real env.
 */
export function signClaimToken(
  token: string,
  secret: string = env.BETTER_AUTH_SECRET,
): string {
  return `${token}${SEP}${sign(token, secret)}`;
}

/**
 * Verify a signed cookie value and return the raw token, or `null` if the value
 * is absent, malformed, or the signature does not match.
 *
 * Never throws — any failure (no cookie, no separator, bad signature, wrong
 * length) collapses to `null` so read-side callers can treat it as "no claim".
 */
export function verifyClaimToken(
  value: string | null | undefined,
  secret: string = env.BETTER_AUTH_SECRET,
): string | null {
  if (!value) return null;

  // Split on the LAST separator: the token is a UUID (contains no ".") so the
  // final "." unambiguously delimits token from signature.  Using lastIndexOf
  // keeps us robust even if a future token format were to contain a dot.
  const sepIndex = value.lastIndexOf(SEP);
  if (sepIndex <= 0 || sepIndex === value.length - 1) return null;

  const token = value.slice(0, sepIndex);
  const providedSig = value.slice(sepIndex + 1);
  const expectedSig = sign(token, secret);

  // Constant-time comparison to avoid leaking signature bytes via timing.
  // timingSafeEqual requires equal-length buffers, so a length mismatch (which
  // implies a mismatch anyway) short-circuits to a rejection.
  const providedBuf = Buffer.from(providedSig);
  const expectedBuf = Buffer.from(expectedSig);
  if (providedBuf.length !== expectedBuf.length) return null;
  if (!timingSafeEqual(providedBuf, expectedBuf)) return null;

  return token;
}
