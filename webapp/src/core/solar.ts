// Solar position, solar noon, sunrise and sunset. Port of python/src/coralshading/solar.py (the reference);
// both must reproduce shared/golden/solar.json. NOAA solar calculator equations after Meeus (1998).
// Dates are civil dates at the site; times are minutes after local midnight on the site's standard clock
// (UTC + utcOffsetH, no daylight saving). Azimuth clockwise from north.

const RAD = Math.PI / 180;

export function daysFromCivil(y: number, m: number, d: number): number {
  y -= m <= 2 ? 1 : 0;
  const era = Math.floor((y >= 0 ? y : y - 399) / 400);
  const yoe = y - era * 400;
  const doy = Math.floor((153 * (m + (m > 2 ? -3 : 9)) + 2) / 5) + d - 1;
  const doe = yoe * 365 + Math.floor(yoe / 4) - Math.floor(yoe / 100) + doy;
  return era * 146097 + doe - 719468;
}

function mod(a: number, n: number): number {
  return ((a % n) + n) % n;
}

export function orbit(jd: number): { decl: number; eot: number } {
  const jc = (jd - 2451545.0) / 36525.0;
  const L0 = mod(280.46646 + jc * (36000.76983 + jc * 0.0003032), 360.0);
  const M = 357.52911 + jc * (35999.05029 - 0.0001537 * jc);
  const e = 0.016708634 - jc * (0.000042037 + 0.0000001267 * jc);
  const C = Math.sin(M * RAD) * (1.914602 - jc * (0.004817 + 0.000014 * jc))
    + Math.sin(2 * M * RAD) * (0.019993 - 0.000101 * jc) + Math.sin(3 * M * RAD) * 0.000289;
  const omega = 125.04 - 1934.136 * jc;
  const app = L0 + C - 0.00569 - 0.00478 * Math.sin(omega * RAD);
  const eps0 = 23.0 + (26.0 + (21.448 - jc * (46.815 + jc * (0.00059 - jc * 0.001813))) / 60.0) / 60.0;
  const eps = eps0 + 0.00256 * Math.cos(omega * RAD);
  const decl = Math.asin(Math.sin(eps * RAD) * Math.sin(app * RAD)) / RAD;
  const yy = Math.tan((eps / 2) * RAD) ** 2;
  const eot = (4.0 / RAD) * (yy * Math.sin(2 * L0 * RAD) - 2 * e * Math.sin(M * RAD)
    + 4 * e * yy * Math.sin(M * RAD) * Math.cos(2 * L0 * RAD)
    - 0.5 * yy * yy * Math.sin(4 * L0 * RAD) - 1.25 * e * e * Math.sin(2 * M * RAD));
  return { decl, eot };
}

export function julianDay(y: number, m: number, d: number, minuteLocal: number, utcOffsetH: number): number {
  return daysFromCivil(y, m, d) + (minuteLocal - 60.0 * utcOffsetH) / 1440.0 + 2440587.5;
}

export function atmosphericRefractionDeg(elevDeg: number): number {
  const te = Math.tan(Math.min(Math.max(elevDeg, -89.0), 89.9) * RAD);
  let r: number;
  if (elevDeg > 85.0) r = 0.0;
  else if (elevDeg > 5.0) r = 58.1 / te - 0.07 / te ** 3 + 0.000086 / te ** 5;
  else if (elevDeg > -0.575) r = 1735.0 + elevDeg * (-518.2 + elevDeg * (103.4 + elevDeg * (-12.79 + elevDeg * 0.711)));
  else r = -20.772 / te;
  return r / 3600.0;
}

export interface SunPosition {
  zenith: number; // apparent (refracted), degrees
  azimuth: number; // degrees clockwise from north
  zenithGeometric: number;
  declination: number;
  eot: number; // minutes
}

export function solarPosition(y: number, m: number, d: number, minuteLocal: number, lat: number, lon: number, utcOffsetH: number): SunPosition {
  const jd = julianDay(y, m, d, minuteLocal, utcOffsetH);
  const { decl, eot } = orbit(jd);
  const tst = mod(minuteLocal + eot + 4.0 * lon - 60.0 * utcOffsetH, 1440.0);
  const ha = tst / 4.0 - 180.0;
  const cz = Math.sin(lat * RAD) * Math.sin(decl * RAD) + Math.cos(lat * RAD) * Math.cos(decl * RAD) * Math.cos(ha * RAD);
  const zen = Math.acos(Math.min(1, Math.max(-1, cz))) / RAD;
  const sz = Math.sin(zen * RAD);
  let azArg = (Math.sin(lat * RAD) * Math.cos(zen * RAD) - Math.sin(decl * RAD)) / (Math.cos(lat * RAD) * sz);
  if (!Number.isFinite(azArg)) azArg = 1.0;
  const az0 = Math.acos(Math.min(1, Math.max(-1, azArg))) / RAD;
  const az = ha > 0 ? mod(az0 + 180.0, 360.0) : mod(540.0 - az0, 360.0);
  const zenApp = zen - atmosphericRefractionDeg(90.0 - zen);
  return { zenith: zenApp, azimuth: az, zenithGeometric: zen, declination: decl, eot };
}

export function solarNoon(y: number, m: number, d: number, lon: number, utcOffsetH: number): number {
  let t = 720.0;
  for (let i = 0; i < 3; i++) {
    const { eot } = orbit(julianDay(y, m, d, t, utcOffsetH));
    t = 720.0 - 4.0 * lon - eot + 60.0 * utcOffsetH;
  }
  return t;
}

export function sunriseSunset(y: number, m: number, d: number, lat: number, lon: number, utcOffsetH: number): [number, number] {
  const out: number[] = [];
  for (const sign of [-1.0, 1.0]) {
    let t = solarNoon(y, m, d, lon, utcOffsetH);
    for (let i = 0; i < 4; i++) {
      const { decl, eot } = orbit(julianDay(y, m, d, t, utcOffsetH));
      const arg = Math.cos(90.833 * RAD) / (Math.cos(lat * RAD) * Math.cos(decl * RAD)) - Math.tan(lat * RAD) * Math.tan(decl * RAD);
      if (Math.abs(arg) > 1) return [NaN, NaN];
      const ha = Math.acos(arg) / RAD;
      t = 720.0 - 4.0 * (lon - sign * ha) - eot + 60.0 * utcOffsetH;
    }
    out.push(t);
  }
  return [out[0]!, out[1]!];
}

// ------------------------------------------------------------------ solar noon control
export type NoonMode = "computed" | "user" | "data";

/** Solar noon from a day of light data: the irradiance-weighted mean time (first moment). */
export function dataNoon(minutes: ArrayLike<number>, ghi: ArrayLike<number>): number {
  let s = 0, sw = 0;
  for (let i = 0; i < minutes.length; i++) {
    const g = Math.max(0, ghi[i]!);
    s += minutes[i]! * g; sw += g;
  }
  if (sw <= 0) throw new Error("no light in the data");
  return s / sw;
}

/** Minutes to shift the sun's timing so solar noon falls at the chosen time (sun evaluated at t - shift). */
export function noonShift(mode: NoonMode, computed: number, user?: number, data?: number): number {
  if (mode === "computed") return 0.0;
  if (mode === "user") {
    if (user === undefined) throw new Error("user noon not set");
    return user - computed;
  }
  if (data === undefined) throw new Error("data noon not available");
  return data - computed;
}

export function sunWithNoon(y: number, m: number, d: number, minuteLocal: number, lat: number, lon: number, utcOffsetH: number, shiftMin = 0): SunPosition {
  return solarPosition(y, m, d, minuteLocal - shiftMin, lat, lon, utcOffsetH);
}
