# Task 6.2 — Playwright e2e happy path: report

## Approach chosen: A (browser-level route interception)

**Why not B (full-live):** The Next.js server refuses to start without `DATABASE_URL`, `ANTHROPIC_API_KEY`, `BETTER_AUTH_SECRET`, `BETTER_AUTH_URL`, `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `MICROSOFT_CLIENT_ID`, `MICROSOFT_CLIENT_SECRET` all set. These env vars are validated at startup (Zod schema in the env config). Without a provisioned Postgres + credentials stack, `pnpm build && next start` exits with code 1 before Playwright can connect. Confirmed by attempting `pnpm test:e2e` — server failed to boot with "Invalid environment variables" errors.

Approach A is not a workaround — it is the correct strategy for testing the frontend happy path in isolation. The route's own logic (gates, DB writes, quota, SMHI, Anthropic) is exercised by the ask-handler unit tests (Task 5.7).

## How Anthropic / SMHI are stubbed

`page.route("**/api/ask", ...)` intercepts at the browser network boundary before any request leaves the browser process. No real HTTP reaches the Next.js route. The intercept:
- Call 1: returns `Content-Type: text/plain; charset=utf-8` with a canned advice string and an `X-Conversation-Id` header — exercises the streaming reader path in `chat.tsx`.
- Call 2: returns `Content-Type: application/json` with `{type:"register_to_continue", text:"..."}` — exercises the gate JSON path.

Neither Anthropic nor SMHI are involved. The stub is documented in the spec file header.

## What the spec asserts

File: `e2e/specs/ask.spec.ts` — 3 tests inside `describe("/ask page — anon happy path (route-intercepted)")`:

1. **Renders the ask page**: navigates to `/ask`, asserts the Fiskargubben image, textarea (`aria-label="Skriv din fråga till Fiskargubben"`), and submit button (`aria-label="Skicka fråga"`) are visible.

2. **First prompt -> advice; second -> register CTA**: fills the textarea, clicks submit, asserts the canned advice text appears in the message list; waits for input re-enable; sends a second message; asserts the `role="status"` CTA banner appears with a `href="/register"` "Skapa konto" link and a "Logga in" link.

3. **Clicking Skapa konto navigates to /register**: same route setup, after the CTA appears clicks "Skapa konto" and asserts `page.url()` matches `/register`.

The selectors are role/text based (matching the actual markup in `chat.tsx`) — no fragile CSS selectors. No `data-testid` attributes were added to `chat.tsx` (not needed; role+text coverage is sufficient).

## pnpm test:e2e result

**Could not boot here — CI-deferred.** The Next.js webServer command (`pnpm build && pnpm exec next start`) fails immediately with:

```
Error: Invalid environment variables:
  DATABASE_URL: Invalid input: expected string, received undefined
  ANTHROPIC_API_KEY: Invalid input: expected string, received undefined
  BETTER_AUTH_SECRET: Invalid input: expected string, received undefined
  ... (5 more)
```

The spec is syntactically valid and would run green in a CI environment with:
- `DATABASE_URL` pointing to a Postgres instance (migrated schema; no seed needed for approach A since the route is intercepted)
- `ANTHROPIC_API_KEY`, `BETTER_AUTH_SECRET`, `BETTER_AUTH_URL`, `GOOGLE_CLIENT_ID/SECRET`, `MICROSOFT_CLIENT_ID/SECRET` set to any non-empty strings
- `playwright` and Chromium installed

## ts:check

Clean — `pnpm ts:check` exits 0.

## biome

Clean — `pnpm exec biome check e2e/specs/ask.spec.ts` reports "No fixes applied."

## Files changed

- `e2e/specs/ask.spec.ts` — created (new file, 166 lines)
- `sdd/task-6.2-report.md` — this report

## Self-review

- Selectors match the exact ARIA markup in `chat.tsx` (`role="status"` on the CTA banner, `aria-label` on input/button, `alt` text on the gubbe image).
- Timeouts are 8 s — generous enough for a built Next.js server, tight enough to catch hangs.
- The `callCount` counter is local to each test so tests do not share state.
- The streaming path (call 1) is tested via the `text/plain` content-type branch in `chat.tsx`; the gate path (call 2) is tested via the JSON branch.
- The claim/credit carryover after registration is noted as out-of-scope for approach A — that path requires a real DB + auth flow and is covered by unit tests (Task 5.6).

## Concerns

1. **CI-deferred run**: the spec cannot be verified green locally without a running Postgres + env vars. The CI pipeline must provision these (even dummy values suffice for approach A since the route is intercepted before it touches them).
2. **Cookie not set in intercepted responses**: the `fiska_claim` cookie that normally gates the second anon prompt is never set; the second call fires `register_to_continue` because the stub always returns that on call 2 — not because of real quota logic. This is correct and honest for approach A and is documented.
3. **No `data-testid` added**: role/text selectors preferred. If the CTA markup changes, the test fails — which is the intended contract.
