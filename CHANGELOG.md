# Changelog

## 5.1.0 (not yet released)

From a scientific review of v5.0.0 (19 Nov 2026). Designs are unchanged except where noted.

**Water scattering (ω₀), for any site**

- **Default ω₀ 0.7 with a range on every result.** v5.0 defaulted to 0.9, fitted to one site's canopy readings.
  ω₀ is rarely measured and published values span most of its range (Petzold's waters 0.25–0.83; 0.1–0.9 from
  absorption- to scattering-dominated water), so the design value is now 0.7, the middle of 0.5–0.9, and every
  result is also computed at both ends with the same structure ("likely between … and …"). This changes designs:
  with less scattering the shade is darker, so a canopy matched to a cloth is narrower and the light reaching the
  corals is lower than at 0.9.
- **ω₀ from a field reading.** The ratio of light under an opaque board to open water at the same depth, with
  the board size and height, date, time and diffuse share, gives the ω₀ that reproduces it (bisection; the ratio
  rises monotonically with ω₀), and its uncertainty gives the range. App: Expert → Water scattering from a field
  reading. Python: `scenarios.w0_from_reading`; CLI `--w0-reading`, `--reading-time`, `--reading-diffuse`,
  `--reading-err`. Field protocol section 1b.
- **Light tables extended to ω₀ 0.3, 0.4 and 0.95** (same Monte Carlo settings), so readings from clearer or
  more strongly scattering water can be fitted.
- **Water presets** are published reef values only (clear 0.06, moderate 0.10, turbid inshore 0.45 m⁻¹); the
  example site's own Kd is no longer a preset. Help texts no longer rely on one site.

**Conditions that change through a deployment**

- **Kd by date** (own readings or satellite products), interpolated day by day.
- **Tide**: a water-level series sets the coral depth at every 10-minute step; the depth entered is the depth at
  mean water level. A structure that reaches the surface at low tide is handled exactly.
- **Cloth fouling over time** replaces the fixed share of time fouled in the app: transmission falls linearly from
  clean to fully fouled over a set number of days after each cleaning (start date, every n days, extra dates).
  Exact and no slower (light is linear in one panel's transmission). Python keeps the fixed share as well.
- **Coral acclimation over time** (new default): Ek starts adjusted to open water at the coral depth and moves
  each day toward the light under the structure with a 2.5-day time constant (Anthony & Hoegh-Guldberg 2003: new
  stable Ek within 5–10 days).
- Exports add `kd_m1`, `depth_at_noon_m` (with a tide) and `cloth_transmission` (with fouling) per day.

**Sky light**

- **Circumsolar light.** Part of the diffuse light now travels with the sun, by the hourly anisotropy index of
  Hay & Davies (1980). In the example (Kd 0.10, ω₀ 0.7, 10 m) open-water daily light rises 1.3 %, light under the
  80 % cloth falls from 25.4 to 25.0 % of open water, and the matching canopy is 2 cm narrower.

**App**

- Fixed a slowdown: after a few design runs V8 deoptimized the inner light loops (objects of several shapes reached
  them) and the robustness stage took about 30 s instead of 3 s. Panels are now copied into one fixed shape first.
- `npm test` runs the same command as CI.

- **Every day, everywhere.** The canopy solver and the robustness table use every day of the deployment (v5.0
  used about 20 and 12 days). The canopy is solved on the reported grid, so the separate correction step is gone.
  At Sipaway the canopy width changes by 1.6 mm and the robustness values by at most 0.08 percentage points. Cost:
  the full Python design takes about 3 minutes instead of 1; in the app the full result takes about 5 s and the
  robustness table about 4 s more. The app's quick preview still uses every tenth day and says so.
- **Clearance rule on the most demanding day.** The canopy height that lets the morning sun reach the whole coral
  area is now computed for every day and the largest is shown, with its date (Sipaway: 2.74 m around the June
  solstice; v5.0 showed 2.56 m for the first day).
- **Light at noon and in the morning and afternoon** for each design, and the share of the light at depth that
  arrives as the sun beam. A CHECK appears when dynamic shading's noon light is more than 0.8 of its morning and
  afternoon light. At Sipaway (Kd 0.21, 10 m, ω₀ 0.9) the beam carries 0.7 % of the light and the canopy designed
  to match an 80 % cloth gives 32 % of open-water light at noon and 36 % in the morning and afternoon, against the
  cloth's 33 % and 35 %: dynamic shading barely differs from constant shading there.
- **"Direct sun" renamed "sun in line".** These hours are geometry only (clouds and scattering are not counted).
  CSV columns `*_direct_sun_h` are now `*_sun_in_line_h`.
- **Assumptions stated on daily values.** Exports (app and Python) start with a line giving the version, site,
  dates, light data and the assumptions: one Kd on every day, a fixed depth (no tide), and, for the typical year,
  that each date is one typical-year day, not that year's weather. `days.csv` has a `weather` column. The app's
  day view says the same.
- Python: `DesignResult.beam_share`, `ScenarioResult.contrast`, `scenarios.noon_contrast`, `contrast_warning`,
  `PeriodResult.beam_share()`; `clearance_check` returns `h_rule_day`; `solve_dynamic` and `robustness` default
  to every day. TypeScript: the same (`beamShare`, `noonContrast`, `contrastWarning`, `hRuleDay`). Golden values
  extended; both test suites check them to 10⁻⁹.
- `python/examples/methods_paper_analyses.py` is unchanged and still solves on every tenth day; it reproduces the
  methods-paper groundwork figures as made.

## 5.0.0 (2026-11-13)

Rebuilt on radiative transfer. Compared with v4.2:

- **Light under water.** Direct and diffuse light are no longer attenuated vertically with one Kd. Light in the
  water comes from Monte Carlo tables (Fournier–Forand scattering) for the site's Kd and scattering (ω₀), so
  light arriving from the side under a structure is included. Checked against a 3-D Monte Carlo of the actual
  structure (docs/validation.md).
- **Surface light.** PVGIS hourly global and diffuse irradiance (typical year or real years) replaces the
  diffuse-share slider; PAR conversion after Spitters et al. (1986) and McCree (1972).
- **Refraction and waves.** Sunlight is refracted at the surface (Snell, Fresnel), and waves spread it
  (Cox and Munk wave slopes from the wind in the light data).
- **Every point, every 10 minutes.** Light is computed over the coral area as a map, not at one point.
- **Designs.** The cloth is sized so the sun reaches the corals only through it; the canopy's east–west width
  is solved to match the cloth's daily light or a set reduction. Infeasible targets give a reason instead of a
  12-hour window.
- **Corals.** Photosynthesis–irradiance presets from published curves, with photoacclimation; expected
  photosynthesis, hours above saturation and P:R.
- **Checks.** Clearance warning (points that never get direct sun) and robustness to Kd, ω₀, wind and
  position.
- **Two products, one set of calculations.** Browser app (one file, works offline) and Python package; the
  test suites require identical results.
- Simple and expert modes; map and coordinates; sourced popups; CSV and JSON export.
- **Light data belong to the site.** Light data more than 50 km away are not used: the app uses a clear-sky
  estimate until PVGIS data for the site are loaded (and flags it); the UTC offset follows the longitude; a
  timing guard stops mismatched hours from turning into spikes. Fixes the spiky day curves away from Sipaway.
- **PVGIS cache (Python, Windows)** no longer corrupts downloads; truncated files are refused.
- **Default water scattering ω₀ = 0.9**, which fits the Sipaway canopy readings (0.85–0.9); set 0.5–0.9 in expert
  mode.

## 4.2

Last version before v5 (commit f3c2957a). The app stays available at
https://grahamhp.github.io/coral-shading-protocol/v4.2/.

## 3.2

Earlier public version (commit 3b45b53c).

## 1.0

Sized the opaque canopy in the Sipaway shading experiment. Its files were lost in a hardware failure.
