# Changelog

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
