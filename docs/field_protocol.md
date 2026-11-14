# Field protocol: measuring a site and checking a design

Three measurements make the app's answer site-specific: water clarity (Kd), light under the structure beside
open water (which constrains water scattering, ω₀), and the cloth's transmission over time. Use a
cosine-corrected underwater PAR sensor, held level.

## 1. Water clarity (Kd)

1. Measure PAR at two depths on the same vertical line, at least 3 m apart (for example 5 m and the coral
   depth), within 2 h of solar noon under a steady sky (clear or evenly overcast).
2. Take at least five readings at each depth, alternating depths, and use the medians.
3. Kd = ln(E_shallow / E_deep) / (z_deep − z_shallow).
4. Repeat on 2–3 days across the tide cycle. Enter the median in the app; the range shows in the robustness
   rows (Kd × 0.5 and × 1.5).

## 2. Light under the structure and in open water

The ratio of light under the structure to open water at the same depth tests the design and constrains ω₀,
the input that matters most under a structure.

1. Positions, at coral depth: under the structure at the center of the coral area and at the four edges
   (east, west, north, south); open water at least 5 m from the structure, out of its shadow.
2. Times: 3 h before solar noon, solar noon and 3 h after (the app shows solar noon for the site).
3. Read the open-water sensor and each position within 1 minute of each other, or log both continuously
   with paired loggers.
4. Record: time, depth of each sensor, cloud cover (oktas), wind and sea state, and whether the cloth was clean.
5. Compare with the prediction: `DesignResult.mc_check()` in the Python package gives the ratio at the same
   three times (center and east and west edges by default; pass `points` for others).

## 3. Shade cloth transmission

1. Measure PAR directly above and directly below the cloth (or under and beside it at the same depth) on the
   day it is deployed and before and after each cleaning.
2. Record cleaning dates. The share of time the cloth is fouled and its fouled transmission go into expert
   mode ("clean / fouled").

## 4. Continuous loggers (optional)

Paired PAR loggers under the structure and in open water give daily light over the deployment. Run them side
by side for 24 h before deployment and use the ratio to correct one to the other. Light loggers that record lux
are not PAR sensors; use them only as ratios between identical loggers.

## 5. What to report

Site coordinates, coral depth, structure height and size, cloth rating and measured transmission, Kd with its
range, the under/open ratios with times and sky conditions, cleaning dates, and the app version used.
