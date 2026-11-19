import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { type Tables, opticalState, panelMoments, runDay } from "../src/core/engine.ts";
import { panel } from "../src/core/geometry.ts";
import type { DayLight } from "../src/core/surface.ts";

const T: Tables = JSON.parse(readFileSync(new URL("../../shared/tables/light_tables.json", import.meta.url), "utf8"));
const G = JSON.parse(readFileSync(new URL("../../shared/golden/engine.json", import.meta.url), "utf8"));
const close = (a: number, b: number, tol = 1e-9) => Math.abs(a - b) <= tol * Math.max(1, Math.abs(b));

const toDay = (d: any): DayLight => ({
  minutes: Float64Array.from(d.minutes), step: d.step, zenith: Float64Array.from(d.zenith), azimuth: Float64Array.from(d.azimuth),
  parDirectH: Float64Array.from(d.par_direct_h), parDiffuse: Float64Array.from(d.par_diffuse),
  wind: Float64Array.from(d.wind, (v: number | null) => (v === null ? NaN : v)),
});

test("fast engine reproduces the Python reference", () => {
  assert.ok(G.cases.length >= 5);
  for (const c of G.cases) {
    const water = { kd: c.water.kd, w0: c.water.w0, depth: c.water.depth };
    const panels = c.panels.map((p: any) => panel({ cx: p.cx, cy: p.cy, lx: p.lx, ly: p.ly, height: p.height, tau: p.tau, rotDeg: p.rot_deg }));
    const pts = new Float64Array(c.px.length * 2);
    c.px.forEach((x: number, i: number) => { pts[2 * i] = x; pts[2 * i + 1] = c.py[i]; });
    const st = opticalState(water, T);
    assert.ok(close(st.tau, c.tau, 1e-10), `${c.name} tau ${st.tau} vs ${c.tau}`);
    const mom = panelMoments(pts, panels, water, st.thetaEdges, T.m_max);
    c.C0_first.forEach((v: number, i: number) => assert.ok(close(mom.C[0]![i]!, v, 1e-10), `${c.name} C0[${i}]`));
    c.S1_first.forEach((v: number, i: number) => assert.ok(close(mom.S[1]![i]!, v, 1e-10), `${c.name} S1[${i}]`));
    const r = runDay(toDay(c.day), water, panels, pts, st, mom, c.n_facets);
    c.ed_open.forEach((v: number, k: number) => assert.ok(close(r.edOpen[k]!, v), `${c.name} edOpen[${k}]`));
    c.beam_open.forEach((v: number, k: number) => assert.ok(close(r.beamOpen[k]!, v), `${c.name} beamOpen[${k}]`));
    c.ed.forEach((row: number[], k: number) => row.forEach((v, p) => assert.ok(close(r.ed[k]![p]!, v), `${c.name} ed[${k}][${p}] ${r.ed[k]![p]} vs ${v}`)));
    c.sunlit.forEach((row: number[], k: number) => row.forEach((v, p) => assert.ok(close(r.sunlit[k]![p]!, v), `${c.name} sunlit[${k}][${p}]`)));
  }
});
