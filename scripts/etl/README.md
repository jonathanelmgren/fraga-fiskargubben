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
