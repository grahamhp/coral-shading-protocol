import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { type HourlyLight, lightFromJson, clearSkyLight, dayLight, distanceKm, typicalYear, parseOpenMeteo, parsePVGIS } from "../src/core/surface.ts";

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
      assert.ok(close(dl.parCircumsolarH![i]!, c.par_circumsolar_h[i]), `${c.name} circumsolar step ${i}`);
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

test("values centred off the half hour match Python (v5.2)", () => {
  const c = G.off_center, cs = clearSkyLight(c.lat, c.lon);
  const cs9: HourlyLight = { ...cs, tUtc: cs.tUtc.map((t) => t - 21), centerMin: c.center_min };
  const dl = dayLight(cs9, c.y, c.m, c.d, c.lat, c.lon, c.tz);
  for (let i = 0; i < c.par_direct_h.length; i++)
    assert.ok(close(dl.parDirectH[i]!, c.par_direct_h[i]) && close(dl.parDiffuse[i]!, c.par_diffuse[i]) && close(dl.parCircumsolarH![i]!, c.par_circumsolar_h[i]), `step ${i}`);
  assert.ok(close(dl.lightTotal!, c.light_total) && close(dl.lightDropped!, c.light_dropped));
  // hourly PVGIS-SARAH3 series (stamps hh:09) are read and used
  const ser = "Radiation database:\tPVGIS-SARAH3\nSlope: 0 deg.\ntime,Gb(i),Gd(i),Gr(i),H_sun,T2m,WS10m,Int\n" + Array.from({ length: 48 }, (_, k) =>
    `2020010${1 + Math.floor(k / 24)}:${String(k % 24).padStart(2, "0")}09,${k % 24 >= 6 && k % 24 <= 14 ? 100 : 0},${k % 24 >= 6 && k % 24 <= 14 ? 30 : 0},0.0,0.0,20.0,3.0,0.0`).join("\n");
  const s = parsePVGIS(ser);
  assert.equal(s.centerMin, 9);
  dayLight(s, 2020, 1, 1, 0, 0, 0);
});

test("typical year and Open-Meteo reader match Python (v5.2)", () => {
  const I = JSON.parse(readFileSync(new URL("../../shared/golden/typical_year_input.json", import.meta.url), "utf8"));
  const c = G.typical_year, n = I.ghi.length;
  const t0 = Date.UTC(2014, 0, 1, 0, 30) / 60000;
  const h: HourlyLight = { tUtc: Float64Array.from({ length: n }, (_, k) => t0 + 60 * k), ghi: Float64Array.from(I.ghi), dhi: Float64Array.from(I.dhi),
    unit: "W", wind: null, lat: I.lat, lon: I.lon, source: "", database: "PVGIS-ERA5", kind: "hourly", centerMin: I.center_min };
  const t = typicalYear(h);
  assert.deepEqual(t.tmyYears, c.years);
  assert.equal(t.database, c.database);
  assert.ok(close(t.ghi.reduce((a, b) => a + b, 0), c.ghi_sum) && close(t.dhi.reduce((a, b) => a + b, 0), c.dhi_sum) && close(t.tUtc[0]!, c.t0));
  for (const s of c.samples) assert.ok(close(t.ghi[s.k]!, s.ghi) && close(t.dhi[s.k]!, s.dhi), `hour ${s.k}`);
  const o = parseOpenMeteo(JSON.stringify(c.open_meteo.reply)), e = c.open_meteo;
  assert.equal(o.ghi.length, e.n);
  assert.ok(close(o.tUtc[0]!, e.t0) && close(o.centerMin!, e.center_min) && close(o.ghi.reduce((a, b) => a + b, 0), e.ghi_sum)
    && close(o.dhi.reduce((a, b) => a + b, 0), e.dhi_sum) && close(o.wind![0]!, e.wind0) && o.lat === e.lat && o.lon === e.lon);
  assert.throws(() => parseOpenMeteo({ error: true, reason: "Daily API request limit exceeded." }), /Open-Meteo/);
});
