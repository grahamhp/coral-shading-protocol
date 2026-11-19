// Compute pipeline: inputs -> results for the interface. Pure (no DOM); runs in a worker.
import type { Tables, Water } from "../core/engine.ts";
import { opticalState } from "../core/engine.ts";
import { type Panel, type Target, panel, targetGrid } from "../core/geometry.ts";
import { type HourlyLight, utcOffsetFromLon } from "../core/surface.ts";
import { solarNoon } from "../core/solar.ts";
import { type Day, type Site, type PeriodResult, type Contrast, deploymentDays, constantScenario, solveDynamic, runPeriod, transmission,
  directSunHours, dliPerDay, dliOpenPerDay, clearanceCheck, robustness, biology, beamShare, noonContrast, contrastWarning } from "../core/scenarios.ts";
import { type PresetFile, type Acclimation, type Coral, coralFromPreset } from "../core/pe.ts";

export type ScenarioChoice = "constant" | "dynamic" | "both";

export interface Inputs {
  site: { name: string; lat: number; lon: number; tz: number };
  start: Day; end: Day;
  target: Target;
  depth: number; height: number;
  water: { kd: number; w0: number };
  scenario: ScenarioChoice;
  sync: boolean;                       // dynamic sized to give the cloth's light
  clothRating: number;                 // % blocked (simple mode): tau = 1 - rating/100
  tauClean?: number; tauFouled?: number; fouledShare?: number;   // expert
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
  ek: number;
  clearance?: { share: number; hRule: number; hRuleDay: Day; hMin: number; never: number[] };
  contrast?: Contrast;                 // light at noon and in the morning and afternoon, shares of open water
  robustness?: { case: string; T: number }[];
  solve?: { feasible: boolean; message: string; iterations: number };
}

export interface Results {
  level: "preview" | "full" | "robust";
  ms: number;
  days: Day[];
  points: number[];                    // interleaved x, y
  spacing: number;
  open: { dliMean: number; dayDli: number[]; dayCurve: number[]; dayCurves: number[][]; lightHist: number[] };
  noons: number[];                     // solar noon per day, minutes
  histMax: number;                     // upper edge of the light histogram, umol m-2 s-1
  lightNotes: string[];                // problems with the light data or the UTC offset (shown first)
  minutes: number[];
  noon: number;
  scenarios: ScenarioOut[];
  warnings: string[];
  timings: Record<string, number>;
  beamShare: number;                   // share of the open-water light at depth that arrives as the sun beam
}

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
  return { kind, panel: pan, T: transmission(r), dliMean: pointDli.reduce((a, v) => a + v, 0) / nP, pointDli, pointSunHours: pointSun,
    dayReduction, dayCurve, dayCurves, bio: b.mean, ek: b.ek[0]! };
}

const now = () => (typeof performance !== "undefined" ? performance.now() : Date.now());

export function compute(inp: Inputs, data: Data, level: "preview" | "full" | "robust", guess?: number): Results {
  const t0 = now();
  const warnings: string[] = [];
  const tm: Record<string, number> = {};
  let tl = t0;
  const lap = (k: string) => { const t = now(); tm[k] = (tm[k] ?? 0) + t - tl; tl = t; };
  const site: Site = { lat: inp.site.lat, lon: inp.site.lon, tz: inp.site.tz, light: data.light, noonShift: inp.noonShift, step: 10 };
  const all = deploymentDays(inp.start, inp.end, 1);
  if (all.length === 0) throw new Error("The deployment ends before it starts.");
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
    const tauC = inp.tauClean ?? 1 - inp.clothRating / 100;
    const cloth = inp.clothSize ? panel({ lx: inp.clothSize.lx, ly: inp.clothSize.ly, height: inp.height, tau: tauC }) : undefined;
    const cs = constantScenario(site, water, inp.target, inp.height, days, data.tables, tauC, inp.tauFouled, inp.fouledShare ?? 0, cloth, spacing, nFacets, wind);
    lap("constant run");
    const so = summarizeScenario("constant", cs.panel, cs.result, pts, coral, inp.target);
    so.contrast = noonContrast(cs.result, site);
    runs.push(cs.result);
    Tc = so.T; openRes = cs.result;
    lap("constant summary");
    if (level === "robust") so.robustness = robustness(site, water, [cs.panel], targetGrid(inp.target, 0.1), all, data.tables, 16, [0.5, 1.5], [0.5, 0.9], [0, 10], 0.2, 1);
    lap("robustness");
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
    if (level === "robust") so.robustness = robustness(site, water, [pan], targetGrid(inp.target, 0.1), all, data.tables, 16, [0.5, 1.5], [0.5, 0.9], [0, 10], 0.2, 1);
    lap("robustness");
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
  return {
    level, ms: now() - t0, days, points: Array.from(pts), spacing,
    open: { dliMean: openD.reduce((a, b) => a + b, 0) / openD.length, dayDli: openD, dayCurve: Array.from(o.edOpen[0]!),
      dayCurves: o.edOpen.map((dd) => Array.from(dd)), lightHist: openHist },
    minutes: Array.from(o.minutes[0]!), noon: solarNoon(y, m, d, inp.site.lon, inp.site.tz) + inp.noonShift,
    noons: days.map(([yy, mm, dd]) => solarNoon(yy, mm, dd, inp.site.lon, inp.site.tz) + inp.noonShift), histMax,
    scenarios: out, warnings, timings: tm, beamShare: beamShare(o),
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

/** Robustness only (third stage): the designs are fixed; conditions vary. */
export function computeRobustness(inp: Inputs, data: Data, panels: { constant?: Panel; dynamic?: Panel }): Record<string, { case: string; T: number }[]> {
  const site: Site = { lat: inp.site.lat, lon: inp.site.lon, tz: inp.site.tz, light: data.light, noonShift: inp.noonShift, step: 10 };
  const all = deploymentDays(inp.start, inp.end, 1);
  const water: Water = { kd: inp.water.kd, w0: inp.water.w0, depth: inp.depth };
  const every = 1, pts = targetGrid(inp.target, 0.1);   // every day
  const out: Record<string, { case: string; T: number }[]> = {};
  for (const [k, p] of Object.entries(panels)) if (p) out[k] = robustness(site, water, [p], pts, all, data.tables, 16, [0.5, 1.5], [0.5, 0.9], [0, 10], 0.2, every);
  return out;
}
