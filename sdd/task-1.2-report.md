# Task 1.2 Report — SVAR WFS import script

## Mapper design and assumptions

`mapFeatureToLake(feature: SvarFeature): LakeRow` is a pure, exported function
that accepts a GeoJSON Feature object and returns a typed lake row (id, name,
municipality, county, lat, lon, areaHa).

### Field-name assumptions

The mapper reads the following `properties` fields from each SVAR feature,
matching SMHI Vattenwebb SVAR (MS_WB_AREA layer) attribute names as documented
at https://vattenwebb.smhi.se/:

| Feature property | Lake column    | Notes                                    |
| ---------------- | -------------- | ---------------------------------------- |
| `MS_CD`          | `id`           | EU WFD water-body code; PK; required     |
| `MS_NAME`        | `name`         | nullable; blank/absent → null            |
| `KOMMUNNAMN`     | `municipality` | required                                 |
| `LANNAMN`        | `county`       | required                                 |
| `CENTROID_N`     | `lat`          | stored as-is; see CRS note below         |
| `CENTROID_E`     | `lon`          | stored as-is                             |
| `AREA_HA`        | `areaHa`       | required                                 |

**CRS note:** The mapper stores centroid coordinates verbatim from the source.
If the WFS layer is requested in SWEREF99TM (EPSG:3006, the Swedish national
grid), these will be metres, not WGS84 decimal degrees. Operators should
request CRS84/EPSG:4326 and update accordingly if WGS84 is needed downstream.

## URL placeholder handling

```ts
const SVAR_WFS_URL =
  process.env.SVAR_WFS_URL ??
  "<TODO: SMHI Vattenwebb SVAR WFS download URL — see scripts/etl/README.md>";
```

At startup the script checks for the placeholder prefix and exits with an
actionable error message if it has not been replaced. This keeps the script
runnable without a real URL while making it impossible to accidentally fire
against nothing. `scripts/etl/README.md` documents the WFS endpoint pattern
and explains that the dataset should be downloaded once and served locally.

## DB connection

`@/shared/db/client` imports `server-only` and validates all application env
vars (including OAuth secrets) — unusable from a standalone ETL script. The
script instead lazily imports `postgres` and `drizzle-orm/postgres-js` directly
with only `DATABASE_URL`, avoiding the constraint. `@/shared/db/schema` is
still imported for the `lakes` table definition (safe, no side effects).

## RED to GREEN evidence

```
# RED — module did not exist yet
Test Files  1 failed (1) — cannot resolve ./import-svar

# GREEN — after implementation
Test Files  1 passed (1)
     Tests  4 passed (4)
  Duration  779ms
```

Four mapper tests:
1. full feature → correct row values
2. absent `MS_NAME` → `name: null`
3. empty `MS_NAME` string → `name: null`
4. missing `MS_CD` → throws

## ts:check

```
> tsgo --noEmit
(no output — clean)
```

## Biome

No errors or warnings in new files. One pre-existing warning in
`src/lib/analytics/events.test.ts` (unrelated `noExplicitAny`).

## Files changed

- `scripts/etl/import-svar.ts` — mapper + script body
- `scripts/etl/import-svar.test.ts` — 4 unit tests
- `scripts/etl/README.md` — operator instructions, field assumptions, CRS note
- `package.json` — added `"etl:svar": "tsx scripts/etl/import-svar.ts"`

## Self-review

- Mapper is pure and tested in isolation — no network, no DB.
- Script body uses dynamic imports so they never execute during test collection.
- `onConflictDoUpdate` uses `sql\`excluded.*\`` for all columns → idempotent.
- Batching at 1 000 rows limits memory for large datasets (~10 k Swedish lakes).
- `pnpm etl:svar` respects `SVAR_WFS_URL` env var for both URL and local
  `file://` paths (Node 24 `fetch` supports both).

## Concerns

1. **CRS ambiguity** — whether the WFS delivers SWEREF99TM or WGS84 depends on
   the `CRS` parameter in the download request. The field names `lat`/`lon` in
   the DB suggest WGS84 is expected; the README calls this out explicitly so
   the operator can verify before running.
2. **Field-name uncertainty** — SMHI WFS schemas can vary between dataset
   versions. The `SvarFeatureProperties` TypeScript interface and the fixture
   in the test make the expected names explicit; if the real dataset differs the
   fix is mechanical.
3. **`fetch` for large GeoJSON** — streaming parse (e.g. `JSONStream`) would be
   safer for very large responses, but `fetch` + `res.json()` is acceptable for
   a one-time script at dataset size (~50 MB).
