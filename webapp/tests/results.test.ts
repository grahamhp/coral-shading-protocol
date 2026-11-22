// The results page is built from computed results without a browser: run the pipeline on the example site and check
// what the page says (quick preview resolution; the numbers themselves are covered by the golden tests).
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { lightFromJson } from "../src/core/surface.ts";
import { compute, computeRobustness, computeClothOptions, type Inputs, type Data } from "../src/ui/compute.ts";
import { resultsHtml, type Ctx } from "../src/ui/results.ts";
import { stages } from "../src/ui/runner.ts";

const read = (p: string) => JSON.parse(readFileSync(new URL(`../../shared/${p}`, import.meta.url), "utf8"));
const EX = read("examples/sipaway.json");
const data: Data = { tables: read("tables/light_tables.json"), presets: read("corals/pe_presets.json"), light: lightFromJson(EX.light) };
const base: Inputs = {
  site: { name: EX.name, lat: EX.lat, lon: EX.lon, tz: EX.utc_offset_h }, start: [2025, 4, 28], end: [2025, 5, 12],
  target: { shape: "circle", lx: 1.1, ly: 1.1 }, depth: 10, height: 0.75, water: { kd: 0.1, w0: 0.7, w0Lo: 0.5, w0Hi: 0.9 },
  scenario: "both", sync: true, clothRating: 80, dynamicTargetReduction: 75, clothSize: null, canopy: null,
  noonShift: 0, wind: null, coral: { preset: "typical", acclimate: "time" }, gridSpacing: 0.1, fouling: null, kdSeriesText: null, tideText: null,
};
const ctx = (state: Inputs, r: ReturnType<typeof compute>, expert: boolean): Ctx => ({ state, r, expert, version: "test",
  ui: { day: null, dayMode: "mean", w0Source: "default", clothAuto: true, lightKind: "tmy" }, lightLabel: "test light", lightSource: "example",
  presets: (data.presets as any).presets, info: () => "" });

test("simple and expert pages render from a full run, with the shade-rating comparison", () => {
  const r = compute(base, data, "full");
  r.clothOptions = computeClothOptions(base);
  const rob = computeRobustness(base, data, { constant: r.scenarios[0]!.panel, dynamic: r.scenarios[1]!.panel });
  for (const s of r.scenarios) { s.robustness = rob[s.kind]!.rows; s.w0Range = rob[s.kind]!.range; }
  const O = r.clothOptions!;
  assert.deepEqual(O.map((o) => o.rating), [30, 50, 70, 80, 90]);
  const cur = O.find((o) => o.current)!, C = r.scenarios[0]!;
  // the comparison's row for the plan's own rating reproduces the plan (light is linear in the cloth's transmission)
  assert.ok(Math.abs(cur.T - C.T) < 1e-9 && Math.abs(cur.dliMean - C.dliMean) < 1e-9 && Math.abs(cur.grossVsOpen - C.bio.grossVsOpen!) < 1e-9);
  assert.ok(Math.abs(cur.first!.prDaily! - C.bioFirst!.prDaily!) < 1e-9);
  // less shade: more light, and more photosynthesis before the corals adjust
  for (let i = 1; i < O.length; i++) assert.ok(O[i]!.T < O[i - 1]!.T && O[i]!.first!.grossVsOpen < O[i - 1]!.first!.grossVsOpen);
  // a 30 % cloth lets through 70 % itself; with side light the corals get at least that
  assert.ok(O[0]!.T > 0.7 && O[0]!.T < 0.8);
  for (const expert of [false, true]) {
    const html = resultsHtml(ctx(base, r, expert));
    assert.ok(!/NaN|undefined|\[object/.test(html), "no broken values");
    for (const need of ["The plan at a glance", "How much shade?", "Through the day", "Through the deployment", "Checks before you build", "this plan", "first days"])
      assert.ok(html.includes(need), need);
    assert.equal(html.includes("Month by month"), expert);
    assert.equal(html.includes("What if conditions differ?"), expert);
    assert.ok(!html.includes("—"), "no em dashes in the interface text");
  }
});

test("one kind of shading, a coral without respiration data and a preview all render", () => {
  for (const [scenario, preset] of [["constant", "typical"], ["dynamic", "porites_lobata"]] as const) {
    const inp: Inputs = { ...base, scenario, coral: { preset, acclimate: "time" } };
    const r = compute(inp, data, "preview");
    const html = resultsHtml(ctx(inp, r, true));
    assert.ok(!/NaN|undefined|\[object/.test(html), `${scenario} ${preset}`);
    assert.equal(html.includes("How much shade?"), scenario === "constant");
    assert.equal(html.includes("Energy balance (P:R)"), preset === "typical");
  }
});

test("the calculation stages give the same plan with or without a background worker", () => {
  // the worker and the page (where a worker is refused) both walk these stages; the last one is the finished result
  const levels: string[] = [];
  let lastR: ReturnType<typeof compute> | null = null;
  for (const r of stages({ type: "run", id: 1, inputs: base, full: true, expert: false }, data)) { levels.push(r.level); lastR = r; }
  assert.deepEqual(levels, ["preview", "full", "full", "robust"]);
  const direct = compute(base, data, "full", compute(base, data, "preview").scenarios[1]!.panel.lx);
  for (const k of [0, 1]) {
    assert.equal(lastR!.scenarios[k]!.panel.lx, direct.scenarios[k]!.panel.lx);
    assert.equal(lastR!.scenarios[k]!.T, direct.scenarios[k]!.T);
    assert.ok(lastR!.scenarios[k]!.robustness!.length > 0);
  }
  assert.equal(lastR!.clothOptions!.length, 5);
});

test("how far the corals adjust: none equals the first days, and more adjustment gives more photosynthesis under the shade", () => {
  const run = (extent: number) => compute({ ...base, coral: { ...base.coral, extent } }, data, "preview");
  const r0 = run(0), r25 = run(0.25), r100 = run(1), rDef = compute(base, data, "preview");
  const C = (r: ReturnType<typeof compute>) => r.scenarios[0]!;
  // the light and the structure do not depend on the coral
  assert.equal(C(r25).T, C(r100).T); assert.equal(C(r25).panel.lx, C(r100).panel.lx);
  // an absent extent means full adjustment (plans saved before v5.2)
  assert.equal(C(rDef).bio.prDaily, C(r100).bio.prDaily);
  // no adjustment: one set of coral values, equal to the first-days values of the other runs
  assert.equal(C(r0).bioFirst, null);
  assert.ok(Math.abs(C(r0).bio.prDaily! - C(r25).bioFirst!.prDaily!) < 1e-12);
  assert.ok(Math.abs(C(r25).bioFirst!.prDaily! - C(r100).bioFirst!.prDaily!) < 1e-12);
  // more adjustment, more photosynthesis under the shade
  assert.ok(C(r0).bio.prDaily! < C(r25).bio.prDaily! && C(r25).bio.prDaily! < C(r100).bio.prDaily!);
  assert.ok(C(r0).bio.grossVsOpen! < C(r25).bio.grossVsOpen! && C(r25).bio.grossVsOpen! < C(r100).bio.grossVsOpen!);
  // the page says how far
  const st = { ...base, coral: { ...base.coral, extent: 0.25 } };
  const html = resultsHtml(ctx(st, r25, false));
  assert.ok(/25\s% of the way to the shade/.test(html) && !/NaN|undefined|\[object/.test(html));   // the page keeps number and % together
  assert.ok(!resultsHtml(ctx({ ...base, coral: { ...base.coral, extent: 0 } }, r0, false)).includes("first days"));
});
