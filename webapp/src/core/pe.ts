// Coral P–E model and daily light metrics. Port of python/src/coralshading/pe.py (definitions in its docstring).

export type Acclimation = "none" | "site" | "shade" | "time";
export const ACCLIMATION_DAYS = 2.5;   // time constant, days (Anthony and Hoegh-Guldberg 2003: new stable Ik within 5-10 days)
export interface Coral { ek: number; rOverPg?: number | null; ekEmax?: number | null; acclimate?: Acclimation; label?: string }

export interface PresetFile {
  presets: { id: string; label: string; Ek: number; R_over_Pg?: number | null; Ek_Emax?: number | null }[];
}

export function coralFromPreset(P: PresetFile, id: string, acclimate: Acclimation = "none"): Coral {
  const p = P.presets.find((x) => x.id === id);
  if (!p) throw new Error(`unknown coral preset ${id}`);
  return { ek: p.Ek, rOverPg: p.R_over_Pg ?? null, ekEmax: p.Ek_Emax ?? null, acclimate, label: p.label };
}

/** 90th percentile as numpy.percentile(..., 90) with linear interpolation. */
function percentile(v: number[], q: number): number {
  const s = [...v].sort((a, b) => a - b);
  const pos = (q / 100) * (s.length - 1), lo = Math.floor(pos), hi = Math.ceil(pos);
  return s[lo]! + (s[hi]! - s[lo]!) * (pos - lo);
}

function p90Peak(days: ArrayLike<number>[][], p: number): number {
  const peaks = days.map((d) => d.reduce((m, row) => Math.max(m, row[p]!), -Infinity));
  return peaks.length > 1 ? percentile(peaks, 90) : peaks[0]!;
}

/** Ek per point (modes as in pe.py). days: [day][time][point]; openDays: [day][time] open water at the target depth. */
export function effectiveEk(coral: Coral, days: Float64Array[][], nPoints: number, openDays?: Float64Array[]): Float64Array {
  const out = new Float64Array(nPoints).fill(coral.ek);
  const mode = coral.ekEmax ? (coral.acclimate ?? "none") : "none";
  if (mode === "shade") for (let p = 0; p < nPoints; p++) out[p] = Math.max(coral.ekEmax! * p90Peak(days, p), 1.0);
  if (mode === "site") {
    if (!openDays) throw new Error("site acclimation needs the open-water light");
    out.fill(Math.max(coral.ekEmax! * p90Peak(openDays.map((d) => Array.from(d, (v) => [v])), 0), 1.0));
  }
  return out;
}

/** Ek per day and point. Static modes repeat effectiveEk; "time" starts acclimated to open water ("site") and moves each
 *  day toward Ek/Emax x that day's peak at the point, exponentially with time constant ACCLIMATION_DAYS (as Python). */
export function effectiveEkByDay(coral: Coral, days: Float64Array[][], nPoints: number, openDays?: Float64Array[]): Float64Array[] {
  const mode = coral.ekEmax ? (coral.acclimate ?? "none") : "none";
  if (mode !== "time") { const e = effectiveEk(coral, days, nPoints, openDays); return days.map(() => e); }
  if (!openDays) throw new Error("acclimation over time needs the open-water light");
  const cur = new Float64Array(nPoints).fill(Math.max(coral.ekEmax! * p90Peak(openDays.map((d) => Array.from(d, (v) => [v])), 0), 1.0));
  const f = 1 - Math.exp(-1 / ACCLIMATION_DAYS);
  return days.map((day) => {
    const now = Float64Array.from(cur);
    for (let p = 0; p < nPoints; p++) {
      let pk = -Infinity; for (const row of day) pk = Math.max(pk, row[p]!);
      cur[p] = cur[p]! + f * (Math.max(coral.ekEmax! * pk, 1.0) - cur[p]!);
    }
    return now;
  });
}

export interface DayMetrics {
  dli: Float64Array; peak: Float64Array; hoursAboveEk: Float64Array; lightAboveEk: Float64Array; grossHours: Float64Array;
  ek: Float64Array; grossVsOpen?: Float64Array; prDaily?: Float64Array; ec?: Float64Array;
  [zoneKey: string]: Float64Array | undefined;      // hours<Zone>, light<Zone>, openHours<Zone>, openLight<Zone>
}

/** The four zones of the P-E curve (daylight only), in order: below compensation, light-limited, near saturation, saturated. */
export const ZONES = ["BelowEc", "Limited", "NearSat", "Saturated"] as const;
const zoneOf = (e: number, ec: number, ek: number) => (e < ec ? 0 : e < ek ? 1 : e < 2 * ek ? 2 : 3);

export function dayMetrics(ed: Float64Array[], stepMin: number, coral: Coral, ek?: Float64Array, edOpen?: Float64Array): DayMetrics {
  const nP = ed[0]?.length ?? 0, dt = stepMin * 60;
  const k = ek ?? new Float64Array(nP).fill(coral.ek);
  const r = coral.rOverPg;
  const ec = r ? k.map((e) => e * Math.atanh(Math.min(r, 0.999999))) : new Float64Array(nP);
  const m: DayMetrics = { dli: new Float64Array(nP), peak: new Float64Array(nP).fill(-Infinity), hoursAboveEk: new Float64Array(nP),
    lightAboveEk: new Float64Array(nP), grossHours: new Float64Array(nP), ek: k };
  const H = ZONES.map(() => new Float64Array(nP)), Lt = ZONES.map(() => new Float64Array(nP));
  for (let p = 0; p < nP; p++) {
    let s = 0, pk = -Infinity, nAbove = 0, above = 0, g = 0;
    const kp = k[p]!, ecp = ec[p]!;
    for (const row of ed) {
      const e = row[p]!;
      if (!(e > 0)) { if (e > pk) pk = e; continue; }
      s += e; if (e > pk) pk = e; if (e > kp) nAbove++; above += Math.max(e - kp, 0); g += Math.tanh(e / kp);
      const z = zoneOf(e, ecp, kp); H[z]![p]! += 1; Lt[z]![p]! += e;
    }
    m.dli[p] = (s * dt) / 1e6; m.peak[p] = pk; m.hoursAboveEk[p] = (nAbove * stepMin) / 60;
    m.lightAboveEk[p] = (above * dt) / 1e6; m.grossHours[p] = (g * stepMin) / 60;
    for (let z = 0; z < 4; z++) { H[z]![p] = (H[z]![p]! * stepMin) / 60; Lt[z]![p] = (Lt[z]![p]! * dt) / 1e6; }
  }
  ZONES.forEach((name, z) => { m[`hours${name}`] = H[z]!; m[`light${name}`] = Lt[z]!; });
  if (edOpen) {
    m.grossVsOpen = new Float64Array(nP);
    const OH = ZONES.map(() => new Float64Array(nP)), OL = ZONES.map(() => new Float64Array(nP));
    const cache = new Map<string, { go: number; h: number[]; l: number[] }>();     // Ek is often the same for every point
    for (let p = 0; p < nP; p++) {
      const key = `${k[p]}|${ec[p]}`;
      let c = cache.get(key);
      if (c === undefined) {
        let g = 0; const h = [0, 0, 0, 0], l = [0, 0, 0, 0];
        for (const e of edOpen) if (e > 0) { g += Math.tanh(e / k[p]!); const z = zoneOf(e, ec[p]!, k[p]!); h[z]! += 1; l[z]! += e; }
        c = { go: (g * stepMin) / 60, h: h.map((v) => (v * stepMin) / 60), l: l.map((v) => (v * dt) / 1e6) }; cache.set(key, c);
      }
      m.grossVsOpen[p] = c.go > 0 ? m.grossHours[p]! / c.go : NaN;
      for (let z = 0; z < 4; z++) { OH[z]![p] = c.h[z]!; OL[z]![p] = c.l[z]!; }
    }
    ZONES.forEach((name, z) => { m[`openHours${name}`] = OH[z]!; m[`openLight${name}`] = OL[z]!; });
  }
  if (r) {
    m.prDaily = m.grossHours.map((g) => g / (24 * r));
    m.ec = ec;
  }
  return m;
}

export interface Summary { mean: number; min: number; max: number; p10: number; p90: number }

/** Weighted mean, min, max and 10th/90th percentiles (same rule as the Python reference). */
export function summarize(values: ArrayLike<number>, weights?: ArrayLike<number>): Summary {
  const n = values.length;
  const idx = Array.from({ length: n }, (_, i) => i).sort((a, b) => values[a]! - values[b]!);
  const w = (i: number) => (weights ? weights[i]! : 1);
  let W = 0, S = 0;
  for (let i = 0; i < n; i++) { W += w(i); S += w(i) * values[i]!; }
  const cw: number[] = []; let c = 0;
  for (const i of idx) { c += w(i); cw.push(c / W); }
  const pct = (q: number) => { let j = 0; while (j < n - 1 && cw[j]! < q) j++; return values[idx[j]!]!; };
  return { mean: S / W, min: values[idx[0]!]!, max: values[idx[n - 1]!]!, p10: pct(0.1), p90: pct(0.9) };
}
