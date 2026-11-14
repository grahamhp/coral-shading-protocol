"""Fast engine: invariants, Kd calibration, and the accuracy contract against the 3-D Monte Carlo."""
import json
import math

import numpy as np
import pytest

from coralshading import SHARED, engine, optics, validate
from coralshading.geometry import Panel


def _open_ratio(w, st):
    """Open-water Ed(z)/Ed(0+) at the Kd reference conditions (sun zenith 20 deg, 30 % diffuse)."""
    Ts = float(optics.fresnel_t(math.cos(math.radians(engine.REF_SUN_ZENITH)))); Tk = optics.sky_transmittance()
    ws = (1 - engine.REF_DIFFUSE) * Ts / ((1 - engine.REF_DIFFUSE) * Ts + engine.REF_DIFFUSE * Tk)
    beam, A = engine._interp_sunz(st, np.array([engine.REF_SUN_ZENITH]))
    return ws * (beam[0] + 2 * math.pi * A[0][0].sum()) + (1 - ws) * st.sky_total


@pytest.mark.parametrize("kd,w0,depth", [(0.05, 0.7, 10), (0.10, 0.7, 10), (0.21, 0.5, 10), (0.21, 0.9, 10),
                                         (0.40, 0.7, 15), (0.60, 0.8, 20)])
def test_kd_round_trip(kd, w0, depth):
    w = engine.Water(kd=kd, w0=w0, depth=depth)
    assert _open_ratio(w, engine.optical_state(w)) == pytest.approx(math.exp(-kd * depth), rel=0.01)


def test_open_water_identity():
    w = engine.Water(kd=0.21, w0=0.7, depth=10)
    r = engine.run_day(validate._one_step_day(30.0, 120.0, 0.7, 0.3), w, [], np.array([0.0, 1.0]), np.array([0.0, -2.0]))
    assert np.allclose(r.ed[0] / r.ed_open[0], 1.0, rtol=1e-12)


def test_huge_opaque_panel_blocks_everything():
    w = engine.Water(kd=0.21, w0=0.7, depth=10)
    r = engine.run_day(validate._one_step_day(30.0, 120.0, 0.7, 0.3), w,
                       [Panel(cx=0, cy=0, lx=500, ly=500, height=0.75, tau=0.0)], np.array([0.0]), np.array([0.0]))
    assert r.ed[0, 0] / r.ed_open[0] < 1e-3


def test_huge_cloth_transmits_its_rating():
    w = engine.Water(kd=0.21, w0=0.7, depth=10)
    r = engine.run_day(validate._one_step_day(30.0, 120.0, 0.7, 0.3), w,
                       [Panel(cx=0, cy=0, lx=500, ly=500, height=0.75, tau=0.21)], np.array([0.0]), np.array([0.0]))
    assert r.ed[0, 0] / r.ed_open[0] == pytest.approx(0.21, abs=2e-3)


def test_low_east_sun_lights_the_east_edge():
    c = [c for c in validate.cases() if c["sun"] == "low_east" and c["panel_name"] == "canopy0.75"][0]
    _, f = validate.engine_case(c)
    assert f["E0.55"] > 3 * f["W0.55"]


def _validation_rows():
    p = SHARED / "validation" / "engine_vs_mc.json"
    return json.loads(p.read_text(encoding="utf-8"))["rows"] if p.exists() else []


@pytest.mark.parametrize("row", _validation_rows(), ids=lambda r: f'{r["case"]["water"]}-{r["case"]["sun"]}-{r["case"]["panel_name"]}')
def test_engine_regression_and_accuracy(row):
    """The stored fast values are reproduced, and they agree with the 3-D Monte Carlo within the stated
    accuracy (docs/validation.md): -0.02 - 2 SE <= fast - MC <= 0.04 + 2 SE in transmission units (the fast
    engine slightly over-predicts light in the shade, more for higher canopies)."""
    _, fast = validate.engine_case(row["case"])
    for k, v in fast.items():
        assert v == pytest.approx(row["fast"][k], abs=1e-9)
        err, se = v - row["mc"][k], row["mc_se"][k]
        assert -0.02 - 2 * se <= err <= 0.04 + 2 * se, k
