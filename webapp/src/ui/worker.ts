// Background worker: keeps the page responsive. A quick preview first, then the full-resolution run.
// The page restarts the worker when inputs change, so stale work is simply dropped.
import type { Data } from "./compute.ts";
import { stages, type RunMsg } from "./runner.ts";
import type { Tables } from "../core/engine.ts";
import type { PresetFile } from "../core/pe.ts";
import type { HourlyLight } from "../core/surface.ts";

type Msg =
  | { type: "init"; tables: Tables; presets: PresetFile; light: HourlyLight }
  | { type: "light"; light: HourlyLight }
  | RunMsg;

let data: Data | null = null;

const post = (m: unknown) => (self as unknown as { postMessage: (m: unknown) => void }).postMessage(m);

(self as unknown as { onmessage: (ev: { data: Msg }) => void }).onmessage = (ev) => {
  const msg = ev.data;
  if (msg.type === "init") { data = { tables: msg.tables, presets: msg.presets, light: msg.light }; return; }
  if (msg.type === "light") { if (data) data.light = msg.light; return; }
  if (msg.type === "run") {
    if (!data) { post({ type: "error", id: msg.id, message: "Not ready." }); return; }
    try {
      for (const result of stages(msg, data)) post({ type: "result", id: msg.id, result });
    } catch (e) {
      post({ type: "error", id: msg.id, message: e instanceof Error ? e.message : String(e) });
    }
  }
};
