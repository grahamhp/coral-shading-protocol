"""Example sites shipped with both products (shared/examples/*.json).

A TMY is stored on a reference non-leap year (2001): value i is the average for the UTC hour starting at
hour i of the year, centred at i h + 30 min. Lookup is by (month, day, UTC hour), so the year never matters.
"""
from __future__ import annotations

import json

import numpy as np

from . import SHARED, solar, surface

REF_YEAR = surface.REF_YEAR


def light_to_json(h: surface.HourlyLight) -> dict:
    r = lambda a: [round(float(x), 1) for x in a]
    j = dict(kind=h.kind, unit=h.unit, source=h.source, database=h.database, lat=h.lat, lon=h.lon,
             ref_year=REF_YEAR, ghi=r(h.ghi), dhi=r(h.dhi),
             wind=None if h.wind is None else [round(float(x), 2) for x in h.wind])
    if h.center_min != 30.0:              # values centred off the half hour (PVGIS-SARAH3)
        j["center_min"] = round(float(h.center_min), 2)
    return j


def light_from_json(j: dict) -> surface.HourlyLight:
    base = solar.days_from_civil(j.get("ref_year", REF_YEAR), 1, 1)
    n = len(j["ghi"])
    cm = float(j.get("center_min", 30.0))
    return surface.HourlyLight(t_utc=base * 1440.0 + cm + 60.0 * np.arange(n), ghi=np.array(j["ghi"], float),
                               dhi=np.array(j["dhi"], float), unit=j["unit"],
                               wind=None if j.get("wind") is None else np.array(j["wind"], float),
                               lat=j.get("lat"), lon=j.get("lon"), source=j.get("source", ""),
                               database=j.get("database", ""), kind=j["kind"], center_min=cm)


def build_sipaway() -> dict:
    raw = (SHARED / "examples" / "raw" / "pvgis_tmy_sipaway.csv").read_text(encoding="utf-8")
    h = surface.parse_pvgis(raw)
    h.database = "PVGIS-ERA5 typical meteorological year"
    site = dict(
        id="sipaway", name="Sipaway Island, Philippines",
        description="Example site: the 2025 shading experiment at Sipaway Island, San Carlos City, Negros "
                    "Occidental (Tañon Strait). Light: PVGIS typical meteorological year.",
        lat=10.4675, lon=123.4506, utc_offset_h=8.0,
        deployment=dict(start="2025-04-28", end="2025-08-08"),
        light=light_to_json(h),
    )
    (SHARED / "examples").mkdir(parents=True, exist_ok=True)
    (SHARED / "examples" / "sipaway.json").write_text(json.dumps(site, separators=(",", ":")), encoding="utf-8")
    return site


# Example reefs bundled with the app (v5.2) so it can be tried offline in several regions. Light: the PVGIS typical
# year for each point. The deployment dates are examples in the local warm season, not advice.
EXAMPLE_SITES = [
    # id, name, lat, lon, clock UTC offset, example deployment
    ("florida_keys", "Florida Keys, USA", 24.63, -81.11, -5.0, ("2027-07-15", "2027-10-15")),
    ("belize", "South Water Caye, Belize", 16.81, -88.08, -6.0, ("2027-08-01", "2027-10-31")),
    ("bonaire", "Bonaire, Dutch Caribbean", 12.16, -68.28, -4.0, ("2027-08-15", "2027-11-15")),
    ("eilat", "Eilat, Gulf of Aqaba (Red Sea)", 29.50, 34.92, 2.0, ("2027-07-01", "2027-09-30")),
    ("mombasa", "Mombasa, Kenya", -4.05, 39.72, 3.0, ("2027-03-01", "2027-05-15")),
    ("maldives", "North Malé Atoll, Maldives", 4.17, 73.51, 5.0, ("2027-04-01", "2027-06-15")),
    ("lizard_island", "Lizard Island, Great Barrier Reef", -14.67, 145.46, 10.0, ("2027-01-15", "2027-04-15")),
    ("kaneohe", "Kāneʻohe Bay, Hawaiʻi", 21.43, -157.79, -10.0, ("2027-08-01", "2027-10-31")),
    ("moorea", "Moorea, French Polynesia", -17.49, -149.83, -10.0, ("2027-02-01", "2027-04-30")),
]


def build_examples(fetch=None) -> list:
    """Write shared/examples/<id>.json for EXAMPLE_SITES from PVGIS typical years (downloads them; cached)."""
    from . import pvgis
    out = []
    for sid, name, lat, lon, tz, (d0, d1) in EXAMPLE_SITES:
        h = (fetch or pvgis.fetch)(lat, lon, "tmy")
        sat = h.center_min != 30.0
        h.database = ("PVGIS-SARAH3" if sat else "PVGIS-ERA5") + " typical meteorological year"
        h.source = "PVGIS 5.3"
        site = dict(id=sid, name=name, description=f"Example reef. Light: PVGIS typical meteorological year "
                    f"({'SARAH-3 satellite record' if sat else 'ERA5 reanalysis'}). Example dates in the local warm season.",
                    lat=lat, lon=lon, utc_offset_h=tz, deployment=dict(start=d0, end=d1), light=light_to_json(h))
        (SHARED / "examples" / f"{sid}.json").write_text(json.dumps(site, separators=(",", ":")), encoding="utf-8")
        out.append(sid)
    return out


def list_examples() -> list:
    """Ids of the bundled example sites, Sipaway first."""
    return ["sipaway"] + [s[0] for s in EXAMPLE_SITES if (SHARED / "examples" / f"{s[0]}.json").exists()]


def load_example(name: str = "sipaway") -> dict:
    j = json.loads((SHARED / "examples" / f"{name}.json").read_text(encoding="utf-8"))
    j["light_obj"] = light_from_json(j["light"])
    return j
