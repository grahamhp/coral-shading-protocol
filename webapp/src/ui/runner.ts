// The calculation, in stages: a quick preview, the full-resolution run, the cloth ratings, the checks under other
// conditions, and (Expert) other canopy widths. The background worker runs the stages back to back. Where a browser
// window refuses a worker (some sandboxed previews do), the page runs the same stages itself, one at a time.
import { compute, computeRobustness, computeClothOptions, computeCanopyOptions, type Data, type Inputs, type Results } from "./compute.ts";

export interface RunMsg { type: "run"; id: number; inputs: Inputs; full: boolean; guess?: number; expert?: boolean }

export function* stages(msg: RunMsg, data: Data): Generator<Results> {
  const pre = compute(msg.inputs, data, "preview", msg.guess);
  yield pre;
  if (!msg.full) return;
  const g = pre.scenarios.find((s) => s.kind === "dynamic")?.panel.lx;
  const full = compute(msg.inputs, data, "full", g);
  yield full;
  // the same cloth with other shade ratings (from the run just made)
  full.clothOptions = computeClothOptions(msg.inputs);
  if (full.clothOptions) yield full;
  // robustness: same designs, varied conditions
  const t0 = performance.now();
  const rob = computeRobustness(msg.inputs, data, { constant: full.scenarios.find((s) => s.kind === "constant")?.panel, dynamic: full.scenarios.find((s) => s.kind === "dynamic")?.panel });
  for (const s of full.scenarios) { s.robustness = rob[s.kind]?.rows; s.w0Range = rob[s.kind]?.range; }
  const ms = performance.now() - t0;
  const dyn = full.scenarios.find((s) => s.kind === "dynamic");
  if (!(msg.expert && dyn)) { yield { ...full, level: "robust", ms: full.ms + ms }; return; }
  yield { ...full, level: "robust", ms: full.ms + ms, canopyOptions: undefined };
  const t1 = performance.now();
  const canopyOptions = computeCanopyOptions(msg.inputs, data, dyn.panel);
  yield { ...full, level: "robust", ms: full.ms + ms + performance.now() - t1, canopyOptions };
}
