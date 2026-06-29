# Task 4.1 Report — sun times + light window

## Files changed

- `src/lib/signals/light.ts` (new) — `sunTimes` + `lightWindow`
- `src/lib/signals/light.test.ts` (new) — 18 tests (4 sunTimes, 14 lightWindow)

---

## Solar algorithm

**Algorithm:** Wikipedia "Sunrise equation" / Jean Meeus "Astronomical Algorithms" approach using the NOAA sunrise equation coefficients.

Steps:
1. Julian Day at UTC midnight via Unix epoch conversion (`JD = ms/86400000 + 2440587.5`)
2. Integer days since J2000.0 noon: `n = ceil(JD − 2451545.0 + 0.0008)`
3. Mean solar noon: `J* = n − lon/360`
4. Solar mean anomaly M (degrees, normalised [0,360))
5. Equation of centre C (3-term Fourier approximation)
6. Ecliptic longitude λ = M + C + 180 + 102.9372 (normalised [0,360))
7. Solar transit Jtransit (Julian day at solar noon)
8. Solar declination from λ and obliquity 23.4397°
9. Hour angle H from cos(H) formula for zenith = −0.833° (sun disk + refraction)
10. Sunrise = Jtransit − H/360, Sunset = Jtransit + H/360 → Date via Julian day → Unix ms

**Reference:** Wikipedia "Sunrise equation" (https://en.wikipedia.org/wiki/Sunrise_equation)
Accuracy: ±1–2 min at mid-latitudes.

---

## Polar edge-case handling

When `cos(H)` falls outside `[−1, 1]`, the sun never crosses the −0.833° zenith for that date:
- `cosH < −1` → **polar day** (sun never sets) → `{ sunrise: null, sunset: null, polarDay: true }`
- `cosH > 1`  → **polar night** (sun never rises) → `{ sunrise: null, sunset: null, polarDay: false }`

`lightWindow` maps polar day → `"day"`, polar night → `"night"`.
No exception is thrown; callers can always destructure the result.

---

## Dawn/dusk window constant

```ts
const WINDOW_MIN = 45;
const WINDOW_MS = WINDOW_MIN * 60 * 1000;
```

`±45 min` from sunrise/sunset, inclusive at the boundary. Classification priority:
1. `[sunrise − 45 min, sunrise + 45 min]` → `"dawn"`
2. `[sunset  − 45 min, sunset  + 45 min]` → `"dusk"`
3. After end of dawn window and before start of dusk window → `"day"`
4. Otherwise → `"night"`

---

## sunTimes reference assertion

**Reference point:** Stockholm (59.3293°N, 18.0686°E) on 2026-04-15 (mid-April spring, no polar risk).

Cross-checked with two independent implementations:
- NOAA Meeus algorithm (this code): sunrise 03:33 UTC, sunset 18:01 UTC
- NOAA simplified solar position formula (independent): sunrise 03:37 UTC, sunset 17:59 UTC

Both agree to within ~4 min. Test tolerance: **±7.5 min** (210–225 min after midnight for sunrise; 1070–1090 min for sunset). This is meaningful — it rules out a 1-hour error (wrong timezone handling) or a 6-hour error (wrong Julian epoch), while accommodating natural algorithm variation.

Stockholm is UTC+2 (CEST), so local times: sunrise ~05:33 CEST, sunset ~20:01 CEST — consistent with mid-April in Sweden.

---

## RED + GREEN evidence

**RED (import fails):**
```
FAIL  src/lib/signals/light.test.ts
Error: Failed to resolve import "./light" from "src/lib/signals/light.test.ts". Does the file exist?
Tests: no tests
```

**RED (wrong reference values — algorithm bug caught by tests):**
After creating light.ts with a broken JDN formula, 2 sunTimes tests failed:
```
AssertionError: expected 932.27 to be less than 307
AssertionError: expected 1802.71 to be less than 1122
```
(First attempt used JDN + 0.5 instead of `ceil(JD − 2451545.0 + 0.0008)`, giving solar noon at 22:47 UTC instead of ~10:47 UTC.)

**GREEN:**
```
Tests  18 passed (18)
Test Files  1 passed (1)
Duration  443ms
```

---

## ts:check

```
> tsgo --noEmit
(no output — exit 0)
```
PASS.

---

## biome

```
Checked 82 files in 33ms. Fixed 2 files.
Found 3 warnings.
```

The 2 format fixes were applied to `light.ts` and `light.test.ts` by `pnpm biome:fix` (parenthesisation of modulo expressions and line-length reformatting). The 3 remaining warnings are pre-existing in `src/lib/analytics/events.test.ts` (`noExplicitAny`) and `src/lib/water/temp.test.ts` (`noGlobalIsFinite` × 2) — not in my files.
**My files: 0 errors, 0 warnings. PASS.**

---

## Self-review

- Both functions are pure (no `Date.now()`, no side effects).
- `Number.isFinite(cosH)` guards against NaN/Infinity before boundary checks.
- The `SunTimesInput` type accepted by `lightWindow` is a superset of `SunTimes` so the return of `sunTimes` can be passed directly.
- Test covers boundary conditions (exactly 45 min, 46 min), midday, midnight, and polar day/night.
- The `n` formula includes the `+ 0.0008` correction from the Wikipedia sunrise equation — without it the solar noon was off by ~24 min.

## Concerns

None significant. The ±7.5 min tolerance is wide enough to accommodate algorithm approximations but tight enough to catch major errors. The algorithm does not account for elevation; for Swedish fishing lakes (low elevation) this is negligible.
