import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import type { Tables } from "../src/core/engine.ts";
import { lightFromJson } from "../src/core/surface.ts";
import { type Day, type Site, deploymentDays, constantScenario, solveDynamic, runPeriod, transmission, directSunHours,
  dliPerDay, clearanceCheck, robustness, biology, beamShare, noonContrast, contrastWarning } from "../src/core/scenarios.ts";
import { type PresetFile, coralFromPreset, summarize } from "../src/core/pe.ts";
import { targetGrid } from "../src/core/geometry.ts";

const T: Tables = JSON.parse(readFileSync(new URL("../../shared/tables/light_tables.json", import.meta.url), "utf8"));
const G = JSON.parse(readFileSync(new URL("../../shared/golden/scenarios.json", import.meta.url), "utf8"));
const EX = JSON.parse(readFileSync(new URL("../../shared/examples/sipaway.json", import.meta.url), "utf8"));
const PR: PresetFile = JSON.parse(readFileSync(new URL("../../shared/corals/pe_presets.json", import.meta.url), "utf8"));
const close = (a: number, b: number, tol = 1e-9) => Math.abs(a - b) <= tol * Math.max(1, Math.abs(b));
const camel = (k: string) => k.replace(/_([a-z])/g, (_, c: string) => c.toUpperCase()).replace(/Ek$/, "Ek");

test("scenario layer reproduces the Python reference (Sipaway)", () => {
  const site: Site = { lat: EX.lat, lon: EX.lon, tz: EX.utc_offset_h, light: lightFromJson(EX.light) };
  const days = deploymentDays([2025, 4, 28], [2025, 5, 6], 4);
  assert.deepEqual(days, G.days as Day[]);
  const water = { kd: G.water.kd, w0: G.water.w0, depth: G.water.depth };
  const tgt = { shape: "circle" as const, lx: 1.1, ly: 1.1 };
  const cs = constantScenario(site, water, tgt, 0.75, days, T, 0.21, 0.147, 0.3, undefined, 0.2);
  assert.ok(close(cs.panel.lx, G.cloth.lx) && close(cs.panel.ly, G.cloth.ly), "cloth size");
  const Tc = transmission(cs.result);
  assert.ok(close(Tc, G.T_constant), `T_constant ${Tc} vs ${G.T_constant}`);
  dliPerDay(cs.result)[0]!.forEach((v, i) => assert.ok(close(v, G.dli_constant_day0[i]), `dli ${i}`));
  const sol = solveDynamic(site, water, tgt, 0.75, days, T, Tc, { spacing: 0.2, solveEvery: 1 });
  assert.equal(sol.iterations, G.solve.iterations);
  assert.ok(close(sol.panel.lx, G.solve.lx) && close(sol.panel.ly, G.solve.ly) && close(sol.transmission, G.solve.T), "solve");
  const pts = targetGrid(tgt, 0.2);
  const dyn = runPeriod(site, water, [sol.panel], pts, days, T);
  assert.ok(close(transmission(dyn), G.T_dynamic_full));
  directSunHours(dyn)[0]!.forEach((v, i) => assert.ok(close(v, G.direct_hours_day0[i]), `sun hours ${i}`));
  const chk = clearanceCheck(dyn, tgt, 0.75, site);
  assert.ok(close(chk.shareNeverSunlit, G.clearance.share) && close(chk.hForSunBy0800ShadeFrom1000, G.clearance.h_rule) && close(chk.hMinAny, G.clearance.h_min));
  assert.deepEqual(chk.hRuleDay, G.clearance.h_rule_day);
  assert.ok(close(beamShare(dyn), G.beam_share), `beam share ${beamShare(dyn)} vs ${G.beam_share}`);
  for (const [k, res] of [["contrast_dynamic", noonContrast(dyn, site)], ["contrast_constant", noonContrast(cs.result, site)]] as const)
    for (const f of ["noon", "side", "ratio"] as const) assert.ok(close(res[f], G[k][f]), `${k} ${f}: ${res[f]} vs ${G[k][f]}`);
  assert.equal(contrastWarning(noonContrast(dyn, site), beamShare(dyn), water.depth), G.contrast_warning);
  const W = G.contrast_warning_example;
  assert.equal(contrastWarning(W.contrast, W.beam, W.depth), W.text);
  const rob = robustness(site, water, [sol.panel], pts, days.slice(0, 2), T, 16, [0.5, 1.5], [0.5, 0.9], [0, 10], 0.2, 1);
  rob.forEach((r, i) => assert.ok(close(r.T, G.robustness[i].T), `robustness ${r.case}`));
  for (const c of Object.values(G.corals) as any[]) {
    const b = biology(dyn, coralFromPreset(PR, c.id, c.acclimate));
    c.ek.forEach((v: number, i: number) => assert.ok(close(b.ek[i]!, v), `${c.id} ${c.acclimate} ek`));
    for (const [k0, v] of Object.entries(c.mean)) { const k = camel(k0).replace(/AboveEk$/, "AboveEk").replace(/aboveEk$/, "AboveEk"); assert.ok(close(b.mean[k]!, v as number), `${c.id} ${c.acclimate} ${k}: ${b.mean[k]} vs ${v}`); }
  }
  const s = summarize(dliPerDay(dyn)[0]!);
  for (const k of ["mean", "min", "max", "p10", "p90"] as const) assert.ok(close(s[k], G.summary_day0[k]), `summary ${k}`);
});

test("v5.1: fouling timeline, Kd by date, tide, acclimation over time and w0 calibration reproduce Python", async () => {
  const { constantScenario, runPeriod, transmission, dliPerDay, dliOpenPerDay, directSunHours, robustness, biology, beamShare, w0FromReading,
    deploymentDays } = await import("../src/core/scenarios.ts");
  const { tauByDay } = await import("../src/core/conditions.ts");
  const V = G.v51;
  const site: Site = { lat: EX.lat, lon: EX.lon, tz: EX.utc_offset_h, light: lightFromJson(EX.light) };
  const days = deploymentDays([2025, 4, 28], [2025, 5, 6], 4);
  const water = { kd: G.water.kd, w0: G.water.w0, depth: G.water.depth };
  const tgt = { shape: "circle" as const, lx: 1.1, ly: 1.1 }, pts = targetGrid(tgt, 0.2);
  // fouling
  const F = V.fouling, foul = { tauClean: F.tau_clean, tauFouled: F.tau_fouled, daysToFoul: F.days_to_foul, cleanEvery: F.clean_every, cleanDates: F.clean_dates };
  tauByDay(foul, days).forEach((t: number, i: number) => assert.ok(close(t, F.tau_days[i]), `tau day ${i}`));
  const cf = constantScenario(site, water, tgt, 0.75, days, T, 0.21, undefined, 0, undefined, 0.2, 16, undefined, foul);
  assert.ok(close(transmission(cf.result), F.T), `fouling T ${transmission(cf.result)} vs ${F.T}`);
  dliPerDay(cf.result)[1]!.forEach((v, i) => assert.ok(close(v, F.dli_day1[i]), `fouling dli ${i}`));
  directSunHours(cf.result)[1]!.forEach((v, i) => assert.ok(close(v, F.sun_day1[i]), `fouling sun ${i}`));
  robustness(site, water, [cf.panel], pts, days.slice(0, 2), T, 16, [0.5, 1.5], [0.5, 0.9], [0, 10], 0.2, 1, cf.tauDays!.slice(0, 2))
    .forEach((r, i) => assert.ok(r.case === F.robustness[i].case && close(r.T, F.robustness[i].T), `fouling robustness ${r.case}`));
  // Kd by date and tide
  const sv: Site = { ...site, kdSeries: new Map(V.kd_series.map(([d, v]: [number[], number]) => [`${d[0]}-${d[1]}-${d[2]}`, v])),
    tide: { tLocal: Float64Array.from(V.tide.t_local), level: Float64Array.from(V.tide.level) } };
  sv.tideRef = (await import("../src/core/scenarios.ts")).tideReference(sv.tide!, days[0]!, days[days.length - 1]!);
  assert.ok(close(sv.tideRef, V.tide.ref), "tide reference");
  const sol = { lx: G.solve.lx, ly: G.solve.ly, cx: 0, cy: 0, height: 0.75, tau: 0, rotDeg: 0 };
  const v = runPeriod(sv, water, [sol], pts, days, T);
  assert.ok(close(transmission(v), V.var.T), `varying T ${transmission(v)} vs ${V.var.T}`);
  dliOpenPerDay(v).forEach((x, i) => assert.ok(close(x, V.var.dli_open[i]), `varying open ${i}`));
  dliPerDay(v)[0]!.forEach((x, i) => assert.ok(close(x, V.var.dli_day0[i]), `varying dli ${i}`));
  v.kdDays!.forEach((x, i) => assert.ok(close(x, V.var.kd_days[i]), `kd day ${i}`));
  v.depthSteps![0]!.forEach((x, i) => assert.ok(close(x, V.var.depth_day0[i]), `depth step ${i}`));
  assert.ok(close(beamShare(v), V.var.beam_share), "varying beam share");
  const VS = V.var_surface, fp = { ...VS.panel, rotDeg: VS.panel.rot_deg };
  const v2 = runPeriod(sv, VS.water, [fp], pts, days.slice(0, 1), T);
  dliPerDay(v2)[0]!.forEach((x, i) => assert.ok(close(x, VS.dli_day0[i]), `surface panel dli ${i}: ${x} vs ${VS.dli_day0[i]}`));
  directSunHours(v2)[0]!.forEach((x, i) => assert.ok(close(x, VS.sunlit_day0[i]), `surface panel sun ${i}`));
  // acclimation over time
  const dyn = runPeriod(site, water, [sol], pts, days, T);
  const bt = biology(dyn, coralFromPreset(PR, "typical", "time"));
  V.acclimation_time.ek.forEach((x: number, i: number) => assert.ok(close(bt.ek[i]!, x), `ek mean ${i}`));
  V.acclimation_time.ek_day2.forEach((x: number, i: number) => assert.ok(close(bt.ekDays[2]![i]!, x), `ek day 2 ${i}`));
  for (const [k0, x] of Object.entries(V.acclimation_time.mean)) { const k = camel(k0); assert.ok(close(bt.mean[k]!, x as number), `time ${k}`); }
  // partial adjustment (extent 0.25): over time, static, and extent 0 (which equals "site")
  const AP = V.acclimation_partial;
  const bp = biology(dyn, coralFromPreset(PR, "typical", "time", AP.extent));
  AP.ek.forEach((x: number, i: number) => assert.ok(close(bp.ek[i]!, x), `partial ek mean ${i}`));
  AP.ek_day2.forEach((x: number, i: number) => assert.ok(close(bp.ekDays[2]![i]!, x), `partial ek day 2 ${i}`));
  for (const [k0, x] of Object.entries(AP.mean)) { const k = camel(k0); assert.ok(close(bp.mean[k]!, x as number), `partial ${k}`); }
  const bps = biology(dyn, coralFromPreset(PR, "typical", "shade", AP.extent));
  AP.shade_ek.forEach((x: number, i: number) => assert.ok(close(bps.ek[i]!, x), `partial shade ek ${i}`));
  for (const [k0, x] of Object.entries(AP.shade_mean)) { const k = camel(k0); assert.ok(close(bps.mean[k]!, x as number), `partial shade ${k}`); }
  const b0 = biology(dyn, coralFromPreset(PR, "typical", "time", 0)), bs = biology(dyn, coralFromPreset(PR, "typical", "site"));
  for (const [k0, x] of Object.entries(AP.none_mean)) { const k = camel(k0); assert.ok(close(b0.mean[k]!, x as number) && b0.mean[k] === bs.mean[k], `extent 0 ${k}`); }
  // w0 calibration
  const C = V.calibration, cp = { ...C.panel, rotDeg: C.panel.rot_deg };
  for (const [res, ds, w] of [[C.result, C.diffuse, C.wind], [C.result_wind, 0.25, 6.0]] as const) {
    const r = w0FromReading(T, C.ratio, cp, C.point, C.kd, C.depth, C.date, C.minute, EX.lat, EX.lon, EX.utc_offset_h, ds, w);
    assert.ok(r.status === res.status && close(r.w0, res.w0) && close(r.ratioMin, res.ratio_min) && close(r.ratioMax, res.ratio_max), `calibration ${r.w0} vs ${res.w0}`);
  }
});
