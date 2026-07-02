# ETL runbook — seeding the data layer

All slow/static data sources are **pre-imported into Postgres by these seed scripts**
(ADR-0002); only the SMHI snow1g forecast is fetched live at request time. These run **once**
(re-runnable / idempotent) at setup, and periodically (chemistry & species seasonally, station
rosters rarely) — **never on the request path**.

## Run order

Seed in this order (later sources join against the `lakes` table created first):

| # | Command | Seeds | Source status |
|---|---------|-------|---------------|
| 1 | `pnpm etl:svar` | `lakes` (all water bodies) | **FLAGGED** — no open SMHI WFS; use VISS API (needs apikey). Run first. |
| 2 | `pnpm etl:metobs-stations` | `metobs_station` (pressure=9, temp=1) | **VERIFIED live** — SMHI metobs. |
| 3 | `pnpm etl:shype` | `water_temp` (modeled override) | **FLAGGED** — no open bulk endpoint (per-area Excel only). Optional. |
| 4 | `pnpm etl:depth` | `lake_depth` (max) | **VERIFIED live** — NORS `maxDjup` (mean depth unavailable). |
| 5 | `pnpm etl:mvm` | `water_colour` + sight depth | **PARTLY VERIFIED** — endpoints verified; needs **MVM ticket** to confirm shapes. |
| 6 | `pnpm etl:aqua` | `lake_species` | **VERIFIED live** — NORS aggregated report. |

Apply migrations first: `pnpm db:migrate`. The `pg_trgm` extension (migration 0003) is required
for lake typeahead.

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
  `fångadeArter` (comma-separated species), `sweref99N/E` (SWEREF99TM), `area`, `maxDjup`.
- **depth** (`DEPTH_URL`) — ✅ **VERIFIED live** for max depth (reuses the NORS `maxDjup` field).
  ⚠️ **mean depth is unavailable from NORS** and is always `null`; SMHI's medeldjup/maxdjup is only
  in the interactive "Modelldata per område" viewer (no open bulk endpoint). Supply a custom export
  (`DEPTH_SOURCE=custom`, `DEPTH_URL=file://…`) if mean depth is required.
- **MVM** (`MVM_BASE_URL`, `MVM_TICKET`) — ⚠️ **endpoints VERIFIED, shapes FLAGGED**. Base
  `https://miljodata.slu.se/api/observations-service/v2`; ticket is query param **`token`** (not
  `ticket`). Two facts need a live ticket to confirm: (1) coordinates are **SWEREF99TM** and need
  reprojection to WGS84; (2) chemistry values are **nested** in `observations[]` keyed by
  `propertyCode`/`propertyAbbrevName` — the exact codes for absorbance-420 / färgtal / Secchi must be
  confirmed and wired into `MVM_PROPERTY_MATCH` in `import-mvm.ts`.
  Verify: `curl "$MVM_BASE_URL/full-samples/query?token=$MVM_TICKET" | jq '.[0].observations[].propertyAbbrevName'`
- **SVAR** (`SVAR_WFS_URL`) — 🚩 **FLAGGED**. SMHI's SVAR lake geometries are Lantmäteriet-derived and
  **not open data** (viewing service only — no open WFS/GeoJSON). Use **VISS** instead
  (`https://viss.lansstyrelsen.se/api?method=waters&watercategory=LW&coordinateformat=WGS84&format=json&apikey=<KEY>`);
  `coordinateformat=WGS84` satisfies the EPSG:4326 requirement directly. Needs a free apikey; the
  VISS response field names differ from the current GeoJSON mapper and must be confirmed with a key.
  Alternatively supply a one-off SVAR GeoJSON via a `file://` path (request WGS84/CRS84).
- **S-HYPE** (`SHYPE_URL`) — 🚩 **FLAGGED**. No open bulk endpoint; water-temperature is only a
  per-area Excel/CSV download and is keyed by **SUBID**, not EU_CD — a SUBID→EU_CD crosswalk plus a
  CSV/XLSX parser are required. Remains a stub.

The runtime app does **not** require any of these (the MVM ticket is `.optional()` in the env
schema); a missing source simply omits its Signal (graceful degradation, ADR-0002).

---

# SVAR ETL — import Swedish water bodies

One-time (re-runnable) script that seeds the `lakes` table from the SMHI
Vattenwebb SVAR (Swedish WAter Register) WFS dataset.

## Prerequisites

- `DATABASE_URL` environment variable pointing to the target Postgres database.
- The SVAR GeoJSON dataset (see **Obtaining the dataset** below), either
  accessible via a URL or as a local file.

## Running

```bash
# From a URL:
SVAR_WFS_URL="https://..." DATABASE_URL="postgres://..." pnpm etl:svar

# From a locally downloaded file:
SVAR_WFS_URL="file:///path/to/svar.geojson" DATABASE_URL="postgres://..." pnpm etl:svar
```

The script is **idempotent** — running it multiple times upserts rows on the
`id` PK (`ON CONFLICT DO UPDATE`) so no duplicates are created.

## Obtaining the dataset — FLAGGED (verified 2026-07-01)

**There is no open SMHI SVAR WFS/GeoJSON endpoint.** SMHI's SVAR lake geometries
are derived from Lantmäteriet material that is **not open data**, so Vattenwebb
publishes SVAR as a viewing service only (confirmed on the SMHI Vattenwebb pages
and the "Öppet API för vattenwebb" forum thread). The `vattenwebb.smhi.se/ogc/wfs`
path assumed by earlier versions returns 404.

**Recommended source — VISS** (Vatteninformationssystem Sverige, Länsstyrelserna),
the open register of ~37 000 water bodies **with EU_CD codes**:

```
https://viss.lansstyrelsen.se/api?method=waters&watercategory=LW
  &coordinateformat=WGS84&format=json&apikey=<KEY>
```

- `watercategory=LW` selects lakes (sjöar); `coordinateformat=WGS84` returns
  EPSG:4326 decimal degrees directly — **no SWEREF99TM reprojection needed**.
- Requires a free apikey (register at <https://viss.lansstyrelsen.se/api>).
- 🚩 **FLAG (live-verification pending):** the VISS `waters` response field names
  differ from the GeoJSON `properties` the mapper below expects. With a key,
  confirm the JSON keys for EU_CD / name / X / Y / area and update
  `SvarFeatureProperties` + `mapFeatureToLake` + the test fixture accordingly.

**Alternative — local GeoJSON file.** If a one-off SVAR GeoJSON export is obtained
(e.g. via Länsstyrelsernas geodata catalogue, shapefile→GeoJSON), pass its
`file://` path to `SVAR_WFS_URL`. Request WGS84/CRS84 (EPSG:4326); a SWEREF99TM
export would store projected metres into `lat`/`lon` and be wrong. Do **not** hit
any service at runtime from the application.

## Field-name assumptions

The mapper (`mapFeatureToLake` in `import-svar.ts`) expects the following
GeoJSON `properties` fields:

| SVAR field    | Type     | Nullable | Description                              |
| ------------- | -------- | -------- | ---------------------------------------- |
| `MS_CD`       | `string` | no       | EU WFD water-body code — used as PK      |
| `MS_NAME`     | `string` | yes      | Swedish name (blank → stored as `null`)  |
| `KOMMUNNAMN`  | `string` | no       | Municipality name (kommunnamn)           |
| `LANNAMN`     | `string` | no       | County name (lännamn)                    |
| `CENTROID_N`  | `number` | no       | Centroid northing (SWEREF99TM metres or WGS84 lat depending on CRS) |
| `CENTROID_E`  | `number` | no       | Centroid easting (SWEREF99TM metres or WGS84 lon) |
| `AREA_HA`     | `number` | no       | Surface area in hectares                 |

> **CRS note:** Centroid coordinates are stored as-is from the source.  If the
> WFS layer is requested in SWEREF99TM (EPSG:3006), `lat`/`lon` in the DB will
> be Swedish northing/easting in metres — not WGS84 degrees.  Request the layer
> in CRS84/EPSG:4326 if you need WGS84 decimal degrees, and update
> `CENTROID_N` → latitude, `CENTROID_E` → longitude mapping accordingly.

These field names match the SVAR attribute documentation at
<https://vattenwebb.smhi.se/>.  If the actual service uses different names
(e.g. `EUCD`, `NAMN`, `AREAL_HA`) update the `SvarFeatureProperties`
interface and `mapFeatureToLake` function accordingly — the test fixture in
`import-svar.test.ts` makes the mapping explicit and must be updated too.

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
DATABASE_URL="postgres://..." pnpm etl:metobs-stations
```

The script is **idempotent** — running it multiple times upserts rows on the
composite `(id, parameter)` PK so no duplicates are created.  A single
physical station can appear in both the `'pressure'` and `'temp'` sets; the
composite key handles this correctly.

---

# S-HYPE ETL — seed modeled water temperatures (STUB)

One-time (re-runnable) script that seeds the `water_temp` table from the SMHI
Vattenwebb S-HYPE sub-catchment water-temperature export.

## Status — STUB (no open bulk endpoint; FLAGGED 2026-07-01)

SMHI Vattenwebb publishes S-HYPE modeled water temperature at the outlet of each
sub-catchment, but **only via the interactive "Modelldata per område" viewer**
(<https://vattenwebb.smhi.se/modelarea/>) as a per-area Excel/CSV download —
there is **no documented open bulk REST/WFS endpoint** (SMHI staff confirm the
only API-available hydrology product today is water discharge, not temperature).

Two further gaps before a real run:

1. **Join-key mismatch** — the series are keyed by **SUBID** (sub-catchment id),
   not the EU WFD code used as `lakes.id`. A SUBID→EU_CD crosswalk is required
   (`mapRecordToWaterTemp` assumes `lakeId` already matches `lakes.id`).
2. **Format** — the export is Excel/CSV, not JSON. The fetch still assumes JSON;
   add a parser or pre-convert to the `ShypeRecord` JSON shape.

The script exits with a clear error if `SHYPE_URL` is not set. The rest of the
system degrades gracefully: `waterTempFor()` falls back to the code-computed
estimate (`source: "estimated"`, `confidence: "low"`) when no `water_temp` row
exists for a lake.

## Prerequisites

- `DATABASE_URL` environment variable pointing to the target Postgres database.
- `SHYPE_URL` set to a `file://` path of a manually-exported, pre-shaped
  `ShypeRecord` JSON array (with `lakeId` already mapped from SUBID to EU_CD).

## Running

```bash
SHYPE_URL="file:///path/to/shype-watertemp.json" DATABASE_URL="postgres://..." pnpm etl:shype
```

## Obtaining the dataset

Reference: **Vattentemperatur- och isberäkningar i S-HYPE**
(<https://www.smhi.se/data/sjoar-och-vattendrag/vattenwebb/om-data-i-vattenwebb/vattentemperatur--och-isberakningar-i-s-hype>).
Download the per-area temperature series from "Modelldata per område", convert to
the `ShypeRecord` shape below, store locally, and pass the `file://` path to
`SHYPE_URL`. Do **not** hit the service at request time.

## Field-name assumptions (placeholder)

The mapper (`mapRecordToWaterTemp` in `import-shype.ts`) currently assumes the
following record shape (to be verified against the real export):

| Field    | Type     | Description                                          |
| -------- | -------- | ---------------------------------------------------- |
| `lakeId` | `string` | Sub-catchment / lake id matching `lakes.id`          |
| `tempC`  | `number` | Modeled water temperature in °C                      |
| `asOf`   | `string` | ISO-8601 timestamp of the model output               |

Update `ShypeRecord` in `import-shype.ts` once the real field names are known.

## Architecture

Per ADR-0002: ETL runs once (or on-demand by an operator), never at request
time.  The script creates its own `postgres` + `drizzle` connection using only
`DATABASE_URL` (does not use `@/shared/db/client`).

The `water_temp` table acts as an optional override layer.  Lakes without a row
get the estimate fallback in `src/lib/water/temp.ts#waterTempFor()`.

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
DATABASE_URL="postgres://..." pnpm etl:depth

# Custom export supplying mean depth:
DEPTH_SOURCE=custom DEPTH_URL="file:///path/to/depth.json" \
  DATABASE_URL="postgres://..." pnpm etl:depth
```

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

# MVM ETL — seed water colour and Secchi sight depth (endpoints VERIFIED)

One-time (re-runnable) script that seeds the `water_colour` table from the
SLU Miljödata-MVM **Observations API v2**. Records water colour (brown/humic vs
clear) and Secchi sight depth per lake.

## Status — endpoints VERIFIED, response shapes FLAGGED (2026-07-01)

The v2 REST API and base path were verified against the OpenAPI spec
(<https://miljodata.slu.se/api/docs/index.html>). Base path:
`https://miljodata.slu.se/api/observations-service/v2`; the ticket is the query
parameter **`token`** (not `ticket`). Two facts need a **live ticket** to confirm
before a real run:

1. **Coordinates are SWEREF99TM**, not WGS84 (`sampleSiteCoordinateN/E` +
   `sampleSiteCoordinateSystem`). They must be reprojected to WGS84 before the
   coordinate join is meaningful (reprojection is still TODO in `import-mvm.ts`).
2. **Chemistry values are nested** in `observations[]` keyed by `propertyCode` /
   `propertyAbbrevName`, not flat `absorbans420`/`fargtal`/`siktdjupM` keys.
   Confirm the exact property codes and wire them into `MVM_PROPERTY_MATCH`:
   `curl "$MVM_BASE_URL/full-samples/query?token=$MVM_TICKET" | jq '.[0].observations[].propertyAbbrevName'`

The system degrades gracefully: `colourFor()` in `src/lib/water/colour.ts`
returns `null` when no `water_colour` row exists for a lake.

## Endpoints (VERIFIED against the OpenAPI spec)

| Path (under the base) | Returns |
| --------------------- | ------- |
| `/sample-sites/ids`   | sample-site ids (filterable) |
| `/sample-sites/{id}`  | one `SampleSite` (coordinates + CRS) |
| `/full-samples/query` | samples WITH nested `observations[]` |
| `/all-full-samples/chemistry` | pre-generated bulk chemistry export |

## Prerequisites

- `DATABASE_URL` environment variable pointing to the target Postgres database.
- `MVM_TICKET` set to your Miljödata-MVM public ticket (passed as `token`).
- (Optional) `MVM_BASE_URL` to override the verified default base path.

## Obtaining the MVM ticket

1. Register as a web-service user at Artdatabanken UserAdmin:
   <https://accounts.artdatabanken.se>
2. Log in to Miljödata-MVM "Mina sidor":
   <https://miljodata.slu.se/mvm/>
3. Activate the ticket.  No approval is required — it is issued immediately.

## Running

```bash
MVM_TICKET="your-ticket-here" DATABASE_URL="postgres://..." pnpm etl:mvm
```

The script is **idempotent** — upserts on `lake_id` PK (`ON CONFLICT DO
UPDATE`) so re-runs are safe.

## Import-time join (ADR-0002)

The MVM API returns sample stations identified by coordinates, not by EU WFD
lake id.  The script joins each station to a lake **at import time** using
`stationMatchesLake` (`src/lib/water/station-match.ts`):

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
DATABASE_URL="postgres://..." pnpm etl:aqua
```

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

Each aggregated record already carries `eU_CD` (the lake PK) **directly**, so no
coordinate join is required for the ~94% of rows that have it. To keep issue #3
scoped to URLs/params/field-shapes, each record is currently adapted into the
existing station+catch maps and the coordinate join loop is left **unchanged**
for issue #4 to restructure (join on `eU_CD` directly; fall back to the
SWEREF99→WGS84-projected coordinate match only for blank-`eU_CD` rows). The
loop uses `stationMatchesLake` (`src/lib/water/station-match.ts`):

| Distance from lake centroid      | Confidence |
| -------------------------------- | ---------- |
| ≤ 200 m                          | `high`     |
| > 200 m and ≤ equal-area radius  | `low`      |
| > equal-area radius              | no match   |

⚠️ **Until #4 lands, the coordinate join uses raw SWEREF99TM metres as lat/lon
and will not match** — the eU_CD-direct join is the intended path. Species from
multiple matching records for the same lake are merged and deduplicated by
`normalizeSpecies` (trim, lower-case, dedupe).

The runtime lookup `speciesFor()` is a pure table read with **no live SLU Aqua
call**.

## Architecture

Per ADR-0002: ETL runs once (or on-demand by an operator), never at request
time.  The script creates its own `postgres` + `drizzle` connection using only
`DATABASE_URL` (does not use `@/shared/db/client`).
