# Lake Switch Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let users switch lakes during and after resolution — post-transition messages that name a lake re-enter the resolver (replacing the lake-lock and the `unresolved_area` dead end), orter get a clarify round instead of an instant charge, and clarify strikes reset when the user pivots to a new lake.

**Architecture:** All behavior lives in the pure orchestrator `handleAsk` (`src/lib/chat/ask-handler.ts`) with injected deps, unit-tested with fakes — no DB or API in tests. One new nullable column `conversations.pending_lake_name` tracks the in-flight resolution target. The credit model is untouched: charged exactly once at the first transition out of `lake_pending`; switches are free; turn caps (wind-down 15, freeze ~20) bound cost.

**Tech Stack:** Next.js (READ `node_modules/next/dist/docs/` before touching anything under `src/app/` — this Next version has breaking changes vs. training data), Drizzle ORM + drizzle-kit migrations, Vitest, pnpm.

**Spec:** `docs/superpowers/specs/2026-07-08-lake-switch-design.md`

## Global Constraints

- Credit spent EXACTLY ONCE per conversation, at the transition out of `lake_pending`. No `spendCredit`/`chargeCredit` call may be added to any switch path.
- Swedish copy rules (see `src/lib/chat/gate-messages.ts` header): no tankstreck (—), warm rather than gruff, plain sentences a human would say.
- `MAX_RESOLVE_ATTEMPTS = 3` and `RESOLVE_CONFIDENCE_THRESHOLD` come from `src/lib/lakes/haiku-resolver.ts` — never hardcode the numbers.
- Do NOT run `pnpm db:migrate` — production is a remote DB applied via tunnel workflow. Only `pnpm db:generate` (writes SQL into `migrations/`).
- Known tooling issue: the pre-commit hook can fail on a biome version mismatch (hook 2.3.8 vs config 2.5.1). If a commit fails ONLY for that reason, commit with `--no-verify`.
- Run tests with `pnpm test src/lib/chat/ask-handler.test.ts` (that script is `vitest run`).
- Type check with `pnpm exec tsc --noEmit`.

---

### Task 1: `pendingLakeName` column + plumbing

**Files:**
- Modify: `src/shared/db/schema.ts` (conversations table, after `resolveAttempts`)
- Modify: `src/lib/chat/ask-handler.ts` (`ConversationRow` type ~line 137; new-conversation literal ~line 574)
- Modify: `src/app/api/ask/route.ts` (`getConversation` mapping ~line 267)
- Modify: `src/lib/chat/ask-handler.test.ts` (fixtures `resolvedConversation` ~line 90, `pendingConversation` ~line 108)
- Create (generated): `migrations/00XX_*.sql` via `pnpm db:generate`

**Interfaces:**
- Produces: `ConversationRow.pendingLakeName: string | null` — every later task reads this field.

- [ ] **Step 1: Add the column to the schema**

In `src/shared/db/schema.ts`, directly after the `resolveAttempts` column in the `conversations` table:

```ts
  /**
   * The lake name currently being resolved via clarify rounds (the
   * "resolution target"). In lake_pending it backs the pivot rule: a clarify
   * round targeting a NEW name resets resolveAttempts. Post-transition it
   * carries an in-flight lake switch across a clarify round ("Hjälmaren" →
   * "vilken kommun?" → "i Örebro"). Null when no clarify is in flight and on
   * legacy rows. Spec: 2026-07-08-lake-switch-design.md.
   */
  pendingLakeName: text("pending_lake_name"),
```

- [ ] **Step 2: Generate the migration**

Run: `pnpm db:generate`
Expected: a new file `migrations/0024_*.sql` containing `ALTER TABLE "conversation" ADD COLUMN "pending_lake_name" text;`
Do NOT run `pnpm db:migrate`.

- [ ] **Step 3: Add the field to `ConversationRow`**

In `src/lib/chat/ask-handler.ts`, inside `ConversationRow` after `bareLakeName`:

```ts
  /**
   * In-flight resolution target (conversations.pendingLakeName). Backs the
   * strike-reset pivot rule and switch-clarify continuation. Null on legacy
   * rows and when no clarify is in flight.
   */
  pendingLakeName?: string | null;
```

And in the new-conversation literal (`conversation = { ... }` right after `createPendingConversation`, ~line 574), add alongside `bareLakeName: null`:

```ts
      pendingLakeName: null,
```

- [ ] **Step 4: Map the column in the route**

In `src/app/api/ask/route.ts`, in the `getConversation` dep's returned object (after the `bareLakeName` line):

```ts
        pendingLakeName: row.pendingLakeName ?? null,
```

- [ ] **Step 5: Update test fixtures**

In `src/lib/chat/ask-handler.test.ts`, add `pendingLakeName: null,` to BOTH fixture objects: `resolvedConversation` (after `bareLakeName: "Tolken",`) and `pendingConversation` (after `bareLakeName: null,`).

- [ ] **Step 6: Verify types and tests**

Run: `pnpm exec tsc --noEmit`
Expected: no errors.
Run: `pnpm test src/lib/chat/ask-handler.test.ts`
Expected: all existing tests PASS (behavior unchanged).

- [ ] **Step 7: Commit**

```bash
git add src/shared/db/schema.ts migrations src/lib/chat/ask-handler.ts src/app/api/ask/route.ts src/lib/chat/ask-handler.test.ts
git commit -m "feat: add conversations.pending_lake_name column and plumbing"
```

---

### Task 2: `recordClarifyRound` dep + pivot strike-reset in the pending phase

**Files:**
- Modify: `src/lib/chat/ask-handler.ts` (deps type ~line 295, `resolvePendingConversation` ~line 670)
- Modify: `src/app/api/ask/route.ts` (dep implementations ~line 434–451)
- Test: `src/lib/chat/ask-handler.test.ts`

**Interfaces:**
- Consumes: `ConversationRow.pendingLakeName` (Task 1).
- Produces: dep `recordClarifyRound(id: string, opts: { attempts: number; pendingLakeName: string | null }): Promise<void>` — REPLACES `incrementResolveAttempts` (delete it). Sets `resolveAttempts` to the ABSOLUTE value `opts.attempts` and `pendingLakeName` in one write. Task 3 and Task 4 call it.
- Produces: `transitionConversation` route impl now also resets `resolveAttempts: 0, pendingLakeName: null` on every transition (type signature unchanged in this task).

- [ ] **Step 1: Write the failing tests**

Add to `src/lib/chat/ask-handler.test.ts` (new describe after "clarify rounds"). Note `loggedIn()` and the fixtures already exist:

```ts
describe("pivot strike-reset (pending phase)", () => {
  it("resets strikes when the clarify target pivots to a new lake", async () => {
    const deps = makeDeps({
      getSession: loggedIn(),
      getConversation: vi.fn().mockResolvedValue(
        pendingConversation({ resolveAttempts: 2, pendingLakeName: "Puttern" }),
      ),
      countUserMessages: vi.fn().mockResolvedValue(2),
      extract: vi
        .fn()
        .mockResolvedValue({ onTopic: true, lakeName: "Hjälmaren" }),
      resolveLakeWithHaiku: vi.fn().mockResolvedValue(unsureResolution()),
    });
    const result = await handleAsk(
      { message: "Hjälmaren då?", conversationId: "conv-pending" },
      deps,
    );
    // 2 strikes on Puttern + this unsure round would have exhausted the
    // attempts — the pivot to Hjälmaren resets them, so this stays a free
    // clarify round instead of an unresolved_area transition.
    expect(result.type).toBe("clarify");
    expect(deps.transitionConversation).not.toHaveBeenCalled();
    expect(deps.spendCredit).not.toHaveBeenCalled();
    expect(deps.recordClarifyRound).toHaveBeenCalledWith("conv-pending", {
      attempts: 1,
      pendingLakeName: "Hjälmaren",
    });
  });

  it("keeps counting strikes when the same lake stays the target", async () => {
    const deps = makeDeps({
      getSession: loggedIn(),
      getConversation: vi.fn().mockResolvedValue(
        pendingConversation({ resolveAttempts: 2, pendingLakeName: "Tolken" }),
      ),
      countUserMessages: vi.fn().mockResolvedValue(2),
      extract: vi.fn().mockResolvedValue({ onTopic: true, lakeName: "Tolken" }),
      resolveLakeWithHaiku: vi.fn().mockResolvedValue(unsureResolution()),
    });
    const result = await handleAsk(
      { message: "Tolken sa jag", conversationId: "conv-pending" },
      deps,
    );
    // Third strike on the SAME target → unresolved_area transition as before.
    expect(result.type).toBe("stream");
    expect(deps.transitionConversation).toHaveBeenCalledWith(
      expect.objectContaining({ status: "unresolved_area" }),
    );
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm test src/lib/chat/ask-handler.test.ts`
Expected: FAIL — `deps.recordClarifyRound` does not exist on the fake (and `makeDeps` still has `incrementResolveAttempts`).

- [ ] **Step 3: Replace the dep in the types and the handler**

In `src/lib/chat/ask-handler.ts`:

1. In `AskHandlerDeps`, DELETE `incrementResolveAttempts(id: string): Promise<void>;` and add:

```ts
  /**
   * Records one clarify round in a single write: resolveAttempts is set to
   * the ABSOLUTE value `attempts` (not incremented — the pivot rule can reset
   * it) and pendingLakeName to the current resolution target.
   */
  recordClarifyRound(
    id: string,
    opts: { attempts: number; pendingLakeName: string | null },
  ): Promise<void>;
```

2. In `resolvePendingConversation`, right after the `userLoc` const, add the pivot rule:

```ts
  // Pivot rule: a clarify round targeting a NEW lake name starts with a fresh
  // strike count — strikes accumulated on "Puttern" must not count against
  // "Hjälmaren". pendingLakeName null means "no target yet", so any named
  // lake is a fresh target (harmless on the first message: attempts are 0).
  const isPivot =
    extraction.lakeName !== undefined &&
    (conversation.pendingLakeName == null ||
      extraction.lakeName.toLowerCase() !==
        conversation.pendingLakeName.toLowerCase());
  const priorAttempts = isPivot ? 0 : conversation.resolveAttempts;
```

3. Replace every use of `conversation.resolveAttempts` below that point with `priorAttempts`:
   - `attempt: conversation.resolveAttempts + 1` (in the `lake_resolved` emit) → `attempt: priorAttempts + 1`
   - `const attemptsAfterThis = conversation.resolveAttempts + 1;` → `const attemptsAfterThis = priorAttempts + 1;`

4. Replace the clarify-round write (`await deps.incrementResolveAttempts(conversation.id);`) with:

```ts
  await deps.recordClarifyRound(conversation.id, {
    attempts: attemptsAfterThis,
    pendingLakeName:
      extraction.lakeName ?? conversation.pendingLakeName ?? null,
  });
```

   NOTE: `attemptsAfterThis` is currently declared inside the strikes-exhausted branch — move the declaration above that `if` so the clarify branch can use it.

- [ ] **Step 4: Update the route implementations**

In `src/app/api/ask/route.ts`, replace the `incrementResolveAttempts` dep with:

```ts
    recordClarifyRound: async (id, { attempts, pendingLakeName }) => {
      await db
        .update(conversations)
        .set({ resolveAttempts: attempts, pendingLakeName })
        .where(eq(conversations.id, id));
    },
```

And extend `transitionConversation` so every transition resets the clarify state (a transition means resolution succeeded or gave up — either way the in-flight target is done):

```ts
    transitionConversation: async ({
      id,
      status,
      lakeId,
      targetTime,
      signalsSnapshot,
    }) => {
      await db
        .update(conversations)
        .set({
          status,
          lakeId,
          targetTime,
          signalsSnapshot,
          resolveAttempts: 0,
          pendingLakeName: null,
        })
        .where(eq(conversations.id, id));
    },
```

- [ ] **Step 5: Update `makeDeps` and existing assertions**

In `src/lib/chat/ask-handler.test.ts`:
1. In `makeDeps`, replace `incrementResolveAttempts: vi.fn().mockResolvedValue(undefined),` with `recordClarifyRound: vi.fn().mockResolvedValue(undefined),`.
2. Grep the test file for `incrementResolveAttempts` — the "clarify rounds" describe asserts on it. Rewrite those assertions against `recordClarifyRound`, e.g. `expect(deps.incrementResolveAttempts).toHaveBeenCalledWith("conv-pending")` becomes:

```ts
    expect(deps.recordClarifyRound).toHaveBeenCalledWith("conv-pending", {
      attempts: 1,
      pendingLakeName: "Tolken",
    });
```

   (Adjust `attempts`/`pendingLakeName` per each test's fixture — the value is the fixture's `resolveAttempts` + 1 when the extracted name matches `pendingLakeName` or none is set, `1` when it pivots.)

- [ ] **Step 6: Run tests + types**

Run: `pnpm test src/lib/chat/ask-handler.test.ts`
Expected: PASS, including the two new tests.
Run: `pnpm exec tsc --noEmit` — confirm no other module still references `incrementResolveAttempts` (grep the repo; only `route.ts` and the test wire it).

- [ ] **Step 7: Commit**

```bash
git add src/lib/chat/ask-handler.ts src/app/api/ask/route.ts src/lib/chat/ask-handler.test.ts
git commit -m "feat: pivot strike-reset via recordClarifyRound dep"
```

---

### Task 3: Ort clarify round (pending phase)

**Files:**
- Modify: `src/lib/chat/gate-messages.ts`
- Modify: `src/lib/chat/ask-handler.ts` (`resolvePendingConversation`)
- Test: `src/lib/chat/ask-handler.test.ts`

**Interfaces:**
- Consumes: `recordClarifyRound`, `isPivot`/`priorAttempts` (Task 2).
- Produces: `ortClarifyMessage(name: string): string` in gate-messages (Task 4 does not use it, but the copy lives with its siblings).

- [ ] **Step 1: Write the failing tests**

Add to `src/lib/chat/ask-handler.test.ts` (import `ortClarifyMessage` from `@/lib/chat/gate-messages`):

```ts
describe("ort clarify round", () => {
  const ortExtraction = {
    onTopic: true,
    lakeName: "Stallarholmen",
    waterKind: "ort" as const,
  };

  it("gives a named ort one free clarify round instead of an instant area transition", async () => {
    const deps = makeDeps({
      getSession: loggedIn(),
      extract: vi.fn().mockResolvedValue(ortExtraction),
    });
    const result = await handleAsk(
      { message: "Kan man fiska vid Stallarholmen?" },
      deps,
    );
    expect(result.type).toBe("clarify");
    if (result.type === "clarify") {
      expect(result.text).toBe(ortClarifyMessage("Stallarholmen"));
    }
    expect(deps.spendCredit).not.toHaveBeenCalled();
    expect(deps.transitionConversation).not.toHaveBeenCalled();
    // The register holds only lakes — candidate SQL and the resolver are
    // both skipped for an ort.
    expect(deps.candidateLakes).not.toHaveBeenCalled();
    expect(deps.resolveLakeWithHaiku).not.toHaveBeenCalled();
    expect(deps.recordClarifyRound).toHaveBeenCalledWith("new-conv-id", {
      attempts: 1,
      pendingLakeName: "Stallarholmen",
    });
  });

  it("insisting on the SAME ort transitions to unresolved_area as before", async () => {
    const deps = makeDeps({
      getSession: loggedIn(),
      getConversation: vi.fn().mockResolvedValue(
        pendingConversation({
          resolveAttempts: 1,
          pendingLakeName: "Stallarholmen",
        }),
      ),
      countUserMessages: vi.fn().mockResolvedValue(1),
      extract: vi.fn().mockResolvedValue(ortExtraction),
    });
    const result = await handleAsk(
      { message: "Stallarholmen sa jag", conversationId: "conv-pending" },
      deps,
    );
    expect(result.type).toBe("stream");
    expect(deps.transitionConversation).toHaveBeenCalledWith(
      expect.objectContaining({ status: "unresolved_area" }),
    );
    expect(deps.emit).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "lake_unresolved_area",
        payload: expect.objectContaining({ reason: "non_lake_water" }),
      }),
    );
  });

  it("ort clarify then a real lake resolves with one credit", async () => {
    const deps = makeDeps({
      getSession: loggedIn(),
      getConversation: vi.fn().mockResolvedValue(
        pendingConversation({
          resolveAttempts: 1,
          pendingLakeName: "Stallarholmen",
        }),
      ),
      countUserMessages: vi.fn().mockResolvedValue(1),
      extract: vi
        .fn()
        .mockResolvedValue({ onTopic: true, lakeName: "Tolken" }),
    });
    const result = await handleAsk(
      { message: "Jag menar Tolken", conversationId: "conv-pending" },
      deps,
    );
    expect(result.type).toBe("stream");
    expect(deps.spendCredit).toHaveBeenCalledTimes(1);
    expect(deps.transitionConversation).toHaveBeenCalledWith(
      expect.objectContaining({ status: "resolved", lakeId: "tolken-1" }),
    );
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm test src/lib/chat/ask-handler.test.ts`
Expected: the first test FAILS (result is a stream — instant `unresolved_area` today). The second and third may already pass; keep them as regression anchors.

- [ ] **Step 3: Add the copy**

In `src/lib/chat/gate-messages.ts`:

```ts
/**
 * A named ort (town/place) reached the resolver gate. The user most likely
 * means a lake NEAR that ort, so ask which one — worth a free round before
 * falling back to area mode. Fires once per ort name (pivot rule).
 */
export function ortClarifyMessage(name: string): string {
  return `${name} låter som en ort snarare än en sjö. Vilken sjö i närheten är det du tänker på?`;
}
```

- [ ] **Step 4: Add the ort branch to the handler**

In `src/lib/chat/ask-handler.ts`:
1. Import `ortClarifyMessage` from `./gate-messages`.
2. In `resolvePendingConversation`, the `claimTokenPart` const is currently declared after the resolver call — move it UP so it sits right after the `priorAttempts` code from Task 2 (it has no dependency on the resolver).
3. Directly after the existing `namedNonLake` const (and before the `candidates` fetch), add:

```ts
  // Ort clarify: the user most likely means a lake NEAR the named ort, so one
  // free round asking which lake beats an instant (credit-charging) area
  // transition. Only when the ort is a NEW target (isPivot) — insisting on
  // the same ort falls through to the unresolved_area transition below.
  if (namedNonLake && extraction.waterKind === "ort" && isPivot) {
    const ortName = extraction.lakeName as string; // namedNonLake implies defined
    await deps.recordClarifyRound(conversation.id, {
      attempts: priorAttempts + 1,
      pendingLakeName: ortName,
    });
    await deps.emit({
      type: "lake_clarify",
      conversationId: conversation.id,
      payload: {
        attempt: priorAttempts + 1,
        confidence: 0,
        lakeName: ortName,
        clarifyQuestion: ortClarifyMessage(ortName),
        reason: "ort",
        prompt: message,
        candidateCount: 0,
        candidates: [],
        hasUserLocation: userLoc !== undefined,
      },
    });
    return {
      type: "clarify",
      text: ortClarifyMessage(ortName),
      conversationId: conversation.id,
      ...claimTokenPart,
    };
  }
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `pnpm test src/lib/chat/ask-handler.test.ts`
Expected: PASS. Also check no existing `unresolved_area` test broke — one test may assert that a first-message ort transitions immediately; if so, update it to reflect the new behavior (first ort message = clarify; the `non_lake_water` transition now needs `pendingLakeName` already set to the same ort, as in the second test above).

- [ ] **Step 6: Commit**

```bash
git add src/lib/chat/gate-messages.ts src/lib/chat/ask-handler.ts src/lib/chat/ask-handler.test.ts
git commit -m "feat: ort gets a free clarify round before area fallback"
```

---

### Task 4: Post-transition lake switch (replaces the lake-lock)

**Files:**
- Modify: `src/lib/chat/ask-handler.ts` (follow-up branch ~line 629; new `getSwitchTarget` + `attemptLakeSwitch`; `AskResult`; deps type; `transitionConversation` opts)
- Modify: `src/lib/chat/advise.ts` (DELETE `isLakeLockViolation`, `getLakeLockRedirect`)
- Modify: `src/lib/chat/gate-messages.ts` (add `switchGiveUpMessage`)
- Modify: `src/lib/analytics/events.ts` (add `lake_switched`, `lake_switch_failed`)
- Modify: `src/app/api/ask/route.ts` (unwire lock deps; `transitionConversation` title)
- Modify: `src/app/ask/chat.tsx` (remove `"lake_lock"` from `GateType`, `PERSONA_GATES`, `KNOWN_GATE_TYPES`)
- Test: `src/lib/chat/ask-handler.test.ts`, `src/lib/chat/advise.test.ts`

**Interfaces:**
- Consumes: `pendingLakeName` (Task 1), `recordClarifyRound` (Task 2).
- Produces: `getSwitchTarget(conversation, extraction): string | null` (exported for tests); `switchGiveUpMessage(currentContext: string): string`; `transitionConversation` opts gain optional `title?: string`; deps LOSE `isLakeLockViolation` and `getLakeLockRedirect`; `AskResult` loses the `lake_lock` variant.

- [ ] **Step 1: Write the failing tests**

In `src/lib/chat/ask-handler.test.ts`, add a candidate fixture next to `TOLKEN` (copy its shape exactly — same fields, new values):

```ts
const HJALMAREN = {
  ...TOLKEN,
  id: "hjalmaren-1",
  name: "Hjälmaren",
  municipality: "Örebro",
  county: "Örebro",
};
```

Then REPLACE the existing lake-lock test(s) (grep `lake_lock` in the file, ~line 865) with this describe:

```ts
describe("lake switch (post-transition)", () => {
  it("a named lake in an unresolved_area chat re-resolves and switches to resolved", async () => {
    const deps = makeDeps({
      getSession: loggedIn(),
      getConversation: vi.fn().mockResolvedValue(
        resolvedConversation({
          status: "unresolved_area",
          lakeId: null,
          bareLakeName: null,
        }),
      ),
      countUserMessages: vi.fn().mockResolvedValue(2),
      extract: vi
        .fn()
        .mockResolvedValue({ onTopic: true, lakeName: "Hjälmaren" }),
      candidateLakes: vi.fn().mockResolvedValue([HJALMAREN]),
      resolveLakeWithHaiku: vi
        .fn()
        .mockResolvedValue(confidentResolution("hjalmaren-1")),
    });
    const result = await handleAsk(
      { message: "Hjälmaren?", conversationId: "conv-1" },
      deps,
    );
    expect(result.type).toBe("stream");
    // The credit was spent at the original transition — switching is free.
    expect(deps.spendCredit).not.toHaveBeenCalled();
    expect(deps.adviseFirst).toHaveBeenCalledOnce();
    expect(deps.adviseFollowup).not.toHaveBeenCalled();
    expect(deps.transitionConversation).toHaveBeenCalledWith(
      expect.objectContaining({ status: "resolved", lakeId: "hjalmaren-1" }),
    );
    expect(deps.emit).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "lake_switched",
        payload: expect.objectContaining({
          fromStatus: "unresolved_area",
          lakeName: "Hjälmaren",
        }),
      }),
    );
  });

  it("naming a different lake in a resolved chat switches instead of locking", async () => {
    const deps = makeDeps({
      getSession: loggedIn(),
      getConversation: vi.fn().mockResolvedValue(resolvedConversation()),
      countUserMessages: vi.fn().mockResolvedValue(2),
      extract: vi
        .fn()
        .mockResolvedValue({ onTopic: true, lakeName: "Hjälmaren" }),
      candidateLakes: vi.fn().mockResolvedValue([HJALMAREN]),
      resolveLakeWithHaiku: vi
        .fn()
        .mockResolvedValue(confidentResolution("hjalmaren-1")),
    });
    const result = await handleAsk(
      { message: "Och Hjälmaren?", conversationId: "conv-1" },
      deps,
    );
    expect(result.type).toBe("stream");
    expect(deps.spendCredit).not.toHaveBeenCalled();
    expect(deps.emit).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "lake_switched",
        payload: expect.objectContaining({ fromLakeId: "tolken-1" }),
      }),
    );
  });

  it("re-mentioning the SAME lake in a resolved chat is a plain follow-up", async () => {
    const deps = makeDeps({
      getSession: loggedIn(),
      getConversation: vi.fn().mockResolvedValue(resolvedConversation()),
      countUserMessages: vi.fn().mockResolvedValue(2),
      extract: vi
        .fn()
        .mockResolvedValue({ onTopic: true, lakeName: "tolken" }),
    });
    const result = await handleAsk(
      { message: "Tolken imorgon då?", conversationId: "conv-1" },
      deps,
    );
    expect(result.type).toBe("stream");
    expect(deps.candidateLakes).not.toHaveBeenCalled();
    expect(deps.adviseFollowup).toHaveBeenCalledOnce();
  });

  it("a named kust post-transition is a plain follow-up (no resolver)", async () => {
    const deps = makeDeps({
      getSession: loggedIn(),
      getConversation: vi.fn().mockResolvedValue(resolvedConversation()),
      countUserMessages: vi.fn().mockResolvedValue(2),
      extract: vi.fn().mockResolvedValue({
        onTopic: true,
        lakeName: "Västkusten",
        waterKind: "kust" as const,
      }),
    });
    const result = await handleAsk(
      { message: "Västkusten då?", conversationId: "conv-1" },
      deps,
    );
    expect(result.type).toBe("stream");
    expect(deps.candidateLakes).not.toHaveBeenCalled();
    expect(deps.adviseFollowup).toHaveBeenCalledOnce();
  });

  it("an unsure switch attempt costs a free clarify round and records the target", async () => {
    const deps = makeDeps({
      getSession: loggedIn(),
      getConversation: vi.fn().mockResolvedValue(resolvedConversation()),
      countUserMessages: vi.fn().mockResolvedValue(2),
      extract: vi
        .fn()
        .mockResolvedValue({ onTopic: true, lakeName: "Hjälmaren" }),
      resolveLakeWithHaiku: vi.fn().mockResolvedValue(unsureResolution()),
    });
    const result = await handleAsk(
      { message: "Hjälmaren?", conversationId: "conv-1" },
      deps,
    );
    expect(result.type).toBe("clarify");
    expect(deps.recordClarifyRound).toHaveBeenCalledWith("conv-1", {
      attempts: 1,
      pendingLakeName: "Hjälmaren",
    });
    expect(deps.transitionConversation).not.toHaveBeenCalled();
    expect(deps.spendCredit).not.toHaveBeenCalled();
  });

  it("a bare municipality reply continues the in-flight switch", async () => {
    const deps = makeDeps({
      getSession: loggedIn(),
      getConversation: vi.fn().mockResolvedValue(
        resolvedConversation({ pendingLakeName: "Hjälmaren", resolveAttempts: 1 }),
      ),
      countUserMessages: vi.fn().mockResolvedValue(3),
      extract: vi
        .fn()
        .mockResolvedValue({ onTopic: true, municipality: "Örebro" }),
      candidateLakes: vi.fn().mockResolvedValue([HJALMAREN]),
      resolveLakeWithHaiku: vi
        .fn()
        .mockResolvedValue(confidentResolution("hjalmaren-1")),
    });
    const result = await handleAsk(
      { message: "i Örebro", conversationId: "conv-1" },
      deps,
    );
    expect(result.type).toBe("stream");
    expect(deps.resolveLakeWithHaiku).toHaveBeenCalledWith(
      expect.objectContaining({
        lakeName: "Hjälmaren",
        municipality: "Örebro",
      }),
    );
    expect(deps.transitionConversation).toHaveBeenCalledWith(
      expect.objectContaining({ status: "resolved", lakeId: "hjalmaren-1" }),
    );
  });

  it("a reply with neither lake nor municipality is a plain follow-up even mid-switch", async () => {
    const deps = makeDeps({
      getSession: loggedIn(),
      getConversation: vi.fn().mockResolvedValue(
        resolvedConversation({ pendingLakeName: "Hjälmaren", resolveAttempts: 1 }),
      ),
      countUserMessages: vi.fn().mockResolvedValue(3),
      extract: vi.fn().mockResolvedValue({ onTopic: true }),
    });
    const result = await handleAsk(
      { message: "hur var vädret nu igen?", conversationId: "conv-1" },
      deps,
    );
    expect(result.type).toBe("stream");
    expect(deps.adviseFollowup).toHaveBeenCalledOnce();
    expect(deps.candidateLakes).not.toHaveBeenCalled();
  });

  it("exhausted switch attempts give up and keep the current context", async () => {
    const deps = makeDeps({
      getSession: loggedIn(),
      getConversation: vi.fn().mockResolvedValue(
        resolvedConversation({ pendingLakeName: "Hjälmaren", resolveAttempts: 2 }),
      ),
      countUserMessages: vi.fn().mockResolvedValue(4),
      extract: vi
        .fn()
        .mockResolvedValue({ onTopic: true, lakeName: "Hjälmaren" }),
      resolveLakeWithHaiku: vi.fn().mockResolvedValue(unsureResolution()),
    });
    const result = await handleAsk(
      { message: "Hjälmaren!!", conversationId: "conv-1" },
      deps,
    );
    expect(result.type).toBe("clarify");
    if (result.type === "clarify") {
      expect(result.text).toBe(switchGiveUpMessage("Tolken"));
    }
    expect(deps.transitionConversation).not.toHaveBeenCalled();
    expect(deps.emit).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "lake_switch_failed",
        payload: expect.objectContaining({ reason: "attempts_exhausted" }),
      }),
    );
    // Attempts pinned at max with the target kept: a re-mention of the same
    // failed name goes straight back to give-up instead of looping.
    expect(deps.recordClarifyRound).toHaveBeenCalledWith("conv-1", {
      attempts: 3,
      pendingLakeName: "Hjälmaren",
    });
  });

  it("a confident no-such-lake verdict gives up immediately", async () => {
    const deps = makeDeps({
      getSession: loggedIn(),
      getConversation: vi.fn().mockResolvedValue(resolvedConversation()),
      countUserMessages: vi.fn().mockResolvedValue(2),
      extract: vi
        .fn()
        .mockResolvedValue({ onTopic: true, lakeName: "Atlantis" }),
      candidateLakes: vi.fn().mockResolvedValue([]),
      resolveLakeWithHaiku: vi.fn().mockResolvedValue({
        lakeId: null,
        confidence: 95,
        noSuchLake: true,
        clarifyQuestion: "",
      }),
    });
    const result = await handleAsk(
      { message: "Atlantis?", conversationId: "conv-1" },
      deps,
    );
    expect(result.type).toBe("clarify");
    expect(deps.emit).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "lake_switch_failed",
        payload: expect.objectContaining({ reason: "no_such_lake" }),
      }),
    );
  });

  it("a confident switch updates the conversation title", async () => {
    const deps = makeDeps({
      getSession: loggedIn(),
      getConversation: vi.fn().mockResolvedValue(resolvedConversation()),
      countUserMessages: vi.fn().mockResolvedValue(2),
      extract: vi.fn().mockResolvedValue({
        onTopic: true,
        lakeName: "Hjälmaren",
        title: "Gös i Hjälmaren",
      }),
      candidateLakes: vi.fn().mockResolvedValue([HJALMAREN]),
      resolveLakeWithHaiku: vi
        .fn()
        .mockResolvedValue(confidentResolution("hjalmaren-1")),
    });
    await handleAsk({ message: "Gös i Hjälmaren?", conversationId: "conv-1" }, deps);
    expect(deps.transitionConversation).toHaveBeenCalledWith(
      expect.objectContaining({ title: "Gös i Hjälmaren" }),
    );
  });
});
```

Import `switchGiveUpMessage` from `@/lib/chat/gate-messages` at the top of the test file.

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm test src/lib/chat/ask-handler.test.ts`
Expected: FAIL — `switchGiveUpMessage` doesn't exist yet; switch tests get `lake_lock`/follow-up behavior.

- [ ] **Step 3: Add copy + analytics event types**

In `src/lib/chat/gate-messages.ts`:

```ts
/**
 * A lake switch attempt gave up (attempts exhausted or confident
 * no-such-lake). The conversation keeps its previous context; say so.
 */
export function switchGiveUpMessage(currentContext: string): string {
  return `Den sjön hittar jag tyvärr inte i mina register. Vi kör vidare på ${currentContext} så länge.`;
}
```

In `src/lib/analytics/events.ts`, add to `AnalyticsEventType` after `"lake_unresolved_area"`:

```ts
  // Lake switch (spec 2026-07-08): a post-transition turn re-resolved to a
  // new lake. payload { fromLakeId, fromStatus, lakeName, confidence, attempt }.
  | "lake_switched"
  // A switch attempt gave up (attempts exhausted or confident no-such-lake);
  // the conversation keeps its previous context. payload { lakeName, reason,
  // confidence } + resolver context (prompt, candidates).
  | "lake_switch_failed"
```

- [ ] **Step 4: Implement the switch path in the handler**

In `src/lib/chat/ask-handler.ts`:

1. Import `LAKE_CLARIFY_FALLBACK` and `switchGiveUpMessage` from `./gate-messages`.

2. In `AskHandlerDeps`: DELETE `isLakeLockViolation(...)` and `getLakeLockRedirect(...)`; add `title?: string;` to the `transitionConversation` opts object type (after `signalsSnapshot`), documented as `/** Replaces the drawer headline on a lake switch; omitted = keep. */`.

3. In `AskResult`: DELETE the `| { type: "lake_lock"; text: string }` variant.

4. REPLACE the whole lake-lock block in `handleAsk` (the `lockKey` const through its `return { type: "lake_lock", ... }`) with:

```ts
  // Lake switch: a post-transition turn that names a NEW lake (or continues
  // an in-flight switch clarify with a municipality) re-enters resolution.
  // The credit was spent at the first transition — switching is free; the
  // turn caps bound the rounds. Replaces the old lake-lock redirect.
  const switchTarget = getSwitchTarget(conversation, extraction);
  if (switchTarget !== null) {
    return attemptLakeSwitch({
      conversation,
      extraction,
      switchTarget,
      message,
      history,
      gender,
      deps,
    });
  }
```

5. Add the two functions (below `resolvePendingConversation`):

```ts
/**
 * Decides whether a post-transition turn is a lake-switch attempt, and for
 * which name. Returns null for ordinary follow-ups.
 *
 * Explicit: the extractor named a lake-ish water (sjö/annat/no kind) that is
 * not the conversation's current lake — in unresolved_area ANY named lake
 * counts. Continuation: no lake named, but a switch clarify is in flight and
 * the user supplied a municipality ("i Örebro"). A reply with neither keeps
 * the pending target for a later turn and follows up normally.
 */
export function getSwitchTarget(
  conversation: Pick<
    ConversationRow,
    "status" | "bareLakeName" | "pendingLakeName"
  >,
  extraction: Extraction,
): string | null {
  if (extraction.lakeName !== undefined) {
    const lakeish =
      extraction.waterKind === undefined ||
      extraction.waterKind === "sjö" ||
      extraction.waterKind === "annat";
    if (!lakeish) return null;
    if (conversation.status === "unresolved_area") return extraction.lakeName;
    const current = conversation.bareLakeName ?? null;
    if (
      current !== null &&
      extraction.lakeName.toLowerCase() === current.toLowerCase()
    ) {
      return null;
    }
    return extraction.lakeName;
  }
  if (conversation.pendingLakeName && extraction.municipality) {
    return conversation.pendingLakeName;
  }
  return null;
}

async function attemptLakeSwitch(ctx: {
  conversation: ConversationRow;
  extraction: Extraction;
  switchTarget: string;
  message: string;
  history: HistoryMessage[];
  gender?: string;
  deps: AskHandlerDeps;
}): Promise<AskResult> {
  const {
    conversation,
    extraction,
    switchTarget,
    message,
    history,
    gender,
    deps,
  } = ctx;

  const userLoc: UserLocation | undefined =
    conversation.userLat !== null && conversation.userLon !== null
      ? { lat: conversation.userLat, lon: conversation.userLon }
      : undefined;

  // Pivot rule, same as the pending phase: a new target starts fresh.
  const isPivot =
    conversation.pendingLakeName == null ||
    switchTarget.toLowerCase() !== conversation.pendingLakeName.toLowerCase();
  const priorAttempts = isPivot ? 0 : conversation.resolveAttempts;

  const candidates = await deps.candidateLakes(switchTarget, userLoc);
  const resolution = await deps.resolveLakeWithHaiku({
    message,
    lakeName: switchTarget,
    municipality: extraction.municipality,
    userLoc,
    candidates,
    history,
  });

  if (resolution.usage) {
    await deps.emit({
      type: "llm_usage",
      conversationId: conversation.id,
      payload: llmUsagePayload("resolve", resolution.usage),
    });
  }

  // Same troubleshooting context as the pending phase: what Haiku SAW.
  const resolutionContext = {
    prompt: message,
    candidateCount: candidates.length,
    candidates: candidates
      .slice(0, 5)
      .map((c) => (c.name ? `${c.name} (${c.municipality})` : c.id)),
    hasUserLocation: userLoc !== undefined,
  };

  const picked =
    resolution.lakeId !== null &&
    resolution.confidence >= RESOLVE_CONFIDENCE_THRESHOLD
      ? (candidates.find((c) => c.id === resolution.lakeId) ?? null)
      : null;

  if (picked) {
    const targetTime = await resolveTargetTime(
      extraction,
      conversation.id,
      deps,
    );
    const lakeWithLabel: Lake & { label: string } = {
      ...picked,
      label: picked.name
        ? formatLabel({
            name: picked.name,
            municipality: picked.municipality,
            county: picked.county,
          })
        : picked.id,
    };
    const signals = await deps.buildSignals({
      lake: lakeWithLabel,
      targetTime,
      now: deps.now,
    });

    // NO credit charge here — spent once at the first lake_pending exit.
    // transitionConversation resets resolveAttempts + pendingLakeName.
    await deps.transitionConversation({
      id: conversation.id,
      status: "resolved",
      lakeId: picked.id,
      targetTime,
      signalsSnapshot: signals,
      ...(extraction.title ? { title: extraction.title } : {}),
    });
    await deps.emit({
      type: "lake_switched",
      lakeId: picked.id,
      conversationId: conversation.id,
      payload: {
        fromLakeId: conversation.lakeId ?? null,
        fromStatus: conversation.status,
        lakeName: switchTarget,
        confidence: resolution.confidence,
        attempt: priorAttempts + 1,
      },
    });

    const stream = deps.adviseFirst({ signals, message, history, gender });
    return {
      type: "stream",
      stream,
      conversationId: conversation.id,
      badges: toBadges(signals, "resolved"),
    };
  }

  const attemptsAfterThis = priorAttempts + 1;
  if (resolution.noSuchLake || attemptsAfterThis >= MAX_RESOLVE_ATTEMPTS) {
    // Give up on the switch, keep the current context. The target stays
    // recorded with attempts pinned at max so a re-mention of the same name
    // goes straight back here (a confident resolution still wins above);
    // a DIFFERENT name is a pivot and starts fresh.
    await deps.recordClarifyRound(conversation.id, {
      attempts: MAX_RESOLVE_ATTEMPTS,
      pendingLakeName: switchTarget,
    });
    await deps.emit({
      type: "lake_switch_failed",
      conversationId: conversation.id,
      payload: {
        lakeName: switchTarget,
        reason: resolution.noSuchLake ? "no_such_lake" : "attempts_exhausted",
        confidence: resolution.confidence,
        ...resolutionContext,
      },
    });
    const currentContext =
      conversation.bareLakeName ??
      conversation.signalsSnapshot?.lake ??
      "det vi pratade om";
    return {
      type: "clarify",
      text: switchGiveUpMessage(currentContext),
      conversationId: conversation.id,
    };
  }

  await deps.recordClarifyRound(conversation.id, {
    attempts: attemptsAfterThis,
    pendingLakeName: switchTarget,
  });
  await deps.emit({
    type: "lake_clarify",
    conversationId: conversation.id,
    payload: {
      attempt: attemptsAfterThis,
      confidence: resolution.confidence,
      lakeName: switchTarget,
      clarifyQuestion: resolution.clarifyQuestion,
      phase: "switch",
      ...resolutionContext,
    },
  });
  return {
    type: "clarify",
    text: resolution.clarifyQuestion || LAKE_CLARIFY_FALLBACK,
    conversationId: conversation.id,
  };
}
```

6. Update the file-header comment (lines 8–32): extend the state diagram and drop the lock bullet:

```
 *   lake_pending ──(Haiku confident)──────────► resolved ◄─────┐
 *        │ ▲                                        │          │
 *        │ └── clarify round (free, Haiku only)     │   lake switch (free
 *        └──(3 strikes or noSuchLake)──► unresolved_area ──────┘  re-resolution)
```

and in "Gate ordering" item 5 replace the `resolved → lake-lock check → …` / `unresolved_area → …` lines with:

```
 *     - resolved / unresolved_area → lake switch check (a newly named lake
 *       re-enters resolution, free) → otherwise adviseFollowup with the
 *       frozen snapshot
```

- [ ] **Step 5: Delete the lock helpers and unwire**

1. `src/lib/chat/advise.ts`: delete `isLakeLockViolation` and `getLakeLockRedirect` (the whole "Lake-lock helpers" section). Remove the now-unused `Extraction` import if nothing else uses it.
2. `src/lib/chat/advise.test.ts`: grep for `isLakeLockViolation` / `getLakeLockRedirect` and delete those tests.
3. `src/app/api/ask/route.ts`: remove `isLakeLockViolation,` and `getLakeLockRedirect,` from the deps object AND from the import statement. Extend the `transitionConversation` impl (from Task 2) to accept and set the optional title:

```ts
    transitionConversation: async ({
      id,
      status,
      lakeId,
      targetTime,
      signalsSnapshot,
      title,
    }) => {
      await db
        .update(conversations)
        .set({
          status,
          lakeId,
          targetTime,
          signalsSnapshot,
          resolveAttempts: 0,
          pendingLakeName: null,
          ...(title !== undefined ? { title } : {}),
        })
        .where(eq(conversations.id, id));
    },
```

4. Grep `src/app/api/ask/route.ts` for `"lake_lock"` — if the result-to-response mapping mentions it, remove that arm (the generic gate mapping likely needs no change). Verify the stream arm forwards `result.badges` for follow-up-path streams too (it should already be generic — the switch path returns `type: "stream"` with `badges`).
5. `src/app/ask/chat.tsx`: remove `| "lake_lock"` from `GateType` (line 34) and the `"lake_lock",` entries from `PERSONA_GATES` (line 62) and `KNOWN_GATE_TYPES` (line 77).
6. `src/lib/chat/ask-handler.test.ts`: remove `isLakeLockViolation` and `getLakeLockRedirect` from `makeDeps`.

- [ ] **Step 6: Run tests + types**

Run: `pnpm test src/lib/chat/ask-handler.test.ts src/lib/chat/advise.test.ts`
Expected: PASS.
Run: `pnpm exec tsc --noEmit`
Expected: no errors (this catches any remaining `lake_lock` references — fix any it finds).

- [ ] **Step 7: Commit**

```bash
git add src/lib/chat/ask-handler.ts src/lib/chat/advise.ts src/lib/chat/advise.test.ts src/lib/chat/gate-messages.ts src/lib/analytics/events.ts src/app/api/ask/route.ts src/app/ask/chat.tsx src/lib/chat/ask-handler.test.ts
git commit -m "feat: lake switch replaces lake-lock; unresolved_area re-resolves"
```

---

### Task 5: Docs + full verification

**Files:**
- Modify: `docs/adr/0004-credit-model-conversation-is-the-billable-unit.md`

**Interfaces:** none — documentation and final gate.

- [ ] **Step 1: Amend ADR-0004**

Append to `docs/adr/0004-credit-model-conversation-is-the-billable-unit.md`:

```markdown

## Amendment (2026-07-08)

The lake-lock ("one conversation = one lake") is retired by the lake-switch
design (`docs/superpowers/specs/2026-07-08-lake-switch-design.md`). The
conversation remains the billable unit: the credit is still spent exactly once,
at the first transition out of `lake_pending`. Later turns that name a new lake
re-enter resolution for free; cost stays bounded by the chat-turn caps
(wind-down at 15, freeze at ~20).
```

- [ ] **Step 2: Full test suite + types**

Run: `pnpm test`
Expected: ALL suites pass.
Run: `pnpm exec tsc --noEmit`
Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add docs/adr/0004-credit-model-conversation-is-the-billable-unit.md
git commit -m "docs: ADR-0004 amendment for lake switch"
```
