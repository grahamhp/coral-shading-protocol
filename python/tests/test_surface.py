from pathlib import Path

import numpy as np
import pytest

from coralshading import SHARED, solar, surface

RAW = SHARED / "examples" / "raw"
LAT, LON, TZ = 10.4675, 123.4506, 8


def _read(name):
    p = RAW / name
    if not p.exists():
        pytest.skip(f"{name} not downloaded")
    return surface.parse_pvgis(p.read_text(encoding="utf-8"))


def test_par_conversion_values():
    b, d = surface.to_par(1000.0, 0.0)
    assert float(b) == pytest.approx(0.5 * 1000 * 4.57) and float(d) == 0.0
    b, d = surface.to_par(1000.0, 1000.0)
    assert float(b) == pytest.approx(0.0) and float(d) == pytest.approx(0.5 * 1000 * 4.24)
    assert float(surface.diffuse_fraction_par(0.3)) == pytest.approx((1 + 0.3 * (1 - 0.09)) * 0.3)
    b, d = surface.to_par(800.0, 240.0)
    assert 2.1 < (float(b) + float(d)) / 800.0 < 2.3       # about 2.2 umol per joule of global light


def test_erbs():
    assert float(surface.erbs_diffuse_fraction(0.1)) == pytest.approx(0.991)
    assert float(surface.erbs_diffuse_fraction(0.9)) == pytest.approx(0.165)
    lo, hi = surface.erbs_diffuse_fraction([0.2199, 0.2201])
    assert abs(lo - hi) < 2e-3


def test_parse_tmy_and_series():
    t = _read("pvgis_tmy_sipaway.csv")
    assert t.kind == "tmy" and len(t.ghi) == 8760 and t.wind is not None
    assert abs(t.lat - 10.467) < 1e-6
    # TMY re-dated onto the reference year: first value is 1 Jan 00:00-01:00 UTC, centred at 00:30
    assert t.t_utc[0] == solar.days_from_civil(surface.REF_YEAR, 1, 1) * 1440 + 30
    assert t.ghi[0] == pytest.approx(440.7)
    s = _read("pvgis_seriescalc_sipaway_2014_2023_ERA5.csv")
    assert s.kind == "hourly" and s.database == "PVGIS-ERA5" and len(s.ghi) > 80000
    assert np.all(s.dhi <= s.ghi + 1e-9)


@pytest.mark.parametrize("ymd", [(2025, 4, 28), (2025, 5, 1), (2025, 8, 31), (2025, 2, 29 - 1)])
def test_day_conserves_hourly_totals(ymd):
    t = _read("pvgis_tmy_sipaway.csv")
    y, m, d = ymd
    dl = surface.day_light(t, y, m, d, LAT, LON, TZ, step=10.0)
    centers, ghi, dhi, _ = surface.hourly_window(t, y, m, d, TZ)
    day0 = solar.days_from_civil(y, m, d) * 1440 - 60 * TZ
    # expected PAR total: each hour converted at its own diffuse fraction, counting only the part in the day
    exp = 0.0
    for c, G, D in zip(centers, ghi, dhi):
        lo = c - 30 - day0
        mins = lo + np.arange(0.5, 60, 1.0)
        cz = np.clip(np.cos(np.radians(solar.solar_position(y, m, d, mins, LAT, LON, TZ).zenith_geometric)), 0, None)
        if cz.mean() == 0:
            continue
        frac = cz[(mins >= 0) & (mins < 1440)].sum() / cz.sum()
        b, dd = surface.to_par(G, D)
        exp += (float(b) + float(dd)) * 60 * frac
    got = (dl.par_direct_h + dl.par_diffuse + dl.par_circumsolar_h).sum() * 10.0
    assert got == pytest.approx(exp, rel=1e-9)


def test_circumsolar_split():
    """Hay-Davies: the circumsolar part is the anisotropy index A = DNI / extraterrestrial normal times the diffuse
    light; switching it off returns the same total diffuse light, all isotropic."""
    t = _read("pvgis_tmy_sipaway.csv")
    on = surface.day_light(t, 2025, 5, 2, LAT, LON, TZ)
    off = surface.day_light(t, 2025, 5, 2, LAT, LON, TZ, circumsolar=False)
    assert np.allclose(on.par_diffuse + on.par_circumsolar_h, off.par_diffuse, rtol=1e-12, atol=1e-9)
    assert np.allclose(on.par_direct_h, off.par_direct_h) and off.par_circumsolar_h.sum() == 0
    share = on.par_circumsolar_h.sum() / off.par_diffuse.sum()
    assert 0.0 < share < 1.0
    # an overcast hour (no beam) has no circumsolar light
    h = surface.HourlyLight(t_utc=t.t_utc, ghi=t.dhi.copy(), dhi=t.dhi.copy(), kind="tmy", lat=t.lat, lon=t.lon)
    oc = surface.day_light(h, 2025, 5, 2, LAT, LON, TZ)
    assert oc.par_circumsolar_h.sum() == 0.0


def test_first_of_month_keeps_morning():
    t = _read("pvgis_tmy_sipaway.csv")
    dl = surface.day_light(t, 2025, 5, 1, LAT, LON, TZ, step=10.0)
    morning = (dl.minutes > 6 * 60) & (dl.minutes < 8 * 60)
    assert (dl.par_direct_h[morning] + dl.par_diffuse[morning]).min() > 50


def test_night_is_dark_and_noon_bright():
    t = _read("pvgis_tmy_sipaway.csv")
    dl = surface.day_light(t, 2025, 4, 28, LAT, LON, TZ, step=10.0)
    tot = dl.par_direct_h + dl.par_diffuse
    assert tot[dl.zenith > 91].max() == 0.0
    assert tot.max() > 1000
    dli = surface.daily_integral(tot, 10.0)
    assert 25 < dli < 70      # surface daily light at 10 deg N in April, mol m-2 d-1


def test_series_requires_covered_date():
    s = _read("pvgis_seriescalc_sipaway_2014_2023_ERA5.csv")
    surface.day_light(s, 2020, 6, 1, LAT, LON, TZ)
    with pytest.raises(ValueError):
        surface.day_light(s, 2030, 6, 1, LAT, LON, TZ)


BELIZE = (16.1883, -88.5992)


def test_doubled_line_endings_and_truncated_files():
    p = RAW / "pvgis_tmy_sipaway.csv"
    if not p.exists():
        pytest.skip("pvgis_tmy_sipaway.csv not downloaded")
    text = p.read_bytes().decode("utf-8")
    a = surface.parse_pvgis(text)
    b = surface.parse_pvgis(text.replace("\r\n", "\n").replace("\n", "\r\r\n"))    # Windows text-mode copy
    assert np.array_equal(a.ghi, b.ghi) and a.ghi.sum() > 0
    lines = text.splitlines()
    cut = "\n".join(lines[:200] + lines[-12:])                                        # most hours missing
    with pytest.raises(ValueError, match="8760 expected"):
        surface.parse_pvgis(cut)


def test_timing_guard_drops_light_that_cannot_match_the_sun():
    from coralshading import examples
    h = examples.load_example("sipaway")["light_obj"]
    own = surface.day_light(h, 2025, 6, 10, LAT, LON, TZ)
    assert own.light_dropped == 0.0
    far = surface.day_light(h, 2025, 6, 10, *BELIZE, -6)
    assert far.light_dropped / far.light_total > 0.5
    # nothing brighter than the light above the atmosphere (as PAR) at any step
    tot = far.par_direct_h + far.par_diffuse + far.par_circumsolar_h
    assert tot.max() < surface.SOLAR_CONSTANT * 1.04 * surface.PAR_FRACTION * surface.Q_DIRECT


def test_clear_sky_year():
    cs = surface.clear_sky_light(*BELIZE)
    assert cs.kind == "tmy" and len(cs.ghi) == 8760 and np.all(cs.dhi <= cs.ghi)
    k = solar.days_from_civil(2001, 6, 10) - solar.days_from_civil(2001, 1, 1)
    assert cs.ghi[k * 24 + 6:k * 24 + 30].sum() / 1000 == pytest.approx(8.14, abs=0.02)   # pvlib Haurwitz: 8.141 kWh m-2
    dl = surface.day_light(cs, 2025, 6, 10, *BELIZE, -6)
    dif = dl.par_diffuse + dl.par_circumsolar_h
    assert dl.light_dropped == 0.0 and 0.15 < dif.sum() / (dl.par_direct_h + dif).sum() < 0.3
    assert surface.distance_km(LAT, LON, *BELIZE) == pytest.approx(15420, rel=0.01)
    assert surface.utc_offset_from_lon(LON) == 8 and surface.utc_offset_from_lon(BELIZE[1]) == -6 and surface.utc_offset_from_lon(7.5) == 1
