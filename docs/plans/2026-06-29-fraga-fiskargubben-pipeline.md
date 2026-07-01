# Fråga Fiskargubben — Full Pipeline Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Build the complete Fråga Fiskargubben chatbot: free-text lake question → resolved lake + time → gathered open environmental data → computed Signals → Claude advice in the Fiskargubben persona, with credits, chat limits, analytics, and anon-claim.

**Architecture:** A Next.js 16 app over Postgres (Drizzle + Better Auth, already scaffolded). All slow/static data sources (SVAR lakes, metobs stations, S-HYPE water temp, depth, SLU water-colour, SLU species) are **pre-imported into Postgres by seed scripts** (ADR-0002); only the SMHI snow1g forecast is fetched live and cached ~1h. A user message runs a cheap **Haiku Extractor** (resolves lake+time+intent, gates topic), then — on the first prompt of a conversation — a **Sonnet** advice call over computed **Signals**; follow-ups are **Haiku** over the conversation's frozen Signals snapshot (ADR-0003). The **conversation** is the billable unit: 3 free **Credits** lifetime, lake locked per chat, ~20-turn hard cap with an in-persona wind-down from turn 15 (ADR-0004). Structured analytics events are written to Postgres inline (ADR-0005).

**Tech Stack:** Next.js 16 (App Router, React 19, React Compiler), Drizzle ORM 0.45 + `postgres` driver, Better Auth 1.6, Zod 4, `@anthropic-ai/sdk` (to add), Vitest + Testing Library, Playwright. Path alias `@/* → src/*`. Commands: `pnpm test`, `pnpm ts:check`, `pnpm biome`, `pnpm db:generate`, `pnpm db:migrate`.

---

## Read first (context the implementer MUST load)

- **`AGENTS.md`** (repo root): "This is NOT the Next.js you know." Before writing any route handler, server action, or fetch-caching code, read the relevant guide under `node_modules/next/dist/docs/` if present in your install, and heed deprecation notices. Do not assume Next 14/15 patterns.
- **`CONTEXT.md`** (repo root): the glossary. Use these exact terms in code identifiers and comments — **Lake**, **Lake id**, **Signals**, **Signals snapshot**, **Target time**, **Advice**, **Fiskargubben**, **Conversation**, **Context**, **Credit**, **Chat turn limit**, **Wind-down**, **Extractor**, **Provenance**, **Light window**, **Windward shore**, **Species comfort**, **Claim**, **Analytics event**. Honour the `_Avoid_` aliases.
- **`docs/adr/0001`–`0005`**: the binding decisions. Every phase below cites the ADR it implements. If code would contradict an ADR, stop and flag it.

## Conventions for every task

- **TDD**: write the failing test, run it red, implement minimally, run it green, commit. Pure logic (Signals math, parsers, quota) gets unit tests; DB/HTTP integration gets integration tests; the end-to-end flow gets one Playwright spec.
- **Colocate** unit tests as `*.test.ts` next to source (see `src/lib/utils.test.ts`).
- **Imports** use `@/…`. DB access only in `server-only` modules. Read env via `import { env } from "@/shared/env"`.
- **Drizzle migrations**: after editing `src/shared/db/schema.ts`, run `pnpm db:generate` (writes SQL into `drizzle/`), commit the generated SQL with the schema change, and apply with `pnpm db:migrate`.
- **Commit** after each green step. Conventional Commits (`feat:`, `test:`, `chore:`). Pre-commit runs lefthook→biome; if the biome CLI version trips on `biome.json` (a known env drift in this worktree — lefthook invoked biome 2.3.8 against a 2.5.1 schema), fix the biome version rather than routinely `--no-verify`.
- **Provenance everywhere**: every Signal value carries `{ source, confidence }` (ADR-0002). A missing source omits the Signal; it never throws.

---

# PHASE 0 — Foundations (SDK, schema skeleton, analytics, Signals types)

## Task 0.1: Add the Anthropic SDK + model constants

**Files:**
- Modify: `package.json` (add dependency)
- Create: `src/lib/claude/models.ts`
- Test: `src/lib/claude/models.test.ts`

**Step 1 — install:** `pnpm add @anthropic-ai/sdk`

**Step 2 — failing test** (`models.test.ts`): assert exported constants equal the exact model IDs.

```ts
import { describe, it, expect } from "vitest";
import { EXTRACTOR_MODEL, ADVICE_MODEL } from "./models";

describe("claude models", () => {
  it("uses Haiku 4.5 for extraction", () => {
    expect(EXTRACTOR_MODEL).toBe("claude-haiku-4-5");
  });
  it("uses Sonnet 4.6 for first-prompt advice", () => {
    expect(ADVICE_MODEL).toBe("claude-sonnet-4-6");
  });
});
```

**Step 3 — run red:** `pnpm test src/lib/claude/models.test.ts` → FAIL (module not found).

**Step 4 — implement** (`models.ts`):

```ts
// Model IDs are verified against the claude-api skill catalog (2026-06).
// Haiku 4.5 = extractor + topic gate + follow-up advice; Sonnet 4.6 = first-prompt advice. (ADR-0003)
export const EXTRACTOR_MODEL = "claude-haiku-4-5" as const;
export const ADVICE_MODEL = "claude-sonnet-4-6" as const;
export const FOLLOWUP_MODEL = "claude-haiku-4-5" as const;
```

**Step 5 — green + commit:** `pnpm test …` PASS; `git add package.json pnpm-lock.yaml src/lib/claude && git commit -m "feat: add Anthropic SDK and model constants"`.

> Note for later tasks: Sonnet 4.6 uses **adaptive thinking** (`thinking: { type: "adaptive" }`) and **streaming**; the persona system prompt carries `cache_control: { type: "ephemeral" }` and must stay byte-frozen — Signals/message/flags go in the user turn, never interpolated into the system block (ADR-0003, prompt-caching prefix rule).

## Task 0.2: Analytics events table + `emit()` (ADR-0005)

**Files:**
- Modify: `src/shared/db/schema.ts` (add `analyticsEvents` table)
- Create: `src/lib/analytics/events.ts` (taxonomy types + `emit()`)
- Test: `src/lib/analytics/events.test.ts`

**Step 1 — schema:** add an append-only table:

```ts
import { pgTable, text, jsonb, timestamp, bigserial } from "drizzle-orm/pg-core";

export const analyticsEvents = pgTable("analytics_event", {
  id: bigserial("id", { mode: "number" }).primaryKey(),
  type: text("type").notNull(),
  lakeId: text("lake_id"),
  conversationId: text("conversation_id"),
  payload: jsonb("payload").$type<Record<string, unknown>>().default({}).notNull(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});
```

**Step 2 — generate migration:** `pnpm db:generate` → commit the new file under `drizzle/`.

**Step 3 — failing test** (`events.test.ts`): the taxonomy union accepts the agreed event types and `emit` inserts a row (mock the db).

```ts
import { describe, it, expect, vi } from "vitest";
import { emit, type AnalyticsEventType } from "./events";

const types: AnalyticsEventType[] = [
  "lake_resolved", "lake_unresolved", "source_miss", "signals_built",
  "credit_spent", "topic_refused", "chat_limit_hit",
];

describe("analytics emit", () => {
  it("covers the taxonomy", () => expect(types).toHaveLength(7));
  it("inserts a row", async () => {
    const insert = vi.fn().mockReturnValue({ values: vi.fn().mockResolvedValue(undefined) });
    await emit({ type: "lake_resolved", lakeId: "654321" }, { db: { insert } as any });
    expect(insert).toHaveBeenCalledOnce();
  });
});
```

**Step 4 — run red**, then **implement** (`events.ts`): a discriminated `AnalyticsEvent` type over the 7 `type`s, and `emit(event, deps = { db })` that `db.insert(analyticsEvents).values(...)`. `emit` must **never throw** — wrap in try/catch and swallow (analytics must not break the request path); on failure, console.warn.

**Step 5 — green + commit.**

## Task 0.3: Signals type + Provenance (ADR-0002, CONTEXT)

**Files:**
- Create: `src/lib/signals/types.ts`
- Test: `src/lib/signals/types.test.ts`

Define the canonical `Signals` shape and `Provenance`:

```ts
export type Source = "forecast" | "observed" | "modeled" | "estimated";
export type Provenance = { source: Source; confidence: "high" | "low" };
export type WithProvenance<T> = { value: T; provenance: Provenance };

export type Signals = {
  lake: string;            // Lake label
  lakeId: string;
  timeLocal: string;       // ISO local Target time
  airTempC?: WithProvenance<number>;
  pressureHpa?: WithProvenance<number>;
  pressureTrend?: WithProvenance<"rising" | "falling" | "stable">;
  airTempTrend5d?: WithProvenance<"warming" | "cooling" | "steady">;
  windMs?: WithProvenance<number>;
  windwardShore?: WithProvenance<string>;   // compass label
  cloudPct?: WithProvenance<number>;
  waterTempC?: WithProvenance<number>;
  waterColour?: WithProvenance<"brown" | "clear">;
  sightDepthM?: WithProvenance<number>;
  maxDepthM?: WithProvenance<number>;
  lightWindow?: "dawn" | "day" | "dusk" | "night";
  speciesPresent?: string[];
  speciesComfort?: Record<string, "comfortable" | "sluggish">;
};
```

Test: a `Signals` object with only `lake/lakeId/timeLocal` type-checks (everything else optional → graceful degradation). Commit.

---

# PHASE 1 — Lake registry (SVAR ETL + resolution + typeahead) — ADR-0002

> **Spec §1.** Import **all** SVAR water bodies into a `lakes` table; resolve free-text to a lake; no runtime geocoding fallback (CONTEXT: Lake). The lake id is the join key for SLU/depth/temp later.

## Task 1.1: `lakes` table + trigram index

**Files:** Modify `src/shared/db/schema.ts`; create `drizzle/` migration via `db:generate`; create `drizzle/0002_pg_trgm.sql` (manual) enabling `pg_trgm`.

`lakes` columns: `id` (text PK = SVAR lake id), `name` (text, nullable), `municipality` (text), `county` (text), `lat` (doublePrecision), `lon` (doublePrecision), `areaHa` (doublePrecision). Add a manual migration `CREATE EXTENSION IF NOT EXISTS pg_trgm;` and a GIN trigram index on `name`. Test: schema compiles, `db:generate` produces SQL. Commit schema + SQL.

## Task 1.2: SVAR import script (one-time ETL)

**Files:** Create `scripts/etl/import-svar.ts`; create `scripts/etl/README.md`.

- Source: SVAR WFS download via SMHI Vattenwebb (document the exact dataset URL in the README; the WFS layer is downloaded once, **not** called at runtime).
- Parse each water body → `{ id, name, municipality, county, lat (centroid), lon, areaHa }`; upsert into `lakes` in batches (e.g. 1000-row chunks).
- Idempotent (re-runnable). Log counts: total imported, unnamed.
- Add a `package.json` script: `"etl:svar": "tsx scripts/etl/import-svar.ts"`.

Test (`import-svar.test.ts`): unit-test the **row-mapping function** (WFS feature → lake row) against a small fixture; do not hit the network in tests. Commit.

## Task 1.3: Lake resolution + ranked typeahead query

**Files:** Create `src/lib/lakes/resolve.ts`; test `resolve.test.ts` (integration, against a seeded test DB or a small in-memory fixture set).

- `searchLakes(q): Promise<LakeHit[]>` — ranked **exact name → prefix → trigram similarity, tiebreak by `areaHa` desc**, label `name (municipality, county)`, **exclude unnamed** bodies, limit 10 (ADR-0002 / CONTEXT: Lake label).
- `resolveLake(name, municipality?): Promise<Lake | null>` — used by the Extractor's output to pin a single lake; if `municipality` given, filter by it; if still ambiguous or none, return null (→ in-persona reprompt upstream).

Tests: "Tolken" returns the largest first; "Tolken" + "Ulricehamn" pins one; unknown returns null. Emit `lake_resolved` / `lake_unresolved` analytics from the **caller** (Phase 5), not here. Commit.

## Task 1.4: `GET /api/lakes?q=` typeahead route (optional UI aid)

**Files:** Create `src/app/api/lakes/route.ts`; e2e later.

Route handler returns `searchLakes(q)` as JSON `[{ id, name, label, lat, lon }]`. **Heed AGENTS.md** for the correct Next 16 route-handler signature/caching. Keep it read-only and cacheable. Test with a route-level integration test or fold into the Playwright spec. Commit.

---

# PHASE 2 — Weather: live forecast + past-weather trend — ADR-0002, Spec §2/§3

## Task 2.1: SMHI snow1g forecast client + 1h whole-doc cache

**Files:** Create `src/lib/weather/forecast.ts`; test `forecast.test.ts`.

- `fetchForecast(lat, lon)`: GET `https://opendata-download-metfcst.smhi.se/api/category/snow1g/version/1/geotype/point/lon/{lon}/lat/{lat}/data.json`. **Use snow1g/version/1** (the old pmp3g/v2 is dead — Spec §2 CRITICAL). Flat `data` object, human-readable param names, times are UTC.
- Cache the **whole `timeSeries` document per lake id** for ~1h (ADR-0002). Use a simple Postgres cache table `forecast_cache (lake_id, fetched_at, doc jsonb)` or an in-process+DB cache; document the choice. Select the target entry **in code** against the cached doc.
- `pickEntry(doc, targetTimeUtc)`: nearest `timeSeries[].time`; return the snap delta so a large gap can be noted to the LLM.
- Extract: `air_temperature`, `air_pressure_at_mean_sea_level`, `wind_speed`, `wind_from_direction`, `cloud_area_fraction`, `symbol_code`, `precipitation_amount_mean`. **Filter sentinel `9999`.**

Tests (against a saved JSON fixture, no network): `pickEntry` picks the nearest time; 9999 is filtered; UTC→local conversion correct. Commit.

## Task 2.2: metobs stations seed (pressure + temp lists)

**Files:** Modify schema (`metobsStations` table: `id`, `name`, `lat`, `lon`, `parameter` ('pressure'|'temp')); create `scripts/etl/import-metobs-stations.ts`; `package.json` script `etl:metobs-stations`.

Seed the station lists per parameter from metobs (ADR-0002). Idempotent. Unit-test the feature→row mapper on a fixture. Commit.

## Task 2.3: nearest-station (haversine) + past-weather trend

**Files:** Create `src/lib/weather/metobs.ts`; create `src/lib/geo/haversine.ts`; tests for both.

- `haversine(a, b)`: km between two lat/lons. Pure, unit-tested with known distances.
- `nearestStation(lakeId, parameter)`: query seeded stations, compute haversine, return nearest + distance; cache the lake→station mapping.
- `pressureTrend24h(station)`: pull ~24h pressure obs → `rising | falling | stable` by delta threshold.
- `airTempTrend5d(station)`: pull ~5d temp obs → `warming | cooling | steady`. **If nearest temp station > ~40 km, mark Provenance confidence `low`** (ADR-0002, Spec §3).

Tests on fixtures: trend classification thresholds; far-station → low confidence. Commit.

## Task 2.4: past-time actuals path (dual source)

**Files:** extend `src/lib/weather/metobs.ts`.

- `observedConditions(station, targetTimeUtc)`: for a **past** Target time, fill the same conditions fields from metobs actuals (temp/pressure/wind) with `source: "observed"` (ADR-0002 dual-source). Future/now uses the forecast (`source: "forecast"`).

Test: past time → observed source marker; future → forecast. Commit.

---

# PHASE 3 — Water temp, depth, colour, species (seeded enrichment) — ADR-0002

## Task 3.1: water-temp estimate (estimate-first) + S-HYPE override

**Files:** Create `src/lib/water/temp.ts`; test.

- `estimateWaterTemp({ airTempTrend5d, season, areaHa })`: the **primary** water-temp model in code (Spec §4 fallback is the common case). `source: "estimated"`, confidence `low`.
- Optional S-HYPE override: a seeded `waterTemp` table keyed by lake id / sub-catchment; if present, use it with `source: "modeled"`, confidence `high`. (Seed script `scripts/etl/import-shype.ts` — document the Vattenwebb export; mapper unit-tested; may be a stub that imports nothing until the dataset is wired — graceful absence is fine.)

Test: estimate always returns a value; override wins when present. Commit.

## Task 3.2: depth scalars

**Files:** Modify schema (`lakeDepth` table: `lakeId`, `maxDepthM`, `meanDepthM`); `scripts/etl/import-depth.ts`; `src/lib/water/depth.ts`.

Seed max/mean depth where available; `depthFor(lakeId)` returns scalars or null (graceful absence). Mapper unit-tested. Commit.

## Task 3.3: SLU water colour + sight depth (MVM) — batch ETL with import-time join

**Files:** Modify schema (`waterColour` table: `lakeId`, `colour` 'brown'|'clear', `sightDepthM`, `confidence`); `scripts/etl/import-mvm.ts`; `src/lib/water/colour.ts`; **add `MVM_TICKET` to `src/shared/env.ts` + `.env.example`**.

- The MVM **public ticket** is a credential — register it in the env zod schema (`MVM_TICKET: z.string().min(1)`) and `.env.example` with a comment on how to obtain it (Artdatabanken UserAdmin → activate in Miljödata-MVM "Mina sidor").
- The import script calls MVM `SampleSites`/`FullSamples` (ticket as a param), joins station→lake **at import time** by coordinates: accept inside the lake polygon or ≤200 m of centroid, else keep but mark confidence `low` (ADR-0002). Runtime `colourFor(lakeId)` is a pure table lookup — **no live MVM call on the request path**.

Test the coordinate-match predicate (inside/≤200m/over) on fixtures; test `colourFor` returns null when absent. Commit.

## Task 3.4: SLU species (Aqua/Sötebasen) — batch ETL

**Files:** Modify schema (`lakeSpecies` table: `lakeId`, `species` text[]); `scripts/etl/import-aqua.ts`; `src/lib/water/species.ts`.

Seed species per surveyed lake (same import-time join discipline). `speciesFor(lakeId)` returns `string[]` or null. Mapper unit-tested. Commit.

---

# PHASE 4 — Signal computation — ADR-0002, Spec "Signal computation"

## Task 4.1: sun times + light window

**Files:** Create `src/lib/signals/light.ts`; test.

- `sunTimes(lat, lon, date)`: compute sunrise/sunset in code via a solar-position formula (no API).
- `lightWindow(targetTime, sun)`: `dawn | day | dusk | night`, dawn/dusk = ~±45 min around sunrise/sunset (CONTEXT: Light window).

Test against a known date/lat/lon (sunrise within tolerance); a time 30 min before sunset → `dusk`. Commit.

## Task 4.2: windward shore

**Files:** Create `src/lib/signals/wind.ts`; test.

- `windwardShore(windFromDirectionDeg)`: `(deg + 180) % 360` → compass label. SMHI `wind_from_direction` is "blows FROM"; the windward (fish-stacking) shore is **downwind = +180°** (CONTEXT: Windward shore; the spec's NE→NE example is wrong).

Test: 45 (NE from) → SW shore. Commit.

## Task 4.3: species comfort rules

**Files:** Create `src/lib/signals/species-comfort.ts`; test.

- A small per-species code rules table over water temp/season → flags (e.g. `pike` `sluggish` when waterTempC > ~21). Returns `Record<species, "comfortable" | "sluggish">` (CONTEXT: Species comfort). Conclusions, not raw numbers, reach the LLM.

Test: pike at 22°C → sluggish; at 16°C → comfortable. Commit.

## Task 4.4: `buildSignals` orchestrator

**Files:** Create `src/lib/signals/build.ts`; integration test `build.test.ts`.

- `buildSignals({ lake, targetTime }): Promise<Signals>` — calls forecast/observed, metobs trends, water temp/depth/colour/species, then derives light window, windward shore, species comfort. Every value wrapped with Provenance; **missing sources omit the Signal, never throw**. Emits a `signals_built` analytics event and a `source_miss` per absent source.

Integration test with mocked source modules: a lake with only forecast still yields a valid Signals object; species-comfort appears only when both water temp and species exist. Commit.

---

# PHASE 5 — Conversation pipeline (Extractor, advice, credits, chat limit, wind-down) — ADR-0001/0003/0004

## Task 5.1: conversation + message + credit schema

**Files:** Modify `src/shared/db/schema.ts`; `db:generate`.

- `conversations`: `id` (text PK), `userId` (text, **nullable** for anon — ADR-0001), `claimToken` (text, nullable), `lakeId` (text), `targetTime` (timestamp), `signalsSnapshot` (jsonb — the **frozen** Signals, ADR-0004), `createdAt`, `lastActiveAt`. The `(lakeId, targetTime)` is the locked **Context**.
- `messages`: `id`, `conversationId` (FK), `role` ('user'|'assistant'), `content` (text), `createdAt`. Turn count derives from message rows.
- Add to `users` (or a `userQuota` table): `creditsUsed` (integer default 0), `isPaid` (boolean default false) — the stubbed paid flag (ADR-0004).

Commit schema + generated SQL.

## Task 5.2: Extractor (Haiku structured output + topic gate)

**Files:** Create `src/lib/chat/extractor.ts`; test with a mocked Anthropic client.

- `extract(message, history): Promise<Extraction>` where `Extraction = { onTopic: boolean; lakeName?: string; municipality?: string; time?: string; intent?: string; contextChanged: boolean }`.
- Haiku call with **structured output** (`output_config.format` json_schema) — no prefill (Sonnet/Haiku 4.x reject last-assistant prefills). Persona-flavoured refusal text when `onTopic=false`.
- **Topic gate**: `onTopic=false` → return early; caller emits `topic_refused`, spends **no Credit**, calls no Sonnet (ADR-0004).

Test (mock the SDK): on-topic fishing message → `onTopic:true` + parsed lake/time; "what's the capital of France" → `onTopic:false`. Commit.

## Task 5.3: Fiskargubben persona prompt (frozen, cached)

**Files:** Create `src/lib/chat/persona.ts`; test (string invariants).

- Export `FISKARGUBBEN_SYSTEM` — a **frozen** Swedish system prompt: gruff old fisherman, **fishing only** (refuse off-topic in character), **never assume gender** — use a gendered address only when a gender value is supplied (from IdP), else neutral ("hörru", "du där", "kompis") (CONTEXT: Fiskargubben). Marked for `cache_control: ephemeral` at call sites.
- Document the **runtime variables** that go in the *user* turn, never the system block: Signals JSON, the user message + short history, `windingDown` flag, optional `gender`. (Prefix-cache rule, ADR-0003.)

Test: the constant contains the topic-lock and gender-neutrality instructions; contains no interpolation placeholders (stays byte-stable). Commit.

## Task 5.4: advice calls (Sonnet first-prompt, Haiku follow-up)

**Files:** Create `src/lib/chat/advise.ts`; test with mocked SDK.

- `adviseFirst({ signals, message }): stream` — **Sonnet**, `thinking:{type:"adaptive"}`, streamed, system = `FISKARGUBBEN_SYSTEM` with `cache_control: ephemeral`, user content = Signals + message. Swedish output (ADR-0003).
- `adviseFollowup({ snapshot, message, history, turnIndex }): stream` — **Haiku**, reuses the frozen `signalsSnapshot`. Pass `windingDown = turnIndex >= 15` into the user turn; persona shortens + signs off ("nu har vi vänt på det mesta, lycka till där ute") (ADR-0004 wind-down).
- **Lake lock**: if the follow-up's extraction names a different lake/time, do **not** re-fetch or escalate — return the in-persona redirect ("jag känner bara till {lake}, grabben — dra igång en ny chatt för ett annat vatten") (ADR-0004).

Tests (mock SDK): first uses ADVICE_MODEL; followup uses FOLLOWUP_MODEL + passes windingDown=true at turn 15; different-lake followup returns the redirect without a model call for new data. Commit.

## Task 5.5: credit gate + chat-turn limit

**Files:** Create `src/lib/chat/quota.ts`; test.

- `canSpendCredit(user): boolean` — `isPaid || creditsUsed < 3` (3 free lifetime, ADR-0004). Decrement **only** on a Sonnet first-prompt, server-side, before the call. Anon = effectively 1 credit (the single claimable prompt).
- `spendCredit(user)`: increments `creditsUsed`, emits `credit_spent`.
- `chatTurnAllowed(conversation): boolean` — `messageCount < ~20`. On the cap, the route returns a **plain, non-persona** alert "Starta en ny chatt" and freezes the conversation (ADR-0004); emit `chat_limit_hit`.

Tests: 3rd credit allowed, 4th blocked unless `isPaid`; turn 20 blocked with the plain message; wind-down (15) is *not* a block. Commit.

## Task 5.6: anon conversation + Claim on registration

**Files:** Create `src/lib/chat/anon.ts`; modify auth flow hook; test.

- Anon first prompt creates a `conversations` row with `userId=null` + a `claimToken` set in a **signed httpOnly cookie** (ADR-0001). Quota gate caps anon at 1 prompt **before** any Claude call.
- On registration, `claimConversation(userId, claimToken)` sets `userId`, clears the token; the claimed conversation is a **spent Credit** → new account starts at `creditsUsed = 1` (ADR-0001/0004 carry-over). Reject an already-claimed token. GC unclaimed anon rows after a TTL (a `scripts/gc-anon.ts` or a scheduled cleanup — document it).

Tests: claim sets userId + leaves 2 credits; double-claim rejected. Commit.

## Task 5.7: `POST /api/ask` — the orchestrator route

**Files:** Create `src/app/api/ask/route.ts`; integration/e2e test.

Sequence (server-side, **quota gate before any Claude call**):
1. Load session (`getSession()`); resolve user or anon (cookie claimToken).
2. **Anon quota gate** (≤1 prompt) → block early if exceeded.
3. **Chat-turn limit** check if continuing a conversation → plain "Starta en ny chatt" + freeze on cap.
4. **Extractor** (Haiku) → `{onTopic, lake, time, …}`. Off-topic → in-persona refusal, no credit, emit `topic_refused`, return.
5. If **new conversation** (first prompt): `resolveLake` → null → in-persona reprompt + `lake_unresolved`. Else `credit gate` (`canSpendCredit`); if blocked → upgrade prompt. Then `buildSignals`, freeze into `signalsSnapshot`, `spendCredit`, stream **Sonnet** advice, emit `lake_resolved`+`credit_spent`.
6. If **follow-up** (existing conversation): lake-lock check; reuse snapshot; stream **Haiku** with `windingDown = turnIndex>=15`.
7. Persist user + assistant messages. Stream the response (Heed AGENTS.md for the Next 16 streaming-response pattern).

Return shape: streamed Advice text; on gates, the structured block/upgrade/redirect message. Commit.

---

# PHASE 6 — UI + end-to-end

## Task 6.1: chat UI (one text box, streamed replies, credit/limit states)

**Files:** Create `src/app/ask/page.tsx` + a client chat component; wire to `/api/ask`. Render streamed Advice; render the plain "Starta en ny chatt" alert distinctly from in-persona messages; show remaining credits for logged-in users; show the register-to-continue CTA for anon at the gate. Keep server/client split per existing patterns (`social-buttons.tsx` style). Commit.

## Task 6.2: Playwright end-to-end happy path

**Files:** Create `e2e/specs/ask.spec.ts`.

Drive: anon asks one fishing question about a known seeded lake → gets advice → second anon prompt is gated → register → conversation claimed, 2 credits left. Mock or stub the Anthropic + SMHI calls at the network layer for determinism (document how). Commit.

---

# PHASE 7 — Wiring + docs

## Task 7.1: env completeness

Ensure `src/shared/env.ts` + `.env.example` include `ANTHROPIC_API_KEY` (done) and `MVM_TICKET` (Task 3.3). Run `pnpm ts:check`, `pnpm test`, `pnpm biome`. Commit any fixes.

## Task 7.2: ETL runbook

**Files:** Create `scripts/etl/README.md` — the seed order (SVAR → metobs stations → S-HYPE → depth → MVM → Aqua), exact dataset URLs, the MVM ticket setup, and that these run **once / seasonally**, not at request time (ADR-0002). Commit.

## Task 7.3: final verification

Run the full suite: `pnpm ts:check && pnpm test && pnpm biome && pnpm test:e2e`. Fix the biome CLI/schema drift if it blocks. Confirm every ADR is honoured (re-read 0001–0005 against the code). Commit.

---

## Coverage check — every API/decision integrated

| Spec source / decision | Phase / Task |
|---|---|
| SVAR lakes (all bodies, trigram, no geocode fallback) | 1.1–1.4 |
| SMHI snow1g forecast (1h whole-doc cache, dual source) | 2.1, 2.4 |
| SMHI metobs (pressure 24h, temp 5d, far-temp low-confidence, seeded stations) | 2.2, 2.3 |
| S-HYPE water temp (estimate-first + override) | 3.1 |
| Depth scalars | 3.2 |
| SLU MVM water colour + sight (batch ETL, polygon/≤200m join, ticket in env) | 3.3 |
| SLU Aqua species | 3.4 |
| Signals (light window, windward +180°, species comfort, Provenance) | 4.1–4.4 |
| Claude Haiku extractor + topic gate | 5.2 |
| Fiskargubben persona (frozen, cached, Swedish, gender, fishing-only) | 5.3 |
| Sonnet first-prompt + Haiku follow-up + wind-down (turn 15) | 5.4 |
| Credits (3 free, isPaid stub) + chat-turn cap (~20, plain alert) | 5.5 |
| Anon claim + credit carry-over | 5.6 |
| `POST /api/ask` orchestrator + server-side quota gate | 5.7 |
| Analytics events to Postgres | 0.2 (+ emits throughout) |
| Conversation persistence, lake-locked Context, frozen snapshot | 5.1, 5.4, 5.7 |
```
