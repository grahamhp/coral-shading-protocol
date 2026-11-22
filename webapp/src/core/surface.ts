// Light at the sea surface: reading PVGIS data, converting to PAR, spreading hourly values over the day.
// Port of python/src/coralshading/surface.py (the reference; see its docstring for sources). Both must
// reproduce shared/golden/surface.json.
import { daysFromCivil, solarPosition, sunWithNoon } from "./solar.ts";

export const PAR_FRACTION = 0.5; // Spitters et al. 1986
export const Q_DIRECT = 4.57; // umol J-1, McCree 1972 (daylight)
export const Q_DIFFUSE = 4.24; // umol J-1, McCree 1972 (skylight)
export const SOLAR_CONSTANT = 1361.0;
export const REF_YEAR = 2001;
export const KT_MAX = 1.0; // an hour brighter than this share of the light above the atmosphere cannot match the sun
export const MATCH_KM = 50.0; // light data must be for a point within this distance of the site
export const CLEAR_SKY_WIND = 5.0; // m s-1, wind used with the clear-sky estimate

export interface HourlyLight {
  tUtc: Float64Array; // minutes since epoch, middle of each hour
  ghi: Float64Array;
  dhi: Float64Array;
  unit: "W" | "PAR";
  wind: Float64Array | null;
  lat: number | null;
  lon: number | null;
  source: string;
  database: string;
  kind: "tmy" | "hourly";
  centerMin?: number; // minute of the UTC hour on which every value is centred (default 30; e.g. 9 for PVGIS-SARAH3)
  tmyYears?: number[] | null; // for a typical year built here: the year chosen for each calendar month
}

/** Minute of the UTC hour (0 <= m < 60) of a time in minutes since the epoch. */
export function centerMinute(tUtcMin: number): number {
  return tUtcMin - 60 * Math.floor(tUtcMin / 60);
}

export function civilFromDays(z0: number): [number, number, number] {
  let z = z0 + 719468;
  const era = Math.floor((z >= 0 ? z : z - 146096) / 146097);
  const doe = z - era * 146097;
  const yoe = Math.floor((doe - Math.floor(doe / 1460) + Math.floor(doe / 36524) - Math.floor(doe / 146096)) / 365);
  const y = yoe + era * 400;
  const doy = doe - (365 * yoe + Math.floor(yoe / 4) - Math.floor(yoe / 100));
  const mp = Math.floor((5 * doy + 2) / 153);
  const d = doy - Math.floor((153 * mp + 2) / 5) + 1;
  const m = mp + (mp < 10 ? 3 : -9);
  return [y + (m <= 2 ? 1 : 0), m, d];
}

// ------------------------------------------------------------------ PAR conversion
export function diffuseFractionPar(k: number): number {
  const kk = Math.min(1, Math.max(0, k));
  return Math.min(1.0, (1.0 + 0.3 * (1.0 - kk * kk)) * kk);
}

/** Horizontal direct and diffuse PAR (umol m-2 s-1) from global and diffuse irradiance (W m-2). */
export function toPar(ghiW: number, dhiW: number): [number, number] {
  const g = Math.max(0, ghiW), d = Math.max(0, dhiW);
  const k = g > 0 ? Math.min(d, g) / g : 0;
  const kp = diffuseFractionPar(k);
  const p = PAR_FRACTION * g;
  return [Q_DIRECT * (1 - kp) * p, Q_DIFFUSE * kp * p];
}

export function erbsDiffuseFraction(kt0: number): number {
  const kt = Math.min(1, Math.max(0, kt0));
  if (kt <= 0.22) return 1.0 - 0.09 * kt;
  if (kt <= 0.8) return 0.9511 - 0.1604 * kt + 4.388 * kt ** 2 - 16.638 * kt ** 3 + 12.336 * kt ** 4;
  return 0.165;
}

// ------------------------------------------------------------------ parsing
function stampToUtcMin(s: string): number {
  const y = +s.slice(0, 4), m = +s.slice(4, 6), d = +s.slice(6, 8), hh = +s.slice(9, 11), mm = +s.slice(11, 13);
  return daysFromCivil(y, m, d) * 1440 + hh * 60 + mm;
}

function headerValue(lines: string[], key: string): string | null {
  for (const ln of lines) if (ln.startsWith(key)) return ln.split(":").slice(1).join(":").trim().replace(/\t/g, " ").split(/\s+/)[0] ?? null;
  return null;
}

/** Read a PVGIS CSV (TMY, or hourly series with components on a horizontal plane). Throws a plain message. */
export function parsePVGIS(text: string): HourlyLight {
  const lines = text.split(/\r*\n/);
  const hdrI = lines.findIndex((l) => l.startsWith("time"));
  if (hdrI < 0) throw new Error("Not a PVGIS hourly or TMY file: no 'time' column header found.");
  const cols = lines[hdrI]!.split(",").map((c) => c.trim());
  const rows: string[][] = [];
  for (const ln of lines.slice(hdrI + 1)) {
    if (!ln.trim()) continue; // blank lines (e.g. doubled line endings) are skipped
    if (ln.length < 13 || !/^\d{8}:/.test(ln)) { if (rows.length) break; continue; }
    rows.push(ln.split(","));
  }
  if (!rows.length) throw new Error("The PVGIS file has a header but no data rows.");
  const lat = headerValue(lines, "Latitude"), lon = headerValue(lines, "Longitude");
  const offsetH = parseFloat(headerValue(lines, "Irradiance Time Offset") ?? "0");
  let database = headerValue(lines, "Radiation database") ?? "";
  const col = new Map(cols.map((c, j) => [c, j] as const));
  const get = (name: string) => Float64Array.from(rows, (r) => parseFloat(r[col.get(name)!]!));
  const t = Float64Array.from(rows, (r) => stampToUtcMin(r[0]!) + 60 * offsetH);
  let ghi: Float64Array, dhi: Float64Array, kind: "tmy" | "hourly";
  if (col.has("G(h)") && col.has("Gd(h)")) { ghi = get("G(h)"); dhi = get("Gd(h)"); kind = "tmy"; database = database || "PVGIS TMY"; }
  else if (col.has("Gb(i)") && col.has("Gd(i)")) {
    const slope = headerValue(lines, "Slope");
    if (slope !== null && parseFloat(slope) !== 0) throw new Error("This PVGIS file is for a tilted plane; download it with slope 0 (horizontal).");
    dhi = get("Gd(i)"); const gb = get("Gb(i)"); ghi = gb.map((v, i) => v + dhi[i]!); kind = "hourly";
  } else if (col.has("G(i)")) throw new Error("This PVGIS file has total irradiance only; download it with 'radiation components' ticked.");
  else throw new Error(`Unrecognised PVGIS columns: ${cols.join(", ")}`);
  const n = t.length;
  if (kind === "tmy" && n !== 8760) throw new Error(`The PVGIS typical-year file has ${n} hourly rows; 8760 expected. Download it again.`);
  if (kind === "hourly" && n > 1 && Math.round((t[n - 1]! - t[0]!) / 60) + 1 !== n)
    throw new Error(`The PVGIS hourly file has ${n} rows but spans ${Math.round((t[n - 1]! - t[0]!) / 60) + 1} hours; hours are missing.`);
  const wind = col.has("WS10m") ? get("WS10m") : null;
  for (let i = 0; i < ghi.length; i++) { ghi[i] = Math.max(0, ghi[i]!); dhi[i] = Math.max(0, Math.min(dhi[i]!, ghi[i]!)); }
  const h: HourlyLight = { tUtc: t, ghi, dhi, unit: "W", wind, lat: lat ? parseFloat(lat) : null, lon: lon ? parseFloat(lon) : null,
    source: "PVGIS 5.3", database, kind, centerMin: centerMinute(t[0]!) };
  return kind === "tmy" ? tmyToReferenceYear(h) : h;
}

export function tmyToReferenceYear(h: HourlyLight): HourlyLight {
  const g = new Float64Array(8760), d = new Float64Array(8760), w = new Float64Array(8760).fill(NaN);
  const base = daysFromCivil(REF_YEAR, 1, 1), cm = h.centerMin ?? 30;
  for (let i = 0; i < h.tUtc.length; i++) {
    const hh = Math.round((h.tUtc[i]! - cm) / 60);   // whole UTC hours since the epoch
    const [, mm, dd] = civilFromDays(Math.floor(hh / 24));
    if (mm === 2 && dd === 29) continue;
    const k = (daysFromCivil(REF_YEAR, mm, dd) - base) * 24 + (((hh % 24) + 24) % 24);
    g[k] = h.ghi[i]!; d[k] = h.dhi[i]!;
    if (h.wind) w[k] = h.wind[i]!;
  }
  const t = Float64Array.from({ length: 8760 }, (_, k) => base * 1440 + cm + 60 * k);
  return { ...h, tUtc: t, ghi: g, dhi: d, wind: h.wind ? w : null, kind: "tmy", centerMin: cm };
}

export function lightFromJson(j: any): HourlyLight {
  const base = daysFromCivil(j.ref_year ?? REF_YEAR, 1, 1);
  const n = j.ghi.length, cm = j.center_min ?? 30;
  return { tUtc: Float64Array.from({ length: n }, (_, k) => base * 1440 + cm + 60 * k), ghi: Float64Array.from(j.ghi),
    dhi: Float64Array.from(j.dhi), unit: j.unit, wind: j.wind ? Float64Array.from(j.wind, (v: number | null) => v ?? NaN) : null,
    lat: j.lat ?? null, lon: j.lon ?? null, source: j.source ?? "", database: j.database ?? "", kind: j.kind, centerMin: cm,
    tmyYears: j.tmy_years ?? null };
}

// ------------------------------------------------------------------ Open-Meteo (ERA5) and typical years
const WIND_TO_MS: Record<string, number> = { "m/s": 1, "km/h": 1 / 3.6, "mp/h": 0.44704, kn: 0.514444 };

function isoToUtcMin(s: string): number {
  return daysFromCivil(+s.slice(0, 4), +s.slice(5, 7), +s.slice(8, 10)) * 1440 + +s.slice(11, 13) * 60 + +s.slice(14, 16);
}

/** Read an Open-Meteo archive (ERA5) reply (as surface.parse_open_meteo in Python): hourly shortwave_radiation and
 *  diffuse_radiation in W m-2, requested with timezone=GMT. Each value is the mean of the hour BEFORE its stamp. */
export function parseOpenMeteo(data: string | any): HourlyLight {
  const j = typeof data === "string" ? JSON.parse(data) : data;
  if (j.error) throw new Error(`Open-Meteo: ${j.reason ?? "request refused"}`);
  const h = j.hourly ?? {};
  if (!h.time || !h.shortwave_radiation || !h.diffuse_radiation) throw new Error("Not an Open-Meteo hourly reply with shortwave_radiation and diffuse_radiation.");
  if ((j.utc_offset_seconds ?? 0) !== 0) throw new Error("Open-Meteo data must be requested with timezone=GMT.");
  let n: number = h.time.length;
  while (n > 0 && (h.shortwave_radiation[n - 1] == null || h.diffuse_radiation[n - 1] == null)) n--;
  if (n === 0) throw new Error("The Open-Meteo reply holds no radiation values.");
  const ghi = new Float64Array(n), dhi = new Float64Array(n), t = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    const g = h.shortwave_radiation[i], d = h.diffuse_radiation[i];
    if (g == null || d == null) throw new Error("The Open-Meteo reply has gaps in the radiation values.");
    t[i] = isoToUtcMin(h.time[i]) - 30;
    ghi[i] = Math.max(0, g); dhi[i] = Math.max(0, Math.min(d, ghi[i]!));
  }
  if (n > 1 && Math.round((t[n - 1]! - t[0]!) / 60) + 1 !== n) throw new Error("The Open-Meteo reply is not a gap-free hourly series.");
  let wind: Float64Array | null = null;
  if (h.wind_speed_10m) {
    const f = WIND_TO_MS[(j.hourly_units ?? {}).wind_speed_10m ?? "km/h"] ?? 1 / 3.6;
    wind = Float64Array.from({ length: n }, (_, i) => (h.wind_speed_10m[i] == null ? NaN : h.wind_speed_10m[i] * f));
  }
  return { tUtc: t, ghi, dhi, unit: "W", wind, lat: j.latitude ?? null, lon: j.longitude ?? null, source: "Open-Meteo archive API",
    database: "ERA5 (Open-Meteo)", kind: "hourly", centerMin: centerMinute(t[0]!) };
}

/** A typical year from several years of hourly data (as surface.typical_year in Python): for each calendar month the
 *  year whose daily global irradiation is distributed most like all years (Finkelstein-Schafer statistic; of the
 *  `candidates` closest, the one with the monthly mean nearest the all-year mean). */
export function typicalYear(h: HourlyLight, candidates = 3): HourlyLight {
  if (h.kind !== "hourly") throw new Error("typical_year needs an hourly series of real years");
  const cm = h.centerMin ?? 30, n = h.tUtc.length;
  const h0 = Math.round((h.tUtc[0]! - cm) / 60);
  for (let i = 0; i < n; i += 997) if (Math.round((h.tUtc[i]! - cm) / 60) !== h0 + i) throw new Error("typical_year needs a gap-free hourly series");
  if (Math.round((h.tUtc[n - 1]! - cm) / 60) !== h0 + n - 1) throw new Error("typical_year needs a gap-free hourly series");
  const yFirst = civilFromDays(Math.floor(h0 / 24))[0], yLast = civilFromDays(Math.floor((h0 + n - 1) / 24))[0];
  const s0 = h.lon !== null ? (((-utcOffsetFromLon(h.lon)) % 24) + 24) % 24 : 0;   // UTC hour of local midnight
  const blocks = new Map<string, [number, number]>();
  let yMin = Infinity, yMax = -Infinity;
  for (let y = yFirst; y <= yLast; y++) for (let m = 1; m <= 12; m++) {
    const a = daysFromCivil(y, m, 1) * 24 - h0, b = daysFromCivil(m === 12 ? y + 1 : y, (m % 12) + 1, 1) * 24 - h0;
    if (a >= 0 && b <= n) { blocks.set(`${m}|${y}`, [a, b]); yMin = Math.min(yMin, y); yMax = Math.max(yMax, y); }
  }
  const base = daysFromCivil(REF_YEAR, 1, 1);
  const g = new Float64Array(8760), d = new Float64Array(8760), w = new Float64Array(8760).fill(NaN);
  const chosen: number[] = [];
  for (let m = 1; m <= 12; m++) {
    const years: number[] = [];
    for (let y = yFirst; y <= yLast; y++) if (blocks.has(`${m}|${y}`)) years.push(y);
    if (!years.length) throw new Error(`typical_year: no complete month ${m} in the data`);
    const daily = new Map<number, number[]>();
    const all: number[] = [];
    for (const y of years) {
      const [a, b] = blocks.get(`${m}|${y}`)!;
      const nd = Math.floor((b - a - s0) / 24), v: number[] = [];
      for (let k = 0; k < nd; k++) { let sum = 0; for (let i = a + s0 + 24 * k; i < a + s0 + 24 * k + 24; i++) sum += h.ghi[i]!; v.push(sum); }
      daily.set(y, v); all.push(...v);
    }
    all.sort((x, y) => x - y);
    const meanAll = all.reduce((x, y) => x + y, 0) / all.length;
    const upper = (x: number) => { let lo = 0, hi = all.length; while (lo < hi) { const mid = (lo + hi) >> 1; if (all[mid]! <= x) lo = mid + 1; else hi = mid; } return lo; };
    const rank = years.map((y) => {
      const v = [...daily.get(y)!].sort((x, z) => x - z), nv = v.length;
      let fs = 0; for (let i = 0; i < nv; i++) fs += Math.abs(upper(v[i]!) / all.length - (i + 1) / nv);
      return { fs: fs / nv, y, dev: Math.abs(v.reduce((x, z) => x + z, 0) / nv - meanAll) };
    });
    rank.sort((p, r) => p.fs - r.fs || p.y - r.y);
    const best = rank.slice(0, Math.max(1, candidates)).sort((p, r) => p.dev - r.dev || p.fs - r.fs || p.y - r.y)[0]!;
    chosen.push(best.y);
    const [a, b] = blocks.get(`${m}|${best.y}`)!;
    for (let i = a; i < b; i++) {
      const hh = h0 + i;
      const [, mm, dd] = civilFromDays(Math.floor(hh / 24));
      if (mm === 2 && dd === 29) continue;
      const k = (daysFromCivil(REF_YEAR, mm, dd) - base) * 24 + (((hh % 24) + 24) % 24);
      g[k] = h.ghi[i]!; d[k] = h.dhi[i]!;
      if (h.wind) w[k] = h.wind[i]!;
    }
  }
  return { tUtc: Float64Array.from({ length: 8760 }, (_, k) => base * 1440 + cm + 60 * k), ghi: g, dhi: d, unit: h.unit, wind: h.wind ? w : null,
    lat: h.lat, lon: h.lon, source: h.source, database: `${h.database} typical year ${yMin}-${yMax}`, kind: "tmy", centerMin: cm, tmyYears: chosen };
}

// ------------------------------------------------------------------ day series
export interface DayLight {
  minutes: Float64Array; step: number; zenith: Float64Array; azimuth: Float64Array;
  parDirectH: Float64Array; parDiffuse: Float64Array; wind: Float64Array;
  lightTotal?: number; // light in the hourly data for this day (data units x minutes)
  lightDropped?: number; // part of it dropped by the timing guard
  parCircumsolarH?: Float64Array; // circumsolar part of the diffuse PAR, from the sun's direction (Hay and Davies 1980);
                                  // parDiffuse is then the isotropic rest
}

export function hourlyWindow(h: HourlyLight, y: number, m: number, d: number, tz: number) {
  const start = daysFromCivil(y, m, d) * 1440 - 60 * tz;
  const cm = h.centerMin ?? 30;   // hour centers at hh:cm (hh:30 for hour means)
  const first = Math.floor((start - 60 - cm) / 60) * 60 + cm;
  const centers: number[] = [];
  for (let j = 0; first + 60 * j < start + 1440 + 90; j++) { const c = first + 60 * j; if (c + 30 > start && c - 30 < start + 1440) centers.push(c); }
  const idx: number[] = [];
  if (h.kind === "tmy") {
    const base = daysFromCivil(REF_YEAR, 1, 1);
    for (const c of centers) {
      const hh = Math.round((c - cm) / 60);   // whole UTC hours since the epoch
      let [, mm, dd] = civilFromDays(Math.floor(hh / 24));
      if (mm === 2 && dd === 29) { mm = 2; dd = 28; }
      idx.push((daysFromCivil(REF_YEAR, mm, dd) - base) * 24 + (((hh % 24) + 24) % 24));
    }
  } else {
    const t0 = h.tUtc[0]!;
    for (const c of centers) {
      const i = Math.round((c - t0) / 60);
      if (i < 0 || i >= h.tUtc.length || Math.abs(h.tUtc[i]! - c) > 1e-6) throw new Error(`The light data do not cover ${y}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}.`);
      idx.push(i);
    }
  }
  return { centers, ghi: idx.map((i) => h.ghi[i]!), dhi: idx.map((i) => h.dhi[i]!), wind: idx.map((i) => (h.wind ? h.wind[i]! : NaN)) };
}

export function dayLight(h: HourlyLight, y: number, m: number, d: number, lat: number, lon: number, tz: number, step = 10, noonShift = 0,
  circumsolar = true): DayLight {
  const { centers, ghi, dhi, wind } = hourlyWindow(h, y, m, d, tz);
  const day0 = daysFromCivil(y, m, d) * 1440 - 60 * tz;
  const N = 1440;
  const cosAt = (minute: number) => Math.max(0, Math.cos((sunWithNoon(y, m, d, minute, lat, lon, tz, noonShift).zenithGeometric * Math.PI) / 180));
  const cz = new Float64Array(N);
  for (let i = 0; i < N; i++) cz[i] = cosAt(i + 0.5);
  const gF = new Float64Array(N), bF = new Float64Array(N), wF = new Float64Array(N).fill(NaN), aF = new Float64Array(N);
  const doy = daysFromCivil(y, m, d) - daysFromCivil(y, 1, 1) + 1;
  const capUnit = h.unit === "W" ? 1 : PAR_FRACTION * Q_DIRECT; // W m-2 -> umol m-2 s-1 upper bound
  const e0n = extraterrestrialHorizontal(doy, 1.0) * capUnit;
  let total = 0, dropped = 0;
  const nH = centers.length;
  // per hour: cos(zenith) at its 60 minutes, their mean, the (capped) global and direct irradiance, the clearness
  const lo = new Float64Array(nH), meanS = new Float64Array(nH), G = new Float64Array(nH), B = new Float64Array(nH);
  const q = new Float64Array(nH), qb = new Float64Array(nH), i0s = new Int32Array(nH), i1s = new Int32Array(nH);
  const czh: Float64Array[] = [], ok: boolean[] = [];
  for (let k = 0; k < nH; k++) {
    lo[k] = centers[k]! - 30 - day0;
    const c = new Float64Array(60);
    let sumS = 0;
    for (let j = 0; j < 60; j++) { c[j] = cosAt(lo[k]! + j + 0.5); sumS += c[j]!; }
    czh.push(c); meanS[k] = sumS / 60;
    i0s[k] = Math.max(0, Math.ceil(lo[k]! - 0.5)); i1s[k] = Math.min(N, Math.ceil(lo[k]! + 60 - 0.5));
    let g = ghi[k]!, dd = dhi[k]!;
    const inside = Math.max(0, i1s[k]! - i0s[k]!);
    total += g * inside;
    const cap = KT_MAX * extraterrestrialHorizontal(doy, meanS[k]!) * capUnit;
    if (g > cap) { dropped += (g - cap) * inside; dd = g > 0 ? (dd * cap) / g : 0; g = cap; } // data and sun disagree
    G[k] = g; B[k] = g - dd;
    ok.push(meanS[k]! > 0 && g > 0);   // hours with sun and light (PVGIS-ERA5 gives 0 for the hour of sunrise)
    q[k] = ok[k] ? g / meanS[k]! : 0; qb[k] = ok[k] ? (g - dd) / meanS[k]! : 0;
  }
  /** Value at local minute t inside hour k: linear in time towards the neighbouring hour's centre (flat where it has no light). */
  const interp = (vals: Float64Array, k: number, t: number): number => {
    const dt = (t - (lo[k]! + 30)) / 60;   // -0.5 .. 0.5
    if (dt < 0) return k > 0 && ok[k - 1] ? vals[k]! + -dt * (vals[k - 1]! - vals[k]!) : vals[k]!;
    return k + 1 < nH && ok[k + 1] ? vals[k]! + dt * (vals[k + 1]! - vals[k]!) : vals[k]!;
  };
  for (let k = 0; k < nH; k++) {
    for (let i = i0s[k]!; i < i1s[k]!; i++) wF[i] = wind[k]!;
    if (!ok[k]) continue;
    let sg = 0, sb = 0;
    for (let j = 0; j < 60; j++) { const t = lo[k]! + j + 0.5; sg += interp(q, k, t) * czh[k]![j]!; sb += interp(qb, k, t) * czh[k]![j]!; }
    const fg = sg > 0 ? (60 * G[k]!) / sg : 0, fb = sb > 0 ? (60 * B[k]!) / sb : 0;   // keep the hour's totals
    for (let i = i0s[k]!; i < i1s[k]!; i++) {
      const t = i + 0.5;
      const gg = interp(q, k, t) * cz[i]! * fg;
      const dni = interp(qb, k, t) * fb;   // direct normal irradiance at this minute
      gF[i] = gg; bF[i] = Math.min(dni * cz[i]!, gg);
      // Hay-Davies anisotropy index: DNI over the extraterrestrial normal irradiance (0..1)
      if (circumsolar) aF[i] = e0n > 0 ? Math.min(Math.max(dni / e0n, 0), 1) : 0;
    }
  }
  const n = Math.round(1440 / step), per = N / n;
  const mins = new Float64Array(n), zen = new Float64Array(n), az = new Float64Array(n);
  const pb = new Float64Array(n), pd = new Float64Array(n), pc = new Float64Array(n), ws = new Float64Array(n);
  for (let s = 0; s < n; s++) {
    let sb = 0, sd = 0, sc = 0, sw = 0, cw = 0;
    for (let j = 0; j < per; j++) {
      const i = s * per + j;
      let b: number, dd: number;
      if (h.unit === "W") [b, dd] = toPar(gF[i]!, gF[i]! - bF[i]!);
      else { b = bF[i]!; dd = gF[i]! - bF[i]!; }
      const c = aF[i]! * dd;
      sb += b; sd += dd - c; sc += c;
      if (!Number.isNaN(wF[i]!)) { sw += wF[i]!; cw++; }
    }
    pb[s] = sb / per; pd[s] = sd / per; pc[s] = sc / per; ws[s] = cw ? sw / cw : NaN;
    mins[s] = (s + 0.5) * step;
    const sp = sunWithNoon(y, m, d, mins[s]!, lat, lon, tz, noonShift);
    zen[s] = sp.zenith; az[s] = sp.azimuth;
  }
  return { minutes: mins, step, zenith: zen, azimuth: az, parDirectH: pb, parDiffuse: pd, wind: ws, lightTotal: total, lightDropped: dropped,
    parCircumsolarH: pc };
}

/** Extraterrestrial irradiance on a horizontal plane (W m-2). */
export function extraterrestrialHorizontal(doy: number, cosZenith: number): number {
  const e0 = 1.0 + 0.033 * Math.cos((2.0 * Math.PI * doy) / 365.0);
  return SOLAR_CONSTANT * e0 * Math.max(0, cosZenith);
}

/** Default UTC offset for a longitude: the nearest whole hour of solar time (round half up). */
export function utcOffsetFromLon(lon: number): number {
  return Math.floor(lon / 15 + 0.5);
}

/** Great-circle distance (km) on a sphere of radius 6371 km. */
export function distanceKm(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const r = Math.PI / 180, p1 = lat1 * r, p2 = lat2 * r;
  const a = Math.sin((p2 - p1) / 2) ** 2 + Math.cos(p1) * Math.cos(p2) * Math.sin(((lon2 - lon1) * r) / 2) ** 2;
  return 2.0 * 6371.0 * Math.asin(Math.min(1, Math.sqrt(a)));
}

/** A typical year of cloud-free light for a site (see surface.py clear_sky_light): Haurwitz (1945) global
 *  irradiance averaged over each UTC hour from 10 samples, diffuse share from Erbs et al. (1982), constant wind. */
export function clearSkyLight(lat: number, lon: number, wind = CLEAR_SKY_WIND): HourlyLight {
  const nS = 10, n = 365 * 24, base = daysFromCivil(REF_YEAR, 1, 1);
  const ghi = new Float64Array(n), dhi = new Float64Array(n), cz = new Float64Array(nS);
  for (let k = 0; k < 365; k++) {
    const [, mm, dd] = civilFromDays(base + k);
    for (let hr = 0; hr < 24; hr++) {
      let g = 0, c = 0;
      for (let j = 0; j < nS; j++) {
        const v = Math.max(0, Math.cos((solarPosition(REF_YEAR, mm, dd, hr * 60 + (j + 0.5) * (60 / nS), lat, lon, 0).zenithGeometric * Math.PI) / 180));
        cz[j] = v; c += v;
        if (v > 0) g += 1098.0 * v * Math.exp(-0.059 / v);
      }
      g /= nS;
      const e = extraterrestrialHorizontal(k + 1, c / nS);
      const kt = e > 0 ? g / e : 0;
      ghi[k * 24 + hr] = g; dhi[k * 24 + hr] = erbsDiffuseFraction(kt) * g;
    }
  }
  return { tUtc: Float64Array.from({ length: n }, (_, i) => base * 1440 + 30 + 60 * i), ghi, dhi, unit: "W",
    wind: new Float64Array(n).fill(wind), lat, lon, source: "clear-sky estimate", database: "clear sky (Haurwitz 1945)", kind: "tmy" };
}

export function dailyIntegral(values: ArrayLike<number>, stepMin: number): number {
  let s = 0;
  for (let i = 0; i < values.length; i++) s += values[i]!;
  return (s * stepMin * 60) / 1e6;
}

export { solarPosition };
