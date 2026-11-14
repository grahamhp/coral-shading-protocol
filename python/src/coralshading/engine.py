"""Fast light engine: downwelling PAR at every point of the target, for any panels, through the day.

Method (checked against the 3-D Monte Carlo in mc.backward_point; see tests and docs/methods.md):
1. The water column is described by Kd (layer average from the surface to the target depth, for a reference
   midday sky: sun 20 deg from the zenith, 30 % diffuse light) and the single-scattering albedo w0. The tables
   (shared/tables/light_tables.json, from the forward Monte Carlo) convert these to the optical depth
   tau = c z and give, per unit downwelling irradiance just below the surface, the light arriving at depth
   as a sun beam (within 3 deg of the refracted sun) and as scattered light by direction.
2. Each panel blocks (or, for shade cloth, partly transmits) the directions it covers as seen from a point.
   The scattered light from those directions is removed (times the panel's transmission); the sun beam is
   removed when the refracted sun rays (one per wave facet) pass through a panel.
3. Light scattered inside the water between a panel and the point is not modelled separately; against the
   3-D Monte Carlo this makes shaded points read about 0.01 of open-water light too high.
Identical in webapp/src/core/engine.ts.
"""
from __future__ import annotations

import json
import math
from dataclasses import dataclass, field
from functools import lru_cache

import numpy as np

from . import SHARED, optics
from .geometry import Panel, transmission_along

REF_SUN_ZENITH = 20.0     # reference conditions defining the user's Kd
REF_DIFFUSE = 0.30
N_THETA_SUB = 3           # zenith sub-samples per 3-deg band for panel masks
N_PHI = 72                # azimuth samples (5 deg) for panel masks


@lru_cache(maxsize=2)
def load_tables(path: str | None = None) -> dict:
    p = SHARED / "tables" / "light_tables.json" if path is None else path
    t = json.loads(open(p, encoding="utf-8").read())
    t["_sun_A"] = np.array(t["sun_A"], dtype=float)          # [w0, sunz, tau, m, theta]
    t["_sun_beam"] = np.array(t["sun_beam"], dtype=float)    # [w0, sunz, tau]
    t["_sun_total"] = np.array(t["sun_total"], dtype=float)
    t["_sky_A0"] = np.array(t["sky_A0"], dtype=float)        # [w0, tau, theta]
    t["_sky_total"] = np.array(t["sky_total"], dtype=float)  # [w0, tau]
    return t


def _bracket(grid, x):
    g = np.asarray(grid, dtype=float)
    x = float(np.clip(x, g[0], g[-1]))
    i = int(np.clip(np.searchsorted(g, x, side="right") - 1, 0, len(g) - 2))
    f = (x - g[i]) / (g[i + 1] - g[i])
    return i, f


def _interp_w0_tau(arr_w0_tau, t, w0, tau):
    """Interpolate a table indexed [w0, ..., tau, ...] in w0 (linear) and log(tau) (linear); tau axis is
    given by position: arr has shape [nw0, ntau, ...]."""
    iw, fw = _bracket(t["w0"], w0)
    it, ft = _bracket(np.log(t["taus"]), math.log(max(tau, 1e-9)))
    a = arr_w0_tau
    lo = (1 - ft) * a[iw, it] + ft * a[iw, it + 1]
    hi = (1 - ft) * a[iw + 1, it] + ft * a[iw + 1, it + 1]
    return (1 - fw) * lo + fw * hi


@dataclass
class Water:
    kd: float = 0.10       # m-1
    w0: float = 0.90       # single-scattering albedo of the water (PAR band)
    depth: float = 10.0    # m, depth of the target plane below the surface


@dataclass
class OpticalState:
    """Tables interpolated to one water column: everything the engine needs except geometry and time."""
    tau: float
    sun_zeniths: np.ndarray
    beam: np.ndarray          # [sunz]
    sun_total: np.ndarray     # [sunz]
    sun_A: np.ndarray         # [sunz, m, theta]
    sky_A0: np.ndarray        # [theta]
    sky_total: float
    theta_edges: np.ndarray   # radians


def optical_depth_for_kd(water: Water, tables: dict | None = None) -> float:
    """Optical depth tau = c z whose reference-condition Kd over 0..z equals water.kd."""
    t = tables or load_tables()
    target = water.kd * water.depth
    T_sun = float(optics.fresnel_t(math.cos(math.radians(REF_SUN_ZENITH)))); T_sky = optics.sky_transmittance()
    ws = (1 - REF_DIFFUSE) * T_sun / ((1 - REF_DIFFUSE) * T_sun + REF_DIFFUSE * T_sky)
    iz, fz = _bracket(t["sun_zeniths"], REF_SUN_ZENITH)
    taus = np.array(t["taus"])
    iw, fw = _bracket(t["w0"], water.w0)
    def G_at(iwx):
        sun = (1 - fz) * t["_sun_total"][iwx, iz] + fz * t["_sun_total"][iwx, iz + 1]
        return -np.log(np.clip(ws * sun + (1 - ws) * t["_sky_total"][iwx], 1e-300, None))
    G = (1 - fw) * G_at(iw) + fw * G_at(iw + 1)
    if target <= G[0]:
        return float(taus[0] * target / G[0])
    if target >= G[-1]:
        raise ValueError(f"Kd x depth = {target:.1f} is beyond the light tables (almost no light reaches this depth).")
    j = int(np.searchsorted(G, target) - 1)
    f = (target - G[j]) / (G[j + 1] - G[j])
    return float(math.exp((1 - f) * math.log(taus[j]) + f * math.log(taus[j + 1])))


def optical_state(water: Water, tables: dict | None = None) -> OpticalState:
    """Interpolate the tables to this water column: totals and beam log-linearly (light falls off roughly
    exponentially), angular shapes (coefficients divided by the totals) linearly; both in w0 and log(tau)."""
    t = tables or load_tables()
    tau = optical_depth_for_kd(water, t)
    lg = lambda x: np.log(np.clip(x, 1e-300, None))
    sun_tot_tw = np.moveaxis(t["_sun_total"], 2, 1)                                    # [w0, tau, sunz]
    tot = np.exp(_interp_w0_tau(lg(sun_tot_tw), t, water.w0, tau))                    # [sunz]
    beam = np.exp(_interp_w0_tau(lg(np.moveaxis(t["_sun_beam"], 2, 1)), t, water.w0, tau))
    shapeA = np.moveaxis(t["_sun_A"], 2, 1) / np.clip(sun_tot_tw, 1e-300, None)[..., None, None]
    A = _interp_w0_tau(shapeA, t, water.w0, tau) * tot[:, None, None]                 # [sunz, m, theta]
    skytot = float(np.exp(_interp_w0_tau(lg(t["_sky_total"])[:, :, None], t, water.w0, tau))[0])
    skyA0 = _interp_w0_tau(t["_sky_A0"] / np.clip(t["_sky_total"], 1e-300, None)[..., None], t, water.w0, tau) * skytot
    return OpticalState(tau=tau, sun_zeniths=np.array(t["sun_zeniths"], float), beam=beam, sun_total=tot, sun_A=A,
                        sky_A0=skyA0, sky_total=skytot, theta_edges=np.radians(np.array(t["theta_edges_deg"])))


def panel_moments(points_x, points_y, panels, water: Water, theta_edges, m_max: int = 4):
    """C[m][p, theta] and S[m][p, theta]: integrals over azimuth of the panels' transmission seen from each point
    (zenith-band averaged), times cos(m phi) and sin(m phi). Open water gives C0 = 2 pi, others 0."""
    px = np.asarray(points_x, float)[:, None]; py = np.asarray(points_y, float)[:, None]
    nT = len(theta_edges) - 1
    phis = (np.arange(N_PHI) + 0.5) * (2 * math.pi / N_PHI)
    C = np.zeros((m_max + 1, len(px), nT)); S = np.zeros((m_max + 1, len(px), nT))
    for i in range(nT):
        ths = theta_edges[i] + (np.arange(N_THETA_SUB) + 0.5) * (theta_edges[i + 1] - theta_edges[i]) / N_THETA_SUB
        tr = np.zeros((len(px), N_PHI))
        for th in ths:
            u = np.stack([np.sin(th) * np.sin(phis), np.sin(th) * np.cos(phis), np.full(N_PHI, np.cos(th))], axis=1)
            tr += transmission_along(px, py, u[None, :, :], panels, water.depth) if panels else 1.0
        tr /= N_THETA_SUB
        for m in range(m_max + 1):
            C[m, :, i] = (tr * np.cos(m * phis)[None, :]).sum(axis=1) * (2 * math.pi / N_PHI)
            S[m, :, i] = (tr * np.sin(m * phis)[None, :]).sum(axis=1) * (2 * math.pi / N_PHI)
    return C, S


@dataclass
class DayResult:
    minutes: np.ndarray
    step: float
    ed: np.ndarray            # [time, point] PAR at the target, umol m-2 s-1
    ed_open: np.ndarray       # [time] open water at the same depth
    sunlit: np.ndarray        # [time, point] share of the sun beam reaching the point (0..1)
    beam_part: np.ndarray     # [time, point] beam contribution
    meta: dict = field(default_factory=dict)

    def dli(self):            # mol m-2 d-1 per point
        return self.ed.sum(axis=0) * self.step * 60 / 1e6

    def dli_open(self):
        return float(self.ed_open.sum() * self.step * 60 / 1e6)


def _interp_sunz(st: OpticalState, zen_deg):
    """Beam, sun_total and A at given sun zenith(s) (linear in zenith)."""
    z = np.clip(np.asarray(zen_deg, float), st.sun_zeniths[0], st.sun_zeniths[-1])
    i = np.clip(np.searchsorted(st.sun_zeniths, z, side="right") - 1, 0, len(st.sun_zeniths) - 2)
    f = (z - st.sun_zeniths[i]) / (st.sun_zeniths[i + 1] - st.sun_zeniths[i])
    lb = np.log(np.clip(st.beam, 1e-300, None))
    beam = np.exp((1 - f) * lb[i] + f * lb[i + 1])
    A = (1 - f)[:, None, None] * st.sun_A[i] + f[:, None, None] * st.sun_A[i + 1]
    return beam, A


def run_day(day, water: Water, panels, points_x, points_y, n_facets: int = 64, state: OpticalState | None = None,
            moments=None) -> DayResult:
    """Light at each point through one day. `day` is a surface.DayLight."""
    st = state or optical_state(water)
    C, S = moments if moments is not None else panel_moments(points_x, points_y, panels, water, st.theta_edges)
    px = np.asarray(points_x, float); py = np.asarray(points_y, float)
    nt = len(day.minutes); npnt = len(px)
    up = day.zenith < 90.0
    ed = np.zeros((nt, npnt)); ed_open = np.zeros(nt); sunlit = np.zeros((nt, npnt)); beam_part = np.zeros((nt, npnt))
    T_sky = optics.sky_transmittance()
    beam_z, A_z = _interp_sunz(st, day.zenith)
    sky_masked = (st.sky_A0[None, :] * C[0]).sum(axis=1)                      # [point]
    for k in np.where(up)[0]:
        wind = day.wind[k] if np.isfinite(day.wind[k]) else 0.0
        dirs, wts, T_sun = optics.refracted_sun_rays(float(day.zenith[k]), float(day.azimuth[k]), wind, n_facets)
        Fs = day.par_direct_h[k] * T_sun; Fk = day.par_diffuse[k] * T_sky
        # sun beam visibility: average over facets of panel transmission along each refracted ray
        sa = math.radians(day.azimuth[k]); za = math.radians(min(day.zenith[k], 89.9))
        air = (math.sin(za) * math.sin(sa), math.sin(za) * math.cos(sa), math.cos(za))
        if panels:
            vis = np.zeros(npnt)
            for d, wf in zip(dirs, wts):
                if wf > 0:
                    vis += wf * transmission_along(px, py, d, panels, water.depth, air_dir=air)
        else:
            vis = np.ones(npnt)
        phis = math.radians(day.azimuth[k])
        Ak = A_z[k]                                                               # [m, theta]
        broad = np.zeros(npnt)
        for m in range(Ak.shape[0]):
            broad += (Ak[m][None, :] * (math.cos(m * phis) * C[m] + math.sin(m * phis) * S[m])).sum(axis=1)
        sun_open = beam_z[k] + 2 * math.pi * Ak[0].sum()
        ed[k] = Fs * (beam_z[k] * vis + broad) + Fk * sky_masked
        ed_open[k] = Fs * sun_open + Fk * 2 * math.pi * st.sky_A0.sum()
        sunlit[k] = vis; beam_part[k] = Fs * beam_z[k] * vis
    return DayResult(minutes=day.minutes, step=day.step, ed=ed, ed_open=ed_open, sunlit=sunlit, beam_part=beam_part,
                     meta=dict(tau=st.tau, kd=water.kd, w0=water.w0, depth=water.depth))
