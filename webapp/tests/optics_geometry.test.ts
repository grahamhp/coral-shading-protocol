import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { refractedZenithDeg, fresnelT, skyTransmittance, unitFacets, refractedSunRays } from "../src/core/optics.ts";
import { panel, targetGrid, rayHitXY, transmissionAlong } from "../src/core/geometry.ts";

const G = JSON.parse(readFileSync(new URL("../../shared/golden/optics.json", import.meta.url), "utf8"));
const close = (a: number, b: number, tol = 1e-9) => Math.abs(a - b) <= tol * Math.max(1, Math.abs(b));

test("refraction, Fresnel and sky transmittance match Python", () => {
  for (const c of G.refracted) assert.ok(close(refractedZenithDeg(c.z), c.w));
  for (const c of G.fresnel) assert.ok(close(fresnelT(c.c), c.t));
  assert.ok(close(skyTransmittance(), G.sky));
});

test("deterministic wave facets match Python", () => {
  const f = unitFacets(16);
  G.facets.forEach((v: number, i: number) => assert.ok(close(f[i]!, v, 1e-12)));
});

test("refracted sun rays match Python", () => {
  for (const c of G.rays) {
    const r = refractedSunRays(c.z, c.a, c.u, c.n);
    assert.equal(r.n * 3, c.dirs.length);
    c.dirs.forEach((v: number, i: number) => assert.ok(close(r.dirs[i]!, v), `dir ${i}`));
    c.w.forEach((v: number, i: number) => assert.ok(close(r.weights[i]!, v), `w ${i}`));
    assert.ok(close(r.transmittance, c.tot));
  }
});

test("target grids match Python", () => {
  for (const c of G.grids) {
    const g = targetGrid({ shape: c.shape, lx: c.lx, ly: c.ly }, c.spacing);
    assert.equal(g.length / 2, c.n);
    let sx = 0, sy = 0;
    for (let i = 0; i < g.length; i += 2) { sx += g[i]!; sy += g[i + 1]!; }
    assert.ok(close(sx, c.sx, 1e-9) && close(sy, c.sy, 1e-9));
    c.xs.forEach((v: number, i: number) => assert.ok(close(g[2 * i]!, v) && close(g[2 * i + 1]!, c.ys[i])));
  }
});

test("ray hits and panel transmission match Python", () => {
  const ps = G.panels.map((p: any) => panel({ cx: p.cx, cy: p.cy, lx: p.lx, ly: p.ly, height: p.height, tau: p.tau, rotDeg: p.rot_deg }));
  for (const c of G.trans) {
    const [ux, uy, uz] = c.up;
    assert.ok(close(transmissionAlong(c.px, c.py, ux, uy, uz, ps, c.depth), c.t), JSON.stringify(c));
    const [hx, hy, ok] = rayHitXY(c.px, c.py, ux, uy, uz, ps[2].height, c.depth);
    assert.equal(ok, c.ok);
    assert.ok(close(hx, c.hx) && close(hy, c.hy));
  }
});
