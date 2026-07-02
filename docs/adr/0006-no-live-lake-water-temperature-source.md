# ADR-0006: No live lake water-temperature source — estimate is authoritative

Date: 2026-07-02
Status: Accepted
Supersedes the S-HYPE portion of [ADR-0002](0002-static-sources-pre-imported-only-forecast-live.md).

## Context

ADR-0002 listed **S-HYPE modeled water temperature** as an optional import that would
override the code-computed estimate with a high-confidence "modeled" value. A
2026-07-02 investigation established that this is not achievable honestly, for two
independent reasons.

### 1. Water temperature is a *current* condition, but the store is a snapshot

`water_temp` keyed by `lakeId` (PK) holds **one** `tempC` per lake. A one-time seed
freezes a single day's value and `waterTempFor()` would keep returning it tagged
`confidence: "high"` indefinitely — a week-old temperature presented as authoritative.
That is worse than the season-based estimate, which is always current and honestly
low-confidence. A correct modeled integration would need either a **daily re-seed** or
a **fetch-per-request** path (like `getForecast`), not a static import.

### 2. There is no live API for lake water temperature

Every avenue was checked:

- **SMHI HydroObs API** (`opendata-download-hydroobs.smhi.se`): 10 parameters. The only
  temperature one is **`4` Vattendragstemperatur** — *watercourse/river* temp, not lake,
  and its 176 stations are **all inactive, latest data 2003-05-04**. The `SE.ACMF
  Hydrologiska observationer – Vattendragstemperatur` product was retired in 2025.
  The other HydroObs parameters are discharge / water level / water content — no
  temperature.
- **SMHI metobs API** (already used for air temp/pressure/wind): no water-temperature
  parameter.
- **S-HYPE** (Vattenwebb `modelarea` / `nadia`): *does* have current + forecast daily
  lake water temperature, but it is published **only as manual per-SUBID Excel/CSV
  downloads — there is no open API**. SMHI staff confirmed the only API-available
  hydrology product is discharge, not temperature. Ingesting it would require a brittle
  automated Excel scrape plus a SUBID→EU_CD crosswalk plus a CSV parser, re-run daily.

## Decision

**The code-computed estimate is the sole and authoritative water-temperature source.**
`estimateWaterTemp()` (season baseline + 5-day air-temp-trend nudge + lake-size
responsiveness, clamped 0–30 °C) returns `source: "estimated", confidence: "low"` so the
LLM hedges. It is not a placeholder awaiting a better source — given the data landscape,
it is the correct design.

The S-HYPE ETL stub, the `water_temp` table, and the "modeled" override path in
`waterTempFor()` / `chooseWaterTemp()` are removed. If a genuinely current source ever
appears (an S-HYPE API, or an operator willing to automate a daily Excel re-seed), it
should be added as a **fetch-per-request or daily-refreshed** source with a staleness
check — not a one-time static import.

## Consequences

- Water temperature always reflects the requested time (season/trend), never stale.
- One less data source to seed/operate; `pnpm etl:shype` and its config are gone.
- No high-confidence water temp anywhere — every water-temp Signal is `estimated`/`low`,
  which the persona already hedges on.
- Re-investigating "why isn't there modeled water temp" is pre-empted: this ADR records
  that it was checked and no live lake-temp API exists.
