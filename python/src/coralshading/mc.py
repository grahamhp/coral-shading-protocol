"""Monte Carlo radiative transfer in the water column (reference engine and table builder).

Physics (shared/references.json):
- Homogeneous water with absorption a and scattering b (beam attenuation c = a + b, single-scattering
  albedo w0 = b / c). Scattering angles follow the Fournier-Forand phase function (Fournier and Forand 1994,
  in the form of Mobley et al. 2002) with n = 1.10 and mu = 3.5835, which gives the backscatter fraction
  0.0183 of Petzold's (1972) average ocean measurements. Henyey-Greenstein is available for comparison.
- Flat sea surface: Fresnel transmission, Snell refraction (n = 1.34) and total internal reflection.
  Uniform sky; the sun enters as a refracted beam.

Two estimators:
- forward_tables(): photons enter at the surface and are tallied each time they cross horizontal planes at
  chosen optical depths. Photon flux through a plane is planar irradiance, so each crossing adds its weight;
  crossings are also binned by direction. This gives the open-water downwelling irradiance and its angular
  distribution at many depths in one run, used to build the fast engine's tables.
- backward_point(): importance paths from one receiver point (3-D, with panels), next-event estimation to the
  sun. This is the reference the fast engine is checked against.
Optical depth units: forward_tables works in c = 1 units (depth tau = c z).
"""
from __future__ import annotations

import math
from functools import lru_cache

import numpy as np

from .optics import N_WATER, fresnel_t

FF_N, FF_MU = 1.10, 3.5835


# ------------------------------------------------------------------ phase functions
def ff_phase(psi, n: float = FF_N, mu: float = FF_MU):
    """Fournier-Forand volume scattering phase function (sr-1), normalised over 4 pi (Mobley et al. 2002)."""
    psi = np.asarray(psi, dtype=float)
    nu = (3.0 - mu) / 2.0
    s2 = np.sin(psi / 2.0) ** 2
    k = 4.0 / (3.0 * (n - 1.0) ** 2)
    d = k * s2
    d180 = k
    dnu = np.power(np.maximum(d, 1e-300), nu)
    with np.errstate(divide="ignore", invalid="ignore"):
        main = (nu * (1 - d) - (1 - dnu) + (d * (1 - dnu) - nu * (1 - d)) / np.maximum(s2, 1e-300)) / (4 * math.pi * (1 - d) ** 2 * dnu)
    # removable singularity at d = 1: replace by the average of close neighbours
    bad = np.abs(1 - d) < 1e-4
    if np.any(bad):
        main = np.where(bad, np.nan, main)
    back = (1 - d180 ** nu) / (16 * math.pi * (d180 - 1) * d180 ** nu) * (3 * np.cos(psi) ** 2 - 1)
    out = main + back
    if np.any(bad):
        idx = np.where(bad)[0] if out.ndim else None
        if out.ndim:
            good = ~np.isnan(out)
            out[~good] = np.interp(psi[~good], psi[good], out[good])
        else:
            out = float(ff_phase(psi + 2e-4, n, mu) + ff_phase(psi - 2e-4, n, mu)) / 2
    return out


def ff_backscatter_fraction(n: float = FF_N, mu: float = FF_MU) -> float:
    nu = (3.0 - mu) / 2.0
    d90 = 4.0 / (3.0 * (n - 1.0) ** 2) * math.sin(math.pi / 4) ** 2
    return 1.0 - (1.0 - d90 ** (nu + 1) - 0.5 * (1.0 - d90 ** nu)) / ((1.0 - d90) * d90 ** nu)


def hg_phase(psi, g: float = 0.924):
    c = np.cos(np.asarray(psi, dtype=float))
    return (1 - g * g) / (4 * math.pi * (1 + g * g - 2 * g * c) ** 1.5)


@lru_cache(maxsize=4)
def _ff_table(n: float = FF_N, mu: float = FF_MU):
    """Tabulated cumulative distribution of the scattering angle for inverse-CDF sampling."""
    psi = np.concatenate([np.geomspace(1e-7, 0.05, 3000, endpoint=False), np.linspace(0.05, math.pi, 4000)])
    p = ff_phase(psi, n, mu) * 2 * math.pi * np.sin(psi)
    cdf = np.concatenate([[0.0], np.cumsum(0.5 * (p[1:] + p[:-1]) * np.diff(psi))])
    # mass below 1e-7 rad (p ~ psi^-0.42, tiny) is folded into the first point
    total = cdf[-1]
    return psi, cdf / total, total


def cone_fraction(cone_deg: float = 3.0) -> float:
    """Share of Fournier-Forand scattering within cone_deg of the forward direction (delta truncation)."""
    psi, cdf, _ = _ff_table()
    return float(np.interp(math.radians(cone_deg), psi, cdf))


def sample_scatter_cos(rng, size: int, phase: str = "ff", g: float = 0.924, cone_deg: float = 3.0) -> np.ndarray:
    """Scattering-angle cosines. 'ff' is delta-truncated: only angles beyond cone_deg are sampled (scattering
    within the cone is treated as no scattering, with the scattering coefficient reduced by the cone share)."""
    if phase == "hg":
        s = (1 - g * g) / (1 - g + 2 * g * rng.random(size))
        return (1 + g * g - s * s) / (2 * g)
    psi, cdf, _ = _ff_table()
    f = cone_fraction(cone_deg)
    return np.cos(np.interp(f + (1 - f) * rng.random(size), cdf, psi))


def phase_value(psi, phase: str = "ff", g: float = 0.924, cone_deg: float = 3.0):
    """Phase function used with sample_scatter_cos: truncated and renormalised for 'ff'."""
    if phase == "hg":
        return hg_phase(psi, g)
    f = cone_fraction(cone_deg)
    psi = np.asarray(psi, dtype=float)
    return np.where(psi >= math.radians(cone_deg), ff_phase(psi) / (1 - f), 0.0)


def effective_scattering(b: float, phase: str = "ff", cone_deg: float = 3.0) -> float:
    """Scattering coefficient after delta truncation (b for HG, b (1 - f_cone) for FF)."""
    return b if phase == "hg" else b * (1 - cone_fraction(cone_deg))


def _rotate(u, cost, phi):
    sint = np.sqrt(np.clip(1 - cost ** 2, 0, 1)); ux, uy, uz = u.T
    den = np.sqrt(np.clip(1 - uz ** 2, 1e-12, 1)); pole = np.abs(uz) > 0.99999
    nx = np.where(pole, sint * np.cos(phi), sint * (ux * uz * np.cos(phi) - uy * np.sin(phi)) / den + ux * cost)
    ny = np.where(pole, sint * np.sin(phi), sint * (uy * uz * np.cos(phi) + ux * np.sin(phi)) / den + uy * cost)
    nz = np.where(pole, np.sign(uz) * cost, -sint * np.cos(phi) * den + uz * cost)
    v = np.stack([nx, ny, nz], 1)
    return v / np.linalg.norm(v, axis=1, keepdims=True)


# ------------------------------------------------------------------ forward tallies (tables)
THETA_EDGES = np.radians(np.arange(0, 91, 3.0))           # 30 zenith bins of 3 deg
DPHI_EDGES = np.radians(np.arange(0, 181, 10.0))          # 18 relative-azimuth bins of 10 deg (symmetric)
CONE_DEG = 3.0                                            # forward-scattered light within 3 deg of the sun counts with the beam


def forward_tables(w0: float, source: str, sun_zenith_air_deg: float = 0.0, taus=(1.0, 2.0, 4.0), n_photons: int = 200_000,
                   seed: int = 1, phase: str = "ff", max_events: int = 400, chunk: int = 100_000,
                   split: bool = False) -> dict:
    """Open-water downwelling irradiance at optical depths `taus` (c = 1) per unit downwelling irradiance
    just below the surface. source = 'sun' (refracted beam) or 'sky' (uniform sky).
    Returns per tau: unscattered, cone (scattered within CONE_DEG of the refracted sun), total, and
    E_bins[theta, dphi] (planar-irradiance contribution of each direction bin, excluding unscattered and cone).
    The sun is placed at azimuth 0; dphi is the angle between the photon's travel azimuth reversed (where it
    comes from) and the sun's azimuth.
    split=True adds geometric splitting / Russian roulette between importance regions (see _transport_split),
    which keeps the photon population roughly constant with depth so that deep planes are as well resolved as
    shallow ones (unbiased; Lux & Koblinger 1991)."""
    rng = np.random.default_rng(seed)
    taus = np.asarray(sorted(taus), dtype=float)
    nT, nP = len(THETA_EDGES) - 1, len(DPHI_EDGES) - 1
    E_bins = np.zeros((len(taus), nT, nP)); E_unsc = np.zeros(len(taus)); E_cone = np.zeros(len(taus)); E_tot = np.zeros(len(taus))
    za = math.radians(sun_zenith_air_deg); zw = math.asin(math.sin(za) / N_WATER)
    s_from = np.array([0.0, math.sin(zw), math.cos(zw)])       # direction toward the refracted sun (y = sun azimuth)
    cos_cone = math.cos(math.radians(CONE_DEG))
    t_sky_mean = None
    b_eff = effective_scattering(w0, phase)                 # c = 1 units: a = 1 - w0, b = w0
    c_eff = (1.0 - w0) + b_eff
    w_eff = b_eff / c_eff
    done = 0
    while done < n_photons:
        n = min(chunk, n_photons - done); done += n
        if source == "sun":
            d = np.tile(-s_from, (n, 1)); w = np.ones(n)
        else:
            mu_a = np.sqrt(rng.random(n)); ph = 2 * math.pi * rng.random(n)       # cosine-weighted sky in air
            T = fresnel_t(mu_a)
            sa = np.sqrt(1 - mu_a ** 2); sw = sa / N_WATER; cw = np.sqrt(1 - sw ** 2)
            d = np.stack([-sw * np.cos(ph), -sw * np.sin(ph), -cw], 1)
            if t_sky_mean is None:
                from .optics import sky_transmittance
                t_sky_mean = sky_transmittance()
            w = T / t_sky_mean
        if split:
            _transport_split(rng, d, w, taus, source, s_from, cos_cone, c_eff, w_eff, phase, w0,
                             E_tot, E_unsc, E_cone, E_bins)
            continue
        z = np.zeros(n)                        # optical depth below the surface (positive down)
        scattered = np.zeros(n, bool)
        alive = np.ones(n, bool)
        for _ in range(max_events):
            idx = np.where(alive)[0]
            if len(idx) == 0:
                break
            dd = d[idx]; zz = z[idx]; ww = w[idx]
            step = rng.exponential(1.0, len(idx)) / c_eff         # free path in c = 1 units (truncated medium)
            dz = -dd[:, 2] * step                                # depth increase (down positive)
            z_new = zz + dz
            # tally crossings of each plane between zz and z_new (downward only, for Ed)
            down = dd[:, 2] < 0
            for k, tk in enumerate(taus):
                cross = down & (zz < tk) & (z_new >= tk)
                if not cross.any():
                    continue
                ci = idx[cross]
                wc = ww[cross]
                E_tot[k] += wc.sum()
                unsc = ~scattered[ci]
                E_unsc[k] += wc[unsc].sum()
                # sun: unscattered light is the beam (tallied apart); sky: it arrives from many directions, so bin it
                sc = ~unsc if source == "sun" else np.ones(len(ci), bool)
                if sc.any():
                    frm = -dd[cross][sc]                         # where light comes from (upward unit vector)
                    ccone = frm @ s_from if source == "sun" else np.full(sc.sum(), -1.0)
                    in_cone = ccone >= cos_cone
                    E_cone[k] += wc[sc][in_cone].sum()
                    th = np.arccos(np.clip(frm[~in_cone, 2], -1, 1))
                    phi = np.abs(np.arctan2(frm[~in_cone, 0], frm[~in_cone, 1]))   # 0..pi from the sun azimuth
                    ti = np.clip(np.searchsorted(THETA_EDGES, th, side="right") - 1, 0, nT - 1)
                    pi_ = np.clip(np.searchsorted(DPHI_EDGES, phi, side="right") - 1, 0, nP - 1)
                    np.add.at(E_bins[k], (ti, pi_), wc[sc][~in_cone])
            # photons reaching the surface from below: the transmitted part escapes; the reflected part
            # (Fresnel R, or all of it beyond Snell's window) turns down and starts a new free path from the
            # surface without scattering (exact, because free paths are memoryless)
            up_out = z_new < 0
            if up_out.any():
                ui = np.where(up_out)[0]
                mu_up = -dd[ui, 2]
                sa = N_WATER * np.sqrt(np.clip(1 - mu_up ** 2, 0, 1))
                R = np.where(sa >= 1, 1.0, 1 - fresnel_t(np.sqrt(np.clip(1 - sa ** 2, 0, 1))))
                z_new[ui] = 0.0
                dd[ui, 2] = -dd[ui, 2]
                ww[ui] = ww[ui] * R
            beyond = z_new > taus[-1] + 5.0                      # far below the deepest plane: negligible return
            sc_now = ~up_out                                     # photons that scatter at the end of this step
            ww = np.where(sc_now, ww * w_eff, ww)                # survival weighting at the scattering event
            ct = sample_scatter_cos(rng, len(idx), phase)
            ph = 2 * math.pi * rng.random(len(idx))
            dd_s = _rotate(dd, ct, ph)
            dd = np.where(sc_now[:, None], dd_s, dd)
            z[idx] = z_new; d[idx] = dd; w[idx] = ww
            scattered[idx] = scattered[idx] | sc_now | up_out
            kill = beyond | (ww < 1e-4)
            rr = (ww < 0.02) & ~kill
            surv = rng.random(len(idx)) < 0.5
            w[idx[rr & surv]] *= 2
            kill |= rr & ~surv
            alive[idx[kill]] = False
    N = float(n_photons)
    return dict(taus=taus.tolist(), unscattered=(E_unsc / N).tolist(), cone=(E_cone / N).tolist(), total=(E_tot / N).tolist(),
                bins=(E_bins / N).tolist(), w0=w0, source=source, sun_zenith_air_deg=sun_zenith_air_deg, n=n_photons, phase=phase)


SPLIT_KAPPA = {0.5: 0.55, 0.6: 0.45, 0.7: 0.37, 0.8: 0.28, 0.9: 0.18}   # rough decay rates (c = 1) to space regions


def _tally(k, cross_w, frm, unsc, source, s_from, cos_cone, E_tot, E_unsc, E_cone, E_bins):
    nT, nP = len(THETA_EDGES) - 1, len(DPHI_EDGES) - 1
    E_tot[k] += cross_w.sum()
    E_unsc[k] += cross_w[unsc].sum()
    sc = ~unsc if source == "sun" else np.ones(len(cross_w), bool)
    if sc.any():
        f = frm[sc]; wc = cross_w[sc]
        ccone = f @ s_from if source == "sun" else np.full(len(wc), -1.0)
        in_cone = ccone >= cos_cone
        E_cone[k] += wc[in_cone].sum()
        th = np.arccos(np.clip(f[~in_cone, 2], -1, 1))
        phi = np.abs(np.arctan2(f[~in_cone, 0], f[~in_cone, 1]))
        ti = np.clip(np.searchsorted(THETA_EDGES, th, side="right") - 1, 0, nT - 1)
        pi_ = np.clip(np.searchsorted(DPHI_EDGES, phi, side="right") - 1, 0, nP - 1)
        np.add.at(E_bins[k], (ti, pi_), wc[~in_cone])


def _transport_split(rng, d, w, taus, source, s_from, cos_cone, c_eff, w_eff, phase, w0, E_tot, E_unsc, E_cone, E_bins,
                     max_events: int = 5000, max_split_exp: int = 4):
    """Transport one batch with geometric splitting. Importance regions are slabs of optical thickness
    dz = ln 2 / kappa (kappa ~ expected decay rate), importance 2**region. A photon entering a deeper region is
    split into 2**dr copies sharing its weight; one moving up is kept with probability 2**dr (weight / p).
    The low-weight roulette acts on the importance-weighted weight w * 2**region. All tallies are unbiased."""
    kappa = SPLIT_KAPPA.get(round(w0, 1), 0.55 * (1.0 - w0) / 0.5)
    dz_reg = math.log(2.0) / kappa
    n = len(w)
    z = np.zeros(n); scattered = np.zeros(n, bool); reg = np.zeros(n, np.int64)
    zmax = taus[-1] + 5.0
    for _ in range(max_events):
        if len(w) == 0:
            break
        step = rng.exponential(1.0, len(w)) / c_eff
        z_new = z - d[:, 2] * step
        lo = np.searchsorted(taus, z, side="right"); hi = np.searchsorted(taus, z_new, side="right")
        ci = np.where((d[:, 2] < 0) & (hi > lo))[0]        # planes k with z < tau_k <= z_new are crossed
        if len(ci):
            lc, hc = lo[ci], hi[ci]
            for k in range(int(lc.min()), int(hc.max())):
                sel = ci[(lc <= k) & (hc > k)]
                if len(sel):
                    _tally(k, w[sel], -d[sel], ~scattered[sel], source, s_from, cos_cone, E_tot, E_unsc, E_cone, E_bins)
        up_out = z_new < 0
        if up_out.any():
            mu_up = -d[up_out, 2]
            sa = N_WATER * np.sqrt(np.clip(1 - mu_up ** 2, 0, 1))
            R = np.where(sa >= 1, 1.0, 1 - fresnel_t(np.sqrt(np.clip(1 - sa ** 2, 0, 1))))
            z_new[up_out] = 0.0
            d[up_out, 2] = -d[up_out, 2]
            w[up_out] *= R
        sc_now = ~up_out
        w = np.where(sc_now, w * w_eff, w)
        ct = sample_scatter_cos(rng, len(w), phase)
        ph = 2 * math.pi * rng.random(len(w))
        d = np.where(sc_now[:, None], _rotate(d, ct, ph), d)
        scattered = scattered | sc_now | up_out
        z = z_new
        r_new = np.floor(z / dz_reg).astype(np.int64)
        dr = r_new - reg
        kill = z > zmax
        upm = dr < 0
        if upm.any():                                      # moving to less important region: roulette
            p = np.power(2.0, dr[upm].astype(float))
            keep = rng.random(int(upm.sum())) < p
            wu = w[upm]; wu = np.where(keep, wu / p, 0.0); w[upm] = wu
            ki = np.where(upm)[0][~keep]; kill[ki] = True
        reg = r_new
        wi = w * np.power(2.0, reg.astype(float))          # importance-weighted weight
        rr = (wi < 0.02) & ~kill
        surv = rng.random(len(w)) < 0.5
        w = np.where(rr & surv, w * 2.0, w)
        kill |= (rr & ~surv) | (wi < 1e-6)
        keep = ~kill
        d, z, w, scattered, reg, dr = d[keep], z[keep], w[keep], scattered[keep], reg[keep], dr[keep]
        dn = dr > 0                                        # moving deeper: split
        if dn.any():
            e = np.minimum(dr[dn], max_split_exp)
            m = np.power(2, e)
            w[dn] = w[dn] / m
            rep = np.ones(len(w), np.int64); rep[dn] = m
            d, z, w, scattered, reg = (np.repeat(d, rep, axis=0), np.repeat(z, rep), np.repeat(w, rep),
                                       np.repeat(scattered, rep), np.repeat(reg, rep))

# ------------------------------------------------------------------ backward point estimator (3-D, panels)
def backward_point(px: float, py: float, depth: float, a: float, b: float, panels=(), sun_zenith_air_deg: float = 20.0,
                   sun_azimuth_deg: float = 0.0, e_dir_h_air: float = 1.0, e_dif_air: float = 0.0, bottom_below: float = 0.5,
                   albedo: float = 0.0, n_paths: int = 150_000, seed: int = 1, phase: str = "ff", max_events: int = 200) -> dict:
    """Planar downwelling irradiance at (px, py) on the target plane (depth below the surface), with panels.
    Physical units (m, m-1). Panels follow geometry.Panel (submerged only: height < depth)."""
    rng = np.random.default_rng(seed)
    b = effective_scattering(b, phase); c = a + b           # delta-truncated medium (beam includes the 3-deg cone)
    za = math.radians(sun_zenith_air_deg); zw = math.asin(math.sin(za) / N_WATER); azr = math.radians(sun_azimuth_deg)
    s_hat = np.array([math.sin(zw) * math.sin(azr), math.sin(zw) * math.cos(azr), math.cos(zw)])
    Tsun = float(fresnel_t(math.cos(za)))
    E_n = e_dir_h_air * Tsun / math.cos(zw)
    Lsky = N_WATER ** 2 * e_dif_air / math.pi

    def tau_seg(p, u, s):
        out = np.ones(len(p))
        for pan in panels:
            with np.errstate(divide="ignore", invalid="ignore"):
                t = (pan.height - p[:, 2]) / u[:, 2]
            ok = (t > 0) & (t < s)
            hit = ok & pan.inside(p[:, 0] + t * u[:, 0], p[:, 1] + t * u[:, 1])
            out = np.where(hit, out * pan.tau, out)
        return out

    p0 = np.array([[px, py, 0.0]]); L0 = depth / math.cos(zw)
    E_unsc = E_n * math.exp(-c * L0) * math.cos(zw) * float(tau_seg(p0, s_hat[None, :], np.array([L0]))[0])
    mu = np.sqrt(rng.random(n_paths)); ph = 2 * math.pi * rng.random(n_paths); st = np.sqrt(1 - mu ** 2)
    u = np.stack([st * np.cos(ph), st * np.sin(ph), mu], 1); p = np.repeat(p0, n_paths, 0); w = np.ones(n_paths)
    alive = np.ones(n_paths, bool); acc = np.zeros(n_paths)
    for _ in range(max_events):
        idx = np.where(alive)[0]
        if len(idx) == 0:
            break
        pp, uu, ww = p[idx], u[idx], w[idx]; n = len(idx)
        s = rng.exponential(1 / b, n)
        with np.errstate(divide="ignore", invalid="ignore"):
            tsurf = np.where(uu[:, 2] > 0, (depth - pp[:, 2]) / uu[:, 2], np.inf)
            tbot = np.where(uu[:, 2] < 0, (-bottom_below - pp[:, 2]) / uu[:, 2], np.inf)
        tb = np.minimum(tsurf, tbot); seg = np.minimum(s, tb)
        ww = ww * np.exp(-a * seg) * tau_seg(pp, uu, seg)
        newp = pp + seg[:, None] * uu; newu = uu.copy(); neww = ww.copy(); keep = np.zeros(n, bool)
        rs_ = (tsurf <= s) & (tsurf <= tbot); rb_ = (tbot < s) & (tbot < tsurf); sc_ = s < tb
        if rs_.any():
            ii = np.where(rs_)[0]; sa = N_WATER * np.sqrt(1 - uu[ii, 2] ** 2)
            T = np.where(sa < 1, fresnel_t(np.sqrt(np.clip(1 - sa ** 2, 0, 1))), 0.0)
            acc[idx[ii]] += ww[ii] * T * Lsky
            newu[ii, 2] = -newu[ii, 2]; neww[ii] = ww[ii] * (1 - T); keep[ii] = (1 - T) > 1e-3
        if rb_.any() and albedo > 0:
            ii = np.where(rb_)[0]; pb = newp[ii]; Ls = (depth - pb[:, 2]) / math.cos(zw)
            vis = tau_seg(pb, np.repeat(s_hat[None, :], len(ii), 0), Ls)
            acc[idx[ii]] += ww[ii] * albedo / math.pi * E_n * math.cos(zw) * np.exp(-c * Ls) * vis
            m2 = np.sqrt(rng.random(len(ii))); ph2 = 2 * math.pi * rng.random(len(ii)); s2 = np.sqrt(1 - m2 ** 2)
            newu[ii] = np.stack([s2 * np.cos(ph2), s2 * np.sin(ph2), m2], 1); neww[ii] = ww[ii] * albedo; keep[ii] = True
        if sc_.any():
            ii = np.where(sc_)[0]; pv = newp[ii]
            psi = np.arccos(np.clip(uu[ii] @ s_hat, -1, 1)); Ls = (depth - pv[:, 2]) / math.cos(zw)
            vis = tau_seg(pv, np.repeat(s_hat[None, :], len(ii), 0), Ls)
            acc[idx[ii]] += ww[ii] * phase_value(psi, phase) * E_n * np.exp(-c * Ls) * vis
            ct = sample_scatter_cos(rng, len(ii), phase); ph3 = 2 * math.pi * rng.random(len(ii))
            newu[ii] = _rotate(uu[ii], ct, ph3); keep[ii] = True
        rr = keep & (neww < 0.02); surv = rng.random(n) < 0.5
        neww = np.where(rr & surv, neww * 2, neww); keep = keep & ~(rr & ~surv)
        p[idx], u[idx], w[idx] = newp, newu, neww; alive[idx] = keep
    return dict(Ed=E_unsc + math.pi * acc.mean(), unscattered=E_unsc, scattered=math.pi * acc.mean(),
                se=math.pi * acc.std() / math.sqrt(n_paths))
