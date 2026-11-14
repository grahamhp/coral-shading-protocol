"""High-level API and command line (fast settings; no network)."""
import numpy as np

from coralshading import SHARED, cli, design, pvgis


def _short():
    return design.design(10.4675, 123.4506, 8, (2025, 4, 28), (2025, 5, 3), light="example", spacing=0.2, robustness=False)


def test_design_sync_and_summary():
    r = _short()
    c, d = r.get("constant"), r.get("dynamic")
    assert c is not None and d is not None
    assert abs(c.transmission - d.transmission) < 0.003          # same daily light as the cloth
    assert 0.0 < d.transmission < 1.0 and d.panel.tau == 0.0
    s = r.summary()
    assert "Constant shading (shade cloth)" in s and "Dynamic shading (opaque canopy)" in s and "2025-04-28" in s


def test_to_csv(tmp_path):
    files = _short().to_csv(tmp_path)
    assert len(files) == 2
    head = open(files[0], encoding="utf-8").readline()
    assert head.startswith("x_east_m,y_north_m,constant_daily_light")


def test_cli_runs(capsys):
    assert cli.main(["design", "--lat", "10.4675", "--lon", "123.4506", "--start", "2025-04-28", "--end", "2025-04-30",
                     "--light", "example", "--spacing", "0.25", "--scenario", "constant"]) == 0
    assert "Constant shading" in capsys.readouterr().out


def test_read_pvgis_file():
    h = pvgis.read_file(SHARED / "examples" / "raw" / "pvgis_tmy_sipaway.csv")
    assert h.kind == "tmy" and len(h.ghi) == 8760


def test_urls():
    assert pvgis.tmy_url(10.4675, 123.4506).endswith("tmy?lat=10.4675&lon=123.4506&outputformat=csv")
    assert "components=1" in pvgis.hourly_url(10.4675, 123.4506, 2014, 2023)


def test_porites_cylindrica_preset_uses_measured_ek():
    from coralshading import pe
    c = pe.Coral.preset("porites_cylindrica", acclimate="site")
    assert c.ek == 1062 and c.ek_emax is None and abs(c.r_over_pg - 0.19) < 1e-9
    ek = pe.effective_ek(c, np.ones((2, 5, 3)) * 500.0, np.ones((2, 5)) * 900.0)
    assert np.allclose(ek, 1062)



def test_light_far_from_site_is_refused_and_warnings():
    import pytest
    from coralshading import design as d
    with pytest.raises(ValueError, match="km from the site"):
        d.design(16.1883, -88.5992, light="example")
    from coralshading import surface
    cs = surface.clear_sky_light(16.1883, -88.5992)
    w = d.light_warnings(cs, 16.1883, -88.5992, 8, (2025, 6, 1), 0.0)
    assert len(w) == 2 and w[0].startswith("Light data: clear-sky") and "UTC-6 fits" in w[1]
    assert d.light_warnings(cs, 16.1883, -88.5992, -6, (2025, 6, 1), 0.2)[1].startswith("20 % of the light")
