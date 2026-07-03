# Chat-first rebuild — implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans (inline execution chosen — single executor holds full pipeline context). Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Chat-first landing, confidence-based Haiku lake resolution with unresolved-area fallback, credit charged at resolution transition, loosened topic guard, dialog auth, profile page, IP signup guard, admin bypass.

**Architecture:** Conversations gain a `status` lifecycle (`lake_pending → resolved | unresolved_area`). All pre-transition turns are Haiku-only and free; the credit is spent exactly once at the transition, right before the first Sonnet answer. The UI becomes chat-first: landing hero hands the prompt to `/ask` via sessionStorage; `/ask/[id]` is the persisted-conversation view with signal badges and a history drawer.

**Tech stack:** Next.js 16 (app router, `after()`, async `cookies()`), React 19, Drizzle/Postgres, better-auth, Anthropic SDK (zodOutputFormat structured output), Tailwind 4, vitest, playwright.

## Global constraints

- Spec: `docs/superpowers/specs/2026-07-03-chat-first-rebuild-design.md`
- `RESOLVE_CONFIDENCE_THRESHOLD = 70`, `MAX_RESOLVE_ATTEMPTS = 3`, `SIGNUP_IP_LIMIT = 3` (per 30 days)
- All user-facing time: Europe/Stockholm wall-clock (never `toISOString()` for display)
- Persona/system prompts stay byte-stable constants (prefix cache)
- Commit per task with `--no-verify` (biome pre-commit version drift)
- Swedish copy on all user surfaces; code/comments in English

---

### Task 1: Schema — conversation lifecycle + signup IP hash

**Files:** Modify `src/shared/db/schema.ts`; generate `drizzle/00xx_*.sql` via `pnpm db:generate`; apply with `pnpm db:migrate`.

- `conversations`: add `status: text("status").default("resolved").notNull()` (`'lake_pending' | 'resolved' | 'unresolved_area'`; default `'resolved'` keeps legacy rows valid), `resolveAttempts: integer("resolve_attempts").default(0).notNull()`, `userLat`/`userLon: doublePrecision` nullable. (`lakeId` is already nullable.)
- `users`: add `signupIpHash: text("signup_ip_hash")` nullable.

- [ ] Steps: edit schema → `pnpm db:generate` → `pnpm db:migrate` → commit.

### Task 2: Models + analytics event types

**Files:** Modify `src/lib/claude/models.ts` (+test), `src/lib/analytics/events.ts` (+test).

- `RESOLVER_MODEL = "claude-haiku-4-5"`.
- New events: `lake_clarify`, `lake_unresolved_area`, `signup_ip_blocked` (check existing union shape and extend).

- [ ] Steps: TDD on models test → implement → commit.

### Task 3: Candidate search — `src/lib/lakes/candidates.ts`

**Interfaces (produces):**
```ts
export type CandidateLake = Lake & { distanceKm?: number };
export async function candidateLakes(
  name: string,
  userLoc?: { lat: number; lon: number },
): Promise<CandidateLake[]>
```
- Trigram + prefix + exact ranked SQL (like `searchLakes` but returns full Lake fields + areaHa; LIMIT 10). When `name` empty and `userLoc` given: 10 nearest named lakes ordered by distance (bounded box prefilter + haversine order in SQL). When both empty: `[]`.
- Distance computed in SQL (approx planar ok) when `userLoc` present.
- Test: `src/lib/lakes/candidates.test.ts` (mock db.execute).

- [ ] Steps: failing test → implement → pass → commit.

### Task 4: Haiku resolver — `src/lib/lakes/haiku-resolver.ts`

**Interfaces (produces):**
```ts
export const RESOLVE_CONFIDENCE_THRESHOLD = 70;
export const MAX_RESOLVE_ATTEMPTS = 3;
export type HaikuResolution = {
  lakeId: string | null;
  confidence: number;        // 0-100
  noSuchLake: boolean;
  clarifyQuestion: string;   // in-persona Swedish, always present
};
export async function resolveLakeWithHaiku(params: {
  message: string;
  lakeName?: string;
  municipality?: string;
  userLoc?: { lat: number; lon: number };
  candidates: CandidateLake[];
  history?: HistoryMessage[];
  deps?: { client: Pick<Anthropic, "messages"> };
}): Promise<HaikuResolution>
```
- zodOutputFormat structured output, `RESOLVER_MODEL`, 8s timeout, typed errors like extractor.
- System prompt: Swedish-geography-aware picker; candidates listed with municipality/county/area/distance; instructed that Lantmäteriet municipality tags can differ from colloquial ones (adjacent-municipality tolerance); user location is a bias, prompt text wins; untrusted-data tag rules.
- Test with fake client: picks candidate, low confidence passthrough, noSuchLake, parse-failure → `{lakeId:null, confidence:0}`.

- [ ] Steps: failing tests → implement → pass → commit.

### Task 5: Area signals — `src/lib/signals/build-area.ts` + Signals type

**Files:** Modify `src/lib/signals/types.ts`; create `src/lib/signals/build-area.ts` + test.

- Signals type: add optional `areaOnly?: boolean`, `askedLakeName?: string`.
- **Produces:**
```ts
export async function buildAreaSignals(input: {
  label: string;              // e.g. "trakten kring Ulricehamn"
  lat: number; lon: number;
  askedLakeName?: string;
  targetTime: Date; now: Date;
}): Promise<Signals>
```
- Forecast/observed conditions + pressure/temp trends + light window only (no depth/colour/species/water-temp). Forecast cache key `area:<lat.toFixed(2)>,<lon.toFixed(2)>`. `lakeId: "area"`, `areaOnly: true`. Never throws.
- Test: fake fetchers via module mocks (follow build.test.ts patterns).

- [ ] Steps: failing test → implement → pass → commit.

### Task 6: Persona + extractor + gate copy loosening

**Files:** Modify `src/lib/chat/persona.ts` (+test), `src/lib/chat/extractor.ts` (+test), `src/lib/chat/gate-messages.ts`.

- Persona ÄMNESREGLER: fishing is home turf; weather/water/nature/outdoors answered plainly; refuse only clearly off-domain (programming, homework, politics, gossip). Drop catchphrases; add honest-mode rule for `areaOnly`/`askedLakeName` signals ("Känner inte just den sjön, men i trakten…").
- Extractor `onTopic` description loosened to match; keep injection guards.
- Gate copy: reword `CANNED_REFUSAL`; add `LAKE_CLARIFY_FALLBACK`; keep others.

- [ ] Steps: update tests → implement → pass → commit.

### Task 7: Quota — admin bypass

**Files:** Modify `src/lib/chat/quota.ts` (+test), `src/lib/is-admin.ts` unchanged.

- `canSpendCredit(user, opts?: { isAdmin?: boolean })` → true for admin; `chatTurnAllowed(count, opts?: { isAdmin?: boolean })` → true for admin. `spendCredit` not called for admins (handler skips; no counter increment).

- [ ] Steps: failing tests → implement → pass → commit.

### Task 8: ask-handler rework (core)

**Files:** Rewrite large parts of `src/lib/chat/ask-handler.ts` + `src/lib/chat/ask-handler.test.ts`.

**New input:** `AskInput.location?: { lat: number; lon: number }`.
**Deps changes:** `getSession` returns `{ user: { id, gender?, isAdmin: boolean } }`; add `candidateLakes`, `resolveLakeWithHaiku`, `getLakeById(id): Promise<Lake | null>`, `buildAreaSignals`, `createPendingConversation`, `transitionConversation` (sets lakeId/status/targetTime/signalsSnapshot), `bumpResolveAttempts`; drop `resolveLake`/old `createConversation`.
**New result type:** `{ type: "clarify"; text: string; conversationId: string; claimToken?: string }` — route persists both turns; client renders as assistant bubble. Remove `lake_ambiguous`/`lake_unresolved` results (fold into clarify; keep `lake_unresolved` string for IDOR/anomaly paths).

**Flow:**
1. Identity (+isAdmin). Anon gate now only blocks NEW conversations when a claimToken exists; anon follow-ups on their own conversation are allowed (needed for the clarify round-trip), bounded by chat-turn limit.
2. Follow-up: ownership/frozen/turn-limit (admin bypasses limit) as today, then branch on `conversation.status`:
   - `resolved` / `unresolved_area`: current follow-up path (lake-lock only for `resolved`).
   - `lake_pending`: goto resolution step with history.
3. New conversation: extract → topic gate → cheap `canSpendCredit` pre-check (block before wasting Haiku resolution) → create pending row (stores location + anon claimToken) → resolution step.
4. Resolution step (shared): candidates → Haiku resolver →
   - confidence ≥ 70 & lakeId: load lake, transition to `resolved`, charge (authoritative spendCredit unless admin/anon), buildSignals, adviseFirst (Sonnet). Refund plumbing as today.
   - `noSuchLake` or attempts+1 ≥ 3: transition to `unresolved_area`; coords = conversation.userLat/lon → candidate centroid → none; buildAreaSignals (or minimal Signals w/o conditions when no coords); charge; adviseFirst.
   - else: bump attempts, return `clarify` with resolver's question.

- [ ] Steps: rewrite tests for each path (new-resolved-first-try, clarify-then-resolved, 3-strikes→area, noSuchLake→area, credit-at-transition-only, admin bypass, anon clarify follow-up allowed, out-of-credits pre-check, IDOR unchanged) → implement → pass → commit.

### Task 9: Route — location, clarify persistence, badges header

**Files:** Modify `src/app/api/ask/route.ts` (+test), `src/lib/chat/persist-turns.ts` (only if reuse needs a text variant).

- Parse optional `location {lat,lon}` (validate finite, Sweden-ish bounds 55–70 / 10–25; else ignore).
- Wire new deps (candidateLakes, haiku resolver, area signals, transition writers, isAdmin via `isAdminEmail(session.user.email)`).
- `clarify` result → `Response.json({type:"clarify", text}, 200)` + `X-Conversation-Id` header + Set-Cookie for new anon claimToken + `after()` persisting user msg + assistant clarify text.
- Stream result → add `X-Signals` header: `encodeURIComponent(JSON.stringify({lake, status, airTempC, windMs, waterTempC}))` (values unwrapped from provenance).

- [ ] Steps: update route tests → implement → pass → commit.

### Task 10: Auth — IP signup guard + deleteUser

**Files:** Create `src/lib/auth/signup-ip.ts` (+test); modify `src/lib/auth.ts`, `src/shared/env.ts`.

- `hashSignupIp(ip: string): string` HMAC-SHA256 w/ BETTER_AUTH_SECRET; `extractClientIp(headers): string | null` (x-forwarded-for first hop, x-real-ip fallback).
- better-auth `databaseHooks.user.create.before`: extract IP → hash → count users w/ same hash createdAt > now-30d → if ≥ SIGNUP_IP_LIMIT (env, default 3) throw `APIError` with Swedish message; else return `{ data: { ...user, signupIpHash } }`. Declare `user.additionalFields.signupIpHash` (input:false). No IP found → allow.
- Enable `user: { deleteUser: { enabled: true } }`.

- [ ] Steps: failing tests (hash, extract, hook logic w/ injected count) → implement → pass → commit.

### Task 11: UI — layout, header, auth dialog

**Files:** Create `src/components/site-header.tsx`, `src/components/auth-dialog.tsx`, `src/components/avatar-menu.tsx`; modify `src/app/layout.tsx`, `src/app/globals.css`; delete `src/app/login/page.tsx` + `src/app/register/page.tsx` (replace with `redirect("/?auth=1")` server stubs); reuse `src/app/social-buttons.tsx`.

- Header: logo + brand → `/`; "Så funkar det" anchor; logged-out: "Logga in" button (opens dialog); logged-in: initials avatar + dropdown (Profil, Admin when admin, Logga ut).
- AuthDialog: overlay dialog, login mode default; "Inte registrerad? Skapa konto här" flips to signup; social buttons both modes; Swedish copy; opens when `?auth=1`.
- Brand tokens per screenshot: cream bg, deep green ink, amber CTA; keep OKLch token structure.

- [ ] Steps: build components → wire layout → visual check later (Task 14) → commit.

### Task 12: UI — landing hero + ask pages + chat rework

**Files:** Rewrite `src/app/page.tsx` (+ hero client component `src/app/hero-prompt.tsx`); create `src/app/ask/[id]/page.tsx`, `src/components/chat-drawer.tsx`; rewrite `src/app/ask/page.tsx`, `src/app/ask/chat.tsx` (+test).

- Landing: hero per screenshot (overline, H1 "Fråga gubben innan du kastar.", sub, big input + amber "Fråga", chips, "Gratis första frågan…", geolocation chip "Använd min plats", wave footer, "Så funkar det" section). Submit → sessionStorage `fg:pending-prompt` {text, location} → `router.push("/ask")`.
- `/ask`: new-chat view; Chat auto-submits pending prompt from sessionStorage; on `X-Conversation-Id` → `history.replaceState` to `/ask/<id>`.
- `/ask/[id]`: server component; ownership check (session user OR anon claim cookie); loads messages + snapshot badges; renders Chat with `initialMessages`, `initialBadges`, `conversationId`; unknown/foreign id → `notFound()`.
- Chat: signal badges strip (lake/area, lufttemp, vind, vattentemp) fed by initialBadges or `X-Signals` header; `clarify` JSON rendered as assistant bubble (conversation continues); gates as before.
- Drawer (logged-in): lists user conversations (server-loaded, newest first, title = bareLakeName ?? first-message excerpt) + "Ny chatt" → `/ask`.

- [ ] Steps: implement pages/components → adapt chat tests → pass → commit.

### Task 13: Profile page

**Files:** Create `src/app/profile/page.tsx`, `src/app/profile/profile-actions.tsx` (client: delete + premium stub).

- Server component, redirect `/` when logged out. Shows name, email, member since (sv-SE date), credits `X av 3` or `Obegränsat` (paid/admin). Danger zone: delete account (confirm dialog → `authClient.deleteUser()` → redirect `/`). Premium card: "Premium — 49 kr" STUB button → "Betalning kommer snart".

- [ ] Steps: implement → commit.

### Task 14: Verify + e2e + PR

- [ ] `pnpm ts:check`, `pnpm biome:fix`, `pnpm test` all green.
- [ ] Update `e2e/specs/*.spec.ts` for new landing/dialog (compile-checked; full run needs built server + DB).
- [ ] `pnpm build`.
- [ ] `pnpm dev` + chrome MCP: landing, auth dialog toggle, profile page, chat flows (resolved, clarify, area) — visual verification, screenshots.
- [ ] Push branch, open PR with summary + migration notes (drizzle migration, `SIGNUP_IP_LIMIT` env optional).
