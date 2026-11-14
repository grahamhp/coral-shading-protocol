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
    return dict(kind=h.kind, unit=h.unit, source=h.source, database=h.database, lat=h.lat, lon=h.lon,
                ref_year=REF_YEAR, ghi=r(h.ghi), dhi=r(h.dhi),
                wind=None if h.wind is None else [round(float(x), 2) for x in h.wind])


def light_from_json(j: dict) -> surface.HourlyLight:
    base = solar.days_from_civil(j.get("ref_year", REF_YEAR), 1, 1)
    n = len(j["ghi"])
    return surface.HourlyLight(t_utc=base * 1440.0 + 30.0 + 60.0 * np.arange(n), ghi=np.array(j["ghi"], float),
                               dhi=np.array(j["dhi"], float), unit=j["unit"],
                               wind=None if j.get("wind") is None else np.array(j["wind"], float),
                               lat=j.get("lat"), lon=j.get("lon"), source=j.get("source", ""),
                               database=j.get("database", ""), kind=j["kind"])


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


def load_example(name: str = "sipaway") -> dict:
    j = json.loads((SHARED / "examples" / f"{name}.json").read_text(encoding="utf-8"))
    j["light_obj"] = light_from_json(j["light"])
    return j
