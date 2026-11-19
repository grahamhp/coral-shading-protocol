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
    source: "PVGIS 5.3", database, kind };
  return kind === "tmy" ? tmyToReferenceYear(h) : h;
}

export function tmyToReferenceYear(h: HourlyLight): HourlyLight {
  const g = new Float64Array(8760), d = new Float64Array(8760), w = new Float64Array(8760).fill(NaN);
  const base = daysFromCivil(REF_YEAR, 1, 1);
  for (let i = 0; i < h.tUtc.length; i++) {
    const c = h.tUtc[i]! - 30;
    const [, mm, dd] = civilFromDays(Math.floor(c / 1440));
    if (mm === 2 && dd === 29) continue;
    const k = (daysFromCivil(REF_YEAR, mm, dd) - base) * 24 + Math.floor((((c % 1440) + 1440) % 1440) / 60);
    g[k] = h.ghi[i]!; d[k] = h.dhi[i]!;
    if (h.wind) w[k] = h.wind[i]!;
  }
  const t = Float64Array.from({ length: 8760 }, (_, k) => base * 1440 + 30 + 60 * k);
  return { ...h, tUtc: t, ghi: g, dhi: d, wind: h.wind ? w : null, kind: "tmy" };
}

export function lightFromJson(j: any): HourlyLight {
  const base = daysFromCivil(j.ref_year ?? REF_YEAR, 1, 1);
  const n = j.ghi.length;
  return { tUtc: Float64Array.from({ length: n }, (_, k) => base * 1440 + 30 + 60 * k), ghi: Float64Array.from(j.ghi),
    dhi: Float64Array.from(j.dhi), unit: j.unit, wind: j.wind ? Float64Array.from(j.wind, (v: number | null) => v ?? NaN) : null,
    lat: j.lat ?? null, lon: j.lon ?? null, source: j.source ?? "", database: j.database ?? "", kind: j.kind };
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
  const first = Math.floor((start - 60) / 60) * 60 + 30;
  const centers: number[] = [];
  for (let c = first; c < start + 1440 + 60; c += 60) if (c + 30 > start && c - 30 < start + 1440) centers.push(c);
  const idx: number[] = [];
  if (h.kind === "tmy") {
    const base = daysFromCivil(REF_YEAR, 1, 1);
    for (const c of centers) {
      let [, mm, dd] = civilFromDays(Math.floor((c - 30) / 1440));
      if (mm === 2 && dd === 29) { mm = 2; dd = 28; }
      idx.push((daysFromCivil(REF_YEAR, mm, dd) - base) * 24 + Math.floor(((((c - 30) % 1440) + 1440) % 1440) / 60));
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
  const cz = new Float64Array(N);
  for (let i = 0; i < N; i++) cz[i] = Math.max(0, Math.cos((sunWithNoon(y, m, d, i + 0.5, lat, lon, tz, noonShift).zenithGeometric * Math.PI) / 180));
  const gF = new Float64Array(N), bF = new Float64Array(N), wF = new Float64Array(N).fill(NaN), aF = new Float64Array(N);
  const doy = daysFromCivil(y, m, d) - daysFromCivil(y, 1, 1) + 1;
  const capUnit = h.unit === "W" ? 1 : PAR_FRACTION * Q_DIRECT; // W m-2 -> umol m-2 s-1 upper bound
  let total = 0, dropped = 0;
  for (let k = 0; k < centers.length; k++) {
    const lo = centers[k]! - 30 - day0;
    let sumS = 0;
    for (let j = 0; j < 60; j++) sumS += Math.max(0, Math.cos((sunWithNoon(y, m, d, lo + j + 0.5, lat, lon, tz, noonShift).zenithGeometric * Math.PI) / 180));
    const meanS = sumS / 60;
    const i0 = Math.max(0, Math.ceil(lo - 0.5)), i1 = Math.min(N, Math.ceil(lo + 60 - 0.5));
    let G = ghi[k]!, D = dhi[k]!;
    const inside = Math.max(0, i1 - i0);
    total += G * inside;
    const cap = KT_MAX * extraterrestrialHorizontal(doy, meanS) * capUnit;
    if (G > cap) { dropped += (G - cap) * inside; D = G > 0 ? (D * cap) / G : 0; G = cap; } // data and sun disagree
    // Hay-Davies anisotropy index: DNI over the extraterrestrial normal irradiance (0..1)
    let A = 0;
    if (circumsolar && meanS > 0) { const e0n = extraterrestrialHorizontal(doy, 1.0) * capUnit; A = e0n > 0 ? Math.min(Math.max((G - D) / meanS / e0n, 0), 1) : 0; }
    for (let i = i0; i < i1; i++) {
      if (meanS > 0) { gF[i] = (G * cz[i]!) / meanS; bF[i] = ((G - D) * cz[i]!) / meanS; aF[i] = A; }
      wF[i] = wind[k]!;
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
