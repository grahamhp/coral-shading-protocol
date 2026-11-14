"""Optics of the sea surface: refraction, Fresnel transmission, Snell's window and wind-driven waves.

Sources (journal articles are in shared/references.json; Mobley 1994, Light and Water, and Born and Wolf,
Principles of Optics, are textbooks):
- Refractive index of seawater about 1.34 in the visible (Quan and Fry 1995; Mobley 1994).
- Unpolarised Fresnel transmission (Born and Wolf; Mobley 1994, ch. 4).
- Sea-surface slope statistics: total mean-square slope sigma^2 = 0.003 + 5.12e-3 U for wind speed U
  (m s-1), Cox and Munk (1954), treated as isotropic because wind direction is not needed for daily light.
Wave facets are a fixed, deterministic set (Halton points through the inverse normal), so Python and the
browser use exactly the same facets. Identical in webapp/src/core/optics.ts.
"""
from __future__ import annotations

import math

import numpy as np

N_WATER = 1.34
SNELL_WINDOW_DEG = math.degrees(math.asin(1.0 / N_WATER))   # 48.27 deg


def refracted_zenith_deg(zenith_air_deg):
    """Underwater zenith angle of a ray entering a flat sea surface."""
    z = np.radians(np.clip(np.asarray(zenith_air_deg, dtype=float), 0.0, 90.0))
    return np.degrees(np.arcsin(np.sin(z) / N_WATER))


def fresnel_t(cos_i):
    """Unpolarised air-to-water transmittance from the cosine of the incidence angle (in air)."""
    ci = np.clip(np.asarray(cos_i, dtype=float), 1e-9, 1.0)
    si = np.sqrt(1.0 - ci * ci); st = si / N_WATER; ct = np.sqrt(1.0 - st * st)
    rs = (ci - N_WATER * ct) / (ci + N_WATER * ct)
    rp = (ct - N_WATER * ci) / (ct + N_WATER * ci)
    return 1.0 - 0.5 * (rs * rs + rp * rp)


def sky_transmittance(n_theta: int = 2000) -> float:
    """Transmittance of a flat surface for a uniform (isotropic) sky: integral of T(theta) cos sin over the
    hemisphere, normalised. About 0.93 (Mobley 1994)."""
    th = (np.arange(n_theta) + 0.5) * (math.pi / 2) / n_theta
    w = np.cos(th) * np.sin(th)
    return float((fresnel_t(np.cos(th)) * w).sum() / w.sum())


def cox_munk_mss(wind_ms) -> np.ndarray:
    """Total mean-square sea-surface slope (Cox and Munk 1954, clean surface)."""
    u = np.clip(np.asarray(wind_ms, dtype=float), 0.0, None)
    return 0.003 + 5.12e-3 * u


# ------------------------------------------------------------------ deterministic wave facets
def _halton(i: int, base: int) -> float:
    f, r = 1.0, 0.0
    while i > 0:
        f /= base
        r += f * (i % base)
        i //= base
    return r


def _inv_norm(p: float) -> float:
    """Inverse standard normal CDF (Acklam's rational approximation, |error| < 1.2e-9)."""
    a = (-3.969683028665376e+01, 2.209460984245205e+02, -2.759285104469687e+02, 1.383577518672690e+02, -3.066479806614716e+01, 2.506628277459239e+00)
    b = (-5.447609879822406e+01, 1.615858368580409e+02, -1.556989798598866e+02, 6.680131188771972e+01, -1.328068155288572e+01)
    c = (-7.784894002430293e-03, -3.223964580411365e-01, -2.400758277161838e+00, -2.549732539343734e+00, 4.374664141464968e+00, 2.938163982698783e+00)
    d = (7.784695709041462e-03, 3.224671290700398e-01, 2.445134137142996e+00, 3.754408661907416e+00)
    pl = 0.02425
    if p < pl:
        q = math.sqrt(-2 * math.log(p))
        return (((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) / ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1)
    if p > 1 - pl:
        q = math.sqrt(-2 * math.log(1 - p))
        return -(((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) / ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1)
    q = p - 0.5; r = q * q
    return (((((a[0] * r + a[1]) * r + a[2]) * r + a[3]) * r + a[4]) * r + a[5]) * q / (((((b[0] * r + b[1]) * r + b[2]) * r + b[3]) * r + b[4]) * r + 1)


def unit_facets(n: int) -> np.ndarray:
    """n deterministic standard-normal 2-D points (Halton bases 2 and 3, skipping index 0)."""
    out = np.empty((n, 2))
    for i in range(n):
        out[i, 0] = _inv_norm(_halton(i + 1, 2))
        out[i, 1] = _inv_norm(_halton(i + 1, 3))
    return out


def refracted_sun_rays(zenith_air_deg: float, azimuth_deg: float, wind_ms: float, n_facets: int = 64):
    """Refracted sun rays below a wavy surface.
    Returns (dirs, weights): dirs are unit vectors pointing UP toward where the light comes from
    (x east, y north, z up), weights sum to 1 and include the facet's projected area and Fresnel
    transmission. With wind <= 0 (or n_facets == 0) a single flat-surface ray is returned with weight 1.
    Facets tilted away from the sun get zero weight; shadowing between facets and multiple reflections
    are ignored (as in the Sipaway paper's wave model)."""
    z = math.radians(min(max(zenith_air_deg, 0.0), 89.9)); a = math.radians(azimuth_deg)
    s = np.array([math.sin(z) * math.sin(a), math.sin(z) * math.cos(a), math.cos(z)])   # toward the sun
    eta = 1.0 / N_WATER
    if wind_ms is None or not np.isfinite(wind_ms) or wind_ms <= 0 or n_facets == 0:
        normals = np.array([[0.0, 0.0, 1.0]]); prob = np.array([1.0])
    else:
        sc = math.sqrt(float(cox_munk_mss(wind_ms)) / 2.0)
        uf = unit_facets(n_facets) * sc                        # slopes (sx, sy)
        nn = np.sqrt(uf[:, 0] ** 2 + uf[:, 1] ** 2 + 1.0)
        normals = np.stack([-uf[:, 0] / nn, -uf[:, 1] / nn, 1.0 / nn], axis=1)
        prob = np.full(n_facets, 1.0 / n_facets) * nn          # projected-area factor 1/cos(beta)
    ci = normals @ s                                           # cos(local incidence)
    k = 1.0 - eta * eta * (1.0 - np.clip(ci, -1, 1) ** 2)
    ok = (ci > 0) & (k > 0)
    # refracted propagation direction t = eta*d + (eta*ci - sqrt(k)) n, with d = -s (downward)
    fac = eta * ci - np.sqrt(np.clip(k, 0, None))
    t = -eta * s[None, :] + fac[:, None] * normals
    w = prob * np.clip(ci, 0, None) * fresnel_t(np.clip(ci, 1e-9, 1)) / max(float(np.clip(s[2], 1e-9, 1)), 1e-9)
    w = np.where(ok & (t[:, 2] < 0), w, 0.0)
    up = -t / np.linalg.norm(t, axis=1, keepdims=True)         # toward the light source
    tot = w.sum()
    return up, (w / tot if tot > 0 else w), float(tot)
