# ETL runbook — seeding the data layer

All slow/static data sources are **pre-imported into Postgres by these seed scripts**
(ADR-0002); only the SMHI snow1g forecast is fetched live at request time. These run **once**
(re-runnable / idempotent) at setup, and periodically (chemistry & species seasonally, station
rosters rarely) — **never on the request path**.

## Run order

**Seed everything at once:** `pnpm seed:all` runs all five in the correct order.
`svar` is treated as a hard prerequisite — if it fails the run aborts (a missing
`lakes` table makes every downstream join meaningless); the other four are
independent, so a failure in one does not stop the rest. The command exits
non-zero if any step failed, and prints an ok/failed summary. All ETL writes are
idempotent upserts, so re-running is safe.

To run a single source instead, seed in this order (later sources join against
the `lakes` table created first):

| # | Command | Seeds | Source status |
|---|---------|-------|---------------|
| 1 | `pnpm etl:svar` | `lakes` (all water bodies) | **VERIFIED live** — VISS API (`VISS_APIKEY`). Run first; later sources join `lakes`. |
| 2 | `pnpm etl:metobs-stations` | `metobs_station` (pressure=9, temp=1) | **VERIFIED live** — SMHI metobs. |
| 3 | `pnpm etl:depth` | `lake_depth` (max) | **VERIFIED live** — NORS `maxDjup` (mean depth unavailable). |
| 4 | `pnpm etl:mvm` | `water_colour` + sight depth | **VERIFIED live** — bulk chemistry export (`MVM_TICKET`). |
| 5 | `pnpm etl:aqua` | `lake_species` | **VERIFIED live** — NORS aggregated report. |

There is **no ETL for water temperature** — it is computed at request time by the estimate in
`src/lib/water/temp.ts` (season + air-temp trend + lake size), always `estimated`/`low`. No live
lake-water-temp API exists; [ADR-0006](../../docs/adr/0006-no-live-lake-water-temperature-source.md)
records why.

Apply migrations first: `pnpm db:migrate`. The `pg_trgm` extension (migration 0003) is required
for lake typeahead.

**SVAR (lakes) must run first** — every other source joins against the `lakes` table it seeds.

**Env loading.** The `etl:*` package.json scripts run
`tsx --env-file-if-exists=.env scripts/etl/import-X.ts`, so each script **auto-loads the repo's
`.env`** (which holds `DATABASE_URL` plus the ETL credentials `VISS_APIKEY` and `MVM_TICKET`). The
run command is therefore just `pnpm etl:<name>` — no inline env prefixes. Each section below still
lists the env vars its script reads; put them in `.env`.

## Source verification status (issue #3, checked 2026-07-01)

Endpoints were verified against the live API / OpenAPI spec where possible. Where live verification
needs a credential (VISS apikey, MVM ticket) or the data is not open, the source is **FLAGGED** with
the exact remaining step.

- **metobs stations** (`METOBS_STATION_URL`) — ✅ **VERIFIED live**. Station list is the parameter
  node itself: `GET /api/version/1.0/parameter/{p}.json` → envelope with a `station[]` array
  (`id`, `name`, `latitude`, `longitude`, `active`, `from`, `to`). The previous `/station.json`
  sub-path did not exist. Parameter ids 9 (pressure) / 1 (temp) confirmed via each node's title.
- **metobs observations** (`src/lib/weather/metobs.ts`, `METOBS_OBS_URL`) — ✅ **VERIFIED live**.
  `.../parameter/{p}/station/{s}/period/{period}/data.json` → `{ value: [ { date: <epoch ms>,
  value: "8.9", quality } ] }`. Valid periods: `latest-hour`, `latest-day`, `latest-months`,
  `corrected-archive`. Wind ids **4 = speed, 3 = direction** confirmed. The 5-day air-temp trend now
  fetches `latest-months` (the narrowest period covering ≥5 days — `latest-day` is only ~24 h) and
  **filters to the trailing 5-day window in code** (there is no native 5-day period).
- **Aqua / NORS** (`AQUA_BASE_URL`) — ✅ **VERIFIED live**. `GET https://dvfisk.slu.se/api/v1/nors/
  data-aggregerad/rapport` returns a flat array (~4250 lakes) with `eU_CD` (matches `lakes.id`),
  `fångadeArter` (comma-separated species), `sweref99N/E` (SWEREF99TM), `area`, `maxDjup`. The
  blank-`eU_CD` (~6%) coordinate fallback now **reprojects SWEREF99TM→WGS84** (via
  `src/lib/geo/sweref99.ts`) before matching; the direct `eU_CD` join is unchanged.
- **depth** (`DEPTH_URL`) — ✅ **VERIFIED live** for max depth (reuses the NORS `maxDjup` field).
  ⚠️ **mean depth is unavailable from NORS** and is always `null`; SMHI's medeldjup/maxdjup is only
  in the interactive "Modelldata per område" viewer (no open bulk endpoint). Supply a custom export
  (`DEPTH_SOURCE=custom`, `DEPTH_URL=file://…`) if mean depth is required.
- **MVM** (`MVM_BASE_URL`, `MVM_TICKET`) — ✅ **VERIFIED live**. Base
  `https://miljodata.slu.se/api/observations-service/v2`; ticket is query param **`token`** (not
  `ticket`). The bulk chemistry export `GET /all-full-samples/chemistry?token=<MVM_TICKET>`
  (~500 MB / 1.15M samples) is the source. Confirmed property codes: `Abs_F420` (absorbance, unit
  is /5cm → multiplied ×20 to per-metre), `Farg` (färgtal), `Siktdjup` (Secchi). Coordinates are
  **SWEREF99TM**, reprojected to WGS84 via `src/lib/geo/sweref99.ts`; the station→lake join is on
  `stationEUID` (EU WFD code → `lakes.id`) with a reprojected-coordinate fallback. ⚠️ The 500 MB
  response may need an `MVM_MAX_SAMPLES` cap or `NODE_OPTIONS=--max-old-space-size`; a streaming
  parser is deferred.
- **SVAR** (`VISS_APIKEY`, optional `VISS_API_URL`) — ✅ **VERIFIED live**. Source is the **VISS API**
  directly (Vatteninformationssystem Sverige, Länsstyrelserna), not an SMHI WFS. It fetches three
  VISS methods: `waters&watercategory=LW` (lakes), `municipalities`, and `counties` (to resolve
  municipality/county names). Coordinates come from the `LatLong` entry in each water's
  `Coordinates[]` (WGS84 — no reprojection). Needs a free apikey (`VISS_APIKEY`). Verified:
  **7252/7267 lakes map**.
- **water temperature** — 🚫 **no live source, no ETL**. There is no open API for lake water
  temperature (S-HYPE is manual per-SUBID Excel only), so water temp is computed by the estimate in
  `src/lib/water/temp.ts` (`estimated`/`low`), not seeded. See
  [ADR-0006](../../docs/adr/0006-no-live-lake-water-temperature-source.md).

The runtime app does **not** require any of these (the MVM ticket is `.optional()` in the env
schema); a missing source simply omits its Signal (graceful degradation, ADR-0002).

---

# SVAR ETL — import Swedish water bodies

One-time (re-runnable) script that seeds the `lakes` table from the **VISS API**
(Vatteninformationssystem Sverige, Länsstyrelserna) — the open register of Swedish
water bodies **with EU_CD codes**. This must run **first**; every other ETL joins
against the `lakes` table it creates.

## Prerequisites

- `DATABASE_URL` — target Postgres database.
- `VISS_APIKEY` — a free VISS apikey (register at <https://viss.lansstyrelsen.se/api>).
- (Optional) `VISS_API_URL` to override the default VISS base URL.

## Running

```bash
pnpm etl:svar
```

`DATABASE_URL` and `VISS_APIKEY` are read from the repo's `.env` (auto-loaded via
`--env-file-if-exists=.env`). The script is **idempotent** — running it multiple
times upserts rows on the `id` PK (`ON CONFLICT DO UPDATE`) so no duplicates are
created.

## Source — VISS API (VERIFIED live 2026-07-02)

The SMHI SVAR geometries are Lantmäteriet-derived and **not open data**, so the
source is the **VISS API** directly (no WFS, no `SVAR_WFS_URL`). The script calls
three VISS methods and joins them in memory:

| VISS method | Provides |
| ------------------------------ | ---------------------------------------------- |
| `waters&watercategory=LW`      | lakes (sjöar) — EU_CD, name, coordinates, area |
| `municipalities`               | municipality id → name lookup |
| `counties`                     | county id → name lookup |

Each water's coordinates come from the **`LatLong` entry in its `Coordinates[]`
array** — already WGS84 (EPSG:4326) decimal degrees, so **no SWEREF99TM
reprojection is needed** for SVAR. `municipalities` / `counties` resolve the
kommun/län names referenced by id on each water.

Verified: **7252 / 7267 lakes map** successfully.

## Field mapping

The mapper (`mapWaterToLake` in `import-svar.ts`) reads the VISS `waters`
records: the EU_CD water-body code (used as the `id` PK), the water name
(blank → stored as `null`), the municipality/county ids (resolved to names via the
`municipalities`/`counties` lookups), the `LatLong` coordinates (lat/lon, WGS84),
and the surface area in hectares. The test fixture in `import-svar.test.ts` makes
the mapping explicit and must be kept in sync.

## Architecture decision

Per ADR-0002: this ETL runs once (or on-demand by an operator), never at
request time.  The script does not use `@/shared/db/client` (which imports
`server-only` and validates all app env vars) — instead it creates its own
minimal `postgres` + `drizzle` connection using only `DATABASE_URL`.

---

# metobs stations ETL — seed SMHI weather station lists

One-time (re-runnable) script that seeds the `metobs_station` table from the
SMHI Open Data metobs API for two weather parameters: air pressure and air
temperature.  A later task uses these rows to find the nearest station to a
lake when answering forecast questions.

## Parameter ids

| DB value    | SMHI parameter id | Description        |
| ----------- | ----------------- | ------------------ |
| `'pressure'` | **9**            | Air pressure       |
| `'temp'`     | **1**            | Air temperature    |

## Endpoint (VERIFIED live 2026-07-01)

The station list for a parameter **is the parameter node itself** — it carries a
`station` array; there is no separate `/station.json` sub-resource. Verified
against `https://opendata-download-metobs.smhi.se/api.json` and a live fetch of
parameter 1 (1000 stations). Docs: <https://opendata.smhi.se/apidocs/metobs/>.

The script defaults `METOBS_STATION_URL` to `/api/version/1.0/parameter/{p}.json`
(the `{p}` placeholder is replaced with the numeric parameter id) and `METOBS_BASE`
to `https://opendata-download-metobs.smhi.se`. Neither needs to be set for a
normal run; override only if the API version changes.

## Prerequisites

- `DATABASE_URL` environment variable pointing to the target Postgres database.
- Optionally `METOBS_STATION_URL` / `METOBS_BASE` to override the verified defaults.

## Running

```bash
pnpm etl:metobs-stations
```

`DATABASE_URL` is read from the repo's `.env`.

The script is **idempotent** — running it multiple times upserts rows on the
composite `(id, parameter)` PK so no duplicates are created.  A single
physical station can appear in both the `'pressure'` and `'temp'` sets; the
composite key handles this correctly.

---

# Water temperature — no ETL (computed estimate only)

Water temperature has **no seed script**. It is computed at request time by
`src/lib/water/temp.ts` (season baseline + 5-day air-temp trend + lake-size
responsiveness), always tagged `source: "estimated"`, `confidence: "low"`. No live
lake-water-temperature API exists, so there is nothing to import;
[ADR-0006](../../docs/adr/0006-no-live-lake-water-temperature-source.md) records the
investigation and decision.

---

# depth ETL — seed max depth from NORS

One-time (re-runnable) script that seeds the `lake_depth` table with per-lake
**max depth** from the SLU Aqua NORS aggregated report (the same endpoint the
Aqua species ETL uses — its `maxDjup` field, keyed by `eU_CD`).

## Status — VERIFIED live (max depth only) 2026-07-01

Max depth is wired against the NORS aggregated report and needs no operator
config. ⚠️ **Mean depth is unavailable from NORS** and is always `null`. SMHI
Vattenwebb's medeldjup/maxdjup exists only in the interactive "Modelldata per
område" viewer (no open bulk endpoint). If mean depth is required, supply a
custom export (see below).

The system degrades gracefully: `depthFor()` in `src/lib/water/depth.ts` returns
`null` when no `lake_depth` row exists for a lake.

## Prerequisites

- `DATABASE_URL` environment variable pointing to the target Postgres database.
- (Optional) `DEPTH_URL=file://…` + `DEPTH_SOURCE=custom` for a custom export.

## Running

```bash
# Default: NORS max depth (no source config needed):
pnpm etl:depth
```

`DATABASE_URL` is read from the repo's `.env`. For a custom export supplying mean
depth, set `DEPTH_SOURCE=custom` and `DEPTH_URL=file:///path/to/depth.json` in
`.env`, then run `pnpm etl:depth`.

## Obtaining a custom (mean-depth) dataset

Export bathymetry (djupdata: `maxdjup` / `medeldjup` per EU WFD id) from SMHI
Vattenwebb's "Modelldata per område", convert to a JSON array of `DepthRecord`
(`lakeId`, `maxDepthM?`, `meanDepthM?`), store locally, and pass the `file://`
path to `DEPTH_URL` with `DEPTH_SOURCE=custom`.

## Architecture

Per ADR-0002: ETL runs once (or on-demand by an operator), never at request
time.  The script creates its own `postgres` + `drizzle` connection using only
`DATABASE_URL` (does not use `@/shared/db/client`).

The `lake_depth` table is an optional data layer.  Lakes without a row get
`null` from `depthFor()` — callers must handle graceful absence.

---

# MVM ETL — seed water colour and Secchi sight depth (VERIFIED live)

One-time (re-runnable) script that seeds the `water_colour` table from the
SLU Miljödata-MVM **Observations API v2**. Records water colour (brown/humic vs
clear) and Secchi sight depth per lake.

## Status — VERIFIED live (2026-07-02)

The v2 REST API and base path were verified against the OpenAPI spec
(<https://miljodata.slu.se/api/docs/index.html>) and a live ticket. Base path:
`https://miljodata.slu.se/api/observations-service/v2`; the ticket is the query
parameter **`token`** (not `ticket`). The ETL uses the **bulk chemistry export**
`GET /all-full-samples/chemistry?token=<MVM_TICKET>` (~500 MB / 1.15M samples).

Confirmed facts:

1. **Property codes** (nested in each sample's `observations[]`): `Abs_F420`
   (absorbance-420 — unit is per 5 cm, so it is multiplied **×20** to per-metre),
   `Farg` (färgtal), `Siktdjup` (Secchi sight depth). These are wired into
   `MVM_PROPERTY_MATCH` in `import-mvm.ts`.
2. **Coordinates are SWEREF99TM** (`sampleSiteCoordinateN/E`) and are reprojected
   to WGS84 via `src/lib/geo/sweref99.ts`. The station→lake join is on
   `stationEUID` (EU WFD code → `lakes.id`) with a reprojected-coordinate fallback.

⚠️ **Memory caveat:** the ~500 MB response is parsed in memory. If it OOMs, set an
`MVM_MAX_SAMPLES` cap and/or raise the heap with
`NODE_OPTIONS=--max-old-space-size=...`. A streaming parser is deferred.

The system degrades gracefully: `colourFor()` in `src/lib/water/colour.ts`
returns `null` when no `water_colour` row exists for a lake.

## Endpoints (VERIFIED against the OpenAPI spec)

| Path (under the base) | Returns |
| --------------------- | ------- |
| `/sample-sites/ids`   | sample-site ids (filterable) |
| `/sample-sites/{id}`  | one `SampleSite` (coordinates + CRS) |
| `/full-samples/query` | samples WITH nested `observations[]` |
| `/all-full-samples/chemistry` | pre-generated bulk chemistry export (used by this ETL) |

## Prerequisites

- `DATABASE_URL` environment variable pointing to the target Postgres database.
- `MVM_TICKET` set to your Miljödata-MVM public ticket (passed as `token`).
- (Optional) `MVM_BASE_URL` to override the verified default base path.
- (Optional) `MVM_MAX_SAMPLES` to cap the number of samples parsed (memory guard).

## Obtaining the MVM ticket

1. Register as a web-service user at Artdatabanken UserAdmin:
   <https://accounts.artdatabanken.se>
2. Log in to Miljödata-MVM "Mina sidor":
   <https://miljodata.slu.se/mvm/>
3. Activate the ticket.  No approval is required — it is issued immediately.

## Running

```bash
pnpm etl:mvm
```

`DATABASE_URL` and `MVM_TICKET` are read from the repo's `.env`. If the ~500 MB
response OOMs, run with `NODE_OPTIONS=--max-old-space-size=4096 pnpm etl:mvm` or
set `MVM_MAX_SAMPLES` in `.env`. The script is **idempotent** — upserts on
`lake_id` PK (`ON CONFLICT DO UPDATE`) so re-runs are safe.

## Import-time join (ADR-0002)

The script joins each MVM station to a lake **at import time**. The primary key is
`stationEUID` (EU WFD code → `lakes.id`, a direct match). For stations without a
usable EUID it falls back to a coordinate match: the SWEREF99TM
`sampleSiteCoordinateN/E` are reprojected to WGS84 (via `src/lib/geo/sweref99.ts`)
and compared against lake centroids with `stationMatchesLake`
(`src/lib/water/station-match.ts`):

| Distance from lake centroid      | Confidence |
| -------------------------------- | ---------- |
| ≤ 200 m                          | `high`     |
| > 200 m and ≤ equal-area radius  | `low`      |
| > equal-area radius              | no match   |

The equal-area radius is `sqrt(areaHa × 10 000 / π)` metres — the radius of a
circle with the same area as the lake.  This is an approximation; a proper
polygon-containment check will replace it when GSD polygon data is available.

The runtime lookup `colourFor()` is a pure table read with **no live MVM call
and no reference to MVM_TICKET**.

## Colour classification threshold

`deriveColour` in `src/lib/water/colour.ts`:

| Input field    | Threshold   | Classification |
| -------------- | ----------- | -------------- |
| `absorbans420` | > 0.1 m⁻¹  | `brown`        |
| `absorbans420` | ≤ 0.1 m⁻¹  | `clear`        |
| `fargtal`      | > 30 mg Pt/L| `brown`        |
| `fargtal`      | ≤ 30 mg Pt/L| `clear`        |

References: EEA humic water classification; Naturvårdsverket water colour
guidelines for Swedish national lake monitoring (NV rapport 6555, appendix).

## Architecture

Per ADR-0002: ETL runs once (or on-demand by an operator), never at request
time.  The script creates its own `postgres` + `drizzle` connection using only
`DATABASE_URL` (does not use `@/shared/db/client`).

---

# Aqua ETL — seed fish species per lake from SLU Aqua NORS

One-time (re-runnable) script that seeds the `lake_species` table from the SLU
Aqua **NORS** database (Nationellt Register över Sjöprovfisken — lake test-fishing
/ provfiske). Records which fish species are present in each surveyed lake.

## Status — VERIFIED live 2026-07-01

Wired against the NORS aggregated per-lake report and needs no operator config.
The system degrades gracefully: `speciesFor()` in `src/lib/water/species.ts`
returns `null` when no `lake_species` row exists for a lake.

## Prerequisites

- `DATABASE_URL` environment variable pointing to the target Postgres database.
- (Optional) `AQUA_BASE_URL` / `AQUA_RAPPORT_PATH` to override verified defaults.

No authentication ticket is required (publicly available data, spec §6).

## Running

```bash
pnpm etl:aqua
```

`DATABASE_URL` is read from the repo's `.env`.

The script is **idempotent** — upserts on `lake_id` PK (`ON CONFLICT DO
UPDATE`) so re-runs are safe.  Species are merged across all matching records
for the same lake; duplicates are removed by `normalizeSpecies`.

## Obtaining the dataset (VERIFIED)

SLU Aqua publishes NORS via the public portal <https://dvfisk.slu.se>. The
per-lake aggregated report endpoint (used here) is:

```
GET https://dvfisk.slu.se/api/v1/nors/data-aggregerad/rapport
```

Returns a flat JSON array (~4250 lakes) — one record per surveyed lake. Field
description: <https://dvfisk.slu.se/assets/NORS_databeskrivning.pdf> (section
"Nätprovfiske aggregerade data"). Fields this ETL reads (camelCased in JSON):

| NORS field     | JSON key       | Description |
| -------------- | -------------- | ----------- |
| `EU_CD`        | `eU_CD`        | EU WFD water-body code (matches `lakes.id`); blank `" "` for ~6% of rows |
| `Sjö`          | `sjö`          | Lake name with SMHI id prefix |
| `FångadeArter` | `fångadeArter` | Comma-separated species list |
| `Sweref99N/E`  | `sweref99N/E`  | SWEREF99TM coordinates (metres) |
| `Area`         | `area`         | Area in hectares |
| `Maxdjup`      | `maxDjup`      | Max depth in metres (also used by the depth ETL) |

## Import-time join (ADR-0002)

Each aggregated record already carries `eU_CD` (the lake PK) **directly**, so the
~94% of rows that have it join on `eU_CD` with no coordinate math. For the
blank-`eU_CD` rows (~6%), the fallback coordinate match now **reprojects the
SWEREF99TM `sweref99N/E` to WGS84** (via `src/lib/geo/sweref99.ts`) before
comparing against lake centroids with `stationMatchesLake`
(`src/lib/water/station-match.ts`):

| Distance from lake centroid      | Confidence |
| -------------------------------- | ---------- |
| ≤ 200 m                          | `high`     |
| > 200 m and ≤ equal-area radius  | `low`      |
| > equal-area radius              | no match   |

Species from multiple matching records for the same lake are merged and
deduplicated by `normalizeSpecies` (trim, lower-case, dedupe).

The runtime lookup `speciesFor()` is a pure table read with **no live SLU Aqua
call**.

## Architecture

Per ADR-0002: ETL runs once (or on-demand by an operator), never at request
time.  The script creates its own `postgres` + `drizzle` connection using only
`DATABASE_URL` (does not use `@/shared/db/client`).
