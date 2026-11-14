// Background worker: keeps the page responsive. A quick preview first, then the full-resolution run.
// The page restarts the worker when inputs change, so stale work is simply dropped.
import { compute, computeRobustness, type Data, type Inputs } from "./compute.ts";
import type { Tables } from "../core/engine.ts";
import type { PresetFile } from "../core/pe.ts";
import type { HourlyLight } from "../core/surface.ts";

type Msg =
  | { type: "init"; tables: Tables; presets: PresetFile; light: HourlyLight }
  | { type: "light"; light: HourlyLight }
  | { type: "run"; id: number; inputs: Inputs; full: boolean; guess?: number };

let data: Data | null = null;

const post = (m: unknown) => (self as unknown as { postMessage: (m: unknown) => void }).postMessage(m);

(self as unknown as { onmessage: (ev: { data: Msg }) => void }).onmessage = (ev) => {
  const msg = ev.data;
  if (msg.type === "init") { data = { tables: msg.tables, presets: msg.presets, light: msg.light }; return; }
  if (msg.type === "light") { if (data) data.light = msg.light; return; }
  if (msg.type === "run") {
    if (!data) { post({ type: "error", id: msg.id, message: "Not ready." }); return; }
    try {
      const pre = compute(msg.inputs, data, "preview", msg.guess);
      post({ type: "result", id: msg.id, result: pre });
      if (msg.full) {
        const g = pre.scenarios.find((s) => s.kind === "dynamic")?.panel.lx;
        const full = compute(msg.inputs, data, "full", g);
        post({ type: "result", id: msg.id, result: full });
        // robustness: same designs, varied conditions
        const t0 = performance.now();
        const rob = computeRobustness(msg.inputs, data, { constant: full.scenarios.find((s) => s.kind === "constant")?.panel, dynamic: full.scenarios.find((s) => s.kind === "dynamic")?.panel });
        for (const s of full.scenarios) s.robustness = rob[s.kind];
        const ms = performance.now() - t0;
        post({ type: "result", id: msg.id, result: { ...full, level: "robust", ms: full.ms + ms } });
      }
    } catch (e) {
      post({ type: "error", id: msg.id, message: e instanceof Error ? e.message : String(e) });
    }
  }
};
