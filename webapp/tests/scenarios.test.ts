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
