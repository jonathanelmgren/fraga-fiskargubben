/**
 * claim-cookie.test.ts — Issue #5: HMAC sign/verify for the fiska_claim cookie.
 *
 * Covers:
 *  - sign→verify roundtrip returns the original token.
 *  - the signed value is `<token>.<signature>` (token recoverable, sig appended).
 *  - tamper rejection: swapped token, flipped signature, empty halves.
 *  - graceful null on absent / malformed input (no throw).
 *  - a signature made with a different secret is rejected (secret binding).
 */

import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

// Stub env so importing claim-cookie (which reads BETTER_AUTH_SECRET) doesn't
// trip Zod validation in CI.  The explicit-secret cases below don't use this,
// but the "default secret" case does.
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

import { signClaimToken, verifyClaimToken } from "./claim-cookie";

const SECRET = "test-secret-that-is-at-least-32-chars!!";
const OTHER_SECRET = "another-secret-also-32-chars-long!!!!!!";

describe("claim-cookie: signClaimToken / verifyClaimToken", () => {
  it("roundtrips: verify(sign(token)) === token", () => {
    const token = "a1b2c3d4-e5f6-7890-abcd-ef1234567890";
    const signed = signClaimToken(token, SECRET);
    expect(verifyClaimToken(signed, SECRET)).toBe(token);
  });

  it("produces `<token>.<signature>` with the raw token as the prefix", () => {
    const token = "a1b2c3d4-e5f6-7890-abcd-ef1234567890";
    const signed = signClaimToken(token, SECRET);
    expect(signed.startsWith(`${token}.`)).toBe(true);
    // signature half is present and non-empty
    expect(signed.slice(signed.lastIndexOf(".") + 1).length).toBeGreaterThan(0);
  });

  it("rejects a tampered token (attacker swaps the token, keeps the signature)", () => {
    const signed = signClaimToken("real-token", SECRET);
    const sig = signed.slice(signed.lastIndexOf(".") + 1);
    const tampered = `attacker-token.${sig}`;
    expect(verifyClaimToken(tampered, SECRET)).toBeNull();
  });

  it("rejects a tampered signature (char-flip in the signature half)", () => {
    const signed = signClaimToken("real-token", SECRET);
    // flip the last char to a different valid base64url char
    const last = signed.at(-1);
    const flipped = last === "A" ? "B" : "A";
    const tampered = signed.slice(0, -1) + flipped;
    expect(verifyClaimToken(tampered, SECRET)).toBeNull();
  });

  it("rejects a value signed with a different secret (secret binding)", () => {
    const signed = signClaimToken("real-token", OTHER_SECRET);
    expect(verifyClaimToken(signed, SECRET)).toBeNull();
  });

  it("rejects an unsigned raw token (no separator)", () => {
    expect(verifyClaimToken("just-a-raw-uuid-no-sig", SECRET)).toBeNull();
  });

  it("rejects a value with an empty token or empty signature", () => {
    expect(verifyClaimToken(".onlysig", SECRET)).toBeNull();
    expect(verifyClaimToken("onlytoken.", SECRET)).toBeNull();
  });

  it("returns null (no throw) for absent input", () => {
    expect(verifyClaimToken(null, SECRET)).toBeNull();
    expect(verifyClaimToken(undefined, SECRET)).toBeNull();
    expect(verifyClaimToken("", SECRET)).toBeNull();
  });

  it("uses BETTER_AUTH_SECRET by default when no secret is passed", () => {
    const token = "default-secret-token";
    const signed = signClaimToken(token);
    expect(verifyClaimToken(signed)).toBe(token);
  });
});
