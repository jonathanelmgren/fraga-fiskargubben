# Spec: full lake coverage via Lantmäteriet Topografi (CC0)

Status: **Proposed** (2026-07-02) · Owner: TBD · Supersedes VISS as the lake universe

## Problem

The `lakes` table is seeded from VISS `waters&watercategory=LW` = **~7,250 WFD-classified
lake water bodies**, not Sweden's **~100,000 lakes**. Small tarns and most named lakes are
absent, so a large share of real fishing lakes fail to resolve → in-persona reprompt with no
way forward (there is no geocoding fallback, by design). This caps how "complete" the app
feels regardless of the weather/water pipeline quality.

VISS cannot fix this: `waters` returns 7,267 for LW and 26,531 across all categories — it is
the WFD register, not the lake register. The full lake set lives in **SVAR / Lantmäteriet**.

## Source decision

Use **Lantmäteriet "Topografi Nedladdning, vektor"** (Topografi 10 / 50 / 100), **CC0 open
data** since the 2022 geodata reform (attribution desired, not required). It contains the full
named Swedish lake set: lake **surface polygons** + Lantmäteriet's official, reviewed names
(Ortnamnsregistret). Distributed via **Geotorget** as **GeoPackage (.gpkg)**.

- Lake polygons live in **Tema Mark** (land-cover surfaces), NOT the Hydrografi theme (which
  is lines/points — streams, structures).
- Lake names live in **Tema Text** (granskade ortnamn), linked spatially to the polygons.
- CRS is **SWEREF99TM (EPSG:3006)** → reproject to WGS84 with the existing
  `src/lib/geo/sweref99.ts`.
- **Do NOT use** the Inspire "Hydrografi Nedladdning" product — still license + fee. Use the
  open-data Topografi vektor products; **verify the CC0 license tag on Geotorget before
  wiring.**

Product tier: start with **Topografi 50** (open CC0, lighter than Topografi 10, national
coverage, adequate centroid accuracy for a point weather lookup). Revisit if name/geometry
fidelity is insufficient.

## The architecture change (the important part)

Switching the lake universe to Lantmäteriet **removes VISS EU_CD as the spine** — Lantmäteriet
lakes carry neither EU_CD nor NORS ids. Two registers then cooperate:

- **Lantmäteriet = the lake universe** — id, official name, centroid (from polygon). This is
  what the user resolves against and what feeds the SMHI point call.
- **VISS = the classified subset** that carries the environmental-data link (EU_CD), which MVM
  and NORS still join on.

So we need a **crosswalk**, built once in ETL: each Lantmäteriet lake ↔ its VISS EU_CD (when
one exists), via point-in-polygon (VISS centroid inside the LM polygon) or nearest-centroid
within a tolerance, storing **match confidence** and logging unmatched rows.

```
  Lantmäteriet (all lakes)          VISS (classified subset, EU_CD)
        │ id, name, centroid              │ EU_CD
        └──────────── crosswalk ──────────┘   (PIP / nearest-centroid, confidence)
                        │
        lakes.id = Lantmäteriet id (new canonical)
        lakes.eu_cd = matched VISS EU_CD (nullable)
                        │
   MVM / NORS still join on eu_cd → resolve to a lakes row via the crosswalk
```

### Schema changes

- `lakes.id` becomes the **Lantmäteriet lake id** (new canonical). Keep the existing columns
  (name, municipality, county, lat, lon, area_ha).
- Add `lakes.eu_cd text` (nullable) — the matched VISS code, for the env-data join.
- Add `lakes.source text` — `'lantmateriet'` | `'viss'` (during transition / provenance).
- MVM/NORS ETL: join `eU_CD`/`stationEUID` → `lakes.eu_cd` (not `lakes.id`) once the switch
  lands. **This is the breaking change** — every source that currently joins on `lakes.id =
  EU_CD` must move to `lakes.eu_cd`.
- Migration must preserve existing `water_colour`/`lake_species`/`lake_depth` rows keyed by
  EU_CD → re-point them at the new lake ids via the crosswalk.

### Filtering

Lantmäteriet has ~100k+ water surfaces including tiny unnamed tarns. Filter to a **relevant,
fishable** set: **named lakes** with **area ≥ a minimum** (e.g. ≥ 1 ha, tune later). Unnamed
bodies can be imported for join completeness but hidden from typeahead (mirrors current
behavior). Expect a set **many times larger than VISS's 7,250** but not the full 100k of noise.

## ETL pipeline

This is a **bulk geodata import**, heavier than the current API pulls:

1. **Acquire**: download the Topografi 50 GeoPackage from Geotorget (manual or its download
   API). One-time; re-fetch on Lantmäteriet updates.
2. **Load to PostGIS**: `ogr2ogr` the `.gpkg` lake-surface layer (Tema Mark water polygons)
   into a staging PostGIS table. **Requires the PostGIS extension** (new infra dependency —
   the app currently uses plain Postgres + pg_trgm).
3. **Names**: join Tema Text place-names to lake polygons spatially (name point inside / nearest
   to polygon).
4. **Reduce**: compute **centroid** per polygon (`ST_Centroid` / `ST_PointOnSurface`), area,
   reproject SWEREF99TM→WGS84 (PostGIS `ST_Transform` to 4326, or the existing
   `sweref99ToWgs84` on the centroid). Emit one `lakes` row per lake.
5. **Crosswalk**: match each LM lake to a VISS EU_CD (PIP against VISS centroids, or nearest
   within tolerance), fill `lakes.eu_cd`, store confidence, **log unmatched** (both directions).
6. **Upsert** into `lakes` (idempotent, same pattern as the other ETL).

New script: `pnpm etl:lakes-lantmateriet` (or rename `etl:svar`). VISS import becomes a
**crosswalk-only** step (`etl:viss-crosswalk`) that just supplies EU_CDs, no longer the universe.

## Risks / open questions

- **PostGIS dependency** — new infra. Confirm the deploy target (Hetzner VPS per recent commits)
  can run PostGIS; add to the migration/setup.
- **Download size** — Topografi 50 national GeoPackage is large; the import is an ops job, not a
  quick API pull. Plan disk + runtime.
- **Name↔polygon linkage** — Tema Text names are separate objects; the spatial join is fuzzy at
  the edges (multiple names near one polygon, or none). Needs a tie-break rule + unmatched log.
- **Crosswalk quality** — a VISS EU_CD might match the wrong LM lake if centroids are close;
  store confidence and prefer PIP over nearest-centroid.
- **`lakes.id` change is breaking** — existing conversations reference `lakeId`; the migration
  must map old EU_CD-based ids → new LM ids (or keep EU_CD-keyed rows addressable during
  transition). Sequence carefully.
- **Geotorget access** — needs an account; verify the CC0 tag on the exact product before wiring
  (the fee'd Inspire Hydrografi is a trap).

## Rollout (suggested)

1. Add PostGIS to infra + a migration adding `lakes.eu_cd` / `lakes.source`.
2. Build `etl:lakes-lantmateriet` (staging + ogr2ogr + centroid/reproject + filter) — verify
   against a single län extract before national.
3. Build the VISS crosswalk; measure match rate + confidence distribution.
4. Re-point MVM/NORS joins to `lakes.eu_cd`; re-key existing water/species/depth rows.
5. Swap the seed order (`etl:lakes-lantmateriet` first, then crosswalk, then the SLU sources).
6. Update README/CONTEXT/ADR-0002; write an ADR for the LM-as-universe decision.

## Effort

Meaningfully larger than the API-pull ETLs: new infra (PostGIS), a bulk GeoPackage pipeline
(ogr2ogr), a spatial name-join, a crosswalk with confidence, and a breaking `lakes.id`
migration. Treat as its own milestone, not a follow-up patch.
