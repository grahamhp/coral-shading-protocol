# Validation

All numbers on this page are generated from `shared/validation/engine_vs_mc.json` and the test suites.

## 1. The browser app and the Python package give the same results

The Python package is the reference. `python -m coralshading.golden` writes test values to `shared/golden/`
(sun positions, refraction and waves, the light engine on single instants and on a full Sipaway day with two
panels including a rotated cloth and a floating panel in wind, and the whole scenario layer on the Sipaway
typical year: cloth size, period light, the canopy solve, direct-sun hours, the clearance check, robustness and
coral metrics). The TypeScript tests reproduce every value to a relative 10⁻⁹. Both suites run on every push
(`.github/workflows/tests.yml`).

## 2. Light engine against the 3-D Monte Carlo

The app's fast engine uses tables made once with a forward Monte Carlo (see the methods). It is checked against
an independent 3-D backward Monte Carlo that traces light through the water around the actual structure
(`coralshading.mc.backward_point`, 200,000 paths per point). Both use the same water optical depth, so the
comparison isolates the engine's approximations. Cases: three sun positions (noon, zenith 9.8°; low sun from
the east-north-east, zenith 50°; afternoon sun from the west, zenith 35°), six points (center; 0.55 m east,
west, north and south; 1.2 m east), flat sea, 70 % direct and 30 % diffuse light.

Values are transmissions (light at the point under the structure ÷ open water at the same depth). Error =
fast engine − Monte Carlo.

| Structure | Water | Points | Mean error | Range | Monte Carlo SE |
|---|---|---|---|---|---|
| opaque canopy, 0.75 m | Kd 0.06, ω₀ 0.70, 10 m | 18 | +0.003 | -0.004 to +0.012 | 0.002 |
| opaque canopy, 0.75 m | Kd 0.21, ω₀ 0.50, 10 m | 18 | +0.004 | -0.004 to +0.019 | 0.002 |
| opaque canopy, 0.75 m | Kd 0.21, ω₀ 0.70, 10 m | 18 | +0.006 | -0.009 to +0.012 | 0.002 |
| opaque canopy, 0.75 m | Kd 0.21, ω₀ 0.85, 10 m | 18 | +0.011 | -0.006 to +0.020 | 0.003 |
| opaque canopy, 0.75 m | Kd 0.40, ω₀ 0.70, 5 m | 18 | +0.008 | -0.016 to +0.022 | 0.002 |
| opaque canopy, 2.0 m | Kd 0.21, ω₀ 0.70, 10 m | 18 | +0.013 | -0.017 to +0.037 | 0.004 |
| shade cloth τ 0.21, 0.75 m | Kd 0.21, ω₀ 0.70, 10 m | 18 | +0.005 | +0.002 to +0.009 | 0.002 |

Across all 126 points the mean error is +0.007. In the shade (Monte Carlo transmission
below 0.3; 89 points) it is +0.008 on average (8 % of the shade
value), at most +0.030.

**Reading.** For structures 0.75 m above the corals the engine is within −0.016 to +0.022 of open-water light.
For a canopy 2 m up it over-predicts light in the shade by up to 0.037: it treats the water beneath the panel as
if it were sunlit, so it misses the weaker forward-scattered light around the panel's shadow. The error is
one-sided (designs come out slightly over-shaded) and smaller than the uncertainty from water scattering
(ω₀; see the methods). The app warns for structures above 1.5 m; `DesignResult.mc_check()` checks a design.

The tests enforce −0.02 − 2 SE ≤ error ≤ +0.04 + 2 SE for every point (`python/tests/test_engine.py`).

## 3. Other checks

- Water clarity: the tables reproduce the requested Kd (open water at depth ÷ just below the surface =
  e^(−Kd·z) at the reference sun) within 1 % in the six tested combinations: Kd 0.05, 0.10, 0.21 (ω₀ 0.5
  and 0.9), 0.40 at 15 m and 0.60 at 20 m (Kd × depth up to 12, inside the extrapolated range).
- Open water: with no structure the engine returns exactly the open-water light; a very large opaque panel
  returns zero; a very large cloth returns its rated transmission (±0.002).
- Light tables: no missing values; light decreases with depth for every sun angle; the direct part plus the
  scattered parts add up to the total within 5 × 10⁻⁵; at depth the decay rate converges to one value per ω₀
  for every sun angle, as radiative-transfer theory requires.
- PVGIS: a fresh download for Sipaway is identical to the stored file; PVGIS time stamps are mid-hour UTC.
- Field data (Sipaway, May 2025): see `docs/methods_paper_groundwork.md`.
