"""Write golden test values to shared/golden/. The TypeScript tests must reproduce them.

Run: python -m coralshading.golden
"""
from __future__ import annotations

import json

import numpy as np

from . import SHARED, solar

SITES = [("Sipaway", 10.4675, 123.4506, 8), ("Lizard Island", -14.67, 145.45, 10),
         ("Florida Keys", 24.55, -81.78, -5), ("Eilat", 29.50, 34.92, 2), ("Oahu", 21.30, -157.80, -10)]
DATES = [(2025, 1, 15), (2025, 4, 28), (2025, 6, 21), (2025, 12, 21), (2024, 2, 29)]


def _f(x):
    return float(np.asarray(x))


def golden_solar() -> dict:
    cases = []
    for name, lat, lon, tz in SITES:
        for (y, m, d) in DATES:
            for minute in (300.0, 494.0, 720.0, 901.5, 1110.0):
                sp = solar.solar_position(y, m, d, minute, lat, lon, tz)
                cases.append(dict(site=name, y=y, m=m, d=d, minute=minute, lat=lat, lon=lon, tz=tz,
                                  zenith=_f(sp.zenith), azimuth=_f(sp.azimuth), zenith_geometric=_f(sp.zenith_geometric),
                                  declination=_f(sp.declination), eot=_f(sp.eot)))
    noons = []
    for name, lat, lon, tz in SITES:
        for (y, m, d) in DATES:
            sr, ss = solar.sunrise_sunset(y, m, d, lat, lon, tz)
            noons.append(dict(site=name, y=y, m=m, d=d, lat=lat, lon=lon, tz=tz,
                              noon=solar.solar_noon(y, m, d, lon, tz), sunrise=sr, sunset=ss))
    days = [dict(y=y, m=m, d=d, days=solar.days_from_civil(y, m, d)) for (y, m, d) in DATES + [(1970, 1, 1), (1999, 12, 31)]]
    return dict(positions=cases, noons=noons, days=days)


def golden_optics() -> dict:
    from . import optics
    from .geometry import Panel, Target, ray_hit_xy, transmission_along
    rz = [dict(z=z, w=float(optics.refracted_zenith_deg(z))) for z in (0, 10, 35.6, 51.2, 75, 89.9, 90)]
    ft = [dict(c=c, t=float(optics.fresnel_t(c))) for c in (1.0, 0.9, 0.5, 0.2, 0.05, 1e-6)]
    rays = []
    for (z, a, u, n) in [(40, 90, 0, 64), (20, 10, 5, 64), (60, 270, 7, 64), (5, 180, 2, 16), (80, 80, 10, 64), (51.2, 80, 5, 32)]:
        d, wgt, tot = optics.refracted_sun_rays(z, a, u, n)
        rays.append(dict(z=z, a=a, u=u, n=n, dirs=d.ravel().tolist(), w=wgt.tolist(), tot=tot))
    grids = []
    for t in (Target("circle", 1.1, 1.1), Target("rect", 2.0, 1.0), Target("rect", 0.5, 3.0)):
        X, Y = t.grid(0.05)
        grids.append(dict(shape=t.shape, lx=t.lx, ly=t.ly, spacing=0.05, n=len(X), xs=X[:7].tolist(), ys=Y[:7].tolist(), sx=float(X.sum()), sy=float(Y.sum())))
    panels = [Panel(lx=1.88, ly=2.0, height=0.75, tau=0.0), Panel(cx=0.3, cy=-0.2, lx=4.0, ly=2.0, height=0.75, tau=0.2, rot_deg=30.0),
              Panel(lx=3.0, ly=3.0, height=12.0, tau=0.0)]
    trans = []
    for (px, py) in [(0, 0), (0.55, 0), (-0.4, 0.3), (1.0, -1.2)]:
        for up in [(0, 0, 1), (0.5, 0.1, 0.86), (-0.6, -0.3, 0.74), (0.7, 0.0, 0.714)]:
            u = np.array(up, float); u /= np.linalg.norm(u)
            for depth in (10.0, 0.5):
                hx, hy, ok = ray_hit_xy(px, py, u, panels[2].height, depth)
                trans.append(dict(px=px, py=py, up=u.tolist(), depth=depth, t=float(transmission_along(px, py, u, panels, depth)),
                                  hx=float(hx), hy=float(hy), ok=bool(ok)))
    return dict(refracted=rz, fresnel=ft, sky=optics.sky_transmittance(), facets=optics.unit_facets(16).ravel().tolist(),
                rays=rays, grids=grids, panels=[p.__dict__ for p in panels], trans=trans)


def golden_engine() -> dict:
    """Fast-engine cases. Inputs (surface light per step, water, panels, points) are stored with the outputs so
    the TypeScript test checks the engine alone."""
    from . import engine, examples, surface
    from .geometry import Panel, Target
    ex = examples.load_example("sipaway")
    day = surface.day_light(ex["light_obj"], 2001, 4, 28, ex["lat"], ex["lon"], ex["utc_offset_h"], step=10.0)
    one = lambda v: np.array([float(v)])
    inst = lambda sz, sa, wind: surface.DayLight(minutes=one(720.0), step=10.0, zenith=one(sz), azimuth=one(sa),
                                                  par_direct_h=one(700.0), par_diffuse=one(300.0), wind=one(wind))
    canopy = Panel(lx=1.88, ly=2.0, height=0.75, tau=0.0)
    cloth = Panel(cx=0.3, cy=-0.2, lx=4.0, ly=2.0, height=0.75, tau=0.21, rot_deg=30.0)
    floating = Panel(cx=0.2, lx=3.0, ly=2.5, height=6.0, tau=0.3)
    X, Y = Target("circle", 1.1, 1.1).grid(0.15)
    pts6 = (np.array([0.0, 0.55, -0.55, 0.0, 0.0, 1.2]), np.array([0.0, 0.0, 0.0, 0.55, -0.55, 0.0]))
    specs = [("instants_canopy", engine.Water(0.21, 0.7, 10.0), [canopy], pts6, [inst(9.8, 0.0, 0.0), inst(50.0, 80.0, 0.0), inst(35.0, 260.0, 4.0)], 16),
             ("sipaway_day_two_panels", engine.Water(0.10, 0.7, 10.0), [canopy, cloth], (X, Y), [day], 16),
             ("floating_panel_wind", engine.Water(0.40, 0.85, 5.0), [floating], pts6, [inst(60.0, 200.0, 6.0)], 16)]
    cases = []
    for name, w, panels, (px, py), days, nf in specs:
        st = engine.optical_state(w)
        C, S = engine.panel_moments(px, py, panels, w, st.theta_edges)
        for d in days:
            r = engine.run_day(d, w, panels, px, py, n_facets=nf, state=st, moments=(C, S))
            cases.append(dict(name=name, water=w.__dict__, panels=[p.__dict__ for p in panels], px=px.tolist(), py=py.tolist(),
                              n_facets=nf, day=dict(minutes=d.minutes.tolist(), step=d.step, zenith=d.zenith.tolist(),
                                                    azimuth=d.azimuth.tolist(), par_direct_h=d.par_direct_h.tolist(),
                                                    par_diffuse=d.par_diffuse.tolist(), wind=[None if not np.isfinite(v) else float(v) for v in d.wind],
                                                    par_circumsolar_h=None if d.par_circumsolar_h is None else d.par_circumsolar_h.tolist()),
                              tau=st.tau, C0_first=C[0][0].tolist(), S1_first=S[1][0].tolist(),
                              ed=r.ed.tolist(), ed_open=r.ed_open.tolist(), sunlit=r.sunlit.tolist(), dli=r.dli().tolist(),
                              beam_open=r.beam_open.tolist()))
    return dict(cases=cases)


def golden_scenarios() -> dict:
    """Scenario layer on the Sipaway TMY: cloth with fouling, synced canopy solve, checks and P–E metrics."""
    from . import engine, examples, pe
    from . import scenarios as sc
    from .geometry import Target
    ex = examples.load_example("sipaway")
    site = sc.Site(lat=ex["lat"], lon=ex["lon"], tz=ex["utc_offset_h"], light=ex["light_obj"])
    days = sc.deployment_days((2025, 4, 28), (2025, 5, 6), every=4)
    water = engine.Water(0.21, 0.7, 10.0)
    tgt = Target("circle", 1.1, 1.1)
    cs = sc.constant_scenario(site, water, tgt, 0.75, days, tau_clean=0.21, tau_fouled=0.147, fouled_share=0.3, spacing=0.2)
    Tc = cs["result"].transmission()
    sol = sc.solve_dynamic(site, water, tgt, 0.75, days, target_transmission=Tc, spacing=0.2, solve_every=1)
    X, Y = tgt.grid(0.2)
    dyn = sc.run_period(site, water, [sol.panel], X, Y, days)
    chk = sc.clearance_check(dyn, X, Y, tgt, 0.75, site)
    con_d = sc.noon_contrast(dyn, site); con_c = sc.noon_contrast(cs["result"], site)
    rob = sc.robustness(site, water, [sol.panel], X, Y, days[:2], every=1)
    corals = {}
    for pid, acc in [("acropora_cervicornis", "none"), ("acropora_cervicornis", "site"), ("pocillopora_damicornis", "shade"),
                     ("typical", "site")]:
        b = sc.biology(dyn, pe.Coral.preset(pid, acclimate=acc))
        corals[f"{pid}_{acc}"] = dict(id=pid, acclimate=acc, ek=b["ek"].tolist(), mean=b["mean"], daily=b["daily"])
    summ = pe.summarize(dyn.dli()[0])
    # ---- v5.1: fouling timeline, Kd by date, tide (with a panel reaching the surface), acclimation over time, w0 calibration
    import numpy as _np
    from dataclasses import replace as _rep
    from . import conditions, solar as _sol
    from .geometry import Panel as _Panel
    foul = conditions.Fouling(tau_clean=0.21, tau_fouled=0.147, days_to_foul=3.0, clean_every=4, clean_dates=[(2025, 5, 2)])
    cf = sc.constant_scenario(site, water, tgt, 0.75, days, tau_clean=0.21, spacing=0.2, fouling=foul)
    rob_f = sc.robustness(site, water, [cf["panel"]], X, Y, days[:2], every=1, tau_days=cf["tau_days"][:2])
    kd_series = {(2025, 4, 28): 0.15, (2025, 5, 6): 0.30}
    t0 = _sol.days_from_civil(2025, 4, 27) * 1440.0
    tt = t0 + 30.0 * _np.arange(int(12 * 1440 / 30))
    lv = 0.6 * _np.cos(2 * _np.pi * (tt - t0) / 745.2) + 0.1 * _np.sin(2 * _np.pi * (tt - t0) / 1490.4) + 1.3
    tide = conditions.Tide(t_local=tt, level=lv)
    sv = _rep(site, kd_series=kd_series, tide=tide)
    sv.tide_ref = sc.tide_reference(sv, days[0], days[-1])
    var = sc.run_period(sv, water, [sol.panel], X, Y, days)
    shallow = engine.Water(0.21, 0.7, 2.0)
    float_pan = _Panel(lx=1.6, ly=1.4, height=1.8, tau=0.0)
    var2 = sc.run_period(sv, shallow, [float_pan], X, Y, days[:1])
    bt = sc.biology(dyn, pe.Coral.preset("typical", acclimate="time"))
    cal_pan = _Panel(lx=1.2, ly=1.2, height=0.75, tau=0.0)
    cal = sc.w0_from_reading(0.12, cal_pan, (0.1, 0.0), 0.21, 10.0, (2025, 5, 22), 700.0, ex["lat"], ex["lon"], ex["utc_offset_h"], 0.3, 0.0)
    cal_w = sc.w0_from_reading(0.12, cal_pan, (0.1, 0.0), 0.21, 10.0, (2025, 5, 22), 700.0, ex["lat"], ex["lon"], ex["utc_offset_h"], 0.25, 6.0)
    v51 = dict(fouling=dict(tau_clean=0.21, tau_fouled=0.147, days_to_foul=3.0, clean_every=4, clean_dates=[[2025, 5, 2]],
                            tau_days=cf["tau_days"], T=cf["result"].transmission(), dli_day1=cf["result"].dli()[1].tolist(),
                            sun_day1=cf["result"].direct_sun_hours()[1].tolist(), robustness=rob_f),
               kd_series=[[list(k), v] for k, v in kd_series.items()], tide=dict(t_local=tt.tolist(), level=lv.tolist(), ref=sv.tide_ref),
               var=dict(T=var.transmission(), dli_open=var.dli_open().tolist(), dli_day0=var.dli()[0].tolist(), kd_days=var.kd_days,
                        depth_day0=var.depth_steps[0].tolist(), beam_share=var.beam_share()),
               var_surface=dict(water=shallow.__dict__, panel=float_pan.__dict__, dli_day0=var2.dli()[0].tolist(),
                                dli_open=var2.dli_open().tolist(), sunlit_day0=var2.direct_sun_hours()[0].tolist()),
               acclimation_time=dict(ek=bt["ek"].tolist(), ek_day2=bt["ek_days"][2].tolist(), mean=bt["mean"]),
               calibration=dict(ratio=0.12, panel=cal_pan.__dict__, point=[0.1, 0.0], kd=0.21, depth=10.0, date=[2025, 5, 22], minute=700.0,
                                diffuse=0.3, wind=0.0, result=cal, result_wind=cal_w))
    ex_c = dict(noon=0.30, side=0.36, ratio=0.30 / 0.36)
    v51["contrast_warning_example"] = dict(contrast=ex_c, beam=0.008, depth=10.0, text=sc.contrast_warning(ex_c, 0.008, 10.0))
    return dict(v51=v51, contrast_warning_example=v51["contrast_warning_example"], days=[list(d) for d in days], water=water.__dict__, target=dict(shape="circle", lx=1.1, ly=1.1),
                cloth=cs["panel"].__dict__, T_constant=Tc, dli_constant_day0=cs["result"].dli()[0].tolist(),
                solve=dict(lx=sol.panel.lx, ly=sol.panel.ly, T=sol.transmission, iterations=sol.iterations, history=sol.history),
                T_dynamic_full=dyn.transmission(), direct_hours_day0=dyn.direct_sun_hours()[0].tolist(),
                clearance=dict(share=chk["share_never_sunlit"], h_rule=chk["h_for_sun_by_0800_shade_from_1000"], h_min=chk["h_min_any"],
                               h_rule_day=list(chk["h_rule_day"])),
                beam_share=dyn.beam_share(), contrast_dynamic=con_d, contrast_constant=con_c,
                contrast_warning=sc.contrast_warning(con_d, dyn.beam_share(), water.depth),
                robustness=rob, corals=corals, summary_day0=summ)


def golden_surface() -> dict:
    """Surface light: the clear-sky typical year, the timing guard (Sipaway data used for a site far away) and
    distances. The TypeScript test rebuilds these from the same inputs."""
    from . import examples, surface
    ex = examples.load_example("sipaway")
    h = ex["light_obj"]
    lat_b, lon_b = 16.1883, -88.5992
    cs = surface.clear_sky_light(lat_b, lon_b)
    ks = [0, 100, 160, 260, 364]
    clear = dict(lat=lat_b, lon=lon_b, days=ks, ghi=[cs.ghi[k * 24:(k + 1) * 24].tolist() for k in ks],
                 dhi=[cs.dhi[k * 24:(k + 1) * 24].tolist() for k in ks], ghi_sum=float(cs.ghi.sum()), dhi_sum=float(cs.dhi.sum()))
    cases = []
    for name, light, lat, lon, tz in [("sipaway_own_data", "example", ex["lat"], ex["lon"], ex["utc_offset_h"]),
                                      ("sipaway_data_at_belize", "example", lat_b, lon_b, -6.0),
                                      ("clear_sky_belize", "clear", lat_b, lon_b, -6.0)]:
        dl = surface.day_light(h if light == "example" else cs, 2025, 6, 10, lat, lon, tz)
        cases.append(dict(name=name, light=light, lat=lat, lon=lon, tz=tz, y=2025, m=6, d=10,
                          par_direct_h=dl.par_direct_h.tolist(), par_diffuse=dl.par_diffuse.tolist(),
                          par_circumsolar_h=dl.par_circumsolar_h.tolist(),
                          wind=[None if not np.isfinite(v) else float(v) for v in dl.wind],
                          light_total=dl.light_total, light_dropped=dl.light_dropped))
    pairs = [(10.4675, 123.4506, 16.1883, -88.5992), (10.4675, 123.4506, 10.9, 123.5), (-18.0, 147.0, -18.4, 147.3)]
    dist = [dict(a=[a, b], b=[c, d], km=surface.distance_km(a, b, c, d)) for a, b, c, d in pairs]
    # ---- v5.2: values centred off the half hour (as PVGIS-SARAH3), and a typical year built from real years
    cs9 = surface.HourlyLight(t_utc=cs.t_utc - 21.0, ghi=cs.ghi, dhi=cs.dhi, unit="W", wind=cs.wind, lat=cs.lat, lon=cs.lon,
                              kind="tmy", center_min=9.0)
    dl9 = surface.day_light(cs9, 2025, 6, 10, lat_b, lon_b, -6.0)
    off = dict(name="clear_sky_belize_centred_at_9_min", center_min=9.0, lat=lat_b, lon=lon_b, tz=-6.0, y=2025, m=6, d=10,
               par_direct_h=dl9.par_direct_h.tolist(), par_diffuse=dl9.par_diffuse.tolist(),
               par_circumsolar_h=dl9.par_circumsolar_h.tolist(), light_total=dl9.light_total, light_dropped=dl9.light_dropped)
    ty = typical_year_case()
    return dict(clear_sky=clear, days=cases, distances=dist, off_center=off, typical_year=ty)


def typical_year_input():
    """The shared multi-year input (shared/golden/typical_year_input.json) as an HourlyLight."""
    from . import surface
    j = json.loads((SHARED / "golden" / "typical_year_input.json").read_text(encoding="utf-8"))
    t0 = surface._iso_to_utc_min(j["start"])
    n = len(j["ghi"])
    return surface.HourlyLight(t_utc=t0 + 60.0 * np.arange(n), ghi=np.array(j["ghi"], float), dhi=np.array(j["dhi"], float),
                               unit="W", lat=j["lat"], lon=j["lon"], database="PVGIS-ERA5", kind="hourly",
                               center_min=float(j["center_min"]))


def typical_year_case() -> dict:
    from . import surface
    t = surface.typical_year(typical_year_input())
    ks = [0, 1000, 2500, 4000, 5500, 7000, 8759]
    om = dict(latitude=10.5, longitude=123.5, utc_offset_seconds=0, hourly_units=dict(wind_speed_10m="km/h"),
              hourly=dict(time=[f"2020-01-{1 + k // 24:02d}T{k % 24:02d}:00" for k in range(48)],
                          shortwave_radiation=[max(0.0, 800.0 - 30.0 * abs(k % 24 - 4)) if k % 24 < 12 else 0.0 for k in range(46)] + [None, None],
                          diffuse_radiation=[max(0.0, 300.0 - 20.0 * abs(k % 24 - 4)) if k % 24 < 12 else 0.0 for k in range(46)] + [None, None],
                          wind_speed_10m=[18.0] * 48))
    o = surface.parse_open_meteo(om)
    return dict(years=t.tmy_years, database=t.database, ghi_sum=float(t.ghi.sum()), dhi_sum=float(t.dhi.sum()),
                samples=[dict(k=k, ghi=float(t.ghi[k]), dhi=float(t.dhi[k])) for k in ks], t0=float(t.t_utc[0]),
                open_meteo=dict(reply=om, n=len(o.ghi), t0=float(o.t_utc[0]), center_min=o.center_min, ghi_sum=float(o.ghi.sum()),
                                dhi_sum=float(o.dhi.sum()), wind0=float(o.wind[0]), lat=o.lat, lon=o.lon))


def write_all() -> list[str]:
    out = SHARED / "golden"
    out.mkdir(parents=True, exist_ok=True)
    written = []
    for name, fn in [("solar", golden_solar), ("optics", golden_optics), ("engine", golden_engine), ("scenarios", golden_scenarios), ("surface", golden_surface)]:
        p = out / f"{name}.json"
        p.write_text(json.dumps(fn(), indent=1), encoding="utf-8")
        written.append(str(p))
    return written


if __name__ == "__main__":
    for p in write_all():
        print("wrote", p)
