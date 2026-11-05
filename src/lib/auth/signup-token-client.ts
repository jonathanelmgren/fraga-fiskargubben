/**
 * Browser side of the signup bot check (signup-token.ts): fetch the token when
 * the signup form opens, then hand it over at submit time so a real user never
 * sees it rejected for being too young or expired.
 */

import {
  SIGNUP_TOKEN_ENDPOINT,
  SIGNUP_TOKEN_MAX_AGE_MS,
  SIGNUP_TOKEN_MIN_AGE_MS,
} from "@/lib/auth/signup-token-shared";

export type SignupTokenGrant = { token: string; fetchedAt: number };

/** Refetch well before expiry, so slow submits cannot race the deadline. */
const REFRESH_AFTER_MS = SIGNUP_TOKEN_MAX_AGE_MS / 2;

/** Null on failure: the server then rejects the signup with a retry message. */
export async function fetchSignupToken(): Promise<SignupTokenGrant | null> {
  try {
    const res = await fetch(SIGNUP_TOKEN_ENDPOINT, { cache: "no-store" });
    if (!res.ok) return null;
    const { token } = (await res.json()) as { token: string };
    return { token, fetchedAt: Date.now() };
  } catch {
    return null;
  }
}

/** Resolves with a token the server will accept right now, or null. */
export async function readySignupToken(
  grant: SignupTokenGrant | null,
): Promise<string | null> {
  const usable =
    grant && Date.now() - grant.fetchedAt < REFRESH_AFTER_MS
      ? grant
      : await fetchSignupToken();
  if (!usable) return null;

  const wait = SIGNUP_TOKEN_MIN_AGE_MS - (Date.now() - usable.fetchedAt);
  if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait));
  return usable.token;
}
