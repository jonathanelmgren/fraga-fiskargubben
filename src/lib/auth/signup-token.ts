/**
 * signup-token.ts — server side of the signup bot check.
 *
 * POST /api/auth/sign-up/email needs no browser: without a cookie Better Auth
 * skips its origin check, so one scripted request creates a user row and sends
 * a verification mail. This check requires what only the signup form sends: a
 * token fetched from our own origin (cross-origin pages cannot read it), at
 * least SIGNUP_TOKEN_MIN_AGE_MS old, and an empty honeypot.
 *
 * It stops blind scripts and form-filling bots. A script written against this
 * site can still fetch a token and wait; the signup IP guard bounds those.
 *
 * Wire format: <issuedAtMs>.<signature>. Stateless, so tokens are reusable until
 * they expire.
 */

import "server-only";

import { createHmac, timingSafeEqual } from "node:crypto";
import {
  SIGNUP_HONEYPOT_HEADER,
  SIGNUP_TOKEN_HEADER,
  SIGNUP_TOKEN_MAX_AGE_MS,
  SIGNUP_TOKEN_MIN_AGE_MS,
} from "@/lib/auth/signup-token-shared";
import { env } from "@/shared/env";

const SEP = ".";

/** Keeps these signatures from validating as any other BETTER_AUTH_SECRET HMAC. */
const SIGNATURE_CONTEXT = "signup-token";

/** Shown by the signup form; reloading fetches a new token. */
export const SIGNUP_BOT_CHECK_MESSAGE =
  "Vi kunde inte skapa kontot. Ladda om sidan och försök igen.";

function sign(issuedAtMs: string): string {
  return createHmac("sha256", env.BETTER_AUTH_SECRET)
    .update(`${SIGNATURE_CONTEXT}:${issuedAtMs}`)
    .digest("base64url");
}

export function issueSignupToken(now: Date = new Date()): string {
  const issuedAtMs = String(now.getTime());
  return `${issuedAtMs}${SEP}${sign(issuedAtMs)}`;
}

/** Never throws: anything malformed is simply not a valid token. */
export function isValidSignupToken(
  token: string | null,
  now: Date = new Date(),
): boolean {
  if (!token) return false;
  const [issuedAtMs, signature, ...rest] = token.split(SEP);
  if (!issuedAtMs || !signature || rest.length > 0) return false;

  const provided = Buffer.from(signature);
  const expected = Buffer.from(sign(issuedAtMs));
  if (provided.length !== expected.length) return false;
  if (!timingSafeEqual(provided, expected)) return false;

  const age = now.getTime() - Number(issuedAtMs);
  return age >= SIGNUP_TOKEN_MIN_AGE_MS && age <= SIGNUP_TOKEN_MAX_AGE_MS;
}

export function passesSignupBotCheck(
  headers: Headers,
  now: Date = new Date(),
): boolean {
  if (headers.has(SIGNUP_HONEYPOT_HEADER)) return false;
  return isValidSignupToken(headers.get(SIGNUP_TOKEN_HEADER), now);
}
