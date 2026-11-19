import { readFileSync } from "node:fs";
import { lightFromJson } from "../src/core/surface.ts";
import { compute, computeRobustness, type Inputs } from "../src/ui/compute.ts";
const T = JSON.parse(readFileSync(new URL("../../shared/tables/light_tables.json", import.meta.url), "utf8"));
const EX = JSON.parse(readFileSync(new URL("../../shared/examples/sipaway.json", import.meta.url), "utf8"));
const P = JSON.parse(readFileSync(new URL("../../shared/corals/pe_presets.json", import.meta.url), "utf8"));
const data = { tables: T, presets: P, light: lightFromJson(EX.light) };
const inp: Inputs = { site: { name: "Sipaway", lat: EX.lat, lon: EX.lon, tz: EX.utc_offset_h }, start: [2025, 4, 28], end: [2025, 8, 8],
  target: { shape: "circle", lx: 1.1, ly: 1.1 }, depth: 10, height: 0.75, water: { kd: 0.10, w0: 0.7, w0Lo: 0.5, w0Hi: 0.9 }, scenario: "both", sync: true,
  clothRating: 80, dynamicTargetReduction: 75, canopy: null, clothSize: null, noonShift: 0, wind: null,
  coral: { preset: "typical", acclimate: "time" }, gridSpacing: 0.05 };
let g: number | undefined;
for (const lev of ["preview", "preview", "preview", "full"] as const) {
  const r = compute(inp, data, lev, g); g = r.scenarios[1]?.panel.lx;
  console.log(lev, r.ms.toFixed(0), "ms", r.points.length / 2, "pts", r.days.length, "days", r.scenarios.map((s) => `${s.kind} T=${s.T.toFixed(4)} ${s.panel.lx.toFixed(2)}x${s.panel.ly.toFixed(2)}`).join(" | "), r.warnings.length, JSON.stringify(Object.fromEntries(Object.entries(r.timings).map(([k, v]) => [k, Math.round(v)]))));
}
{ const r = compute(inp, data, "full", g); const t0 = performance.now(); const rob = computeRobustness(inp, data, { constant: r.scenarios[0]!.panel, dynamic: r.scenarios[1]!.panel }); console.log("robust only", (performance.now() - t0).toFixed(0), "ms", rob.dynamic!.rows.map((x) => x.T.toFixed(3)).join(" "), "range", rob.dynamic!.range.map((x) => x.toFixed(3)).join("-")); }
