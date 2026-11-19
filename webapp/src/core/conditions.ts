// Conditions that change through a deployment (v5.1): water clarity by date, tide, and cloth fouling.
// Port of python/src/coralshading/conditions.py (method in its docstring).
import { daysFromCivil } from "./solar.ts";

export type Day = [number, number, number];
export const TAU_STEP = 2e-4; // tide: optical depths rounded to steps of 0.02 % (log scale) so water states can be reused

function parseDate(s0: string): Day {
  const s = s0.trim().replace(/^"|"$/g, "").slice(0, 10).replace(/\//g, "-");
  const [y, m, d] = s.split("-").map((x) => parseInt(x, 10));
  if (![y, m, d].every((v) => Number.isFinite(v))) throw new Error(`Not a date: ${s0}`);
  return [y!, m!, d!];
}

/** 'YYYY-MM-DD HH:MM[:SS]' or 'YYYY-MM-DDTHH:MM' (local standard time) -> minutes since 1970-01-01 00:00. */
export function parseDateTimeMin(s0: string): number {
  const s = s0.trim().replace(/^"|"$/g, "").replace("T", " ");
  const sp = s.indexOf(" ");
  const date = sp < 0 ? s : s.slice(0, sp), time = sp < 0 ? "00:00" : s.slice(sp + 1);
  const [y, m, d] = parseDate(date);
  const [hh, mm, ss] = time.split(":");
  return daysFromCivil(y, m, d) * 1440 + parseInt(hh!, 10) * 60 + parseInt(mm!, 10) + (ss ? parseFloat(ss) / 60 : 0);
}

function* rows(text: string): Generator<string[]> {
  for (const raw of text.split(/\r?\n/)) {
    const ln = raw.trim();
    if (!ln || ln.startsWith("#")) continue;
    const parts = ln.replace(/;/g, ",").replace(/\t/g, ",").split(",").map((p) => p.trim());
    if (parts.length < 2 || !/^\d{4}/.test(parts[0]!)) continue; // header or anything not starting with a year
    yield parts;
  }
}

// ------------------------------------------------------------------ Kd by date
export type KdSeries = Map<string, number>;   // "y-m-d" -> Kd
const key = (d: Day) => `${d[0]}-${d[1]}-${d[2]}`;

export function kdSeriesFromCsv(text: string): KdSeries {
  const out: KdSeries = new Map();
  for (const p of rows(text)) {
    const kd = parseFloat(p[1]!);
    if (!(kd > 0)) throw new Error(`Kd must be positive (row starting ${p[0]}).`);
    out.set(key(parseDate(p[0]!)), kd);
  }
  if (!out.size) throw new Error("No 'date, Kd' rows found.");
  return out;
}

/** Kd for each day: linear interpolation in time between the given dates, the nearest value held outside. */
export function kdForDays(series: KdSeries, days: Day[]): number[] {
  const pts = [...series.entries()].map(([k, v]) => { const [y, m, d] = k.split("-").map(Number); return [daysFromCivil(y!, m!, d!), v] as [number, number]; })
    .sort((a, b) => a[0] - b[0]);
  return days.map((d) => interp(daysFromCivil(...d), pts.map((p) => p[0]), pts.map((p) => p[1])));
}

/** numpy.interp: linear, values held beyond the ends. */
function interp(x: number, xs: number[] | Float64Array, ys: number[] | Float64Array): number {
  const n = xs.length;
  if (x <= xs[0]!) return ys[0]!;
  if (x >= xs[n - 1]!) return ys[n - 1]!;
  let lo = 0, hi = n - 1;
  while (hi - lo > 1) { const mid = (lo + hi) >> 1; if (xs[mid]! <= x) lo = mid; else hi = mid; }
  const f = (x - xs[lo]!) / (xs[hi]! - xs[lo]!);
  return ys[lo]! + f * (ys[hi]! - ys[lo]!);
}

// ------------------------------------------------------------------ tide
export interface Tide { tLocal: Float64Array; level: Float64Array; source?: string }

export function tideAt(t: Tide, x: number): number {
  if (x < t.tLocal[0]! - 1e-9 || x > t.tLocal[t.tLocal.length - 1]! + 1e-9) throw new Error("The tide series does not cover the whole deployment.");
  return interp(x, t.tLocal, t.level);
}

/** Time-weighted mean level over [t0, t1] (trapezoids on the series, end points interpolated). */
export function tideMeanBetween(t: Tide, t0: number, t1: number): number {
  const tt = [t0], ll = [tideAt(t, t0)];
  for (let i = 0; i < t.tLocal.length; i++) if (t.tLocal[i]! > t0 && t.tLocal[i]! < t1) { tt.push(t.tLocal[i]!); ll.push(t.level[i]!); }
  tt.push(t1); ll.push(tideAt(t, t1));
  let s = 0; for (let i = 1; i < tt.length; i++) s += (ll[i]! + ll[i - 1]!) * 0.5 * (tt[i]! - tt[i - 1]!);
  return s / (t1 - t0);
}

export function tideMin(t: Tide): number { let m = Infinity; for (const v of t.level) m = Math.min(m, v); return m; }

export function tideFromCsv(text: string): Tide {
  const pts = new Map<number, number>();
  for (const p of rows(text)) pts.set(parseDateTimeMin(p[0]!), parseFloat(p[1]!));
  if (pts.size < 2) throw new Error("A tide series needs at least two 'date time, level' rows.");
  const ts = [...pts.keys()].sort((a, b) => a - b);
  return { tLocal: Float64Array.from(ts), level: Float64Array.from(ts, (k) => pts.get(k)!) };
}

/** Round an optical depth to steps of TAU_STEP on a log scale (as Python). */
export function quantizeTau(tau: number): number {
  const k = Math.floor(Math.log(tau) / TAU_STEP + 0.5);
  return Math.exp(k * TAU_STEP);
}

// ------------------------------------------------------------------ cloth fouling over time
export interface Fouling { tauClean: number; tauFouled: number; daysToFoul: number; cleanEvery: number; cleanDates: Day[] }

/** Cloth transmission on each day (the start date counts as a cleaning). */
export function tauByDay(f: Fouling, days: Day[]): number[] {
  const d0 = daysFromCivil(...days[0]!);
  const extra = f.cleanDates.map((d) => daysFromCivil(...d)).sort((a, b) => a - b);
  return days.map((d) => {
    const k = daysFromCivil(...d);
    let last = d0;
    if (f.cleanEvery > 0) last = d0 + Math.floor((k - d0) / f.cleanEvery) * f.cleanEvery;
    for (const e of extra) if (d0 <= e && e <= k) last = Math.max(last, e);
    const age = k - last;
    const fr = f.daysToFoul <= 0 ? 1 : Math.min(1, age / f.daysToFoul);
    return f.tauClean + (f.tauFouled - f.tauClean) * fr;
  });
}

export function cleanDatesFromText(text: string): Day[] {
  return text.split(/[\s,;]+/).map((s) => s.trim()).filter((s) => /^\d{4}-\d{1,2}-\d{1,2}$/.test(s)).map(parseDate);
}
