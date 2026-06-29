## Task 1.3 Report: Lake resolution + ranked typeahead query

### Functions design

**`searchLakes(q: string): Promise<LakeHit[]>`** — ranked typeahead (ADR-0002).
- Single raw SQL query via drizzle `db.execute(sql\`...\`)`.
- `WHERE name IS NOT NULL AND (exact OR prefix OR similarity > 0.1)` to exclude unnamed bodies and keep results relevant.
- Returns `LakeHit = { id, name, label, lat, lon }`.
- Label built with `formatLabel` helper: `"name (municipality, county)"`.
- Limit 10.

**`resolveLake(name: string, municipality?: string): Promise<Lake | null>`** — confident pinning.
- Exact-match only (`lower(name) = lower($name)`); no loose trigram (resolution must be confident).
- Optional municipality filter: `AND lower(municipality) = lower($municipality)`.
- Returns null if row count != 1 (ambiguous or not found).
- Returns full `Lake = { id, name, municipality, county, lat, lon, areaHa }`.

**`formatLabel`** — pure helper in `resolve-helpers.ts`, no `server-only` constraint, always testable.

### Exact ranking SQL (`searchLakes`)

```sql
SELECT id, name, municipality, county, lat, lon
FROM lakes
WHERE
  name IS NOT NULL
  AND (
    lower(name) = lower($q)
    OR lower(name) LIKE lower($q) || '%'
    OR similarity(name, $q) > 0.1
  )
ORDER BY
  CASE
    WHEN lower(name) = lower($q)            THEN 0
    WHEN lower(name) LIKE lower($q) || '%'  THEN 1
    ELSE 2
  END ASC,
  similarity(name, $q) DESC,
  area_ha DESC
LIMIT 10
```

The `CASE` expression maps exact -> 0, prefix -> 1, trigram-only -> 2; within each tier, pg_trgm `similarity()` breaks further ties; area_ha DESC is the final tiebreak as required by ADR-0002.

### Test approach

**Both A + B** (most robust, as the brief recommends):

- **B (pure helpers)** — `resolve-helpers.ts` exports `formatLabel` with no server/DB dependency. Two unit tests always run; cover label formatting and whitespace fidelity.
- **A (integration, gated)** — 12 integration tests against a real Postgres, gated with `describe.skipIf(!process.env.DATABASE_URL)`. Seed five fixture lakes (three "Tolken" of varying size, one "Tolkabad" prefix-variant, one unnamed body). Verify: ordering by areaHa DESC within exact tier, exact-before-prefix ordering, unnamed exclusion, label format, limit, return shape, resolveLake pinning, ambiguity null, municipality miss null, unknown-name null, full Lake fields.

`server-only` is mocked at top level with `vi.mock`; `@/shared/env` is stubbed to pass Zod validation while forwarding the real `DATABASE_URL`. The real drizzle+postgres-js client then connects to the live DB.

### RED -> GREEN evidence

**RED:** First run failed with `Error: Failed to resolve import "./resolve"` (module not found) — confirming tests failed before implementation. After `resolve.ts` existed but before fixing the `server-only` / `env` mocking, tests failed with `This module cannot be imported from a Client Component module`.

**GREEN:** After extracting `formatLabel` to `resolve-helpers.ts` and adding `vi.mock("server-only", ...)` + `vi.mock("@/shared/env", ...)`:
- With `DATABASE_URL`: 14 passed (2 pure + 12 integration)
- Without `DATABASE_URL`: 2 passed, 12 skipped

### ts:check

`pnpm ts:check` -- clean, no errors.

### Files changed

- `src/lib/lakes/resolve-helpers.ts` -- new: pure `formatLabel` helper
- `src/lib/lakes/resolve.ts` -- new: `searchLakes`, `resolveLake`, re-exports `formatLabel`
- `src/lib/lakes/resolve.test.ts` -- new: 2 pure-helper tests + 12 gated integration tests

### Self-review

- Ranking SQL is implemented in a single `db.execute(sql\`...\`)` call. Drizzle's query builder doesn't express `CASE` ordering natively so raw SQL is the right call here.
- The `similarity > 0.1` threshold in `searchLakes` is a pragmatic cutoff; it may need tuning with real data but matches the pg_trgm default behaviour.
- `resolveLake` uses exact match only (no prefix) -- this is intentional and conservative; the Extractor is expected to supply the canonical lake name, so confidence > coverage.

### Concerns

Minor: the `similarity > 0.1` cutoff for typeahead and exact-only for resolution are reasonable defaults but should be verified against real SVAR data once the ETL (Task 1.2) has seeded the production DB. If many lakes have similar names, the 0.1 threshold may be too permissive; if names are very distinct, the exact-only resolution may be too conservative for abbreviations. These are operational tuning concerns, not code defects.
