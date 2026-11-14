"""Download sunlight data from PVGIS (EU Joint Research Centre) and read it.

PVGIS 5.3 API (https://re.jrc.ec.europa.eu/api/v5_3/): `tmy` (typical meteorological year) and `seriescalc`
(hourly series for chosen years, horizontal plane, with direct and diffuse components). No database is
requested, so PVGIS chooses the best one for the location (e.g. PVGIS-ERA5 where satellite data do not reach).
Downloads are cached on disk so repeated runs work offline.
"""
from __future__ import annotations

import hashlib
import os
import time
import urllib.error
import urllib.request
from pathlib import Path

from . import surface

BASE = "https://re.jrc.ec.europa.eu/api/v5_3"


def tmy_url(lat: float, lon: float) -> str:
    return f"{BASE}/tmy?lat={lat:.4f}&lon={lon:.4f}&outputformat=csv"


def hourly_url(lat: float, lon: float, start_year: int, end_year: int) -> str:
    return (f"{BASE}/seriescalc?lat={lat:.4f}&lon={lon:.4f}&startyear={start_year}&endyear={end_year}"
            f"&components=1&outputformat=csv")


def cache_dir() -> Path:
    d = Path(os.environ.get("CORALSHADING_CACHE", Path.home() / ".cache" / "coralshading"))
    d.mkdir(parents=True, exist_ok=True)
    return d


def _get(url: str, retries: int = 3, timeout: float = 120.0) -> str:
    last = None
    for k in range(retries):
        try:
            with urllib.request.urlopen(url, timeout=timeout) as r:
                return r.read().decode("utf-8", "replace")
        except urllib.error.HTTPError as e:            # PVGIS explains bad requests in the body
            body = e.read().decode("utf-8", "replace")[:400]
            raise RuntimeError(f"PVGIS refused the request ({e.code}): {body}") from None
        except (urllib.error.URLError, TimeoutError) as e:
            last = e
            time.sleep(2 * (k + 1))
    raise RuntimeError(f"Could not reach PVGIS: {last}")


def fetch_text(url: str, use_cache: bool = True) -> str:
    p = cache_dir() / (hashlib.sha1(url.encode()).hexdigest()[:16] + ".csv")
    if use_cache and p.exists():
        return p.read_bytes().decode("utf-8")
    text = _get(url)
    p.write_bytes(text.encode("utf-8"))        # bytes: text mode on Windows would double the line endings
    return text


def fetch(lat: float, lon: float, kind: str = "tmy", start_year: int | None = None, end_year: int | None = None,
          use_cache: bool = True) -> surface.HourlyLight:
    """Sunlight at the sea surface for a site. kind = "tmy" (typical year; best for design) or "hourly"
    (real weather for start_year..end_year)."""
    if kind == "tmy":
        url = tmy_url(lat, lon)
    elif kind == "hourly":
        if start_year is None or end_year is None:
            raise ValueError("hourly data need start_year and end_year")
        url = hourly_url(lat, lon, start_year, end_year)
    else:
        raise ValueError("kind must be 'tmy' or 'hourly'")
    h = surface.parse_pvgis(fetch_text(url, use_cache))
    h.source = url
    return h


def read_file(path: str | os.PathLike) -> surface.HourlyLight:
    """Read a PVGIS CSV saved from the website or the app's download link."""
    return surface.parse_pvgis(Path(path).read_text(encoding="utf-8"))
