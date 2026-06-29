# Task 4.3 Report: Species Comfort Rules

## Files changed

- `src/lib/signals/species-comfort.ts` — implementation (created)
- `src/lib/signals/species-comfort.test.ts` — 23 tests (created)

---

## Rules table, thresholds, and rationale

All thresholds are approximate fishing heuristics, not precise biology (±1–2°C should be treated as equivalent). v1 uses water temperature only; season is not modelled (future work).

| Species (Swedish) | Common name | Sluggish condition | Rationale |
|---|---|---|---|
| gädda | pike | waterTempC > 21 | Cold-water ambush predator, optimal ~10–18°C. Holds deep / lethargic in summer heat. Source: SLU Aqua thermal tolerance data; "Fiskeboken". |
| abborre | perch | waterTempC > 24 | More eurythermal than pike, active into mid-20s. Noticeably sluggish above ~24°C. Source: Nordic fishing literature. |
| gös | zander / pikeperch | waterTempC > 26 OR < 6 | Warm-water tolerant, thrives ~16–24°C. Sluggish in very cold water (pre-spawn coma < 6°C) and extreme heat (> 26°C). Source: SLU Aqua; IGFA records. |
| öring | brown trout | waterTempC > 18 | Obligate cold-water salmonid, optimal ~8–16°C. Stress / lethargy above ~18°C; mortality risk above 22°C. Source: Hyvärinen & Vehanen (2004); Naturvårdsverket. |
| lax | Atlantic salmon | waterTempC > 18 | Same cold-water salmonid family as öring, very similar thermal preference. Source: ICES salmon temperature guidance. |
| mört | roach | waterTempC > 28 | Hardy cyprinid, broadly eurythermal (4–28°C active). Only sluggish in extreme summer heat. Source: FishBase; Swedish freshwater fishing notes. |
| braxen | bream | waterTempC > 28 | Another robust cyprinid, similar thermal range to mört. Source: FishBase. |

---

## Unknown-species handling

**Unknown species are omitted from the result.** Only species with a documented rule emit a flag. This is intentional: surfacing a guess ("comfortable" by default) for a species we have no data on could mislead the LLM. Absence of a key is unambiguous — the LLM receives no signal for that species, which is safer than a fabricated default.

---

## Boundary inclusivity

All thresholds are **exclusive** (strict greater-than / strict less-than):

- Upper heat threshold: `> N` is sluggish; `= N` is comfortable.
- Lower cold threshold (gös only): `< N` is sluggish; `= N` is comfortable.

This matches how fishing heuristics are typically stated ("above approximately X°C"). The test covers the exact boundary for gädda (21°C → comfortable, 21.1°C → sluggish).

---

## TDD evidence

### RED

```
FAIL  src/lib/signals/species-comfort.test.ts
Error: Failed to resolve import "./species-comfort" — file did not exist yet.
0 tests run.
```

### GREEN

```
Test Files  1 passed (1)
Tests       23 passed (23)
Duration    669ms
```

All 23 tests pass.

---

## ts:check

```
> tsgo --noEmit
(no output — clean)
```

**Result: clean, zero errors.**

---

## Biome

Pre-commit hook (lefthook → biome) ran on the 2 staged files:

```
Checked 2 files in 7ms. No fixes applied.
✔️ biome (0.24 seconds)
```

**Result: clean on both new files.**

Note: `pnpm biome` on the full repo reports 3 pre-existing warnings in `src/lib/signals/types.test.ts` (`isFinite` → `Number.isFinite`). These are not in my files and were present before this task.

---

## Self-review

- Pure function, no side effects, deterministic.
- `Number.isFinite` guard on `waterTempC` — returns `{}` for non-finite input (NaN/Infinity).
- Rules table is small and focused — 7 species, YAGNI.
- Each rule is a single-line arrow function; easy to audit and extend.
- Swedish names match what the species ETL stores (as specified).
- Thresholds and rationale are commented inline in the source file.
- Test covers every species in the table for both comfortable and sluggish, boundary case (gädda at 21°C), unknown species omission, empty input, and a multi-species call.

## Concerns

None significant. One minor note: öring and lax share identical threshold (> 18°C). They are deliberately kept as separate entries because they may diverge in future (seasonal rules, e.g. running salmon vs lake trout), and explicit rules are easier to audit than shared references. If they stay identical long-term, consider deduplicating.

---

## Commit

`0783154 feat: add species comfort rules for Swedish lake fish`
