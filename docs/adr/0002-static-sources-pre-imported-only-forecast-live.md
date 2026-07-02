# Static sources are pre-imported; only the forecast is fetched live

Every slow, static, or awkwardly-accessed data source is **pre-imported into Postgres by seed
jobs**, not called at request time:

- **SVAR** lake register → `lakes` table, trigram typeahead. **[CORRECTION]** The original
  wording ("all water bodies") overstated coverage: the actual source is the **VISS API**
  (`waters&watercategory=LW`), which returns **~7,250 WFD-classified lake water bodies** (7,267
  returned; 7,252 with a mappable LatLong centroid) — *not* all of Sweden's ~100,000 lakes.
  Small tarns are absent. Full ~100k coverage via Lantmäteriet Topografi (CC0) is planned as
  future work (separate spec).
- **metobs** station lists (pressure, temp) → seeded; nearest found by haversine, lake→station mapping cached.
- **S-HYPE** modeled water temp → optional override import keyed by sub-catchment.
  **[SUPERSEDED by [ADR-0006](0006-no-live-lake-water-temperature-source.md).]** No live lake
  water-temperature API exists, so S-HYPE was removed; water temp is now the code-computed estimate
  (`estimated`/`low`) only, with no ETL.
- **Depth** → max/mean scalars per lake where available.
- **SLU Miljödata-MVM** (water colour / sight depth) and **SLU Aqua** (species) → seeded, keyed by
  SVAR lake id, with the coordinate→station match resolved **at import time** (inside polygon or
  ≤200 m of centroid, else kept but flagged low-confidence).

Only **SMHI snow1g forecast** is fetched live at request time, cached as a whole timeSeries
document per lake for ~1h. Past-time questions are filled from metobs actuals.

**Why:** these sources change slowly (chemistry/species seasonally, station rosters rarely),
several have no clean point API (MVM ticket auth, depth rasters — the S-HYPE example here is
**superseded by [ADR-0006](0006-no-live-lake-water-temperature-source.md)**: water temp has no live
source at all and is now the code estimate, not an import), and the coordinate-fallback lake-join
is expensive — doing it once at import beats running it hot on every ask. **[CLARIFICATION]** All
three SLU sources actually carry the canonical **EU_CD** (VISS WFD code, = `lakes.id`) directly, so
the common case is a **direct O(1) join** (MVM `stationEUID`; NORS/Aqua `eU_CD`, ~94% of aqua rows).
Only the minority of rows with a blank EU_CD fall back to a haversine coordinate match (≤200 m
centroid = high confidence, ≤ equal-area radius = low), reprojecting SWEREF99TM→WGS84. Match
confidence is stored per row.
Pre-importing keeps the request path fast, avoids runtime auth dependencies (the MVM ticket
never touches the ask path), and lets every Signal carry **Provenance** (source + confidence)
so the LLM hedges on estimated or low-confidence values and degrades gracefully when a source is
absent. The cost is a seed-job subsystem and periodic re-imports, accepted deliberately.
