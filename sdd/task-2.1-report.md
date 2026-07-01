# Task 2.1 Implementation Report: SMHI snow1g Forecast Client + 1h Postgres Cache

## Endpoint Used

`https://opendata-download-metfcst.smhi.se/api/category/snow1g/version/1/geotype/point/lon/{lon}/lat/{lat}/data.json`

Coordinates are formatted with `.toFixed(4)` — SMHI snow1g/version/1 requires max 4 decimal places; fewer may return 404.

---

## Cache Design + Rationale

**Table:** `forecast_cache` (Postgres via Drizzle)
- `lake_id` TEXT PRIMARY KEY — one row per lake
- `fetched_at` TIMESTAMPTZ NOT NULL — when the SMHI response was stored
- `doc` JSONB NOT NULL — the complete `timeSeries` document

**TTL:** 1 hour, enforced purely in application code via `isFresh(fetchedAt, now)`.

**Rationale for Postgres over in-process Map:**
1. The app is containerised and may run multiple instances — a `Map` is not shared across pods or restarts.
2. Postgres is already the primary store; no new infrastructure.
3. The cache hit path is a single indexed primary-key lookup — negligible overhead vs the SMHI network round-trip (~200–500 ms).
4. A cold start with no DB connection degrades gracefully (cache miss → live fetch, the error surfaces from `cacheGet` rather than `getForecast`).

**Schema type:** `jsonb("doc").notNull()` has no TypeScript generic in `schema.ts` to avoid a circular import (`schema → forecast → schema`). The cast to `SmhiForecastDoc` happens in `forecast.ts` at the `cacheGet` read site.

---

## `pickEntry` + 9999 Handling

`pickEntry(doc, targetTimeUtc)` is a **pure function** (no I/O, no DB):

1. Converts `targetTimeUtc` to epoch ms.
2. Iterates `timeSeries[]` once, tracking the entry with the smallest absolute ms difference.
3. **Tie-break:** `diff <= bestDiff` (not strict `<`) — later entry wins when equidistant. This is natural because we iterate forward through the array.
4. Calls `extractParams(best.data)` which iterates `PARAM_KEYS` and omits any value equal to `9999` (SMHI's sentinel for "data not available"). Real values are preserved unchanged.
5. Returns `{ entry, snapDeltaMinutes, params }`.

**Sentinel 9999:** filtered in `extractParams` — if `data[key] === 9999` the key is simply not set in the returned `SmhiDataParams` object, so callers receive `undefined` for that field.

---

## Fixture Description

`src/lib/weather/__fixtures__/snow1g-sample.json`

A minimal synthetic SMHI snow1g response with 4 `timeSeries` entries:

| Time (UTC)           | Notable content                                                   |
|----------------------|-------------------------------------------------------------------|
| 2024-06-15T10:00:00Z | All params valid                                                  |
| 2024-06-15T11:00:00Z | `wind_speed: 9999`, `wind_from_direction: 9999` (sentinel test)  |
| 2024-06-15T12:00:00Z | All params valid (used as reference entry)                        |
| 2024-06-15T14:00:00Z | 2h gap — tests nearest-entry selection                            |

---

## RED Evidence

```
pnpm test src/lib/weather/forecast.test.ts

 FAIL  src/lib/weather/forecast.test.ts [ src/lib/weather/forecast.test.ts ]
Error: Failed to resolve import "./forecast" from "src/lib/weather/forecast.test.ts". Does the file exist?
  Plugin: vite:import-analysis

 Test Files  1 failed (1)
      Tests  no tests
```

Confirmed: `forecast.ts` did not yet exist, Vite could not resolve the module.

---

## GREEN Evidence

```
pnpm test src/lib/weather/forecast.test.ts

 RUN  v4.1.9

 Test Files  1 passed (1)
      Tests  13 passed (13)
   Start at  17:57:28
   Duration  925ms (transform 42ms, setup 86ms, import 269ms, tests 3ms, environment 438ms)
```

All 13 tests pass. No DB or network calls in any test (pure functions only).

---

## ts:check Result

```
pnpm ts:check
(no output — exit 0)
```

One fix was required: TypeScript infers JSON `coordinates` as `number[]`, not `[number, number]`. Resolved in `forecast.test.ts` by casting the fixture import: `fixtureRaw as unknown as SmhiForecastDoc`.

---

## Files Changed

| File | Status |
|------|--------|
| `src/lib/weather/__fixtures__/snow1g-sample.json` | Created |
| `src/lib/weather/forecast.test.ts` | Created |
| `src/lib/weather/forecast.ts` | Created |
| `src/shared/db/schema.ts` | Modified (added `forecastCache` table) |
| `drizzle/0004_curly_hobgoblin.sql` | Generated |
| `drizzle/meta/0004_snapshot.json` | Generated |

---

## Self-Review

- `pickEntry` is pure and covers all fixture-verified paths: exact match, nearest, equidistant tie-break, sentinel filter, full param extraction, UTC epoch comparison.
- `isFresh` is pure: tested at boundary (exactly 1h → false), below (30 min → true), above (90 min → false), and at zero (now → true).
- `server-only` guard at top of `forecast.ts` prevents accidental client-side import.
- Cache upsert uses `onConflictDoUpdate` — idempotent and race-condition safe for the primary key.
- No network or DB calls in any test — mocks cover `server-only` and `@/shared/env`; DB client is never invoked because tests only call pure exports.

---

## Fix: Task 2.1 empty-timeSeries guard

### Guard added (`src/lib/weather/forecast.ts`)

```ts
export function pickEntry(
  doc: SmhiForecastDoc,
  targetTimeUtc: string,
): PickResult {
  if (doc.timeSeries.length === 0) {
    throw new Error("SMHI returned an empty timeSeries");
  }
  // … rest unchanged
```

Added at the top of `pickEntry`, before the `doc.timeSeries[0]` access, to prevent a cryptic `TypeError: Cannot read properties of undefined` when SMHI returns an empty array.

### New test (`src/lib/weather/forecast.test.ts`)

```ts
it("throws a clear error when timeSeries is empty", () => {
  const emptyDoc: SmhiForecastDoc = {
    ...fixture,
    timeSeries: [],
  };
  expect(() => pickEntry(emptyDoc, "2024-06-15T12:00:00Z")).toThrow(
    /empty timeSeries/i,
  );
});
```

### Covering test command + output

```
pnpm test src/lib/weather/forecast.test.ts

 RUN  v4.1.9

 Test Files  1 passed (1)
      Tests  14 passed (14)
   Start at  18:03:39
   Duration  889ms (transform 40ms, setup 77ms, import 279ms, tests 3ms, environment 444ms)
```

14 tests pass (13 original + 1 new).

### ts:check result

```
pnpm ts:check
(no output — exit 0)
```

### Commit

`75b024a fix: guard pickEntry against empty timeSeries`

---

## Concerns

- **No integration test for `getForecast`/`cacheGet`/`cacheSet`:** these cache functions are not exercised by the unit tests. Integration coverage would require a real or in-memory Postgres instance; deferred to a future task.
- **`db:migrate` not run:** the `0004_curly_hobgoblin.sql` migration was generated but not applied. The `forecast_cache` table does not exist in the live database until `pnpm db:migrate` is run in the deployment environment.
- **Coordinate precision for very precise coords:** `.toFixed(4)` truncates — this is correct per SMHI docs but callers should be aware that sub-0.0001° precision is silently dropped.
