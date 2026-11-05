/**
 * Wire contract of the signup bot check, shared by the server (signup-token.ts)
 * and the browser (signup-token-client.ts). No secrets and no server imports.
 */

export const SIGNUP_TOKEN_ENDPOINT = "/api/signup-token";

/** Carries the token issued by SIGNUP_TOKEN_ENDPOINT. */
export const SIGNUP_TOKEN_HEADER = "x-signup-token";

/** Present only when the form's hidden honeypot field was filled in. */
export const SIGNUP_HONEYPOT_HEADER = "x-signup-honeypot";

/** A signup this soon after loading the form is a script, not a person. */
export const SIGNUP_TOKEN_MIN_AGE_MS = 2000;

/** A token outlives any realistic time spent with the signup form open. */
export const SIGNUP_TOKEN_MAX_AGE_MS = 60 * 60 * 1000;
