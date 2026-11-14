"""Validation of the fast engine against the 3-D backward Monte Carlo (mc.backward_point).

Each case is one instant: sun position, horizontal direct and diffuse irradiance in air (only their ratio matters),
a water column (kd, w0, depth) and a set of panels. Both methods use the same optical depth tau (from the tables),
so the comparison isolates the engine's angular approximations. Results are transmissions: light at the point under
the panels divided by open water at the same depth.

    python -m coralshading.validate [n_paths] [part K N]
writes shared/validation/engine_vs_mc.json (or a part file when run in parts).
"""
from __future__ import annotations

import json
import sys
import time

import numpy as np

from . import SHARED, engine, mc
from .geometry import Panel
from .surface import DayLight

CANOPY = dict(cx=0.0, cy=0.0, lx=1.88, ly=2.0, height=0.75, tau=0.0)      # Sipaway opaque canopy (E-W x N-S)
CLOTH = dict(cx=0.0, cy=0.0, lx=4.0, ly=2.0, height=0.75, tau=0.21)       # Sipaway shade cloth, cleaned
POINTS = {"C": (0.0, 0.0), "E0.55": (0.55, 0.0), "W0.55": (-0.55, 0.0), "N0.55": (0.0, 0.55), "S0.55": (0.0, -0.55),
          "E1.2": (1.2, 0.0)}
SUNS = {"noon": (9.8, 0.0), "low_east": (50.0, 80.0), "mid_west": (35.0, 260.0)}


def cases():
    out = []
    for w in [dict(kd=0.21, w0=0.7, depth=10.0), dict(kd=0.21, w0=0.85, depth=10.0), dict(kd=0.21, w0=0.5, depth=10.0),
              dict(kd=0.06, w0=0.7, depth=10.0), dict(kd=0.40, w0=0.7, depth=5.0)]:
        for sun_name, (sz, sa) in SUNS.items():
            for pname, pan in [("canopy0.75", CANOPY), ("cloth0.75", CLOTH), ("canopy2.0", dict(CANOPY, height=2.0))]:
                if (w["kd"], w["w0"]) != (0.21, 0.7) and pname != "canopy0.75":
                    continue
                out.append(dict(water=w, sun=sun_name, sun_zenith=sz, sun_azimuth=sa, panel_name=pname, panel=pan,
                                f_dir=0.7, f_dif=0.3))
    return out


def _one_step_day(sz, sa, f_dir, f_dif):
    one = lambda v: np.array([float(v)])
    return DayLight(minutes=one(720.0), step=10.0, zenith=one(sz), azimuth=one(sa), par_direct_h=one(f_dir),
                    par_diffuse=one(f_dif), wind=one(0.0))


def engine_case(c):
    w = engine.Water(**c["water"]); st = engine.optical_state(w)
    pan = [Panel(**c["panel"])]
    xs = np.array([p[0] for p in POINTS.values()]); ys = np.array([p[1] for p in POINTS.values()])
    r = engine.run_day(_one_step_day(c["sun_zenith"], c["sun_azimuth"], c["f_dir"], c["f_dif"]), w, pan, xs, ys,
                       n_facets=0, state=st)
    return st.tau, dict(zip(POINTS, (r.ed[0] / r.ed_open[0]).tolist()))


def mc_case(c, tau, n_paths, seed=7):
    d = c["water"]["depth"]; cc = tau / d; a = (1 - c["water"]["w0"]) * cc; b = c["water"]["w0"] * cc
    kw = dict(depth=d, a=a, b=b, sun_zenith_air_deg=c["sun_zenith"], sun_azimuth_deg=c["sun_azimuth"],
              e_dir_h_air=c["f_dir"], e_dif_air=c["f_dif"], n_paths=n_paths, bottom_below=50.0)
    op = mc.backward_point(0.0, 0.0, seed=seed, **kw)
    out, se = {}, {}
    for k, (x, y) in POINTS.items():
        r = mc.backward_point(x, y, panels=[Panel(**c["panel"])], seed=seed + 1, **kw)
        out[k] = r["Ed"] / op["Ed"]
        se[k] = r["se"] / op["Ed"]
    return out, se, op


def run(n_paths=200_000, part=0, of=1):
    rows = []
    for i, c in enumerate(cases()):
        if i % of != part:
            continue
        t0 = time.time()
        tau, fast = engine_case(c)
        ref, se, op = mc_case(c, tau, n_paths)
        rows.append(dict(case=c, tau=tau, fast=fast, mc=ref, mc_se=se, mc_open=op, seconds=round(time.time() - t0, 1)))
    d = SHARED / "validation"; d.mkdir(parents=True, exist_ok=True)
    p = d / ("engine_vs_mc.json" if of == 1 else f"engine_vs_mc_part{part}.json")
    p.write_text(json.dumps(dict(n_paths=n_paths, rows=rows), indent=1), encoding="utf-8")
    return str(p)


if __name__ == "__main__":
    n = int(sys.argv[1]) if len(sys.argv) > 1 else 200_000
    part, of = (int(sys.argv[3]), int(sys.argv[4])) if len(sys.argv) > 4 and sys.argv[2] == "part" else (0, 1)
    print(run(n, part, of))
