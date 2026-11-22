# Field protocol: measuring a site and checking a design

Four measurements make the app's answer site-specific: water clarity (Kd), water scattering (ω₀) from a reading
under an opaque board, light under the structure beside open water (a check of the design), and the cloth's
transmission over time. A tide record for the deployment can be added too. Use a
cosine-corrected underwater PAR sensor, held level.

## 1. Water clarity (Kd)

1. Measure PAR at two depths on the same vertical line, at least 3 m apart (for example 5 m and the coral
   depth), within 2 h of solar noon under a steady sky (clear or evenly overcast).
2. Take at least five readings at each depth, alternating depths, and use the medians.
3. Kd = ln(E_shallow / E_deep) / (z_deep − z_shallow).
4. Repeat on 2–3 days across the tide cycle. Enter the median in the app; the range shows in the robustness
   rows (Kd × 0.5 and × 1.5).
5. If clarity changes through the deployment, repeat every 1–2 weeks (or use satellite Kd products for the
   site) and paste the dated values into Expert → Water through the deployment → Kd by date.

## 1b. Water scattering (ω₀): one reading under an opaque board

ω₀ sets how much light reaches the corals sideways under a structure and changes the result more than any
other input. It cannot be inferred from Kd. One reading fixes it for the site:

1. Hold an opaque, level board (plywood or black plastic, at least 1 m across; 1.2 m is convenient) at a
   measured height (0.5–1 m) above a PAR sensor at coral depth, the sensor under the board's center. Note the
   board's east–west and north–south size.
2. Between 10:00 and 14:00, on a calm day with a steady sky, read the sensor under the board and a second sensor
   in open water at the same depth at least 5 m away, within 1 minute of each other. Take at least five paired
   readings and use the median of the ratios (under ÷ open); note their spread.
3. Measure Kd the same day (section 1).
4. Enter in Expert → Water scattering from a field reading: the ratio and its spread (±), board size and height,
   date and time, and the diffuse share of PAR above the water (about 15–25 % in clear sun at midday; from a
   shaded/unshaded sensor pair above water if available). Set Kd and the coral depth first. The app finds ω₀
   and its range and uses them in every result.
5. Repeat on a second day; the two values should agree within their ranges.

The Python package does the same: `coralshading design ... --w0-reading RATIO LX LY HEIGHT`.

## 2. Light under the structure and in open water

The ratio of light under the structure to open water at the same depth tests the design.

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
2. Record cleaning dates. Enter the clean transmission, the fully fouled transmission, the days it takes to foul
   and the cleaning schedule in Expert → Constant shading → Fouling: Builds up.

## 4. Continuous loggers (optional)

Paired PAR loggers under the structure and in open water give daily light over the deployment. Run them side
by side for 24 h before deployment and use the ratio to correct one to the other. Light loggers that record lux
are not PAR sensors; use them only as ratios between identical loggers.

## 5. What to report

Site coordinates, coral depth, structure height and size, cloth rating and measured transmission, Kd with its
range (and dates), the board reading and the ω₀ found, the under/open ratios with times and sky conditions, cleaning dates, and the app version used.
