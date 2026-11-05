import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
vi.mock("@/shared/env", () => ({
  env: { BETTER_AUTH_SECRET: "test-secret-that-is-at-least-32-chars!!" },
}));

import {
  issueSignupToken,
  isValidSignupToken,
  passesSignupBotCheck,
} from "./signup-token";
import {
  SIGNUP_HONEYPOT_HEADER,
  SIGNUP_TOKEN_HEADER,
  SIGNUP_TOKEN_MAX_AGE_MS,
  SIGNUP_TOKEN_MIN_AGE_MS,
} from "./signup-token-shared";

const ISSUED_AT = new Date("2026-11-05T10:00:00Z");
const agedBy = (ms: number) => new Date(ISSUED_AT.getTime() + ms);
const OLD_ENOUGH = agedBy(SIGNUP_TOKEN_MIN_AGE_MS);

describe("isValidSignupToken", () => {
  it("accepts a token within its age window", () => {
    const token = issueSignupToken(ISSUED_AT);
    expect(isValidSignupToken(token, OLD_ENOUGH)).toBe(true);
    expect(isValidSignupToken(token, agedBy(SIGNUP_TOKEN_MAX_AGE_MS))).toBe(
      true,
    );
  });

  it("rejects a token used faster than a person can fill in the form", () => {
    const token = issueSignupToken(ISSUED_AT);
    expect(isValidSignupToken(token, agedBy(SIGNUP_TOKEN_MIN_AGE_MS - 1))).toBe(
      false,
    );
  });

  it("rejects an expired token", () => {
    const token = issueSignupToken(ISSUED_AT);
    expect(isValidSignupToken(token, agedBy(SIGNUP_TOKEN_MAX_AGE_MS + 1))).toBe(
      false,
    );
  });

  it("rejects a backdated timestamp, whose signature no longer matches", () => {
    const signature = issueSignupToken(ISSUED_AT).split(".")[1];
    const backdated = `${ISSUED_AT.getTime() - SIGNUP_TOKEN_MIN_AGE_MS}.${signature}`;
    expect(isValidSignupToken(backdated, ISSUED_AT)).toBe(false);
  });

  it.each([
    ["missing", null],
    ["empty", ""],
    ["unsigned", "1793800000000"],
    ["wrong signature length", "1793800000000.abc"],
    ["extra segment", `${issueSignupToken(ISSUED_AT)}.extra`],
  ])("rejects a malformed token: %s", (_name, token) => {
    expect(isValidSignupToken(token, OLD_ENOUGH)).toBe(false);
  });
});

describe("passesSignupBotCheck", () => {
  const validToken = issueSignupToken(ISSUED_AT);

  it("passes the request the signup form sends", () => {
    const headers = new Headers({ [SIGNUP_TOKEN_HEADER]: validToken });
    expect(passesSignupBotCheck(headers, OLD_ENOUGH)).toBe(true);
  });

  it("fails a request with no token", () => {
    expect(passesSignupBotCheck(new Headers(), OLD_ENOUGH)).toBe(false);
  });

  it("fails a valid token when the honeypot was filled in", () => {
    const headers = new Headers({
      [SIGNUP_TOKEN_HEADER]: validToken,
      [SIGNUP_HONEYPOT_HEADER]: "1",
    });
    expect(passesSignupBotCheck(headers, OLD_ENOUGH)).toBe(false);
  });
});
