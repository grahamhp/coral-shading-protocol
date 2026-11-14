import { readFileSync } from "node:fs";
import { lightFromJson, dayLight } from "../src/core/surface.ts";
import { refractedSunRays } from "../src/core/optics.ts";
import { deploymentDays } from "../src/core/scenarios.ts";
const EX = JSON.parse(readFileSync(new URL("../../shared/examples/sipaway.json", import.meta.url), "utf8"));
const L = lightFromJson(EX.light);
const all = deploymentDays([2025, 4, 28], [2025, 8, 8], 1);
let t0 = performance.now(); const dls = all.map(([y, m, d]) => dayLight(L, y, m, d, EX.lat, EX.lon, EX.utc_offset_h, 10, 0)); let t1 = performance.now();
console.log("dayLight x", all.length, (t1 - t0).toFixed(0), "ms");
t0 = performance.now(); let n = 0;
for (const dl of dls) for (let k = 0; k < dl.minutes.length; k++) if (dl.zenith[k]! < 90) { refractedSunRays(dl.zenith[k]!, dl.azimuth[k]!, dl.wind[k] || 0, 16); n++; }
t1 = performance.now(); console.log("rays x", n, (t1 - t0).toFixed(0), "ms");
