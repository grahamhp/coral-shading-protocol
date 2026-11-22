# Methods

How the Coral Shading Protocol v5.2 computes light under a shade cloth or an opaque canopy. Every step names the
code that does it (Python reference `python/src/coralshading/`, identical TypeScript in `webapp/src/core/`).
Full references with DOIs are in `shared/references.json` (each checked on CrossRef).

## 1. Sun

Solar position (zenith with atmospheric refraction, azimuth clockwise from north) from date, local time,
latitude, longitude and UTC offset, by the NOAA solar-position algorithm; checked against NREL SPA values
(Reda & Andreas 2004). Solar noon is computed from the equation of time and longitude; the user can shift
it (minutes) to match a light record whose clock is offset. *(solar.py)*

## 2. Light at the sea surface

**Data.** Hourly global (G) and diffuse (D) irradiance on a horizontal plane, in W m⁻², as a typical year or as
real hours for chosen years. Three sources:

- *PVGIS 5.3* (Huld et al. 2012), the reference. PVGIS chooses the database for the location: the SARAH-3
  satellite record between about 65° W and 65° E (Europe, Africa, the Red Sea, the western Indian Ocean, the
  eastern Caribbean) and the ERA5 reanalysis (Hersbach et al. 2020) elsewhere, including the Philippines, the
  Pacific and the Americas west of about 65° W. Ten example reefs carry their PVGIS typical year with the app.
  *(surface.parse_pvgis; pvgis.py downloads in Python; examples.py)*
- *ERA5 from the Open-Meteo archive* (v5.2), for any site without a file: ten complete years of hourly values, from
  which a typical year is built (below). Where PVGIS itself uses ERA5 the two agree hour by hour (validation,
  section 5); inside the satellite area PVGIS follows clouds more closely and is the better choice for a final
  design. *(surface.parse_open_meteo, surface.typical_year; app: ui/lightdata.ts; Python: openmeteo.py)*
- A *clear-sky estimate* (below), only until one of the above is loaded.

**Each value keeps its own time (v5.2).** ERA5 values are means of a clock hour (PVGIS stamps them hh:30 in hourly
series, and hh:00 with a stated offset of 0.5 h in typical years; Open-Meteo stamps each mean at the end of its
hour). SARAH-3 values are the irradiance at the satellite scan a few minutes after the hour (stamps such as hh:09;
typical-year offset such as 0.153 h). Every value is used as the mean of the hour centred on its own time. Until
v5.1 all values were placed on hh:30 hours, which put SARAH-3 data about 40 minutes early (and refused SARAH-3
hourly series). Checked on clear days at ten sites: the light's centre of mass falls within a few minutes of solar
noon with this placement (validation, section 5). *(HourlyLight.center_min; surface.hourly_window)*

**Typical year from real years (v5.2).** For each calendar month one year is chosen and its hours are copied, the
irradiance part of ISO 15927-4: the distribution of daily global irradiation in each candidate year-month is
compared with all years of that month by the Finkelstein–Schafer statistic (mean absolute difference between the
two cumulative distributions; Finkelstein & Schafer 1971); of the three closest years, the one whose monthly mean
is nearest the all-year mean is taken. Days run from local solar midnight; 29 February is dropped. At six test
sites the typical year's annual light is within 0.2–1.8 % of the ten-year mean (monthly within 2.6–5.4 %) before the
mean rule, which tightens the monthly means further. *(surface.typical_year)*

TMY days are re-dated onto each deployment day, and the sun is computed for the actual year. A typical year must
have 8760 hours and an hourly series no gaps; blank lines are skipped.

**Within each hour (v5.2)** the light follows cos(zenith) times the hour's clearness (irradiance ÷ mean
cos(zenith)), which is interpolated linearly in time between the centres of neighbouring hours and then rescaled
so that each hour keeps its total exactly; global and direct irradiance are treated alike, and no light falls
before sunrise. Hours without light are not interpolated towards (PVGIS-ERA5 gives zero for the hour of sunrise
when the sun is below the horizon at its start). Until v5.1 the clearness was constant within each hour, which made
the light jump at every hour boundary: on a cloud-free day the largest second difference between 10-minute steps
from 07:00 to 17:00 fell from 98 to 8.5 µmol m⁻² s⁻¹. Hour totals, daily light and the designs are unchanged (the
example canopy by 0.04 cm, period light by 0.02 percentage points). The minute values are averaged onto 10-minute
steps. *(surface.day_light)*

**Timing guard.** An hour may hold at most the light that reaches a horizontal plane above the atmosphere for the
sun computed in that hour, 1361 W m⁻² × [1 + 0.033 cos(2π·day/365)] × mean cos(zenith) (hourly clearness index ≤ 1).
More than that means the data are for another place or are mistimed. The excess is left out and its share
reported, instead of being squeezed into the few minutes the sun is up. In the example data the brightest hour
reaches 0.73 of this limit, so the guard never acts there. *(surface.day_light: light_total, light_dropped)*

**Light data must belong to the site.** Light data for a point more than 50 km from the site are not used. The app
then looks for a bundled example within 50 km, then fetches ERA5 data for the site, and shows a clear-sky estimate until they arrive; loading a PVGIS file for another place
moves the site to the file's location; the Python package refuses such data with a message. *(surface.MATCH_KM)*

**Clear-sky estimate.** Global irradiance G = 1098 cos z exp(−0.059 / cos z) W m⁻² (Haurwitz 1945; constants as in
Reno et al. 2012 and pvlib), averaged over each UTC hour from 10 samples; diffuse share from the hourly clearness
index (Erbs et al. 1982); wind 5 m s⁻¹. It has no clouds. At the example site (Sipaway Island, Philippines) it gives 2639 kWh m⁻² a year against 1758 in
the PVGIS typical year. At Belize (16.19° N, 88.60° W) in June it gives 54 % more surface light than PVGIS (65.8
against 42.8 mol m⁻² d⁻¹) with a diffuse share of 0.22 against 0.48; the designed structures were within 0.01 m
and 0.01 in light ratio, but photosynthesis was overstated (cloth 48 % against 41 % of unshaded). The app and the
package flag every result made with it. *(surface.clear_sky_light)*

**UTC offset.** When the site moves, the offset is set to the nearest whole hour of solar time,
floor(longitude/15 + 0.5); the user can change it to the civil time zone (for example Hawaii, UTC−10). A check fires
when solar noon falls more than 3 h from 12:00. *(surface.utc_offset_from_lon; design.light_warnings)*

**PAR.** PAR = 0.50 G (Spitters et al. 1986). The diffuse fraction of PAR follows Spitters et al. (1986):
k_PAR = min(1, [1 + 0.3(1 − k²)] k), where k = D/G. Energy is converted to photons at 4.57 µmol J⁻¹ for direct
and 4.24 µmol J⁻¹ for diffuse light (McCree 1972). *(surface.to_par)*

**Circumsolar sky light (v5.1).** Part of the diffuse light comes from the bright sky around the sun. As in the
Hay & Davies (1980) sky model, each hour's anisotropy index A = direct normal irradiance ÷ extraterrestrial normal
irradiance (the hour's beam on a horizontal plane ÷ the extraterrestrial horizontal irradiance for the same sun)
gives the share of the diffuse PAR that travels with the sun beam (refracted by the same facets, attenuated and
shaded like the beam); the rest is isotropic sky. Overcast hours (no beam) have none. The surface total is
unchanged. *(surface.day_light: par_circumsolar_h)*

## 3. Through the surface

- Refractive index of seawater n = 1.34 (Quan & Fry 1995). Unpolarised Fresnel transmittance for the sun; for a uniform sky the
  hemispherical transmittance (≈ 0.93). *(optics.fresnel_t, sky_transmittance)*
- **Waves.** The sun beam is split over 64 deterministic surface facets (16 in period runs) with Gaussian
  slopes of total mean square σ² = 0.003 + 5.12 × 10⁻³ U (Cox & Munk 1954), U = wind speed at 10 m from the
  light data or set by the user. Each facet refracts the beam (Snell) and is weighted by its projected area
  and Fresnel transmittance; facets turned away from the sun get no weight. A flat sea (U = 0) gives one ray.
  Under a flat sea, light never travels more than 48.3° from vertical. *(optics.refracted_sun_rays)*

## 4. Through the water: the light tables

Light in the water column is computed once, by Monte Carlo, and stored in `shared/tables/light_tables.json`.

- **Water.** Absorption a and scattering b with c = a + b; single-scattering albedo ω₀ = b/c; optical depth
  τ = c z. Scattering follows the Fournier–Forand phase function with n = 1.10 and μ = 3.5835 (backscatter
  ratio 0.0183, the value for Petzold's average particle phase function; Fournier & Forand 1994; Mobley et al.
  2002). Light scattered within 3° of its direction is kept in the beam (δ-truncation; Joseph et al. 1976;
  Wiscombe 1977), which removes 44.7 % of b and the need to resolve the narrow forward peak. *(mc.py)*
- **Forward Monte Carlo** for ω₀ = 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9 and 0.95; sun zenith 0–88° (10 values) and a uniform sky;
  24 depths τ = 0.05–40. Photons enter through a flat surface; light going up is partly reflected back at the
  surface (Fresnel, total internal reflection outside Snell's window). Tallies at each depth plane: the beam
  (unscattered plus within 3° of the refracted sun) and the downwelling irradiance from each direction, in
  3°-zenith × 10°-azimuth bins relative to the sun (symmetric about the sun's vertical plane), stored as
  cosine Fourier coefficients A_m(θ), m = 0–4. Each run
  uses 4 million photons; where fewer than 2,500 photon-equivalents reach a depth, a second run with
  geometric splitting and Russian roulette (200,000 photons; unbiased; deep planes resolved as well as shallow
  ones) supplies the values. Beyond τ = 40 (to τ ≈ 96) light decays exponentially with the angular shape
  fixed, at the rate fitted over the deepest four simulated depths (τ ≈ 17–40), where the decay rate has
  converged to the asymptotic value for each ω₀. *(build_tables.py)*
- **From Kd to optical depth.** The user gives Kd (PAR) and ω₀. τ for the coral depth is chosen so that open-
  water light at depth ÷ light just below the surface equals e^(−Kd·z) for a reference sky (sun zenith 20°,
  30 % diffuse), interpolating the tables log-linearly in τ. *(engine.optical_depth_for_kd)*

### Conditions that change through the deployment (v5.1)

- **Kd by date.** Kd values on some dates (own readings or satellite Kd products); each day takes the value
  interpolated linearly in time between the nearest dates, the nearest value held before the first and after the
  last. The day's τ follows from that Kd as above; ω₀ is kept. *(conditions.kd_for_days)*
- **Tide.** A water-level series in local standard time. Levels are taken relative to their time-weighted mean
  over the deployment (local midnight before the first day to midnight after the last), so the depth entered is
  the depth at mean water level. At each 10-minute step the depth is z(t) = z + level(t) − mean level, and the
  optical depth is c·z(t) with the day's beam attenuation c = τ/z kept; τ is rounded to steps of 0.02 % (log
  scale) so that water states can be reused (effect on daily light under 0.05 %). A panel that can reach the
  surface at low tide has its angular transmission recomputed for the depth at each step (to the nearest 1 cm).
  Depths of 0.05 m or less stop the run with a message. *(conditions.Tide; scenarios.run_period)*

## 5. Light at each point under the structures: the fast engine

The coral area is a grid of points (rectangle or circle; 5 cm by default). Each structure is a flat
rectangular panel (size, center offset, rotation, height above the corals, light transmission τ: 0 for an
opaque canopy, the cloth's value for a cloth). Panels can be submerged or above the water; for panels above
the water the ray is refracted at the surface. For each point and each 10-minute step:

E = F_s [B(θ_s) V + Σ_m Σ_i A_m,i(θ_s) (cos mφ_s C_m,i + sin mφ_s S_m,i)] + F_k Σ_i A^sky_0,i C_0,i

- F_s = (direct + circumsolar PAR) on a horizontal plane × surface transmittance of the facets; F_k = diffuse PAR × sky
  transmittance.
- B, A_m,i, A^sky: the tables, interpolated to the water (linear in ω₀ and log τ, on log values) and to the
  sun zenith θ_s (linear; the beam log-linear).
- V: the sun beam's visibility, the facet-weighted product of the transmissions of the panels each refracted
  ray crosses (exact ray–rectangle tests).
- C_m,i = ∫ T(θ_i, φ) cos mφ dφ and S_m,i = ∫ T(θ_i, φ) sin mφ dφ, where T is the panels' transmission seen from
  the point in direction (θ, φ) (3 zenith sub-samples per 3° band × 72 azimuths).
- Open water: the same with T = 1, E_open = F_s [B + 2π Σ A_0,i] + F_k 2π Σ A^sky_0,i.

The engine treats light reaching the point from each direction as open-water light dimmed by the panels in
that direction. It is checked against a 3-D backward Monte Carlo that follows light around the actual
structure (*validation.md*): for structures 0.75 m above the corals, within −0.016 to +0.022 of open-water
light at ω₀ 0.3–0.85 (one sunlit point at ω₀ 0.95: −0.029); for a canopy 2 m up, light in the shade is up to 0.037 too high. *(engine.py)*

Daily light (mol m⁻² d⁻¹) is the sum over steps; the period transmission T is the area-mean daily light summed
over the deployment ÷ open-water daily light summed.

## 6. Shading scenarios and design

- **Constant (shade cloth).** By default the cloth is sized so that, whenever the sun is more than 10° up, its
  refracted beam reaches the coral area only through the cloth: half-sizes = target half-size + height × the
  largest east–west and north–south tan(refracted zenith) of the period. Transmission = 1 − rating (simple mode)
  or the cloth's own clean transmission with a fouling timeline (v5.1): after each cleaning (the start date, every
  n days and any listed dates) transmission falls linearly from clean to fully fouled over a set number of days,
  then stays there. Each day uses its own transmission. This is exact and costs one run: for a single panel, light
  at every point is linear in the panel's transmission, E(τ) = E(0) + τ [E_open − E(0)]. (The Python package also
  keeps v5.0's fixed share of time fouled.) *(conditions.Fouling; scenarios.period_for)*
- **Dynamic (opaque canopy).** North–south size = target + 2 × height × the noon sun's largest north–south
  tan(refracted zenith). East–west width solved so that T meets the target: the cloth's T ("same daily light") or a reduction the user sets. The match is in light summed over the deployment, not day by
  day: on clear days dynamic shading gives slightly less light than constant shading, on cloudy days more, because
  a narrow canopy blocks less of the diffuse light from a cloudy sky. Solver: Illinois (modified regula falsi) on
  every day of the deployment and on the reported grid (v5.1; v5.0 used about 20 days on a 10 cm grid and a
  correction step, which moved the result by 0.05 percentage points in the example). If even a 12 m canopy lets too
  much light through, the closest design is shown with the reason.
- **Light at noon and in the morning and afternoon (v5.1).** For each design: area-mean light ÷ open water within
  1 h of solar noon, and 3 h or more from solar noon with the sun more than 10° up, summed over every day. Also
  the share of open-water light at depth that arrives as the sun beam (within 3° of the refracted sun). Where
  scattering dominates (high ω₀, deep or turbid water), an opaque canopy blocks scattered light at every hour and
  cannot shade noon much more than the morning; a CHECK appears when dynamic shading's noon light exceeds 0.8 of
  its morning and afternoon light. At Kd 0.21 and 10 m the beam carries 29 %, 10 % and 0.8 % of the light at ω₀ 0.5,
  0.7 and 0.9 (example site, 28 April–8 August).
- **Clearance check.** Points with less than 0.1 h with the sun in line on every day are mapped (the sun is in
  line when at least half of the facet-weighted beam reaches the point). This is geometry: clouds and scattering
  are not counted, so it says little about light dose where the beam carries little light. For a
  target of radius R and a sun moving roughly east–west, the whole target is sunlit while H tan θ_w ≥ a + R and
  shaded while H tan θ_w ≤ a − R (a = canopy half-width), so both need H ≥ 2R / (tan θ_w,lit − tan θ_w,shade).
  Because tan θ_w < 1.12 under a flat sea, any full clearance needs H ≥ 1.78 R. The app shows the H needed for
  the target to be fully sunlit 4 h before noon and fully shaded from 2 h before noon on the most demanding day
  of the deployment (v5.1; v5.0 used the first day: 2.56 m against 2.74 m around the June solstice in the example).
- **Water scattering: design value and range (v5.1).** ω₀ is rarely measured and spans most of its possible range
  in natural waters: about 0.25, 0.55 and 0.83 for Petzold's clear-ocean, coastal and turbid-harbor waters in green
  light (Petzold 1972; Mobley 1994); radiative transfer studies take 0.1 as absorption-dominated and 0.9 as
  scattering-dominated water (Mobley et al. 2002); and Pacific reef waters absorb and scatter more than the
  offshore water next to them (Russell et al. 2019). The design value is 0.7, the middle of 0.5–0.9, and every
  result is also computed at both ends of the range (the same structure, every day, the reported grid), shown as
  "likely between … and …". The range can be set by hand or from a field reading.
- **ω₀ from a field reading (v5.1).** The ratio of light under a level opaque board to open water at the same
  depth, read at the board's center, is computed for the reading's date, time and diffuse share (wind 0) with the
  site's Kd and depth; it increases monotonically with ω₀ (Kd 0.21, 10 m, a 1.2 m board 0.75 m up, 22 May at 12:00 at
  the example site, 30 % diffuse: 0.078 at ω₀ 0.5, 0.137 at 0.7, 0.305 at 0.9), so ω₀ is found by bisection over the tables' range. The reading's ± sets the
  range. Readings outside what any ω₀ can give are reported, not forced. *(scenarios.w0_from_reading)*
- **Robustness.** T recomputed with Kd × 0.5 and × 1.5, ω₀ at the ends of the range, wind 0 and 10 m s⁻¹, and the
  structure shifted 0.2 m east or north, on every day and a 10 cm grid (v5.1; v5.0 used about 12 days, within
  0.08 percentage points).
- **What is held fixed.** Unless Kd by date and a tide series are given, one Kd and one depth hold for the whole
  deployment; ω₀ and the backscatter ratio are always held fixed; with a typical year, each date is one
  typical-year day, not that year's weather. Light ratios between designs are insensitive to Kd and depth (in the
  example, Kd × 0.5–1.5 moves them at most 2.7 points, ±0.75 m of depth under 0.3 points, real years 2014–2023
  under 0.11 points; a 1 m semidiurnal tide changes open-water daily light by about ±4 % and the ratio by about
  0.2 points), but absolute daily light and the coral metrics are not. Exports state what was assumed.

## 7. Corals

- **First days and once adjusted (v5.2).** The app reports the coral metrics twice when the chosen acclimation
  lets Ek follow the shade ("over time", "the shade"): *first days*, with Ek as acclimated to open water at the
  coral depth (the corals as they are when the shade goes up), and *once adjusted*, with the chosen acclimation.
  Reason: with Ek proportional to the light and Pmax and R held fixed, an adjusted coral recovers its daily
  photosynthesis almost fully under any shade, so the adjusted P:R says little about how much shade is too much.
  The first-days values are the immediate effect of the shade; the fully adjusted values are on the optimistic
  side, because real corals in low light also change Pmax and respiration (Porter et al. 1984). The shade-rating
  table uses the first-days values. *(ui/compute.ts: bioFirst; in Python: pe.Coral(acclimate="site"))*
- **How far the corals adjust (v5.2).** An extent x between 0 and 1 sets the Ek the corals move to:
  Ek_site + x (Ek matched to the shade − Ek_site), where Ek_site is the Ek for open water at the coral depth.
  x = 1 is the full adjustment described under Photoacclimation below, x = 0 leaves the corals as they are at
  this depth, and the time course (2.5-day time constant) is the same for any x. The app and `design()` start at
  **x = 0.25 ("Low")**. This is a cautious design assumption chosen by the authors, not a measured value: the
  full adjustment was measured in the laboratory at ordinary temperatures, the tool has no measurement of how far
  corals adjust during heat stress, and a low extent keeps a plan from relying on the corals making up for heavy
  shade. The app offers None, Low (0.25), Medium (0.5) and Full (1), and any value in Expert mode.
  *(pe.Coral.extent; design(acclimation_extent=...); CLI --acclimation-extent)*
- **Starting values.** The app, `design()` and the command line start from a 50 % shade cloth and corals at 5 m
  (before 5.2: 80 % and 10 m, the Sipaway deployment). They are a place to start, not advice for a site.
- **Photosynthesis.** P_gross = Pmax tanh(E / Ek) (Jassby & Platt 1976; Chalker 1981). Daily gross
  photosynthesis in Pmax-hours = ∫ tanh(E/Ek) dt; "photosynthesis, % of unshaded" = that ÷ the same for
  open water at the same depth. Hours above Ek; light above Ek = ∫ max(E − Ek, 0) dt. Daily P:R =
  gross Pmax-hours ÷ (24 h × R/Pmax), with dark respiration all day; compensation irradiance Ec = Ek atanh(R/Pmax).
- **Light zones.** Daylight time and light at each point are split into four zones of the curve: below
  compensation (E < Ec; only when R/Pmax is known), light-limited (Ec–Ek; P below 76 % of Pmax), near saturation
  (Ek–2 Ek; 76–96 %) and saturated (above 2 Ek); the same for open water. The app reports hours per day and the
  share of daily light in each zone, averaged over the coral area and the deployment. *(pe.day_metrics)*
- **Presets** (`shared/corals/pe_presets.json`): oxygen P–E curves compiled by Sawall & Hochberg (2018) with
  the original studies cited: *Stylophora pistillata* (Porter et al. 1984; Mass et al. 2007), *Pocillopora
  verrucosa* (Sawall et al. 2014), *P. damicornis* and *Porites lobata* (Davies 1991), *Acropora cervicornis*
  and *A. muricata* (Chalker 1981). The typical coral is the median of the 26 curves from 1–12 m (Ek 234, IQR
  176–273 µmol m⁻² s⁻¹; Ek/Emax 0.33). R/Pmax from matched studies via the Coral Trait Database (Madin et al.
  2016; Edmunds et al. 2014): *A. cervicornis* 0.29 (Porter 1980), *P. damicornis* 0.36 (Lesser et al. 1994);
  typical coral 0.33, the middle of the same-study ratios found (0.25–0.41). *A. muricata* (Ek 55, Ek/Emax
  0.07) is marked "use with care": unusually low for a shallow *Acropora* and not checked against the original. *Porites cylindrica* (Montebon & Yap 1995; field controls on a reef flat, Ek 1062, R/Pmax 0.19) is
  also marked "use with care": Ek lies near the top of the measured light range, and with no growth light reported
  it is used as measured. *Acropora palmata* is left out: Gomez-Campo et al. (2024) report Pmax and the initial slope
  only as box plots, so Ek cannot be read reliably.
- **Photoacclimation** (Ek tracks the growth light; Falkowski & Dubinsky 1981; Anthony & Hoegh-Guldberg 2003).
  "Over time" (default, v5.1): Ek starts at the value for open water at the coral depth, (Ek/Emax of the source) ×
  the 90th percentile of daily peak open-water light, as for nursery corals before shading; each day it then moves
  toward (Ek/Emax) × that point's own daily peak light under the structure, Ek ← Ek + (1 − e^(−1/2.5)) (target −
  Ek), a first-order response with a 2.5-day time constant (Anthony & Hoegh-Guldberg 2003 found Ek "reached new
  and stable levels within 5–10 days" after a change in light). Each day uses the Ek reached before it.
  "Light at this depth" holds the starting value; "the shade" uses each point's own 90th-percentile peak;
  "as measured" uses the source Ek.

## 8. Limits

- The engine slightly over-predicts light in the shade of high canopies (section 5).
- Water scattering (ω₀) matters more than Kd under a structure and is rarely measured; every result carries the
  range it causes, and one reading under an opaque board narrows it (field protocol).
- The particle phase function is fixed (Fournier–Forand, backscatter ratio 0.0183). Reef waters can backscatter a
  larger share (Russell et al. 2019 report particulate backscatter ratios near 0.03); more backscatter returns more
  light upward and slightly changes the angular spread, a smaller effect under a structure than ω₀ is expected to have.
- With a tide, the water's attenuation per meter is held for each day; with Kd by date, ω₀ is held.
- Flat panels only; no light reflected from the panel undersides or the seabed (in the 3-D Monte Carlo a sand
  seabed of albedo 0.4 added 0.003–0.013 to the noon under/open ratio under the example canopy); the coral area is flat.
- P:R uses dark respiration; light-enhanced respiration is not included. Acclimation changes Ek only; Pmax and
  respiration are held fixed (section 7).
- The tool computes light and photosynthesis. It does not model temperature, bleaching or survival. Published
  trials found less bleaching under 30 %, 50 % and 75 % shade (Butcherine et al. 2023; Coelho et al. 2017; review:
  Tagliafico et al. 2022); how much shade a site needs is not settled.
