"""Shading scenarios, the design solver and design checks.

Scenarios (as in the Sipaway experiment and earlier app versions):
- constant: a shade cloth over the target all day (transmission tau; optionally clean / fouled with a time share);
- dynamic:  an opaque canopy that shades the target around midday and lets the low morning and afternoon sun in.
With `sync`, the dynamic canopy is sized so that its period light equals the constant scenario's ("equal daily
dose", the paper's design); otherwise each scenario has its own target.

The objective is the period transmission T = sum over days of the area-mean daily light at the target divided by
the sum of the open-water daily light at the same depth; the target reduction is 1 - T.

Solver (dynamic): the canopy's north-south size is set to cover the target plus the noon sun's north-south reach
over the period; the east-west width W is found by regula falsi (T decreases monotonically with W), on every day
of the period. Infeasible targets are reported with the reason and the closest design (design document D2).
Clearance (D4): points that never have the sun in line are flagged, and the height rule
H >= 2R / (tan theta_lit - tan theta_shade) is shown for the most demanding day of the period.
Robustness (D3): Kd, w0, wind and placement are varied on every day and the spread reported.
Contrast (v5.1): light at noon (solar noon +/- 1 h) and in the morning and afternoon (3 h or more from noon, sun
above 10 deg) as shares of open water, and the share of the light at depth that arrives as the sun beam. Where
scattering dominates, an opaque canopy cannot shade much more at noon than at other times.
"""
from __future__ import annotations

import math
from dataclasses import dataclass, field, replace
from functools import lru_cache

import numpy as np

from . import conditions, engine, optics, solar, surface
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
    kd_series: dict | None = None     # v5.1: {(y, m, d): Kd} measured on some dates (conditions.kd_series_from_csv)
    tide: "conditions.Tide | None" = None   # v5.1: water level through the deployment
    tide_ref: float | None = None     # level taken as mean water (set by the caller over the whole deployment)


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
    beam_open: list = field(default_factory=list)   # per day: [time] sun-beam part of the open-water light
    kd_days: list = field(default_factory=list)     # Kd used on each day
    depth_steps: list = field(default_factory=list) # per day: [time] coral depth (m) when a tide is given, else empty
    tau_cloth: list = field(default_factory=list)   # per day: cloth transmission when fouling varies, else empty

    def dli(self):           # [day, point]
        return np.array([e.sum(axis=0) * self.step * 60 / 1e6 for e in self.ed])

    def dli_open(self):      # [day]
        return np.array([e.sum() * self.step * 60 / 1e6 for e in self.ed_open])

    def transmission(self) -> float:
        """Period transmission: area-mean daily light summed over days / open-water daily light summed."""
        w = self.weights / self.weights.sum()
        return float((self.dli() @ w).sum() / self.dli_open().sum())

    def direct_sun_hours(self, threshold: float = 0.5):   # [day, point]
        """Hours per day with the sun in line (geometric: the refracted sun's line passes the structures for at least
        `threshold` of the wave facets). Not a light dose: clouds and scattering are not counted; see beam_share()."""
        return np.array([(s >= threshold).sum(axis=0) * self.step / 60 for s in self.sunlit])

    def beam_share(self) -> float:
        """Share of the open-water light at depth, summed over the period, that arrives as the sun beam."""
        den = float(sum(e.sum() for e in self.ed_open))
        return float(sum(b.sum() for b in self.beam_open)) / den if den > 0 and self.beam_open else 0.0


@lru_cache(maxsize=20000)
def _state_cached(w0: float, tau: float) -> engine.OpticalState:
    return engine.optical_state(engine.Water(kd=0.1, w0=w0, depth=1.0), tau=tau)


def tide_reference(site: Site, start: tuple, end: tuple) -> float:
    """Mean water level over the deployment (local midnight of the start day to midnight after the end day)."""
    return site.tide.mean_between(solar.days_from_civil(*start) * 1440.0, (solar.days_from_civil(*end) + 1) * 1440.0)


def run_period(site: Site, water: engine.Water, panels, X, Y, days, n_facets: int = 16, wind_override: float | None = None,
               state: engine.OpticalState | None = None) -> PeriodResult:
    """Light at every point, every step of every day. With site.kd_series and/or site.tide the water column changes
    by day (Kd) and by step (water level); otherwise one water column serves the whole period."""
    varying = site.kd_series is not None or site.tide is not None
    st = state if (state is not None and not varying) else engine.optical_state(water)
    mom = engine.panel_moments(X, Y, panels, water, st.theta_edges)
    out = dict(ed=[], ed_open=[], sunlit=[], minutes=[], zenith=[], azimuth=[], beam_open=[], kd_days=[], depth_steps=[])
    kds = conditions.kd_for_days(site.kd_series, days) if site.kd_series is not None else [water.kd] * len(days)
    ref = None
    if site.tide is not None:
        ref = site.tide_ref if site.tide_ref is not None else tide_reference(site, days[0], days[-1])
    state_for = lambda tau: _state_cached(water.w0, float(tau))
    # panel moments depend on depth only for a panel that can reach the surface
    moments_at = None
    if site.tide is not None and any(p.height >= water.depth + float(site.tide.level.min()) - ref for p in panels):
        mcache = {}
        def moments_at(z):
            zq = math.floor(z * 100 + 0.5) / 100
            if zq not in mcache:
                mcache[zq] = engine.panel_moments(X, Y, panels, replace(water, depth=zq), st.theta_edges)
            return mcache[zq]
    tot = drop = 0.0
    for (y, m, d), kd in zip(days, kds):
        dl = surface.day_light(site.light, y, m, d, site.lat, site.lon, site.tz, step=site.step, noon_shift=site.noon_shift)
        tot += dl.light_total; drop += dl.light_dropped
        if wind_override is not None:
            dl = replace(dl, wind=np.full_like(dl.wind, float(wind_override)))
        if not varying:
            r = engine.run_day(dl, water, panels, X, Y, n_facets=n_facets, state=st, moments=mom)
            depths = []
        else:
            tau_mean = engine.optical_depth_for_kd(replace(water, kd=kd))
            if site.tide is None:
                depths = []
                r = engine.run_day(dl, replace(water, kd=kd), panels, X, Y, n_facets=n_facets, state=state_for(tau_mean), moments=mom)
            else:
                c = tau_mean / water.depth
                t_loc = solar.days_from_civil(y, m, d) * 1440.0 + np.asarray(dl.minutes, float)
                depths = water.depth + (site.tide.at(t_loc) - ref)
                if depths.min() <= 0.05:
                    raise ValueError(f"At low tide on {y}-{m:02d}-{d:02d} the corals are only {depths.min():.2f} m deep or dry; "
                                     "check the depth (at mean water level) and the tide series.")
                steps = [state_for(conditions.quantize_tau(c * z)) for z in depths]
                r = engine.run_day(dl, replace(water, kd=kd), panels, X, Y, n_facets=n_facets, state=state_for(tau_mean),
                                   moments=mom, step_states=steps, step_depths=depths, moments_at=moments_at)
        out["ed"].append(r.ed); out["ed_open"].append(r.ed_open); out["sunlit"].append(r.sunlit); out["beam_open"].append(r.beam_open)
        out["minutes"].append(dl.minutes); out["zenith"].append(dl.zenith); out["azimuth"].append(dl.azimuth)
        out["kd_days"].append(kd); out["depth_steps"].append(np.asarray(depths, float))
    if site.tide is None:
        out["depth_steps"] = []
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


def period_for(site: Site, water: engine.Water, panels, X, Y, days, n_facets: int = 16, wind_override: float | None = None,
               tau_days: list | None = None) -> PeriodResult:
    """run_period, or, with tau_days (one transmission per day for a single panel), the exact linear mix
    E(tau) = E(0) + tau (E_open - E(0)) from one run with the panel opaque (light and the sun-in-line share are both
    linear in a single panel's transmission: each ray passes it with factor tau or 1)."""
    if tau_days is None:
        return run_period(site, water, panels, X, Y, days, n_facets, wind_override)
    opq = run_period(site, water, [replace(panels[0], tau=0.0)], X, Y, days, n_facets, wind_override)
    ed = [e0 + t * (eo[:, None] - e0) for e0, eo, t in zip(opq.ed, opq.ed_open, tau_days)]
    sl = [s0 + t * (1.0 - s0) for s0, t in zip(opq.sunlit, tau_days)]
    return replace(opq, ed=ed, sunlit=sl, tau_cloth=[float(t) for t in tau_days])


def cloth_tau_days(days, tau_clean: float, tau_fouled: float | None = None, fouled_share: float = 0.0,
                   fouling: "conditions.Fouling | None" = None) -> list | None:
    """Cloth transmission by day: a fouling timeline, or the older fixed share of time fouled (which, light being
    linear in tau, equals the time-weighted transmission on every day), or None for a clean cloth."""
    if fouling is not None:
        return fouling.tau_by_day(days)
    if tau_fouled is not None and fouled_share > 0:
        s = float(fouled_share)
        return [(1 - s) * tau_clean + s * tau_fouled] * len(days)
    return None


def constant_scenario(site, water, target: Target, height: float, days, tau_clean: float, tau_fouled: float | None = None,
                      fouled_share: float = 0.0, cloth: Panel | None = None, spacing: float = 0.05, n_facets: int = 16,
                      wind_override: float | None = None, fouling: "conditions.Fouling | None" = None):
    """Shade cloth: clean, with a fixed share of time fouled, or with a fouling timeline between cleanings (v5.1)."""
    X, Y = target.grid(spacing)
    base = cloth or default_cloth(target, height, site, days, tau_clean)
    tau_days = cloth_tau_days(days, tau_clean, tau_fouled, fouled_share, fouling)
    res = period_for(site, water, [replace(base, tau=tau_clean)], X, Y, days, n_facets, wind_override, tau_days)
    return dict(panel=replace(base, tau=tau_clean), result=res, X=X, Y=Y, tau_days=tau_days)


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
                  w_max: float = 12.0, spacing: float = 0.1, n_facets: int = 16, solve_every: int = 1, tol: float = 0.002,
                  tol_T: float = 0.0005,
                  offset: tuple = (0.0, 0.0), wind_override: float | None = None, guess: float | None = None) -> SolveResult:
    """East-west width of an opaque canopy so that the period transmission matches the target. Uses every day of
    the period unless solve_every > 1."""
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
    """Points that never have the sun in line on any day of the period, and the height rule for full clearance
    (flat sea; design document D4): fully sunlit 4 h before solar noon and fully shaded from 2 h before, on the most
    demanding day of the period (the largest height)."""
    hrs = result.direct_sun_hours()                        # [day, point]
    never = (hrs.max(axis=0) < threshold_hours)
    R = 0.5 * max(target.lx, target.ly if target.shape == "rect" else target.lx)
    h_rule, h_day = 0.0, result.days[0]
    for (y, m, d) in result.days:
        noon = solar.solar_noon(y, m, d, site.lon, site.tz)
        zen = lambda minute: float(solar.solar_position(y, m, d, minute, site.lat, site.lon, site.tz).zenith)
        tz8 = math.tan(math.radians(optics.refracted_zenith_deg(zen(noon - 240))))     # 4 h before solar noon
        tz10 = math.tan(math.radians(optics.refracted_zenith_deg(zen(noon - 120))))    # 2 h before solar noon
        h = 2 * R / max(tz8 - tz10, 1e-6)
        if h > h_rule:
            h_rule, h_day = h, (y, m, d)
    return dict(never_sunlit=never, share_never_sunlit=float(never.mean()), h_min_any=1.78 * R,
                h_for_sun_by_0800_shade_from_1000=h_rule, h_rule_day=tuple(h_day), height=height)


def noon_contrast(result: PeriodResult, site: Site) -> dict:
    """Area-mean light as a share of open water at noon (solar noon +/- 1 h) and in the morning and afternoon (3 h or
    more from solar noon, sun more than 10 deg up), summed over every day; ratio = noon / morning and afternoon."""
    w = result.weights / result.weights.sum()
    nn = no = sn = so = 0.0
    for (y, m, d), e, eo, mins, zen in zip(result.days, result.ed, result.ed_open, result.minutes, result.zenith):
        noon = solar.solar_noon(y, m, d, site.lon, site.tz) + site.noon_shift
        dt = np.abs(np.asarray(mins, float) - noon)
        a = np.asarray(e, float) @ w
        at_noon = dt <= 60.0
        side = (dt >= 180.0) & (np.asarray(zen, float) < 80.0)
        nn += float(a[at_noon].sum()); no += float(np.asarray(eo, float)[at_noon].sum())
        sn += float(a[side].sum()); so += float(np.asarray(eo, float)[side].sum())
    noon_t = nn / no if no > 0 else float("nan"); side_t = sn / so if so > 0 else float("nan")
    return dict(noon=noon_t, side=side_t, ratio=noon_t / side_t if side_t > 0 else float("nan"))


CONTRAST_WARN = 0.8     # dynamic shading: warn when noon light is more than this share of morning and afternoon light


def contrast_warning(c: dict, beam_share: float, depth: float) -> str | None:
    """Plain-language warning when dynamic shading gives nearly the same light pattern as constant shading."""
    if not (c["ratio"] > CONTRAST_WARN):
        return None
    return (f"Dynamic shading barely changes through the day here: at noon the corals get {100 * c['noon']:.0f} % of open-water "
            f"light, in the morning and afternoon {100 * c['side']:.0f} %. Only {100 * beam_share:.1f} % of the light at "
            f"{depth:g} m arrives as the sun beam; the rest is scattered light from all directions, which the canopy blocks at "
            f"every hour. A stronger midday contrast needs less scattering water (lower w0), a shallower site or a wider "
            f"canopy, which also gives less light overall.")


def robustness(site, water, panels, X, Y, days, n_facets: int = 16, kd_factor=(0.5, 1.5), w0s=(0.5, 0.9), winds=(0.0, 10.0),
               shift: float = 0.2, every: int = 1, tau_days: list | None = None) -> list[dict]:
    """Period transmission under altered conditions (design document D3), on every day unless every > 1.
    tau_days: the cloth's transmission by day (fouling), as in the scenario. With Kd by date, the Kd cases scale
    every day's Kd."""
    idx = list(range(0, len(days), every)) if every > 1 else list(range(len(days)))
    dd = [days[i] for i in idx]
    td = None if tau_days is None else [tau_days[i] for i in idx]
    T = lambda s, w, p, u=None: period_for(s, w, p, X, Y, dd, n_facets, u, td).transmission()
    rows = [dict(case="as designed", T=T(site, water, panels))]
    for f in kd_factor:
        w = replace(water, kd=water.kd * f)
        s2 = site if site.kd_series is None else replace(site, kd_series={k: v * f for k, v in site.kd_series.items()})
        rows.append(dict(case=f"Kd x {f:g}" + ("" if site.kd_series is not None else f" ({w.kd:.3f} m-1)"), T=T(s2, w, panels)))
    for w0 in w0s:
        rows.append(dict(case=f"w0 {w0:g}", T=T(site, replace(water, w0=w0), panels)))
    for u in winds:
        rows.append(dict(case=f"wind {u:g} m s-1", T=T(site, water, panels, u)))
    for name, (dx, dy) in {f"shifted {shift:g} m east": (shift, 0), f"shifted {shift:g} m north": (0, shift)}.items():
        moved = [replace(p, cx=p.cx + dx, cy=p.cy + dy) for p in panels]
        rows.append(dict(case=name, T=T(site, water, moved)))
    return rows


def biology(result: PeriodResult, coral: Coral) -> dict:
    """P–E metrics per day (area mean) for a scenario."""
    ek = effective_ek(coral, np.stack(result.ed), np.stack(result.ed_open))     # [point], or [day, point] over time
    ek_days = ek if ek.ndim == 2 else np.broadcast_to(ek, (len(result.ed), len(ek)))
    w = result.weights / result.weights.sum()
    rows = []
    for k, (e, eo) in enumerate(zip(result.ed, result.ed_open)):
        m = day_metrics(e, result.step, coral, ek=ek_days[k], ed_open=eo)
        rows.append({k: float(v @ w) for k, v in m.items() if isinstance(v, np.ndarray) and v.ndim == 1})
    keys = rows[0].keys()
    return dict(ek=np.asarray(ek_days).mean(axis=0), ek_days=np.asarray(ek_days), daily=rows,
                mean={k: float(np.mean([r[k] for r in rows])) for k in keys})


# ------------------------------------------------------------------ water scattering (w0): field calibration
def w0_bounds() -> tuple[float, float]:
    """Smallest and largest w0 in the light tables."""
    w = engine.load_tables()["w0"]
    return float(w[0]), float(w[-1])


def reading_ratio(w0: float, panel: Panel, point: tuple, kd: float, depth: float, date: tuple, minute: float, lat: float,
                  lon: float, tz: float, diffuse_share: float = 0.3, wind: float = 0.0) -> float:
    """Model light under a panel / open water at one point and moment (a field reading), for scattering w0."""
    sp = solar.solar_position(*date, minute, lat, lon, tz)
    if float(sp.zenith) >= 90.0:
        raise ValueError("The sun is below the horizon at that time.")
    day = surface.DayLight(minutes=np.array([float(minute)]), step=10.0, zenith=np.array([float(sp.zenith)]),
                           azimuth=np.array([float(sp.azimuth)]), par_direct_h=np.array([1000.0 * (1.0 - diffuse_share)]),
                           par_diffuse=np.array([1000.0 * diffuse_share]), wind=np.array([float(wind)]))
    w = engine.Water(kd=kd, w0=w0, depth=depth)
    r = engine.run_day(day, w, [panel], np.array([point[0]]), np.array([point[1]]), n_facets=64 if wind > 0 else 0)
    return float(r.ed[0, 0] / r.ed_open[0])


def w0_from_reading(ratio: float, panel: Panel, point: tuple, kd: float, depth: float, date: tuple, minute: float, lat: float,
                    lon: float, tz: float, diffuse_share: float = 0.3, wind: float = 0.0) -> dict:
    """The w0 for which the model reproduces a field reading (light under an opaque panel / open water at the same
    depth, same moment). The ratio rises with w0 (more scattering brightens the shade), so bisection finds it.
    status: 'ok', or 'below' / 'above' when the reading is outside what the tables' w0 range gives (w0 is then the
    nearest bound)."""
    lo, hi = w0_bounds()
    f = lambda w: reading_ratio(w, panel, point, kd, depth, date, minute, lat, lon, tz, diffuse_share, wind)
    r_lo, r_hi = f(lo), f(hi)
    if ratio <= r_lo:
        return dict(w0=lo, status="below", ratio_min=r_lo, ratio_max=r_hi)
    if ratio >= r_hi:
        return dict(w0=hi, status="above", ratio_min=r_lo, ratio_max=r_hi)
    a, b = lo, hi
    for _ in range(40):
        m = 0.5 * (a + b)
        if f(m) < ratio:
            a = m
        else:
            b = m
    return dict(w0=0.5 * (a + b), status="ok", ratio_min=r_lo, ratio_max=r_hi)
