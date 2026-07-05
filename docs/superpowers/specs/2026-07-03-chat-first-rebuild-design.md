# Chat-first rebuild — design

Date: 2026-07-03
Status: approved (user approved summary in session; implementation on branch `rebuild-chat-first-ui`)

## Goal

Rebuild the site around a chat-first landing page, rework lake resolution to a
confidence-based multi-turn flow that tolerates unresolvable lakes, loosen the
topic guard, move auth into dialogs, add profile page, guard signups by IP, and
exempt admins from limits.

## A. Lake resolution rework (server)

### Conversation lifecycle

- Conversation row is created on the **first prompt**, before any lake is
  known. No credit charged at creation.
- New/changed columns on `conversations`:
  - `lakeId` → nullable.
  - `status`: `'lake_pending' | 'resolved' | 'unresolved_area'` (default
    `lake_pending`).
  - `resolveAttempts`: int, default 0.
  - `userLat`, `userLon`: double precision, nullable — browser geolocation
    captured at first prompt.
- `signalsSnapshot` stays the frozen billable context, written at the moment
  the conversation leaves `lake_pending`.

### Location

- Client asks for browser geolocation on the landing page (soft ask — small
  UI affordance, not an immediate browser prompt). If granted, `{lat, lon}`
  rides along on `POST /api/ask` and is stored on the conversation.
- Location precedence: **place named in the prompt beats browser location**.
  Browser location is a tiebreaker/bias, never an override of explicit text.

### Resolver

Two-stage, all pre-resolution turns are Haiku-only and free:

1. **Candidate search (SQL)** — trigram + prefix match on lake name,
   top ~10 candidates with `name, municipality, county, lat, lon, areaHa`
   and, when user location is known, distance from user. If the extractor
   found a municipality, do not hard-filter on it — include it as a signal.
2. **Haiku resolver call** — input: user prompt, extracted lake/municipality,
   candidate list (with distances), user location if any. Output (structured):
   `{ lakeId: string | null, confidence: 0–100, noSuchLake: boolean,
   clarifyQuestion?: string }`. Haiku brings world knowledge of Swedish
   geography (knows Ulricehamn borders Borås), which fixes the
   "Åsunden ulricehamn" case where Lantmäteriet tags the lake `Borås`.

Decision rule:

- `confidence >= 70` → transition to `resolved`.
- `confidence < 70` → stream an in-persona clarify question (Haiku text),
  `resolveAttempts++`. Free.
- `resolveAttempts >= 3` **or** `noSuchLake` with high confidence →
  transition to `unresolved_area`.

### Unresolved-area mode

- Area coords fallback order: user browser location → centroid of top
  candidates → none.
- With coords: build a reduced Signals set from SMHI (wind, air temp,
  pressure, cloud, light window). No lake-specific data (water temp, depth,
  species, colour).
- Without coords: no signals; the gubbe gives honest general seasonal advice.
- Persona is honest: "Känner inte just den sjön, men i trakten…".

### Credit

- Charged **exactly once**, at the transition out of `lake_pending`
  (to `resolved` OR `unresolved_area`), immediately before the first Sonnet
  answer. Refund-on-stream-failure logic kept.
- Admins (email in `ADMIN_EMAILS`) bypass the credit cap and the chat-turn
  limit.
- Anon flow unchanged: one free conversation per claim token, carried over on
  registration.

### Models

- Extractor: Haiku (unchanged).
- Lake resolver: Haiku (new call).
- First answer: Sonnet with adaptive thinking (unchanged).
- Follow-ups: Haiku (unchanged).

## B. Topic guard loosening

- Persona ÄMNESREGLER rewritten: fishing is the home turf, but adjacent
  outdoors/nature/weather questions are answered plainly ("hur blåser det
  nu?", "hur kallt är vattnet?", "blir det regn?"). Refuse only clearly
  off-domain asks (programming, homework, politics, celebrity gossip, etc.),
  still in character but without catchphrases.
- Extractor `onTopic` loosened to match: weather/conditions/outdoors counts
  as on-topic.
- Drop scripted catchphrases ("fiskarna vet om det" etc.) from persona text.

## C. UI rebuild

### Landing `/`

- Hero: logo (gubbe), overline, H1 "Fråga Fiskargubben", subheading, big
  prompt input with placeholder + submit button, suggestion chips —
  per user's screenshot direction, existing brand (cream bg, deep green,
  teal/amber accents).
- Soft geolocation affordance near the input ("Använd min plats" toggle/chip);
  browser permission requested only on interaction.
- Submit: POST `/api/ask` (creates conversation) → redirect to `/ask/<id>`
  where the first answer streams.

### `/ask/[id]` chat

- Chat thread as today (bubbles, streaming, gates), plus:
- **Signal badges** strip above/below thread: lake name, air temp, wind,
  water temp (when present in snapshot). Unresolved conversations show an
  "område"-style badge instead of a lake.
- Logged in: collapsible drawer/sidebar listing user's conversations
  (title = lake or first prompt excerpt, date) + "Ny chatt" button.
- Anon: no drawer.

### Auth dialogs

- `/login` and `/register` pages removed. One dialog, two modes: login form
  default, link "Inte registrerad? Skapa konto här" flips to signup (and
  back). Social buttons in both modes.
- Header: only "Logga in" button when logged out.
- Old routes `/login`, `/register` redirect to `/?auth=1` which opens the
  dialog.

### Logged-in header

- Initials avatar + dropdown: Profil, Logga ut (admin: link to analytics).

### `/profile`

- Shows user data (name, email, credits used, plan).
- Delete account (danger zone, confirm dialog) — better-auth delete +
  cascade.
- Premium upsell: 49 SEK — **STUB** button; no payment provider. Marks
  nothing; shows "kommer snart" state after click.

## D. Signup abuse guard

- MAC addresses are not obtainable from a browser — dropped.
- Store `signupIpHash` (HMAC-SHA256 of client IP with BETTER_AUTH_SECRET) on
  the user row at creation.
- Better-auth `before`-create hook: count users with same `signupIpHash`
  created in the last 30 days; reject with honest Swedish message when >= 3.
  Applies to email and OAuth paths.

## E. Out of scope

- Real payments, email verification, changes to anon claim flow, ETL.

## Testing

- Unit tests (vitest) for: resolver decision rule, credit-at-transition,
  attempt counting, unresolved-area signal building, admin bypass, IP guard
  hook, extractor loosening (prompt fixtures), gate messages.
- e2e (playwright) updated for new landing + dialog auth.
- Manual UI verification via chrome MCP against `pnpm dev`.
