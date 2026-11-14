"""High-level API: the same design calculation as the browser app.

    from coralshading import design
    r = design.design(10.4675, 123.4506, start=(2025, 4, 28), end=(2025, 8, 8), light="example")
    print(r.summary())
    r.to_csv("results")
    r.mc_check()            # optional: check the light under the structures with the 3-D Monte Carlo
"""
from __future__ import annotations

import csv
import math
import os
import sys
import time
from dataclasses import dataclass, field, replace
from pathlib import Path

import numpy as np

from . import __version__, engine, examples, mc, pe, pvgis, scenarios as sc, surface
from .geometry import Panel, Target

TARGETS = {"reef_star": Target("circle", 1.1, 1.1), "table": Target("rect", 1.0, 2.0), "rope": Target("rect", 1.0, 4.0)}   # long north-south


@dataclass
class ScenarioResult:
    kind: str                       # "constant" (cloth) or "dynamic" (canopy)
    panel: Panel
    period: sc.PeriodResult
    X: np.ndarray
    Y: np.ndarray
    transmission: float
    biology: dict
    clearance: dict | None = None
    robustness: list | None = None
    solve: sc.SolveResult | None = None

    @property
    def reduction(self) -> float:
        return 100 * (1 - self.transmission)


@dataclass
class DesignResult:
    inputs: dict
    site: sc.Site
    water: engine.Water
    target: Target
    scenarios: list = field(default_factory=list)
    warnings: list = field(default_factory=list)

    def get(self, kind: str) -> ScenarioResult | None:
        return next((s for s in self.scenarios if s.kind == kind), None)

    def summary(self) -> str:
        i = self.inputs
        lines = [f"Coral Shading Protocol {__version__}",
                 f"Site {i['lat']:.4f}, {i['lon']:.4f} (UTC{i['tz']:+g}); {'%d-%02d-%02d' % i['start']} to {'%d-%02d-%02d' % i['end']}; corals at {i['depth']} m; "
                 f"structures {i['height']} m above; Kd {i['kd']} m-1, w0 {i['w0']}; light: {i['light']}"]
        lines += [f"WARNING: {w}" for w in self.warnings]
        p0 = self.scenarios[0].period
        lines.append(f"Open water at depth: {p0.dli_open().mean():.2f} mol m-2 d-1 (mean daily light)")
        for s in self.scenarios:
            name = "Constant shading (shade cloth)" if s.kind == "constant" else "Dynamic shading (opaque canopy)"
            dli = s.period.dli().mean()
            lines.append(f"{name}: {s.panel.lx:.2f} m E-W x {s.panel.ly:.2f} m N-S, light through {s.panel.tau:.2f}; "
                         f"daily light {dli:.2f} mol m-2 d-1 ({s.reduction:.1f} % less than open water)")
            b = s.biology["mean"]
            pr = f", daily P:R {b['pr_daily']:.2f}" if "pr_daily" in b else ""
            lines.append(f"    coral ({i['coral']}, adjusted to {i['acclimate']}): Ek {b['ek']:.0f}; photosynthesis "
                         f"{100 * b['gross_vs_open']:.0f} % of unshaded; {b['hours_above_ek']:.1f} h above Ek per day{pr}")
            if s.solve is not None and not s.solve.feasible:
                lines.append("    " + s.solve.message)
            if s.clearance is not None:
                c = s.clearance
                lines.append(f"    never in direct sun: {100 * c['share_never_sunlit']:.0f} % of the area; height for sun by "
                             f"4 h before noon and full shade from 2 h before: {c['h_for_sun_by_0800_shade_from_1000']:.2f} m")
            if s.robustness:
                T = [r["T"] for r in s.robustness]
                lines.append(f"    robustness: light {100 * min(T):.0f}-{100 * max(T):.0f} % of open water across Kd x0.5-1.5, "
                             f"w0 0.5-0.9, wind 0-10 m s-1 and 0.2 m shifts")
        if self.inputs["height"] > 1.5:
            lines.append("Note: above 1.5 m the fast engine can over-predict light in the shade by up to 4 % of open water; "
                         "use mc_check().")
        return "\n".join(lines)

    def to_csv(self, folder: str | os.PathLike) -> list[str]:
        d = Path(folder); d.mkdir(parents=True, exist_ok=True)
        out = []
        p = d / "points.csv"
        with open(p, "w", newline="", encoding="utf-8") as f:
            w = csv.writer(f)
            w.writerow(["x_east_m", "y_north_m"] + [f"{s.kind}_daily_light_mol_m2_d" for s in self.scenarios]
                       + [f"{s.kind}_direct_sun_h" for s in self.scenarios])
            cols = [s.period.dli().mean(axis=0) for s in self.scenarios] + [s.period.direct_sun_hours().mean(axis=0) for s in self.scenarios]
            X = self.scenarios[0].X; Y = self.scenarios[0].Y
            for k in range(len(X)):
                w.writerow([f"{X[k]:.3f}", f"{Y[k]:.3f}"] + [f"{c[k]:.4f}" for c in cols])
        out.append(str(p))
        p = d / "days.csv"
        with open(p, "w", newline="", encoding="utf-8") as f:
            w = csv.writer(f)
            w.writerow(["date", "open_water_daily_light_mol_m2_d"] + [f"{s.kind}_daily_light_mean_mol_m2_d" for s in self.scenarios])
            p0 = self.scenarios[0].period
            for k, day in enumerate(p0.days):
                w.writerow([f"{day[0]}-{day[1]:02d}-{day[2]:02d}", f"{p0.dli_open()[k]:.3f}"]
                           + [f"{s.period.dli()[k].mean():.3f}" for s in self.scenarios])
        out.append(str(p))
        rob = [s for s in self.scenarios if getattr(s, "robustness", None)]
        if rob:
            p = d / "robustness.csv"
            with open(p, "w", newline="", encoding="utf-8") as f:
                w = csv.writer(f)
                w.writerow(["scenario", "case", "period_transmission"])
                for s in rob:
                    for row in s.robustness:
                        w.writerow([s.kind, row["case"], f"{row['T']:.4f}"])
            out.append(str(p))
        return out

    def mc_check(self, points: dict | None = None, hours_from_noon=(-3.0, 0.0, 3.0), n_paths: int = 200_000,
                 workers: int | None = None, verbose: bool = True) -> list[dict]:
        """Check the fast engine against the 3-D Monte Carlo for each structure: transmission (light under the
        structure / open water) at a few points and times on the first day, for a flat sea. Runs points in
        parallel; a few minutes on a laptop."""
        pts = points or {"center": (0.0, 0.0), "east edge": (0.45 * self.target.lx, 0.0), "west edge": (-0.45 * self.target.lx, 0.0)}
        y, m, d = self.scenarios[0].period.days[0]
        noon = sc.solar.solar_noon(y, m, d, self.site.lon, self.site.tz)
        st = engine.optical_state(self.water)
        jobs = []
        for s in self.scenarios:
            for h in hours_from_noon:
                sp = sc.solar.solar_position(y, m, d, noon + 60 * h, self.site.lat, self.site.lon, self.site.tz)
                zen, az = float(sp.zenith), float(sp.azimuth)
                if zen >= 85:
                    continue
                for name, (px, py) in pts.items():
                    jobs.append(dict(kind=s.kind, panel=s.panel, hour=h, zen=zen, az=az, point=name, xy=(px, py)))
        c = st.tau / self.water.depth
        a, b = (1 - self.water.w0) * c, self.water.w0 * c
        run = lambda j: _mc_job(j, self.water.depth, a, b, n_paths)
        results = []
        t0 = time.time()
        try:
            from concurrent.futures import ProcessPoolExecutor
            with ProcessPoolExecutor(max_workers=workers) as ex:
                futs = [ex.submit(_mc_job, j, self.water.depth, a, b, n_paths) for j in jobs]
                for k, f in enumerate(futs):
                    results.append(f.result())
                    if verbose:
                        _progress(k + 1, len(jobs), t0)
        except (OSError, PermissionError, RuntimeError):
            results = []
            for k, j in enumerate(jobs):          # no multiprocessing available: run serially
                results.append(run(j))
                if verbose:
                    _progress(k + 1, len(jobs), t0)
        for j, r in zip(jobs, results):
            day = surface.DayLight(minutes=np.array([720.0]), step=10.0, zenith=np.array([j["zen"]]), azimuth=np.array([j["az"]]),
                                   par_direct_h=np.array([700.0]), par_diffuse=np.array([300.0]), wind=np.array([0.0]))
            fr = engine.run_day(day, self.water, [j["panel"]], np.array([j["xy"][0]]), np.array([j["xy"][1]]), n_facets=0, state=st)
            r["fast"] = float(fr.ed[0, 0] / fr.ed_open[0])
            r["difference"] = r["fast"] - r["mc"]
        if verbose:
            print()
            for r in results:
                print(f"{r['kind']:9s} {r['hour']:+.0f} h  {r['point']:10s} fast {r['fast']:.3f}  Monte Carlo {r['mc']:.3f} ± {r['se']:.3f}"
                      f"  difference {r['difference']:+.3f}")
        return results


def _progress(k: int, n: int, t0: float):
    el = time.time() - t0
    bar = "#" * int(30 * k / n)
    sys.stdout.write(f"\rMonte Carlo check [{bar:<30s}] {k}/{n}  {el:.0f} s, about {el / k * (n - k):.0f} s left")
    sys.stdout.flush()


def _mc_job(j: dict, depth: float, a: float, b: float, n_paths: int) -> dict:
    kw = dict(depth=depth, a=a, b=b, sun_zenith_air_deg=j["zen"], sun_azimuth_deg=j["az"], e_dir_h_air=0.7, e_dif_air=0.3,
              n_paths=n_paths, bottom_below=50.0)
    op = mc.backward_point(0.0, 0.0, seed=11, **kw)
    r = mc.backward_point(j["xy"][0], j["xy"][1], panels=[j["panel"]], seed=12, **kw)
    return dict(kind=j["kind"], hour=j["hour"], point=j["point"], mc=r["Ed"] / op["Ed"], se=r["se"] / op["Ed"])


def design(lat: float, lon: float, tz: float | None = None, start=(2025, 4, 28), end=(2025, 8, 8), target="reef_star",
           depth: float = 10.0, height: float = 0.75, kd: float = 0.10, w0: float = 0.9, scenario: str = "both", sync: bool = True,
           cloth_rating: float = 80.0, tau_clean: float | None = None, tau_fouled: float | None = None, fouled_share: float = 0.0,
           cloth_size: tuple | None = None, dynamic_reduction: float = 75.0, canopy: dict | None = None, coral: str = "typical",
           acclimate: str = "site", light="tmy", spacing: float = 0.05, noon_shift: float = 0.0, wind: float | None = None,
           robustness: bool = True, n_facets: int = 16) -> DesignResult:
    """Design a shade cloth and/or canopy for a coral area (see the browser app's help for every input).
    light: "tmy" (download a PVGIS typical year), "example" (Sipaway), "clearsky" (cloud-free model light, no
    download), a (start_year, end_year) tuple for real hourly years, a path to a PVGIS CSV, or a surface.HourlyLight.
    Light data for a point more than surface.MATCH_KM from the site are refused."""
    tz = surface.utc_offset_from_lon(lon) if tz is None else tz
    if isinstance(light, surface.HourlyLight):
        h, label = light, light.database or "user data"
    elif light == "example":
        h, label = examples.load_example("sipaway")["light_obj"], "Sipaway example (PVGIS-ERA5 typical year)"
    elif light == "clearsky":
        h, label = surface.clear_sky_light(lat, lon), "Clear-sky estimate (no clouds; Haurwitz 1945)"
    elif light == "tmy":
        h = pvgis.fetch(lat, lon, "tmy"); label = f"PVGIS typical year ({h.database})"
    elif isinstance(light, tuple):
        h = pvgis.fetch(lat, lon, "hourly", light[0], light[1]); label = f"PVGIS hourly {light[0]}-{light[1]}"
    else:
        h = pvgis.read_file(light); label = str(light)
    if h.lat is not None and h.lon is not None:
        km = surface.distance_km(lat, lon, h.lat, h.lon)
        if km > surface.MATCH_KM:
            raise ValueError(f"The light data are for {h.lat:.3f}, {h.lon:.3f}, {km:,.0f} km from the site. Use light='tmy' to "
                             f"download a PVGIS typical year for the site, or light='clearsky' for a clear-sky estimate.")
    tgt = TARGETS[target] if isinstance(target, str) else target
    site = sc.Site(lat=lat, lon=lon, tz=tz, light=h, noon_shift=noon_shift)
    water = engine.Water(kd=kd, w0=w0, depth=depth)
    days = sc.deployment_days(tuple(start), tuple(end))
    cor = pe.Coral.preset(coral, acclimate=acclimate)
    res = DesignResult(inputs=dict(lat=lat, lon=lon, tz=tz, start=tuple(start), end=tuple(end), depth=depth, height=height, kd=kd, w0=w0,
                                   scenario=scenario, coral=coral, acclimate=(acclimate if cor.ek_emax else "none (no growth light in the source)"), light=label),
                       site=site, water=water, target=tgt)
    X, Y = tgt.grid(spacing)
    Tc = None
    if scenario in ("constant", "both"):
        tc = tau_clean if tau_clean is not None else 1 - cloth_rating / 100
        cloth = Panel(lx=cloth_size[0], ly=cloth_size[1], height=height, tau=tc) if cloth_size else None
        cs = sc.constant_scenario(site, water, tgt, height, days, tc, tau_fouled, fouled_share, cloth, spacing, n_facets, wind)
        Tc = cs["result"].transmission()
        s = ScenarioResult("constant", cs["panel"], cs["result"], X, Y, Tc, sc.biology(cs["result"], cor))
        if robustness:
            s.robustness = sc.robustness(site, water, [cs["panel"]], *tgt.grid(0.1), days, n_facets, every=max(1, math.ceil(len(days) / 12)))
        res.scenarios.append(s)
    if scenario in ("dynamic", "both"):
        sol = None
        if canopy:
            pan = Panel(cx=canopy.get("cx", 0.0), cy=canopy.get("cy", 0.0), lx=canopy["lx"], ly=canopy["ly"], height=height, tau=0.0,
                        rot_deg=canopy.get("rot", 0.0))
        else:
            target_T = Tc if (sync and Tc is not None) else 1 - dynamic_reduction / 100
            every = max(1, math.ceil(len(days) / 20))
            sol = sc.solve_dynamic(site, water, tgt, height, days, target_T, spacing=max(spacing, 0.1), n_facets=n_facets,
                                   solve_every=every, wind_override=wind)
            pan = sol.panel
            if sol.feasible and every > 1 and pan.lx > 0.02:
                # one secant step on all days (as the app does), so the target holds for the whole period
                Xs, Ys = tgt.grid(max(spacing, 0.1))
                st = engine.optical_state(water)
                T_all = lambda W: sc.run_period(site, water, [replace(pan, lx=W)], Xs, Ys, days, n_facets, wind, st).transmission()
                w1, w2 = pan.lx, pan.lx * 1.03
                f1, f2 = T_all(w1) - target_T, T_all(w2) - target_T
                if f2 != f1:
                    w3 = w1 - f1 * (w2 - w1) / (f2 - f1)
                    if w3 > 0.01 and abs(w3 - w1) < 0.25 * w1:
                        pan = replace(pan, lx=w3)
        per = sc.run_period(site, water, [pan], X, Y, days, n_facets, wind_override=wind)
        s = ScenarioResult("dynamic", pan, per, X, Y, per.transmission(), sc.biology(per, cor), solve=sol,
                           clearance=sc.clearance_check(per, X, Y, tgt, height, site))
        if robustness:
            s.robustness = sc.robustness(site, water, [pan], *tgt.grid(0.1), days, n_facets, every=max(1, math.ceil(len(days) / 12)))
        res.scenarios.append(s)
    res.warnings = light_warnings(h, lat, lon, tz, start, max(s.period.light_dropped for s in res.scenarios) if res.scenarios else 0.0)
    return res


def light_warnings(h: surface.HourlyLight, lat: float, lon: float, tz: float, start, dropped: float) -> list:
    """Plain-language warnings about the light data and the UTC offset (the app shows the same)."""
    out = []
    if h.database.startswith("clear sky"):
        out.append("Light data: clear-sky estimate (no clouds). Real weather gives less daily light, more of it diffuse, so this "
                   "overstates daily light and coral photosynthesis. Load the PVGIS typical year for this site before building.")
    if dropped > 0.01:
        out.append(f"{100 * dropped:.0f} % of the light in the data falls in hours when the sun is down or too low at this site, "
                   "so the data do not match the site. That light was left out.")
    noon = sc.solar.solar_noon(*tuple(start), lon, tz)
    if abs(noon - 720.0) > 180.0:
        hh = (noon % 1440.0 + 1440.0) % 1440.0
        out.append(f"Solar noon is at {int(hh // 60):02d}:{int(hh % 60):02d} with UTC{tz:+g}. Check the UTC offset: "
                   f"UTC{surface.utc_offset_from_lon(lon):+d} fits this longitude.")
    return out
