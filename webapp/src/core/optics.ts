// Sea-surface optics: refraction, Fresnel transmission, Snell's window, Cox-Munk waves.
// Port of python/src/coralshading/optics.py (the reference; sources in its docstring).
export const N_WATER = 1.34;
export const SNELL_WINDOW_DEG = (Math.asin(1 / N_WATER) * 180) / Math.PI;

export function refractedZenithDeg(zenithAirDeg: number): number {
  const z = (Math.min(Math.max(zenithAirDeg, 0), 90) * Math.PI) / 180;
  return (Math.asin(Math.sin(z) / N_WATER) * 180) / Math.PI;
}

export function fresnelT(cosI: number): number {
  const ci = Math.min(1, Math.max(1e-9, cosI));
  const si = Math.sqrt(1 - ci * ci), st = si / N_WATER, ct = Math.sqrt(1 - st * st);
  const rs = (ci - N_WATER * ct) / (ci + N_WATER * ct);
  const rp = (ct - N_WATER * ci) / (ct + N_WATER * ci);
  return 1 - 0.5 * (rs * rs + rp * rp);
}

export function skyTransmittance(nTheta = 2000): number {
  let s = 0, sw = 0;
  for (let i = 0; i < nTheta; i++) {
    const th = ((i + 0.5) * (Math.PI / 2)) / nTheta;
    const w = Math.cos(th) * Math.sin(th);
    s += fresnelT(Math.cos(th)) * w; sw += w;
  }
  return s / sw;
}

export function coxMunkMss(windMs: number): number {
  return 0.003 + 5.12e-3 * Math.max(0, windMs);
}

function halton(i0: number, base: number): number {
  let f = 1, r = 0, i = i0;
  while (i > 0) { f /= base; r += f * (i % base); i = Math.floor(i / base); }
  return r;
}

const A = [-3.969683028665376e+1, 2.209460984245205e+2, -2.759285104469687e+2, 1.38357751867269e+2, -3.066479806614716e+1, 2.506628277459239];
const B = [-5.447609879822406e+1, 1.615858368580409e+2, -1.556989798598866e+2, 6.680131188771972e+1, -1.328068155288572e+1];
const C = [-7.784894002430293e-3, -3.223964580411365e-1, -2.400758277161838, -2.549732539343734, 4.374664141464968, 2.938163982698783];
const D = [7.784695709041462e-3, 3.224671290700398e-1, 2.445134137142996, 3.754408661907416];

/** Inverse standard normal CDF (Acklam). */
export function invNorm(p: number): number {
  const pl = 0.02425;
  if (p < pl) {
    const q = Math.sqrt(-2 * Math.log(p));
    return (((((C[0]! * q + C[1]!) * q + C[2]!) * q + C[3]!) * q + C[4]!) * q + C[5]!) / ((((D[0]! * q + D[1]!) * q + D[2]!) * q + D[3]!) * q + 1);
  }
  if (p > 1 - pl) {
    const q = Math.sqrt(-2 * Math.log(1 - p));
    return -(((((C[0]! * q + C[1]!) * q + C[2]!) * q + C[3]!) * q + C[4]!) * q + C[5]!) / ((((D[0]! * q + D[1]!) * q + D[2]!) * q + D[3]!) * q + 1);
  }
  const q = p - 0.5, r = q * q;
  return ((((((A[0]! * r + A[1]!) * r + A[2]!) * r + A[3]!) * r + A[4]!) * r + A[5]!) * q) / (((((B[0]! * r + B[1]!) * r + B[2]!) * r + B[3]!) * r + B[4]!) * r + 1);
}

export function unitFacets(n: number): Float64Array {
  const out = new Float64Array(2 * n);
  for (let i = 0; i < n; i++) { out[2 * i] = invNorm(halton(i + 1, 2)); out[2 * i + 1] = invNorm(halton(i + 1, 3)); }
  return out;
}

export interface SunRays { dirs: Float64Array; weights: Float64Array; transmittance: number; n: number }

/** Refracted sun rays below a flat (wind <= 0) or wavy sea. dirs: unit vectors (x east, y north, z up)
 *  pointing back toward the light source; weights sum to 1. */
export function refractedSunRays(zenithAirDeg: number, azimuthDeg: number, windMs: number, nFacets = 64): SunRays {
  const z = (Math.min(Math.max(zenithAirDeg, 0), 89.9) * Math.PI) / 180, a = (azimuthDeg * Math.PI) / 180;
  const s = [Math.sin(z) * Math.sin(a), Math.sin(z) * Math.cos(a), Math.cos(z)] as const;
  const eta = 1 / N_WATER;
  let normals: number[][], prob: number[];
  if (!(windMs > 0) || nFacets === 0) { normals = [[0, 0, 1]]; prob = [1]; }
  else {
    const sc = Math.sqrt(coxMunkMss(windMs) / 2);
    const uf = unitFacets(nFacets);
    normals = []; prob = [];
    for (let i = 0; i < nFacets; i++) {
      const sx = uf[2 * i]! * sc, sy = uf[2 * i + 1]! * sc;
      const nn = Math.sqrt(sx * sx + sy * sy + 1);
      normals.push([-sx / nn, -sy / nn, 1 / nn]); prob.push((1 / nFacets) * nn);
    }
  }
  const n = normals.length;
  const dirs = new Float64Array(3 * n), w = new Float64Array(n);
  let tot = 0;
  const sz = Math.max(Math.min(s[2], 1), 1e-9);
  for (let i = 0; i < n; i++) {
    const nv = normals[i]!;
    const ci = nv[0]! * s[0] + nv[1]! * s[1] + nv[2]! * s[2];
    const cic = Math.min(1, Math.max(-1, ci));
    const k = 1 - eta * eta * (1 - cic * cic);
    const fac = eta * ci - Math.sqrt(Math.max(k, 0));
    const t = [-eta * s[0] + fac * nv[0]!, -eta * s[1] + fac * nv[1]!, -eta * s[2] + fac * nv[2]!];
    const norm = Math.hypot(t[0]!, t[1]!, t[2]!);
    dirs[3 * i] = -t[0]! / norm; dirs[3 * i + 1] = -t[1]! / norm; dirs[3 * i + 2] = -t[2]! / norm;
    let wi = (prob[i]! * Math.max(ci, 0) * fresnelT(Math.min(1, Math.max(1e-9, ci)))) / sz;
    if (!(ci > 0 && k > 0 && t[2]! < 0)) wi = 0;
    w[i] = wi; tot += wi;
  }
  if (tot > 0) for (let i = 0; i < n; i++) w[i] = w[i]! / tot;
  return { dirs, weights: w, transmittance: tot, n };
}
