import math

import numpy as np
import pytest

from coralshading import solar

SITES = [  # name, lat, lon, UTC offset
    ("Sipaway", 10.4675, 123.4506, 8),
    ("Lizard Island", -14.67, 145.45, 10),
    ("Florida Keys", 24.55, -81.78, -5),
    ("Eilat", 29.50, 34.92, 2),
    ("Oahu", 21.30, -157.80, -10),
]
DATES = [(2025, 1, 15), (2025, 3, 20), (2025, 4, 28), (2025, 6, 21), (2025, 9, 23), (2025, 12, 21)]


def test_civil_days_roundtrip():
    assert solar.days_from_civil(1970, 1, 1) == 0
    assert solar.days_from_civil(2000, 3, 1) == 11017
    for z in range(-1000, 30000, 37):
        assert solar.days_from_civil(*solar.civil_from_days(z)) == z


def test_against_nrel_spa():
    pvlib = pytest.importorskip("pvlib")
    import pandas as pd
    worst_z = worst_a = 0.0
    for _, lat, lon, tz in SITES:
        for (y, m, d) in DATES:
            mins = np.arange(0, 1440, 20.0)
            sp = solar.solar_position(y, m, d, mins, lat, lon, tz)
            idx = pd.Timestamp(year=y, month=m, day=d, tz=f"Etc/GMT{-tz:+d}") + pd.to_timedelta(mins, unit="min")
            ref = pvlib.solarposition.spa_python(idx, lat, lon)
            up = ref["apparent_zenith"].to_numpy() < 87
            dz = np.abs(sp.zenith[up] - ref["apparent_zenith"].to_numpy()[up])
            da = np.abs(((sp.azimuth[up] - ref["azimuth"].to_numpy()[up]) + 180) % 360 - 180)
            worst_z = max(worst_z, dz.max()); worst_a = max(worst_a, da.max())
    assert worst_z < 0.05, worst_z
    assert worst_a < 0.1, worst_a


def test_noon_is_zenith_minimum():
    for _, lat, lon, tz in SITES:
        for (y, m, d) in DATES:
            n = solar.solar_noon(y, m, d, lon, tz)
            mins = np.arange(n - 30, n + 30, 0.05)
            zg = solar.solar_position(y, m, d, mins, lat, lon, tz).zenith_geometric
            assert abs(mins[np.argmin(zg)] - n) < 0.2


def test_sunrise_sunset_against_spa():
    pvlib = pytest.importorskip("pvlib")
    import pandas as pd
    for _, lat, lon, tz in SITES:
        for (y, m, d) in DATES:
            sr, ss = solar.sunrise_sunset(y, m, d, lat, lon, tz)
            day = pd.DatetimeIndex([pd.Timestamp(year=y, month=m, day=d, tz=f"Etc/GMT{-tz:+d}")])
            ref = pvlib.solarposition.sun_rise_set_transit_spa(day, lat, lon)
            def mins(ts):
                ts = ts.iloc[0]
                return ts.hour * 60 + ts.minute + ts.second / 60
            assert abs(sr - mins(ref["sunrise"])) < 1.5
            assert abs(ss - mins(ref["sunset"])) < 1.5
            assert abs(solar.solar_noon(y, m, d, lon, tz) - mins(ref["transit"])) < 0.5


def test_sipaway_paper_design_ray():
    # Sipaway design time. 51.2 deg zenith at 08:14 on 28 April 2025 is the in-air design ray drawn by the
    # paper's reanalysis figure script fig1_redraw.py (n_w, za, zw = 1.34, 51.2, 35.6); solar noon 11:43.7 matches the 11:44 the paper
    # gives from the NOAA Solar Calculator. The azimuth (about 80 deg) is a regression value of this module.
    sp = solar.solar_position(2025, 4, 28, 8 * 60 + 14, 10.4675, 123.4506, 8)
    assert abs(float(sp.zenith) - 51.2) < 0.1
    assert abs(float(sp.azimuth) - 80.0) < 1.0
    assert abs(solar.solar_noon(2025, 4, 28, 123.4506, 8) - (11 * 60 + 43.7)) < 0.2


def test_noon_shift_moves_noon():
    y, m, d, lat, lon, tz = 2025, 4, 28, 10.4675, 123.4506, 8
    n = solar.solar_noon(y, m, d, lon, tz)
    user = 12 * 60.0
    s = solar.noon_shift("user", n, user=user)
    mins = np.arange(user - 20, user + 20, 0.05)
    zg = solar.sun_with_noon(y, m, d, mins, lat, lon, tz, s).zenith_geometric
    assert abs(mins[np.argmin(zg)] - user) < 0.2
    assert solar.noon_shift("computed", n) == 0.0
    with pytest.raises(ValueError):
        solar.noon_shift("user", n)


def test_data_noon_symmetric_day():
    y, m, d, lat, lon, tz = 2025, 6, 21, 10.4675, 123.4506, 8
    n = solar.solar_noon(y, m, d, lon, tz)
    mins = np.arange(0, 1440, 1.0)
    cz = np.cos(np.radians(solar.solar_position(y, m, d, mins, lat, lon, tz).zenith_geometric))
    assert abs(solar.data_noon(mins, np.clip(cz, 0, None)) - n) < 1.0
