// Smoke test of the BUILT app (dist/index.html) in Node, with a minimal DOM stub and an in-process worker.
import { readFileSync } from "node:fs";
const html = readFileSync(new URL("../dist/index.html", import.meta.url), "utf8");
const scripts = [...html.matchAll(/<script([^>]*)>([\s\S]*?)<\/script>/g)].map((m) => ({ attrs: m[1], code: m[2] }));
const bootJson = scripts.find((s) => s.attrs.includes('id="boot"')).code;
const appCode = scripts[scripts.length - 1].code;
const els = new Map();
const mkEl = (sel) => ({ sel, innerHTML: "", textContent: "", value: "", classList: { toggle() {}, add() {}, remove() {} }, querySelector: () => null, querySelectorAll: () => [], addEventListener() {}, remove() {}, dataset: {} });
const listeners = {};
globalThis.document = { body: { innerHTML: "", classList: { toggle() {} }, appendChild() {} }, addEventListener: (t, f) => ((listeners[t] ??= []).push(f)),
  querySelector: (sel) => { if (!els.has(sel)) els.set(sel, mkEl(sel)); return els.get(sel); }, getElementById: (i) => (i === "boot" ? { textContent: bootJson } : document.querySelector("#" + i)), createElement: () => mkEl("x") };
globalThis.window = globalThis; Object.defineProperty(globalThis, "navigator", { value: { onLine: false }, configurable: true });
const CSP_BOOT = JSON.parse(bootJson);
globalThis.CSP_BOOT = CSP_BOOT;
URL.createObjectURL = () => "blob:worker";
let posted = 0;
globalThis.Worker = class { constructor() { const me = this; this.self = { postMessage: (m) => setTimeout(() => me.onmessage && me.onmessage({ data: structuredClone(m) }), 0) };
  new Function("self", CSP_BOOT.workerSource)(this.self); }
  postMessage(m) { posted++; const s = this.self; setTimeout(() => s.onmessage({ data: structuredClone(m) }), 0); } terminate() { this.self.onmessage = () => {}; } };
const t0 = Date.now();
new Function(appCode)();
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
let status = ""; const seen = [];
for (let i = 0; i < 300; i++) { await wait(100); status = document.querySelector("#status").textContent; if (seen[seen.length - 1] !== status) seen.push(status); if ((status.startsWith("Full") && !status.includes("checking")) || status.startsWith("⚠")) break; }
globalThis.__lastTimings = null;
const right = document.querySelector("#right").innerHTML, left = document.querySelector("#left").innerHTML;
console.log("status:", status, "| after", ((Date.now() - t0) / 1000).toFixed(1), "s | worker messages", posted);
console.log("stages:", seen.join("  →  "));
console.log("left html", left.length, "right html", right.length);
console.log("simple mode has solar noon field:", left.includes("Solar noon"), "| waves field:", left.includes("Waves"));
const h1 = right.match(/<h1>(.*?)<\/h1>/); console.log("headline:", h1 && h1[1]);
for (const m of right.matchAll(/<div class="n">(.*?)<\/div>/g)) console.log("kpi:", m[1].replace(/<[^>]+>/g, ""));
for (const m of right.matchAll(/<div class="check"><span class="badge [a-z]+">([A-Z.…]+)<\/span><div><b>(.*?)<\/b>/g)) console.log("check:", m[1], "-", m[2]);
console.log("svg count", (right.match(/<svg/g) || []).length, "| NaN in output:", /NaN|undefined/.test(right));

// expert mode
globalThis.__csp.toggle("mode", "expert");
for (let i = 0; i < 300; i++) { await wait(100); const s = document.querySelector("#status").textContent; if (s.startsWith("Full") && !s.includes("checking")) break; }
const L2 = document.querySelector("#left").innerHTML, R2 = document.querySelector("#right").innerHTML;
console.log("expert left has kd/w0/fouling/canopy/grid:", ["id=\"kd\"", "id=\"w0\"", "id=\"tauClean\"", "canopyAuto", "id=\"grid\""].map((k) => L2.includes(k)));
console.log("expert right has robustness rows:", (R2.match(/<tr><td>(Kd|w0|wind|shifted|as designed)/g) || []).length, "| exports:", (R2.match(/data-export=/g) || []).length, "| NaN:", /NaN|undefined/.test(R2));
// exports produce text
let dl = null; globalThis.document.createElement = () => ({ click() {}, set href(v) {}, get href() { return ""; }, set download(v) { dl = v; } });
const origCreate = URL.createObjectURL; let blobs = []; URL.createObjectURL = (b) => { blobs.push(b); return "blob:x"; }; URL.revokeObjectURL = () => {};
for (const k of ["points", "days", "inputs"]) globalThis.__csp.exportAs(k);
for (const b of blobs) { const t = await b.text(); console.log("export", t.split("\n").slice(0, 3).join(" | ").slice(0, 220), "... lines", t.split("\n").length); }
// constant-only scenario and an infeasible dynamic target
globalThis.__csp.toggle("scenario", "dynamic"); globalThis.__csp.state.dynamicTargetReduction = 99; globalThis.__csp.state.height = 0.75;
globalThis.__csp.toggle("scenario", "dynamic");
await wait(400);
for (let i = 0; i < 300; i++) { await wait(100); const s = document.querySelector("#status").textContent; if ((s.startsWith("Full") && !s.includes("checking")) || s.startsWith("⚠")) break; }
const R3 = document.querySelector("#right").innerHTML;
console.log("dynamic 99 %:", (R3.match(/<h1>(.*?)<\/h1>/) || [])[1], "| warn:", (R3.match(/Not reachable[^<]{0,160}/) || [""])[0]);

// ---- 8 Nov review checks (run in simple mode, both scenarios)
const waitFull = async () => {
  for (let i = 0; i < 50; i++) { await wait(50); if (!document.querySelector("#status").textContent.startsWith("Full")) break; }   // the new run has started
  for (let i = 0; i < 400; i++) { await wait(100); const s = document.querySelector("#status").textContent; if ((s.startsWith("Full") && !s.includes("checking")) || s.startsWith("⚠")) break; }
  await wait(300); };
const C = globalThis.__csp;
C.toggle("mode", "simple"); C.state.dynamicTargetReduction = 75; C.toggle("scenario", "both"); await waitFull();
let R = document.querySelector("#right").innerHTML, Lh = document.querySelector("#left").innerHTML;
console.log("REVIEW lead:", (R.match(/<p class="lead">(.*?)<\/p>/) || [])[1]);
console.log("REVIEW day picker:", R.includes('id="dayIdx"'), "| zone table:", R.includes('class="t zones"'), "| zone rows:", (R.match(/Light-limited|Near saturation|Saturated|Below compensation/g) || []).length,
  "| daily light chart:", R.includes("Daily light at the corals through the deployment"), "| map legend:", /Dashed line: the structure/.test(R), "| dates grid:", Lh.includes('class="dates"'), "| NaN:", /NaN|undefined/.test(R));
const res = C.results(); const d0 = (R.match(/<span class="dd">(.*?)<\/span>/) || [])[1];
C.ui.day = res.days[50]; C.render(); R = document.querySelector("#right").innerHTML;
console.log("REVIEW day flip:", d0, "->", (R.match(/<span class="dd">(.*?)<\/span>/) || [])[1], "| note:", (R.match(/weather; open water got ([^<]*?) that day/) || [])[1]);
const zcells = [...R.matchAll(/<td>([\d.]+)\u00a0h<br><span class="sub">([\d]+)\u00a0% of light/g)].map((m) => `${m[1]}h/${m[2]}%`);
console.log("REVIEW zone cells:", zcells.join(" "));
// rope nursery laid north-south vs east-west
C.ui.targetKey = "rope"; C.state.target = { shape: "rect", lx: 1.0, ly: 4.0 }; C.ui.day = null; C.rerun(); await waitFull();
R = document.querySelector("#right").innerHTML;
console.log("REVIEW rope N-S kpis:", [...R.matchAll(/<div class="n">(.*?)<\/div>/g)].map((m) => m[1].replace(/<[^>]+>/g, "")).join(" | "), "| ends warning:", R.includes("ends of the coral area get little shade"));
C.state.target = { shape: "rect", lx: 4.0, ly: 1.0 }; C.rerun(); await waitFull();
R = document.querySelector("#right").innerHTML;
console.log("REVIEW rope E-W kpis:", [...R.matchAll(/<div class="n">(.*?)<\/div>/g)].map((m) => m[1].replace(/<[^>]+>/g, "")).join(" | "), "| ends warning:", R.includes("ends of the coral area get little shade"));

// Belize (the spiky-curve report): moving the site far from the Sipaway data must give a clear-sky estimate,
// a longitude-based UTC offset and smooth day curves that never exceed the clear-sky ceiling.
C.ui.targetKey = "reef_star"; C.state.target = { shape: "circle", lx: 1.1, ly: 1.1 };
C.state.start = [2025, 6, 1]; C.state.end = [2025, 6, 30]; C.state.depth = 5;
C.setSite(16.1883, -88.5992); await waitFull();
R = document.querySelector("#right").innerHTML;
const rb = C.results(), L0 = C.light();
const peak = Math.max(...rb.open.dayCurves.flat());
const noonH = rb.noons[9] / 60;
// curve smoothness: largest jump between 10-min steps relative to the peak
let jump = 0; for (const c of rb.open.dayCurves) for (let i = 1; i < c.length; i++) jump = Math.max(jump, Math.abs(c[i] - c[i - 1]));
console.log("BELIZE tz:", C.state.site.tz, "| light:", L0.database, "| noon Jun 10:", noonH.toFixed(2), "h | open peak at 5 m:", peak.toFixed(0),
  "| max 10-min jump:", jump.toFixed(0), "| open DLI:", rb.open.dliMean.toFixed(1), "| checks:", (R.match(/clear-sky estimate \(no clouds\)/g) || []).length,
  "| lightNotes:", rb.lightNotes.length, "| NaN:", /NaN|undefined/.test(R));
// back to Sipaway: the example data return
C.setSite(10.4675, 123.4506); await waitFull();
const rs = C.results();
console.log("SIPAWAY again tz:", C.state.site.tz, "| light:", C.light().database, "| lightNotes:", rs.lightNotes.length, "| open DLI:", rs.open.dliMean.toFixed(2));
