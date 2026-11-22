"""Per-day check: the fast engine against the independent 3-D Monte Carlo on days through the deployment,
at five times of day, for the designed cloth and canopy (Sipaway example, app defaults). Flat sea in both."""
import sys, json, time, numpy as np
sys.path.insert(0, str(__import__("pathlib").Path(__file__).resolve().parents[1] / "src"))
from coralshading import engine, mc, surface, solar, examples, scenarios as sc
from coralshading.geometry import Panel, Target
from dataclasses import replace

ex = examples.load_example("sipaway"); h = ex["light_obj"]; lat, lon, tz = ex["lat"], ex["lon"], ex["utc_offset_h"]
site = sc.Site(lat=lat, lon=lon, tz=tz, light=h)
water = engine.Water(kd=0.10, w0=0.7, depth=10.0)
tgt = Target("circle", 1.1, 1.1)
days = sc.deployment_days((2025, 4, 28), (2025, 8, 8))
t0 = time.time()
cloth = sc.default_cloth(tgt, 0.75, site, days, 0.2)
cs = sc.constant_scenario(site, water, tgt, 0.75, days, 0.2, spacing=0.1)
Tc = cs["result"].transmission()
sol = sc.solve_dynamic(site, water, tgt, 0.75, days, Tc, spacing=0.1)
canopy = sol.panel
print("cloth", cloth.lx, cloth.ly, "Tc", Tc, "canopy", canopy.lx, canopy.ly, "T", sol.transmission, round(time.time() - t0, 1), "s", flush=True)
st = engine.optical_state(water)
cc = st.tau / water.depth; a = (1 - water.w0) * cc; b = water.w0 * cc
POINTS = {"center": (0.0, 0.0), "east 0.45 m": (0.45, 0.0), "west 0.45 m": (-0.45, 0.0), "north 0.45 m": (0.0, 0.45)}
xs = np.array([p[0] for p in POINTS.values()]); ys = np.array([p[1] for p in POINTS.values()])
rows = []
N = int(sys.argv[1]) if len(sys.argv) > 1 else 200_000
for (y, m, d) in [(2025, 4, 28), (2025, 5, 18), (2025, 6, 21), (2025, 7, 24), (2025, 8, 8)]:
    dl = surface.day_light(h, y, m, d, lat, lon, tz, step=10.0)
    for hh in (8, 10, 12, 14, 16):
        k = int(np.argmin(np.abs(dl.minutes - (hh * 60 + 5))))
        one = lambda v: np.array([float(v)])
        inst = surface.DayLight(minutes=one(dl.minutes[k]), step=10.0, zenith=one(dl.zenith[k]), azimuth=one(dl.azimuth[k]),
                                par_direct_h=one(dl.par_direct_h[k]), par_diffuse=one(dl.par_diffuse[k]), wind=one(0.0),
                                par_circumsolar_h=one(dl.par_circumsolar_h[k]))
        e_dir = float(dl.par_direct_h[k] + dl.par_circumsolar_h[k]); e_dif = float(dl.par_diffuse[k])
        kw = dict(depth=water.depth, a=a, b=b, sun_zenith_air_deg=float(dl.zenith[k]), sun_azimuth_deg=float(dl.azimuth[k]),
                  e_dir_h_air=e_dir, e_dif_air=e_dif, n_paths=N, bottom_below=50.0)
        op = mc.backward_point(0.0, 0.0, seed=7, **kw)
        for name, pan in (("cloth", cloth), ("canopy", canopy)):
            r = engine.run_day(inst, water, [pan], xs, ys, n_facets=0, state=st)
            fast = (r.ed[0] / r.ed_open[0]).tolist()
            for i, (pn, (px, py)) in enumerate(POINTS.items()):
                q = mc.backward_point(px, py, panels=[pan], seed=8, **kw)
                rows.append(dict(date=f"{y}-{m:02d}-{d:02d}", time=f"{hh:02d}:05", zenith=float(dl.zenith[k]), azimuth=float(dl.azimuth[k]),
                                 direct_share=e_dir / (e_dir + e_dif) if e_dir + e_dif > 0 else None, structure=name, point=pn,
                                 fast=fast[i], mc=q["Ed"] / op["Ed"], mc_se=q["se"] / op["Ed"],
                                 open_fast=float(r.ed_open[0]), open_mc=op["Ed"]))
        print(y, m, d, hh, round(time.time() - t0, 1), "s", flush=True)
out = dict(n_paths=N, water=dict(kd=0.10, w0=0.7, depth=10.0), cloth=cloth.__dict__, canopy=canopy.__dict__, rows=rows)
json.dump(out, open(str(__import__("pathlib").Path(__file__).resolve().parents[2] / "shared" / "validation" / "engine_vs_mc_days.json"), "w"), indent=1)
err = np.array([r["fast"] - r["mc"] for r in rows]); se = np.array([r["mc_se"] for r in rows])
print("points", len(rows), "mean error", err.mean(), "range", err.min(), err.max(), "mean MC SE", se.mean())
oo = np.array([r["open_fast"] / r["open_mc"] for r in rows if r["open_mc"] > 0]); print("open water fast/MC", oo.mean(), oo.min(), oo.max())
