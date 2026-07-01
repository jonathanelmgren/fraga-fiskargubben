# Task 4.4 Report: `buildSignals` Orchestrator

## Files Changed

- **Created** `src/lib/signals/build.ts` — the orchestrator
- **Created** `src/lib/signals/build.test.ts` — 23 integration tests, all mocked

---

## Orchestration Order

1. **conditionsSource** (`targetTimeUtc`, `now`) → decides `"forecast"` or `"observed"`
2. **Conditions fetch** — if forecast: `getForecast` + `pickEntry`; if observed: `nearestStation(temp)` + `observedConditions`
3. **Trend stations** — `nearestStation(pressure)` + `nearestStation(temp)` in parallel
4. **pressureTrend24h** — from pressure station id
5. **airTempTrend5d** — from temp station id + distanceKm (provides confidence)
6. **waterTempFor** — `(lakeId, { season, airTempTrend5d, areaHa })`; season derived from `targetTime.getUTCMonth()`
7. **depthFor** — `lakeId` → `{ maxDepthM, meanDepthM } | null`
8. **colourFor** — `lakeId` → `{ colour, sightDepthM, confidence } | null`
9. **speciesFor** — `lakeId` → `string[] | null`
10. **lightWindow** — pure: `sunTimes(lat, lon, date)` + `lightWindow(targetTime, sun)`
11. **windwardShore** — pure: from `wind_from_direction` if present
12. **speciesComfort** — only when BOTH `waterTemp` and `speciesPresent` are present

---

## Graceful Degradation (ADR-0002)

Each source call is wrapped by a `safe<T>(fn, onMiss)` helper:

```ts
async function safe<T>(fn: () => Promise<T>, onMiss: () => void): Promise<T | undefined> {
  try { return await fn(); } catch { onMiss(); return undefined; }
}
```

`onMiss` calls `missFire(lakeId, sourceName)` which fire-and-forgets a `source_miss` analytics event (wrapped in `Promise.resolve(...).catch()` to survive mock returning `undefined`). Any `undefined` result means the corresponding `Signals` field is simply not set.

- `lake`, `lakeId`, `timeLocal` are always set from the input.
- `lightWindow` is always set (pure computation, no I/O).
- All other fields are set only when their source succeeds and returns a non-null value.

---

## Season Derivation

```ts
function seasonFromDate(date: Date): Season {
  const month = date.getUTCMonth(); // 0-11
  if (month >= 2 && month <= 4) return "spring";
  if (month >= 5 && month <= 7) return "summer";
  if (month >= 8 && month <= 10) return "autumn";
  return "winter";
}
```

Northern hemisphere, UTC-based. Dec-Feb winter, Mar-May spring, Jun-Aug summer, Sep-Nov autumn.

---

## Provenance Mapping

| Signal | Source | Confidence |
|---|---|---|
| `airTempC`, `pressureHpa`, `windMs`, `cloudPct` | `"forecast"` or `"observed"` (from `conditionsSource`) | `"high"` |
| `windwardShore` | same as conditions source | `"high"` |
| `pressureTrend` | `"observed"` | `"high"` |
| `airTempTrend5d` | `"observed"` | `"high"` or `"low"` (per `tempConfidence`, >40 km = low) |
| `waterTempC` | passes through `WithProvenance` from `waterTempFor` | `"low"` (estimated) or `"high"` (modeled) |
| `maxDepthM` | `"modeled"` | `"high"` |
| `waterColour`, `sightDepthM` | `"modeled"` | from `colourFor.confidence` |

---

## Source Signatures Consumed

- `conditionsSource(targetTimeUtc: string, now: Date): "forecast" | "observed"`
- `getForecast(lakeId, lat, lon): Promise<SmhiForecastDoc>`
- `pickEntry(doc, targetTimeUtc): PickResult` (returns `params: SmhiDataParams`)
- `nearestStation(lake, parameter): Promise<NearestStationResult | null>`
- `observedConditions(stationId, targetTimeUtc): Promise<ObservedConditions>`
- `pressureTrend24h(stationId): Promise<"rising" | "falling" | "stable">`
- `airTempTrend5d(stationId, distanceKm): Promise<{ trend, confidence }>`
- `waterTempFor(lakeId, WaterTempInput): Promise<WithProvenance<number>>`
- `depthFor(lakeId): Promise<DepthResult>`
- `colourFor(lakeId): Promise<ColourResult>`
- `speciesFor(lakeId): Promise<string[] | null>`
- `sunTimes(lat, lon, date): SunTimes`
- `lightWindow(targetTime, sun): "dawn" | "day" | "dusk" | "night"`
- `windwardShore(windFromDirectionDeg): string`
- `speciesComfort(speciesPresent, waterTempC): Record<string, Comfort>`
- `emit(event, deps?): Promise<void>`

---

## RED to GREEN Evidence

**RED**: Test file ran, failed with `Error: Failed to resolve import "./build"` — module did not exist.

**GREEN** (after implementing `build.ts`): All 23 tests passed. A second failure cycle occurred (`TypeError: Cannot read properties of undefined (reading 'catch')`) because the `emit` mock returns `undefined` rather than a Promise; fixed by wrapping in `Promise.resolve(...)` before `.catch()`.

```
Test Files  1 passed (1)
      Tests  23 passed (23)
```

---

## TypeScript

`pnpm ts:check` (`tsgo --noEmit`) exits with no output (clean).

---

## Biome

`pnpm biome` result after auto-fix:

```
Checked 88 files in 19ms. No fixes applied.
Found 3 warnings.
```

The 3 warnings are pre-existing in `src/lib/analytics/events.test.ts` (noExplicitAny) and `src/lib/water/temp.test.ts` (noGlobalIsFinite x 2). Zero findings in `build.ts` or `build.test.ts`.

---

## Self-Review / Concerns

1. **Observed-path station lookup duplication**: for the observed path, `nearestStation(temp)` is called inside the conditions block AND again in Step 2 for trends. The metobs module caches by `lat:lon:parameter` key in-process so the second call is a cache hit. Not a correctness issue; a future refactor could deduplicate.

2. **speciesComfort gating**: requires `speciesResult.length > 0` to prevent calling `speciesComfort` with an empty array. An empty array from the DB would produce an empty record `{}` — omitting it seems correct behaviour.

3. **`now` is required** in `BuildSignalsInput` (not optional), enforcing testability at the type level. Any production call site must pass the current clock.

4. **speciesComfort with empty result**: if `speciesComfort` returns `{}` (no recognised species), the field is still set to `{}`. Acceptable but could be discussed.

---

## Fix: Task 4.4 graceful-degradation gaps

### Finding 1 — `conditionsSource` call unwrapped

**What changed** (`build.ts` ~line 121): The bare `const source = conditionsSource(targetUtc, now)` was wrapped in a `try/catch`. On throw it defaults to `"forecast"` and fires `missFire(lake.id, "conditions_source")`. Normal (non-throwing) path is unchanged.

### Finding 2 — `sunTimes`/`lightWindow` derivation unwrapped

**What changed** (`build.ts` ~line 223): The two-line derivation:
```ts
const sun = sunTimes(lake.lat, lake.lon, targetTime);
const light = lightWindow(targetTime, sun);
```
is now wrapped in a `try/catch`. On throw, `light` remains `undefined`, `missFire(lake.id, "light_window")` is called, and `signals.lightWindow` is not set (conditional assignment `if (light !== undefined)`). Previously `signals.lightWindow = light` was unconditional; that line was updated to match.

`@/lib/signals/light` is now mocked in `build.test.ts` (added `vi.mock("@/lib/signals/light", ...)` and `setupForecastOnly` sets `sunTimes` → FAKE_SUN, `lightWindow` → `"day"`).

### Finding 3 — Empty `speciesComfort {}` set instead of omitted

**What changed** (`build.ts` ~line 241): The assignment `speciesComfortSignal = speciesComfort(...)` is now guarded:
```ts
const comfortResult = speciesComfort(speciesResult, waterTemp.value);
if (Object.keys(comfortResult).length > 0) {
  speciesComfortSignal = comfortResult;
}
```
When all species are unrecognised (e.g. `["unknown_fish"]`), `speciesComfort` returns `{}` and the signal is omitted.

### New Tests (build.test.ts)

Added 4 new tests (27 total, was 23):

- **`graceful degradation — light window`** (3 tests):
  - `resolves (does not throw) when sunTimes throws`
  - `omits lightWindow when sunTimes throws`
  - `emits source_miss(light_window) when sunTimes throws`
- **`graceful degradation — speciesComfort empty result`** (1 test):
  - `omits speciesComfort when speciesComfort returns {} (unknown species)`

### Verification

**Test command + output:**
```
pnpm test src/lib/signals/build.test.ts

Test Files  1 passed (1)
      Tests  27 passed (27)
   Duration  459ms
```

**TypeScript:** `pnpm ts:check` (`tsgo --noEmit`) exits clean — no output.

**Biome:** `./node_modules/.bin/biome check src/lib/signals/build.ts src/lib/signals/build.test.ts`
```
Checked 2 files in 9ms. No fixes applied.
```
Zero findings on the two changed files. (Pre-existing warnings in unrelated files are unchanged.)
