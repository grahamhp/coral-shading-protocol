// Compute pipeline: inputs -> results for the interface. Pure (no DOM); runs in a worker.
import type { Tables, Water } from "../core/engine.ts";
import { opticalState } from "../core/engine.ts";
import { type Panel, type Target, panel, targetGrid } from "../core/geometry.ts";
import { type HourlyLight, utcOffsetFromLon } from "../core/surface.ts";
import { solarNoon } from "../core/solar.ts";
import { type Day, type Site, type PeriodResult, type Contrast, deploymentDays, constantScenario, solveDynamic, runPeriod, periodFor, clothTauDays,
  transmission, directSunHours, dliPerDay, dliOpenPerDay, clearanceCheck, robustness, biology, beamShare, noonContrast, contrastWarning,
  tideReference } from "../core/scenarios.ts";
import { type PresetFile, type Acclimation, type Coral, coralFromPreset } from "../core/pe.ts";
import { type Fouling, kdSeriesFromCsv, tideFromCsv, cleanDatesFromText } from "../core/conditions.ts";

export type ScenarioChoice = "constant" | "dynamic" | "both";

export interface Inputs {
  site: { name: string; lat: number; lon: number; tz: number };
  start: Day; end: Day;
  target: Target;
  depth: number; height: number;
  water: { kd: number; w0: number; w0Lo: number; w0Hi: number };   // w0 for the design; range shown with results
  scenario: ScenarioChoice;
  sync: boolean;                       // dynamic sized to give the cloth's light
  clothRating: number;                 // % blocked (simple mode): tau = 1 - rating/100
  tauClean?: number; tauFouled?: number; fouledShare?: number;   // expert (fouledShare: older fixed share of time fouled)
  fouling?: { tauClean: number; tauFouled: number; daysToFoul: number; cleanEvery: number; cleanDates: string } | null;   // timeline
  kdSeriesText?: string | null;        // 'date, Kd' rows (Kd by date), or null
  tideText?: string | null;            // 'local date time, level (m)' rows, or null
  clothSize?: { lx: number; ly: number } | null;                  // null = automatic
  dynamicTargetReduction: number;      // % (used when not synced, or when the scenario is dynamic only)
  canopy?: { lx: number; ly: number; cx: number; cy: number; rot: number } | null;   // null = solve
  noonShift: number;                   // minutes
  wind: number | null;                 // null = from the light data
  coral: { preset: string; acclimate: Acclimation; ek?: number; rOverPg?: number | null };
  gridSpacing: number;                 // m, full resolution
}

export interface ScenarioOut {
  kind: "constant" | "dynamic";
  panel: Panel;
  T: number;                           // period transmission
  dliMean: number;                     // area mean over days, mol m-2 d-1
  pointDli: number[];                  // period-mean daily light per point
  pointSunHours: number[];             // mean direct-sun hours per day per point
  dayReduction: { mean: number; min: number; max: number }[];  // per day, %
  dayCurve: { mean: number[]; center: number[]; east: number[]; west: number[] };   // first day, umol m-2 s-1
  dayCurves: { mean: number[][]; center: number[][]; east: number[][]; west: number[][] };   // every day [day][step]
  lightHist?: number[];                // hours per day in each light bin (area mean), bins 0..histMax
  bio: Record<string, number>;
  bioDaily: { grossVsOpen: number[]; prDaily: number[] | null };   // per day, area mean
  bioFirst: Record<string, number> | null;   // the same metrics before the corals adjust to the shade (Ek as in open water
                                             // at this depth); null when the chosen acclimation already means that
  ek: number;
  clearance?: { share: number; hRule: number; hRuleDay: Day; hMin: number; never: number[] };
  contrast?: Contrast;                 // light at noon and in the morning and afternoon, shares of open water
  robustness?: { case: string; T: number }[];
  w0Range?: [number, number];          // period transmission at the low and high end of the w0 range (same structure)
  tauDays?: number[] | null;           // cloth transmission by day (fouling)
  solve?: { feasible: boolean; message: string; iterations: number };
}

export interface Results {
  level: "preview" | "full" | "robust";
  ms: number;
  days: Day[];
  points: number[];                    // interleaved x, y
  spacing: number;
  open: { dliMean: number; dayDli: number[]; dayCurve: number[]; dayCurves: number[][]; lightHist: number[];
    dayBeamShare: number[];            // per day: share of the open-water light at depth that arrives as the sun beam
    bio: Record<string, number>;       // the coral metrics for unshaded corals at this depth
    bioFirst: Record<string, number> | null };   // the same with Ek as in open water throughout (the baseline for bioFirst)
  clothOptions?: ClothOption[] | null; // other shade ratings on the same cloth (null: not available)
  canopyOptions?: CanopyOption[] | null;   // other canopy widths (expert)
  noons: number[];                     // solar noon per day, minutes
  histMax: number;                     // upper edge of the light histogram, umol m-2 s-1
  lightNotes: string[];                // problems with the light data or the UTC offset (shown first)
  minutes: number[];
  noon: number;
  scenarios: ScenarioOut[];
  warnings: string[];
  timings: Record<string, number>;
  beamShare: number;                   // share of the open-water light at depth that arrives as the sun beam
  kdDays: number[];                    // Kd used on each day
  depthNoon: number[] | null;          // coral depth at solar noon on each day (tide), or null
}

/** One row of the shade-rating comparison: the same cloth with another rating (light is exactly linear in it). */
export interface ClothOption { rating: number; tau: number; T: number; dliMean: number; grossVsOpen: number; prDaily: number | null;
  hoursSaturated: number; hoursBelowEc: number | null; current: boolean;
  first: { grossVsOpen: number; prDaily: number | null; hoursSaturated: number } | null }   // before the corals adjust (see bioFirst)
/** One row of the canopy-width comparison (10 cm grid). */
export interface CanopyOption { lx: number; ly: number; T: number; noon: number; side: number; current: boolean }

export interface Data { tables: Tables; presets: PresetFile; light: HourlyLight }

const nearestIdx = (pts: Float64Array, x: number, y: number) => {
  let best = 0, bd = Infinity;
  for (let p = 0; p < pts.length / 2; p++) { const d = (pts[2 * p]! - x) ** 2 + (pts[2 * p + 1]! - y) ** 2; if (d < bd) { bd = d; best = p; } }
  return best;
};

function summarizeScenario(kind: "constant" | "dynamic", pan: Panel, r: PeriodResult, pts: Float64Array, coral: Coral, target: Target): ScenarioOut {
  const dli = dliPerDay(r), open = dliOpenPerDay(r), nP = r.nPoints, nD = r.days.length;
  const pointDli = new Array<number>(nP).fill(0), pointSun = new Array<number>(nP).fill(0);
  const sun = directSunHours(r);
  dli.forEach((d) => d.forEach((v, p) => (pointDli[p] = pointDli[p]! + v / nD)));
  sun.forEach((d) => d.forEach((v, p) => (pointSun[p] = pointSun[p]! + v / nD)));
  const dayReduction = dli.map((d, i) => {
    let s = 0, mn = Infinity, mx = -Infinity;
    for (const v of d) { s += v; mn = Math.min(mn, v); mx = Math.max(mx, v); }
    return { mean: 100 * (1 - s / nP / open[i]!), min: 100 * (1 - mx / open[i]!), max: 100 * (1 - mn / open[i]!) };
  });
  const day0 = r.ed[0]!;
  const half = target.lx / 2;
  const iC = nearestIdx(pts, 0, 0), iE = nearestIdx(pts, 0.9 * half, 0), iW = nearestIdx(pts, -0.9 * half, 0);
  const dayCurve = { mean: day0.map((row) => row.reduce((a, b) => a + b, 0) / nP), center: day0.map((row) => row[iC]!),
    east: day0.map((row) => row[iE]!), west: day0.map((row) => row[iW]!) };
  const rowMean = (row: Float64Array) => { let s = 0; for (let p = 0; p < nP; p++) s += row[p]!; return s / nP; };
  const dayCurves = { mean: r.ed.map((day) => day.map(rowMean)), center: r.ed.map((day) => day.map((row) => row[iC]!)),
    east: r.ed.map((day) => day.map((row) => row[iE]!)), west: r.ed.map((day) => day.map((row) => row[iW]!)) };
  const b = biology(r, coral);
  const fc = firstCoral(coral);
  const bioFirst = fc ? biology(r, fc).mean : null;
  const bioDaily = { grossVsOpen: b.daily.map((x) => x.grossVsOpen ?? NaN), prDaily: b.daily[0]?.prDaily !== undefined ? b.daily.map((x) => x.prDaily!) : null };
  return { kind, panel: pan, T: transmission(r), dliMean: pointDli.reduce((a, v) => a + v, 0) / nP, pointDli, pointSunHours: pointSun,
    dayReduction, dayCurve, dayCurves, bio: b.mean, bioDaily, bioFirst, ek: b.ek.reduce((a, v) => a + v, 0) / b.ek.length };
}

const now = () => (typeof performance !== "undefined" ? performance.now() : Date.now());

/** The coral before it adjusts to the shade: Ek as acclimated to open water at this depth. Null when the chosen
 *  acclimation is already that, or the coral's sources give no growth light (Ek stays as measured). */
function firstCoral(coral: Coral): Coral | null {
  return coral.ekEmax && (coral.acclimate === "time" || coral.acclimate === "shade") ? { ...coral, acclimate: "site" } : null;
}

// The full-resolution cloth run is kept (in the worker) until the shade-rating comparison has been made from it.
let kept: { result: PeriodResult; tauDays: number[] | null; tauClean: number; coral: Coral } | null = null;
export const SHADE_RATINGS = [30, 50, 70, 80, 90];

/** The same cloth with other shade ratings. Light under a cloth is exactly linear in its transmission
 *  (E = E_opaque + tau (E_open - E_opaque), as periodFor), so no new light run is needed; the coral metrics are
 *  recomputed for each rating. Fouling keeps its share: each day's transmission scales with the clean value. */
export function computeClothOptions(inp: Inputs): ClothOption[] | null {
  const k = kept; kept = null;
  if (!k || !(k.tauClean < 0.98)) return null;
  const r = k.result, cur = Math.round(100 * (1 - k.tauClean));
  const ratings = [...new Set([...SHADE_RATINGS, cur])].sort((a, b) => a - b);
  // light with the cloth opaque, from the run with the cloth as designed
  const opq = r.ed.map((day, i) => { const t = k.tauDays ? k.tauDays[i]! : k.tauClean, eo = r.edOpen[i]!;
    return day.map((row, s) => row.map((v) => Math.max(0, (v - t * eo[s]!) / (1 - t)))); });
  const out: ClothOption[] = [];
  for (const rating of ratings) {
    const tau = 1 - rating / 100, isCur = rating === cur && Math.abs(tau - k.tauClean) < 1e-9;
    const ed = opq.map((day, i) => { const t = k.tauDays ? (k.tauDays[i]! * tau) / k.tauClean : tau, eo = r.edOpen[i]!;
      return day.map((row, s) => row.map((v) => v + t * (eo[s]! - v))); });
    const pr: PeriodResult = { ...r, ed };
    const b = biology(pr, k.coral).mean;
    const fc = firstCoral(k.coral), f = fc ? biology(pr, fc).mean : null;
    let dl = 0; for (const d of dliPerDay(pr)) dl += d.reduce((a, v) => a + v, 0) / r.nPoints;
    out.push({ rating, tau, T: transmission(pr), dliMean: dl / r.days.length, grossVsOpen: b.grossVsOpen ?? NaN, prDaily: b.prDaily ?? null,
      hoursSaturated: b.hoursSaturated ?? NaN, hoursBelowEc: b.prDaily !== undefined ? (b.hoursBelowEc ?? 0) : null, current: isCur,
      first: f ? { grossVsOpen: f.grossVsOpen ?? NaN, prDaily: f.prDaily ?? null, hoursSaturated: f.hoursSaturated ?? NaN } : null });
  }
  void inp;
  return out;
}

/** Other canopy widths around the designed one (10 cm grid, every day): light over the deployment and its timing. */
export function computeCanopyOptions(inp: Inputs, data: Data, pan: Panel): CanopyOption[] {
  const site = siteFrom(inp, data), all = deploymentDays(inp.start, inp.end, 1);
  const water: Water = { kd: inp.water.kd, w0: inp.water.w0, depth: inp.depth };
  const pts = targetGrid(inp.target, 0.1), wind = inp.wind ?? undefined;
  const st = opticalState(water, data.tables);
  return [0.6, 0.8, 1, 1.25, 1.5].map((f) => {
    const p = { ...pan, lx: pan.lx * f };
    const r = runPeriod(site, water, [p], pts, all, data.tables, 16, wind, st), c = noonContrast(r, site);
    return { lx: p.lx, ly: p.ly, T: transmission(r), noon: c.noon, side: c.side, current: f === 1 };
  });
}

/** The site with its light data and, when given, Kd by date and the tide (mean level over the whole deployment). */
export function siteFrom(inp: Inputs, data: Data): Site {
  const site: Site = { lat: inp.site.lat, lon: inp.site.lon, tz: inp.site.tz, light: data.light, noonShift: inp.noonShift, step: 10 };
  if (inp.kdSeriesText) site.kdSeries = kdSeriesFromCsv(inp.kdSeriesText);
  if (inp.tideText) { site.tide = tideFromCsv(inp.tideText); site.tideRef = tideReference(site.tide, inp.start, inp.end); }
  return site;
}

export function foulingFrom(inp: Inputs): Fouling | null {
  const f = inp.fouling;
  return f ? { tauClean: f.tauClean, tauFouled: f.tauFouled, daysToFoul: f.daysToFoul, cleanEvery: Math.round(f.cleanEvery), cleanDates: cleanDatesFromText(f.cleanDates ?? "") } : null;
}

export function compute(inp: Inputs, data: Data, level: "preview" | "full" | "robust", guess?: number): Results {
  const t0 = now();
  const warnings: string[] = [];
  const tm: Record<string, number> = {};
  let tl = t0;
  const lap = (k: string) => { const t = now(); tm[k] = (tm[k] ?? 0) + t - tl; tl = t; };
  const all = deploymentDays(inp.start, inp.end, 1);
  if (all.length === 0) throw new Error("The deployment ends before it starts.");
  const site = siteFrom(inp, data);
  const fouling = foulingFrom(inp);
  const every = level === "preview" ? Math.max(1, Math.ceil(all.length / 10)) : 1;
  const days = all.filter((_, i) => i % every === 0);
  const spacing = level === "preview" ? Math.max(inp.gridSpacing, 0.15) : inp.gridSpacing;
  const nFacets = level === "preview" ? 8 : 16;
  const water: Water = { kd: inp.water.kd, w0: inp.water.w0, depth: inp.depth };
  if (inp.height >= inp.depth) warnings.push("The structure is above the water surface; refraction at the surface is included.");
  if (inp.height > 1.5) warnings.push("For structures more than 1.5 m above the corals the fast light engine can over-predict light in the shade by up to 4 % of open-water light. Check important designs with the Python package's Monte Carlo.");
  const st = opticalState(water, data.tables);
  const pts = targetGrid(inp.target, spacing);
  const presetCoral = coralFromPreset(data.presets, inp.coral.preset, inp.coral.acclimate);
  const coral: Coral = { ...presetCoral, ek: inp.coral.ek ?? presetCoral.ek,
    rOverPg: inp.coral.rOverPg !== undefined ? inp.coral.rOverPg : presetCoral.rOverPg ?? null };
  const wind = inp.wind ?? undefined;
  const out: ScenarioOut[] = [];
  let openRes: PeriodResult | null = null;
  const runs: PeriodResult[] = [];
  let Tc: number | null = null;
  if (inp.scenario !== "dynamic") {
    const tauC = fouling ? fouling.tauClean : inp.tauClean ?? 1 - inp.clothRating / 100;
    const cloth = inp.clothSize ? panel({ lx: inp.clothSize.lx, ly: inp.clothSize.ly, height: inp.height, tau: tauC }) : undefined;
    const cs = constantScenario(site, water, inp.target, inp.height, days, data.tables, tauC, inp.tauFouled, inp.fouledShare ?? 0, cloth, spacing, nFacets, wind, fouling);
    lap("constant run");
    const so = summarizeScenario("constant", cs.panel, cs.result, pts, coral, inp.target);
    so.contrast = noonContrast(cs.result, site);
    so.tauDays = cs.tauDays;
    runs.push(cs.result);
    Tc = so.T; openRes = cs.result;
    kept = level === "full" && !inp.clothSize ? { result: cs.result, tauDays: cs.tauDays, tauClean: tauC, coral } : null;
    lap("constant summary");
    out.push(so);
  }
  if (inp.scenario !== "constant") {
    let pan: Panel;
    let solve: ScenarioOut["solve"];
    if (inp.canopy) {
      pan = panel({ lx: inp.canopy.lx, ly: inp.canopy.ly, cx: inp.canopy.cx, cy: inp.canopy.cy, rotDeg: inp.canopy.rot, height: inp.height, tau: 0 });
    } else {
      const targetT = inp.sync && Tc !== null ? Tc : 1 - inp.dynamicTargetReduction / 100;
      // every day of the run, on the reported grid (as Python), so the period light matches the target
      const s = solveDynamic(site, water, inp.target, inp.height, days, data.tables, targetT,
        { spacing, nFacets, solveEvery: 1, ...(wind !== undefined ? { wind } : {}), ...(guess ? { guess } : {}) });
      pan = s.panel;
      solve = { feasible: s.feasible, message: s.message, iterations: s.iterations };
      lap("solve");
      if (!s.feasible) warnings.push(s.message);
    }
    const r = runPeriod(site, water, [pan], pts, days, data.tables, nFacets, wind, st);
    lap("dynamic run");
    const so = summarizeScenario("dynamic", pan, r, pts, coral, inp.target);
    runs.push(r);
    lap("dynamic summary");
    if (solve) so.solve = solve;
    const chk = clearanceCheck(r, inp.target, inp.height, site);
    so.clearance = { share: chk.shareNeverSunlit, hRule: chk.hForSunBy0800ShadeFrom1000, hRuleDay: chk.hRuleDay, hMin: chk.hMinAny, never: Array.from(chk.neverSunlit) };
    so.contrast = noonContrast(r, site);
    if (chk.shareNeverSunlit > 0)
      warnings.push(`${Math.round(100 * chk.shareNeverSunlit)} % of the coral area never has the sun in line under the canopy. A canopy about ${chk.hForSunBy0800ShadeFrom1000.toFixed(1)} m above the corals would let the morning sun reach all of it on every day.`);
    const cw = contrastWarning(so.contrast, beamShare(r), inp.depth);
    if (cw) warnings.push(cw);
    openRes = openRes ?? r;
    out.push(so);
  }
  const o = openRes!;
  const openD = Array.from(dliOpenPerDay(o));
  const [y, m, d] = days[0]!;
  // time spent at each light level (hours per day, area mean), for the coral-response chart
  let histMax = 1;
  for (const day of o.edOpen) for (const v of day) if (v > histMax) histMax = v;
  const NB = 48, bw = histMax / NB, stepH = o.step / 60, nD = days.length;
  const openHist = new Array<number>(NB).fill(0);
  for (const day of o.edOpen) for (const v of day) if (v > 1) openHist[Math.min(NB - 1, Math.floor(v / bw))]! += stepH / nD;
  runs.forEach((rr, i) => {
    const hist = new Array<number>(NB).fill(0), w = stepH / (nD * rr.nPoints);
    const nPP = rr.nPoints;
    for (const day of rr.ed) for (const row of day) for (let p = 0; p < nPP; p++) { const v = row[p]!; if (v > 1) hist[Math.min(NB - 1, Math.floor(v / bw))]! += w; }
    out[i]!.lightHist = hist;
  });
  // unshaded corals at this depth: the same metrics, from the open-water light (one point)
  const openOnly: PeriodResult = { ...o, ed: o.edOpen.map((dd) => Array.from(dd, (v) => Float64Array.of(v))), nPoints: 1,
    sunlit: o.edOpen.map((dd) => Array.from(dd, () => Float64Array.of(1))) };
  const openBio = biology(openOnly, coral).mean;
  const fc0 = firstCoral(coral), openBioFirst = fc0 ? biology(openOnly, fc0).mean : null;
  const dayBeamShare = o.beamOpen.map((bd, i) => { let b = 0, e = 0; for (const v of bd) b += v; for (const v of o.edOpen[i]!) e += v; return e > 0 ? b / e : 0; });
  if (inp.scenario === "dynamic") kept = null;
  return {
    level, ms: now() - t0, days, points: Array.from(pts), spacing,
    open: { dliMean: openD.reduce((a, b) => a + b, 0) / openD.length, dayDli: openD, dayCurve: Array.from(o.edOpen[0]!),
      dayCurves: o.edOpen.map((dd) => Array.from(dd)), lightHist: openHist, dayBeamShare, bio: openBio, bioFirst: openBioFirst },
    minutes: Array.from(o.minutes[0]!), noon: solarNoon(y, m, d, inp.site.lon, inp.site.tz) + inp.noonShift,
    noons: days.map(([yy, mm, dd]) => solarNoon(yy, mm, dd, inp.site.lon, inp.site.tz) + inp.noonShift), histMax,
    scenarios: out, warnings, timings: tm, beamShare: beamShare(o), kdDays: o.kdDays ?? days.map(() => inp.water.kd),
    depthNoon: o.depthSteps && o.depthSteps.length ? o.depthSteps.map((z, i) => {
      const nn = solarNoon(days[i]![0], days[i]![1], days[i]![2], inp.site.lon, inp.site.tz) + inp.noonShift;
      return z[Math.min(z.length - 1, Math.max(0, Math.floor(nn / o.step)))]!; }) : null,
    lightNotes: lightWarnings(data.light, inp.site.lon, inp.site.tz, inp.start, Math.max(0, ...runs.map((rr) => rr.lightDropped ?? 0))),
  };
}

/** Plain-language warnings about the light data and the UTC offset (as design.light_warnings in Python). */
export function lightWarnings(h: HourlyLight, lon: number, tz: number, start: Day, dropped: number): string[] {
  const out: string[] = [];
  if (h.database.startsWith("clear sky"))
    out.push("Light data: clear-sky estimate (no clouds). Real weather gives less daily light, more of it diffuse, so this "
      + "overstates daily light and coral photosynthesis. Load the PVGIS typical year for this site before building.");
  if (dropped > 0.01)
    out.push(`${(100 * dropped).toFixed(0)} % of the light in the data falls in hours when the sun is down or too low at this site, `
      + "so the data do not match the site. That light was left out.");
  const noon = solarNoon(start[0], start[1], start[2], lon, tz);
  if (Math.abs(noon - 720) > 180) {
    const hh = ((noon % 1440) + 1440) % 1440, sg = (v: number) => (v >= 0 ? `+${v}` : `${v}`);
    out.push(`Solar noon is at ${String(Math.floor(hh / 60)).padStart(2, "0")}:${String(Math.floor(hh % 60)).padStart(2, "0")} with UTC${sg(tz)}. `
      + `Check the UTC offset: UTC${sg(utcOffsetFromLon(lon))} fits this longitude.`);
  }
  return out;
}

/** Third stage: the designs are fixed; conditions vary. Robustness table (10 cm grid) and the w0 range (the reported grid). */
export function computeRobustness(inp: Inputs, data: Data, panels: { constant?: Panel; dynamic?: Panel }):
  Record<string, { rows: { case: string; T: number }[]; range: [number, number] }> {
  const site = siteFrom(inp, data);
  const all = deploymentDays(inp.start, inp.end, 1);
  const water: Water = { kd: inp.water.kd, w0: inp.water.w0, depth: inp.depth };
  const lo = Math.min(inp.water.w0Lo, inp.water.w0Hi), hi = Math.max(inp.water.w0Lo, inp.water.w0Hi);
  const pts10 = targetGrid(inp.target, 0.1), pts = targetGrid(inp.target, inp.gridSpacing), wind = inp.wind ?? undefined;
  const fouling = foulingFrom(inp);
  const out: Record<string, { rows: { case: string; T: number }[]; range: [number, number] }> = {};
  for (const [k, p] of Object.entries(panels)) {
    if (!p) continue;
    const td = k === "constant" ? clothTauDays(all, p.tau, inp.tauFouled, inp.fouledShare ?? 0, fouling) : null;
    const rows = robustness(site, water, [p], pts10, all, data.tables, 16, [0.5, 1.5], [lo, hi], [0, 10], 0.2, 1, td);
    const T = (w0: number) => transmission(periodFor(site, { ...water, w0 }, [p], pts, all, data.tables, 16, wind, td));
    out[k] = { rows, range: [T(lo), T(hi)] };
  }
  return out;
}
