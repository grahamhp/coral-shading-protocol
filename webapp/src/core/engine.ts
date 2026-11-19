// Fast light engine. Port of python/src/coralshading/engine.py (the reference; method in its docstring).
// Must reproduce shared/golden/engine.json.
import { fresnelT, skyTransmittance, refractedSunRays } from "./optics.ts";
import { type Panel, insidePanel, rayHitXY } from "./geometry.ts";
import type { DayLight } from "./surface.ts";

export const REF_SUN_ZENITH = 20.0;
export const REF_DIFFUSE = 0.3;
export const N_THETA_SUB = 3;
export const N_PHI = 72;

export interface Tables {
  w0: number[]; sun_zeniths: number[]; taus: number[]; theta_edges_deg: number[]; m_max: number;
  sun_beam: number[][][]; sun_total: number[][][]; sun_A: number[][][][][]; sky_total: number[][]; sky_A0: number[][][];
}

export interface Water { kd: number; w0: number; depth: number }

export interface OpticalState {
  tau: number; sunZeniths: number[]; beam: Float64Array; sunTotal: Float64Array;
  sunA: Float64Array[][]; // [sunz][m] -> Float64Array(theta)
  skyA0: Float64Array; skyTotal: number; thetaEdges: Float64Array; mMax: number;
}

function bracket(g: number[], x0: number): [number, number] {
  const x = Math.min(Math.max(x0, g[0]!), g[g.length - 1]!);
  let i = 0;
  while (i < g.length - 2 && g[i + 1]! <= x) i++;
  return [i, (x - g[i]!) / (g[i + 1]! - g[i]!)];
}

const lg = (x: number) => Math.log(Math.max(x, 1e-300));

export function opticalDepthForKd(water: Water, t: Tables): number {
  const target = water.kd * water.depth;
  const Tsun = fresnelT(Math.cos((REF_SUN_ZENITH * Math.PI) / 180)), Tsky = skyTransmittance();
  const ws = ((1 - REF_DIFFUSE) * Tsun) / ((1 - REF_DIFFUSE) * Tsun + REF_DIFFUSE * Tsky);
  const [iz, fz] = bracket(t.sun_zeniths, REF_SUN_ZENITH);
  const [iw, fw] = bracket(t.w0, water.w0);
  const G = t.taus.map((_, k) => {
    const g = (iwx: number) => {
      const sun = (1 - fz) * t.sun_total[iwx]![iz]![k]! + fz * t.sun_total[iwx]![iz + 1]![k]!;
      return -Math.log(Math.max(ws * sun + (1 - ws) * t.sky_total[iwx]![k]!, 1e-300));
    };
    return (1 - fw) * g(iw) + fw * g(iw + 1);
  });
  if (target <= G[0]!) return (t.taus[0]! * target) / G[0]!;
  if (target >= G[G.length - 1]!) throw new Error(`Kd x depth = ${target.toFixed(1)} is beyond the light tables (almost no light reaches this depth).`);
  let j = 0;
  while (G[j + 1]! < target) j++;
  const f = (target - G[j]!) / (G[j + 1]! - G[j]!);
  return Math.exp((1 - f) * Math.log(t.taus[j]!) + f * Math.log(t.taus[j + 1]!));
}

/** Interpolate value(iw, itau) in w0 (linear) and log(tau) (linear). */
function interpWT(t: Tables, w0: number, tau: number, value: (iw: number, it: number) => number): number {
  const [iw, fw] = bracket(t.w0, w0);
  const [it, ft] = bracket(t.taus.map(Math.log), Math.log(Math.max(tau, 1e-9)));
  const lo = (1 - ft) * value(iw, it) + ft * value(iw, it + 1);
  const hi = (1 - ft) * value(iw + 1, it) + ft * value(iw + 1, it + 1);
  return (1 - fw) * lo + fw * hi;
}

/** Tables interpolated to one water column; tau (= c z) from water.kd and water.depth unless given (v5.1). */
export function opticalState(water: Water, t: Tables, tauGiven?: number): OpticalState {
  const tau = tauGiven ?? opticalDepthForKd(water, t);
  const nz = t.sun_zeniths.length, nT = t.theta_edges_deg.length - 1, M = t.m_max;
  const beam = new Float64Array(nz), tot = new Float64Array(nz);
  const sunA: Float64Array[][] = [];
  for (let j = 0; j < nz; j++) {
    tot[j] = Math.exp(interpWT(t, water.w0, tau, (iw, it) => lg(t.sun_total[iw]![j]![it]!)));
    beam[j] = Math.exp(interpWT(t, water.w0, tau, (iw, it) => lg(t.sun_beam[iw]![j]![it]!)));
    const rows: Float64Array[] = [];
    for (let m = 0; m <= M; m++) {
      const row = new Float64Array(nT);
      for (let i = 0; i < nT; i++)
        row[i] = interpWT(t, water.w0, tau, (iw, it) => t.sun_A[iw]![j]![it]![m]![i]! / Math.max(t.sun_total[iw]![j]![it]!, 1e-300)) * tot[j]!;
      rows.push(row);
    }
    sunA.push(rows);
  }
  const skyTotal = Math.exp(interpWT(t, water.w0, tau, (iw, it) => lg(t.sky_total[iw]![it]!)));
  const skyA0 = new Float64Array(nT);
  for (let i = 0; i < nT; i++) skyA0[i] = interpWT(t, water.w0, tau, (iw, it) => t.sky_A0[iw]![it]![i]! / Math.max(t.sky_total[iw]![it]!, 1e-300)) * skyTotal;
  return { tau, sunZeniths: t.sun_zeniths, beam, sunTotal: tot, sunA, skyA0, skyTotal,
    thetaEdges: Float64Array.from(t.theta_edges_deg, (d) => (d * Math.PI) / 180), mMax: M };
}

export interface Moments { C: Float64Array[]; S: Float64Array[]; nPoints: number; nTheta: number } // [m] -> (point*nTheta + i)

/** Azimuth integrals of the panels' transmission seen from each point (see Python panel_moments).
 * Loops run direction-major: for submerged panels the hit offset of a direction does not depend on the point,
 * so it is computed once and reused for every point (same arithmetic as the reference: x + (h*ux)/uz). */
export function panelMoments(pts: Float64Array, panels: readonly Panel[], water: Water, thetaEdges: Float64Array, mMax = 4): Moments {
  const nP = pts.length / 2, nT = thetaEdges.length - 1;
  const C: Float64Array[] = [], S: Float64Array[] = [];
  for (let m = 0; m <= mMax; m++) { C.push(new Float64Array(nP * nT)); S.push(new Float64Array(nP * nT)); }
  const dphi = (2 * Math.PI) / N_PHI;
  const phis = Float64Array.from({ length: N_PHI }, (_, j) => (j + 0.5) * dphi);
  const cosm: Float64Array[] = [], sinm: Float64Array[] = [];
  for (let m = 0; m <= mMax; m++) { cosm.push(phis.map((p) => Math.cos(m * p))); sinm.push(phis.map((p) => Math.sin(m * p))); }
  const pc = panels.map((p) => ({ p, cr: Math.cos((p.rotDeg * Math.PI) / 180), sr: Math.sin((p.rotDeg * Math.PI) / 180), sub: p.height <= water.depth }));
  const tr = new Float64Array(nP * N_PHI);
  for (let i = 0; i < nT; i++) {
    tr.fill(0);
    for (let s = 0; s < N_THETA_SUB; s++) {
      const th = thetaEdges[i]! + ((s + 0.5) * (thetaEdges[i + 1]! - thetaEdges[i]!)) / N_THETA_SUB;
      const st = Math.sin(th), ct = Math.cos(th);
      for (let j = 0; j < N_PHI; j++) {
        if (!pc.length) { for (let p = 0; p < nP; p++) tr[p * N_PHI + j] = tr[p * N_PHI + j]! + 1; continue; }
        const ux = st * Math.sin(phis[j]!), uy = st * Math.cos(phis[j]!), uz = Math.max(ct, 1e-12);
        const nPan = pc.length;
        if (nPan === 1 && pc[0]!.sub) {
          // single submerged panel (the common case): hit offset is the same for every point
          const { p: pan, cr, sr } = pc[0]!;
          const ox = (pan.height * ux) / uz, oy = (pan.height * uy) / uz, hlx = pan.lx / 2, hly = pan.ly / 2, tau = pan.tau;
          for (let p = 0; p < nP; p++) {
            const dx = pts[2 * p]! + ox - pan.cx, dy = pts[2 * p + 1]! + oy - pan.cy;
            const u = dx * cr - dy * sr, w = dx * sr + dy * cr;
            const k = p * N_PHI + j;
            tr[k] = tr[k]! + (Math.abs(u) <= hlx && Math.abs(w) <= hly ? tau : 1);
          }
          continue;
        }
        for (let p = 0; p < nP; p++) {
          const px = pts[2 * p]!, py = pts[2 * p + 1]!;
          let t = 1;
          for (let q = 0; q < nPan; q++) {
            const { p: pan, cr, sr, sub } = pc[q]!;
            let hx: number, hy: number, ok = true;
            if (sub) { hx = px + (pan.height * ux) / uz; hy = py + (pan.height * uy) / uz; }
            else [hx, hy, ok] = rayHitXY(px, py, ux, uy, ct, pan.height, water.depth);
            if (!ok) continue;
            const dx = hx - pan.cx, dy = hy - pan.cy;
            const u = dx * cr - dy * sr, w = dx * sr + dy * cr;
            if (Math.abs(u) <= pan.lx / 2 && Math.abs(w) <= pan.ly / 2) t *= pan.tau;
          }
          tr[p * N_PHI + j] = tr[p * N_PHI + j]! + t;
        }
      }
    }
    for (let p = 0; p < nP; p++) {
      const o = p * N_PHI;
      for (let j = 0; j < N_PHI; j++) tr[o + j] = tr[o + j]! / N_THETA_SUB;
      for (let m = 0; m <= mMax; m++) {
        let c = 0, s = 0;
        const cmm = cosm[m]!, smm = sinm[m]!;
        for (let j = 0; j < N_PHI; j++) { c += tr[o + j]! * cmm[j]!; s += tr[o + j]! * smm[j]!; }
        C[m]![p * nT + i] = c * dphi; S[m]![p * nT + i] = s * dphi;
      }
    }
  }
  return { C, S, nPoints: nP, nTheta: nT };
}

export interface DayResult { minutes: Float64Array; step: number; ed: Float64Array[]; edOpen: Float64Array; sunlit: Float64Array[];
  beamOpen: Float64Array }   // beamOpen: sun-beam part of the open-water light (within 3 deg of the refracted sun)

/** Panel moments pre-reduced against the tabulated sun angles: D[j][m][p] = sum_i A_m^(j)[i] C_m[p,i] (and E with S).
 * Exact, because the engine interpolates A linearly in sun zenith; it turns the per-step broad sum from
 * (m_max+1) x n_theta x 2 to (m_max+1) x 2 operations per point. */
interface Reduced { D: Float64Array; E: Float64Array; sky: Float64Array; M1: number; nP: number }   // D[(j*M1+m)*nP+p]
const reducedCache = new WeakMap<Moments, WeakMap<OpticalState, Reduced>>();

function reduce(st: OpticalState, mom: Moments): Reduced {
  let byState = reducedCache.get(mom);
  if (!byState) { byState = new WeakMap(); reducedCache.set(mom, byState); }
  const hit = byState.get(st);
  if (hit) return hit;
  const nP = mom.nPoints, nT = mom.nTheta, M1 = st.mMax + 1, nz = st.sunZeniths.length;
  const D = new Float64Array(nz * M1 * nP), E = new Float64Array(nz * M1 * nP);
  for (let j = 0; j < nz; j++) for (let m = 0; m < M1; m++) {
    const A = st.sunA[j]![m]!, Cm = mom.C[m]!, Sm = mom.S[m]!, o = (j * M1 + m) * nP;
    for (let p = 0; p < nP; p++) {
      let sd = 0, se = 0;
      for (let i = 0; i < nT; i++) { sd += A[i]! * Cm[p * nT + i]!; se += A[i]! * Sm[p * nT + i]!; }
      D[o + p] = sd; E[o + p] = se;
    }
  }
  const sky = new Float64Array(nP);
  for (let p = 0; p < nP; p++) { let s = 0; for (let i = 0; i < nT; i++) s += st.skyA0[i]! * mom.C[0]![p * nT + i]!; sky[p] = s; }
  const r = { D, E, sky, M1, nP };
  byState.set(st, r);
  return r;
}

export interface StepConditions {
  states: OpticalState[];                 // one per time step (tide, Kd by date)
  depths?: Float64Array;                  // coral depth per step (m), when the water level changes
  momentsAt?: (depth: number) => Moments; // panel moments for a depth, when a panel can reach the surface
}

/** Per-state quantities used at every step (cached per optical state and moments). */
interface Derived { red: Reduced; skyOpen: number; lb: Float64Array; a0: Float64Array }
const derivedCache = new WeakMap<Moments, WeakMap<OpticalState, Derived>>();
function derive(st: OpticalState, mom: Moments): Derived {
  let byState = derivedCache.get(mom);
  if (!byState) { byState = new WeakMap(); derivedCache.set(mom, byState); }
  const hit = byState.get(st);
  if (hit) return hit;
  const nT = mom.nTheta, nz = st.sunZeniths.length;
  let skyOpen = 0; for (let i = 0; i < nT; i++) skyOpen += st.skyA0[i]!;
  const lb = Float64Array.from(st.beam, (b) => lg(b));
  const a0 = Float64Array.from({ length: nz }, (_, j) => { let s = 0; const A = st.sunA[j]![0]!; for (let i = 0; i < nT; i++) s += A[i]!; return s; });
  const r = { red: reduce(st, mom), skyOpen, lb, a0 };
  byState.set(st, r);
  return r;
}

export function runDay(day: DayLight, water: Water, panels: readonly Panel[], pts: Float64Array, st: OpticalState, mom: Moments, nFacets = 64,
  cond?: StepConditions): DayResult {
  const nt = day.minutes.length, nP = pts.length / 2;
  const ed: Float64Array[] = [], sunlit: Float64Array[] = [];
  const edOpen = new Float64Array(nt), beamOpen = new Float64Array(nt);
  const Tsky = skyTransmittance();
  const Z = st.sunZeniths, nz = Z.length;
  const M = st.mMax;
  const circ = day.parCircumsolarH;
  // per-panel constants for the inlined ray test
  const pn = panels.map((p) => ({ p, cr: Math.cos((p.rotDeg * Math.PI) / 180), sr: Math.sin((p.rotDeg * Math.PI) / 180) }));
  for (let k = 0; k < nt; k++) {
    const e = new Float64Array(nP), v = new Float64Array(nP);
    ed.push(e); sunlit.push(v);
    if (!(day.zenith[k]! < 90)) continue;
    const depthK = cond?.depths ? cond.depths[k]! : water.depth;
    const momK = cond?.momentsAt ? cond.momentsAt(depthK) : mom;
    const { red, skyOpen, lb, a0 } = derive(cond ? cond.states[k]! : st, momK);
    const wind = Number.isFinite(day.wind[k]!) ? day.wind[k]! : 0;
    const rays = refractedSunRays(day.zenith[k]!, day.azimuth[k]!, wind, nFacets);
    const Fs = (day.parDirectH[k]! + (circ ? circ[k]! : 0)) * rays.transmittance, Fk = day.parDiffuse[k]! * Tsky;
    const sa = (day.azimuth[k]! * Math.PI) / 180, za = (Math.min(day.zenith[k]!, 89.9) * Math.PI) / 180;
    const air = [Math.sin(za) * Math.sin(sa), Math.sin(za) * Math.cos(sa), Math.cos(za)] as const;
    const z = Math.min(Math.max(day.zenith[k]!, Z[0]!), Z[nz - 1]!);
    const [j, f] = bracket(Z, z);
    const beam = Math.exp((1 - f) * lb[j]! + f * lb[j + 1]!);
    // broad = sum_m cos(m sa) [(1-f) D_j + f D_j+1] + sin(m sa) [(1-f) E_j + f E_j+1]
    const M1 = M + 1, cA = new Float64Array(M1), cB = new Float64Array(M1), sA = new Float64Array(M1), sB = new Float64Array(M1);
    for (let m = 0; m < M1; m++) { const c = Math.cos(m * sa), s = Math.sin(m * sa); cA[m] = c * (1 - f); cB[m] = c * f; sA[m] = s * (1 - f); sB[m] = s * f; }
    const oj = j * M1 * nP, oj1 = (j + 1) * M1 * nP, RD = red.D, RE = red.E;
    // Facet hit offsets (hit - point) do not depend on the point: compute once per step and panel, with a
    // bounding circle so that points whose every facet agrees skip the facet loop (exact).
    const nq = rays.n;
    let sumW = 0; for (let q = 0; q < nq; q++) { const wf = rays.weights[q]!; if (wf > 0) sumW += wf; }
    const off = pn.map(({ p: pan }) => {
      const ox = new Float64Array(nq), oy = new Float64Array(nq), ok = new Uint8Array(nq);
      let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity, allOk = true;
      for (let q = 0; q < nq; q++) {
        if (!(rays.weights[q]! > 0)) continue;
        const ux = rays.dirs[3 * q]!, uy = rays.dirs[3 * q + 1]!, uz = Math.max(rays.dirs[3 * q + 2]!, 1e-12);
        let hx: number, hy: number, good = true;
        if (pan.height <= depthK) { hx = (pan.height * ux) / uz; hy = (pan.height * uy) / uz; }
        else [hx, hy, good] = rayHitXY(0, 0, ux, uy, uz, pan.height, depthK, air);
        ox[q] = hx; oy[q] = hy; ok[q] = good ? 1 : 0;
        if (!good) { allOk = false; continue; }
        x0 = Math.min(x0, hx); x1 = Math.max(x1, hx); y0 = Math.min(y0, hy); y1 = Math.max(y1, hy);
      }
      const cx = 0.5 * (x0 + x1), cy = 0.5 * (y0 + y1), r = 0.5 * Math.hypot(x1 - x0, y1 - y0) + 1e-9;
      return { ox, oy, ok, cx, cy, r, allOk };
    });
    for (let p = 0; p < nP; p++) {
      const px = pts[2 * p]!, py = pts[2 * p + 1]!;
      let vis = 0;
      if (pn.length) {
        // classify every panel: 0 = all facets miss, 1 = all hit, 2 = mixed
        let uniform = true, tAll = 1;
        for (let k2 = 0; k2 < pn.length; k2++) {
          const { p: pan, cr, sr } = pn[k2]!, o = off[k2]!;
          const dx = px + o.cx - pan.cx, dy = py + o.cy - pan.cy;
          const u = Math.abs(dx * cr - dy * sr), w = Math.abs(dx * sr + dy * cr);
          if (u > pan.lx / 2 + o.r || w > pan.ly / 2 + o.r) continue;                 // all miss
          if (o.allOk && u <= pan.lx / 2 - o.r && w <= pan.ly / 2 - o.r) { tAll *= pan.tau; continue; } // all hit
          uniform = false; break;
        }
        if (uniform) vis = tAll * sumW;
        else {
          for (let q = 0; q < nq; q++) {
            const wf = rays.weights[q]!;
            if (!(wf > 0)) continue;
            let t = 1;
            for (let k2 = 0; k2 < pn.length; k2++) {
              const { p: pan, cr, sr } = pn[k2]!, o = off[k2]!;
              if (!o.ok[q]) continue;
              const dx = px + o.ox[q]! - pan.cx, dy = py + o.oy[q]! - pan.cy;
              const u = dx * cr - dy * sr, w = dx * sr + dy * cr;
              if (Math.abs(u) <= pan.lx / 2 && Math.abs(w) <= pan.ly / 2) t *= pan.tau;
            }
            vis += wf * t;
          }
        }
      } else vis = 1;
      let broad = 0;
      for (let m = 0; m < M1; m++) {
        const q0 = oj + m * nP + p, q1 = oj1 + m * nP + p;
        broad += cA[m]! * RD[q0]! + cB[m]! * RD[q1]! + sA[m]! * RE[q0]! + sB[m]! * RE[q1]!;
      }
      e[p] = Fs * (beam * vis + broad) + Fk * red.sky[p]!;
      v[p] = vis;
    }
    const a0k = (1 - f) * a0[j]! + f * a0[j + 1]!;
    edOpen[k] = Fs * (beam + 2 * Math.PI * a0k) + Fk * 2 * Math.PI * skyOpen;
    beamOpen[k] = Fs * beam;
  }
  return { minutes: day.minutes, step: day.step, ed, edOpen, sunlit, beamOpen };
}
