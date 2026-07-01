# Task 3.1 Report — water-temp estimate-first + S-HYPE override

**Commit:** `6d539fe` feat: water-temp estimate-first + S-HYPE override (task 3.1)

---

## Estimate formula + rationale

Formula in `src/lib/water/temp.ts#estimateWaterTemp`:

1. **Season baseline (°C):** winter=2, spring=9, summer=19, autumn=11.
   Baselines are rough midpoints of typical Swedish lake temps in each season.

2. **Air-temp trend nudge:** ±1.5 °C (warming / cooling), 0 for steady.
   Scaled by lake responsiveness (step 3).

3. **Lake-size responsiveness:**
   - `areaHa < 50` → responsiveness = 1.0 (small lakes heat/cool fully)
   - `areaHa ≥ 50` → `clamp(1 - log10(areaHa/50) × 0.2, 0.6, 1.0)`
     Decays on a log10 scale; very large lakes (>2000 ha) bottom out at 0.6.
   - `areaHa` absent → 0.8 (medium-lake assumption)

4. **Clamp to [0, 30]** — the realistic Swedish freshwater range.

Result is deterministic given the same inputs. This is a proxy, not science.

---

## Override decision design

`chooseWaterTemp(modeledRow | null, estimate)` — pure, no I/O:

- `modeledRow !== null` → `{ value: tempC, provenance: { source: "modeled", confidence: "high" } }`
- `null` → returns the estimate unchanged

`waterTempFor(lakeId, estimateInput)` — async, DB-backed:
computes the estimate, queries `water_temp` by `lakeId`, delegates to `chooseWaterTemp`.
Lazy imports keep DB/server-only code out of unit-test scope.

---

## Table + migration

Added `waterTemp` table to `src/shared/db/schema.ts`:
```ts
pgTable("water_temp", {
  lakeId: text("lake_id").primaryKey(),
  tempC:  doublePrecision("temp_c").notNull(),
  asOf:   timestamp("as_of", { withTimezone: true }),
})
```
Migration generated: `drizzle/0006_material_cyclops.sql` (CREATE TABLE water_temp).

---

## S-HYPE ETL stub

`scripts/etl/import-shype.ts` — follows the `import-svar.ts` pattern:
- `SHYPE_URL` env-var placeholder (exits 1 with clear error if absent)
- `ShypeRecord` / `WaterTempRow` type stubs + `mapRecordToWaterTemp` pure mapper
- Lazy DB imports; idempotent upsert on `lake_id` PK when wired
- `pnpm etl:shype` script added to `package.json`
- Documented in `scripts/etl/README.md` (S-HYPE section appended)

Status: **STUB** — no data imported until the Vattenwebb S-HYPE URL is supplied.
Graceful absence confirmed: `waterTempFor` falls back to estimate when no row exists.

---

## RED + GREEN evidence

**RED:** `pnpm test src/lib/water/temp.test.ts` failed with
`Error: Failed to resolve import "./temp"` (0 tests, 1 failed suite).

**GREEN:** After implementation, `pnpm test src/lib/water/temp.test.ts`:
```
Test Files  1 passed (1)
     Tests  13 passed (13)
```
Full suite: `12 test files passed, 84 passed | 12 skipped (96 total)` — no regressions.

---

## ts:check

`pnpm ts:check` (tsgo --noEmit) — **clean, no errors.**

---

## Files changed

| File | Change |
|------|--------|
| `src/lib/water/temp.ts` | NEW — estimateWaterTemp, chooseWaterTemp, waterTempFor |
| `src/lib/water/temp.test.ts` | NEW — 13 tests |
| `src/shared/db/schema.ts` | Added `waterTemp` table |
| `drizzle/0006_material_cyclops.sql` | NEW — CREATE TABLE water_temp |
| `drizzle/meta/0006_snapshot.json` | NEW — drizzle snapshot |
| `drizzle/meta/_journal.json` | Updated — entry 6 appended |
| `scripts/etl/import-shype.ts` | NEW — S-HYPE ETL stub |
| `scripts/etl/README.md` | Appended S-HYPE section |
| `package.json` | Added `etl:shype` script |

---

## Self-review

- Formula is simple, documented, and deterministic. ✓
- Pure functions tested without DB. ✓
- `chooseWaterTemp` tests cover: null→estimate, row→modeled, modeled overrides higher estimate. ✓
- `estimateWaterTemp` tests cover: sane range, summer>winter, warming>steady>cooling, small-lake responsiveness, all seasons ordered, no-optional-fields. ✓
- Lazy imports correctly isolate DB from unit tests. ✓
- Migration generated and committed, no db:migrate run (as instructed). ✓

---

## Concerns

1. The `ShypeRecord.lakeId` field name is a placeholder — the real Vattenwebb S-HYPE export format is unknown until the operator wires it. The mapper and README both note this prominently.
2. `waterTempFor` is untested at the integration level (intentionally — gated on DATABASE_URL). The pure `chooseWaterTemp` covers the logic completely.
3. Biome pre-commit hook auto-fixed `isFinite` → `Number.isFinite` in both the test and the ETL stub; those fixes are included in the committed state.
