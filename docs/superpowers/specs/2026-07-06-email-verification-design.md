# Email Verification for Email/Password Signup — Design

**Date:** 2026-07-06
**Status:** Approved

## Goal

Require email verification for accounts registered with email/password. Social sign-in (Google/Microsoft) is unaffected — OAuth emails are treated as verified automatically.

## Context

- Auth: better-auth v1.6.22, configured in `src/lib/auth.ts`. `requireEmailVerification` currently `false` because no mail sender exists.
- DB: Drizzle/Postgres. `verification` table and `user.email_verified` column already exist — no migration needed.
- No email infrastructure today. No real users in prod, so no backfill needed.

## Decisions

| Decision | Choice |
|---|---|
| Email provider | Resend |
| Unverified accounts | Blocked from sign-in (`requireEmailVerification: true`) |
| Existing users | Nothing — no real prod users |
| From-address | `noreply@fragafiskargubben.se`, via env var |
| Verification style | Link (better-auth built-in), not OTP code |

## Components

### 1. Mail sender — `src/lib/email.ts` (new)

- `resend` npm package.
- Exports `sendVerificationEmail({ to, url })`.
- Simple Swedish HTML + plain-text email containing the verification link.
- Sender address from `EMAIL_FROM` env var.

### 2. Environment

- `RESEND_API_KEY` (required in prod)
- `EMAIL_FROM` (default `noreply@fragafiskargubben.se`)
- Added to `src/shared/env.ts` validation and `.env.example`.

### 3. Auth config — `src/lib/auth.ts`

- `emailAndPassword.requireEmailVerification: true` — unverified login rejected (403); better-auth automatically re-sends the verification mail on such an attempt.
- `emailVerification`:
  - `sendVerificationEmail` → wired to `src/lib/email.ts`
  - `sendOnSignUp: true`
  - `autoSignInAfterVerification: true`
  - `expiresIn: 3600` (1 hour)
- Verification link callback redirects to `/`; user lands signed in.

### 4. UI — `src/components/auth-dialog.tsx`

- Successful signup → dialog switches to a "check your inbox" state instead of closing.
- Login attempt with unverified email → error message telling the user to verify, noting a new mail was sent.

## Error handling

Resend failure during signup: user is still created, mail missing. Self-healing — better-auth re-sends on next login attempt. Log the failure and alert via existing Discord alerts webhook.

## Testing

- Config-level tests (auth.test.ts) assert the verification wiring; behavioral signup→blocked-login→verify flow was verified by a live smoke test (2026-07-06). A DB-backed integration test is deferred — revisit if a better-auth upgrade changes verification semantics.

## Out of scope

- Password reset flow.
- Changes to Google/Microsoft sign-in.
- Rate limiting beyond what better-auth/existing IP guard provide.
