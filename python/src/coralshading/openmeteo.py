"""Hourly ERA5 light for any site from the Open-Meteo archive, reduced to a typical year.

ERA5 (Hersbach et al. 2020) is the reanalysis that PVGIS itself uses outside its satellite area, so there this
route and PVGIS agree hour by hour (docs/validation.md, section 5). Inside the satellite area (about 65 W to 65 E)
PVGIS-SARAH3 follows clouds more closely; prefer `pvgis.fetch` there. The app uses the same request and the same
typical-year method (surface.typical_year). Data: Open-Meteo.com, CC BY 4.0; free for non-commercial use.
Downloads are cached on disk like the PVGIS ones.
"""
from __future__ import annotations

import datetime as _dt
import hashlib

from . import pvgis, surface

API = "https://archive-api.open-meteo.com/v1/archive"
N_YEARS = 10


def url(lat: float, lon: float, last_year: int | None = None, n_years: int = N_YEARS) -> str:
    """The last n_years complete calendar years. One more day is requested: Open-Meteo stamps each hour at its
    end, so the last hour of 31 December carries the stamp of 1 January 00:00."""
    y1 = last_year if last_year is not None else _dt.datetime.now(_dt.timezone.utc).year - 1
    y0 = y1 - n_years + 1
    return (f"{API}?latitude={lat:.4f}&longitude={lon:.4f}&start_date={y0}-01-01&end_date={y1 + 1}-01-01"
            "&hourly=shortwave_radiation,diffuse_radiation,wind_speed_10m&models=era5&timezone=GMT&wind_speed_unit=ms")


def fetch_hourly(lat: float, lon: float, last_year: int | None = None, n_years: int = N_YEARS, use_cache: bool = True) -> surface.HourlyLight:
    u = url(lat, lon, last_year, n_years)
    p = pvgis.cache_dir() / ("om_" + hashlib.sha1(u.encode()).hexdigest()[:16] + ".json")
    if use_cache and p.exists():
        text = p.read_bytes().decode("utf-8")
    else:
        text = pvgis._get(u)
        p.write_bytes(text.encode("utf-8"))
    h = surface.parse_open_meteo(text)
    h.source = u
    return h


def fetch(lat: float, lon: float, last_year: int | None = None, n_years: int = N_YEARS, use_cache: bool = True) -> surface.HourlyLight:
    """A typical year of ERA5 light for the site (surface.typical_year of the last n_years years)."""
    return surface.typical_year(fetch_hourly(lat, lon, last_year, n_years, use_cache))
