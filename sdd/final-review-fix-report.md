# Final Review Fix Report — Fråga Fiskargubben

Date: 2026-06-29

## Summary

Three findings fixed across 6 files + 1 new test file. 15 new tests added.

---

## C1 (CRITICAL) — Bad time string throws a 500

### What was changed

**Layer 1 — ask-handler.ts** (line ~249):
Replaced the direct `new Date(extraction.time)` with a guarded parse:

```ts
const parsedTime = extraction.time ? new Date(extraction.time) : null;
const targetTime =
  parsedTime !== null && !Number.isNaN(parsedTime.getTime())
    ? parsedTime
    : deps.now;
```

If the Extractor returns a Swedish free-text time like "ikväll" or "på lördag", `new Date()` produces an Invalid Date. The guard detects it (`Number.isNaN(…getTime())`) and falls back to `deps.now`. A comment notes that proper Swedish relative-time resolution is a follow-up task.

**Layer 2 — build.ts** (line ~108):
Added a defense-in-depth guard at the start of `buildSignals` to honor the ADR-0002 never-throws contract regardless of what the caller passes in:

```ts
const safeTargetTime = !Number.isNaN(targetTime.getTime()) ? targetTime : now;
```

All subsequent uses of `targetTime` inside `buildSignals` were replaced with `safeTargetTime` (including `toISOString()`, `seasonFromDate()`, `sunTimes()`, `lightWindow()`).

### Tests added (ask-handler.test.ts + build.test.ts)

- `ask-handler`: "does NOT throw when extraction.time is 'ikväll'"
- `ask-handler`: "calls buildSignals with deps.now when extraction.time is unparseable"
- `ask-handler`: "uses the parsed date when extraction.time is a valid ISO string"
- `build`: "does not throw when targetTime is an Invalid Date"
- `build`: "falls back to now for timeLocal when targetTime is Invalid Date"

---

## C2 (CRITICAL) — Anon→register Claim is never wired

### Approach chosen: `databaseHooks.user.create.after` in auth.ts

The Better Auth `databaseHooks.user.create.after` hook was chosen over a server action because:

1. **Covers all registration paths** (email+password, Google SSO, Microsoft SSO) in a single place. A server action on the register page would only cover the email+password path.
2. **No async context issues**: the hook receives the request `context` which exposes `context.getCookie(key)` — direct access to the cookie from the live HTTP request, no `next/headers` `await cookies()` required.
3. **Fires after the user row exists**: `claimConversation` needs to write `userId` to the conversation — the `after` hook guarantees the user row is in the DB.
4. **Non-fatal**: a claim failure is swallowed inside the hook; the user account is already created. The unclaimed conversation will be GC'd by `gcUnclaimedAnon`.

### What was changed

**src/lib/auth.ts**: Added `claimConversation` import and `databaseHooks` config block:

```ts
databaseHooks: {
  user: {
    create: {
      async after(user, context) {
        if (!context) return;
        const token = context.getCookie(CLAIM_TOKEN_COOKIE);
        if (!token) return;
        try {
          await claimConversation(user.id, token);
        } catch {
          // swallowed — user account already created
        }
      },
    },
  },
},
```

The `CLAIM_TOKEN_COOKIE = "fiska_claim"` constant is defined locally in auth.ts. It must remain in sync with the same constant in `app/api/ask/route.ts` (both are `"fiska_claim"`). A comment documents this.

### Tests added (src/lib/auth.test.ts — new file)

- "the auth config has databaseHooks.user.create.after defined"
- "calls claimConversation(userId, token) when fiska_claim cookie is present"
- "does NOT call claimConversation when context is null (seed / non-request creation)"
- "does NOT call claimConversation when fiska_claim cookie is absent"
- "swallows claimConversation errors — the hook never throws"

---

## I1 (IMPORTANT) — Lake label degraded + lake-lock coupled to the bug

### Problem

`ask-handler.ts` was passing `label: lake.name ?? lake.id` instead of the canonical `"name (municipality, county)"` format. This meant `Signals.lake` (the display label) was wrong. Worse: the lake-lock comparison `isLakeLockViolation(extraction, lockedLakeName)` in route.ts derived `lockedLakeName` from `snapshot.lake` — and since `snapshot.lake` was the bare name, the comparison happened to work. Fixing the label without fixing the lock would silently break the lock.

### Decoupling approach

1. **`Signals` type** (`types.ts`): added optional `bareLakeName?: string` field to carry the bare lake name ("Tolken") alongside the formatted label ("Tolken (Borås, Västra Götaland)").

2. **`buildSignals`** (`build.ts`): populates `signals.bareLakeName = lake.name` in the assembled Signals object.

3. **`ask-handler.ts`**: changed `label` to use `formatLabel({ name, municipality, county })` from `resolve-helpers.ts`. Unnamed lakes (name = null) fall back to `lake.id` for both label and bareLakeName.

4. **`route.ts`**: changed `lakeName` derivation for the lake-lock to:
   ```ts
   lakeName:
     row.signalsSnapshot?.bareLakeName ??
     row.signalsSnapshot?.lake ??
     null,
   ```
   Old snapshots (pre-fix, without `bareLakeName`) fall back to `snapshot.lake` — this may degrade (lock compares against the label) but is graceful and safe.

### Tests added (ask-handler.test.ts + build.test.ts)

- `ask-handler`: "calls buildSignals with a formatted label (name + municipality + county)"
- `ask-handler`: "lake-lock fires correctly when extraction.lakeName differs from the bare stored name" — asserts `isLakeLockViolation` is called with the bare name (no parentheses)
- `ask-handler`: "lake-lock passes when extraction.lakeName matches the bare stored name"
- `build`: "includes bareLakeName matching lake.name"
- `build`: "bareLakeName is distinct from lake.label when label is formatted"

---

## Build + Quality Results

### pnpm test

```
Test Files  27 passed (27)
      Tests  293 passed | 12 skipped (305)
```

Baseline was 278 passed | 12 skipped across 26 test files. 15 new tests added.

### pnpm ts:check

```
(no output — clean exit 0)
```

### pnpm biome

```
Checked 108 files in 27ms. No fixes applied. (exit 0)
```

### pnpm build (dummy env)

```
Compiled successfully in 2.9s
Running TypeScript ... Finished in 2.7s
Generating static pages (13/13)
(exit 0 — Better Auth low-entropy-secret warnings expected with dummy values)
```

---

## Files Changed

- `src/lib/chat/ask-handler.ts` — C1 time guard + I1 formatLabel
- `src/lib/signals/build.ts` — C1 defense-in-depth safeTargetTime + I1 bareLakeName
- `src/lib/signals/types.ts` — I1 bareLakeName field added
- `src/lib/auth.ts` — C2 databaseHooks.user.create.after wire
- `src/app/api/ask/route.ts` — I1 lakeName derivation from bareLakeName
- `src/lib/chat/ask-handler.test.ts` — C1 + I1 tests appended
- `src/lib/signals/build.test.ts` — C1 + I1 tests appended
- `src/lib/auth.test.ts` — NEW FILE — C2 tests
