# Static sources are pre-imported; only the forecast is fetched live

Every slow, static, or awkwardly-accessed data source is **pre-imported into Postgres by seed
jobs**, not called at request time:

- **SVAR** lake register (all water bodies) → `lakes` table, trigram typeahead.
- **metobs** station lists (pressure, temp) → seeded; nearest found by haversine, lake→station mapping cached.
- **S-HYPE** modeled water temp → optional override import keyed by sub-catchment.
- **Depth** → max/mean scalars per lake where available.
- **SLU Miljödata-MVM** (water colour / sight depth) and **SLU Aqua** (species) → seeded, keyed by
  SVAR lake id, with the coordinate→station match resolved **at import time** (inside polygon or
  ≤200 m of centroid, else kept but flagged low-confidence).

Only **SMHI snow1g forecast** is fetched live at request time, cached as a whole timeSeries
document per lake for ~1h. Past-time questions are filled from metobs actuals.

**Why:** these sources change slowly (chemistry/species seasonally, station rosters rarely),
several have no clean point API (S-HYPE exports, MVM ticket auth, depth rasters), and the
lake-join is fuzzy and expensive — doing it once at import beats running it hot on every ask.
Pre-importing keeps the request path fast, avoids runtime auth dependencies (the MVM ticket
never touches the ask path), and lets every Signal carry **Provenance** (source + confidence)
so the LLM hedges on estimated or low-confidence values and degrades gracefully when a source is
absent. The cost is a seed-job subsystem and periodic re-imports, accepted deliberately.
