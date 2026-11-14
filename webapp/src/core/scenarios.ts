// Shading scenarios, design solver and checks. Port of python/src/coralshading/scenarios.py (method in its docstring).
import { daysFromCivil, solarPosition, solarNoon, sunWithNoon } from "./solar.ts";
import { refractedZenithDeg } from "./optics.ts";
import { type Panel, type Target, panel, targetGrid } from "./geometry.ts";
import { type HourlyLight, civilFromDays, dayLight } from "./surface.ts";
import { type Tables, type Water, type OpticalState, opticalState, panelMoments, runDay } from "./engine.ts";
import { type Coral, dayMetrics, effectiveEk } from "./pe.ts";

export interface Site { lat: number; lon: number; tz: number; light: HourlyLight; noonShift?: number; step?: number }
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

export function runPeriod(site: Site, water: Water, panels: readonly Panel[], pts: Float64Array, days: Day[], tables: Tables,
  nFacets = 16, windOverride?: number, state?: OpticalState): PeriodResult {
  const st = state ?? opticalState(water, tables);
  const mom = panelMoments(pts, panels, water, st.thetaEdges, tables.m_max);
  const step = site.step ?? 10, shift = site.noonShift ?? 0;
  const out: PeriodResult = { days, step, ed: [], edOpen: [], sunlit: [], minutes: [], zenith: [], azimuth: [], nPoints: pts.length / 2 };
  let tot = 0, drop = 0;
  for (const [y, m, d] of days) {
    let dl = cachedDayLight(site, y, m, d, step, shift);
    tot += dl.lightTotal ?? 0; drop += dl.lightDropped ?? 0;
    if (windOverride !== undefined) dl = { ...dl, wind: new Float64Array(dl.wind.length).fill(windOverride) };
    const r = runDay(dl, water, panels, pts, st, mom, nFacets);
    out.ed.push(r.ed); out.edOpen.push(r.edOpen); out.sunlit.push(r.sunlit);
    out.minutes.push(dl.minutes); out.zenith.push(dl.zenith); out.azimuth.push(dl.azimuth);
  }
  out.lightDropped = tot > 0 ? drop / tot : 0;
  return out;
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

export interface ConstantResult { panel: Panel; result: PeriodResult; clean?: PeriodResult; fouled?: PeriodResult; fouledShare?: number }

export function constantScenario(site: Site, water: Water, target: Target, height: number, days: Day[], tables: Tables,
  tauClean: number, tauFouled?: number, fouledShare = 0, cloth?: Panel, spacing = 0.05, nFacets = 16, windOverride?: number): ConstantResult {
  const pts = targetGrid(target, spacing);
  const base = cloth ?? defaultCloth(target, height, site, days, tauClean);
  const clean = runPeriod(site, water, [{ ...base, tau: tauClean }], pts, days, tables, nFacets, windOverride);
  if (tauFouled === undefined || fouledShare <= 0) return { panel: { ...base, tau: tauClean }, result: clean };
  const foul = runPeriod(site, water, [{ ...base, tau: tauFouled }], pts, days, tables, nFacets, windOverride);
  const s = fouledShare;
  const mix = (A: Float64Array[][], B: Float64Array[][]) => A.map((day, i) => day.map((row, k) => row.map((v, p) => (1 - s) * v + s * B[i]![k]![p]!)));
  const mixed: PeriodResult = { ...clean, ed: mix(clean.ed, foul.ed), sunlit: mix(clean.sunlit, foul.sunlit) };
  return { panel: { ...base, tau: tauClean }, result: mixed, clean, fouled: foul, fouledShare: s };
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
  const { wMax = 12, spacing = 0.1, nFacets = 16, solveEvery = 5, tol = 0.002, tolT = 0.0005, offset = [0, 0] } = opts;
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

export interface Clearance { neverSunlit: Uint8Array; shareNeverSunlit: number; hMinAny: number; hForSunBy0800ShadeFrom1000: number; height: number }

export function clearanceCheck(r: PeriodResult, target: Target, height: number, site: Site, thresholdHours = 0.1): Clearance {
  const hrs = directSunHours(r);
  const never = new Uint8Array(r.nPoints);
  let n = 0;
  for (let p = 0; p < r.nPoints; p++) {
    let mx = 0; for (const d of hrs) mx = Math.max(mx, d[p]!);
    if (mx < thresholdHours) { never[p] = 1; n++; }
  }
  const R = 0.5 * Math.max(target.lx, target.shape === "rect" ? target.ly : target.lx);
  const [y, m, d] = r.days[0]!;
  const noon = solarNoon(y, m, d, site.lon, site.tz);
  const tz = (minute: number) => Math.tan((refractedZenithDeg(solarPosition(y, m, d, minute, site.lat, site.lon, site.tz).zenith) * Math.PI) / 180);
  const hRule = (2 * R) / Math.max(tz(noon - 240) - tz(noon - 120), 1e-6);
  return { neverSunlit: never, shareNeverSunlit: n / r.nPoints, hMinAny: 1.78 * R, hForSunBy0800ShadeFrom1000: hRule, height };
}

export interface RobustRow { case: string; T: number }

export function robustness(site: Site, water: Water, panels: readonly Panel[], pts: Float64Array, days: Day[], tables: Tables, nFacets = 16,
  kdFactor = [0.5, 1.5], w0s = [0.5, 0.9], winds = [0, 10], shift = 0.2, every = 5): RobustRow[] {
  const dd = every > 1 ? days.filter((_, i) => i % every === 0) : days;
  const T = (w: Water, p: readonly Panel[], wind?: number) => transmission(runPeriod(site, w, p, pts, dd, tables, nFacets, wind));
  const rows: RobustRow[] = [{ case: "as designed", T: T(water, panels) }];
  for (const f of kdFactor) { const w = { ...water, kd: water.kd * f }; rows.push({ case: `Kd x ${f} (${w.kd.toFixed(3)} m-1)`, T: T(w, panels) }); }
  for (const w0 of w0s) rows.push({ case: `w0 ${w0}`, T: T({ ...water, w0 }, panels) });
  for (const u of winds) rows.push({ case: `wind ${u} m s-1`, T: T(water, panels, u) });
  rows.push({ case: "shifted 0.2 m east", T: T(water, panels.map((p) => ({ ...p, cx: p.cx + shift }))) });
  rows.push({ case: "shifted 0.2 m north", T: T(water, panels.map((p) => ({ ...p, cy: p.cy + shift }))) });
  return rows;
}

export interface BiologyResult { ek: Float64Array; daily: Record<string, number>[]; mean: Record<string, number> }

export function biology(r: PeriodResult, coral: Coral): BiologyResult {
  const ek = effectiveEk(coral, r.ed, r.nPoints, r.edOpen);
  const daily = r.ed.map((e, i) => {
    const m = dayMetrics(e, r.step, coral, ek, r.edOpen[i]);
    const row: Record<string, number> = {};
    for (const [k, v] of Object.entries(m)) if (v instanceof Float64Array) row[k] = v.reduce((a, b) => a + b, 0) / r.nPoints;
    return row;
  });
  const mean: Record<string, number> = {};
  for (const k of Object.keys(daily[0] ?? {})) mean[k] = daily.reduce((a, row) => a + row[k]!, 0) / daily.length;
  return { ek, daily, mean };
}
