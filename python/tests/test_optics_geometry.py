import json
import math

import numpy as np
import pytest

from coralshading import SHARED, optics, solar
from coralshading.geometry import Panel, Target, ray_hit_xy, transmission_along


def test_snell_and_fresnel():
    assert optics.SNELL_WINDOW_DEG == pytest.approx(48.27, abs=0.01)
    assert float(optics.refracted_zenith_deg(90.0)) == pytest.approx(optics.SNELL_WINDOW_DEG)
    assert float(optics.fresnel_t(1.0)) == pytest.approx(1 - ((1.34 - 1) / (1.34 + 1)) ** 2)
    assert 0.92 < optics.sky_transmittance() < 0.94


def test_cox_munk():
    assert float(optics.cox_munk_mss(5.0)) == pytest.approx(0.0286)
    u = optics.unit_facets(4096)
    assert abs(u.mean()) < 0.02 and abs(u.std() - 1) < 0.02


def test_flat_sun_ray():
    dirs, w, tot = optics.refracted_sun_rays(40.0, 90.0, 0.0)
    assert len(w) == 1 and w[0] == 1.0
    zw = math.degrees(math.acos(dirs[0, 2]))
    assert zw == pytest.approx(float(optics.refracted_zenith_deg(40.0)), abs=1e-9)
    assert dirs[0, 0] > 0 and abs(dirs[0, 1]) < 1e-12            # points back toward the sun in the east
    assert tot == pytest.approx(float(optics.fresnel_t(math.cos(math.radians(40)))))


def test_wavy_sun_rays_spread_and_transmit():
    flat, _, tf = optics.refracted_sun_rays(30.0, 90.0, 0.0)
    dirs, w, tot = optics.refracted_sun_rays(30.0, 90.0, 7.0, n_facets=256)
    mean = (dirs * w[:, None]).sum(0); mean /= np.linalg.norm(mean)
    assert np.degrees(np.arccos(np.clip(mean @ flat[0], -1, 1))) < 1.0
    spread = np.degrees(np.arccos(np.clip(dirs @ flat[0], -1, 1)))
    assert (w * spread).sum() > 2.0                                # several degrees of blur
    assert abs(tot - tf) < 0.03


def test_panel_rotation_and_hits():
    p = Panel(lx=4.0, ly=1.0, rot_deg=90.0)
    assert bool(p.inside(0.0, 1.9)) and not bool(p.inside(1.9, 0.0))
    hx, hy, ok = ray_hit_xy(0.1, 0.2, np.array([0.0, 0.0, 1.0]), 0.75, 10.0)
    assert (float(hx), float(hy), bool(ok)) == (0.1, 0.2, True)
    # floating panel above the surface, vertical ray
    hx, hy, ok = ray_hit_xy(0.0, 0.0, np.array([0.0, 0.0, 1.0]), 12.0, 10.0)
    assert bool(ok) and abs(float(hx)) < 1e-12
    # ray outside Snell's window cannot reach a panel above the water
    up = np.array([math.sin(math.radians(60)), 0.0, math.cos(math.radians(60))])
    assert not bool(ray_hit_xy(0.0, 0.0, up, 12.0, 10.0)[2])


def test_target_grid():
    X, Y = Target("circle", 1.1, 1.1).grid(0.01)
    assert len(X) == pytest.approx(math.pi * 0.55 ** 2 / 1e-4, rel=0.01)
    X, Y = Target("rect", 2.0, 1.0).grid(0.05)
    assert len(X) == 40 * 20 and X.max() < 1.0 and Y.max() < 0.5


def test_flat_sea_shading_matches_paper_flat_model():
    """Hours of direct sun below the 1.88 x 2.0 m canopy at 0.75 m, flat sea, 28 April 2025, against the
    paper's results. The paper's 09_wave_refraction.R mirrors east-west and north-south (sign error in its
    ray trace, see docs/DECISIONS.md), so its 'E' is our W and vice versa; totals match."""
    ref = json.loads((SHARED / "golden" / "paper_wave_regression.json").read_text())
    rows = {(r["offset_m"], r["direction"]): r for r in ref["day_2025_04_28"] if r["U"] == 0}
    canopy = [Panel(lx=1.88, ly=2.0, height=0.75, tau=0.0)]
    mins = np.arange(0, 1440, 2.0) + 1.0
    sp = solar.solar_position(2025, 4, 28, mins, 10.4675, 123.4506, 8)
    up = sp.zenith < 90
    for (off, dname), mirror in [((0.55, "E"), "W"), ((0.55, "W"), "E"), ((0.4, "E"), "W"), ((0.2, "W"), "E"), ((0.0, "centre"), "centre")]:
        bearing = {"E": 90.0, "W": 270.0, "centre": 0.0}[dname]
        px, py = off * math.sin(math.radians(bearing)), off * math.cos(math.radians(bearing))
        hours = 0.0; first = None
        for k in np.where(up)[0]:
            dirs, w, _ = optics.refracted_sun_rays(float(sp.zenith[k]), float(sp.azimuth[k]), 0.0)
            lit = float(transmission_along(px, py, dirs[0], canopy, 10.0)) > 0.5
            if lit:
                hours += 2 / 60; first = first if first is not None else mins[k]
        r = rows[(off, mirror)]
        assert hours == pytest.approx(r["direct_equiv_hours"], abs=0.1), (off, dname, hours, r)
        if r["first_direct"] == r["first_direct"] and first is not None:   # not NaN
            assert abs(first - 1 - r["first_direct"]) <= 4
    # physics check: with the sun in the east, the east edge (0.55 m E) is sunlit and the west edge is not
    k = int(np.argmin(np.abs(mins - (7 * 60 + 1))))
    dirs, _, _ = optics.refracted_sun_rays(float(sp.zenith[k]), float(sp.azimuth[k]), 0.0)
    assert float(transmission_along(0.55, 0.0, dirs[0], canopy, 10.0)) == 1.0
    assert float(transmission_along(-0.55, 0.0, dirs[0], canopy, 10.0)) == 0.0
