// The results side of the interface: plain HTML strings from the computed results (no DOM access, so it can be tested in Node).
import type { Inputs, Results, ScenarioOut } from "./compute.ts";
import type { Day } from "../core/scenarios.ts";
import { COLORS, ZONE_TINTS, lineChart, mapChart, colorbar, dailyLightChart, peChart, barCell, resetHover } from "./charts.ts";

export interface Ctx {
  state: Inputs; r: Results; expert: boolean; version: string;
  ui: { day: Day | null; dayMode: "mean" | "date"; w0Source: "default" | "reading" | "user"; clothAuto: boolean; lightKind: string };
  lightLabel: string; lightSource: "example" | "pvgis" | "era5" | "clear";
  presets: any[]; info: (key: string) => string;
}

const esc = (s: string) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);
export const fmt = (v: number, d = 1) => (Number.isFinite(v) ? v.toFixed(d) : "–");
export const pct = (v: number) => (Number.isFinite(v) ? `${Math.round(v)} %` : "–");
export const MON = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
export const dstr = (d: [number, number, number]) => `${d[0]}-${String(d[1]).padStart(2, "0")}-${String(d[2]).padStart(2, "0")}`;
/** Keep numbers with their units and "a × b" together on one line. */
const nb = (s: string) => s.replace(/ × /g, " × ").replace(/(\d) (?=(m|%|h|mol|µmol|°|d⁻¹)(?![A-Za-z]))/g, "$1 ");
const sameDay = (a: Day, b: Day) => a[0] === b[0] && a[1] === b[1] && a[2] === b[2];
export const nameOf = (s: { kind: string }) => (s.kind === "constant" ? "Constant shading" : "Dynamic shading");
const color = (s: { kind: string }) => (s.kind === "constant" ? COLORS.cloth : COLORS.canopy);
const dot = (c: string) => `<span class="dot" style="background:${c}"></span>`;
const mean = (a: number[]) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : NaN);

export function dayIndex(r: Results, day: Day | null): number {
  if (!day) return 0;
  const k = r.days.findIndex((d) => sameDay(d, day));
  if (k >= 0) return k;
  const t = Date.UTC(day[0], day[1] - 1, day[2]);
  let best = 0, bd = Infinity;
  r.days.forEach((d, i) => { const dd = Math.abs(Date.UTC(d[0], d[1] - 1, d[2]) - t); if (dd < bd) { bd = dd; best = i; } });
  return best;
}

/** How the sky was on a day, from that day's light relative to the brightest day of the deployment. */
function sky(r: Results, di: number): string {
  const o = r.open.dayDli, mx = Math.max(...o), f = mx > 0 ? o[di]! / mx : 1;
  return f >= 0.85 ? "a clear day" : f >= 0.6 ? "a partly cloudy day" : f >= 0.35 ? "a cloudy day" : "a heavily overcast day";
}

export function resultsHtml(c: Ctx): string {
  resetHover();
  const { state, r, expert: E, ui, info } = c;
  const sc = (k: "constant" | "dynamic") => r.scenarios.find((s) => s.kind === k);
  const C = sc("constant"), D = sc("dynamic"), open = r.open.dliMean;
  const main = D ?? C!;
  const red = (s: ScenarioOut) => 100 * (1 - s.T);
  const rangeOf = (s: ScenarioOut) => (s.w0Range ? `${fmt(100 * Math.min(...s.w0Range), 0)}–${fmt(100 * Math.max(...s.w0Range), 0)} %` : "");
  const clear = c.lightSource === "clear";
  const hasR = main.bio.prDaily !== undefined;
  const preset = c.presets.find((p: any) => p.id === state.coral.preset);

  // ------------------------------------------------------------ headline
  const ratingNote = C && state.tauClean === undefined
    ? ` The cloth is rated ${state.clothRating} % shade, but light also reaches the corals from the sides, so more gets through than the rating suggests.` : "";
  const rng = (s: ScenarioOut) => (s.w0Range ? `, likely ${rangeOf(s)},` : "");
  const lead = C && D
    ? (Math.abs(C.T - D.T) < 0.01
      ? `Both kinds of shading give the corals ${pct(100 * C.T)} of the light they would get unshaded${rng(D).replace(/,$/, "")} (${pct(red(C))} less), summed over the deployment.${ratingNote}${state.sync ? " Dynamic shading is sized to match constant shading." : ""}`
      : `Summed over the deployment, constant shading gives the corals ${pct(100 * C.T)} of the light they would get unshaded${rng(C)} and dynamic shading ${pct(100 * D.T)}${rng(D).replace(/,$/, "")}.${ratingNote}`)
    : `${nameOf(main)} gives the corals ${pct(100 * main.T)} of the light they would get unshaded${rng(main).replace(/,$/, "")} (${pct(red(main))} less), summed over the deployment.${C ? ratingNote : ""}`;
  const stage = r.level === "preview" ? `<span class="pill wait">Quick preview, refining…</span>` : "";

  // ------------------------------------------------------------ headline numbers
  const both = (f: (s: ScenarioOut) => string) => r.scenarios.map((s) => `<span class="pair-v">${r.scenarios.length > 1 ? dot(color(s)) : ""}${f(s)}</span>`).join("");
  const kp = (title: string, key: string, value: string, sub: string) => `<div class="card kpi"><div class="t">${title} ${info(key)}</div><div class="n">${value}</div><div class="s">${sub}</div></div>`;
  // coral metrics: "first" = before the corals adjust to the shade (Ek as in open water at this depth); "adj" = with the chosen acclimation
  const two = main.bioFirst !== null;
  const F = (s: ScenarioOut) => s.bioFirst ?? s.bio, oF = r.open.bioFirst ?? r.open.bio;
  // how far the corals adjust (share of the way from the Ek at this depth to the Ek matched to the shade)
  const mode = preset?.Ek_Emax ? state.coral.acclimate : "none";
  const ext = mode === "time" || mode === "shade" ? Math.min(1, Math.max(0, state.coral.extent ?? 1)) : 1;
  const part = ext < 1, way = `${Math.round(100 * ext)} % of the way to the shade`;
  const accl = ext <= 0 ? "for corals that do not adjust to the shade"
    : ({ time: part ? `once the corals have adjusted ${way}` : "once the corals have adjusted to the shade", shade: part ? `for corals adjusted ${way}` : "for corals adjusted to the shade",
      site: "for corals adjusted to open water at this depth", none: "with Ek as measured" } as Record<string, string>)[mode]!;
  const kpis = [
    kp("Light at the corals", "kpiLight", both((s) => pct(100 * s.T)), `of unshaded light at ${fmt(state.depth, 1)} m${main.w0Range ? `, likely ${rangeOf(main)}` : ""}`),
    kp("Daily light", "kpiDli", both((s) => fmt(s.dliMean, 1)), `mol m⁻² d⁻¹. Unshaded at this depth: ${fmt(open, 1)}`),
    kp(two ? "Photosynthesis, first days" : "Photosynthesis", "kpiPhoto", both((s) => pct(100 * F(s).grossVsOpen!)), two ? "of unshaded, before the corals adjust to the shade" : `of unshaded, ${accl}`),
    hasR ? kp("Energy balance (P:R)", "kpiPR", both((s) => (two ? `${fmt(F(s).prDaily!, 2)}<span class="arrow">to</span>${fmt(s.bio.prDaily!, 2)}` : fmt(s.bio.prDaily!, 2))),
      `${two ? `First days, then once adjusted${part ? ` (${way})` : " to the shade"}. ` : ""}Above 1, photosynthesis covers respiration. Unshaded: ${fmt(oF.prDaily ?? NaN, 2)}`)
      : kp("Time above saturation", "kpiSat", both((s) => `${fmt(F(s).hoursSaturated ?? NaN, 1)} h`), `per day with more light than photosynthesis can use${two ? ", first days" : ""}. Unshaded: ${fmt(oF.hoursSaturated ?? NaN, 1)} h`),
  ];
  const kpiLegend = r.scenarios.length > 1 ? `<div class="legend lead-key">${r.scenarios.map((s) => `<span>${dot(color(s))}${nameOf(s)}</span>`).join("")}</div>` : "";

  // ------------------------------------------------------------ the plan at a glance
  const cols = [...r.scenarios];
  const th = cols.map((s) => `<th>${dot(color(s))}${nameOf(s)}<br><span class="sub">${s.kind === "constant" ? "shade cloth, all day" : "opaque canopy, shades at midday"}</span></th>`).join("") + `<th>No shade<br><span class="sub">open water at ${fmt(state.depth, 1)} m</span></th>`;
  const row = (label: string, sub: string, f: (s: ScenarioOut) => string, o = "–", cls = "") => `<tr${cls ? ` class="${cls}"` : ""}><td>${label}${sub ? `<br><span class="sub">${sub}</span>` : ""}</td>${cols.map((s) => `<td>${f(s)}</td>`).join("")}<td class="o">${o}</td></tr>`;
  const material = (s: ScenarioOut) => s.kind === "constant"
    ? `${state.tauClean !== undefined ? `Cloth passing ${fmt(100 * state.tauClean, 0)} % of light` : `${state.clothRating} % shade cloth`}${state.fouling ? `<br><span class="sub">fouling to ${fmt(100 * state.fouling.tauFouled, 0)} % over ${state.fouling.daysToFoul} days${state.fouling.cleanEvery > 0 ? `, cleaned every ${state.fouling.cleanEvery} days` : ""}</span>` : ""}`
    : "Opaque panel";
  const sizing = (s: ScenarioOut) => s.kind === "constant"
    ? (ui.clothAuto ? "large enough that the sun reaches the corals only through it" : "size set by you")
    : (s.solve ? (state.sync && C ? "width solved to give the same light as the cloth" : `width solved for ${state.dynamicTargetReduction} % less light`) : "size set by you");
  const b = (s: ScenarioOut, k: string) => s.bio[k] ?? NaN;
  const prCell = (v: number) => fmt(v, 2);
  const plan = `<div class="card"><h2>The plan at a glance ${info("plan")}</h2>
    <p class="sub">What to build, and what the corals get under it compared with no shade. Sizes are east–west × north–south, centered over the coral area.</p>
    <div class="tscroll"><table class="t plan"><thead><tr><th></th>${th}</tr></thead><tbody>
    <tr class="grp"><td colspan="${cols.length + 2}">What to build</td></tr>
    ${row("Material", "", material)}
    ${row("Size", "", (s) => `<b>${fmt(s.panel.lx, 2)} × ${fmt(s.panel.ly, 2)} m</b><br><span class="sub">${sizing(s)}</span>`)}
    ${row("Area of material", "", (s) => `${fmt(s.panel.lx * s.panel.ly, 1)} m²`)}
    ${row("Height above the corals", "", () => `${fmt(state.height, 2)} m`)}
    <tr class="grp"><td colspan="${cols.length + 2}">Light the corals get</td></tr>
    ${row("Whole deployment", "share of unshaded light", (s) => `<b>${pct(100 * s.T)}</b>${s.w0Range ? `<br><span class="sub">likely ${rangeOf(s)}</span>` : ""}`, "100 %")}
    ${row("Around midday", "solar noon ± 1 h", (s) => (s.contrast ? pct(100 * s.contrast.noon) : "–"), "100 %")}
    ${row("Morning and afternoon", "3 h or more from solar noon", (s) => (s.contrast ? pct(100 * s.contrast.side) : "–"), "100 %")}
    ${row("Daily light", "mol m⁻² d⁻¹, mean of all days", (s) => fmt(s.dliMean, 1), fmt(open, 1))}
    <tr class="grp"><td colspan="${cols.length + 2}">What it means for the corals <span class="sub">(${esc(preset?.label ?? "")})</span></td></tr>
    ${row(two ? "Photosynthesis, first days" : "Photosynthesis", two ? "share of unshaded, before the corals adjust" : "share of unshaded", (s) => pct(100 * F(s).grossVsOpen!), "100 %")}
    ${hasR ? row(two ? "Energy balance (P:R), first days" : "Energy balance (P:R)", "daily photosynthesis ÷ respiration", (s) => prCell(F(s).prDaily!), fmt(oF.prDaily ?? NaN, 2)) : ""}
    ${hasR && two ? row("Energy balance, once adjusted", part ? `if the corals adjust ${way}` : "if the corals adjust fully to the shade", (s) => prCell(b(s, "prDaily")), fmt(r.open.bio.prDaily ?? NaN, 2)) : ""}
    ${row(two ? "Time above saturation, first days" : "Time above saturation", "hours per day with more light than photosynthesis can use", (s) => `${fmt(F(s).hoursSaturated ?? NaN, 1)} h`, `${fmt(oF.hoursSaturated ?? NaN, 1)} h`)}
    </tbody></table></div>
    ${two ? `<p class="sub">“First days”: the corals are still adjusted to the light at this depth. ${part
      ? `“Once adjusted” assumes they then move ${way} within about a week. That share is an assumption you can change under Which coral: full adjustment within 5 to 10 days has been measured in the laboratory, and a low share keeps the plan from leaning on it. Only the saturation light Ek changes in the model; maximum photosynthesis and respiration are held fixed.`
      : "In the model they adjust to the shade within about a week (only the saturation light Ek changes; maximum photosynthesis and respiration are held fixed), so the adjusted values are on the optimistic side."}</p>` : ""}
    ${hasR ? "" : `<p class="sub">Energy balance needs respiration data, which the sources for this coral lack.</p>`}</div>`;

  // ------------------------------------------------------------ light across the coral area (plan view)
  const allDli = r.scenarios.flatMap((s) => s.pointDli);
  const vmin = Math.floor(Math.min(...allDli) * 2) / 2, vmax = Math.ceil(Math.max(...allDli) * 2) / 2;
  const extent = Math.max(state.target.lx, state.target.ly, ...r.scenarios.map((s) => Math.max(s.panel.lx, s.panel.ly) + 2 * Math.hypot(s.panel.cx, s.panel.cy))) * 1.08;
  const maps = r.scenarios.map((s) => mapChart(r.points, s.pointDli, r.spacing, vmin, vmax, { lx: s.panel.lx, ly: s.panel.ly, cx: s.panel.cx, cy: s.panel.cy, rot: s.panel.rotDeg },
    state.target, nameOf(s), extent, s.kind === "dynamic" ? s.clearance?.never : undefined)).join("");
  const never = D?.clearance?.share ? ` <span class="sw" style="background:${COLORS.coral}"></span>Dots: parts that never have the sun in line.` : "";
  const mapCard = `<div class="card"><h2>Seen from above</h2><p class="sub">Daily light on each part of the coral area, mean of all days. Dashed line: the structure. White line: edge of the coral area. Drawn to scale, north up.${never}</p>
    <div class="maps n${r.scenarios.length}">${maps}</div>${colorbar(vmin, vmax, "Daily light (mol m⁻² d⁻¹)")}</div>`;

  // ------------------------------------------------------------ how much shade: the same cloth at other ratings
  let options = "";
  if (C) {
    const O = r.clothOptions;
    const body = O === undefined ? `<tr><td colspan="6" class="wait">Computing…</td></tr>`
      : O === null ? `<tr><td colspan="6" class="wait">Not shown for a cloth of set size${state.tauClean !== undefined ? " or a custom transmission" : ""}.</td></tr>`
      : O.map((o) => { const f = o.first ?? o; return `<tr class="${o.current ? "cur" : ""}"><td><button type="button" class="opt-b" data-rating="${o.rating}"${o.current ? " aria-pressed=\"true\"" : ""}>${o.rating} %</button>${o.current ? `<span class="pill">this plan</span>` : ""}</td>
        <td>${barCell(100 * o.T, 100, COLORS.cloth, pct(100 * o.T))}</td><td>${fmt(o.dliMean, 1)}</td>
        <td>${barCell(100 * f.grossVsOpen, 100, COLORS.sea, pct(100 * f.grossVsOpen))}</td>
        ${hasR ? `<td>${f.prDaily !== null ? prCell(f.prDaily) : "–"}${o.first && o.prDaily !== null ? `<br><span class="sub">once adjusted ${fmt(o.prDaily, 2)}</span>` : ""}</td>` : ""}<td>${fmt(f.hoursSaturated, 1)} h</td></tr>`; }).join("");
    options = `<div class="card"><h2>How much shade? The same cloth at other ratings ${info("shadeEvidence")}</h2>
      <p class="sub">Each row is a cloth of the same size with another shade rating, over the same deployment. Choose a rating to use it in the plan.${two ? " “First days”: before the corals adjust to the shade." : ""}</p>
      <div class="tscroll"><table class="t opts"><thead><tr><th>Cloth shade rating</th><th>Light at the corals<br><span class="sub">share of unshaded</span></th><th>Daily light<br><span class="sub">mol m⁻² d⁻¹</span></th>
      <th>Photosynthesis<br><span class="sub">${two ? "first days, " : ""}share of unshaded</span></th>${hasR ? `<th>Energy balance (P:R)<br><span class="sub">${two ? "first days" : "daily"}</span></th>` : ""}<th>Above saturation<br><span class="sub">${two ? "first days, " : ""}hours per day</span></th></tr></thead><tbody>${body}
      <tr class="o"><td>No shade</td><td>${barCell(100, 100, COLORS.open, "100 %")}</td><td>${fmt(open, 1)}</td><td>${barCell(100, 100, COLORS.open, "100 %")}</td>${hasR ? `<td>${fmt(oF.prDaily ?? NaN, 2)}</td>` : ""}<td>${fmt(oF.hoursSaturated ?? NaN, 1)} h</td></tr></tbody></table></div>
      <p class="sub">How to read it: more shade removes more of the light the corals cannot use (time above saturation) and leaves less for photosynthesis. Shade levels tested in published heat-stress trials: 30 % (aquarium), 50 % and 75 % (on a reef; the heavier shade protected better). Those are nominal shade levels in shallow water, not light at depth as computed here. This tool computes light and photosynthesis; it does not predict bleaching.</p></div>`;
  }

  // ------------------------------------------------------------ a day under the structures
  const nD = r.days.length, di = dayIndex(r, ui.day), dd = r.days[di]!;
  const odli = r.open.dayDli, lo = Math.min(...odli), hi = Math.max(...odli);
  const iClear = odli.indexOf(hi), iCloud = odli.indexOf(lo);
  const avg = (rows: number[][]) => rows[0]!.map((_, k) => rows.reduce((a, row) => a + row[k]!, 0) / rows.length);
  const isMean = ui.dayMode === "mean";
  const series = isMean
    ? [{ name: "Open water", x: r.minutes, y: avg(r.open.dayCurves), color: COLORS.open, dash: "5 4" },
      ...r.scenarios.map((s) => ({ name: nameOf(s), x: r.minutes, y: avg(s.dayCurves.mean), color: color(s), fill: true }))]
    : [{ name: "Open water", x: r.minutes, y: r.open.dayCurves[di]!, color: COLORS.open, dash: "5 4" },
      ...r.scenarios.map((s) => ({ name: nameOf(s), x: r.minutes, y: s.dayCurves.mean[di]!, color: color(s), fill: true }))];
  const legend = `<div class="legend"><span><span class="key dash" style="border-color:${COLORS.open}"></span>Open water at ${fmt(state.depth, 1)} m</span>${r.scenarios.map((s) => `<span><span class="key" style="border-color:${color(s)}"></span>${nameOf(s)}</span>`).join("")}</div>`;
  const dbtn = (mode: string, label: string, on: boolean, extra = "") => `<button type="button" data-daymode="${mode}"${extra} class="${on ? "on" : ""}">${label}</button>`;
  const picker = `<div class="daybar"><span class="tog">${dbtn("mean", "Average day", isMean)}${dbtn("clear", "Clearest day", !isMean && di === iClear)}${dbtn("cloud", "Cloudiest day", !isMean && di === iCloud)}</span>
    <div class="daypick"><button class="btn ghost sm" data-day="-1" aria-label="Previous day"${!isMean && di === 0 ? " disabled" : ""}>‹</button><input id="dayIdx" type="range" min="0" max="${nD - 1}" step="1" value="${di}" aria-label="Day of the deployment"><button class="btn ghost sm" data-day="1" aria-label="Next day"${!isMean && di === nD - 1 ? " disabled" : ""}>›</button><span class="dd">${isMean ? "all days" : `${MON[dd[1] - 1]} ${dd[2]}`}</span></div></div>`;
  const wx = clear ? "Clear-sky estimate (no clouds), so every day looks alike." : ui.lightKind === "tmy" ? "Typical-year weather: one plausible day for this date, not a forecast." : "Recorded weather.";
  const beamDay = 100 * (r.open.dayBeamShare?.[di] ?? 0);
  const dayNote = isMean
    ? `The mean of all ${nD} days at each time of day. Area mean over the coral area. Use the buttons or the slider for single days.`
    : `${MON[dd[1] - 1]} ${dd[2]} was ${clear ? "cloud-free" : sky(r, di)}: open water got ${fmt(odli[di]!, 1)} mol m⁻² (${fmt(lo, 1)}–${fmt(hi, 1)} over the deployment), ${fmt(beamDay, 0)} % of it straight from the sun. ${D && beamDay < 12 ? "With so little direct sun, the canopy shades much like a cloth: the light comes from the whole sky. " : ""}${wx}${E ? ` ${state.kdSeriesText ? `Kd that day ${fmt(r.kdDays[di]!, 3)} m⁻¹` : `Kd ${state.water.kd} m⁻¹`}; ${r.depthNoon ? `corals at ${fmt(r.depthNoon[di]!, 2)} m at noon (tide)` : "fixed depth"}.` : ""}`;
  const dayCard = `<div class="card"><h2>Through the day ${info("dayChart")}</h2>${picker}<p class="sub">${dayNote}</p>
    ${lineChart(series, { ylab: "Light at the corals (µmol m⁻² s⁻¹)", noon: isMean ? mean(r.noons) : r.noons[di]!, h: 250 })}${legend}</div>`;

  // ------------------------------------------------------------ across the deployment
  const dayLight = (s: ScenarioOut) => r.open.dayDli.map((o, i) => o * (1 - s.dayReduction[i]!.mean / 100));
  const season = dailyLightChart(r.days, [{ y: r.open.dayDli, color: COLORS.open, name: "Open water", dash: "5 4" },
    ...r.scenarios.map((s) => ({ y: dayLight(s), color: color(s), name: nameOf(s) }))], isMean ? undefined : di);
  const condNote = (state.kdSeriesText ? ` Water clarity changes by date (Kd ${fmt(Math.min(...r.kdDays), 2)}–${fmt(Math.max(...r.kdDays), 2)} m⁻¹).` : "")
    + (r.depthNoon ? " Depth follows the tide." : "")
    + (C?.tauDays ? ` The cloth passes ${fmt(100 * Math.min(...C.tauDays), 0)}–${fmt(100 * Math.max(...C.tauDays), 0)} % as it fouls and is cleaned.` : "");
  const seasonCard = `<div class="card"><h2>Through the deployment</h2><p class="sub">Daily light at the corals, one value per day. ${clear ? "No clouds in a clear-sky estimate, so the line is smooth." : "Dips are cloudy days; shaded corals follow the weather too."}${condNote}</p>${season}${legend}</div>`;

  // ------------------------------------------------------------ checks
  const checks: string[] = [];
  const chk = (kind: "ok" | "warn" | "note", tag: string, head: string, body: string) => checks.push(`<div class="check"><span class="badge ${kind}">${tag}</span><div><b>${head}</b>${body ? `<br><span class="sub">${body}</span>` : ""}</div></div>`);
  for (const w of r.lightNotes ?? []) { const k = w.indexOf(". ") + 1; chk("warn", "CHECK", esc(k > 0 ? w.slice(0, k) : w), esc(k > 0 ? w.slice(k + 1) : "")); }
  if (c.lightSource === "era5")
    chk("note", "DATA", "Weather: ERA5 reanalysis, fetched for this site", `${esc(c.lightLabel)}. ${Math.abs(state.site.lon) <= 65 ? "Between about 65° W and 65° E the PVGIS service has satellite-based light data that follow clouds more closely than a reanalysis. Load it for a final design (Weather data → Use a PVGIS file)." : "Here PVGIS uses the same reanalysis, so its typical year differs only in which years were picked."} Light under shade as a share of open water barely depends on the weather data; daily light and the coral numbers do.`);
  const beamNote = `At ${state.depth} m the sun beam carries ${fmt(100 * (r.beamShare ?? 0), 0)} % of the light; the rest is scattered light from all directions.`
    + (D?.contrast ? ` Under dynamic shading the corals get ${pct(100 * D.contrast.noon)} of open-water light at midday and ${pct(100 * D.contrast.side)} in the morning and afternoon.` : "");
  if (D?.clearance) {
    const sunMin = Math.min(...D.pointSunHours), sunMax = Math.max(...D.pointSunHours);
    if (D.clearance.share > 0) chk("warn", "CHECK", `${pct(100 * D.clearance.share)} of the coral area never has the sun in line under dynamic shading`,
      `Dots on the plan view. A canopy about ${fmt(D.clearance.hRule, 1)} m above the corals would let the morning sun reach all of it on every day (most demanding day ${dstr(D.clearance.hRuleDay)}; at least ${fmt(D.clearance.hMin, 1)} m is needed for any full clearance). ${beamNote}`);
    else chk("ok", "OK", "Every part of the coral area has the sun in line each day",
      `Under dynamic shading the sun is in line with each part for ${fmt(sunMin, 1)}–${fmt(sunMax, 1)} hours a day, in the morning and afternoon: least in the middle, most at the edges. These hours are geometry only; clouds and scattering are not counted. ${beamNote}`);
  }
  if (D && D.panel.lx + 0.02 < state.target.lx)
    chk("warn", "CHECK", "The east and west ends of the coral area get little shade from dynamic shading", `The canopy (${fmt(D.panel.lx, 2)} m east–west) is narrower than the coral area (${fmt(state.target.lx, 1)} m east–west). Lay the coral area long north–south: the sun crosses from east to west, so the shade then spreads evenly.`);
  if (hasR) {
    const low = r.scenarios.filter((s) => F(s).prDaily! < 1), lowAdj = r.scenarios.filter((s) => s.bio.prDaily! < 1);
    if (lowAdj.length) chk("warn", "CHECK", `Energy balance below 1 even ${accl} (${lowAdj.map((s) => `${nameOf(s).toLowerCase()} P:R ${fmt(s.bio.prDaily!, 2)}`).join(", ")})`,
      `For ${esc(preset?.label ?? "this coral")}, modeled daily photosynthesis does not cover respiration under this much shade at ${state.depth} m. Less shade (see the ratings table) keeps more of a margin.${part && ext > 0 ? ` This uses the adjustment set under Which coral (${way}); with more adjustment the value is higher.` : ""}`);
    else if (two && low.length) chk("note", "NOTE", `In the first days the energy balance is below 1 (${low.map((s) => `${nameOf(s).toLowerCase()} P:R ${fmt(F(s).prDaily!, 2)}`).join(", ")}; unshaded ${fmt(oF.prDaily ?? NaN, 2)})`,
      `Until the corals adjust to the shade, modeled photosynthesis covers less than their respiration (${esc(preset?.label ?? "coral")}). Corals adjust to lower light over days and can also feed; whether a temporary deficit matters during heat stress is an open question. The ratings table shows the trade-off with less shade.`);
  }
  const rob = main.robustness, wr = main.w0Range;
  if (rob && wr) {
    const pick = (p: string) => rob.filter((x) => x.case.startsWith(p)).map((x) => 100 * x.T);
    const k = pick("Kd"), sh = pick("shifted");
    chk("note", "RANGE", `Light at the corals: ${pct(100 * main.T)} of unshaded, likely between ${fmt(100 * Math.min(...wr), 0)} and ${fmt(100 * Math.max(...wr), 0)} %`,
      `${nameOf(main)}. The range comes from how strongly the water scatters light sideways under the structure (ω₀ ${state.water.w0Lo}–${state.water.w0Hi}, ${({ default: "the span typical of coastal and reef waters, since it is rarely measured", reading: "from your field reading and its uncertainty", user: "as you set it" } as Record<string, string>)[ui.w0Source]}). Water clarity ±50 % changes it to ${fmt(Math.min(...k), 0)}–${fmt(Math.max(...k), 0)} %, and a structure 0.2 m off center to at most ${fmt(Math.max(...sh), 0)} %. ${ui.w0Source === "reading" ? "A second reading on another day checks it." : "One light reading under an opaque board narrows the range (Expert → Water scattering from a field reading)."}`);
  } else chk("note", "…", "Uncertainty range", "Computing…");
  for (const w of r.warnings) chk("warn", "NOTE", esc(w), "");
  chk("note", "FIELD", "Measure to confirm", "Light under and beside the structure at 09:00, noon and 15:00 shows how this water behaves. The field protocol is in the project's documentation.");
  const checksCard = `<div class="card"><h2>Checks before you build</h2>${checks.join("")}</div>`;

  // ------------------------------------------------------------ expert
  let expert = "";
  if (E) {
    // coral response
    const ec = main.bio.ec ?? 0;
    const hists = [{ name: "Open water", color: COLORS.open, dash: "4 3", values: r.open.lightHist },
      ...r.scenarios.map((s) => ({ name: nameOf(s), color: color(s), values: s.lightHist ?? [] }))];
    const Z = [["BelowEc", "Below compensation", "under Ec: respiration exceeds photosynthesis"], ["Limited", "Light-limited", hasR ? "Ec to Ek: below 76 % of Pmax" : "below Ek: below 76 % of Pmax"],
      ["NearSat", "Near saturation", "Ek to 2 Ek: 76–96 % of Pmax"], ["Saturated", "Saturated", "above 2 Ek: extra light adds little"]].filter((z) => hasR || z[0] !== "BelowEc");
    const zc = [{ name: "Open water", get: (k: string) => main.bio[`open${k}`] }, ...r.scenarios.map((s) => ({ name: nameOf(s), get: (k: string) => s.bio[k.charAt(0).toLowerCase() + k.slice(1)] }))];
    const zoneRows = Z.map(([k, lab, sub], zi) => `<tr><td><span class="sw" style="background:${ZONE_TINTS[hasR ? zi : zi + 1]}"></span>${lab}<br><span class="sub">${sub}</span></td>${zc.map((col) => {
      const h = col.get(`Hours${k}`) ?? 0, lt = col.get(`Light${k}`) ?? 0;
      const tot = Z.reduce((a, [kk]) => a + (col.get(`Light${kk}`) ?? 0), 0);
      return `<td>${fmt(h, 1)} h<br><span class="sub">${tot > 0 ? pct((100 * lt) / tot) : "–"} of light</span></td>`; }).join("")}</tr>`).join("");
    const coral = `<div class="card"><h2>Coral response ${info("coral")}</h2><p class="sub">Photosynthesis curve of ${esc(preset?.label ?? "")} (Ek ${fmt(main.ek, 0)} µmol m⁻² s⁻¹). Stepped lines: hours per day the corals spend at each light level, mean of all days.</p>
      <div class="pe">${peChart(main.ek, ec, hists, r.histMax)}</div>
      <div class="legend"><span><span class="key dash" style="border-color:${COLORS.open}"></span>Open water</span>${r.scenarios.map((s) => `<span><span class="key" style="border-color:${color(s)}"></span>${nameOf(s)}</span>`).join("")}</div>
      <div class="tscroll"><table class="t zones"><thead><tr><th>Time per day</th>${zc.map((col) => `<th>${col.name}</th>`).join("")}</tr></thead><tbody>${zoneRows}</tbody></table></div></div>`;
    // month by month
    const groups: { key: string; idx: number[] }[] = [];
    r.days.forEach((d, i) => { const key = `${MON[d[1] - 1]} ${d[0]}`; const g = groups[groups.length - 1]; if (g && g.key === key) g.idx.push(i); else groups.push({ key, idx: [i] }); });
    const sumAt = (a: number[], idx: number[]) => idx.reduce((x, i) => x + a[i]!, 0);
    const mrow = (label: string, idx: number[], cls = "") => `<tr${cls ? ` class="${cls}"` : ""}><td>${label}<br><span class="sub">${idx.length} days</span></td><td>${fmt(sumAt(r.open.dayDli, idx) / idx.length, 1)}</td>${r.scenarios.map((s) => {
      const dl = dayLight(s); const share = sumAt(dl, idx) / sumAt(r.open.dayDli, idx);
      return `<td>${fmt(sumAt(dl, idx) / idx.length, 1)}<br><span class="sub">${pct(100 * share)}</span></td><td>${pct(100 * mean(idx.map((i) => s.bioDaily.grossVsOpen[i]!)))}${s.bioDaily.prDaily ? `<br><span class="sub">P:R ${fmt(mean(idx.map((i) => s.bioDaily.prDaily![i]!)), 2)}</span>` : ""}</td>`; }).join("")}</tr>`;
    const monthly = `<div class="card"><h2>Month by month</h2><p class="sub">Daily light (mol m⁻² d⁻¹) with its share of open water, and photosynthesis as a share of unshaded${hasR ? " with the energy balance" : ""}. ${mode === "time" && ext > 0 ? "Corals adjust to the shade over the first days, so early values differ." : ""}</p>
      <div class="tscroll"><table class="t"><thead><tr><th>Month</th><th>Open water</th>${r.scenarios.map((s) => `<th>${dot(color(s))}${s.kind === "constant" ? "Constant" : "Dynamic"}: light</th><th>photosynthesis</th>`).join("")}</tr></thead>
      <tbody>${groups.map((g) => mrow(g.key, g.idx)).join("")}${groups.length > 1 ? mrow("Whole deployment", r.days.map((_, i) => i), "tot") : ""}</tbody></table></div></div>`;
    // sensitivity
    const pretty = (cs: string) => cs === "as designed" ? "As designed"
      : cs.startsWith("Kd x 0.5") ? `Clearer water${cs.includes("(") ? ` (Kd ${cs.match(/\(([\d.]+)/)?.[1]} m⁻¹)` : " (Kd × 0.5)"}`
      : cs.startsWith("Kd x 1.5") ? `More turbid water${cs.includes("(") ? ` (Kd ${cs.match(/\(([\d.]+)/)?.[1]} m⁻¹)` : " (Kd × 1.5)"}`
      : cs.startsWith("w0") ? `${+cs.slice(3) < state.water.w0 ? "Less" : "More"} scattering (ω₀ ${cs.slice(3)})`
      : cs.startsWith("wind 0") ? "Calm sea (no wind)" : cs.startsWith("wind") ? `Windy (${cs.match(/[\d.]+/)?.[0]} m s⁻¹)`
      : cs.startsWith("shifted") ? `Structure ${cs.match(/[\d.]+/)?.[0]} m off center to the ${cs.endsWith("east") ? "east" : "north"}` : cs;
    const sens = (s: ScenarioOut, i: number) => { const x = s.robustness?.[i]; if (!x) return "<td>…</td>"; const base = s.robustness![0]!.T, dl = 100 * (x.T - base);
      return `<td>${fmt(100 * x.T, 1)} %${i > 0 ? ` <span class="delta ${Math.abs(dl) >= 2 ? "big" : ""}">${Math.abs(dl) < 0.05 ? "±" : dl > 0 ? "+" : "−"}${fmt(Math.abs(dl), 1)}</span>` : ""}</td>`; };
    const nRows = (main.robustness ?? []).length;
    const sensitivity = `<div class="card"><h2>What if conditions differ? ${info("robust")}</h2><p class="sub">The same structures under other conditions: light over the deployment as a share of open water, and the change in percentage points.</p>
      <div class="tscroll"><table class="t"><thead><tr><th>Condition</th>${r.scenarios.map((s) => `<th>${dot(color(s))}${s.kind === "constant" ? "Constant" : "Dynamic"}</th>`).join("")}</tr></thead><tbody>
      ${nRows ? Array.from({ length: nRows }, (_, i) => `<tr><td>${esc(pretty(main.robustness![i]!.case))}</td>${r.scenarios.map((s) => sens(s, i)).join("")}</tr>`).join("") : `<tr><td colspan="${1 + r.scenarios.length}" class="wait">Computing…</td></tr>`}</tbody></table></div></div>`;
    expert += `<div class="grid2">${coral}${sensitivity}</div>${monthly}`;
    if (D) {
      const pts = lineChart([{ name: "Open water", x: r.minutes, y: r.open.dayCurves[di]!, color: COLORS.open, dash: "5 4" },
        { name: "Center", x: r.minutes, y: D.dayCurves.center[di]!, color: COLORS.ink }, { name: "East edge", x: r.minutes, y: D.dayCurves.east[di]!, color: COLORS.canopy },
        { name: "West edge", x: r.minutes, y: D.dayCurves.west[di]!, color: COLORS.sea, dash: "3 3" }], { ylab: "Light under dynamic shading (µmol m⁻² s⁻¹)", noon: r.noons[di], h: 250 });
      const ptsCard = `<div class="card"><h2>Points under dynamic shading, ${MON[dd[1] - 1]} ${dd[2]}</h2><p class="sub">The center and points near the east and west edges of the coral area. Pick the day in “Through the day”.</p>${pts}
        <div class="legend"><span><span class="key dash" style="border-color:${COLORS.open}"></span>Open water</span><span><span class="key" style="border-color:${COLORS.ink}"></span>Center</span><span><span class="key" style="border-color:${COLORS.canopy}"></span>East edge</span><span><span class="key dash" style="border-color:${COLORS.sea}"></span>West edge</span></div></div>`;
      const CO = r.canopyOptions;
      const coRows = !CO ? `<tr><td colspan="4" class="wait">Computing…</td></tr>` : CO.map((o) => `<tr class="${o.current ? "cur" : ""}"><td>${fmt(o.lx, 2)} × ${fmt(o.ly, 2)} m${o.current ? `<span class="pill">this plan</span>` : ""}</td>
        <td>${barCell(100 * o.T, 100, COLORS.canopy, pct(100 * o.T))}</td><td>${pct(100 * o.noon)}</td><td>${pct(100 * o.side)}</td></tr>`).join("");
      const canopyCard = `<div class="card"><h2>Other canopy widths ${info("canopy")}</h2><p class="sub">A wider canopy shades more and for longer around midday. Sizes are east–west × north–south; light is a share of open water, on a 10 cm grid.</p>
        <div class="tscroll"><table class="t opts"><thead><tr><th>Canopy size</th><th>Whole deployment</th><th>Midday</th><th>Morning,<br>afternoon</th></tr></thead><tbody>${coRows}</tbody></table></div></div>`;
      expert += `<div class="grid2">${ptsCard}${canopyCard}</div>`;
    }
  }

  // ------------------------------------------------------------ save and sources
  const save = `<div class="card"><h2>Save this plan</h2><p class="sub">The report holds everything on this page. The files hold the numbers behind it${E ? "" : " (more detail in Expert mode)"}.</p>
    <div class="exports"><button class="btn sea" data-export="report">Report (print or PDF)</button><button class="btn ghost" data-export="days">Daily summary (CSV)</button><button class="btn ghost" data-export="points">Daily light per point (CSV)</button><button class="btn ghost" data-export="inputs">Inputs (JSON)</button></div></div>`;
  const about = `<div class="card about"><h2>What this tool does, and what it does not ${info("accuracy")}</h2>
    <ul><li><b>It computes light.</b> Light at the corals under a shade cloth or an opaque canopy, every 10 minutes of every day of the deployment, from hourly weather data, refraction and waves at the sea surface, and scattering in the water. Photosynthesis follows from published light-response curves.</li>
    <li><b>It does not predict bleaching or survival.</b> Shading reduced bleaching in published trials, but how much shade a site needs is not settled, and temperature is not modeled here.</li>
    <li><b>It was checked</b> against an independent 3-D Monte Carlo light model: within about 2 to 4 % of open-water light for structures up to 2 m above the corals. The largest uncertainty is how strongly the water scatters light, shown as the “likely” range.</li></ul>
    <p class="sub">Version ${c.version}. Weather data: ${esc(c.lightLabel)}</p></div>`;

  return nb(`
    <div class="head"><h1>Shading plan for corals at ${fmt(state.depth, 1)} m</h1><p>${esc(state.site.name)}, ${MON[state.start[1] - 1]} ${state.start[2]} to ${MON[state.end[1] - 1]} ${state.end[2]} ${state.end[0]} (${nD} days${r.level === "preview" ? " sampled" : ""})</p>${stage}</div>
    <p class="lead">${lead}</p>
    ${kpiLegend}<div class="kpis">${kpis.join("")}</div>
    <div class="grid2 wide-left">${plan}${mapCard}</div>
    ${options}
    <div class="grid2">${dayCard}${seasonCard}</div>
    ${checksCard}${expert}
    <div class="grid2">${save}${about}</div>`);
}
