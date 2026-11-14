import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { lightFromJson, clearSkyLight, dayLight, distanceKm } from "../src/core/surface.ts";

const G = JSON.parse(readFileSync(new URL("../../shared/golden/surface.json", import.meta.url), "utf8"));
const EX = JSON.parse(readFileSync(new URL("../../shared/examples/sipaway.json", import.meta.url), "utf8"));
const close = (a: number, b: number, tol = 1e-9) => Math.abs(a - b) <= tol * Math.max(1, Math.abs(b));

test("clear-sky typical year matches Python", () => {
  const c = G.clear_sky, cs = clearSkyLight(c.lat, c.lon);
  c.days.forEach((k: number, i: number) => {
    for (let h = 0; h < 24; h++) {
      assert.ok(close(cs.ghi[k * 24 + h]!, c.ghi[i][h]), `ghi day ${k} hour ${h}: ${cs.ghi[k * 24 + h]} vs ${c.ghi[i][h]}`);
      assert.ok(close(cs.dhi[k * 24 + h]!, c.dhi[i][h]), `dhi day ${k} hour ${h}`);
    }
  });
  assert.ok(close(cs.ghi.reduce((a, b) => a + b, 0), c.ghi_sum) && close(cs.dhi.reduce((a, b) => a + b, 0), c.dhi_sum));
});

test("day light and timing guard match Python", () => {
  const ex = lightFromJson(EX.light), cs = clearSkyLight(G.clear_sky.lat, G.clear_sky.lon);
  for (const c of G.days) {
    const dl = dayLight(c.light === "example" ? ex : cs, c.y, c.m, c.d, c.lat, c.lon, c.tz);
    for (let i = 0; i < c.par_direct_h.length; i++) {
      assert.ok(close(dl.parDirectH[i]!, c.par_direct_h[i]) && close(dl.parDiffuse[i]!, c.par_diffuse[i]), `${c.name} step ${i}`);
    }
    assert.ok(close(dl.lightTotal!, c.light_total) && close(dl.lightDropped!, c.light_dropped), `${c.name} totals`);
  }
  const far = G.days.find((c: any) => c.name === "sipaway_data_at_belize");
  assert.ok(far.light_dropped / far.light_total > 0.5, "the guard drops most of the mismatched light");
  const own = G.days.find((c: any) => c.name === "sipaway_own_data");
  assert.equal(own.light_dropped, 0);
});

test("distances match Python", () => {
  for (const c of G.distances) assert.ok(close(distanceKm(c.a[0], c.a[1], c.b[0], c.b[1]), c.km));
});
