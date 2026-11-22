// Coral Shading Protocol v5: the browser interface (inputs, light data, worker, exports). Results are drawn by results.ts.
import { VERSION } from "../core/index.ts";
import type { Tables } from "../core/engine.ts";
import type { PresetFile } from "../core/pe.ts";
import { type HourlyLight, lightFromJson, clearSkyLight, distanceKm, utcOffsetFromLon, MATCH_KM } from "../core/surface.ts";
import { solarNoon } from "../core/solar.ts";
import type { Inputs, Results } from "./compute.ts";
import { type Day, w0FromReading, w0Bounds } from "../core/scenarios.ts";
import { kdSeriesFromCsv, tideFromCsv, cleanDatesFromText } from "../core/conditions.ts";
import { HELP } from "./help.ts";
import { HOVER } from "./charts.ts";
import { tmyUrl, hourlyUrl, importText, readFile } from "./pvgis.ts";
import { fetchTypicalYear, cacheGet, cachePut, ERA5_LABEL } from "./lightdata.ts";
import { resultsHtml, dayIndex, fmt, dstr, MON } from "./results.ts";
import { stages, type RunMsg } from "./runner.ts";

declare const L: any;   // Leaflet (bundled UMD build)

interface Example { id: string; name: string; description: string; lat: number; lon: number; utc_offset_h: number; deployment: { start: string; end: string }; light: any }
interface Boot { tables: Tables; presets: PresetFile & { presets: any[] }; examples: Example[]; references: { references: Record<string, any> }; workerSource: string }
declare const CSP_BOOT: Boot;

const $ = <T extends HTMLElement = HTMLElement>(sel: string, root: ParentNode = document) => root.querySelector(sel) as T;
const esc = (s: string) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);
const parseDate = (s: string): [number, number, number] => { const [y, m, d] = s.split("-").map(Number); return [y!, m!, d!]; };
const hhmm = (min: number) => `${String(Math.floor(min / 60)).padStart(2, "0")}:${String(Math.round(min % 60)).padStart(2, "0")}`;
const EMBED = (() => { try { return window.self !== window.top; } catch { return true; } })();

const TARGETS: Record<string, { label: string; shape: "rect" | "circle"; lx: number; ly: number }> = {
  reef_star: { label: "MARRS Reef Star (1.1 m across)", shape: "circle", lx: 1.1, ly: 1.1 },
  table: { label: "Nursery table 1 × 2 m (long north–south)", shape: "rect", lx: 1.0, ly: 2.0 },
  rope: { label: "Rope nursery 1 × 4 m (long north–south)", shape: "rect", lx: 1.0, ly: 4.0 },
  rect: { label: "Rectangle (set the size)", shape: "rect", lx: 1.0, ly: 1.0 },
  circle: { label: "Circle (set the size)", shape: "circle", lx: 1.0, ly: 1.0 },
};
// Kd(PAR) classes with sources in the help popup; Secchi depths are a rough guide (Kd x Secchi depth = 1.4 to 1.7)
const KD_PRESETS: [string, string, number, string][] = [
  ["clear", "Clear reef water", 0.06, "Kd 0.06 m⁻¹: a Secchi disc stays visible to roughly 24–28 m"],
  ["moderate", "Moderate reef water", 0.10, "Kd 0.10 m⁻¹: a Secchi disc stays visible to roughly 15–17 m"],
  ["turbid", "Turbid inshore water", 0.45, "Kd 0.45 m⁻¹: a Secchi disc stays visible to roughly 3–4 m"]];
const RATINGS = [30, 50, 70, 80, 90];   // shade ratings commonly sold
const W0_DEFAULT = 0.7, W0_RANGE: [number, number] = [0.5, 0.9];   // published range for coastal and reef waters (see help)

interface UI { mode: "simple" | "expert"; targetKey: string; kdKey: string; lightLabel: string; lightKind: string; noonMode: "computed" | "user"; windMode: "data" | "set";
  clothAuto: boolean; canopyAuto: boolean; day: Day | null; dayMode: "mean" | "date"; foulMode: "none" | "time"; w0Note: string; w0Source: "default" | "reading" | "user"; kdNote: string; tideNote: string;
  exampleId: string; auto: boolean; fetching: boolean; fetchNote: string; lightSource: "example" | "pvgis" | "era5" | "clear";
  reading: { pct: number; err: number; lx: number; ly: number; h: number; date: string; time: string; diffuse: number } }

const EXAMPLES = CSP_BOOT.examples;
const ex = EXAMPLES[0]!;
const exLabel = (e: Example) => `${e.light.database}, bundled with the app`;
const state: Inputs = {
  site: { name: ex.name, lat: ex.lat, lon: ex.lon, tz: ex.utc_offset_h },
  start: parseDate(ex.deployment.start), end: parseDate(ex.deployment.end),
  target: { shape: "circle", lx: 1.1, ly: 1.1 }, depth: 10, height: 0.75, water: { kd: 0.10, w0: W0_DEFAULT, w0Lo: W0_RANGE[0], w0Hi: W0_RANGE[1] },
  scenario: "both", sync: true, clothRating: 80, dynamicTargetReduction: 75, clothSize: null, canopy: null,
  noonShift: 0, wind: null, coral: { preset: "typical", acclimate: "time" }, gridSpacing: 0.05,
  fouling: null, kdSeriesText: null, tideText: null,
};
const ui: UI = { mode: "simple", targetKey: "reef_star", kdKey: "moderate", lightLabel: exLabel(ex), lightKind: "tmy",
  noonMode: "computed", windMode: "data", clothAuto: true, canopyAuto: true, day: null, dayMode: "mean", foulMode: "none", w0Note: "", w0Source: "default", kdNote: "", tideNote: "",
  exampleId: ex.id, auto: true, fetching: false, fetchNote: "", lightSource: "example",
  reading: { pct: 15, err: 2, lx: 1.2, ly: 1.2, h: 0.75, date: ex.deployment.start, time: "12:00", diffuse: 30 } };

// ------------------------------------------------------------------ light data
// dataLight: the data loaded for a place (a bundled example, a PVGIS file, or ERA5 fetched for the site).
// light: what the worker uses: dataLight when it is for a point within MATCH_KM of the site, otherwise a clear-sky stand-in.
let light: HourlyLight = lightFromJson(ex.light);
let dataLight = light, dataLabel = ui.lightLabel, dataSource: UI["lightSource"] = "example";
const exampleLights = new Map<string, HourlyLight>([[ex.id, light]]);
const exampleLight = (e: Example) => { let h = exampleLights.get(e.id); if (!h) { h = lightFromJson(e.light); exampleLights.set(e.id, h); } return h; };
const isClear = () => light.database.startsWith("clear sky");
const near = (h: HourlyLight, lat: number, lon: number) => h.lat === null || h.lon === null || distanceKm(lat, lon, h.lat, h.lon) <= MATCH_KM;
const weatherLabel = () => (isClear() ? "clear-sky estimate" : ui.lightKind === "tmy" ? "typical-year day" : "recorded");
const assumptions = () => `daily values assume ${state.kdSeriesText ? "Kd by date (interpolated between the dates given)" : `Kd ${state.water.kd} m-1 on every day`} and `
  + `${state.tideText ? `a depth that follows the tide (${state.depth} m at mean water level)` : `a fixed depth of ${state.depth} m (no tide)`}; `
  + `water scattering w0 ${state.water.w0} (range ${state.water.w0Lo}-${state.water.w0Hi}); `
  + ({ "typical-year day": "with typical-year light each date is one typical-year day, not that year's weather",
    recorded: "recorded hourly weather", "clear-sky estimate": "clear-sky light (no clouds)" } as Record<string, string>)[weatherLabel()];
const noonText = () => { const n = solarNoon(state.start[0], state.start[1], state.start[2], state.site.lon, state.site.tz); return hhmm(((n % 1440) + 1440) % 1440); };

/** Choose the light for the site: the loaded data, a bundled example, a cached download, or a clear-sky stand-in. Returns true when it changed. */
function matchLight(): boolean {
  const prev = light, { lat, lon } = state.site;
  if (!near(dataLight, lat, lon)) {
    const e = EXAMPLES.find((x) => distanceKm(lat, lon, x.lat, x.lon) <= MATCH_KM);
    const cached = e ? null : cacheGet(lat, lon);
    if (e) { dataLight = exampleLight(e); dataLabel = exLabel(e); dataSource = "example"; }
    else if (cached) { dataLight = cached; dataLabel = ERA5_LABEL(cached); dataSource = "era5"; }
  }
  if (near(dataLight, lat, lon)) { light = dataLight; ui.lightLabel = dataLabel; ui.lightKind = dataLight.kind; ui.lightSource = dataSource; }
  else {
    light = clearSkyLight(lat, lon); ui.lightKind = "tmy"; ui.lightSource = "clear";
    ui.lightLabel = "Clear-sky estimate for this site (no clouds)";
  }
  return light !== prev;
}

let fetchCtl: AbortController | null = null, fetchTimer: number | undefined;
/** Fetch ERA5 weather for the site when nothing loaded fits it (after the site has stopped moving). */
function autoFetch(now = false) {
  window.clearTimeout(fetchTimer);
  if (fetchCtl) { fetchCtl.abort(); fetchCtl = null; }
  ui.fetching = false;
  if (!isClear() || !(ui.auto || now)) return;
  if (!navigator.onLine) { ui.fetchNote = "Offline: weather for this site cannot be fetched. Try an example reef, or load a PVGIS file."; refreshSiteInfo(); return; }
  const { lat, lon } = state.site;
  ui.fetching = true; ui.fetchNote = ""; refreshSiteInfo();
  fetchTimer = window.setTimeout(async () => {
    const ctl = new AbortController(); fetchCtl = ctl;
    try {
      const ty = await fetchTypicalYear(lat, lon, ctl.signal);
      if (ctl.signal.aborted) return;
      cachePut(ty);
      if (!near(ty, state.site.lat, state.site.lon)) return;     // the site moved on meanwhile
      dataLight = ty; dataLabel = ERA5_LABEL(ty); dataSource = "era5";
      ui.fetching = false; ui.fetchNote = "";
      matchLight(); guess = undefined; runId++; startWorker(); refreshSiteInfo(); schedule();
    } catch (e) {
      if (ctl.signal.aborted) return;
      ui.fetching = false;
      ui.fetchNote = `Weather for this site could not be fetched (${e instanceof Error ? e.message : String(e)}). The clear-sky estimate stays in use. Try again, or load a PVGIS file.`;
      refreshSiteInfo();
    }
  }, now ? 0 : 900);
}

const lightLine = () => ui.fetching ? "Fetching 10 years of hourly weather for this site (ERA5)… A clear-sky estimate is shown meanwhile."
  : isClear() ? `${ui.lightLabel}. It shows how the sun moves here but gives more light than real weather.` : ui.lightLabel;

/** Update the site-dependent text in the left panel without re-rendering it (keeps the map and the focus). */
function refreshSiteInfo() {
  const tzEl = document.getElementById("tz") as HTMLInputElement | null;
  if (tzEl && document.activeElement !== tzEl) tzEl.value = String(state.site.tz);
  const lab = document.getElementById("light-label");
  if (lab) { lab.textContent = lightLine(); lab.classList.toggle("warn", isClear() && !ui.fetching); }
  const note = document.getElementById("light-note");
  if (note) { note.textContent = ui.fetchNote; note.hidden = !ui.fetchNote; }
  const fb = document.getElementById("btn-fetch");
  if (fb) fb.hidden = !(isClear() && !ui.fetching);
  const chip = document.getElementById("chip");
  if (chip) chip.innerHTML = `<b>${esc(state.site.name)}</b>`;
  const nbt = document.querySelector('[data-tog="noonMode"] button[data-v="computed"]');
  if (nbt) nbt.textContent = `Computed ${noonText()}`;
  const sel = document.getElementById("example") as HTMLSelectElement | null;
  if (sel) sel.value = ui.exampleId;
}
let last: Results | null = null;
let runId = 0, worker: Worker | null = null, busy = false, guess: number | undefined;

// ------------------------------------------------------------------ worker
// The calculation runs in a background worker. Some windows refuse one (a sandboxed preview, for example); the page
// then runs the same stages itself, pausing between them so the screen can update.
let inline = false, workerSeen = false, pending: RunMsg | null = null;

function onWorkerMessage(m: { type: string; id: number; message?: string; result?: Results }) {
  if (m.id !== runId) return;
  if (m.type === "error") { busy = false; setStatus(`⚠ ${m.message}`, true); return; }
  last = m.result as Results;
  const dyn = last.scenarios.find((s) => s.kind === "dynamic");
  if (dyn && !state.canopy) guess = dyn.panel.lx;
  const done = last.level === "robust" && (ui.mode !== "expert" || !dyn || last.canopyOptions !== undefined);
  if (done) busy = false;
  renderResults();
  const slow = inline && !done ? " The page may pause while it works." : "";
  setStatus((last.level === "preview" ? "Quick preview · refining…"
    : !done ? `Full resolution · ${last.points.length / 2} points × ${last.days.length} days · checking other conditions…`
    : `Full resolution · ${(last.ms / 1000).toFixed(1)} s · ${last.points.length / 2} points × ${last.days.length} days`) + slow);
}

function startWorker() {
  if (worker) { worker.terminate(); worker = null; }
  if (inline) return;
  try {
    const url = URL.createObjectURL(new Blob([CSP_BOOT.workerSource], { type: "text/javascript" }));
    const w = new Worker(url);
    w.onmessage = (ev: MessageEvent) => { workerSeen = true; onWorkerMessage(ev.data); };
    // a worker that fails before it ever answers was blocked while loading: carry on without one
    w.onerror = (ev) => { if (!workerSeen) { ev.preventDefault?.(); goInline(); } };
    w.postMessage({ type: "init", tables: CSP_BOOT.tables, presets: CSP_BOOT.presets, light });
    worker = w;
  } catch { goInline(); }
}

function goInline() {
  if (inline) return;
  inline = true;
  if (worker) { try { worker.terminate(); } catch { /* already gone */ } worker = null; }
  if (busy && pending && pending.id === runId) runInline(pending);
}

function runInline(msg: RunMsg) {
  const it = stages(msg, { tables: CSP_BOOT.tables, presets: CSP_BOOT.presets, light });
  const step = () => {
    if (msg.id !== runId) return;       // newer inputs arrived: drop this run
    try {
      const r = it.next();
      if (r.done) return;
      onWorkerMessage({ type: "result", id: msg.id, result: r.value });
    } catch (e) {
      onWorkerMessage({ type: "error", id: msg.id, message: e instanceof Error ? e.message : String(e) });
      return;
    }
    window.setTimeout(step, 30);
  };
  window.setTimeout(step, 30);
}

let timer: number | undefined;
function schedule() {
  window.clearTimeout(timer);
  timer = window.setTimeout(() => {
    runId++;
    if (busy) startWorker();          // drop stale work
    busy = true;
    setStatus("Computing…");
    const msg: RunMsg = { type: "run", id: runId, inputs: JSON.parse(JSON.stringify(state)), full: true, guess, expert: ui.mode === "expert" };
    pending = msg;
    if (!inline && !worker) startWorker();
    if (worker) worker.postMessage(msg); else runInline(msg);
  }, inline ? 350 : 120);
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
  return `<span class="info" tabindex="0" role="button" aria-label="About ${esc(h.title)}">i<span class="pop" role="tooltip"><b>${esc(h.title)}</b>${esc(h.body)}${table}${src}</span></span>`;
}

// ------------------------------------------------------------------ left panel
const sel = (id: string, opts: [string, string][], v: string) => `<select id="${id}" class="sel">${opts.map(([k, l]) => `<option value="${k}"${k === v ? " selected" : ""}>${esc(l)}</option>`).join("")}</select>`;
const num = (id: string, v: number, step = 0.01, unit = "", min?: number, max?: number) =>
  `<span class="inp"><input id="${id}" type="number" step="${step}" value="${v}"${min !== undefined ? ` min="${min}"` : ""}${max !== undefined ? ` max="${max}"` : ""}>${unit ? `<span class="unit">${unit}</span>` : ""}</span>`;
const tog = (name: string, opts: [string, string][], v: string) => `<span class="tog" data-tog="${name}">${opts.map(([k, l]) => `<button type="button" data-v="${k}" class="${k === v ? "on" : ""}">${esc(l)}</button>`).join("")}</span>`;

const W0B = w0Bounds(CSP_BOOT.tables);

function renderLeft() {
  const P = CSP_BOOT.presets.presets;
  const E = ui.mode === "expert";
  const t = state.target;
  const customT = ui.targetKey === "rect" || ui.targetKey === "circle";
  const tauC = state.tauClean ?? 1 - state.clothRating / 100;
  const kdP = KD_PRESETS.find((p) => p[0] === ui.kdKey);
  $("#left").innerHTML = `
  <section class="card step"><h3><i>1</i>Where is the reef? ${info("site")}</h3>
    <div class="field"><label for="example">Examples</label>${sel("example", [["", "Choose…"], ...EXAMPLES.map((e) => [e.id, e.name] as [string, string])], ui.exampleId)}</div>
    <div id="map" class="map"><div class="map-off">The map needs internet. Type coordinates below.</div></div>
    <div class="row"><input id="search" class="txt" placeholder="Search a place" aria-label="Search a place"><button id="btn-search" class="btn ghost sm">Find</button></div>
    <div class="coords"><label>Latitude<input id="lat" type="number" step="0.0001" value="${state.site.lat}"></label><label>Longitude<input id="lon" type="number" step="0.0001" value="${state.site.lon}"></label><label>UTC offset<input id="tz" type="number" step="0.5" value="${state.site.tz}"></label></div>
    <div class="lab">Weather data ${info("lightData")}</div>
    <p class="sub${isClear() && !ui.fetching ? " warn" : ""}" id="light-label">${esc(lightLine())}</p>
    <p class="sub warn" id="light-note"${ui.fetchNote ? "" : " hidden"}>${esc(ui.fetchNote)}</p>
    <div class="row wrap"><button id="btn-fetch" class="btn sea sm"${isClear() && !ui.fetching ? "" : " hidden"}>Fetch weather for this site</button><button id="btn-data" class="btn ghost sm">Use a PVGIS file…</button></div>
  </section>
  <section class="card step"><h3><i>2</i>When will the shade be up? ${info("deployment")}</h3>
    <div class="dates"><input id="start" type="date" value="${dstr(state.start)}" aria-label="First day"><span>to</span><input id="end" type="date" value="${dstr(state.end)}" aria-label="Last day"></div>
    <div class="field"><label>Solar noon ${info("noon")}</label>${tog("noonMode", [["computed", `Computed ${noonText()}`], ["user", "Shift"]], ui.noonMode)}</div>
    ${ui.noonMode === "user" ? `<div class="field"><label>Shift (minutes, + = later)</label>${num("noonShift", state.noonShift, 1, "min")}</div>` : ""}
    ${E ? `<div class="field"><label>Waves ${info("waves")}</label>${tog("windMode", [["data", "Wind from data"], ["set", "Set wind"]], ui.windMode)}</div>
    ${ui.windMode === "set" ? `<div class="field"><label>Wind speed</label>${num("wind", state.wind ?? 5, 0.5, "m s⁻¹", 0, 25)}</div>` : ""}` : ""}
  </section>
  <section class="card step"><h3><i>3</i>What is being shaded?</h3>
    <div class="field"><label>Coral area ${info("target")}</label>${sel("target", Object.entries(TARGETS).map(([k, v]) => [k, v.label]), ui.targetKey)}</div>
    ${customT || E ? `<div class="field"><label>${t.shape === "circle" ? "Diameter" : "East–west × north–south"}</label><span class="pair">${num("tlx", t.lx, 0.05, "", 0.1, 20)}${t.shape === "rect" ? `<span>×</span>${num("tly", t.ly, 0.05, "m", 0.1, 20)}` : `<span class="unit">m</span>`}</span></div>` : ""}
    <div class="field"><label>Depth of the corals ${info("depth")}</label>${num("depth", state.depth, 0.5, "m", 0.5, 60)}</div>
    <div class="field"><label>Shade height above corals ${info("height")}</label>${num("height", state.height, 0.05, "m", 0.05, 30)}</div>
    ${E ? `<div class="field"><label>Water clarity, Kd (PAR) ${info("kd")}</label>${num("kd", state.water.kd, 0.01, "m⁻¹", 0.02, 1.5)}</div>
    <div class="field"><label>Scattering ω₀ ${info("w0")}</label>${num("w0", state.water.w0, 0.01, "", W0B[0], W0B[1])}</div>
    <div class="field"><label>ω₀ range ${info("w0range")}</label><span class="pair">${num("w0lo", state.water.w0Lo, 0.01, "", W0B[0], W0B[1])}<span>–</span>${num("w0hi", state.water.w0Hi, 0.01, "", W0B[0], W0B[1])}</span></div>
    ${ui.w0Note ? `<p class="sub">${esc(ui.w0Note)}</p>` : ""}`
    : `<div class="field"><label>Water clarity ${info("kd")}</label>${sel("kdPreset", [...KD_PRESETS.map(([k, l]) => [k, l] as [string, string]), ...(ui.kdKey === "custom" ? [["custom", `Custom (Kd ${state.water.kd} m⁻¹)`] as [string, string]] : [])], ui.kdKey)}</div>
    <p class="sub">${esc(kdP ? kdP[3] : "Set in Expert mode")}.</p>`}
  </section>
  <section class="card step"><h3><i>4</i>How much shade? ${info("scenario")}</h3>
    ${tog("scenario", [["both", "Compare both"], ["constant", "Shade cloth"], ["dynamic", "Midday canopy"]], state.scenario)}
    ${state.scenario !== "dynamic" ? `<div class="field"><label>Cloth shade rating ${info("clothRating")}</label><span class="val" id="rating-val">${state.clothRating} %</span></div>
    <div class="chips" role="group" aria-label="Common shade ratings">${RATINGS.map((x) => `<button type="button" data-rating="${x}" class="${x === state.clothRating && state.tauClean === undefined ? "on" : ""}">${x} %</button>`).join("")}</div>
    <input id="rating" class="slider" type="range" min="10" max="95" step="1" value="${state.clothRating}" aria-label="Cloth shade rating">` : ""}
    ${state.scenario === "both" ? `<div class="lab">Size the canopy to ${info("sync")}</div>${tog("sync", [["yes", "Match the cloth's light"], ["no", "Its own target"]], state.sync ? "yes" : "no")}` : ""}
    ${state.scenario !== "constant" && (!state.sync || state.scenario === "dynamic") ? `<div class="field"><label>Canopy: less light by</label><span class="val" id="dyn-val">${state.dynamicTargetReduction} %</span></div>
    <input id="dynRed" class="slider" type="range" min="10" max="95" step="1" value="${state.dynamicTargetReduction}" aria-label="Light reduction under the canopy">` : ""}
  </section>
  ${E ? `<section class="card step"><h3><i>+</i>Water scattering from a field reading ${info("w0reading")}</h3>
    <p class="sub">Light under an opaque board ÷ open water at the same depth, read at the board's center.</p>
    <div class="field"><label>Under ÷ open, %</label><span class="pair">${num("rdPct", ui.reading.pct, 0.5, "", 0, 100)}<span>±</span>${num("rdErr", ui.reading.err, 0.5, "", 0, 50)}</span></div>
    <div class="field"><label>Board, m (E–W × N–S)</label><span class="pair">${num("rdLx", ui.reading.lx, 0.05)}<span>×</span>${num("rdLy", ui.reading.ly, 0.05)}</span></div>
    <div class="field"><label>Board above the sensor</label>${num("rdH", ui.reading.h, 0.05, "m", 0.05, 5)}</div>
    <div class="field"><label>Taken</label><span class="pair dt"><input id="rdDate" type="date" value="${ui.reading.date}" aria-label="Date of the reading"><input id="rdTime" type="time" value="${ui.reading.time}" aria-label="Time of the reading"></span></div>
    <div class="field"><label>Sky light (diffuse share)</label>${num("rdDif", ui.reading.diffuse, 5, "%", 0, 100)}</div>
    <div class="row"><button id="btn-w0" class="btn sea sm">Find ω₀ from the reading</button></div>
  </section>
  <section class="card step"><h3><i>+</i>Water through the deployment</h3>
    <div class="lab">Kd by date ${info("kdseries")}</div>
    <textarea id="kdSeries" class="txt" rows="3" placeholder="2025-04-28, 0.18&#10;2025-06-01, 0.25" aria-label="Kd by date">${esc(state.kdSeriesText ?? "")}</textarea>
    ${ui.kdNote ? `<p class="sub">${esc(ui.kdNote)}</p>` : ""}
    <div class="lab">Tide: water level ${info("tide")}</div>
    <textarea id="tideSeries" class="txt" rows="3" placeholder="2025-04-28 00:00, 0.42&#10;2025-04-28 01:00, 0.61" aria-label="Tide series">${esc(state.tideText ?? "")}</textarea>
    ${ui.tideNote ? `<p class="sub">${esc(ui.tideNote)}</p>` : ""}
  </section>` : ""}
  ${E && state.scenario !== "dynamic" ? `<section class="card step"><h3><i>+</i>Shade cloth details ${info("fouling")}</h3>
    <div class="field"><label>Light through, clean</label>${num("tauClean", +tauC.toFixed(3), 0.01, "", 0, 1)}</div>
    <div class="field"><label>Fouling</label>${tog("foulMode", [["none", "None"], ["time", "Builds up"]], ui.foulMode)}</div>
    ${ui.foulMode === "time" && state.fouling ? `<div class="field"><label>Light through, fully fouled</label>${num("fTau", state.fouling.tauFouled, 0.01, "", 0, 1)}</div>
    <div class="field"><label>Days to foul fully</label>${num("fDays", state.fouling.daysToFoul, 1, "d", 0, 365)}</div>
    <div class="field"><label>Cleaned every</label>${num("fEvery", state.fouling.cleanEvery, 1, "d", 0, 365)}</div>
    <div class="lab">Other cleaning dates</div><input id="fDates" class="txt" value="${esc(state.fouling.cleanDates)}" placeholder="2025-06-15, 2025-07-10" aria-label="Other cleaning dates">
    <p class="sub">0 days between cleanings means it is only clean at the start.</p>` : ""}
    <div class="field"><label>Size</label>${tog("clothAuto", [["auto", "Automatic"], ["set", "Set"]], ui.clothAuto ? "auto" : "set")}</div>
    ${!ui.clothAuto ? `<div class="field"><label>East–west × north–south</label><span class="pair">${num("clx", state.clothSize?.lx ?? 3, 0.05)}<span>×</span>${num("cly", state.clothSize?.ly ?? 2, 0.05, "m")}</span></div>` : ""}
  </section>` : ""}
  ${E && state.scenario !== "constant" ? `<section class="card step"><h3><i>+</i>Canopy details ${info("canopy")}</h3>
    <div class="field"><label>Size</label>${tog("canopyAuto", [["auto", "Solve"], ["set", "Set"]], ui.canopyAuto ? "auto" : "set")}</div>
    ${!ui.canopyAuto ? `<div class="field"><label>East–west × north–south</label><span class="pair">${num("plx", state.canopy?.lx ?? 1.3, 0.05)}<span>×</span>${num("ply", state.canopy?.ly ?? 1.3, 0.05, "m")}</span></div>
    <div class="field"><label>Offset east / north</label><span class="pair">${num("pcx", state.canopy?.cx ?? 0, 0.05)}<span>/</span>${num("pcy", state.canopy?.cy ?? 0, 0.05, "m")}</span></div>
    <div class="field"><label>Rotation (clockwise)</label>${num("prot", state.canopy?.rot ?? 0, 5, "°", -90, 90)}</div>` : ""}
  </section>` : ""}
  <section class="card step"><h3><i>5</i>Which coral? ${info("coral")}</h3>
    <div class="field"><label for="coral">Coral type</label>${sel("coral", P.map((p: any) => [p.id, p.label + (p.status === "caution" ? " (use with care)" : "")]), state.coral.preset)}</div>
    ${P.find((p: any) => p.id === state.coral.preset)?.Ek_Emax
      ? `<div class="field"><label>Corals adjusted to ${info("acclimation")}</label>${sel("accl", [["time", "Over time (from this depth to the shade)"], ["site", "Light at this depth"], ["shade", "The shade"], ["none", "As measured"]], state.coral.acclimate)}</div>`
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
    const move = (ll: { lat: number; lng: number }) => { state.site.name = `${ll.lat.toFixed(3)}, ${ll.lng.toFixed(3)}`; setSite(+ll.lat.toFixed(4), +ll.lng.toFixed(4)); };
    map.on("click", (e: any) => move(e.latlng));
    marker.on("dragend", () => move(marker.getLatLng()));
    el.querySelector(".map-off")?.remove();
    // tiles blocked (for example in a preview window that forbids network requests): say so instead of a blank map
    let loaded = 0, failed = 0;
    const note = () => {
      if (loaded > 0 || failed < 4 || el.querySelector(".map-off")) return;
      const d = document.createElement("div"); d.className = "map-off"; d.style.zIndex = "1000";
      d.textContent = "Map tiles could not load. Type coordinates below, or choose an example reef.";
      el.appendChild(d); el.classList.add("no-tiles");
    };
    sat.on("tileload", () => { loaded++; el.querySelector(".map-off")?.remove(); el.classList.remove("no-tiles"); });
    sat.on("tileerror", () => { failed++; note(); });
  } catch { /* offline: typed coordinates still work */ }
}

function setSite(lat: number, lon: number, opts: { tz?: number; keepExample?: boolean } = {}) {
  state.site.lat = lat; state.site.lon = lon; state.site.tz = opts.tz ?? utcOffsetFromLon(lon);
  if (!opts.keepExample) ui.exampleId = EXAMPLES.find((e) => Math.abs(e.lat - lat) < 1e-6 && Math.abs(e.lon - lon) < 1e-6)?.id ?? "";
  const la = $("#lat") as HTMLInputElement, lo = $("#lon") as HTMLInputElement;
  if (la && document.activeElement !== la) la.value = String(lat);
  if (lo && document.activeElement !== lo) lo.value = String(lon);
  if (marker) marker.setLatLng([lat, lon]);
  if (matchLight()) { guess = undefined; runId++; startWorker(); }
  ui.fetchNote = "";
  refreshSiteInfo();
  autoFetch();
  schedule();
}

function useExample(id: string) {
  const e = EXAMPLES.find((x) => x.id === id);
  if (!e) return;
  ui.exampleId = id;
  state.site.name = e.name;
  state.start = parseDate(e.deployment.start); state.end = parseDate(e.deployment.end);
  ui.day = null; ui.dayMode = "mean";
  dataLight = exampleLight(e); dataLabel = exLabel(e); dataSource = "example";
  setSite(e.lat, e.lon, { tz: e.utc_offset_h, keepExample: true });
  if (map) map.setView([e.lat, e.lon], 9);
  renderLeft();
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
function setRating(v: number) {
  state.clothRating = Math.round(v); delete state.tauClean;
  if (state.fouling) state.fouling.tauClean = 1 - state.clothRating / 100;
  const val = document.getElementById("rating-val"); if (val) val.textContent = `${state.clothRating} %`;
  const sl = document.getElementById("rating") as HTMLInputElement | null; if (sl && document.activeElement !== sl) sl.value = String(state.clothRating);
  document.querySelectorAll(".chips button").forEach((b) => b.classList.toggle("on", Number((b as HTMLElement).dataset.rating) === state.clothRating));
}

function onInput(e: Event) {
  const el = e.target as HTMLInputElement;
  const v = parseFloat(el.value);
  if (el.id === "dayIdx") { if (last) { ui.day = last.days[Math.round(v)] ?? null; ui.dayMode = "date"; renderResults(true); } return; }
  switch (el.id) {
    case "example": if (el.value) useExample(el.value); return;
    case "lat": case "lon": if (Number.isFinite(v)) { state.site.name = `${(el.id === "lat" ? v : state.site.lat).toFixed(3)}, ${(el.id === "lon" ? v : state.site.lon).toFixed(3)}`; setSite(el.id === "lat" ? v : state.site.lat, el.id === "lon" ? v : state.site.lon); } return;
    case "tz": if (Number.isFinite(v)) { state.site.tz = v; refreshSiteInfo(); } break;
    case "start": if (el.value) state.start = parseDate(el.value); ui.day = null; ui.dayMode = "mean"; break;
    case "end": if (el.value) state.end = parseDate(el.value); ui.day = null; ui.dayMode = "mean"; break;
    case "target": { ui.targetKey = el.value; const t = TARGETS[el.value]!; state.target = { shape: t.shape, lx: t.lx, ly: t.ly }; renderLeft(); break; }
    case "tlx": if (v > 0) { state.target.lx = v; if (state.target.shape === "circle") state.target.ly = v; } break;
    case "tly": if (v > 0) state.target.ly = v; break;
    case "depth": if (v > 0) state.depth = v; break;
    case "height": if (v > 0) state.height = v; break;
    case "kdPreset": { ui.kdKey = el.value; const k = KD_PRESETS.find((p) => p[0] === el.value); if (k) state.water.kd = k[2]; renderLeft(); break; }
    case "kd": if (v > 0) { state.water.kd = v; ui.kdKey = KD_PRESETS.find((p) => p[2] === v)?.[0] ?? "custom"; } break;
    case "w0": if (v >= W0B[0] && v <= W0B[1]) { state.water.w0 = v; ui.w0Note = ""; ui.w0Source = "user"; } break;
    case "w0lo": if (v >= W0B[0] && v <= W0B[1]) { state.water.w0Lo = v; ui.w0Note = ""; ui.w0Source = "user"; } break;
    case "w0hi": if (v >= W0B[0] && v <= W0B[1]) { state.water.w0Hi = v; ui.w0Note = ""; ui.w0Source = "user"; } break;
    case "rdPct": if (v > 0) ui.reading.pct = v; return;
    case "rdErr": if (v >= 0) ui.reading.err = v; return;
    case "rdLx": if (v > 0) ui.reading.lx = v; return;
    case "rdLy": if (v > 0) ui.reading.ly = v; return;
    case "rdH": if (v > 0) ui.reading.h = v; return;
    case "rdDate": ui.reading.date = el.value; return;
    case "rdTime": ui.reading.time = el.value; return;
    case "rdDif": if (v >= 0 && v <= 100) ui.reading.diffuse = v; return;
    case "kdSeries": {
      const t = (el as unknown as HTMLTextAreaElement).value.trim();
      if (!t) { state.kdSeriesText = null; ui.kdNote = ""; break; }
      try { const s = kdSeriesFromCsv(t); state.kdSeriesText = t; ui.kdNote = `${s.size} dates read; each day is interpolated between them.`; }
      catch (err) { ui.kdNote = `Not used: ${err instanceof Error ? err.message : String(err)}`; state.kdSeriesText = null; }
      renderLeft(); break;
    }
    case "tideSeries": {
      const t = (el as unknown as HTMLTextAreaElement).value.trim();
      if (!t) { state.tideText = null; ui.tideNote = ""; break; }
      try {
        const td = tideFromCsv(t), a = td.tLocal[0]!, b = td.tLocal[td.tLocal.length - 1]!;
        const d0 = Date.UTC(state.start[0], state.start[1] - 1, state.start[2]) / 60000, d1 = Date.UTC(state.end[0], state.end[1] - 1, state.end[2]) / 60000 + 1440;
        if (a > d0 || b < d1) throw new Error("the series must cover the whole deployment");
        let lo = Infinity, hi = -Infinity; for (const x of td.level) { lo = Math.min(lo, x); hi = Math.max(hi, x); }
        state.tideText = t; ui.tideNote = `${td.level.length} levels read; range ${fmt(hi - lo, 2)} m. The depth above is taken at mean water level.`;
      } catch (err) { ui.tideNote = `Not used: ${err instanceof Error ? err.message : String(err)}`; state.tideText = null; }
      renderLeft(); break;
    }
    case "fTau": if (state.fouling && v >= 0 && v <= 1) state.fouling.tauFouled = v; break;
    case "fDays": if (state.fouling && v >= 0) state.fouling.daysToFoul = v; break;
    case "fEvery": if (state.fouling && v >= 0) state.fouling.cleanEvery = Math.round(v); break;
    case "fDates": if (state.fouling) { cleanDatesFromText(el.value); state.fouling.cleanDates = el.value; } break;
    case "rating": setRating(v); break;
    case "dynRed": state.dynamicTargetReduction = Math.round(v); { const dv = document.getElementById("dyn-val"); if (dv) dv.textContent = `${state.dynamicTargetReduction} %`; } break;
    case "tauClean": if (v >= 0 && v <= 1) { state.tauClean = v; if (state.fouling) state.fouling.tauClean = v; } break;
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
    case "mode": ui.mode = v as UI["mode"]; document.body.classList.toggle("expert", ui.mode === "expert");
      document.querySelectorAll('[data-tog="mode"] button').forEach((b) => b.classList.toggle("on", (b as HTMLElement).dataset.v === v)); break;
    case "foulMode": {
      ui.foulMode = v as UI["foulMode"];
      const tc = state.tauClean ?? 1 - state.clothRating / 100;
      state.fouling = v === "time" ? { tauClean: tc, tauFouled: +(tc * 0.6).toFixed(3), daysToFoul: 30, cleanEvery: 0, cleanDates: "" } : null;
      break;
    }
  }
  renderLeft(); schedule(); if (last) renderResults();
}

// ------------------------------------------------------------------ w0 from a field reading
function findW0() {
  const R = ui.reading, T = CSP_BOOT.tables;
  const [hh, mm] = R.time.split(":").map(Number);
  const date = parseDate(R.date), minute = (hh ?? 12) * 60 + (mm ?? 0);
  const pan = { cx: 0, cy: 0, lx: R.lx, ly: R.ly, height: R.h, tau: 0, rotDeg: 0 };
  try {
    const f = (p: number) => w0FromReading(T, Math.max(p, 0.01) / 100, pan, [0, 0], state.water.kd, state.depth, date, minute,
      state.site.lat, state.site.lon, state.site.tz, R.diffuse / 100, 0);
    const mid = f(R.pct);
    if (mid.status !== "ok") {
      ui.w0Note = `Not used: the reading (${fmt(R.pct, 1)} %) is ${mid.status === "below" ? "darker" : "brighter"} than the model gives for any ω₀ from ${W0B[0]} to ${W0B[1]} (${fmt(100 * mid.ratioMin, 1)}–${fmt(100 * mid.ratioMax, 1)} % for this board, time, Kd ${state.water.kd} and depth ${state.depth} m). Check Kd, the depth, the board size and height, and the time; ω₀ is unchanged.`;
    } else {
      const lo = f(R.pct - R.err), hi = f(R.pct + R.err);
      const r2 = (x: number) => +x.toFixed(2);
      state.water.w0 = r2(mid.w0); state.water.w0Lo = r2(Math.min(lo.w0, hi.w0)); state.water.w0Hi = r2(Math.max(lo.w0, hi.w0)); ui.w0Source = "reading";
      const edge = lo.status !== "ok" || hi.status !== "ok" ? " Part of the ± range lies outside the tables, so the range is cut at their limit." : "";
      ui.w0Note = `From the reading: ω₀ ${fmt(mid.w0, 2)} (range ${fmt(state.water.w0Lo, 2)}–${fmt(state.water.w0Hi, 2)} for ±${R.err} %), with Kd ${state.water.kd} and the corals' depth ${state.depth} m.${edge}`;
    }
  } catch (e) { ui.w0Note = `Could not use the reading: ${e instanceof Error ? e.message : String(e)}`; }
  renderLeft(); schedule();
}

// ------------------------------------------------------------------ results
const sc = (k: "constant" | "dynamic") => last?.scenarios.find((s) => s.kind === k);

function renderResults(keepFocus = false) {
  if (!last) return;
  const html = resultsHtml({ state, r: last, expert: ui.mode === "expert", version: VERSION, ui, lightLabel: ui.lightLabel, lightSource: ui.lightSource,
    presets: CSP_BOOT.presets.presets, info });
  const right = $("#right");
  const had = keepFocus && (document.activeElement as HTMLElement | null)?.id === "dayIdx";
  right.innerHTML = html;
  if (had) (document.getElementById("dayIdx") as HTMLInputElement | null)?.focus();
  postHeight();
}

// ------------------------------------------------------------------ light-data helper (PVGIS file)
let lastClickY = 0;
function openDataHelper() {
  const lat = state.site.lat, lon = state.site.lon, y = new Date().getFullYear() - 3;
  const m = document.createElement("div");
  m.className = "modal-bg";
  if (EMBED) { m.classList.add("at"); m.style.paddingTop = `${Math.max(12, lastClickY - 260)}px`; }
  m.innerHTML = `<div class="modal" role="dialog" aria-modal="true" aria-label="Use PVGIS light data"><div class="mh"><h2>Use PVGIS light data for this site</h2><span class="sub">${lat.toFixed(4)}, ${lon.toFixed(4)}</span><button class="x" aria-label="Close">×</button></div>
    <p class="sub">PVGIS is the European Commission's solar radiation service. It is the reference for this tool, and between about 65° W and 65° E it offers satellite-based data. It does not let web pages fetch its data, so this takes a download and one extra click.</p>
    <ol class="stepper"><li class="on">1. Choose the data</li><li class="on">2. Download from PVGIS</li><li class="on">3. Add the file</li></ol>
    <label class="opt on"><input type="radio" name="kind" value="tmy" checked><div><b>Typical year (recommended)</b><br><span class="sub">One representative year built by PVGIS from many years of data. Best for designing a structure.</span></div></label>
    <label class="opt"><input type="radio" name="kind" value="hourly"><div><b>Hourly data for chosen years</b><br><span class="sub">The weather that actually happened, for example to compare with a past deployment. Years: <input id="y0" type="number" value="${y - 9}" class="yr" aria-label="First year"> – <input id="y1" type="number" value="${y}" class="yr" aria-label="Last year"></span></div></label>
    <div class="row"><a id="dl" class="btn sea" target="_blank" rel="noopener" href="${tmyUrl(lat, lon)}">Open the PVGIS download</a><span class="sub">Saves a CSV file to your computer.</span></div>
    <div id="drop" class="drop"><b>Drop the CSV here</b> or <label class="link">choose a file<input id="file" type="file" accept=".csv,.txt" hidden></label><br><textarea id="paste" placeholder="…or paste the file's text here" aria-label="Paste the PVGIS file"></textarea></div>
    <div id="preview"></div>
    <div class="actions"><button class="btn ghost" data-close>Cancel</button><button id="use" class="btn sea" disabled>Use this data</button></div></div>`;
  document.body.appendChild(m);
  let imported: ReturnType<typeof importText> | null = null;
  const close = () => { m.remove(); postHeight(); };
  m.querySelector(".x")!.addEventListener("click", close);
  m.querySelector("[data-close]")!.addEventListener("click", close);
  m.addEventListener("keydown", (e) => { if ((e as KeyboardEvent).key === "Escape") close(); });
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
    dataLight = imported.light; dataLabel = imported.summary; dataSource = "pvgis";
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
      state.site.name = `${state.site.lat.toFixed(3)}, ${state.site.lon.toFixed(3)}`;
      dataLabel += " · site moved to the file's location";
    }
    window.clearTimeout(fetchTimer); if (fetchCtl) fetchCtl.abort(); ui.fetching = false; ui.fetchNote = "";
    ui.exampleId = ""; ui.day = null; ui.dayMode = "mean";
    matchLight(); guess = undefined;
    close(); renderLeft(); runId++; startWorker(); schedule();
  });
  (m.querySelector(".x") as HTMLElement).focus();
  postHeight();
}

// ------------------------------------------------------------------ exports
function download(name: string, text: string, type = "text/csv") {
  const a = document.createElement("a");
  a.href = URL.createObjectURL(new Blob([text], { type })); a.download = name; a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 2000);
}

function doExport(kind: string) {
  if (!last) return;
  const r = last, head = `# Coral Shading Protocol ${VERSION}; ${state.site.name} ${state.site.lat}, ${state.site.lon}; ${dstr(state.start)} to ${dstr(state.end)}; ${r.level === "preview" ? "preview" : "full"} resolution; light data: ${ui.lightLabel}; ${assumptions()}\n`;
  if (kind === "inputs") download("csp_inputs.json", JSON.stringify({ app: "Coral Shading Protocol", version: VERSION, inputs: state, light: ui.lightLabel }, null, 1), "application/json");
  if (kind === "points") {
    const cols = r.scenarios.flatMap((s) => [`${s.kind}_daily_light_mol_m2_d`, `${s.kind}_sun_in_line_h`]);
    const lines = [`x_east_m,y_north_m,${cols.join(",")}`];
    for (let p = 0; p < r.points.length / 2; p++) lines.push([r.points[2 * p]!.toFixed(3), r.points[2 * p + 1]!.toFixed(3), ...r.scenarios.flatMap((s) => [s.pointDli[p]!.toFixed(4), s.pointSunHours[p]!.toFixed(2)])].join(","));
    download("csp_points.csv", head + lines.join("\n"));
  }
  if (kind === "days") {
    const cols = r.scenarios.flatMap((s) => [`${s.kind}_reduction_mean_pct`, `${s.kind}_reduction_min_pct`, `${s.kind}_reduction_max_pct`, `${s.kind}_photosynthesis_vs_unshaded`, ...(s.bioDaily.prDaily ? [`${s.kind}_p_to_r`] : [])]);
    const cl = sc("constant")?.tauDays;
    const lines = [`date,weather,kd_m1,${r.depthNoon ? "depth_at_noon_m," : ""}open_water_daily_light_mol_m2_d,open_water_beam_share,${cols.join(",")}${cl ? ",cloth_transmission" : ""}`];
    const wx = weatherLabel();
    r.days.forEach((d, i) => lines.push([dstr(d), wx, r.kdDays[i]!.toFixed(4), ...(r.depthNoon ? [r.depthNoon[i]!.toFixed(3)] : []), r.open.dayDli[i]!.toFixed(3), (r.open.dayBeamShare[i] ?? 0).toFixed(3),
      ...r.scenarios.flatMap((s) => [...[s.dayReduction[i]!.mean, s.dayReduction[i]!.min, s.dayReduction[i]!.max].map((x) => x.toFixed(2)), s.bioDaily.grossVsOpen[i]!.toFixed(3), ...(s.bioDaily.prDaily ? [s.bioDaily.prDaily[i]!.toFixed(3)] : [])]), ...(cl ? [cl[i]!.toFixed(4)] : [])].join(",")));
    download("csp_days.csv", head + lines.join("\n"));
  }
  if (kind === "report") {
    const w = window.open("", "_blank");
    if (!w) { setStatus("The report opens in a new window: allow pop-ups for this page.", true); return; }
    w.document.write(`<!doctype html><html><head><meta charset="utf-8"><title>Coral Shading Protocol report</title><style>${$("#css").textContent}body{background:#fff}.top,.exports,.info,.daybar,.opt-b::after{display:none}.wrap{display:block}</style></head><body class="print">
      <div style="padding:20px 28px"><h1 style="margin:0 0 4px">Coral Shading Protocol ${VERSION}: design report</h1><p class="sub">${esc(state.site.name)} (${state.site.lat}, ${state.site.lon}) · ${dstr(state.start)} to ${dstr(state.end)} · ${esc(ui.lightLabel)} · water ${state.kdSeriesText ? "Kd by date" : `Kd ${state.water.kd} m⁻¹`}, ω₀ ${state.water.w0} (range ${state.water.w0Lo}–${state.water.w0Hi}) · corals at ${state.depth} m${state.tideText ? " at mean water level, with tide" : ""}, structures ${state.height} m above</p>
      ${$("#right").innerHTML}<p class="sub">Computed ${new Date().toISOString().slice(0, 10)} at ${r.level === "preview" ? "preview" : "full"} resolution. Methods and sources: github.com/grahamhp/coral-shading-protocol.</p></div></body></html>`);
    w.document.close(); setTimeout(() => w.print(), 400);
  }
}

// ------------------------------------------------------------------ embedding: tell the host page how tall the app is
let lastH = 0;
function postHeight() {
  if (!EMBED) return;
  requestAnimationFrame(() => {
    const modal = document.querySelector(".modal") as HTMLElement | null;
    const h = Math.ceil(Math.max(document.body.scrollHeight, modal ? modal.getBoundingClientRect().bottom + 24 : 0));
    if (Math.abs(h - lastH) < 2) return;
    lastH = h;
    try { window.parent.postMessage({ type: "csp:height", height: h }, "*"); } catch { /* not embedded after all */ }
  });
}

// ------------------------------------------------------------------ pointer readouts: help popups and chart values
function placePop(infoEl: HTMLElement) {
  const pop = infoEl.querySelector(".pop") as HTMLElement | null;
  if (!pop) return;
  pop.style.left = "0px"; pop.style.top = "0px";
  const a = infoEl.getBoundingClientRect(), w = Math.min(340, window.innerWidth - 16);
  pop.style.width = `${w}px`;
  const ph = pop.offsetHeight, vh = EMBED ? Infinity : window.innerHeight;
  let x = a.right + 8, y = a.top - 8;
  if (x + w > window.innerWidth - 8) x = Math.max(8, Math.min(a.left - w / 2, window.innerWidth - w - 8)), y = a.bottom + 8;
  if (y + ph > vh - 8) y = Math.max(8, a.top - ph - 8);
  pop.style.left = `${x}px`; pop.style.top = `${Math.max(8, y)}px`;
}

function chartHover(e: PointerEvent) {
  const tip = $("#tip");
  const svg = (e.target as Element).closest?.("svg[data-hv]") as SVGSVGElement | null;
  document.querySelectorAll("svg[data-hv] .xh").forEach((l) => { if (!svg || !svg.contains(l)) l.setAttribute("opacity", "0"); });
  const h = svg ? HOVER.get(svg.dataset.hv!) : undefined;
  if (!svg || !h) { tip.hidden = true; return; }
  const box = svg.getBoundingClientRect(), px = ((e.clientX - box.left) / box.width) * h.w;
  if (px < h.px0 - 4 || px > h.px1 + 4) { tip.hidden = true; svg.querySelector(".xh")?.setAttribute("opacity", "0"); return; }
  const xv = h.xmin + ((px - h.px0) / (h.px1 - h.px0)) * (h.xmax - h.xmin);
  let k = 0, bd = Infinity;
  for (let i = 0; i < h.x.length; i++) { const d = Math.abs(h.x[i]! - xv); if (d < bd) { bd = d; k = i; } }
  const sx = h.px0 + ((h.x[k]! - h.xmin) / (h.xmax - h.xmin)) * (h.px1 - h.px0);
  const xh = svg.querySelector(".xh");
  if (xh) { xh.setAttribute("x1", sx.toFixed(1)); xh.setAttribute("x2", sx.toFixed(1)); xh.setAttribute("opacity", ".35"); }
  tip.textContent = "";
  const head = document.createElement("div"); head.className = "tip-h";
  head.textContent = h.kind === "time" ? hhmm(h.x[k]!) : (h.labels?.[k] ?? "");
  tip.appendChild(head);
  for (const s of h.series) {
    const row = document.createElement("div"); row.className = "tip-r";
    const key = document.createElement("span"); key.className = "key" + (s.dash ? " dash" : ""); key.style.borderColor = s.color;
    const val = document.createElement("b"); val.textContent = (s.y[k] ?? NaN).toFixed(h.digits);
    const nm = document.createElement("span"); nm.textContent = s.name;
    row.append(key, val, nm); tip.appendChild(row);
  }
  const unit = document.createElement("div"); unit.className = "tip-u"; unit.textContent = h.unit; tip.appendChild(unit);
  tip.hidden = false;
  const tw = tip.offsetWidth, th = tip.offsetHeight;
  let x = e.clientX + 14, y = e.clientY - th - 10;
  if (x + tw > window.innerWidth - 8) x = e.clientX - tw - 14;
  if (y < 8) y = e.clientY + 16;
  tip.style.left = `${x + window.scrollX}px`; tip.style.top = `${y + window.scrollY}px`;
}

// ------------------------------------------------------------------ boot
function boot() {
  document.body.classList.toggle("embed", EMBED);
  document.body.innerHTML = `
  <header class="top"><div class="brand">Coral Shading Protocol<small>v${VERSION}</small></div>
    <div class="seg" data-tog="mode" role="group" aria-label="Mode"><button type="button" data-v="simple" class="on">Simple</button><button type="button" data-v="expert">Expert</button></div>
    <span class="chip" id="chip"></span><div class="spacer"></div><span id="status" class="status" role="status">Starting…</span>
    <button class="btn line" id="btn-reset" title="Back to the starting example">Start over</button><button class="btn light" data-export="report">Report</button></header>
  <main class="wrap"><aside id="left" aria-label="Inputs"></aside><section id="right" aria-label="Results"><div class="card"><p>Computing…</p></div></section></main>
  <footer class="foot">Free and open source (MIT) from REEF Scuba: <a href="https://github.com/grahamhp/coral-shading-protocol" target="_blank" rel="noopener">code, methods and validation</a>. Sunlight data: PVGIS © European Union; ERA5 (Copernicus Climate Change Service) via <a href="https://open-meteo.com/" target="_blank" rel="noopener">Open-Meteo.com</a> (CC BY 4.0). Place search © OpenStreetMap contributors. Imagery: Sentinel-2 cloudless by EOX.</footer>
  <div id="tip" class="tip" hidden></div>`;
  document.addEventListener("change", onInput);
  document.addEventListener("input", (e) => { const id = (e.target as HTMLElement).id; if (["rating", "dynRed", "dayIdx"].includes(id)) onInput(e); });
  document.addEventListener("click", (e) => {
    const t = e.target as HTMLElement;
    lastClickY = (e as MouseEvent).pageY;
    const b = t.closest("[data-tog] button") as HTMLElement | null;
    if (b) { const g = b.parentElement!.dataset.tog!; b.parentElement!.querySelectorAll("button").forEach((x) => x.classList.toggle("on", x === b)); onToggle(g, b.dataset.v!); return; }
    const rt = t.closest("[data-rating]") as HTMLElement | null;
    if (rt) { setRating(Number(rt.dataset.rating)); if (state.scenario === "dynamic") { state.scenario = "both"; } renderLeft(); schedule(); return; }
    const dm = t.closest("[data-daymode]") as HTMLElement | null;
    if (dm && last) {
      const o = last.open.dayDli, mode = dm.dataset.daymode!;
      if (mode === "mean") ui.dayMode = "mean";
      else { ui.dayMode = "date"; ui.day = last.days[o.indexOf(mode === "clear" ? Math.max(...o) : Math.min(...o))] ?? null; }
      renderResults(); return;
    }
    const dbtn = t.closest("[data-day]") as HTMLElement | null;
    if (dbtn && last) { const cur = ui.dayMode === "mean" ? (Number(dbtn.dataset.day) > 0 ? -1 : last.days.length) : dayIndex(last, ui.day);
      const k = Math.min(last.days.length - 1, Math.max(0, cur + Number(dbtn.dataset.day))); ui.day = last.days[k]!; ui.dayMode = "date"; renderResults(); return; }
    const x = t.closest("[data-export]") as HTMLElement | null;
    if (x) { doExport(x.dataset.export!); return; }
    if (t.id === "btn-data") openDataHelper();
    if (t.id === "btn-fetch") autoFetch(true);
    if (t.id === "btn-w0") findW0();
    if (t.id === "btn-search") search();
    if (t.id === "btn-reset") location.reload();
  });
  document.addEventListener("keydown", (e) => { if ((e.target as HTMLElement).id === "search" && e.key === "Enter") search(); });
  // help popups stay inside the window
  const showPop = (e: Event) => { const i = (e.target as HTMLElement).closest?.(".info") as HTMLElement | null; if (i) placePop(i); };
  document.addEventListener("pointerover", showPop); document.addEventListener("focusin", showPop);
  document.addEventListener("pointermove", chartHover);
  document.addEventListener("pointerleave", () => { $("#tip").hidden = true; });
  if (EMBED && "ResizeObserver" in window) new ResizeObserver(postHeight).observe(document.body);
  window.addEventListener("online", () => { if (!map) renderLeft(); autoFetch(); });
  renderLeft(); refreshSiteInfo(); startWorker(); schedule();
  // for testing and for power users in the browser console
  (window as unknown as Record<string, unknown>).__csp = { state, ui, toggle: onToggle, exportAs: doExport, results: () => last, inline: () => inline, render: renderResults, rerun: schedule, setSite, useExample, light: () => light };
}

boot();
