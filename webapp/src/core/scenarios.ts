// Shading scenarios, design solver and checks. Port of python/src/coralshading/scenarios.py (method in its docstring).
import { daysFromCivil, solarPosition, solarNoon, sunWithNoon } from "./solar.ts";
import { refractedZenithDeg } from "./optics.ts";
import { type Panel, type Target, panel, targetGrid } from "./geometry.ts";
import { type HourlyLight, civilFromDays, dayLight } from "./surface.ts";
import { type Tables, type Water, type OpticalState, type Moments, type StepConditions, opticalState, opticalDepthForKd, panelMoments, runDay } from "./engine.ts";
import { type KdSeries, type Tide, type Fouling, kdForDays, tideAt, tideMeanBetween, tideMin, quantizeTau, tauByDay } from "./conditions.ts";
import type { DayLight } from "./surface.ts";
import { type Coral, dayMetrics, effectiveEkByDay } from "./pe.ts";

export interface Site { lat: number; lon: number; tz: number; light: HourlyLight; noonShift?: number; step?: number;
  kdSeries?: KdSeries; tide?: Tide; tideRef?: number }   // v5.1: Kd by date, water level, mean level over the deployment
export type Day = [number, number, number];

export function deploymentDays(start: Day, end: Day, every = 1): Day[] {
  const a = daysFromCivil(...start), b = daysFromCivil(...end), out: Day[] = [];
  for (let k = a; k <= b; k += every) out.push(civilFromDays(k));
  return out;
}

export interface PeriodResult {
  days: Day[]; step: number; ed: Float64Array[][]; edOpen: Float64Array[]; sunlit: Float64Array[][];
  minutes: Float64Array[]; zenith: Float64Array[]; azimuth: Float64Array[]; nPoints: number;
  lightDropped?: number; // share of the hourly light dropped by the timing guard (dayLight)
  beamOpen: Float64Array[];   // per day: sun-beam part of the open-water light
  kdDays?: number[];          // Kd used on each day
  depthSteps?: Float64Array[];// per day: coral depth per step when a tide is given
  tauCloth?: number[];        // per day: cloth transmission when fouling varies
}

export function dliPerDay(r: PeriodResult): Float64Array[] {            // [day] -> per point, mol m-2 d-1
  return r.ed.map((day) => {
    const o = new Float64Array(r.nPoints);
    for (const row of day) for (let p = 0; p < r.nPoints; p++) o[p] = o[p]! + row[p]!;
    return o.map((v) => (v * r.step * 60) / 1e6);
  });
}

export function dliOpenPerDay(r: PeriodResult): Float64Array {
  return Float64Array.from(r.edOpen, (e) => (e.reduce((a, b) => a + b, 0) * r.step * 60) / 1e6);
}

/** Period transmission: area-mean daily light summed over days / open-water daily light summed over days. */
export function transmission(r: PeriodResult): number {
  let num = 0, den = 0;
  for (const d of dliPerDay(r)) num += d.reduce((a, b) => a + b, 0) / r.nPoints;
  for (const v of dliOpenPerDay(r)) den += v;
  return num / den;
}

/** Share of the open-water light at depth, summed over the period, that arrives as the sun beam. */
export function beamShare(r: PeriodResult): number {
  let b = 0, o = 0;
  for (const d of r.beamOpen) for (const v of d) b += v;
  for (const d of r.edOpen) for (const v of d) o += v;
  return o > 0 ? b / o : 0;
}

/** Hours per day with the sun in line (geometric; not a light dose: clouds and scattering are not counted). */
export function directSunHours(r: PeriodResult, threshold = 0.5): Float64Array[] {
  return r.sunlit.map((day) => {
    const o = new Float64Array(r.nPoints);
    for (const row of day) for (let p = 0; p < r.nPoints; p++) if (row[p]! >= threshold) o[p] = o[p]! + r.step / 60;
    return o;
  });
}

// Surface light depends only on the site, data and day, not on the design: cache it (solver iterations reuse it).
const dayCache = new WeakMap<HourlyLight, Map<string, ReturnType<typeof dayLight>>>();
function cachedDayLight(site: Site, y: number, m: number, d: number, step: number, shift: number) {
  let c = dayCache.get(site.light);
  if (!c) { c = new Map(); dayCache.set(site.light, c); }
  const key = `${site.lat}|${site.lon}|${site.tz}|${step}|${shift}|${y}-${m}-${d}`;
  let v = c.get(key);
  if (!v) { v = dayLight(site.light, y, m, d, site.lat, site.lon, site.tz, step, shift); c.set(key, v); }
  return v;
}

/** Mean water level over the deployment (local midnight of the start day to midnight after the end day). */
export function tideReference(tide: Tide, start: Day, end: Day): number {
  return tideMeanBetween(tide, daysFromCivil(...start) * 1440, (daysFromCivil(...end) + 1) * 1440);
}

// water states by (w0, tau), shared across runs (tide and Kd by date reuse them)
const stateCache = new WeakMap<Tables, Map<string, OpticalState>>();
function stateFor(tables: Tables, w0: number, tau: number): OpticalState {
  let c = stateCache.get(tables);
  if (!c) { c = new Map(); stateCache.set(tables, c); }
  const k = `${w0}|${tau}`;
  let v = c.get(k);
  if (!v) { v = opticalState({ kd: 0.1, w0, depth: 1 }, tables, tau); c.set(k, v); }
  return v;
}

/** Light at every point, every step of every day. With site.kdSeries and/or site.tide the water column changes by day
 *  (Kd) and by step (water level); otherwise one water column serves the whole period (as Python run_period). */
export function runPeriod(site: Site, water: Water, panels: readonly Panel[], pts: Float64Array, days: Day[], tables: Tables,
  nFacets = 16, windOverride?: number, state?: OpticalState): PeriodResult {
  const varying = site.kdSeries !== undefined || site.tide !== undefined;
  const st = state && !varying ? state : opticalState(water, tables);
  const mom = panelMoments(pts, panels, water, st.thetaEdges, tables.m_max);
  const step = site.step ?? 10, shift = site.noonShift ?? 0;
  const out: PeriodResult = { days, step, ed: [], edOpen: [], sunlit: [], minutes: [], zenith: [], azimuth: [], nPoints: pts.length / 2, beamOpen: [],
    kdDays: [], depthSteps: [] };
  const kds = site.kdSeries ? kdForDays(site.kdSeries, days) : days.map(() => water.kd);
  let ref = 0;
  if (site.tide) ref = site.tideRef ?? tideReference(site.tide, days[0]!, days[days.length - 1]!);
  let momentsAt: ((z: number) => Moments) | undefined;
  if (site.tide && panels.some((p) => p.height >= water.depth + tideMin(site.tide!) - ref)) {
    const mc = new Map<number, Moments>();
    momentsAt = (z: number) => {
      const zq = Math.floor(z * 100 + 0.5) / 100;
      let m = mc.get(zq);
      if (!m) { m = panelMoments(pts, panels, { ...water, depth: zq }, st.thetaEdges, tables.m_max); mc.set(zq, m); }
      return m;
    };
  }
  let tot = 0, drop = 0;
  days.forEach(([y, m, d], i) => {
    let dl: DayLight = cachedDayLight(site, y, m, d, step, shift);
    tot += dl.lightTotal ?? 0; drop += dl.lightDropped ?? 0;
    if (windOverride !== undefined) dl = { ...dl, wind: new Float64Array(dl.wind.length).fill(windOverride) };
    const kd = kds[i]!;
    let r, depths: Float64Array | undefined;
    if (!varying) r = runDay(dl, water, panels, pts, st, mom, nFacets);
    else {
      const tauMean = opticalDepthForKd({ ...water, kd }, tables);
      if (!site.tide) r = runDay(dl, { ...water, kd }, panels, pts, stateFor(tables, water.w0, tauMean), mom, nFacets);
      else {
        const c = tauMean / water.depth, base = daysFromCivil(y, m, d) * 1440;
        depths = Float64Array.from(dl.minutes, (mn) => water.depth + (tideAt(site.tide!, base + mn) - ref));
        let zmin = Infinity; for (const z of depths) zmin = Math.min(zmin, z);
        if (zmin <= 0.05) throw new Error(`At low tide on ${y}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")} the corals are only ${zmin.toFixed(2)} m deep or dry; check the depth (at mean water level) and the tide series.`);
        const cond: StepConditions = { states: Array.from(depths, (z) => stateFor(tables, water.w0, quantizeTau(c * z))), depths, ...(momentsAt ? { momentsAt } : {}) };
        r = runDay(dl, { ...water, kd }, panels, pts, stateFor(tables, water.w0, tauMean), mom, nFacets, cond);
      }
    }
    out.ed.push(r.ed); out.edOpen.push(r.edOpen); out.sunlit.push(r.sunlit); out.beamOpen.push(r.beamOpen);
    out.minutes.push(dl.minutes); out.zenith.push(dl.zenith); out.azimuth.push(dl.azimuth);
    out.kdDays!.push(kd); if (depths) out.depthSteps!.push(depths);
  });
  out.lightDropped = tot > 0 ? drop / tot : 0;
  return out;
}

/** runPeriod, or with tauDays (one transmission per day for a single panel) the exact linear mix
 *  E(tau) = E(0) + tau (E_open - E(0)) from one run with the panel opaque (as Python period_for). */
export function periodFor(site: Site, water: Water, panels: readonly Panel[], pts: Float64Array, days: Day[], tables: Tables,
  nFacets = 16, windOverride?: number, tauDays?: number[] | null): PeriodResult {
  if (!tauDays) return runPeriod(site, water, panels, pts, days, tables, nFacets, windOverride);
  const opq = runPeriod(site, water, [{ ...panels[0]!, tau: 0 }], pts, days, tables, nFacets, windOverride);
  const ed = opq.ed.map((day, i) => { const t = tauDays[i]!, eo = opq.edOpen[i]!; return day.map((row, k) => row.map((v) => v + t * (eo[k]! - v))); });
  const sunlit = opq.sunlit.map((day, i) => { const t = tauDays[i]!; return day.map((row) => row.map((v) => v + t * (1 - v))); });
  return { ...opq, ed, sunlit, tauCloth: [...tauDays] };
}

/** Cloth transmission by day: fouling timeline, or the fixed share of time fouled (time-weighted tau), or null. */
export function clothTauDays(days: Day[], tauClean: number, tauFouled?: number, fouledShare = 0, fouling?: Fouling | null): number[] | null {
  if (fouling) return tauByDay(fouling, days);
  if (tauFouled !== undefined && fouledShare > 0) { const v = (1 - fouledShare) * tauClean + fouledShare * tauFouled; return days.map(() => v); }
  return null;
}

const halfY = (t: Target) => (t.shape === "rect" ? t.ly : t.lx) / 2;

/** Largest tan(refracted zenith) east-west and north-south over the period for sun elevations above minElevation. */
export function maxRefractedTan(site: Site, days: Day[], minElevation = 0): [number, number] {
  let tx = 0, ty = 0;
  for (const [y, m, d] of days) {
    for (let minute = 0; minute < 1440; minute += 10) {
      const sp = sunWithNoon(y, m, d, minute, site.lat, site.lon, site.tz, site.noonShift ?? 0);
      if (90 - sp.zenith <= minElevation) continue;
      const zw = (refractedZenithDeg(sp.zenith) * Math.PI) / 180, az = (sp.azimuth * Math.PI) / 180;
      tx = Math.max(tx, Math.abs(Math.tan(zw) * Math.sin(az))); ty = Math.max(ty, Math.abs(Math.tan(zw) * Math.cos(az)));
    }
  }
  return [tx, ty];
}

export function defaultCloth(target: Target, height: number, site: Site, days: Day[], tau: number): Panel {
  const [tx, ty] = maxRefractedTan(site, days, 10);
  return panel({ lx: 2 * (target.lx / 2 + height * tx), ly: 2 * (halfY(target) + height * ty), height, tau });
}

export interface ConstantResult { panel: Panel; result: PeriodResult; tauDays: number[] | null }

/** Shade cloth: clean, with a fixed share of time fouled, or with a fouling timeline between cleanings (v5.1). */
export function constantScenario(site: Site, water: Water, target: Target, height: number, days: Day[], tables: Tables,
  tauClean: number, tauFouled?: number, fouledShare = 0, cloth?: Panel, spacing = 0.05, nFacets = 16, windOverride?: number,
  fouling?: Fouling | null): ConstantResult {
  const pts = targetGrid(target, spacing);
  const base = cloth ?? defaultCloth(target, height, site, days, tauClean);
  const tauDays = clothTauDays(days, tauClean, tauFouled, fouledShare, fouling);
  const result = periodFor(site, water, [{ ...base, tau: tauClean }], pts, days, tables, nFacets, windOverride, tauDays);
  return { panel: { ...base, tau: tauClean }, result, tauDays };
}

export function canopyNsSize(target: Target, height: number, site: Site, days: Day[], margin = 0): number {
  let ty = 0;
  for (const [y, m, d] of days) {
    const sp = solarPosition(y, m, d, solarNoon(y, m, d, site.lon, site.tz), site.lat, site.lon, site.tz);
    const zw = (refractedZenithDeg(sp.zenith) * Math.PI) / 180;
    ty = Math.max(ty, Math.abs(Math.tan(zw) * Math.cos((sp.azimuth * Math.PI) / 180)));
  }
  return 2 * (halfY(target) + height * ty) + margin;
}

export interface SolveResult { feasible: boolean; panel: Panel; transmission: number; targetTransmission: number; iterations: number; message: string; history: [number, number][] }

export function solveDynamic(site: Site, water: Water, target: Target, height: number, days: Day[], tables: Tables, targetTransmission: number,
  opts: { ly?: number; wMax?: number; spacing?: number; nFacets?: number; solveEvery?: number; tol?: number; tolT?: number; offset?: [number, number]; wind?: number; guess?: number } = {}): SolveResult {
  const { wMax = 12, spacing = 0.1, nFacets = 16, solveEvery = 1, tol = 0.002, tolT = 0.0005, offset = [0, 0] } = opts;
  const sdays = solveEvery > 1 ? days.filter((_, i) => i % solveEvery === 0) : days;
  const pts = targetGrid(target, spacing);
  const LY = opts.ly ?? canopyNsSize(target, height, site, days);
  const st = opticalState(water, tables);
  const mk = (W: number) => panel({ cx: offset[0], cy: offset[1], lx: W, ly: LY, height, tau: 0 });
  const T = (W: number) => transmission(runPeriod(site, water, [mk(W)], pts, sdays, tables, nFacets, opts.wind, st));
  const hist: [number, number][] = [];
  let lo = 0.01, hi = wMax;
  let tLo: number, tHi: number;
  if (opts.guess && opts.guess > 0.02 && opts.guess < wMax) {
    // warm start: bracket around the previous answer, widening until the target is inside
    lo = Math.max(0.01, opts.guess * 0.85); hi = Math.min(wMax, opts.guess * 1.18);
    tLo = T(lo); tHi = T(hi); hist.push([lo, tLo], [hi, tHi]);
    while (tLo < targetTransmission && lo > 0.01) { hi = lo; tHi = tLo; lo = Math.max(0.01, lo / 1.5); tLo = T(lo); hist.push([lo, tLo]); }
    while (tHi > targetTransmission && hi < wMax) { lo = hi; tLo = tHi; hi = Math.min(wMax, hi * 1.5); tHi = T(hi); hist.push([hi, tHi]); }
  } else {
    tLo = T(lo); tHi = T(hi);
    hist.push([lo, tLo], [hi, tHi]);
  }
  if (targetTransmission < tHi)
    return { feasible: false, panel: mk(hi), transmission: tHi, targetTransmission, iterations: 2, history: hist,
      message: `Not reachable: even a ${hi.toFixed(1)} m wide canopy lets ${(100 * tHi).toFixed(0)} % of the light through, mostly scattered light from the north and south sides. Lower the canopy, make it longer north-south, or use a cloth.` };
  if (targetTransmission >= tLo)
    return { feasible: true, panel: mk(lo), transmission: tLo, targetTransmission, iterations: 2, history: hist, message: "The target is met without a canopy." };
  let fLo = tLo - targetTransmission, fHi = tHi - targetTransmission, it = 0, side = 0, W = lo, tW = tLo;
  while (it < 40) {
    W = (lo * fHi - hi * fLo) / (fHi - fLo);
    tW = T(W); hist.push([W, tW]); it++;
    const fW = tW - targetTransmission;
    if (Math.abs(fW) < tolT || hi - lo < tol) break;
    if (fW > 0) { lo = W; fLo = fW; if (side === -1) fHi *= 0.5; side = -1; }
    else { hi = W; fHi = fW; if (side === 1) fLo *= 0.5; side = 1; }
  }
  return { feasible: true, panel: mk(W), transmission: tW, targetTransmission, iterations: it, history: hist, message: "Solved." };
}

export interface Clearance { neverSunlit: Uint8Array; shareNeverSunlit: number; hMinAny: number; hForSunBy0800ShadeFrom1000: number; hRuleDay: Day; height: number }

export function clearanceCheck(r: PeriodResult, target: Target, height: number, site: Site, thresholdHours = 0.1): Clearance {
  const hrs = directSunHours(r);
  const never = new Uint8Array(r.nPoints);
  let n = 0;
  for (let p = 0; p < r.nPoints; p++) {
    let mx = 0; for (const d of hrs) mx = Math.max(mx, d[p]!);
    if (mx < thresholdHours) { never[p] = 1; n++; }
  }
  const R = 0.5 * Math.max(target.lx, target.shape === "rect" ? target.ly : target.lx);
  // height rule on the most demanding day of the period (the largest height)
  let hRule = 0, hRuleDay: Day = r.days[0]!;
  for (const [y, m, d] of r.days) {
    const noon = solarNoon(y, m, d, site.lon, site.tz);
    const tz = (minute: number) => Math.tan((refractedZenithDeg(solarPosition(y, m, d, minute, site.lat, site.lon, site.tz).zenith) * Math.PI) / 180);
    const h = (2 * R) / Math.max(tz(noon - 240) - tz(noon - 120), 1e-6);
    if (h > hRule) { hRule = h; hRuleDay = [y, m, d]; }
  }
  return { neverSunlit: never, shareNeverSunlit: n / r.nPoints, hMinAny: 1.78 * R, hForSunBy0800ShadeFrom1000: hRule, hRuleDay, height };
}

export interface Contrast { noon: number; side: number; ratio: number }

/** Area-mean light as a share of open water at noon (solar noon ± 1 h) and in the morning and afternoon (3 h or more
 *  from solar noon, sun more than 10° up), summed over every day; ratio = noon / morning and afternoon. */
export function noonContrast(r: PeriodResult, site: Site): Contrast {
  let nn = 0, no = 0, sn = 0, so = 0;
  const nP = r.nPoints;
  r.days.forEach(([y, m, d], i) => {
    const noon = solarNoon(y, m, d, site.lon, site.tz) + (site.noonShift ?? 0);
    const e = r.ed[i]!, eo = r.edOpen[i]!, mins = r.minutes[i]!, zen = r.zenith[i]!;
    for (let k = 0; k < mins.length; k++) {
      const dt = Math.abs(mins[k]! - noon);
      const atNoon = dt <= 60, side = dt >= 180 && zen[k]! < 80;
      if (!atNoon && !side) continue;
      let a = 0; const row = e[k]!; for (let p = 0; p < nP; p++) a += row[p]! / nP;
      if (atNoon) { nn += a; no += eo[k]!; } else { sn += a; so += eo[k]!; }
    }
  });
  const noonT = no > 0 ? nn / no : NaN, sideT = so > 0 ? sn / so : NaN;
  return { noon: noonT, side: sideT, ratio: sideT > 0 ? noonT / sideT : NaN };
}

export const CONTRAST_WARN = 0.8;   // dynamic shading: warn when noon light is more than this share of morning and afternoon light

/** Plain-language warning when dynamic shading gives nearly the same light pattern as constant shading (as Python). */
export function contrastWarning(c: Contrast, beam: number, depth: number): string | null {
  if (!(c.ratio > CONTRAST_WARN)) return null;
  return `Dynamic shading barely changes through the day here: at noon the corals get ${(100 * c.noon).toFixed(0)} % of open-water `
    + `light, in the morning and afternoon ${(100 * c.side).toFixed(0)} %. Only ${(100 * beam).toFixed(1)} % of the light at `
    + `${depth} m arrives as the sun beam; the rest is scattered light from all directions, which the canopy blocks at `
    + `every hour. A stronger midday contrast needs less scattering water (lower w0), a shallower site or a wider `
    + `canopy, which also gives less light overall.`;
}

export interface RobustRow { case: string; T: number }

/** Period transmission under altered conditions, on every day unless every > 1 (as Python robustness). tauDays: the
 *  cloth's transmission by day (fouling). With Kd by date, the Kd cases scale every day's Kd. */
export function robustness(site: Site, water: Water, panels: readonly Panel[], pts: Float64Array, days: Day[], tables: Tables, nFacets = 16,
  kdFactor = [0.5, 1.5], w0s = [0.5, 0.9], winds = [0, 10], shift = 0.2, every = 1, tauDays: number[] | null = null): RobustRow[] {
  const idx = days.map((_, i) => i).filter((i) => every <= 1 || i % every === 0);
  const dd = idx.map((i) => days[i]!), td = tauDays ? idx.map((i) => tauDays[i]!) : null;
  const T = (s: Site, w: Water, p: readonly Panel[], wind?: number) => transmission(periodFor(s, w, p, pts, dd, tables, nFacets, wind, td));
  const g = (v: number) => String(+v.toPrecision(6));
  const rows: RobustRow[] = [{ case: "as designed", T: T(site, water, panels) }];
  for (const f of kdFactor) {
    const w = { ...water, kd: water.kd * f };
    const s2: Site = site.kdSeries ? { ...site, kdSeries: new Map([...site.kdSeries].map(([k, v]) => [k, v * f])) } : site;
    rows.push({ case: `Kd x ${g(f)}` + (site.kdSeries ? "" : ` (${w.kd.toFixed(3)} m-1)`), T: T(s2, w, panels) });
  }
  for (const w0 of w0s) rows.push({ case: `w0 ${g(w0)}`, T: T(site, { ...water, w0 }, panels) });
  for (const u of winds) rows.push({ case: `wind ${g(u)} m s-1`, T: T(site, water, panels, u) });
  rows.push({ case: `shifted ${g(shift)} m east`, T: T(site, water, panels.map((p) => ({ ...p, cx: p.cx + shift }))) });
  rows.push({ case: `shifted ${g(shift)} m north`, T: T(site, water, panels.map((p) => ({ ...p, cy: p.cy + shift }))) });
  return rows;
}

// ------------------------------------------------------------------ water scattering (w0): field calibration (as Python)
export function w0Bounds(tables: Tables): [number, number] { return [tables.w0[0]!, tables.w0[tables.w0.length - 1]!]; }

/** Model light under a panel / open water at one point and moment (a field reading), for scattering w0. */
export function readingRatio(tables: Tables, w0: number, pan: Panel, point: [number, number], kd: number, depth: number, date: Day, minute: number,
  lat: number, lon: number, tz: number, diffuseShare = 0.3, wind = 0): number {
  const sp = solarPosition(date[0], date[1], date[2], minute, lat, lon, tz);
  if (sp.zenith >= 90) throw new Error("The sun is below the horizon at that time.");
  const day: DayLight = { minutes: Float64Array.of(minute), step: 10, zenith: Float64Array.of(sp.zenith), azimuth: Float64Array.of(sp.azimuth),
    parDirectH: Float64Array.of(1000 * (1 - diffuseShare)), parDiffuse: Float64Array.of(1000 * diffuseShare), wind: Float64Array.of(wind) };
  const water: Water = { kd, w0, depth };
  const st = opticalState(water, tables), pts = Float64Array.of(point[0], point[1]);
  const mom = panelMoments(pts, [pan], water, st.thetaEdges, tables.m_max);
  const r = runDay(day, water, [pan], pts, st, mom, wind > 0 ? 64 : 0);
  return r.ed[0]![0]! / r.edOpen[0]!;
}

export interface W0Fit { w0: number; status: "ok" | "below" | "above"; ratioMin: number; ratioMax: number }

/** The w0 for which the model reproduces a field reading (light under an opaque panel / open water, same moment). */
export function w0FromReading(tables: Tables, ratio: number, pan: Panel, point: [number, number], kd: number, depth: number, date: Day, minute: number,
  lat: number, lon: number, tz: number, diffuseShare = 0.3, wind = 0): W0Fit {
  const [lo, hi] = w0Bounds(tables);
  const f = (w: number) => readingRatio(tables, w, pan, point, kd, depth, date, minute, lat, lon, tz, diffuseShare, wind);
  const rLo = f(lo), rHi = f(hi);
  if (ratio <= rLo) return { w0: lo, status: "below", ratioMin: rLo, ratioMax: rHi };
  if (ratio >= rHi) return { w0: hi, status: "above", ratioMin: rLo, ratioMax: rHi };
  let a = lo, b = hi;
  for (let i = 0; i < 40; i++) { const m = 0.5 * (a + b); if (f(m) < ratio) a = m; else b = m; }
  return { w0: 0.5 * (a + b), status: "ok", ratioMin: rLo, ratioMax: rHi };
}

export interface BiologyResult { ek: Float64Array; ekDays: Float64Array[]; daily: Record<string, number>[]; mean: Record<string, number> }

export function biology(r: PeriodResult, coral: Coral): BiologyResult {
  const ekDays = effectiveEkByDay(coral, r.ed, r.nPoints, r.edOpen);
  const ek = new Float64Array(r.nPoints);
  for (const d of ekDays) for (let p = 0; p < r.nPoints; p++) ek[p] = ek[p]! + d[p]! / ekDays.length;   // deployment mean per point
  const daily = r.ed.map((e, i) => {
    const m = dayMetrics(e, r.step, coral, ekDays[i], r.edOpen[i]);
    const row: Record<string, number> = {};
    for (const [k, v] of Object.entries(m)) if (v instanceof Float64Array) row[k] = v.reduce((a, b) => a + b, 0) / r.nPoints;
    return row;
  });
  const mean: Record<string, number> = {};
  for (const k of Object.keys(daily[0] ?? {})) mean[k] = daily.reduce((a, row) => a + row[k]!, 0) / daily.length;
  return { ek, ekDays, daily, mean };
}
