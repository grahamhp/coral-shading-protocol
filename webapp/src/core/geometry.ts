// Shade panels, the shaded target area, and ray tests. Port of python/src/coralshading/geometry.py.
// x east, y north, z up (m); origin at the centre of the target on the target plane; sea surface at z = depth.
import { N_WATER } from "./optics.ts";

export interface Panel { cx: number; cy: number; lx: number; ly: number; height: number; tau: number; rotDeg: number }

export function panel(p: Partial<Panel> = {}): Panel {
  return { cx: 0, cy: 0, lx: 2, ly: 2, height: 0.75, tau: 0, rotDeg: 0, ...p };
}

export function insidePanel(p: Panel, x: number, y: number): boolean {
  const r = (p.rotDeg * Math.PI) / 180;
  const dx = x - p.cx, dy = y - p.cy;
  const u = dx * Math.cos(r) - dy * Math.sin(r);
  const v = dx * Math.sin(r) + dy * Math.cos(r);
  return Math.abs(u) <= p.lx / 2 && Math.abs(v) <= p.ly / 2;
}

export interface Target { shape: "rect" | "circle"; lx: number; ly: number }

/** Grid of equal-area cell centres covering the target. Returns interleaved [x0, y0, x1, y1, ...]. */
export function targetGrid(t: Target, spacing = 0.025): Float64Array {
  const nx = Math.max(1, Math.round(t.lx / spacing));
  const Ly = t.shape === "rect" ? t.ly : t.lx;
  const ny = Math.max(1, Math.round(Ly / spacing));
  const pts: number[] = [];
  for (let j = 0; j < ny; j++) {
    const y = (j + 0.5) * (Ly / ny) - Ly / 2;
    for (let i = 0; i < nx; i++) {
      const x = (i + 0.5) * (t.lx / nx) - t.lx / 2;
      if (t.shape === "circle" && x * x + y * y > (t.lx / 2) ** 2 + 1e-12) continue;
      pts.push(x, y);
    }
  }
  return Float64Array.from(pts);
}

export const PRESETS: Record<string, { label: string; target: Target }> = {
  reef_star: { label: "MARRS Reef Star (1.1 m across)", target: { shape: "circle", lx: 1.1, ly: 1.1 } },
  nursery_table_1x2: { label: "Nursery table 1 x 2 m", target: { shape: "rect", lx: 2.0, ly: 1.0 } },
  rope_nursery_4x1: { label: "Rope nursery 4 x 1 m", target: { shape: "rect", lx: 4.0, ly: 1.0 } },
};

/** Where a ray leaving (px, py) upward along unit underwater direction (ux, uy, uz) crosses z = height.
 *  Panels at or above the surface: refracted into air along airDir if given, else by Snell's law. */
export function rayHitXY(px: number, py: number, ux: number, uy: number, uz0: number, height: number, depth: number,
  airDir?: readonly [number, number, number]): [number, number, boolean] {
  const uz = Math.max(uz0, 1e-12);
  if (height <= depth) return [px + (height * ux) / uz, py + (height * uy) / uz, true];
  const sx = px + (depth * ux) / uz, sy = py + (depth * uy) / uz;
  if (airDir) {
    const az = Math.max(airDir[2], 1e-12);
    return [sx + ((height - depth) * airDir[0]) / az, sy + ((height - depth) * airDir[1]) / az, true];
  }
  const sw = Math.sqrt(Math.max(ux * ux + uy * uy, 0));
  const sa = N_WATER * sw;
  const valid = sa < 1;
  const ca = Math.sqrt(Math.max(1 - sa * sa, 1e-12));
  const hx = sw > 0 ? ux / sw : 0, hy = sw > 0 ? uy / sw : 0;
  const t = ((height - depth) * sa) / ca;
  return [sx + t * hx, sy + t * hy, valid];
}

/** Product of the transmissions of every panel the ray crosses. */
export function transmissionAlong(px: number, py: number, ux: number, uy: number, uz: number, panels: readonly Panel[], depth: number,
  airDir?: readonly [number, number, number]): number {
  let out = 1;
  for (const p of panels) {
    const [hx, hy, ok] = rayHitXY(px, py, ux, uy, uz, p.height, depth, airDir);
    if (ok && insidePanel(p, hx, hy)) out *= p.tau;
  }
  return out;
}
