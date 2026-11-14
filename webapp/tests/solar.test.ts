import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { daysFromCivil, solarPosition, solarNoon, sunriseSunset, noonShift, sunWithNoon } from "../src/core/solar.ts";

const G = JSON.parse(readFileSync(new URL("../../shared/golden/solar.json", import.meta.url), "utf8"));
const close = (a: number, b: number, tol = 1e-9) => Math.abs(a - b) <= tol * Math.max(1, Math.abs(b));

test("days from civil matches Python", () => {
  for (const c of G.days) assert.equal(daysFromCivil(c.y, c.m, c.d), c.days);
});

test("solar positions match Python reference", () => {
  let worst = 0;
  for (const c of G.positions) {
    const p = solarPosition(c.y, c.m, c.d, c.minute, c.lat, c.lon, c.tz);
    for (const [k, v] of [["zenith", p.zenith], ["azimuth", p.azimuth], ["zenith_geometric", p.zenithGeometric], ["declination", p.declination], ["eot", p.eot]] as const) {
      worst = Math.max(worst, Math.abs(v - c[k]) / Math.max(1, Math.abs(c[k])));
      assert.ok(close(v, c[k]), `${c.site} ${c.y}-${c.m}-${c.d} ${c.minute} ${k}: ${v} vs ${c[k]}`);
    }
  }
  assert.ok(worst <= 1e-9, `worst relative difference ${worst}`);
});

test("solar noon, sunrise and sunset match Python reference", () => {
  for (const c of G.noons) {
    assert.ok(close(solarNoon(c.y, c.m, c.d, c.lon, c.tz), c.noon));
    const [sr, ss] = sunriseSunset(c.y, c.m, c.d, c.lat, c.lon, c.tz);
    assert.ok(close(sr, c.sunrise) && close(ss, c.sunset));
  }
});

test("user noon shift moves the zenith minimum", () => {
  const [y, m, d, lat, lon, tz] = [2025, 4, 28, 10.4675, 123.4506, 8];
  const n = solarNoon(y, m, d, lon, tz);
  const s = noonShift("user", n, 720);
  let best = 1e9, at = 0;
  for (let t = 700; t < 740; t += 0.05) {
    const z = sunWithNoon(y, m, d, t, lat, lon, tz, s).zenithGeometric;
    if (z < best) { best = z; at = t; }
  }
  assert.ok(Math.abs(at - 720) < 0.2);
});
