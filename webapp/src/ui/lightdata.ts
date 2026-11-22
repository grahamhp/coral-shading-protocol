// Weather for any site without a file: ten years of hourly ERA5 global and diffuse irradiance from the Open-Meteo
// archive, reduced to a typical year (core/surface.ts typicalYear). ERA5 is the reanalysis PVGIS itself uses outside
// its satellite area, so there the two agree hour by hour (see docs/validation.md). The typical year is kept in the
// browser's storage so a site visited before works offline.
import { type HourlyLight, parseOpenMeteo, typicalYear, lightFromJson, distanceKm, MATCH_KM, REF_YEAR } from "../core/surface.ts";

export const N_YEARS = 10;
const API = "https://archive-api.open-meteo.com/v1/archive";

/** The last N_YEARS complete calendar years. One more day is requested: Open-Meteo stamps each hour at its end,
 *  so the last hour of 31 December carries the stamp of 1 January 00:00. */
export function era5Url(lat: number, lon: number, today = new Date()): string {
  const y1 = today.getUTCFullYear() - 1, y0 = y1 - N_YEARS + 1;
  return `${API}?latitude=${lat.toFixed(4)}&longitude=${lon.toFixed(4)}&start_date=${y0}-01-01&end_date=${y1 + 1}-01-01`
    + "&hourly=shortwave_radiation,diffuse_radiation,wind_speed_10m&models=era5&timezone=GMT&wind_speed_unit=ms";
}

export async function fetchTypicalYear(lat: number, lon: number, signal: AbortSignal): Promise<HourlyLight> {
  const ctl = new AbortController();
  const stop = () => ctl.abort();
  signal.addEventListener("abort", stop);
  const timer = setTimeout(stop, 90_000);
  try {
    const r = await fetch(era5Url(lat, lon), { signal: ctl.signal });
    const text = await r.text();
    let j: any;
    try { j = JSON.parse(text); } catch { throw new Error(`the weather service answered ${r.status}`); }
    if (j.error) throw new Error(String(j.reason ?? "the weather service refused the request"));
    const h = parseOpenMeteo(j);
    // the stamp of 1 January 00:00 after the last year closes that year; drop the other hours of that extra day
    const ty = typicalYear(h);
    return { ...ty, source: "Open-Meteo archive API (ERA5)" };
  } catch (e) {
    if (ctl.signal.aborted && !signal.aborted) throw new Error("no answer within 90 seconds");
    if (e instanceof TypeError) throw new Error("no connection to the weather service");
    throw e;
  } finally { clearTimeout(timer); signal.removeEventListener("abort", stop); }
}

export const ERA5_LABEL = (h: HourlyLight) => {
  const ys = h.tmyYears ?? [];
  return `ERA5 reanalysis typical year${ys.length ? ` (months chosen from ${Math.min(...ys)}–${Math.max(...ys)})` : ""}, fetched from Open-Meteo for ${h.lat?.toFixed(2)}, ${h.lon?.toFixed(2)}`;
};

// ------------------------------------------------------------------ storage (per browser; may be unavailable)
const KEY = "csp.light.v1", MAX_SITES = 6;
interface Stored { t: number; lat: number; lon: number; db: string; cm: number; years: number[] | null; g: number[]; d: number[]; w: number[] | null }

function readAll(): Stored[] {
  try { const j = JSON.parse(localStorage.getItem(KEY) ?? "[]"); return Array.isArray(j) ? j : []; } catch { return []; }
}

export function cachePut(h: HourlyLight): void {
  if (h.lat === null || h.lon === null || h.kind !== "tmy") return;
  const item: Stored = { t: Date.now(), lat: h.lat, lon: h.lon, db: h.database, cm: h.centerMin ?? 30, years: h.tmyYears ?? null,
    g: Array.from(h.ghi, (v) => Math.round(v)), d: Array.from(h.dhi, (v) => Math.round(v)), w: h.wind ? Array.from(h.wind, (v) => (Number.isFinite(v) ? Math.round(v * 10) : -1)) : null };
  let all = readAll().filter((s) => distanceKm(s.lat, s.lon, item.lat, item.lon) > 1);
  all.unshift(item);
  for (let n = Math.min(all.length, MAX_SITES); n >= 1; n--) {
    try { localStorage.setItem(KEY, JSON.stringify(all.slice(0, n))); return; } catch { /* storage full or unavailable: keep fewer */ }
  }
}

export function cacheGet(lat: number, lon: number): HourlyLight | null {
  const s = readAll().find((x) => distanceKm(lat, lon, x.lat, x.lon) <= MATCH_KM / 2);
  if (!s || s.g?.length !== 8760) return null;
  try {
    return lightFromJson({ kind: "tmy", unit: "W", source: "Open-Meteo archive API (ERA5)", database: s.db, lat: s.lat, lon: s.lon, ref_year: REF_YEAR,
      center_min: s.cm, tmy_years: s.years, ghi: s.g, dhi: s.d, wind: s.w ? s.w.map((v) => (v < 0 ? null : v / 10)) : null });
  } catch { return null; }
}
