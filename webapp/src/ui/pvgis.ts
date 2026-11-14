// PVGIS download links and file import. PVGIS blocks direct (AJAX) calls from web pages, so the app opens a
// download link (browser=1) and reads the file the user saves. PVGIS chooses the database for the location.
import { type HourlyLight, parsePVGIS, civilFromDays, distanceKm, MATCH_KM } from "../core/surface.ts";

const BASE = "https://re.jrc.ec.europa.eu/api/v5_3";
const r4 = (v: number) => v.toFixed(4);

export function tmyUrl(lat: number, lon: number): string {
  return `${BASE}/tmy?lat=${r4(lat)}&lon=${r4(lon)}&outputformat=csv&browser=1`;
}

export function hourlyUrl(lat: number, lon: number, startYear: number, endYear: number): string {
  return `${BASE}/seriescalc?lat=${r4(lat)}&lon=${r4(lon)}&startyear=${startYear}&endyear=${endYear}&components=1&outputformat=csv&browser=1`;
}

export interface Imported { light: HourlyLight; summary: string; years: [number, number] | null; warning: string | null }

export function importText(text: string, siteLat: number, siteLon: number): Imported {
  const light = parsePVGIS(text);
  let years: [number, number] | null = null;
  if (light.kind === "hourly") {
    const y0 = civilFromDays(Math.floor(light.tUtc[0]! / 1440))[0], y1 = civilFromDays(Math.floor(light.tUtc[light.tUtc.length - 1]! / 1440))[0];
    years = [y0, y1];
  }
  let warning: string | null = null;
  if (light.lat !== null && light.lon !== null) {
    const d = distanceKm(siteLat, siteLon, light.lat, light.lon);
    if (d > MATCH_KM) warning = `This file is for ${light.lat.toFixed(3)}, ${light.lon.toFixed(3)}, about ${d.toFixed(0)} km from the site. Using it moves the site there.`;
    else if (d > 10) warning = `This file is for ${light.lat.toFixed(3)}, ${light.lon.toFixed(3)}, about ${d.toFixed(0)} km from the site; it is used as is.`;
  }
  const kind = light.kind === "tmy" ? "typical year" : `hourly ${years![0]}–${years![1]}`;
  const summary = `${light.database || "PVGIS"} · ${kind} · irradiance in W m⁻² (converted to PAR)${light.wind ? " · wind included" : ""}`;
  return { light, summary, years, warning };
}

export function readFile(file: File): Promise<string> {
  return new Promise((ok, fail) => { const r = new FileReader(); r.onload = () => ok(String(r.result)); r.onerror = () => fail(r.error); r.readAsText(file); });
}
