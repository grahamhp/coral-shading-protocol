# Validation

All numbers on this page are generated from `shared/validation/engine_vs_mc.json` and the test suites.

## 1. The browser app and the Python package give the same results

The Python package is the reference. `python -m coralshading.golden` writes test values to `shared/golden/`
(sun positions, refraction and waves, the light engine on single instants and on a full example-site day with
two panels including a rotated cloth and a floating panel in wind, and the whole scenario layer on the example
typical year, including Kd by date, a tide that brings a panel to the surface, fouling, acclimation over time and
the ω₀ calibration: cloth size, period light, the canopy solve, direct-sun hours, the clearance check, robustness and
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
| opaque canopy, 0.75 m | Kd 0.21, ω₀ 0.30, 10 m | 18 | +0.002 | -0.001 to +0.012 | 0.001 |
| opaque canopy, 0.75 m | Kd 0.21, ω₀ 0.40, 10 m | 18 | +0.002 | -0.004 to +0.014 | 0.001 |
| opaque canopy, 0.75 m | Kd 0.21, ω₀ 0.50, 10 m | 18 | +0.004 | -0.004 to +0.019 | 0.002 |
| opaque canopy, 0.75 m | Kd 0.21, ω₀ 0.70, 10 m | 18 | +0.006 | -0.009 to +0.012 | 0.002 |
| opaque canopy, 0.75 m | Kd 0.21, ω₀ 0.85, 10 m | 18 | +0.011 | -0.006 to +0.020 | 0.003 |
| opaque canopy, 0.75 m | Kd 0.21, ω₀ 0.95, 10 m | 18 | +0.003 | -0.029 to +0.015 | 0.005 |
| opaque canopy, 0.75 m | Kd 0.40, ω₀ 0.70, 5 m | 18 | +0.008 | -0.016 to +0.022 | 0.002 |
| opaque canopy, 2.0 m | Kd 0.21, ω₀ 0.70, 10 m | 18 | +0.013 | -0.017 to +0.037 | 0.004 |
| shade cloth τ 0.21, 0.75 m | Kd 0.21, ω₀ 0.70, 10 m | 18 | +0.005 | +0.002 to +0.009 | 0.002 |

Across all 180 points the mean error is +0.006. In the shade (Monte Carlo transmission
below 0.3; 131 points) it is +0.006 on average (7 % of the shade value), at most +0.030. The ω₀ 0.3, 0.4 and 0.95
rows were added in v5.1 with the extended tables (same method, seeds and number of paths).

**Reading.** For structures 0.75 m above the corals the engine is within −0.016 to +0.022 of open-water light
for ω₀ 0.3–0.85; at ω₀ 0.95 one point in open light 1.2 m east of the canopy (low sun) comes out 0.029 low, within
four Monte Carlo standard errors (0.008) of the reference; the shaded points there are within −0.003 to +0.015.
For a canopy 2 m up it over-predicts light in the shade by up to 0.037: it treats the water beneath the panel as
if it were sunlit, so it misses the weaker forward-scattered light around the panel's shadow. The error is
one-sided (designs come out slightly over-shaded) and smaller than the uncertainty from water scattering
(ω₀; see the methods). The app warns for structures above 1.5 m; `DesignResult.mc_check()` checks a design.

The tests enforce −0.02 − 2 SE ≤ error ≤ +0.04 + 2 SE for every point (`python/tests/test_engine.py`).

## 3. Other checks

- Water clarity: the tables reproduce the requested Kd (open water at depth ÷ just below the surface =
  e^(−Kd·z) at the reference sun) within 1 % in the twelve tested combinations: Kd 0.05, 0.10, 0.21 (ω₀ 0.3,
  0.4, 0.5, 0.9, 0.95), 0.06 (ω₀ 0.95), 0.40 at 15 m (ω₀ 0.3, 0.7, 0.95) and 0.60 at 20 m (Kd × depth up to 12;
  at ω₀ 0.95 and Kd 0.40 at 15 m the optical depth, 54, is inside the extrapolated range).
- Open water: with no structure the engine returns exactly the open-water light; a very large opaque panel
  returns zero; a very large cloth returns its rated transmission (±0.002).
- Light tables: no missing values; light decreases with depth for every sun angle; the direct part plus the
  scattered parts add up to the total within 5 × 10⁻⁵; at depth the decay rate converges to one value per ω₀
  for every sun angle, as radiative-transfer theory requires. Light increases with ω₀ in all 1890 sun cells but
  one: at ω₀ 0.4, sun zenith 80° and optical depth 22 (2.9 × 10⁻⁷ of the light below the surface, far deeper
  than corals live) Monte Carlo noise leaves it 24 % above the ω₀ 0.5 value. Two split-transport runs at the
  new ω₀ values were redone with 1,000,000 photons for this reason (build_tables.SPLIT_PHOTONS_OVERRIDE).
- PVGIS: a fresh download for Sipaway is identical to the stored file; PVGIS time stamps are mid-hour UTC.
- Field data (Sipaway, May 2025): see `docs/methods_paper_groundwork.md`.

## 4. Days through the deployment (v5.2)

The cases in section 2 are single sun positions. To check that nothing drifts as the season moves on, the example
design (the app's starting values until 22 Nov 2026: Sipaway, Reef Star at 10 m, Kd 0.10, ω₀ 0.7, 80 % cloth 2.68 × 1.71 m and the canopy solved to
match it, 1.28 × 1.36 m, both 0.75 m up) was followed through the deployment: five days from 28 April to 8 August,
at 08:05, 10:05, 12:05, 14:05 and 16:05, each with that day's own sun position and direct and diffuse light
(typical-year weather, from 22 % direct on 21 June to 86 % on 28 April), at four points (center; 0.45 m east,
west and north). Fast engine against the 3-D backward Monte Carlo, 200,000 paths per point, flat sea
(`python/examples/validate_days.py`; `shared/validation/engine_vs_mc_days.json`).

| Day | Points | Mean error | Range |
|---|---|---|---|
| 28 April | 40 | +0.005 | -0.017 to +0.029 |
| 18 May | 40 | +0.005 | -0.011 to +0.027 |
| 21 June | 40 | +0.005 | -0.002 to +0.014 |
| 24 July | 40 | +0.005 | -0.021 to +0.031 |
| 8 August | 40 | +0.005 | -0.018 to +0.033 |

All 200 points: mean +0.005 of open-water light (Monte Carlo standard error 0.002); cloth +0.004 (−0.001 to
+0.017), canopy +0.006 (−0.021 to +0.033). The largest errors are at the north edge under the canopy with a low
morning sun (the engine is 0.03 too bright). Open-water light itself: engine ÷ Monte Carlo 0.990 (0.979–1.004).
No trend with the date: the same small bias on every day, inside the limits of section 2.

**The starting design (22 Nov 2026).** The app now starts from a 50 % cloth and corals at 5 m. For that design at
the example site (cloth 2.68 × 1.71 m; matched canopy 0.65 × 1.35 m; Kd 0.10, ω₀ 0.7), `mc_check()` on 28 April
at 3 h before noon, noon and 3 h after, at the center and the east and west edges (18 points, 200,000 paths each):
engine − Monte Carlo = +0.005 on average, from −0.005 to +0.013 of open-water light, inside the range of
section 2. *(shared/validation/mc_starting_design.json)*

## 5. Light data: sources and timing (v5.2)

**Which moment does a value describe?** On cloud-free days the light is symmetric about solar noon, so the centre
of mass of the hourly values shows where they sit in time. With each value placed at its time stamp, the centre of
mass fell 24–28 minutes before solar noon in eight PVGIS-ERA5 typical years (values centred half an hour after the
stamp, as the files state), 9.5 minutes before in the PVGIS-SARAH3 typical year for Eilat (stated offset 9.2
minutes), and 29–34 minutes after solar noon in six Open-Meteo ERA5 series (values are means of the hour before the
stamp). The app places each value accordingly (methods, section 2). In v5.1 the SARAH-3 values were placed 39
minutes early.

**Is ERA5 from Open-Meteo as good as PVGIS?** Hourly global irradiance, 2014–2023, same hours
(`shared/validation/light_sources.json`):

| Site | PVGIS database | Hourly correlation | Mean difference | Diffuse share (PVGIS / Open-Meteo) |
|---|---|---|---|---|
| Sipaway, Philippines | ERA5 | 0.993 | +2.8 % | 0.34 / 0.33 |
| Florida Keys | ERA5 | 0.996 | −0.2 % | 0.26 / 0.27 |
| Lizard Island, Australia | ERA5 | 0.993 | +2.3 % | 0.29 / 0.28 |
| Moorea | ERA5 | 0.999 | +0.7 % | 0.27 / 0.27 |
| Eilat, Red Sea | SARAH-3 | daily 0.97 | +2.2 % | |
| Mombasa, Kenya | SARAH-3 | daily 0.74 | −6.7 % | |

Where PVGIS uses ERA5, the two are the same data to within the choice of grid cell (PVGIS also sets the hour of
sunrise to zero when the sun is below the horizon at the start of the hour, which accounts for part of the small
positive difference). Where PVGIS uses the SARAH-3 satellite record, the reanalysis follows day-to-day cloud less
well (Mombasa) and a PVGIS file is the better choice. Light under a structure as a share of open water barely
depends on the weather data (real years 2014–2023 changed it by at most 0.11 percentage points at Sipaway);
absolute daily light and the coral metrics do.

