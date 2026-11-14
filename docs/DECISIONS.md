# Decision log (for Graham's review)

Decisions made while building without you, newest last. Each says what was chosen, why, and what the
alternative was. Items marked **[needs you]** are waiting on your approval or input.

## Build environment

1. **Browser app folder is `webapp/`.** In this sandbox every npm run leaves `package.json` read-only to me,
   and the first two installs hung, which locked `app/package.json` and `web/package.json` with incomplete
   contents. `webapp/` was created with a complete `package.json` before npm ran.
   **[needs you]** Please delete `app/`, `web/`, `_scratch_npm_test/` and `_scratch_npm_test2/` (or approve
   my request to move them to the Trash). You may also want to end two stuck `node.exe` processes from
   `...\.claude-science\conda\envs\jsbench\` (my safety check could not run without you).
2. **No Vite, Vitest, esbuild or Rollup.** In this sandbox Node cannot start child processes, so those tools
   hang. The app uses only the TypeScript compiler, Node's built-in test runner (in-process) and a short
   build script that packs all modules into one file. Benefit beyond the sandbox: fewer dependencies, and
   the built app opens from a double-click (file://) with no server, as v4.2 did.
3. **PVGIS database.** PVGIS's satellite database (SARAH-3) does not cover the Philippines, so PVGIS
   returns an error if it is requested there. The app's download links and the Python package let PVGIS
   pick the database for each location (ERA5 reanalysis for Sipaway) and record which one was used.

## Physics

4. **PAR from PVGIS irradiance.** PAR = 0.50 of global irradiance (Spitters et al. 1986, with their diffuse
   fraction rule), converted at 4.57 µmol J⁻¹ for direct and 4.24 µmol J⁻¹ for diffuse light (McCree 1972).
   Alternative: one factor for all light (e.g. 2.1 µmol J⁻¹ of global); rejected because the direct/diffuse
   split matters under a canopy.
5. **Hourly values spread by the sun's path.** Each PVGIS hour is spread over its 60 minutes in proportion
   to cos(zenith), keeping every hour's total exact. Alternative: flat steps; rejected because they put
   light before sunrise and shift the shade timing.
6. **TMY dates.** PVGIS typical-year files mix years; they are re-dated onto each requested calendar day,
   and the sun is computed for the actual deployment year.
7. **Default Kd 0.10 m⁻¹** (a moderate coral-reef value), with a popup of sourced ranges from very clear
   (0.05–0.07, Kahng et al. 2010) to turbid inshore reefs (0.4–0.6). Sipaway itself measured about 0.21.
8. **Refractive index 1.34** for seawater and 64 deterministic wave facets (Cox & Munk 1954 slopes) for
   the sun beam; 16 facets in period runs and in the solver. Measured for the Sipaway canopy and cloth over
   the deployment: period transmission changes by less than 0.0001; daily light at single points by at most
   0.006 of open water (canopy edge).
9. **Underwater scattering: Fournier–Forand phase function, delta-truncated at 3°** (Mobley et al. 2002
   parameters, bb/b 0.0183). Light within 3° of the refracted sun is treated as part of the beam.
   Alternative: Henyey–Greenstein; rejected because it under-represents the strong forward peak of
   seawater and gave unrealistically dark shade.
10. **Single-scattering albedo w0 = 0.7 by default, 0.5–0.9 as the uncertainty band.** It is the largest
    single uncertainty: for the Sipaway canopy in Sipaway water (Kd 0.21) the period transmission is 0.21 at
    w0 0.5 and 0.40 at 0.9 (0.27 at 0.7); with the default Kd 0.10 it is 0.21 and 0.36. Kd ×0.5 to ×1.5 moves it only 0.25–0.28. The measured Sipaway under/open ratio (0.14 at
    noon) fits w0 0.8–0.85 better than 0.7. Expert users can calibrate w0 from an under/open reading.
    Resolved: the default is now 0.9 (decision 50).
11. **Light tables.** Forward Monte Carlo, 5 values of w0 × 10 sun angles + sky × 24 optical depths, 4 million
    photons each, plus geometric-splitting runs (200,000 photons) that resolve the deep planes, and an
    asymptotic extension to τ ≈ 96 so very turbid or deep sites still run. Deep decay rates converge to one
    value per w0 for every sun angle, as radiative-transfer theory requires. Fourier terms m ≤ 4 in azimuth.
12. **No correction table for the fast engine (yet).** Against the 3-D Monte Carlo (21 cases, 126 points) the
    fast engine is within −0.016 to +0.022 of open-water light for structures at 0.75 m (mean +0.006) and
    +0.002 to +0.009 for the cloth, but over-predicts light in the shade of a 2 m-high canopy by up to 0.037
    (mean +0.013, about 10 % of the shade value). Cause: it treats the water under the panel as if it were
    sunlit. The bias is one-sided (designs come out slightly over-shaded) and smaller than the w0
    uncertainty. A correction needs a model of the shadowed water volume; listed for the methods paper.
    The app will warn for canopies above 1.5 m and the Python package can check a design with the
    Monte Carlo. The tests enforce −0.02 ≤ error ≤ +0.04.

## Biology

13. **Coral presets: six species plus a "typical shallow coral"**, all from oxygen P–E curves compiled by
    Sawall & Hochberg (2018, PLoS ONE, S1 Table), with the original papers cited; all 13 references checked
    on CrossRef. Typical coral: Ek 234 µmol m⁻² s⁻¹ = median of the 26 curves from 1–12 m (IQR 176–273).
    Dropped for lack of an accessible Ek: *Acropora palmata* (values only in figures of Gomez-Campo et al.
    2023), *Porites cylindrica* (Montebon & Yap 1995, closed access), *A. hyacinthus*, *A. tenuis*.
    **[needs you]** If you have the PDF of Montebon & Yap (1995) — measured at Bolinao, Philippines — or
    the data of Gomez-Campo et al. (2023), I can add *P. cylindrica* and *A. palmata*.
14. ***Stylophora pistillata* uses Porter et al. (1984), Ek 273.** Mass et al. (2007) state Ek 1084.5 and
    659.5 at 5 m in their text, which Sawall & Hochberg list as the maximum irradiance (Ek 233 and 121).
    The conflict is shown in the preset note.
15. ***Acropora muricata* (Chalker 1981, as *A. formosa*) is marked "use with care":** Ek 55 at 6 m on a
    turbid inshore reef is far below other shallow corals (Ek/Emax 0.07 vs 0.2–0.5); not checked against
    the closed-access original.
16. **Respiration for P:R** only where a matched study gives dark respiration and saturated gross
    photosynthesis (Coral Trait Database): *A. cervicornis* 0.29 (Porter 1980), *P. damicornis* 0.36
    (Lesser et al. 1994); typical coral 0.33. Other presets show light and photosynthesis metrics but no P:R.
17. **Photoacclimation default: corals acclimated to open water at the target depth** (Ek scaled by the
    source study's Ek/Emax to the site's peak light). Options: as measured, or fully acclimated to the shade.
    Reason: with shallow-colony Ek, even unshaded corals at 10 m in Sipaway water would show P:R < 1, which
    is not what grows there. Sources: Falkowski & Dubinsky 1981; Anthony & Hoegh-Guldberg 2003.

## Design solver

18. **Objective = period transmission** (area-mean daily light summed over the deployment ÷ open water
    summed). Constant = cloth sized so the sun reaches the target only through it whenever the sun is
    > 10° up; dynamic = opaque canopy whose north–south size covers the noon sun's reach and whose
    east–west width is solved (Illinois method). Sync mode matches the dynamic canopy to the cloth's light.
19. **Fouling** mixes the clean- and fouled-cloth light by the share of time (exact for a single cloth).
20. **Clearance is a warning:** points that never get direct sun are mapped, with the height rule
    H ≥ 2R/(tan θ_lit − tan θ_shade) shown (e.g. about 2.6 m for a Reef Star to be fully sunlit at 08:00 and
    fully shaded from 10:00 at Sipaway on 28 April).

## Paper (time-sensitive)

21. **`09_wave_refraction.R` mirrors east–west and north–south** in its per-direction output
    (`dxm <- H * (-tx / tz)` should be `H * (tx / tz)`; same for y). No number in the manuscript or Online
    Resources changes, but the per-direction rows of `wave_points_summary.csv` and `wave_points_by_day.csv`
    in the Zenodo package are mislabelled. **[needs you]** I could not run the fix-and-compare (blocked by a
    safety check); recommend fixing the sign and regenerating the two CSVs before the Zenodo upload.

## Interface

22. **Interface built on the mock-ups before your approval.** You asked me to continue through completion, so
    the app follows the three mock-ups (simple, expert, light-data helper). Layout, colors and wording are
    in one stylesheet and one text file, so changes are quick. **[needs you]** Approve or mark up the mock-ups.
23. **Instant preview, then full resolution.** Every change gives a preview within about 0.2 s (15 cm grid,
    10 days, 8 wave facets; period light within about 0.002 of the full result: 0.2554 vs 0.2540 for the cloth),
    then the full run (5 cm grid, every day, 16 facets; about 4.5 s) and the robustness checks (about 1.5 s) follow in a background worker. The page
    never freezes; a new change discards stale work. Measured in Node on this PC for the Sipaway example.
24. **Left out of this first build (planned):** calibrating ω₀ from one under/open light reading, importing
    a generic light-logger CSV, and the plan's expert "noon from data" option. PVGIS data are hourly and
    modeled, so their peak only reproduces the computed noon; reading noon from data is useful with logger
    records and will come with the logger import (the noon shift covers it meanwhile). None of these controls
    is shown, so nothing in the interface is unfinished.
    **[needs you]** Say if either should come first.
25. **`python/pyproject.toml` is read-only to me** (sandbox file lock, as with `package.json`). The intended version is
    `python/pyproject.proposed.toml`: Python ≥ 3.10 (the code uses `X | None` hints), a `coralshading` command,
    and bundled data for pip installs. **[needs you]** Replace `pyproject.toml` with it. The license is set to
    MIT; **[needs you]** confirm or choose another.
26. **Solar noon is settable in simple mode too**, as you asked ("allow both to set when solar noon is"); the
    first build had put it in expert mode only. Wind stays in expert mode. The help text now says what the
    shift does (the whole path of the sun moves by that many minutes) and no longer mentions reading noon from
    the light data, which the app does not do. The Python command line gained `--noon-shift` and `--wind` to
    match the app.

## Documentation

27. **Documents written for release:** `README.md` (both products, usage, versions), `docs/methods.md` (every
    step against the code that does it), `docs/validation.md` (tables generated from
    `shared/validation/engine_vs_mc.json`), `docs/field_protocol.md`, `docs/RELEASE.md`, `CHANGELOG.md` and
    `CITATION.cff`. Each number in them was checked against the code or a run.
28. **Cloth help corrected.** It said the Sipaway cloth "let through 21 % clean and 15 % with sand". Those are
    readings under and beside the cloth at 10 m, which include light from the sides; the cloth itself let
    through about 12–20 % clean, depending on water scattering (`docs/methods_paper_groundwork.md`, section 3).
    The help now says this and asks for the cloth's own transmission in expert mode.
29. **Methods-paper analyses** are in `docs/methods_paper_groundwork.md`, reproducible with
    `python/examples/methods_paper_analyses.py`; figures and CSVs in `docs/figures/`. Main findings: the
    Sipaway canopy readings fit ω₀ ≈ 0.85–0.9 (see section 7 there; the default is now 0.9, decision 50);
    a 75 % canopy grows steeply with height and is out of reach above 1.5–2 m at Sipaway; an 80 % cloth
    transmits 0.24–0.44 of open-water light depending on height and ω₀.

## After your review (8 Nov, evening)

30. **Names: "constant shading" and "dynamic shading" throughout** (your request). The app's selector, cards,
    figures, checks and help, and the Python summary, now use these names; "shade cloth" and "opaque canopy"
    appear only where a sentence is about the structure itself (its size or rating).
31. **Energy match checked.** The two designs are matched in light summed over the deployment, not day by day.
    Sipaway, 3 m, 80 % cloth, 30 April: dynamic shading gains 1.09 mol m⁻² in the morning and 1.11 in the
    afternoon and loses 2.52 around noon, so it gets 9.00 against 9.32 mol m⁻² that day (3.5 % less). Over the
    101 days the totals agree within 0.3 %. Single days range from 0.87 to 1.24 (dynamic ÷ constant), driven by
    cloud: on the clearest quarter of days dynamic shading gets about 2 % less, on the cloudiest quarter 7–9 % more,
    because a narrow canopy blocks less of the diffuse light from a cloudy sky. 30 April is the clearest day in
    the typical year. The constant-shading curve is a nearly fixed fraction of open water (0.22–0.25 for an 80 %
    cloth; slightly higher early and late, when more light comes from the side). The "same light" help now says
    this. Figure: energy_balance_check.png.
32. **Map fallback.** When map tiles are blocked (for example in a preview window), the map now says so and
    points to typed coordinates, instead of staying blank.
33. **Porites cylindrica added** (Montebon & Yap 1995, from the PDF you sent): Ek 1062 (range 968–1307),
    R/Pmax 0.19, marked "use with care" because Ek sits near the top of the measured light range and no growth
    light is given, so Ek is used as measured; the app says so. **Acropora palmata** stays out: Gomez-Campo et al.
    (2024) show Pmax and the initial slope only as box plots; the medians give Ek ≈ 390 (290–590). **[needs you]**
    Their Appendix S1 (Supporting Information) should hold the values; send it if you have it.
34. **Left panel fits.** Latitude, longitude and UTC offset share a row that now shrinks to fit; the deployment
    dates sit on their own row below the label. Labels no longer wrap their (i) icon onto a new line; long
    selector text is shortened with an ellipsis instead of pushing the label.
35. **No orphaned words.** Headings and labels use balanced line breaks and paragraphs avoid single-word last
    lines (CSS text-wrap, current Chrome, Edge and Safari); numbers stay with their units ("0.75 m", "1.29 × 1.35 m");
    the key figures put the unit on its own line.
36. **Rectangular coral areas run north–south** by default (table 1 × 2 m, rope nursery 1 × 4 m; also in Python),
    so dynamic shading sweeps evenly over them. If a coral area is wider east–west than the canopy, a check says
    the ends stay in the sun and suggests turning it.
37. **Headline and light ratio.** The headline no longer says "cut daily light by 75 %". A sentence under it says
    what share of open-water light reaches the corals and why it differs from the cloth rating (light from the
    sides).
38. **Coral response redesigned.** The chart shows the photosynthesis curve with the four light zones and the
    hours per day spent at each light level for open water and each kind of shading. A table gives hours per day
    and share of daily light in each zone for all three (new zone metrics, identical in Python and the app; old
    "hours above Ek" rows dropped). Photoinhibition is not shown: none of the preset sources gives a threshold.
39. **Acropora muricata removed from the presets** (moved to excluded): its Ek of 55 µmol m⁻² s⁻¹ (Ek/Emax 0.07)
    made shaded corals look saturated all day, which is what you saw.
40. **Across the deployment** now shows daily light (mol m⁻² d⁻¹) for open water and each kind of shading, taller,
    with the means in the caption.
41. **A day under the structures** has a day picker (slider and arrows) over the whole deployment; the expert
    points chart follows it. The caption gives that day's open-water light and the deployment range.
42. **Checks reworded** for first-time users: the direct-sun hours are a range across the coral area (least where
    the canopy covers longest, most at the edges), counted when the sun is in line, not affected by cloud. The
    scattering range is explained in plain words.
43. **Map:** satellite only (the street map is blocked by OpenStreetMap's tile policy for pages opened from a file).
44. **Scattering (ω₀) cannot be looked up from Kd.** Petzold's measurements (530 nm) give 0.25 (clear ocean),
    0.55 (coastal, Kd ≈ 0.19) and 0.83 (turbid harbor); the Sipaway canopy readings at Kd 0.21 fit 0.85–0.9. The
    help now gives these values. **[needs you]** Choose how to narrow the range (see the message of 8 Nov).

## 9 November 2026: spiky day curves at other sites

45. **Cause.** Moving the site kept the Sipaway light data and UTC+8. At Belize (16.19° N, 88.60° W) the Sipaway
    hours of strong sun fall at night or near dawn there; spreading an hour along the computed sun squeezed its
    light into the few minutes the sun was up (surface peak 4831 µmol m⁻² s⁻¹, about 2000 at 5 m, 3.4 mol m⁻² for
    the day). Changing the UTC offset alone does not fix it (surface peak still 3667).
46. **Light data must belong to the site.** Data more than 50 km from the site are not used. The app switches to a
    clear-sky estimate for the site (Haurwitz 1945; Erbs et al. 1982; wind 5 m s⁻¹), says so in the light-data line,
    the status bar and a CHECK, and returns to the loaded data when the site moves back within 50 km. Loading a
    PVGIS file for another place moves the site there. The Python package refuses far data with a message and
    gains light="clearsky". Clear sky overstates light (Belize, June: +54 % at the surface; photosynthesis under
    the cloth 48 % against 41 % of unshaded), but structure sizes stayed within 0.01 m.
47. **Timing guard** in both products: an hour cannot hold more light than reaches the top of the atmosphere for
    the computed sun (clearness index ≤ 1); the excess is left out and reported when above 1 %. It never acts on
    the Sipaway data (brightest hour 0.73), so all earlier goldens are unchanged to the last digit.
48. **UTC offset** follows the longitude when the site moves (nearest whole hour); solar noon is shown within
    0–24 h, and a check fires when it falls more than 3 h from 12:00.
49. **Bug found on the way (Python, Windows):** the PVGIS download cache was written in text mode, doubling every
    line ending; read back, the parser stopped after one row and returned a year of zeros without an error. The
    cache now writes bytes; both parsers skip blank lines and refuse a typical year without 8760 hours or an
    hourly series with gaps.

## Release (13 Nov 2026)

50. **Default ω₀ = 0.9** (your decision), in the app, `design()`, the command line and `engine.Water`. The
    Sipaway canopy readings fit 0.85–0.9. More scattering brightens the shade, so with this default structures
    come out larger and tall canopies reach a given light cut less often than at 0.7. The 0.5–0.9 range and the
    golden test values (which set ω₀ explicitly) are unchanged.

