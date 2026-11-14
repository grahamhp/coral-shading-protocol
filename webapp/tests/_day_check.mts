
import { readFileSync, writeFileSync } from "node:fs";
import { lightFromJson } from "../src/core/surface.ts";
import { compute, type Inputs } from "../src/ui/compute.ts";
const T = JSON.parse(readFileSync(new URL("../../shared/tables/light_tables.json", import.meta.url), "utf8"));
const EX = JSON.parse(readFileSync(new URL("../../shared/examples/sipaway.json", import.meta.url), "utf8"));
const P = JSON.parse(readFileSync(new URL("../../shared/corals/pe_presets.json", import.meta.url), "utf8"));
const data = { tables: T, presets: P, light: lightFromJson(EX.light) };
const depth = Number(process.argv[2] ?? 3), kd = Number(process.argv[3] ?? 0.10);
const inp: Inputs = { site: { name: "Sipaway", lat: EX.lat, lon: EX.lon, tz: EX.utc_offset_h }, start: [2025, 4, 30], end: [2025, 8, 8],
  target: { shape: "circle", lx: 1.1, ly: 1.1 }, depth, height: 0.75, water: { kd, w0: 0.7 }, scenario: "both", sync: true,
  clothRating: Number(process.argv[5] ?? 80), dynamicTargetReduction: 75, canopy: null, clothSize: null, noonShift: 0, wind: null,
  coral: { preset: "typical", acclimate: "site" }, gridSpacing: 0.05 };
const r = compute(inp, data, "full");
const out = { depth, kd, minutes: r.minutes, open: r.open.dayCurve, openDayDli: r.open.dayDli, openDliMean: r.open.dliMean, noon: r.noon,
  days: r.days, scen: r.scenarios.map((s) => ({ kind: s.kind, T: s.T, dliMean: s.dliMean, lx: s.panel.lx, ly: s.panel.ly, tau: s.panel.tau,
  mean: s.dayCurve.mean, center: s.dayCurve.center, dayRed: s.dayReduction.map((d) => d.mean) })) };
writeFileSync(process.argv[4] ?? "day_check.json", JSON.stringify(out));
console.log("done", r.ms.toFixed(0), "ms", r.scenarios.map((s) => `${s.kind} T=${s.T.toFixed(4)} ${s.panel.lx.toFixed(2)}x${s.panel.ly.toFixed(2)}`).join(" | "));
