"""Coral photosynthesis–irradiance (P–E) model and daily light metrics.

P_gross(E) = Pmax tanh(E / Ek)   (Jassby & Platt 1976; Chalker 1981 for corals). Rates are expressed relative to
Pmax, so only Ek (and, for net metrics, R/Pg = dark respiration / Pmax from the same or a matched study) are needed.

Daily metrics for each point (E in umol photons m-2 s-1 on a regular grid of `step` minutes):
- dli:              daily light integral, mol photons m-2 d-1
- peak:             highest irradiance, umol m-2 s-1
- hours_above_ek:   hours with E > Ek
- light_above_ek:   integral of max(E - Ek, 0), mol photons m-2 d-1 (light beyond saturation)
- gross_hours:      integral of tanh(E/Ek) dt, in hours at Pmax ("Pmax-hours"); daily gross photosynthesis = Pmax x this
- gross_vs_open:    gross_hours relative to the same day in open water at the same depth
- pr_daily:         daily P:R = gross_hours / (24 R/Pg)   (only when R/Pg is given; dark respiration all day)
- ec:               compensation irradiance Ek atanh(R/Pg)
- hours_<zone>, light_<zone> (and open_ for open water): time (h) and light (mol m-2) per day in four zones of the
  P-E curve: below_ec (E < Ec), limited (Ec-Ek), near_sat (Ek-2Ek), saturated (> 2Ek); daylight only

Photoacclimation (Ek tracks the growth irradiance: Falkowski & Dubinsky 1981; Anthony & Hoegh-Guldberg 2003; the
compiled curves of Sawall & Hochberg 2018 have Ek/Emax 0.14-0.52). Modes:
- "none":  Ek as measured in the source colonies;
- "site":  corals acclimated to open water at the target depth (they grew there before shading):
           Ek = (Ek/Emax of the source) x peak open-water irradiance at the target depth (default);
- "shade": corals fully acclimated to the light at their own position under the structure:
           Ek = (Ek/Emax of the source) x the point's own peak irradiance.
- "time" (v5.1): corals start acclimated to open water ("site") and adjust each day toward (Ek/Emax) x that day's
           peak irradiance at their own position, exponentially with a time constant of ACCLIMATION_DAYS. Anthony and
           Hoegh-Guldberg (2003) found that Ik changed exponentially after shifts in growth light and reached new
           stable levels within 5-10 days (Turbinaria mesenterina); a time constant of 2.5 days puts 95 % of the change
           within 7.5 days. Day k uses the Ek reached after the light of days 0..k-1.
The peak is the 90th percentile of daily peaks when several days are given ("site", "shade"). Presets without Ek/Emax
use "none".

How far the corals adjust (v5.2): extent, 0 to 1. In "time" and "shade" the Ek the corals move to is
    Ek_site + extent x (Ek matched to the shade - Ek_site),
so 1 is full adjustment (the modes as described above), 0 leaves the corals as in "site", and values between are a
partial adjustment. The published observations are of full adjustment in corals that were not heat-stressed; a low
extent is a cautious design assumption, not a measured value.
"""
from __future__ import annotations

import json
import math
from dataclasses import dataclass

import numpy as np

from . import SHARED


def load_presets(path: str | None = None) -> dict:
    p = path or (SHARED / "corals" / "pe_presets.json")
    return json.loads(open(p, encoding="utf-8").read())


@dataclass
class Coral:
    ek: float                          # umol photons m-2 s-1
    r_over_pg: float | None = None     # dark respiration / Pmax (gross)
    ek_emax: float | None = None       # Ek / peak irradiance of the source colonies (for photoacclimation)
    acclimate: str = "none"            # "none" | "site" | "shade" | "time"
    label: str = "custom"
    extent: float = 1.0                # how far Ek moves from "site" to the shade in "time" and "shade" (0-1)

    @classmethod
    def preset(cls, pid: str, acclimate: str = "none", presets: dict | None = None, extent: float = 1.0) -> "Coral":
        P = presets or load_presets()
        p = next(x for x in P["presets"] if x["id"] == pid)
        return cls(ek=float(p["Ek"]), r_over_pg=p.get("R_over_Pg"), ek_emax=p.get("Ek_Emax"), acclimate=acclimate, label=p["label"],
                   extent=extent)


def _p90_peak(days3: np.ndarray) -> np.ndarray:
    """days3: [day, time, point] -> 90th percentile over days of the daily peak, per point."""
    peaks = days3.max(axis=1)
    return np.percentile(peaks, 90, axis=0) if peaks.shape[0] > 1 else peaks[0]


ACCLIMATION_DAYS = 2.5


def effective_ek(coral: Coral, ed_days: np.ndarray, ed_open_days: np.ndarray | None = None) -> np.ndarray:
    """Ek per point ([point]), or per day and point ([day, point]) for acclimation over time.
    ed_days: [day, time, point] (or [time, point]); ed_open_days: [day, time] (or [time])."""
    e = ed_days if ed_days.ndim == 3 else ed_days[None]
    npnt = e.shape[2]
    mode = coral.acclimate if coral.ek_emax else "none"
    x = float(coral.extent)
    if not 0.0 <= x <= 1.0:
        raise ValueError("the extent of acclimation must be between 0 and 1")
    site = None
    if mode == "site" or mode == "time" or (mode == "shade" and x < 1.0):
        if ed_open_days is None:
            raise ValueError("acclimation over time needs the open-water light" if mode == "time" else "site acclimation needs the open-water light")
        o = np.asarray(ed_open_days, float); o = o if o.ndim == 2 else o[None]
        site = max(coral.ek_emax * float(_p90_peak(o[:, :, None])[0]), 1.0)
    if mode == "time":
        cur = np.full(npnt, site)
        f = 1.0 - math.exp(-1.0 / ACCLIMATION_DAYS)
        out = np.empty((e.shape[0], npnt))
        for k in range(e.shape[0]):
            out[k] = cur
            tgt = np.maximum(coral.ek_emax * e[k].max(axis=0), 1.0)
            if x < 1.0:
                tgt = site + x * (tgt - site)
            cur = cur + f * (tgt - cur)
        return out
    if mode == "shade":
        full = np.maximum(coral.ek_emax * _p90_peak(e), 1.0)
        return full if x >= 1.0 else site + x * (full - site)
    if mode == "site":
        return np.full(npnt, site)
    return np.full(npnt, coral.ek)


def day_metrics(ed: np.ndarray, step_min: float, coral: Coral, ek: np.ndarray | None = None, ed_open: np.ndarray | None = None) -> dict:
    """Metrics for one day. ed: [time, point]; ed_open: [time] (open water at the same depth) or None."""
    ed = np.asarray(ed, float)
    ek = np.full(ed.shape[1], coral.ek) if ek is None else np.asarray(ek, float)
    dt_s = step_min * 60.0
    out = dict(
        dli=ed.sum(axis=0) * dt_s / 1e6,
        peak=ed.max(axis=0),
        hours_above_ek=(ed > ek[None, :]).sum(axis=0) * step_min / 60.0,
        light_above_ek=np.clip(ed - ek[None, :], 0, None).sum(axis=0) * dt_s / 1e6,
        gross_hours=np.tanh(ed / ek[None, :]).sum(axis=0) * step_min / 60.0,
        ek=ek,
    )
    if ed_open is not None:
        g_open = np.tanh(np.asarray(ed_open, float)[:, None] / ek[None, :]).sum(axis=0) * step_min / 60.0
        out["gross_vs_open"] = np.where(g_open > 0, out["gross_hours"] / np.where(g_open > 0, g_open, 1.0), np.nan)
    if coral.r_over_pg:
        r = coral.r_over_pg
        out["pr_daily"] = out["gross_hours"] / (24.0 * r)
        out["ec"] = ek * math.atanh(min(r, 0.999999))
    # Time and light in four zones of the P-E curve (daylight only): below compensation (E < Ec; only when R/Pg is
    # known), light-limited (Ec-Ek, P below 76 % of Pmax), near saturation (Ek-2Ek, 76-96 %), saturated (> 2Ek).
    ec = out["ec"] if "ec" in out else np.zeros_like(ek)
    def zones(e2, prefix):
        pos = e2 > 0
        masks = dict(below_ec=pos & (e2 < ec[None, :]), limited=pos & (e2 >= ec[None, :]) & (e2 < ek[None, :]),
                     near_sat=pos & (e2 >= ek[None, :]) & (e2 < 2 * ek[None, :]), saturated=pos & (e2 >= 2 * ek[None, :]))
        for z, msk in masks.items():
            out[f"{prefix}hours_{z}"] = msk.sum(axis=0) * step_min / 60.0
            out[f"{prefix}light_{z}"] = np.where(msk, e2, 0.0).sum(axis=0) * dt_s / 1e6
    zones(ed, "")
    if ed_open is not None:
        zones(np.broadcast_to(np.asarray(ed_open, float)[:, None], ed.shape), "open_")
    return out


def summarize(values: np.ndarray, weights: np.ndarray | None = None) -> dict:
    """Area-weighted mean, minimum, maximum and 10th/90th percentiles over the target points."""
    v = np.asarray(values, float)
    w = np.ones_like(v) if weights is None else np.asarray(weights, float)
    order = np.argsort(v); cw = np.cumsum(w[order]) / w.sum()
    pct = lambda q: float(v[order][np.searchsorted(cw, q)])
    return dict(mean=float((v * w).sum() / w.sum()), min=float(v.min()), max=float(v.max()), p10=pct(0.10), p90=pct(0.90))
