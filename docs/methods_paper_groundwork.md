# Methods paper: groundwork

Analyses for a paper describing CSP v5. All numbers come from `python/examples/methods_paper_analyses.py`,
`shared/validation/engine_vs_mc.json` and the saved CSV files; figures were made from the same data.

## 1. Proposed paper

**Working title:** Designing shade structures for corals from radiative transfer: the Coral Shading Protocol v5.

**One-sentence pitch:** Light under a coral shade structure depends on scattered light from the sides as much
as on the shadow, so structures must be designed with the water's scattering in mind, and a free tool now does
this point by point.

**Possible venues** (to decide): *Methods in Ecology and Evolution* (Applications, for software), *Coral
Reefs* (Report or Note), *Restoration Ecology* (practical article), or *Limnology and Oceanography: Methods*.

**Outline**

1. Introduction: shading as a bleaching intervention; design so far by vertical attenuation or rules of thumb;
   what is missing: side light, refraction, waves, coral response.
2. Methods: the light model (`docs/methods.md`); the fast engine and its Monte Carlo tables; validation
   design (3-D Monte Carlo, 21 cases, 126 points); field data (Sipaway, 22 May 2025); design analyses.
3. Results: (i) accuracy; (ii) field readings and what they say about ω₀ and cloth transmission; (iii) design
   space: height, width, direct sun; (iv) robustness: ω₀ dominates.
4. Discussion: design rules (keep structures low; size for side light; measure ω₀ with one reading);
   limitations; next steps (ω₀ calibration, shadow-volume correction, multi-site validation).
5. Software availability: app URL, repository, Zenodo DOI, Python package.

**Figures**

- Fig. 1: the problem in one picture (light reaching a coral under a canopy: shadow, side light, refraction cap).
  To draw.
- Fig. 2: accuracy and field check: [figures/fig_methods_validation.png](figures/fig_methods_validation.png)
- Fig. 3: design space vs height: [figures/fig_methods_design_space.png](figures/fig_methods_design_space.png)
- Fig. 4: the app (simple and expert screens) with the Sipaway example.

## 2. Accuracy (Fig. 2a–b)

Fast engine against the 3-D Monte Carlo, 126 points in 21 cases: mean error +0.007; all errors
between -0.017 and +0.037. In the shade (Monte Carlo transmission < 0.3; 89 points)
the mean error is +0.008. The largest errors are under a canopy 2 m up (up to +0.037), where the
engine treats the water beneath the panel as sunlit. Details: `docs/validation.md`.

## 3. Sipaway field readings (Fig. 2c)

**Data.** On 22 May 2025, around solar noon, PAR was read eight times per structure, alternating between the
shaded area and the adjacent open area (LI-192 sensor, LI-1400 logger; Kd 0.21 m⁻¹ measured the same day).
Reductions (mean ± SD of four structures): opaque canopy 86.0 ± 7.5 % (under/open 0.140 ± 0.075); shade cloth
79.0 ± 1.5 % after cleaning (0.210 ± 0.015) and 85.3 ± 3.6 % with sand (0.147 ± 0.036).

**Model.** Canopy 1.88 × 2.0 m and cloth 4.0 × 2.0 m (rated 80 %, τ 0.20), 0.75 m above a Reef Star at 10 m;
solar noon ± 30 min on 22 May 2025 (sun 10.0° from the zenith, to the north); diffuse share of PAR
0.31 (PVGIS typical year at noon; 0.30 and 0.50 change the canopy ratio by at most 0.009); flat sea
(5 m s⁻¹ wind changes nothing at noon).

| ω₀ | Canopy, center | Canopy, Reef Star mean (range) | Cloth τ 0.20, Reef Star mean | Cloth τ implied by 0.210 |
|---|---|---|---|---|
| 0.5 | 0.022 | 0.036 (0.022–0.065) | 0.215 | 0.19–0.20 |
| 0.7 | 0.049 | 0.069 (0.048–0.108) | 0.231 | 0.18–0.19 |
| 0.8 | 0.076 | 0.103 (0.076–0.150) | 0.248 | 0.16–0.17 |
| 0.85 | 0.103 | 0.133 (0.102–0.186) | 0.264 | 0.14–0.16 |
| 0.9 | 0.135 | 0.170 (0.134–0.228) | 0.282 | 0.12–0.14 |

**Reading.**

- The canopy readings (0.14) fit ω₀ ≈ 0.85–0.9: the mean matches ω₀ 0.86 for the Reef Star mean and just
  above 0.9 at the center. At the app's default ω₀ 0.7 the model gives 0.05 at the center and 0.07 over the
  Reef Star, a third to a half of what was measured. With four structures the mean is uncertain: ± 1 SE
  (0.10–0.18) spans ω₀ ≈ 0.8 to above 0.9, and the 95 % interval (0.02–0.26, t with 3 df) does not exclude the
  default. One site with four readings suggests, but does not establish, a higher ω₀.
- The 3-D Monte Carlo gives the same picture: at ω₀ 0.85 the Sipaway canopy at noon transmits
  0.089 at the center and 0.139–0.172 at the Reef Star edge; at ω₀ 0.7,
  0.042 and 0.078–0.100. The fast engine reads 0.010–0.015 high at ω₀ 0.85, which
  moves the fit slightly toward 0.9; a sand seabed (albedo 0.4) adds 0.003–0.013, which moves it back.
- The cloth readings fit any ω₀ if the cloth's transmission in water was below its rating. With ω₀ 0.85–0.9,
  the cleaned cloth transmitted about 0.12–0.16 (rated 0.20) and the sanded cloth 0.05–0.09. Shade ratings are
  nominal and measured in air; this is worth one sentence in the paper and a note in the app's cloth help.
- The canopy reading is the cleaner test of the model, because an opaque sheet has no material uncertainty.

## 4. Design space (Fig. 3)

Sipaway, 28 April–8 August, Kd 0.21, Reef Star (1.1 m), canopy solved for a 75 % cut in period light with the
default north–south length (target plus the noon sun's reach), and the default 80 % cloth (sized so the sun
reaches the corals only through it above 10° elevation). Direct sun: hours per day with at least half the beam
reaching a point, mean over the Reef Star / at its center; never sunlit: share of the Reef Star with < 0.1 h of
direct sun every day.

| ω₀ | Height (m) | Canopy E–W × N–S (m) | Direct sun, mean / center (h d⁻¹) | Never sunlit | Cloth (m) | Cloth T |
|---|---|---|---|---|---|---|
| 0.7 | 0.5 | 1.01 × 1.27 | 3.9 / 2.6 | 0 % | 2.15 × 1.51 | 0.24 |
| 0.7 | 0.75 | 1.36 × 1.35 | 4.0 / 3.6 | 0 % | 2.68 × 1.71 | 0.26 |
| 0.7 | 1 | 1.85 × 1.44 | 3.7 / 3.4 | 0 % | 3.20 × 1.91 | 0.28 |
| 0.7 | 1.5 | 4.05 × 1.61 | 1.5 / 0.3 | 4 % | 4.26 × 2.32 | 0.31 |
| 0.7 | 2 | not reachable (12 m: T 0.29) | – | – | 5.31 × 2.73 | 0.33 |
| 0.7 | 3 | not reachable (12 m: T 0.37) | – | – | 7.41 × 3.54 | 0.36 |
| 0.85 | 0.5 | 1.20 × 1.27 | 2.8 / 0.8 | 0 % | 2.15 × 1.51 | 0.28 |
| 0.85 | 0.75 | 1.87 × 1.35 | 2.0 / 0.3 | 0 % | 2.68 × 1.71 | 0.31 |
| 0.85 | 1 | 4.64 × 1.44 | 0.7 / 0.0 | 56 % | 3.20 × 1.91 | 0.34 |
| 0.85 | 1.5 | not reachable (12 m: T 0.33) | – | – | 4.26 × 2.32 | 0.38 |
| 0.85 | 2 | not reachable (12 m: T 0.39) | – | – | 5.31 × 2.73 | 0.41 |
| 0.85 | 3 | not reachable (12 m: T 0.48) | – | – | 7.41 × 3.54 | 0.44 |

**Reading.**

- Keep structures low. The canopy needed for a 75 % cut grows steeply with height (ω₀ 0.7: 1.01 m at 0.5 m,
  4.05 m at 1.5 m), because a higher canopy blocks less of the scattered light from the sides. Above 1.5–2 m
  (ω₀ 0.7) or 1–1.5 m (ω₀ 0.85) no canopy of the default north–south length reaches 75 %; it must also be
  longer north–south.
- A wide canopy is constant shade again. Under higher or wider canopies the corals lose their direct sun
  (ω₀ 0.85, 1 m: 0.65 h d⁻¹ on average, 56 % of the Reef Star never sunlit), which defeats the purpose of
  dynamic shading.
- Cloth rating is not shade. An 80 % cloth sized to cover the sun's path transmits 0.24–0.28 of open-water
  light at 0.5 m and 0.36–0.44 at 3 m.
- At Sipaway's Kd and the ω₀ that fits the canopy readings (0.85), v5 sizes the canopy for a 75 % cut at
  1.87 m east–west at 0.75 m height; the canopy built at Sipaway was 1.88 m (with 2.0 m north–south rather than
  1.35 m).
- The fast engine over-predicts shade light at 1.5–2 m by up to 0.037 (section 2), so the feasibility limits
  above are conservative; confirm with `DesignResult.mc_check()` before publishing them.

## 5. Refraction cap and clearance rule

Under a flat sea, refracted sunlight is never more than 48.3° from vertical (tan 48.3° = 1.12). A canopy's
shadow therefore moves at most 1.12 H from the point below its edge. For a target of radius R to pass from
fully sunlit to fully shaded, H must satisfy H (tan θ_lit − tan θ_shade) ≥ 2R; since tan θ < 1.12, any full
clearance needs H ≥ 1.78 R (0.98 m for a Reef Star). The app's example rule (fully sunlit 4 h before noon,
fully shaded from 2 h before noon, first day) gives 2.56 m for Sipaway. Waves relax the cap (facets refract
light beyond 48.3°), which is why the app counts direct-sun hours per point rather than relying on the rule.

## 6. Research item: shadow-volume correction

The engine's errors share a cause: it treats light arriving at a point from a direction that misses the panel
as open-water light, but part of that light was scattered from water inside the panel's shadow, where there is
no direct sun to scatter. The error grows with height (more shadowed water in view) and with ω₀.

A correction: for each viewing direction, compute the fraction of the path within about one scattering length
(1/b) that lies inside the shadow volume (the prism below the panel along the refracted sun direction), and
remove that fraction of the single-scattered sunlight from the direction's radiance. The single-scattered share
and its build-up with distance can be tallied in the existing forward Monte Carlo. This would remove most of
the +0.01 to +0.04 bias, at a cost of one extra ray–prism test per direction. Test against the 21 Monte Carlo
cases; adopt if the shade errors at 2 m fall below 0.01 without slowing the app noticeably.

## 7. Water scattering (ω₀): recommendation

ω₀ changes the period transmission more than any other input (Sipaway: 0.21 at ω₀ 0.5 to 0.40 at 0.9) and is
rarely measured. One turbid site (Kd 0.21) fits 0.85–0.9; clear reef water is expected to scatter less relative
to absorption. Options:

1. Keep 0.7 as the default with the 0.5–0.9 robustness band (current).
2. Default 0.8 (considered in decision 5), closer to the one measured site.
3. Tie the default to Kd (for example 0.7 at Kd ≤ 0.1, rising to 0.85 at Kd ≥ 0.2) once a second site is
   measured.

**[needs you]** Recommended: option 1 now, with the calibration from one under/open reading (deferred feature,
decision 24) as the next feature, because it replaces the guess with a site measurement. Revisit the default
after a second site.

## 8. Field validation campaign

Protocol: `docs/field_protocol.md`. To support the paper's claims beyond one site: three sites spanning Kd
0.05–0.3; at each, one canopy at two heights (0.5 and 1.0 m); under/open readings at the center and four edges
at 3 h before noon, noon and 3 h after; Kd at two depths; cloth transmission clean and fouled. This tests the
model across ω₀ and height and gives ω₀ for each water type.

## 9. Draft figure captions

**Fig. 2** Accuracy of the fast light engine and a field check. **a** Transmission (light at the point ÷ open
water at the same depth) from the fast engine against an independent 3-D Monte Carlo of the actual structure,
for 126 points in 21 cases (three sun positions, six points, seven structure–water combinations). **b**
Error (fast − Monte Carlo) with ± 2 SE of the Monte Carlo; grey band, the accuracy limits enforced by the
tests. **c** Light under the structures ÷ open water around solar noon on 22 May 2025 at Sipaway (Kd 0.21 m⁻¹,
10 m) against water scattering (ω₀): lines, model mean over the Reef Star; bands, range over the Reef Star;
diamonds and dashed lines, measured (mean ± SD, n = 4 structures; cloth after cleaning). The cloth model uses
its rated transmission (0.20).

**Fig. 3** Design of shade structures against height above the corals (Sipaway, 28 April–8 August 2025,
Kd 0.21 m⁻¹, 10 m, Reef Star 1.1 m; light ω₀ 0.7, dark ω₀ 0.85). **a** East–west width of an opaque canopy
that cuts period light by 75 %, with the default north–south length; ×, no width up to 12 m reaches the
target. **b** Direct sun on the corals under that canopy (hours per day with at least half the beam reaching a
point; solid, Reef Star mean; dashed, center). **c** Period light under an 80 % shade cloth sized so that the
sun reaches the corals only through it above 10° elevation.
