# Lake switch during and after resolution — design

**Date:** 2026-07-08
**Status:** Approved
**Motivation:** User feedback (Facebook, Jonas Forsberg): asked about "Stallarholmen" (an ort),
got an instant weather-only answer, then tried "Mälaren", a western-Mälaren area, and finally
"Hjälmaren" — all in the same conversation, all dead ends. Root cause: once a conversation
leaves `lake_pending`, no later message ever reaches the lake resolver. `unresolved_area` is a
trap with no escape, and `resolved` conversations hard-lock to their first lake.

## Problem

Three related defects in the lake-resolution lifecycle (`src/lib/chat/ask-handler.ts`):

1. **`unresolved_area` is a dead end.** Follow-up turns load the frozen area snapshot and call
   `adviseFollowup` — the resolver never runs again. A user who names a perfectly resolvable
   lake ("Hjälmaren") gets an answer generated from a frozen area snapshot that knows nothing
   about it.
2. **`waterKind: "ort"` transitions instantly.** A named ort short-circuits to
   `unresolved_area` on the first message: credit charged, zero clarify rounds. The user most
   likely means a lake near that ort.
3. **`resolveAttempts` strikes are per-conversation, not per-lake.** Clarify strikes accumulated
   on lake A count against lake B when the user pivots mid-clarification. (Only bites when B
   also resolves below the confidence threshold, since the confident-pick branch runs first.)

Additionally, the lake-lock on `resolved` conversations ("starta en ny chatt") is being
retired as a product decision: switching lakes inside one chat is now allowed.

## Credit model (decision)

**One credit per conversation, unchanged.** The credit is charged exactly once, at the first
transition out of `lake_pending` (either to `resolved` or `unresolved_area`). Lake switches
after that are free. Cost is bounded by the existing turn caps: wind-down at turn 15
(`WINDING_DOWN_TURN`, `src/lib/chat/quota.ts`), hard freeze at ~20 turns (`conversations.frozen`).

This amends the lake-lock rationale attached to ADR-0004: the *conversation* remains the
billable unit; it is no longer bound to a single lake.

## Design

### 1. New column: `conversations.pendingLakeName`

`text`, nullable, default null. Tracks the lake name currently being resolved via clarify
rounds. Used in both lifecycle phases:

- **`lake_pending`:** set to the extracted `lakeName` on each clarify round. On the next
  message, if the newly extracted `lakeName` differs (case-insensitive), reset
  `resolveAttempts` to 0 before evaluating the strike limit — a pivot to a new lake starts
  fresh.
- **Post-transition (`resolved` / `unresolved_area`):** set when a switch attempt ends in a
  clarify round. On the next message, a bare clarify reply ("i Örebro") continues the switch
  when the extractor produced a `municipality` — the resolver then runs with
  `conversation.pendingLakeName` as the target; it already receives conversation history, so
  Haiku combines name + municipality. A reply with neither lake name nor municipality is a
  normal follow-up (the pending name is kept for a later reply). Cleared on successful
  resolution; **kept** on give-up so a re-mention of the same failed name does not reset the
  strike count (a confident resolution still wins — the resolver always runs first).

**Attempts-reset rule (both phases):** whenever the resolution target changes —
`extraction.lakeName` present and different (case-insensitive) from `pendingLakeName`,
including when `pendingLakeName` is null — reset `resolveAttempts` to 0 before evaluating
the strike limit. In particular, the first switch attempt after a transition always starts
with a fresh strike count, even when the conversation reached `unresolved_area` via
`attempts_exhausted`.

### 2. Post-transition switch path (replaces lake-lock)

In the follow-up branch of `handleAsk` (currently `ask-handler.ts:615–663`), before
`adviseFollowup`:

**Trigger:** `effectiveLakeName` is present, AND `extraction.waterKind` is `"sjö"`, `"annat"`,
or undefined, AND (status is `unresolved_area`, OR status is `resolved` and
`effectiveLakeName` ≠ `bareLakeName` case-insensitive).

**Flow when triggered** — run `candidateLakes(effectiveLakeName, userLoc)` +
`resolveLakeWithHaiku` (with history), then:

- **Confident (≥ `RESOLVE_CONFIDENCE_THRESHOLD`):** `resolveTargetTime`, `buildSignals`,
  `transitionConversation({ status: "resolved", lakeId, targetTime, signalsSnapshot })`.
  No credit charge. Reset `resolveAttempts` to 0, clear `pendingLakeName`. Update the
  conversation `title` when the extractor produced one. Stream `adviseFirst` with the new
  signals and badges. Emit a new `lake_switched` analytics event with payload
  `{ fromLakeId, toLakeId, fromStatus, lakeName, confidence, attempt }`.
- **Not confident:** free clarify round (same response shape as pending-phase clarify).
  Set `pendingLakeName = effectiveLakeName`, increment `resolveAttempts`. Status and
  snapshot unchanged.
- **Attempts exhausted (`MAX_RESOLVE_ATTEMPTS`) or resolver says `noSuchLake`:** give up on
  the switch. Keep `pendingLakeName`, set `resolveAttempts = MAX_RESOLVE_ATTEMPTS` — a
  re-mention of the same name goes straight back to give-up (unless the resolver is
  confident, which always wins), while a different lake name is a pivot and resets the
  strikes. Return a persona message: can't find that lake, continuing with the current
  context. No status change, no charge, no second `unresolved_area` transition.

**Non-triggers (normal follow-up):** same lake re-mentioned in a `resolved` chat; mention of
älv/kust/ort water kinds; no lake name and no pending name.

Delete the lake-lock branch, `isLakeLockViolation`, and `getLakeLockRedirect`. The
`lake_lock` event type stays defined for historical analytics rows but is never emitted again.

### 3. Ort clarify round (`lake_pending`)

`waterKind: "ort"` no longer short-circuits to `unresolved_area`. Instead it costs one
clarify round with a static template:

> "{namn} låter som en ort snarare än en sjö. Vilken sjö i närheten är det du tänker på?"

The round increments `resolveAttempts` and sets `pendingLakeName` like any clarify. The ort
clarify fires only when the ort name is a new resolution target (differs from
`pendingLakeName`); the user insisting on the SAME ort transitions to `unresolved_area`
exactly as today (reason `non_lake_water`). `älv` and `kust` keep the instant area
transition — those waters are genuinely unsupported and area advice is the correct first
answer.

### 4. Unchanged

- Credit charge sites remain only in the `lake_pending` transition paths.
- Anonymous claim-token quota, wind-down, and freeze behavior.
- The extractor stays current-message-only; history is context, never an extraction source —
  no implicit lake carry-over.
- Clarify turn persistence (`persistClarifyTurns`) is reused for switch clarifies.

## Error handling

- Resolver timeout during a switch attempt → treated as low confidence → free clarify round
  (existing behavior of `resolveLakeWithHaiku` fallback).
- `buildSignals` failure during a switch → surface as today's stream-failure path; the
  conversation keeps its previous status and snapshot because `transitionConversation` runs
  only after signals are built.
- Missing snapshot on a post-transition row keeps the existing `persistence_failure` emit.

## Testing

Unit tests against `handleAsk` with fake deps (existing pattern):

1. **Jonas scenario end-to-end:** ort ("Stallarholmen") → clarify (no charge) → "Mälaren" →
   resolved (charge once) — and the variant where the conversation already reached
   `unresolved_area` and a later "Hjälmaren" message switches it to `resolved` with no
   second charge.
2. Switch from `resolved` to a different lake → new snapshot, `lake_switched` emitted, no
   charge, title updated.
3. Switch clarify → bare "i Örebro" reply routes via `pendingLakeName` and resolves.
4. `resolveAttempts` resets when the extracted lake name pivots mid-`lake_pending`.
5. Switch attempts exhaustion → give-up message, status/snapshot unchanged, `pendingLakeName`
   kept with attempts pinned at max (re-mention of same name goes straight to give-up; different
   name is a pivot, resets strikes).
6. Same lake re-mentioned in `resolved` chat → plain follow-up, resolver not called.
7. älv/kust named post-transition → plain follow-up, resolver not called.

Migration: add `pending_lake_name` column (nullable text), no backfill.
