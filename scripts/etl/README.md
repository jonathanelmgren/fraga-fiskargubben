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

## Obtaining the dataset

**The exact download URL must be supplied by the operator.**  SMHI
Vattenwebb provides the SVAR dataset via its WFS service at
<https://vattenwebb.smhi.se/>.  The layer of interest is
**MS_WB_AREA** (Swedish water-body areas, EU WFD).

Typical WFS download URL pattern (verify against current service):

```
https://vattenwebb.smhi.se/ogc/wfs?SERVICE=WFS&VERSION=2.0.0
  &REQUEST=GetFeature&TYPENAMES=MS_WB_AREA&OUTPUTFORMAT=application/json
```

Download the full GeoJSON once, store it locally (it is ~50 MB), and pass
the `file://` path to `SVAR_WFS_URL`.  Do **not** hit the WFS service at
runtime from the application.

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

## Endpoint placeholder

**The exact station-list URL path must be verified by the operator** against the
current SMHI Open Data metobs API documentation at
<https://opendata.smhi.se/apidocs/metobs/> before running.

The script uses a `METOBS_STATION_URL` env var (defaulting to
`<TODO: confirm real path, e.g. /api/version/1.0/parameter/{p}/station.json>`).
The `{p}` placeholder is replaced at runtime with the numeric parameter id.
The base URL is controlled by `METOBS_BASE` (default:
`https://opendata-download-metobs.smhi.se`).

## Prerequisites

- `DATABASE_URL` environment variable pointing to the target Postgres database.
- `METOBS_STATION_URL` set to the verified endpoint path (with `{p}` for the
  parameter id), e.g. `/api/version/1.0/parameter/{p}/station.json`.
- Optionally `METOBS_BASE` if the base URL differs from the default.

## Running

```bash
# Once the correct endpoint path is known:
METOBS_STATION_URL="/api/version/1.0/parameter/{p}/station.json" \
  DATABASE_URL="postgres://..." \
  pnpm etl:metobs-stations
```

The script is **idempotent** — running it multiple times upserts rows on the
composite `(id, parameter)` PK so no duplicates are created.  A single
physical station can appear in both the `'pressure'` and `'temp'` sets; the
composite key handles this correctly.

---

# S-HYPE ETL — seed modeled water temperatures (STUB)

One-time (re-runnable) script that seeds the `water_temp` table from the SMHI
Vattenwebb S-HYPE sub-catchment water-temperature export.

## Status

**STUB** — the Vattenwebb S-HYPE export URL/format has not yet been wired.
The script exits with a clear error if `SHYPE_URL` is not set.  The rest of
the system degrades gracefully: `waterTempFor()` falls back to the code-computed
estimate (`source: "estimated"`, `confidence: "low"`) when no `water_temp` row
exists for a lake.

## Prerequisites

- `DATABASE_URL` environment variable pointing to the target Postgres database.
- `SHYPE_URL` set to the verified Vattenwebb S-HYPE export URL.

## Running

```bash
SHYPE_URL="https://..." DATABASE_URL="postgres://..." pnpm etl:shype
```

## Obtaining the dataset

SMHI Vattenwebb provides S-HYPE sub-catchment model output at
<https://vattenwebb.smhi.se/>.  The relevant product is the
**S-HYPE water-temperature** (sjötemperatur) export for Swedish lakes.

Typical access path (verify against current service — may require registration):

```
https://vattenwebb.smhi.se/modelentry/api/...
```

Download the export once, store it locally, and pass the `file://` path to
`SHYPE_URL`.  Do **not** hit the service at request time.

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

# depth ETL — seed bathymetric depth scalars (STUB)

One-time (re-runnable) script that seeds the `lake_depth` table from the SMHI
Vattenwebb bathymetry dataset.  Max and mean depth are available for ~10k
Swedish lakes.

## Status

**STUB** — the Vattenwebb bathymetry export URL/format has not yet been wired.
The script exits with a clear error if `DEPTH_URL` is not set.  The rest of
the system degrades gracefully: `depthFor()` in `src/lib/water/depth.ts`
returns `null` when no `lake_depth` row exists for a lake.

## Prerequisites

- `DATABASE_URL` environment variable pointing to the target Postgres database.
- `DEPTH_URL` set to the verified Vattenwebb bathymetry export URL.

## Running

```bash
DEPTH_URL="https://..." DATABASE_URL="postgres://..." pnpm etl:depth
```

## Obtaining the dataset

SMHI Vattenwebb provides bathymetry (djupdata) for Swedish lakes at
<https://vattenwebb.smhi.se/>.  The relevant dataset contains max depth
(`maxdjup`) and mean depth (`medeldjup`) per water body (EU WFD id).

**The exact download URL must be supplied by the operator.**

## Field-name assumptions (placeholder)

The mapper (`mapDepthRecord` in `import-depth.ts`) currently assumes the
following record shape (to be verified against the real export):

| Field       | Type               | Description                                   |
| ----------- | ------------------ | --------------------------------------------- |
| `lakeId`    | `string`           | EU WFD water-body code matching `lakes.id`    |
| `maxDepthM` | `number` (opt)     | Maximum lake depth in metres                  |
| `meanDepthM`| `number` (opt)     | Mean lake depth in metres                     |

Update `DepthRecord` in `import-depth.ts` once the real field names are known.

## Architecture

Per ADR-0002: ETL runs once (or on-demand by an operator), never at request
time.  The script creates its own `postgres` + `drizzle` connection using only
`DATABASE_URL` (does not use `@/shared/db/client`).

The `lake_depth` table is an optional data layer.  Lakes without a row get
`null` from `depthFor()` — callers must handle graceful absence.

---

# MVM ETL — seed water colour and Secchi sight depth (STUB)

One-time (re-runnable) script that seeds the `water_colour` table from the
SLU Miljödata-MVM API (SampleSites / FullSamples).  Records water colour
(brown/humic vs clear) and Secchi sight depth per lake.

## Status

**STUB** — the MVM API base URL has not yet been verified.  The script exits
with a clear error if `MVM_BASE_URL` is not set.  The system degrades
gracefully: `colourFor()` in `src/lib/water/colour.ts` returns `null` when no
`water_colour` row exists for a lake.

## Prerequisites

- `DATABASE_URL` environment variable pointing to the target Postgres database.
- `MVM_TICKET` set to your Miljödata-MVM public ticket.
- `MVM_BASE_URL` set to the verified MVM API base URL.

## Obtaining the MVM ticket

1. Register as a web-service user at Artdatabanken UserAdmin:
   <https://accounts.artdatabanken.se>
2. Log in to Miljödata-MVM "Mina sidor":
   <https://miljodata.slu.se/mvm/>
3. Activate the ticket.  No approval is required — it is issued immediately.

## Running

```bash
MVM_BASE_URL="https://miljodata.slu.se/mvm/api/v1" \
  MVM_TICKET="your-ticket-here" \
  DATABASE_URL="postgres://..." \
  pnpm etl:mvm
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

# Aqua ETL — seed fish species per lake from SLU Aqua / Sötebasen (STUB)

One-time (re-runnable) script that seeds the `lake_species` table from SLU Aqua /
Sötebasen test-fishing (provfiske) survey data.  Records which fish species are
present in each surveyed lake.

## Status

**STUB** — the SLU Aqua / Sötebasen API base URL and endpoint paths have not
yet been confirmed.  The script exits with a clear error if `AQUA_BASE_URL` is
not set.  The system degrades gracefully: `speciesFor()` in
`src/lib/water/species.ts` returns `null` when no `lake_species` row exists for
a lake.

## Prerequisites

- `DATABASE_URL` environment variable pointing to the target Postgres database.
- `AQUA_BASE_URL` set to the verified SLU Aqua / Sötebasen API base URL.

No authentication ticket is required per spec §6 (publicly available data).  If
the real endpoint requires authentication, add an `AQUA_TOKEN` env var and
update the script accordingly.

## Running

```bash
AQUA_BASE_URL="https://sotebasen.slu.se/api/v1" \
  DATABASE_URL="postgres://..." \
  pnpm etl:aqua
```

The script is **idempotent** — upserts on `lake_id` PK (`ON CONFLICT DO
UPDATE`) so re-runs are safe.  Species are merged across all matching stations
for the same lake; duplicates are removed by `normalizeSpecies`.

## Obtaining the dataset

SLU Aqua / Sötebasen (Swedish freshwater fish monitoring) provides test-fishing
(provfiske) data at <https://www.slu.se/aqua/> and the Sötebasen database at
<https://www.slu.se/institutioner/akvatiska-resurser/databaser/sotebasen/>.

The script assumes two endpoints (to be verified against current API docs):

| Endpoint             | Returns                             |
| -------------------- | ----------------------------------- |
| `GET /stations`      | Array of `AquaStation` (id/lat/lon) |
| `GET /catches`       | Array of `AquaCatch` (stationId, species) |

Update `AquaStation`, `AquaCatch` interfaces and endpoint paths in
`import-aqua.ts` once the real field names are confirmed.

## Import-time join (ADR-0002)

The Sötebasen data returns survey stations identified by coordinates, not by
EU WFD lake id.  The script joins each station to a lake **at import time**
using `stationMatchesLake` (`src/lib/water/station-match.ts`):

| Distance from lake centroid      | Confidence |
| -------------------------------- | ---------- |
| ≤ 200 m                          | `high`     |
| > 200 m and ≤ equal-area radius  | `low`      |
| > equal-area radius              | no match   |

Species from multiple matching stations for the same lake are merged and
deduplicated by `normalizeSpecies` (trim, lower-case, dedupe).

The runtime lookup `speciesFor()` is a pure table read with **no live SLU Aqua
call**.

## Architecture

Per ADR-0002: ETL runs once (or on-demand by an operator), never at request
time.  The script creates its own `postgres` + `drizzle` connection using only
`DATABASE_URL` (does not use `@/shared/db/client`).
