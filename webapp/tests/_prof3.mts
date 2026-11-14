import { readFileSync } from "node:fs";
import { lightFromJson } from "../src/core/surface.ts";
import { opticalState, panelMoments } from "../src/core/engine.ts";
import { targetGrid, panel } from "../src/core/geometry.ts";
import { deploymentDays, constantScenario, solveDynamic, runPeriod, biology, defaultCloth, canopyNsSize } from "../src/core/scenarios.ts";
import { coralFromPreset } from "../src/core/pe.ts";
const T = JSON.parse(readFileSync(new URL("../../shared/tables/light_tables.json", import.meta.url), "utf8"));
const EX = JSON.parse(readFileSync(new URL("../../shared/examples/sipaway.json", import.meta.url), "utf8"));
const P = JSON.parse(readFileSync(new URL("../../shared/corals/pe_presets.json", import.meta.url), "utf8"));
const site = { lat: EX.lat, lon: EX.lon, tz: EX.utc_offset_h, light: lightFromJson(EX.light), noonShift: 0, step: 10 };
const water = { kd: 0.10, w0: 0.7, depth: 10 }; const tgt = { shape: "circle" as const, lx: 1.1, ly: 1.1 };
const days = deploymentDays([2025, 4, 28], [2025, 8, 8], 7);
const tm = (lab: string, f: () => any) => { const t0 = performance.now(); const r = f(); console.log(lab, (performance.now() - t0).toFixed(1), "ms"); return r; };
const st = tm("opticalState", () => opticalState(water, T));
tm("opticalState again", () => opticalState(water, T));
const pts = targetGrid(tgt, 0.1);
const cl = tm("defaultCloth", () => defaultCloth(tgt, 0.75, site, days, 0.2));
tm("panelMoments 97", () => panelMoments(pts, [cl], water, st.thetaEdges, 4));
tm("runPeriod cloth (incl dayLight)", () => runPeriod(site, water, [cl], pts, days, T, 8, undefined, st));
tm("runPeriod cloth again", () => runPeriod(site, water, [cl], pts, days, T, 8, undefined, st));
tm("canopyNs", () => canopyNsSize(tgt, 0.75, site, days));
const s = tm("solveDynamic", () => solveDynamic(site, water, tgt, 0.75, days, T, 0.25, { spacing: 0.1, nFacets: 8, solveEvery: 1 }));
console.log("iters", s.iterations);
const r = runPeriod(site, water, [s.panel], pts, days, T, 8, undefined, st);
tm("biology site", () => biology(r, coralFromPreset(P, "typical", "site")));

import { runDay } from "../src/core/engine.ts";
import { dayLight } from "../src/core/surface.ts";
const dl = dayLight(site.light, 2025, 4, 28, site.lat, site.lon, site.tz, 10, 0);
const mom = panelMoments(pts, [cl], water, st.thetaEdges, 4);
for (const nf of [8, 16]) { const t0 = performance.now(); for (let k = 0; k < 20; k++) runDay(dl, water, [cl], pts, st, mom, nf); console.log("runDay x20 nf", nf, (performance.now() - t0).toFixed(1), "ms"); }
const mom0 = panelMoments(pts, [], water, st.thetaEdges, 4);
{ const t0 = performance.now(); for (let k = 0; k < 20; k++) runDay(dl, water, [], pts, st, mom0, 8); console.log("runDay x20 open", (performance.now() - t0).toFixed(1), "ms"); }
