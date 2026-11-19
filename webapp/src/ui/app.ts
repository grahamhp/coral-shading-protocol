// Coral Shading Protocol v5: the browser interface.
import { VERSION } from "../core/index.ts";
import type { Tables } from "../core/engine.ts";
import type { PresetFile } from "../core/pe.ts";
import { type HourlyLight, lightFromJson, clearSkyLight, distanceKm, utcOffsetFromLon, MATCH_KM } from "../core/surface.ts";
import { solarNoon } from "../core/solar.ts";
import type { Inputs, Results, ScenarioOut } from "./compute.ts";
import type { Day } from "../core/scenarios.ts";
import { HELP } from "./help.ts";
import { COLORS, ZONE_TINTS, lineChart, mapChart, colorbar, dailyLightChart, peChart } from "./charts.ts";
import { tmyUrl, hourlyUrl, importText, readFile } from "./pvgis.ts";

declare const L: any;   // Leaflet (bundled UMD build)

interface Boot { tables: Tables; presets: PresetFile & { presets: any[] }; example: any; references: { references: Record<string, any> }; workerSource: string }
declare const CSP_BOOT: Boot;

const $ = <T extends HTMLElement = HTMLElement>(sel: string, root: ParentNode = document) => root.querySelector(sel) as T;
const esc = (s: string) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);
const fmt = (v: number, d = 1) => (Number.isFinite(v) ? v.toFixed(d) : "–");
const pct = (v: number) => `${Math.round(v)} %`;
const MON = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const dstr = (d: [number, number, number]) => `${d[0]}-${String(d[1]).padStart(2, "0")}-${String(d[2]).padStart(2, "0")}`;
const parseDate = (s: string): [number, number, number] => { const [y, m, d] = s.split("-").map(Number); return [y!, m!, d!]; };
const hhmm = (min: number) => `${String(Math.floor(min / 60)).padStart(2, "0")}:${String(Math.round(min % 60)).padStart(2, "0")}`;

const TARGETS: Record<string, { label: string; shape: "rect" | "circle"; lx: number; ly: number }> = {
  reef_star: { label: "MARRS Reef Star (1.1 m)", shape: "circle", lx: 1.1, ly: 1.1 },
  table: { label: "Nursery table 1 × 2 m (long north–south)", shape: "rect", lx: 1.0, ly: 2.0 },
  rope: { label: "Rope nursery 1 × 4 m (long north–south)", shape: "rect", lx: 1.0, ly: 4.0 },
  rect: { label: "Rectangle (set size)", shape: "rect", lx: 1.0, ly: 1.0 },
  circle: { label: "Circle (set size)", shape: "circle", lx: 1.0, ly: 1.0 },
};
const KD_PRESETS: [string, string, number][] = [["clear", "Clear water · Kd 0.06", 0.06], ["moderate", "Moderate reef · Kd 0.10", 0.10],
  ["sipaway", "Sipaway 2025 · Kd 0.21", 0.21], ["turbid", "Turbid inshore · Kd 0.45", 0.45]];

interface UI { mode: "simple" | "expert"; targetKey: string; kdKey: string; lightLabel: string; lightKind: string; noonMode: "computed" | "user"; windMode: "data" | "set";
  clothAuto: boolean; canopyAuto: boolean; day: Day | null }

const ex = CSP_BOOT.example;
const state: Inputs = {
  site: { name: ex.name, lat: ex.lat, lon: ex.lon, tz: ex.utc_offset_h },
  start: parseDate(ex.deployment.start), end: parseDate(ex.deployment.end),
  target: { shape: "circle", lx: 1.1, ly: 1.1 }, depth: 10, height: 0.75, water: { kd: 0.10, w0: 0.9 },
  scenario: "both", sync: true, clothRating: 80, dynamicTargetReduction: 75, clothSize: null, canopy: null,
  noonShift: 0, wind: null, coral: { preset: "typical", acclimate: "site" }, gridSpacing: 0.05,
};
const ui: UI = { mode: "simple", targetKey: "reef_star", kdKey: "moderate", lightLabel: "Sipaway 2025 example · PVGIS-ERA5 typical year", lightKind: "tmy",
  noonMode: "computed", windMode: "data", clothAuto: true, canopyAuto: true, day: null };
let light: HourlyLight = lightFromJson(ex.light);
let dataLight = light, dataLabel = ui.lightLabel;   // the loaded data (example or file); `light` may be a clear-sky stand-in
const isClear = () => light.database.startsWith("clear sky");
/** What a day in the results represents, and the assumptions behind daily values (as Python's DesignResult). */
const weatherLabel = () => (isClear() ? "clear-sky estimate" : ui.lightKind === "tmy" ? "typical-year day" : "recorded");
const assumptions = () => `daily values assume Kd ${state.water.kd} m-1 on every day and a fixed depth of ${state.depth} m (no tide); `
  + ({ "typical-year day": "with typical-year light each date is one typical-year day, not that year's weather",
    recorded: "recorded hourly weather", "clear-sky estimate": "clear-sky light (no clouds)" } as Record<string, string>)[weatherLabel()];
const noonText = () => { const n = solarNoon(state.start[0], state.start[1], state.start[2], state.site.lon, state.site.tz); return hhmm(((n % 1440) + 1440) % 1440); };

/** Use the loaded light data when they are for a point within MATCH_KM of the site; otherwise a clear-sky estimate. */
function matchLight(): boolean {
  const prev = light, { lat, lon } = state.site;
  if (dataLight.lat === null || dataLight.lon === null || distanceKm(lat, lon, dataLight.lat, dataLight.lon) <= MATCH_KM) {
    light = dataLight; ui.lightLabel = dataLabel; ui.lightKind = dataLight.kind;
  } else {
    light = clearSkyLight(lat, lon); ui.lightKind = "tmy";
    ui.lightLabel = "Clear-sky estimate for this site (no clouds). Light data → Change… gets the PVGIS typical year for real weather.";
  }
  return light !== prev;
}

/** Update the site-dependent text in the left panel without re-rendering it (keeps the map and the focus). */
function refreshSiteInfo() {
  const tzEl = document.getElementById("tz") as HTMLInputElement | null;
  if (tzEl && document.activeElement !== tzEl) tzEl.value = String(state.site.tz);
  const lab = document.getElementById("light-label");
  if (lab) { lab.textContent = ui.lightLabel; lab.classList.toggle("warn", isClear()); }
  const nb = document.querySelector('[data-tog="noonMode"] button[data-v="computed"]');
  if (nb) nb.textContent = `Computed ${noonText()}`;
}
let last: Results | null = null;
let runId = 0, worker: Worker | null = null, busy = false, guess: number | undefined;

// ------------------------------------------------------------------ worker
function startWorker() {
  if (worker) worker.terminate();
  const url = URL.createObjectURL(new Blob([CSP_BOOT.workerSource], { type: "text/javascript" }));
  worker = new Worker(url);
  worker.postMessage({ type: "init", tables: CSP_BOOT.tables, presets: CSP_BOOT.presets, light });
  worker.onmessage = (ev: MessageEvent) => {
    const m = ev.data;
    if (m.id !== runId) return;
    if (m.type === "error") { busy = false; setStatus(`⚠ ${m.message}`, true); return; }
    last = m.result as Results;
    const dyn = last.scenarios.find((s) => s.kind === "dynamic");
    if (dyn && !state.canopy) guess = dyn.panel.lx;
    if (last.level === "robust") busy = false;
    renderResults();
    setStatus(last.level === "preview" ? `Preview (${Math.round(last.ms)} ms) · refining…`
      : last.level === "full" ? `Full resolution · ${last.points.length / 2} points × ${last.days.length} days · checking robustness…`
      : `Full resolution · ${(last.ms / 1000).toFixed(1)} s · ${last.points.length / 2} points × ${last.days.length} days`);
  };
}

let timer: number | undefined;
function schedule() {
  window.clearTimeout(timer);
  timer = window.setTimeout(() => {
    runId++;
    if (busy) startWorker();          // drop stale work
    busy = true;
    setStatus("Computing…");
    worker!.postMessage({ type: "run", id: runId, inputs: JSON.parse(JSON.stringify(state)), full: true, guess });
  }, 120);
}

function setStatus(text: string, err = false) { const s = $("#status"); s.textContent = text; s.classList.toggle("err", err); }

// ------------------------------------------------------------------ help popups
function info(key: string): string {
  const h = HELP[key];
  if (!h) return "";
  const refs = CSP_BOOT.references.references;
  const table = h.table ? `<table>${h.table.map(([a, b]) => `<tr><td>${esc(a)}</td><td>${esc(b)}</td></tr>`).join("")}</table>` : "";
  const src = h.refs?.length ? `<div class="src">Sources: ${h.refs.map((k) => { const r = refs[k]; if (!r) return esc(k);
    const au = (r.authors ?? [])[0] ? String(r.authors[0]).replace(/\s+[A-Z]+$/, "") + ((r.authors.length > 1) ? " et al." : "") : k;
    const link = r.doi ? `https://doi.org/${r.doi}` : r.url; return link ? `<a href="${link}" target="_blank" rel="noopener">${esc(au)} ${r.year}</a>` : `${esc(au)} ${r.year}`; }).join("; ")}</div>` : "";
  return `<span class="info" tabindex="0" aria-label="About ${esc(h.title)}">i<span class="pop" role="tooltip"><b>${esc(h.title)}</b>${esc(h.body)}${table}${src}</span></span>`;
}

// ------------------------------------------------------------------ left panel
const sel = (id: string, opts: [string, string][], v: string) => `<select id="${id}" class="sel">${opts.map(([k, l]) => `<option value="${k}"${k === v ? " selected" : ""}>${esc(l)}</option>`).join("")}</select>`;
const num = (id: string, v: number, step = 0.01, unit = "", min?: number, max?: number) =>
  `<span class="inp"><input id="${id}" type="number" step="${step}" value="${v}"${min !== undefined ? ` min="${min}"` : ""}${max !== undefined ? ` max="${max}"` : ""}>${unit ? `<span class="unit">${unit}</span>` : ""}</span>`;
const tog = (name: string, opts: [string, string][], v: string) => `<span class="tog" data-tog="${name}">${opts.map(([k, l]) => `<button type="button" data-v="${k}" class="${k === v ? "on" : ""}">${esc(l)}</button>`).join("")}</span>`;

function renderLeft() {
  const P = CSP_BOOT.presets.presets;
  const E = ui.mode === "expert";
  const t = state.target;
  const customT = ui.targetKey === "rect" || ui.targetKey === "circle";
  const tauC = state.tauClean ?? 1 - state.clothRating / 100;
  $("#left").innerHTML = `
  <section class="card step"><h3><i>1</i>Site ${info("site")}</h3>
    <div id="map" class="map"><div class="map-off">Map needs internet. Type coordinates below.</div></div>
    <div class="row"><input id="search" class="txt" placeholder="Search a place (needs internet)"><button id="btn-search" class="btn ghost sm">Find</button></div>
    <div class="coords"><label>Lat<input id="lat" type="number" step="0.0001" value="${state.site.lat}"></label><label>Lon<input id="lon" type="number" step="0.0001" value="${state.site.lon}"></label><label>UTC<input id="tz" type="number" step="0.5" value="${state.site.tz}"></label></div>
    <div class="field"><label>Light data ${info("lightData")}</label><button id="btn-data" class="btn ghost sm">Change…</button></div>
    <p class="sub${isClear() ? " warn" : ""}" id="light-label">${esc(ui.lightLabel)}</p>
    <div class="lab">Deployment ${info("deployment")}</div><div class="dates"><input id="start" type="date" value="${dstr(state.start)}" aria-label="Start"><span>to</span><input id="end" type="date" value="${dstr(state.end)}" aria-label="End"></div>
    <div class="field"><label>Solar noon ${info("noon")}</label>${tog("noonMode", [["computed", `Computed ${noonText()}`], ["user", "Shift"]], ui.noonMode)}</div>
    ${ui.noonMode === "user" ? `<div class="field"><label>Shift (minutes, + = later)</label>${num("noonShift", state.noonShift, 1, "min")}</div>` : ""}
    ${E ? `<div class="field"><label>Waves ${info("waves")}</label>${tog("windMode", [["data", "Wind from data"], ["set", "Set wind"]], ui.windMode)}</div>
    ${ui.windMode === "set" ? `<div class="field"><label>Wind speed</label>${num("wind", state.wind ?? 5, 0.5, "m s⁻¹", 0, 25)}</div>` : ""}` : ""}
  </section>
  <section class="card step"><h3><i>2</i>Corals and structure</h3>
    <div class="field"><label>Coral area ${info("target")}</label>${sel("target", Object.entries(TARGETS).map(([k, v]) => [k, v.label]), ui.targetKey)}</div>
    ${customT || E ? `<div class="field"><label>${t.shape === "circle" ? "Diameter" : "East–west × north–south"}</label><span class="pair">${num("tlx", t.lx, 0.05, "", 0.1, 20)}${t.shape === "rect" ? `<span>×</span>${num("tly", t.ly, 0.05, "m", 0.1, 20)}` : `<span class="unit">m</span>`}</span></div>` : ""}
    <div class="field"><label>Depth of the corals ${info("depth")}</label>${num("depth", state.depth, 0.5, "m", 0.5, 60)}</div>
    <div class="field"><label>Height above corals ${info("height")}</label>${num("height", state.height, 0.05, "m", 0.05, 30)}</div>
    ${E ? `<div class="field"><label>Kd (PAR) ${info("kd")}</label>${num("kd", state.water.kd, 0.01, "m⁻¹", 0.02, 1.5)}</div>
    <div class="field"><label>Scattering ω₀ ${info("w0")}</label>${num("w0", state.water.w0, 0.05, "", 0.5, 0.9)}</div>`
    : `<div class="field"><label>Water clarity ${info("kd")}</label>${sel("kdPreset", [...KD_PRESETS.map(([k, l]) => [k, l] as [string, string]), ...(ui.kdKey === "custom" ? [["custom", `Custom · Kd ${state.water.kd}`] as [string, string]] : [])], ui.kdKey)}</div>`}
    <div class="lab">Shading ${info("scenario")}</div>${tog("scenario", [["constant", "Constant shading"], ["dynamic", "Dynamic shading"], ["both", "Both"]], state.scenario)}
    ${state.scenario !== "dynamic" ? `<div class="field"><label>Cloth shade rating ${info("clothRating")}</label><span class="val">${state.clothRating} %</span></div>
    <input id="rating" class="slider" type="range" min="10" max="99" step="1" value="${state.clothRating}">` : ""}
    ${state.scenario === "both" ? `<div class="lab">Dynamic shading ${info("sync")}</div>${tog("sync", [["yes", "Same light as constant"], ["no", "Set its own target"]], state.sync ? "yes" : "no")}` : ""}
    ${state.scenario !== "constant" && (!state.sync || state.scenario === "dynamic") ? `<div class="field"><label>Dynamic shading: light reduction</label><span class="val">${state.dynamicTargetReduction} %</span></div>
    <input id="dynRed" class="slider" type="range" min="10" max="95" step="1" value="${state.dynamicTargetReduction}">` : ""}
  </section>
  ${E && state.scenario !== "dynamic" ? `<section class="card step"><h3><i>·</i>Constant shading: shade cloth ${info("fouling")}</h3>
    <div class="field"><label>Light through, clean</label>${num("tauClean", +tauC.toFixed(3), 0.01, "", 0, 1)}</div>
    <div class="field"><label>Light through, fouled</label>${num("tauFouled", state.tauFouled ?? +Math.max(0, tauC * 0.7).toFixed(3), 0.01, "", 0, 1)}</div>
    <div class="field"><label>Share of time fouled</label>${num("fouledShare", Math.round(100 * (state.fouledShare ?? 0)), 5, "%", 0, 100)}</div>
    <div class="field"><label>Size</label>${tog("clothAuto", [["auto", "Automatic"], ["set", "Set"]], ui.clothAuto ? "auto" : "set")}</div>
    ${!ui.clothAuto ? `<div class="field"><label>East–west × north–south</label><span class="pair">${num("clx", state.clothSize?.lx ?? 3, 0.05)}<span>×</span>${num("cly", state.clothSize?.ly ?? 2, 0.05, "m")}</span></div>` : ""}
  </section>` : ""}
  ${E && state.scenario !== "constant" ? `<section class="card step"><h3><i>·</i>Dynamic shading: opaque canopy ${info("canopy")}</h3>
    <div class="field"><label>Size</label>${tog("canopyAuto", [["auto", "Solve"], ["set", "Set"]], ui.canopyAuto ? "auto" : "set")}</div>
    ${!ui.canopyAuto ? `<div class="field"><label>East–west × north–south</label><span class="pair">${num("plx", state.canopy?.lx ?? 1.3, 0.05)}<span>×</span>${num("ply", state.canopy?.ly ?? 1.3, 0.05, "m")}</span></div>
    <div class="field"><label>Offset east / north</label><span class="pair">${num("pcx", state.canopy?.cx ?? 0, 0.05)}<span>/</span>${num("pcy", state.canopy?.cy ?? 0, 0.05, "m")}</span></div>
    <div class="field"><label>Rotation (clockwise)</label>${num("prot", state.canopy?.rot ?? 0, 5, "°", -90, 90)}</div>` : ""}
  </section>` : ""}
  <section class="card step"><h3><i>3</i>Coral type</h3>
    <div class="field"><label>Species ${info("coral")}</label>${sel("coral", P.map((p: any) => [p.id, p.label + (p.status === "caution" ? " (use with care)" : "")]), state.coral.preset)}</div>
    ${P.find((p: any) => p.id === state.coral.preset)?.Ek_Emax
      ? `<div class="field"><label>Corals adjusted to ${info("acclimation")}</label>${sel("accl", [["site", "Light at this depth"], ["shade", "The shade"], ["none", "As measured"]], state.coral.acclimate)}</div>`
      : `<div class="field"><label>Corals adjusted to ${info("acclimation")}</label><span class="val">As measured</span></div><p class="sub">The source gives no growth light for this coral, so its measured Ek is used.</p>`}
    ${E ? `<div class="field"><label>Ek (as measured)</label>${num("ek", state.coral.ek ?? P.find((p: any) => p.id === state.coral.preset)!.Ek, 1, "µmol m⁻² s⁻¹", 5, 2000)}</div>
    <div class="field"><label>Respiration ÷ Pmax</label>${num("rpg", state.coral.rOverPg ?? P.find((p: any) => p.id === state.coral.preset)!.R_over_Pg ?? 0, 0.01, "", 0, 0.99)}</div>
    <div class="field"><label>Grid spacing ${info("grid")}</label>${sel("grid", [["0.025", "2.5 cm"], ["0.05", "5 cm"], ["0.1", "10 cm"]], String(state.gridSpacing))}</div>` : ""}
    <p class="sub">${esc(presetNote())}</p>
  </section>`;
  initMap();
}

function presetNote(): string {
  const p: any = CSP_BOOT.presets.presets.find((x: any) => x.id === state.coral.preset);
  return p ? `Ek ${p.Ek} µmol m⁻² s⁻¹. ${p.Ek_basis}.${p.notes ? " " + p.notes : ""}` : "";
}

// ------------------------------------------------------------------ map
let map: any = null, marker: any = null;
function initMap() {
  const el = $("#map");
  if (typeof L === "undefined" || !navigator.onLine) return;
  try {
    map = L.map(el, { zoomControl: true, attributionControl: true }).setView([state.site.lat, state.site.lon], 9);
    const sat = L.tileLayer("https://tiles.maps.eox.at/wmts/1.0.0/s2cloudless-2020_3857/default/g/{z}/{y}/{x}.jpg",
      { maxZoom: 15, attribution: "Sentinel-2 cloudless by EOX (contains modified Copernicus Sentinel data 2020)" });
    sat.addTo(map);
    marker = L.marker([state.site.lat, state.site.lon], { icon: L.divIcon({ className: "pin", iconSize: [16, 16] }), draggable: true }).addTo(map);
    const move = (ll: { lat: number; lng: number }) => { setSite(+ll.lat.toFixed(4), +ll.lng.toFixed(4)); };
    map.on("click", (e: any) => move(e.latlng));
    marker.on("dragend", () => move(marker.getLatLng()));
    el.querySelector(".map-off")?.remove();
    // tiles blocked (for example in a preview window that forbids network requests): say so instead of a blank map
    let loaded = 0, failed = 0;
    const note = () => {
      if (loaded > 0 || failed < 4 || el.querySelector(".map-off")) return;
      const d = document.createElement("div"); d.className = "map-off"; d.style.zIndex = "1000";
      d.textContent = "Map tiles could not load here. Open the file in a web browser with internet, or type coordinates below.";
      el.appendChild(d);
    };
    sat.on("tileload", () => { loaded++; el.querySelector(".map-off")?.remove(); });
    sat.on("tileerror", () => { failed++; note(); });
  } catch { /* offline: typed coordinates still work */ }
}

function setSite(lat: number, lon: number) {
  state.site.lat = lat; state.site.lon = lon; state.site.tz = utcOffsetFromLon(lon);
  const la = $("#lat") as HTMLInputElement, lo = $("#lon") as HTMLInputElement;
  if (document.activeElement !== la) la.value = String(lat);
  if (document.activeElement !== lo) lo.value = String(lon);
  if (marker) marker.setLatLng([lat, lon]);
  if (matchLight()) { guess = undefined; runId++; startWorker(); }
  refreshSiteInfo();
  if (isClear()) setStatus("No light data for this site yet: using a clear-sky estimate. Light data → Change… gets the PVGIS typical year.", true);
  schedule();
}

async function search() {
  const q = ($("#search") as HTMLInputElement).value.trim();
  if (!q) return;
  try {
    const r = await fetch(`https://nominatim.openstreetmap.org/search?format=json&limit=1&q=${encodeURIComponent(q)}`);
    const j = await r.json();
    if (!j.length) { setStatus(`No place found for “${q}”.`, true); return; }
    const lat = +(+j[0].lat).toFixed(4), lon = +(+j[0].lon).toFixed(4);
    state.site.name = j[0].display_name.split(",")[0];
    if (map) map.setView([lat, lon], 11);
    setSite(lat, lon);
  } catch { setStatus("Search needs internet. Type the coordinates instead.", true); }
}

// ------------------------------------------------------------------ inputs
function onInput(e: Event) {
  const el = e.target as HTMLInputElement;
  const v = parseFloat(el.value);
  if (el.id === "dayIdx") { if (last) { ui.day = last.days[Math.round(v)] ?? null; renderResults(); } return; }
  switch (el.id) {
    case "lat": case "lon": if (Number.isFinite(v)) setSite(el.id === "lat" ? v : state.site.lat, el.id === "lon" ? v : state.site.lon); return;
    case "tz": if (Number.isFinite(v)) { state.site.tz = v; refreshSiteInfo(); } break;
    case "start": state.start = parseDate(el.value); break;
    case "end": state.end = parseDate(el.value); break;
    case "target": { ui.targetKey = el.value; const t = TARGETS[el.value]!; state.target = { shape: t.shape, lx: t.lx, ly: t.ly }; renderLeft(); break; }
    case "tlx": if (v > 0) { state.target.lx = v; if (state.target.shape === "circle") state.target.ly = v; } break;
    case "tly": if (v > 0) state.target.ly = v; break;
    case "depth": if (v > 0) state.depth = v; break;
    case "height": if (v > 0) state.height = v; break;
    case "kdPreset": { ui.kdKey = el.value; const k = KD_PRESETS.find((p) => p[0] === el.value); if (k) state.water.kd = k[2]; break; }
    case "kd": if (v > 0) { state.water.kd = v; ui.kdKey = KD_PRESETS.find((p) => p[2] === v)?.[0] ?? "custom"; } break;
    case "w0": if (v >= 0.5 && v <= 0.9) state.water.w0 = v; break;
    case "rating": state.clothRating = Math.round(v); delete state.tauClean; (el.previousElementSibling!.querySelector(".val") as HTMLElement).textContent = `${state.clothRating} %`; break;
    case "dynRed": state.dynamicTargetReduction = Math.round(v); (el.previousElementSibling!.querySelector(".val") as HTMLElement).textContent = `${state.dynamicTargetReduction} %`; break;
    case "tauClean": if (v >= 0 && v <= 1) state.tauClean = v; break;
    case "tauFouled": if (v >= 0 && v <= 1) state.tauFouled = v; break;
    case "fouledShare": if (v >= 0 && v <= 100) { state.fouledShare = v / 100; if (state.tauFouled === undefined) state.tauFouled = +((state.tauClean ?? 1 - state.clothRating / 100) * 0.7).toFixed(3); } break;
    case "clx": case "cly": state.clothSize = { lx: parseFloat(($("#clx") as HTMLInputElement).value), ly: parseFloat(($("#cly") as HTMLInputElement).value) }; break;
    case "plx": case "ply": case "pcx": case "pcy": case "prot":
      state.canopy = { lx: parseFloat(($("#plx") as HTMLInputElement).value), ly: parseFloat(($("#ply") as HTMLInputElement).value),
        cx: parseFloat(($("#pcx") as HTMLInputElement).value), cy: parseFloat(($("#pcy") as HTMLInputElement).value), rot: parseFloat(($("#prot") as HTMLInputElement).value) }; break;
    case "noonShift": if (Number.isFinite(v)) state.noonShift = v; break;
    case "wind": if (v >= 0) state.wind = v; break;
    case "coral": state.coral = { preset: el.value, acclimate: state.coral.acclimate }; renderLeft(); break;
    case "accl": state.coral.acclimate = el.value as Inputs["coral"]["acclimate"]; break;
    case "ek": if (v > 0) state.coral.ek = v; break;
    case "rpg": if (v >= 0 && v < 1) state.coral.rOverPg = v; break;
    case "grid": state.gridSpacing = v; break;
    default: return;
  }
  schedule();
}

function onToggle(name: string, v: string) {
  switch (name) {
    case "scenario": state.scenario = v as Inputs["scenario"]; break;
    case "sync": state.sync = v === "yes"; break;
    case "noonMode": ui.noonMode = v as UI["noonMode"]; if (v === "computed") state.noonShift = 0; break;
    case "windMode": ui.windMode = v as UI["windMode"]; state.wind = v === "set" ? (state.wind ?? 5) : null; break;
    case "clothAuto": ui.clothAuto = v === "auto"; state.clothSize = ui.clothAuto ? null : { lx: last?.scenarios.find((s) => s.kind === "constant")?.panel.lx ?? 3, ly: last?.scenarios.find((s) => s.kind === "constant")?.panel.ly ?? 2 }; break;
    case "canopyAuto": {
      ui.canopyAuto = v === "auto";
      const p = last?.scenarios.find((s) => s.kind === "dynamic")?.panel;
      state.canopy = ui.canopyAuto ? null : { lx: p?.lx ?? 1.3, ly: p?.ly ?? 1.3, cx: 0, cy: 0, rot: 0 }; break;
    }
    case "mode": ui.mode = v as UI["mode"]; document.body.classList.toggle("expert", ui.mode === "expert"); break;
  }
  renderLeft(); schedule(); if (last) renderResults();
}

// ------------------------------------------------------------------ results
const sc = (k: "constant" | "dynamic") => last?.scenarios.find((s) => s.kind === k);
const color = (s: ScenarioOut) => (s.kind === "constant" ? COLORS.cloth : COLORS.canopy);
const nameOf = (s: ScenarioOut) => (s.kind === "constant" ? "Constant shading" : "Dynamic shading");

/** Keep numbers with their units and "a × b" together on one line. */
const nb = (s: string) => s.replace(/ × /g, "\u00a0×\u00a0").replace(/(\d) (?=(m|%|h|mol|µmol|°|d⁻¹)(?![A-Za-z]))/g, "$1\u00a0");
const sameDay = (a: Day, b: Day) => a[0] === b[0] && a[1] === b[1] && a[2] === b[2];
function dayIndex(r: Results): number {
  if (!ui.day) return 0;
  const k = r.days.findIndex((d) => sameDay(d, ui.day!));
  if (k >= 0) return k;
  const t = Date.UTC(ui.day[0], ui.day[1] - 1, ui.day[2]);
  let best = 0, bd = Infinity;
  r.days.forEach((d, i) => { const dd = Math.abs(Date.UTC(d[0], d[1] - 1, d[2]) - t); if (dd < bd) { bd = dd; best = i; } });
  return best;
}

function renderResults() {
  if (!last) return;
  const r = last, E = ui.mode === "expert";
  const C = sc("constant"), D = sc("dynamic"), open = r.open.dliMean;
  const red = (s: ScenarioOut) => 100 * (1 - s.T);
  const main = D ?? C!;
  const ratingNote = C && state.tauClean === undefined
    ? ` The cloth is rated ${state.clothRating} % shade, but light also reaches the corals from the sides, so more gets through than the rating suggests.` : "";
  const lead = C && D
    ? (Math.abs(C.T - D.T) < 0.01
      ? `Both kinds of shading give the corals ${pct(100 * C.T)} of open-water light over the deployment (${pct(red(C))} less).${ratingNote}${state.sync ? " Dynamic shading is sized to match constant shading." : ""}`
      : `Over the deployment, constant shading gives the corals ${pct(100 * C.T)} of open-water light and dynamic shading ${pct(100 * D.T)}.${ratingNote}`)
    : `${nameOf(main)} gives the corals ${pct(100 * main.T)} of open-water light over the deployment (${pct(red(main))} less).${C ? ratingNote : ""}`;
  const kpis: string[] = [];
  if (D) kpis.push(`<div class="card kpi"><div class="t"><span class="dot" style="background:${COLORS.canopy}"></span>Dynamic shading</div><div class="n">${fmt(D.panel.lx, 2)} × ${fmt(D.panel.ly, 2)} m</div><div class="s">Opaque canopy, east–west × north–south, ${fmt(state.height, 2)} m above the corals.${D.solve ? (state.sync && C ? " Sized to give the same light as constant shading." : ` Sized for ${state.dynamicTargetReduction} % less light.`) : " Size set by you."}</div></div>`);
  if (C) kpis.push(`<div class="card kpi"><div class="t"><span class="dot" style="background:${COLORS.cloth}"></span>Constant shading</div><div class="n">${fmt(C.panel.lx, 1)} × ${fmt(C.panel.ly, 1)} m</div><div class="s">${state.tauClean !== undefined ? `Cloth passing ${fmt(100 * state.tauClean, 0)} % when clean` : `${state.clothRating} % shade cloth`}, ${fmt(state.height, 2)} m above the corals.${ui.clothAuto ? " Big enough that the sun reaches the corals only through it." : ""}</div></div>`);
  kpis.push(`<div class="card kpi"><div class="t">Daily light at the corals</div><div class="n">${fmt(main.dliMean, 1)}</div><div class="u">mol m⁻² d⁻¹, ${pct(100 * main.T)} of open water</div><div class="s">Open water at ${fmt(state.depth, 1)} m: ${fmt(open, 1)}.${C && D ? ` Constant shading: ${fmt(C.dliMean, 1)}.` : ""}</div></div>`);
  const b = main.bio;
  kpis.push(`<div class="card kpi"><div class="t">Coral photosynthesis</div><div class="n">${pct(100 * b.grossVsOpen!)}</div><div class="u">of what it would be unshaded</div><div class="s">${nameOf(main)}${C && D ? `; constant shading ${pct(100 * C.bio.grossVsOpen!)}` : ""}. Corals adjusted to ${state.coral.acclimate === "site" ? "this depth" : state.coral.acclimate === "shade" ? "the shade" : "their source site"}.</div></div>`);
  // ---- a day under the structures (any day of the deployment)
  const di = dayIndex(r), dd = r.days[di]!, nD = r.days.length;
  const odli = r.open.dayDli, lo = Math.min(...odli), hi = Math.max(...odli);
  const series = [{ name: "Open water", x: r.minutes, y: r.open.dayCurves[di]!, color: COLORS.open, dash: "5 4" },
    ...r.scenarios.map((s) => ({ name: nameOf(s), x: r.minutes, y: s.dayCurves.mean[di]!, color: color(s), fill: true }))];
  const legend = `<div class="legend"><span><span class="dot" style="background:${COLORS.open}"></span>Open water at ${fmt(state.depth, 1)} m</span>${r.scenarios.map((s) => `<span><span class="dot" style="background:${color(s)}"></span>${nameOf(s)}</span>`).join("")}</div>`;
  const picker = `<div class="daypick"><button class="btn ghost sm" data-day="-1" aria-label="Previous day"${di === 0 ? " disabled" : ""}>‹</button><input id="dayIdx" type="range" min="0" max="${nD - 1}" step="1" value="${di}" aria-label="Day of the deployment"><button class="btn ghost sm" data-day="1" aria-label="Next day"${di === nD - 1 ? " disabled" : ""}>›</button><span class="dd">${MON[dd[1] - 1]} ${dd[2]}</span></div>`;
  const dayNote = isClear() ? `Clear-sky estimate (no clouds), so every day looks alike; open water got ${fmt(odli[di]!, 1)} mol m⁻² that day. Area mean.`
    : `${ui.lightKind === "tmy" ? "Typical-year day (one plausible day for this date, not that year's weather)" : "Recorded"} weather; open water got ${fmt(odli[di]!, 1)} mol m⁻² that day (deployment range ${fmt(lo, 1)}–${fmt(hi, 1)}, lower on cloudy days). Area mean. Assumes Kd ${state.water.kd} m⁻¹ on every day and a fixed depth (no tide).`;
  // ---- maps
  const allDli = r.scenarios.flatMap((s) => s.pointDli);
  const vmin = Math.floor(Math.min(...allDli) * 2) / 2, vmax = Math.ceil(Math.max(...allDli) * 2) / 2;
  const extent = Math.max(state.target.lx, state.target.ly, ...r.scenarios.map((s) => Math.max(s.panel.lx, s.panel.ly) + 2 * Math.hypot(s.panel.cx, s.panel.cy))) * 1.08;
  const maps = r.scenarios.map((s) => mapChart(r.points, s.pointDli, r.spacing, vmin, vmax, { lx: s.panel.lx, ly: s.panel.ly, cx: s.panel.cx, cy: s.panel.cy, rot: s.panel.rotDeg },
    state.target, nameOf(s), extent, s.kind === "dynamic" ? s.clearance?.never : undefined)).join("");
  const never = D?.clearance?.share ? ` <span class="sw" style="background:${COLORS.coral}"></span>Orange dots: parts that never have the sun in line.` : "";
  // ---- across the deployment: daily light
  const dayLight = (s: ScenarioOut) => r.open.dayDli.map((o, i) => o * (1 - s.dayReduction[i]!.mean / 100));
  const season = dailyLightChart(r.days, [{ y: r.open.dayDli, color: COLORS.open, name: "Open water", dash: "5 4" },
    ...r.scenarios.map((s) => ({ y: dayLight(s), color: color(s), name: nameOf(s) }))]);
  const means = `Means: open water ${fmt(open, 1)}${r.scenarios.map((s) => `, ${nameOf(s).toLowerCase()} ${fmt(s.dliMean, 1)}`).join("")} mol m⁻² d⁻¹.`;
  // ---- coral response
  const preset = CSP_BOOT.presets.presets.find((p: any) => p.id === state.coral.preset);
  const ec = main.bio.ec ?? 0, hasR = main.bio.prDaily !== undefined;
  const hists = [{ name: "Open water", color: COLORS.open, dash: "4 3", values: r.open.lightHist },
    ...r.scenarios.map((s) => ({ name: nameOf(s), color: color(s), values: s.lightHist ?? [] }))];
  const Z = [["BelowEc", "Below compensation", "under Ec: respiration exceeds photosynthesis"], ["Limited", "Light-limited", hasR ? "Ec to Ek: below 76 % of Pmax" : "below Ek: below 76 % of Pmax"],
    ["NearSat", "Near saturation", "Ek to 2 Ek: 76–96 % of Pmax"], ["Saturated", "Saturated", "above 2 Ek: extra light adds little"]].filter((z) => hasR || z[0] !== "BelowEc");
  const cols = [{ name: "Open water", get: (k: string) => main.bio[`open${k}`] }, ...r.scenarios.map((s) => ({ name: nameOf(s), get: (k: string) => s.bio[k.charAt(0).toLowerCase() + k.slice(1)] }))];
  const zoneRows = Z.map(([k, lab, sub], zi) => `<tr><td><span class="sw" style="background:${ZONE_TINTS[hasR ? zi : zi + 1]}"></span>${lab}<br><span class="sub">${sub}</span></td>${cols.map((c) => {
    const h = c.get(`Hours${k}`) ?? 0, lt = c.get(`Light${k}`) ?? 0;
    const tot = Z.reduce((a, [kk]) => a + (c.get(`Light${kk}`) ?? 0), 0);
    return `<td>${fmt(h, 1)} h<br><span class="sub">${tot > 0 ? pct((100 * lt) / tot) : "–"} of light</span></td>`; }).join("")}</tr>`).join("");
  const rows = (k: string, lab: string, f: (v: number) => string) => `<tr><td>${lab}</td><td>–</td>${r.scenarios.map((s) => `<td>${s.bio[k] !== undefined ? f(s.bio[k]!) : "–"}</td>`).join("")}</tr>`;
  const coral = `<div class="card"><h2>Coral response</h2><p class="sub">Photosynthesis curve of ${esc(preset?.label ?? "")} (Ek ${fmt(main.ek, 0)} µmol m⁻² s⁻¹). Lines: hours per day the corals spend at each light level, over the deployment.</p>${peChart(main.ek, ec, hists, r.histMax)}
    <div class="legend"><span><span class="dot" style="background:${COLORS.open}"></span>Open water</span>${r.scenarios.map((s) => `<span><span class="dot" style="background:${color(s)}"></span>${nameOf(s)}</span>`).join("")}</div>
    <table class="t zones"><tr><th>Time per day</th>${cols.map((c) => `<th>${c.name}</th>`).join("")}</tr>${zoneRows}
    ${rows("grossVsOpen", "Photosynthesis, % of unshaded", (v) => pct(100 * v))}${hasR ? rows("prDaily", "Daily P:R", (v) => fmt(v, 2)) : ""}</table>
    ${hasR ? "" : `<p class="sub">Time below compensation and P:R need respiration data, which this coral's sources lack.</p>`}</div>`;
  // ---- checks
  const checks: string[] = [];
  for (const w of r.lightNotes ?? []) {
    const k = w.indexOf(". ") + 1, head = k > 0 ? w.slice(0, k) : w, rest = k > 0 ? w.slice(k + 1) : "";
    checks.push(`<div class="check"><span class="badge warn">CHECK</span><div><b>${esc(head)}</b>${rest ? `<br><span class="sub">${esc(rest)}</span>` : ""}</div></div>`);
  }
  const beamNote = `At ${state.depth} m the sun beam carries ${fmt(100 * (r.beamShare ?? 0), 1)} % of the light; the rest is scattered light from all directions.`
    + (D?.contrast ? ` Under dynamic shading the corals get ${pct(100 * D.contrast.noon)} of open-water light at noon and ${pct(100 * D.contrast.side)} in the morning and afternoon.` : "");
  if (D?.clearance) {
    const sunMin = Math.min(...D.pointSunHours), sunMax = Math.max(...D.pointSunHours);
    checks.push(D.clearance.share > 0
      ? `<div class="check"><span class="badge warn">CHECK</span><div><b>${pct(100 * D.clearance.share)} of the coral area never has the sun in line under dynamic shading</b><br><span class="sub">Orange dots on the map. A canopy about ${fmt(D.clearance.hRule, 1)} m above the corals would let the morning sun reach all of it on every day (most demanding day ${dstr(D.clearance.hRuleDay)}; at least ${fmt(D.clearance.hMin, 1)} m is needed for any full clearance). ${beamNote}</span></div></div>`
      : `<div class="check"><span class="badge ok">OK</span><div><b>Every part of the coral area has the sun in line each day</b><br><span class="sub">Under dynamic shading, the sun is in line with each part for ${fmt(sunMin, 1)}–${fmt(sunMax, 1)} hours a day, in the morning and afternoon: least where the canopy covers longest (usually the middle), most at the edges. These hours are geometry only: clouds and scattering are not counted. ${beamNote}</span></div></div>`);
  }
  if (D && D.panel.lx + 0.02 < state.target.lx)
    checks.push(`<div class="check"><span class="badge warn">CHECK</span><div><b>The ends of the coral area get little shade from dynamic shading</b><br><span class="sub">The canopy (${fmt(D.panel.lx, 2)} m east–west) is narrower than the coral area (${fmt(state.target.lx, 1)} m east–west), so the east and west ends stay in the sun. Lay the coral area long north–south: the sun crosses from east to west, so the shade then spreads evenly.</span></div></div>`);
  const rob = (D ?? C)?.robustness;
  if (rob) {
    const pick = (p: string) => rob.filter((x) => x.case.startsWith(p)).map((x) => 100 * x.T);
    const w = pick("w0"), k = pick("Kd"), s = pick("shifted");
    checks.push(`<div class="check"><span class="badge note">RANGE</span><div><b>Light at the corals: ${pct(100 * (D ?? C)!.T)} of open water, likely between ${fmt(Math.min(...w), 0)} and ${fmt(Math.max(...w), 0)} %</b><br><span class="sub">The range comes from how much the water scatters light sideways under the structure (from clearer to more turbid reef water), which is rarely measured. Water clarity ±50 % changes it only to ${fmt(Math.min(...k), 0)}–${fmt(Math.max(...k), 0)} %, and moving the structure 0.2 m to at most ${fmt(Math.max(...s), 0)} %. One light reading under and beside the structure narrows the range (see the field protocol in the help).</span></div></div>`);
  } else checks.push(`<div class="check"><span class="badge note">…</span><div><b>Uncertainty range</b><br><span class="sub">Computing…</span></div></div>`);
  for (const w of r.warnings) checks.push(`<div class="check"><span class="badge warn">NOTE</span><div>${esc(w)}</div></div>`);
  checks.push(`<div class="check"><span class="badge note">FIELD</span><div><b>Measure to confirm</b><br><span class="sub">Light under and beside the structure at 09:00, noon and 15:00 shows how this water behaves. See the field protocol in the help.</span></div></div>`);
  let expert = "";
  if (E && D) {
    const pts = lineChart([{ name: "Open water", x: r.minutes, y: r.open.dayCurves[di]!, color: COLORS.open, dash: "5 4" },
      { name: "Center", x: r.minutes, y: D.dayCurves.center[di]!, color: COLORS.ink }, { name: "East edge", x: r.minutes, y: D.dayCurves.east[di]!, color: COLORS.canopy },
      { name: "West edge", x: r.minutes, y: D.dayCurves.west[di]!, color: COLORS.coral, dash: "3 3" }], { ylab: "PAR under dynamic shading (µmol m⁻² s⁻¹)", noon: r.noons[di] });
    expert += `<div class="grid2"><div class="card"><h2>Points under dynamic shading, ${MON[dd[1] - 1]} ${dd[2]}</h2><p class="sub">Center and points near the east and west edges. Change the day above.</p>${pts}
    <div class="legend"><span><span class="dot" style="background:${COLORS.open}"></span>Open water</span><span><span class="dot" style="background:${COLORS.ink}"></span>Center</span><span><span class="dot" style="background:${COLORS.canopy}"></span>East edge</span><span><span class="dot" style="background:${COLORS.coral}"></span>West edge</span></div></div>`;
    const robRows = (D.robustness ?? []).map((x, i) => `<tr><td>${esc(x.case)}</td><td>${fmt(100 * x.T, 1)} %</td>${C?.robustness ? `<td>${fmt(100 * C.robustness[i]!.T, 1)} %</td>` : ""}</tr>`).join("");
    expert += `<div class="card"><h2>Robustness</h2><p class="sub">Light over the deployment as % of open water.</p><table class="t"><tr><th>Case</th><th>Dynamic</th>${C ? "<th>Constant</th>" : ""}</tr>${robRows || `<tr><td colspan="3">Computing…</td></tr>`}</table></div></div>`;
  }
  if (E) expert += `<div class="card"><h2>Accuracy ${info("accuracy")}</h2><p class="sub">Light engine checked against a 3-D Monte Carlo model; the app and the Python package share test values. Version ${VERSION}.</p>
    <div class="exports"><button class="btn sea" data-export="report">Report (print or PDF)</button><button class="btn ghost" data-export="points">Daily light per point (CSV)</button><button class="btn ghost" data-export="days">Daily summary (CSV)</button><button class="btn ghost" data-export="inputs">Inputs (JSON)</button></div></div>`;
  $("#right").innerHTML = nb(`
    <div class="head"><h1>Shading plan for corals at ${fmt(state.depth, 1)} m</h1><p>${esc(state.site.name)} · ${MON[state.start[1] - 1]} ${state.start[2]} – ${MON[state.end[1] - 1]} ${state.end[2]} ${state.end[0]}</p></div>
    <p class="lead">${lead}</p>
    <div class="kpis">${kpis.join("")}</div>
    <div class="grid2"><div class="card"><h2>A day under the structures</h2>${picker}<p class="sub">${dayNote}</p>${lineChart(series, { ylab: "PAR at the corals, area mean (µmol m⁻² s⁻¹)", noon: r.noons[di] })}${legend}</div>
    <div class="card"><h2>Daily light across the coral area</h2><p class="sub">Deployment mean. Colors: daily light on each part of the coral area. Dashed line: the structure. White line: edge of the coral area.${never}</p><div class="maps">${maps}</div>${colorbar(vmin, vmax, "Daily light (mol m⁻² d⁻¹)")}</div></div>
    <div class="grid2"><div class="card"><h2>Across the deployment</h2><p class="sub">Daily light at the corals, area mean. Dips are cloudy days; both kinds of shading follow the weather. ${means}</p>${season}${legend}</div>${coral}</div>
    <div class="card"><h2>Checks</h2>${checks.join("")}</div>${expert}`);
}

// ------------------------------------------------------------------ light-data helper
function openDataHelper() {
  const lat = state.site.lat, lon = state.site.lon, y = new Date().getFullYear() - 2;
  const m = document.createElement("div");
  m.className = "modal-bg";
  m.innerHTML = `<div class="modal" role="dialog" aria-label="Add light data"><div class="mh"><h2>Add light data for your site</h2><span class="sub">${lat.toFixed(4)}, ${lon.toFixed(4)}</span><button class="x" aria-label="Close">×</button></div>
    <ol class="stepper"><li class="on">Choose the data</li><li class="on">Download from PVGIS</li><li class="on">Add the file</li></ol>
    <label class="opt on"><input type="radio" name="kind" value="tmy" checked><div><b>Typical year (recommended)</b><br><span class="sub">One representative year built by the EU's PVGIS service from many years of data. Best for designing a structure.</span></div></label>
    <label class="opt"><input type="radio" name="kind" value="hourly"><div><b>Hourly data for chosen years</b><br><span class="sub">The weather that actually happened, e.g. to compare with a past deployment. Years: <input id="y0" type="number" value="${y - 9}" class="yr"> – <input id="y1" type="number" value="${y}" class="yr"></span></div></label>
    <div class="row"><a id="dl" class="btn sea" target="_blank" rel="noopener" href="${tmyUrl(lat, lon)}">Open PVGIS download ↗</a><span class="sub">Saves a CSV file to your computer. PVGIS picks the best database for the location.</span></div>
    <div id="drop" class="drop"><b>Drop the CSV here</b> or <label class="link">choose a file<input id="file" type="file" accept=".csv,.txt" hidden></label><br><textarea id="paste" placeholder="…or paste the file's text here"></textarea></div>
    <div id="preview"></div>
    <div class="actions"><button class="btn ghost" data-close>Cancel</button><button id="use" class="btn sea" disabled>Use this data</button></div></div>`;
  document.body.appendChild(m);
  let imported: ReturnType<typeof importText> | null = null;
  const close = () => m.remove();
  m.querySelector(".x")!.addEventListener("click", close);
  m.querySelector("[data-close]")!.addEventListener("click", close);
  const link = m.querySelector("#dl") as HTMLAnchorElement;
  const upd = () => { const k = (m.querySelector("input[name=kind]:checked") as HTMLInputElement).value;
    m.querySelectorAll(".opt").forEach((o) => o.classList.toggle("on", (o.querySelector("input") as HTMLInputElement).checked));
    link.href = k === "tmy" ? tmyUrl(lat, lon) : hourlyUrl(lat, lon, +(m.querySelector("#y0") as HTMLInputElement).value, +(m.querySelector("#y1") as HTMLInputElement).value); };
  m.addEventListener("change", upd); m.addEventListener("input", (e) => { if ((e.target as HTMLElement).classList.contains("yr")) upd(); });
  const take = (text: string) => {
    try {
      imported = importText(text, lat, lon);
      (m.querySelector("#preview") as HTMLElement).innerHTML = `<div class="card ok"><span class="badge ok">READ</span> <b>${esc(imported.summary)}</b>${imported.warning ? `<p class="sub warn">${esc(imported.warning)}</p>` : ""}</div>`;
      (m.querySelector("#use") as HTMLButtonElement).disabled = false;
    } catch (e) { (m.querySelector("#preview") as HTMLElement).innerHTML = `<div class="card bad"><span class="badge warn">PROBLEM</span> ${esc(e instanceof Error ? e.message : String(e))}</div>`; }
  };
  const drop = m.querySelector("#drop") as HTMLElement;
  drop.addEventListener("dragover", (e) => { e.preventDefault(); drop.classList.add("over"); });
  drop.addEventListener("dragleave", () => drop.classList.remove("over"));
  drop.addEventListener("drop", async (e) => { e.preventDefault(); drop.classList.remove("over"); const f = e.dataTransfer?.files[0]; if (f) take(await readFile(f)); });
  m.querySelector("#file")!.addEventListener("change", async (e) => { const f = (e.target as HTMLInputElement).files?.[0]; if (f) take(await readFile(f)); });
  m.querySelector("#paste")!.addEventListener("input", (e) => { const t = (e.target as HTMLTextAreaElement).value; if (t.length > 200) take(t); });
  m.querySelector("#use")!.addEventListener("click", () => {
    if (!imported) return;
    dataLight = imported.light; dataLabel = imported.summary;
    if (imported.years) {
      const [y0, y1] = imported.years;
      if (state.start[0] < y0 || state.end[0] > y1) {
        const shift = y1 - state.end[0];
        state.start = [state.start[0] + shift, state.start[1], state.start[2]]; state.end = [y1, state.end[1], state.end[2]];
        dataLabel += ` · deployment moved to ${state.end[0]} to match the data`;
      }
    }
    if (dataLight.lat !== null && dataLight.lon !== null && distanceKm(state.site.lat, state.site.lon, dataLight.lat, dataLight.lon) > MATCH_KM) {
      // the file is for another place: move the site there, so light and sun always belong together
      state.site.lat = +dataLight.lat.toFixed(4); state.site.lon = +dataLight.lon.toFixed(4); state.site.tz = utcOffsetFromLon(state.site.lon);
      dataLabel += " · site moved to the file's location";
    }
    if (state.site.name === ex.name) state.site.name = `${state.site.lat.toFixed(3)}, ${state.site.lon.toFixed(3)}`;
    matchLight(); guess = undefined;
    close(); renderLeft(); runId++; startWorker(); schedule();
  });
}

// ------------------------------------------------------------------ exports
function download(name: string, text: string, type = "text/csv") {
  const a = document.createElement("a");
  a.href = URL.createObjectURL(new Blob([text], { type })); a.download = name; a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 2000);
}

function doExport(kind: string) {
  if (!last) return;
  const r = last, head = `# Coral Shading Protocol ${VERSION}; ${state.site.name} ${state.site.lat}, ${state.site.lon}; ${dstr(state.start)} to ${dstr(state.end)}; ${r.level === "preview" ? "preview" : "full"} resolution; ${assumptions()}\n`;
  if (kind === "inputs") download("csp_inputs.json", JSON.stringify({ app: "Coral Shading Protocol", version: VERSION, inputs: state, light: ui.lightLabel }, null, 1), "application/json");
  if (kind === "points") {
    const cols = r.scenarios.flatMap((s) => [`${s.kind}_daily_light_mol_m2_d`, `${s.kind}_sun_in_line_h`]);
    const lines = [`x_east_m,y_north_m,${cols.join(",")}`];
    for (let p = 0; p < r.points.length / 2; p++) lines.push([r.points[2 * p]!.toFixed(3), r.points[2 * p + 1]!.toFixed(3), ...r.scenarios.flatMap((s) => [s.pointDli[p]!.toFixed(4), s.pointSunHours[p]!.toFixed(2)])].join(","));
    download("csp_points.csv", head + lines.join("\n"));
  }
  if (kind === "days") {
    const cols = r.scenarios.flatMap((s) => [`${s.kind}_reduction_mean_pct`, `${s.kind}_reduction_min_pct`, `${s.kind}_reduction_max_pct`]);
    const lines = [`date,weather,open_water_daily_light_mol_m2_d,${cols.join(",")}`];
    const wx = weatherLabel();
    r.days.forEach((d, i) => lines.push([dstr(d), wx, r.open.dayDli[i]!.toFixed(3), ...r.scenarios.flatMap((s) => [s.dayReduction[i]!.mean, s.dayReduction[i]!.min, s.dayReduction[i]!.max].map((v) => v.toFixed(2)))].join(",")));
    download("csp_days.csv", head + lines.join("\n"));
  }
  if (kind === "report") {
    const w = window.open("", "_blank");
    if (!w) return;
    w.document.write(`<!doctype html><html><head><meta charset="utf-8"><title>CSP report</title><style>${$("#css").textContent}body{background:#fff}.top,.exports,.info{display:none}</style></head><body>
      <div style="padding:20px 28px"><h1 style="margin:0 0 4px">Coral Shading Protocol ${VERSION} · design report</h1><p class="sub">${esc(state.site.name)} (${state.site.lat}, ${state.site.lon}) · ${dstr(state.start)} to ${dstr(state.end)} · ${esc(ui.lightLabel)} · water Kd ${state.water.kd} m⁻¹, ω₀ ${state.water.w0} · corals at ${state.depth} m, structures ${state.height} m above</p>
      ${$("#right").innerHTML}<p class="sub">Computed ${new Date().toISOString().slice(0, 10)} at ${r.level === "preview" ? "preview" : "full"} resolution. Methods and sources: see the app's help and the methods page.</p></div></body></html>`);
    w.document.close(); setTimeout(() => w.print(), 400);
  }
}

// ------------------------------------------------------------------ boot
function boot() {
  document.body.innerHTML = `
  <header class="top"><div class="brand">Coral Shading Protocol<small>v${VERSION}</small></div>
    <div class="seg" data-tog="mode"><button type="button" data-v="simple" class="on">Simple</button><button type="button" data-v="expert">Expert</button></div>
    <span class="chip" id="chip">Example: <b>Sipaway 2025</b></span><div class="spacer"></div><span id="status" class="status">Starting…</span>
    <button class="btn light" data-export="report">Export report</button></header>
  <main class="wrap"><aside id="left"></aside><section id="right"><div class="card"><p>Computing…</p></div></section></main>
  <footer class="foot">Light engine and data: see Expert → Accuracy. Place search © OpenStreetMap contributors; imagery Sentinel-2 cloudless by EOX. Sunlight data: PVGIS © European Union.</footer>`;
  document.addEventListener("change", onInput);
  document.addEventListener("input", (e) => { const id = (e.target as HTMLElement).id; if (["rating", "dynRed", "dayIdx"].includes(id)) onInput(e); });
  document.addEventListener("click", (e) => {
    const t = e.target as HTMLElement;
    const b = t.closest("[data-tog] button") as HTMLElement | null;
    if (b) { const g = b.parentElement!.dataset.tog!; b.parentElement!.querySelectorAll("button").forEach((x) => x.classList.toggle("on", x === b)); onToggle(g, b.dataset.v!); return; }
    const dbtn = t.closest("[data-day]") as HTMLElement | null;
    if (dbtn && last) { const k = Math.min(last.days.length - 1, Math.max(0, dayIndex(last) + Number(dbtn.dataset.day))); ui.day = last.days[k]!; renderResults(); return; }
    const x = t.closest("[data-export]") as HTMLElement | null;
    if (x) { doExport(x.dataset.export!); return; }
    if (t.id === "btn-data") openDataHelper();
    if (t.id === "btn-search") search();
  });
  document.addEventListener("keydown", (e) => { if ((e.target as HTMLElement).id === "search" && e.key === "Enter") search(); });
  renderLeft(); startWorker(); schedule();
  // for testing and for power users in the browser console
  (window as unknown as Record<string, unknown>).__csp = { state, ui, toggle: onToggle, exportAs: doExport, results: () => last, render: renderResults, rerun: schedule, setSite, light: () => light };
}

boot();
