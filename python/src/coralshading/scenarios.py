"""Shading scenarios, the design solver and design checks.

Scenarios (as in the Sipaway experiment and earlier app versions):
- constant: a shade cloth over the target all day (transmission tau; optionally clean / fouled with a time share);
- dynamic:  an opaque canopy that shades the target around midday and lets the low morning and afternoon sun in.
With `sync`, the dynamic canopy is sized so that its period light equals the constant scenario's ("equal daily
dose", the paper's design); otherwise each scenario has its own target.

The objective is the period transmission T = sum over days of the area-mean daily light at the target divided by
the sum of the open-water daily light at the same depth; the target reduction is 1 - T.

Solver (dynamic): the canopy's north-south size is set to cover the target plus the noon sun's north-south reach
over the period; the east-west width W is found by bisection (T decreases monotonically with W). Infeasible
targets are reported with the reason and the closest design (design document D2). Clearance (D4): points that
never get direct sun are flagged and the height rule H >= 2R / (tan theta_lit - tan theta_shade) is shown.
Robustness (D3): Kd, w0, wind and placement are varied and the spread reported.
"""
from __future__ import annotations

import math
from dataclasses import dataclass, field, replace

import numpy as np

from . import engine, optics, solar, surface
from .geometry import Panel, Target
from .pe import Coral, day_metrics, effective_ek


@dataclass
class Site:
    lat: float
    lon: float
    tz: float
    light: surface.HourlyLight
    noon_shift: float = 0.0           # minutes (user or data-derived solar-noon correction)
    step: float = 10.0                # minutes


def deployment_days(start: tuple, end: tuple, every: int = 1) -> list[tuple]:
    a = solar.days_from_civil(*start); b = solar.days_from_civil(*end)
    return [tuple(solar.civil_from_days(k)) for k in range(a, b + 1, every)]


@dataclass
class PeriodResult:
    days: list
    step: float
    ed: list                 # per day: [time, point]
    ed_open: list            # per day: [time]
    sunlit: list             # per day: [time, point]
    minutes: list
    zenith: list
    azimuth: list
    weights: np.ndarray      # point area weights
    light_dropped: float = 0.0   # share of the hourly light dropped by the timing guard (surface.day_light)

    def dli(self):           # [day, point]
        return np.array([e.sum(axis=0) * self.step * 60 / 1e6 for e in self.ed])

    def dli_open(self):      # [day]
        return np.array([e.sum() * self.step * 60 / 1e6 for e in self.ed_open])

    def transmission(self) -> float:
        """Period transmission: area-mean daily light summed over days / open-water daily light summed."""
        w = self.weights / self.weights.sum()
        return float((self.dli() @ w).sum() / self.dli_open().sum())

    def direct_sun_hours(self, threshold: float = 0.5):   # [day, point]
        return np.array([(s >= threshold).sum(axis=0) * self.step / 60 for s in self.sunlit])


def run_period(site: Site, water: engine.Water, panels, X, Y, days, n_facets: int = 16, wind_override: float | None = None,
               state: engine.OpticalState | None = None) -> PeriodResult:
    st = state or engine.optical_state(water)
    mom = engine.panel_moments(X, Y, panels, water, st.theta_edges)
    out = dict(ed=[], ed_open=[], sunlit=[], minutes=[], zenith=[], azimuth=[])
    tot = drop = 0.0
    for (y, m, d) in days:
        dl = surface.day_light(site.light, y, m, d, site.lat, site.lon, site.tz, step=site.step, noon_shift=site.noon_shift)
        tot += dl.light_total; drop += dl.light_dropped
        if wind_override is not None:
            dl = replace(dl, wind=np.full_like(dl.wind, float(wind_override)))
        r = engine.run_day(dl, water, panels, X, Y, n_facets=n_facets, state=st, moments=mom)
        out["ed"].append(r.ed); out["ed_open"].append(r.ed_open); out["sunlit"].append(r.sunlit)
        out["minutes"].append(dl.minutes); out["zenith"].append(dl.zenith); out["azimuth"].append(dl.azimuth)
    return PeriodResult(days=list(days), step=site.step, weights=np.ones(len(X)), light_dropped=drop / tot if tot > 0 else 0.0, **out)


# ------------------------------------------------------------------ constant scenario (shade cloth)

def max_refracted_tan(site: Site, days, min_elevation: float = 0.0) -> tuple[float, float]:
    """Largest tan(refracted zenith) of the sun in the east-west and north-south directions over the period,
    for sun elevations above min_elevation (degrees)."""
    tx = ty = 0.0
    for (y, m, d) in days:
        for minute in np.arange(0, 1440, 10.0):
            sp = solar.sun_with_noon(y, m, d, minute, site.lat, site.lon, site.tz, site.noon_shift)
            if 90 - float(sp.zenith) <= min_elevation:
                continue
            zw = math.radians(optics.refracted_zenith_deg(float(sp.zenith)))
            az = math.radians(float(sp.azimuth))
            tx = max(tx, abs(math.tan(zw) * math.sin(az))); ty = max(ty, abs(math.tan(zw) * math.cos(az)))
    return tx, ty


def default_cloth(target: Target, height: float, site: Site, days, tau: float) -> Panel:
    """A cloth large enough that the direct sun reaches the target only through it whenever the sun is more than
    10 degrees up (below that the light is small)."""
    tx, ty = max_refracted_tan(site, days, min_elevation=10.0)
    hx = target.lx / 2; hy = (target.ly if target.shape == "rect" else target.lx) / 2
    return Panel(lx=2 * (hx + height * tx), ly=2 * (hy + height * ty), height=height, tau=tau)


def constant_scenario(site, water, target: Target, height: float, days, tau_clean: float, tau_fouled: float | None = None,
                      fouled_share: float = 0.0, cloth: Panel | None = None, spacing: float = 0.05, n_facets: int = 16,
                      wind_override: float | None = None):
    """Shade cloth. With fouling, light is the time-weighted mix of the clean and fouled cloth (exact: light is
    linear in a single panel's transmission)."""
    X, Y = target.grid(spacing)
    base = cloth or default_cloth(target, height, site, days, tau_clean)
    clean = run_period(site, water, [replace(base, tau=tau_clean)], X, Y, days, n_facets, wind_override)
    if tau_fouled is None or fouled_share <= 0:
        return dict(panel=replace(base, tau=tau_clean), result=clean, X=X, Y=Y)
    foul = run_period(site, water, [replace(base, tau=tau_fouled)], X, Y, days, n_facets, wind_override)
    s = float(fouled_share)
    mixed = PeriodResult(days=clean.days, step=clean.step, weights=clean.weights, light_dropped=clean.light_dropped,
                         ed=[(1 - s) * a + s * b for a, b in zip(clean.ed, foul.ed)], ed_open=clean.ed_open,
                         sunlit=[(1 - s) * a + s * b for a, b in zip(clean.sunlit, foul.sunlit)],
                         minutes=clean.minutes, zenith=clean.zenith, azimuth=clean.azimuth)
    return dict(panel=replace(base, tau=tau_clean), result=mixed, X=X, Y=Y, clean=clean, fouled=foul, fouled_share=s)


# ------------------------------------------------------------------ dynamic scenario (opaque canopy) and solver

def canopy_ns_size(target: Target, height: float, site: Site, days, margin: float = 0.0) -> float:
    """North-south size: covers the target plus the noon sun's north-south reach over the period."""
    hy = (target.ly if target.shape == "rect" else target.lx) / 2
    ty = 0.0
    for (y, m, d) in days:
        noon = solar.solar_noon(y, m, d, site.lon, site.tz)                    # sun geometry at true solar noon
        sp = solar.solar_position(y, m, d, noon, site.lat, site.lon, site.tz)
        zw = math.radians(optics.refracted_zenith_deg(float(sp.zenith)))
        ty = max(ty, abs(math.tan(zw) * math.cos(math.radians(float(sp.azimuth)))))
    return 2 * (hy + height * ty) + margin


@dataclass
class SolveResult:
    feasible: bool
    panel: Panel
    transmission: float
    target_transmission: float
    iterations: int
    message: str
    history: list = field(default_factory=list)


def solve_dynamic(site, water, target: Target, height: float, days, target_transmission: float, ly: float | None = None,
                  w_max: float = 12.0, spacing: float = 0.1, n_facets: int = 16, solve_every: int = 5, tol: float = 0.002,
                  tol_T: float = 0.0005,
                  offset: tuple = (0.0, 0.0), wind_override: float | None = None, guess: float | None = None) -> SolveResult:
    """East-west width of an opaque canopy so that the period transmission matches the target."""
    solve_days = days[::solve_every] if solve_every > 1 else days
    X, Y = target.grid(spacing)
    LY = ly if ly is not None else canopy_ns_size(target, height, site, days)
    st = engine.optical_state(water)
    T = lambda W: run_period(site, water, [Panel(cx=offset[0], cy=offset[1], lx=W, ly=LY, height=height, tau=0.0)],
                             X, Y, solve_days, n_facets, wind_override=wind_override, state=st).transmission()
    hist = []
    lo, hi = 0.01, w_max
    if guess and 0.02 < guess < w_max:
        # warm start: bracket around the previous answer, widening until the target is inside
        lo, hi = max(0.01, guess * 0.85), min(w_max, guess * 1.18)
        t_lo, t_hi = T(lo), T(hi)
        hist += [(lo, t_lo), (hi, t_hi)]
        while t_lo < target_transmission and lo > 0.01:
            hi, t_hi = lo, t_lo; lo = max(0.01, lo / 1.5); t_lo = T(lo); hist.append((lo, t_lo))
        while t_hi > target_transmission and hi < w_max:
            lo, t_lo = hi, t_hi; hi = min(w_max, hi * 1.5); t_hi = T(hi); hist.append((hi, t_hi))
    else:
        t_lo, t_hi = T(lo), T(hi)
        hist += [(lo, t_lo), (hi, t_hi)]
    if target_transmission < t_hi:
        return SolveResult(False, Panel(cx=offset[0], cy=offset[1], lx=hi, ly=LY, height=height, tau=0.0), t_hi, target_transmission, 2,
                           f"Not reachable: even a {hi:.1f} m wide canopy lets {100 * t_hi:.0f} % of the light through, mostly "
                           f"scattered light from the north and south sides. Lower the canopy, make it longer north-south, or use "
                           f"a cloth.", hist)
    if target_transmission >= t_lo:
        return SolveResult(True, Panel(cx=offset[0], cy=offset[1], lx=lo, ly=LY, height=height, tau=0.0), t_lo, target_transmission, 2,
                           "The target is met without a canopy.", hist)
    # Illinois (modified regula falsi): keeps the bracket, converges superlinearly on this smooth monotonic curve
    f_lo, f_hi = t_lo - target_transmission, t_hi - target_transmission
    it, side, W, tW = 0, 0, lo, t_lo
    while it < 40:
        W = (lo * f_hi - hi * f_lo) / (f_hi - f_lo)
        tW = T(W); hist.append((W, tW)); it += 1
        fW = tW - target_transmission
        if abs(fW) < tol_T or hi - lo < tol:
            break
        if fW > 0:                      # still too much light: canopy must be wider
            lo, f_lo = W, fW
            if side == -1:
                f_hi *= 0.5
            side = -1
        else:
            hi, f_hi = W, fW
            if side == 1:
                f_lo *= 0.5
            side = 1
    return SolveResult(True, Panel(cx=offset[0], cy=offset[1], lx=W, ly=LY, height=height, tau=0.0), tW,
                       target_transmission, it, "Solved.", hist)


# ------------------------------------------------------------------ checks

def clearance_check(result: PeriodResult, X, Y, target: Target, height: float, site: Site, threshold_hours: float = 0.1):
    """Points that never receive direct sun on any day of the period, and the height rule for full clearance
    (flat sea; design document D4)."""
    hrs = result.direct_sun_hours()                        # [day, point]
    never = (hrs.max(axis=0) < threshold_hours)
    R = 0.5 * max(target.lx, target.ly if target.shape == "rect" else target.lx)
    # tan of refracted zenith at 08:00 and 10:00 local solar time on the first day (example clearance window)
    y, m, d = result.days[0]
    noon = solar.solar_noon(y, m, d, site.lon, site.tz)
    zen = lambda minute: float(solar.solar_position(y, m, d, minute, site.lat, site.lon, site.tz).zenith)
    tz8 = math.tan(math.radians(optics.refracted_zenith_deg(zen(noon - 240))))     # 4 h before solar noon
    tz10 = math.tan(math.radians(optics.refracted_zenith_deg(zen(noon - 120))))    # 2 h before solar noon
    h_rule = 2 * R / max(tz8 - tz10, 1e-6)
    return dict(never_sunlit=never, share_never_sunlit=float(never.mean()), h_min_any=1.78 * R,
                h_for_sun_by_0800_shade_from_1000=h_rule, height=height)


def robustness(site, water, panels, X, Y, days, n_facets: int = 16, kd_factor=(0.5, 1.5), w0s=(0.5, 0.9), winds=(0.0, 10.0),
               shift: float = 0.2, every: int = 5) -> list[dict]:
    """Period transmission under altered conditions (design document D3)."""
    dd = days[::every] if every > 1 else days
    base = run_period(site, water, panels, X, Y, dd, n_facets).transmission()
    rows = [dict(case="as designed", T=base)]
    for f in kd_factor:
        w = replace(water, kd=water.kd * f); rows.append(dict(case=f"Kd x {f:g} ({w.kd:.3f} m-1)", T=run_period(site, w, panels, X, Y, dd, n_facets).transmission()))
    for w0 in w0s:
        w = replace(water, w0=w0); rows.append(dict(case=f"w0 {w0:g}", T=run_period(site, w, panels, X, Y, dd, n_facets).transmission()))
    for u in winds:
        rows.append(dict(case=f"wind {u:g} m s-1", T=run_period(site, water, panels, X, Y, dd, n_facets, wind_override=u).transmission()))
    for name, (dx, dy) in {"shifted 0.2 m east": (shift, 0), "shifted 0.2 m north": (0, shift)}.items():
        moved = [replace(p, cx=p.cx + dx, cy=p.cy + dy) for p in panels]
        rows.append(dict(case=name, T=run_period(site, water, moved, X, Y, dd, n_facets).transmission()))
    return rows


def biology(result: PeriodResult, coral: Coral) -> dict:
    """P–E metrics per day (area mean) for a scenario."""
    ek = effective_ek(coral, np.stack(result.ed), np.stack(result.ed_open))
    w = result.weights / result.weights.sum()
    rows = []
    for e, eo in zip(result.ed, result.ed_open):
        m = day_metrics(e, result.step, coral, ek=ek, ed_open=eo)
        rows.append({k: float(v @ w) for k, v in m.items() if isinstance(v, np.ndarray) and v.ndim == 1})
    keys = rows[0].keys()
    return dict(ek=ek, daily=rows, mean={k: float(np.mean([r[k] for r in rows])) for k in keys})
