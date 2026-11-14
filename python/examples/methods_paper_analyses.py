"""Analyses for the CSP v5 methods paper (docs/methods_paper_groundwork.md).

    python methods_paper_analyses.py noon      # Sipaway 22 May 2025 noon readings vs model (about 15 s)
    python methods_paper_analyses.py heights   # canopy and cloth design vs height (about 8 min)

Writes CSV files to the current folder.
"""
import sys

import numpy as np
import pandas as pd

from coralshading import examples, scenarios as scn, solar, surface
from coralshading.engine import Water, run_day
from coralshading.geometry import Panel

EX = examples.load_example("sipaway")
LAT, LON, TZ = EX["lat"], EX["lon"], EX["utc_offset_h"]
KD = 0.21                                   # measured at Sipaway on 22 May 2025
W0S = (0.5, 0.6, 0.7, 0.8, 0.85, 0.9)


def reef_star_points(spacing=0.05, radius=0.55):
    """Center first, then a grid over the Reef Star disk."""
    g = np.arange(-radius, radius + 1e-9, spacing)
    X, Y = np.meshgrid(g, g)
    sel = X ** 2 + Y ** 2 <= radius ** 2 + 1e-9
    return np.r_[0.0, X[sel]], np.r_[0.0, Y[sel]]


def noon_comparison():
    """Light under each structure / open water, solar noon +-30 min on 22 May 2025, as measured."""
    y, m, d = 2025, 5, 22
    noon = solar.solar_noon(y, m, d, LON, TZ)
    dl = surface.day_light(EX["light_obj"], y, m, d, LAT, LON, TZ)
    i0 = int(np.argmin(abs(dl.minutes - noon)))
    fd_tmy = float(dl.par_diffuse[i0] / (dl.par_diffuse[i0] + dl.par_direct_h[i0]))
    mins = noon + np.arange(-30, 31, 10.0)
    sp = solar.solar_position(y, m, d, mins, LAT, LON, TZ)
    px, py = reef_star_points()
    structures = {"canopy": Panel(lx=1.88, ly=2.0, height=0.75, tau=0.0),
                  "cloth0.20": Panel(lx=4.0, ly=2.0, height=0.75, tau=0.20),
                  "cloth_opaque": Panel(lx=4.0, ly=2.0, height=0.75, tau=0.0)}
    rows = []
    for fd in (round(fd_tmy, 3), 0.3, 0.5):
        for wind in (0.0, 5.0):
            day = surface.DayLight(minutes=mins, step=10.0, zenith=np.asarray(sp.zenith, float),
                                   azimuth=np.asarray(sp.azimuth, float), par_direct_h=np.full(len(mins), 1000 * (1 - fd)),
                                   par_diffuse=np.full(len(mins), 1000 * fd), wind=np.full(len(mins), wind))
            for w0 in W0S:
                water = Water(kd=KD, w0=w0, depth=10.0)
                for name, pan in structures.items():
                    r = run_day(day, water, [pan], px, py, n_facets=64)
                    ratio = r.ed.sum(axis=0) / r.ed_open.sum(axis=0)
                    rows.append(dict(structure=name, diffuse=fd, wind=wind, w0=w0, center=ratio[0],
                                     star_mean=ratio[1:].mean(), star_min=ratio[1:].min(), star_max=ratio[1:].max()))
    out = pd.DataFrame(rows)
    # cloth material transmission implied by the measured under/open ratios (0.210 cleaned, 0.147 with sand):
    # R(tau) = s + tau (1 - s), s = side light under an opaque panel of the cloth's size
    s = out[(out.structure == "cloth_opaque") & (out.wind == 0) & (out.diffuse == round(fd_tmy, 3))]
    inf = []
    for _, r in s.iterrows():
        for lab, sv in (("center", r.center), ("star_mean", r.star_mean)):
            inf.append(dict(w0=r.w0, point=lab, side_light=sv, tau_clean=(0.210 - sv) / (1 - sv), tau_sand=(0.147 - sv) / (1 - sv)))
    out.to_csv("sipaway_noon_model_vs_w0.csv", index=False)
    pd.DataFrame(inf).to_csv("sipaway_cloth_tau_inferred.csv", index=False)
    print(f"solar noon {noon:.1f} min, zenith {float(dl.zenith[i0]):.1f} deg, TMY diffuse share {fd_tmy:.3f}")
    print(out[(out.wind == 0) & (out.diffuse == round(fd_tmy, 3)) & (out.structure != "cloth_opaque")].round(3).to_string(index=False))
    print(pd.DataFrame(inf).round(3).to_string(index=False))


def height_sweep(heights=(0.5, 0.75, 1.0, 1.5, 2.0, 3.0), w0s=(0.7, 0.85), target_T=0.25):
    """Canopy solved for a 75 % cut, and the default 80 % cloth, at several heights (Sipaway, 28 Apr - 8 Aug)."""
    site = scn.Site(LAT, LON, TZ, EX["light_obj"])
    days = scn.deployment_days((2025, 4, 28), (2025, 8, 8))
    days_m = days[::5]
    tgt = scn.Target("circle", 1.1, 1.1)
    X, Y = tgt.grid(0.1)
    ic = int(np.argmin(X ** 2 + Y ** 2))
    rows = []
    for w0 in w0s:
        water = Water(kd=KD, w0=w0, depth=10.0)
        for H in heights:
            sol = scn.solve_dynamic(site, water, tgt, H, days, target_T, spacing=0.1, n_facets=16, solve_every=10)
            per = scn.run_period(site, water, [sol.panel], X, Y, days_m, 16)
            hrs = per.direct_sun_hours().mean(axis=0)
            clr = scn.clearance_check(per, X, Y, tgt, H, site)
            cloth = scn.default_cloth(tgt, H, site, days, 0.20)
            perc = scn.run_period(site, water, [cloth], X, Y, days_m, 16)
            rows.append(dict(w0=w0, H=H, feasible=sol.feasible, canopy_ew=sol.panel.lx, canopy_ns=sol.panel.ly,
                             T_canopy=per.transmission(), sun_center=float(hrs[ic]), sun_mean=float(hrs.mean()),
                             sun_min=float(hrs.min()), sun_max=float(hrs.max()), never_sunlit=clr["share_never_sunlit"],
                             h_rule=clr["h_for_sun_by_0800_shade_from_1000"], cloth_ew=cloth.lx, cloth_ns=cloth.ly,
                             T_cloth=perc.transmission(), cloth_sun_mean=float(perc.direct_sun_hours().mean())))
            print(rows[-1], flush=True)
    pd.DataFrame(rows).to_csv("design_space_height.csv", index=False)


if __name__ == "__main__":
    what = sys.argv[1] if len(sys.argv) > 1 else "noon"
    {"noon": noon_comparison, "heights": height_sweep}[what]()
