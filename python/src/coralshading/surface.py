"""Light at the sea surface: reading data, converting to PAR, and spreading hourly values over the day.

Sources (see shared/references.json):
- PAR is 0.50 of global (broadband) irradiance, nearly constant across sky conditions for sun elevations
  above 10 degrees; the diffuse share of PAR is larger than that of global irradiance:
  k_PAR = [1 + 0.3 (1 - k^2)] k, with k = diffuse / global (Spitters et al. 1986, eqs. 9-10).
- Energy to photons: 4.57 umol J-1 for daylight (sun plus sky) and 4.24 umol J-1 for diffuse skylight
  (McCree 1972). The direct beam uses 4.57.
- When only global irradiance is known, the diffuse fraction is estimated from the clearness index with the
  Erbs et al. (1982) correlation.
- PVGIS files are hourly averages with UTC time stamps. Hourly series (seriescalc) are stamped at the middle
  of the hour; TMY files are stamped at the start of the hour with an "Irradiance Time Offset" of 0.5 h.

Hourly averages are spread over the day so that each hour keeps exactly its total: within an hour the
horizontal irradiance follows the cosine of the solar zenith angle (the clear-sky shape), scaled to the
hour's mean. Direct normal irradiance is then constant within each hour.
- Circumsolar sky light (v5.1): part of the diffuse light comes from around the sun. Following Hay and Davies
  (1980), the share A = DNI / extraterrestrial normal irradiance (the anisotropy index, 0..1) of the diffuse
  light is treated as coming from the sun's direction; the rest is an isotropic sky. A clear sky has a large A;
  an overcast sky has A = 0, so all its diffuse light stays isotropic.
Identical in webapp/src/core/surface.ts.
"""
from __future__ import annotations

import math
from dataclasses import dataclass, field

import numpy as np

from . import solar

PAR_FRACTION = 0.50          # Spitters et al. 1986
Q_DIRECT = 4.57              # umol J-1, McCree 1972 (daylight)
Q_DIFFUSE = 4.24             # umol J-1, McCree 1972 (skylight)
SOLAR_CONSTANT = 1361.0      # W m-2 (Kopp and Lean 2011)
REF_YEAR = 2001              # TMY data are re-dated onto this non-leap year
KT_MAX = 1.0                 # an hour brighter than this share of the light above the atmosphere cannot match the sun
MATCH_KM = 50.0              # light data must be for a point within this distance of the site
CLEAR_SKY_WIND = 5.0         # m s-1, wind used with the clear-sky estimate (the light model has none)


@dataclass
class HourlyLight:
    """Hourly-average light at the surface, on a horizontal plane.
    t_utc: minutes since 1970-01-01 00:00 UTC at the MIDDLE of each hour.
    ghi, dhi: global and diffuse horizontal irradiance. unit 'W' (W m-2) or 'PAR' (umol m-2 s-1).
    wind: 10-m wind speed (m s-1) or None."""
    t_utc: np.ndarray
    ghi: np.ndarray
    dhi: np.ndarray
    unit: str = "W"
    wind: np.ndarray | None = None
    lat: float | None = None
    lon: float | None = None
    source: str = ""
    database: str = ""
    kind: str = "hourly"      # 'tmy' or 'hourly'
    notes: list = field(default_factory=list)


# ------------------------------------------------------------------ PAR conversion
def diffuse_fraction_par(k):
    """Diffuse fraction of PAR from the diffuse fraction of global irradiance (Spitters et al. 1986)."""
    k = np.clip(np.asarray(k, dtype=float), 0.0, 1.0)
    return np.minimum(1.0, (1.0 + 0.3 * (1.0 - k * k)) * k)


def to_par(ghi_w, dhi_w):
    """Horizontal direct and diffuse PAR (umol m-2 s-1) from global and diffuse irradiance (W m-2)."""
    g = np.clip(np.asarray(ghi_w, dtype=float), 0.0, None)
    d = np.clip(np.asarray(dhi_w, dtype=float), 0.0, None)
    with np.errstate(divide="ignore", invalid="ignore"):
        k = np.where(g > 0, np.minimum(d, g) / g, 0.0)
    kp = diffuse_fraction_par(k)
    p = PAR_FRACTION * g
    return Q_DIRECT * (1.0 - kp) * p, Q_DIFFUSE * kp * p


def extraterrestrial_horizontal(doy, cos_zenith):
    """Extraterrestrial irradiance on a horizontal plane (W m-2), Spencer-free simple form."""
    e0 = 1.0 + 0.033 * np.cos(2.0 * math.pi * np.asarray(doy, dtype=float) / 365.0)
    return SOLAR_CONSTANT * e0 * np.clip(cos_zenith, 0.0, None)


def erbs_diffuse_fraction(kt):
    """Erbs, Klein and Duffie (1982) hourly diffuse fraction from the clearness index kt."""
    kt = np.clip(np.asarray(kt, dtype=float), 0.0, 1.0)
    mid = 0.9511 - 0.1604 * kt + 4.388 * kt ** 2 - 16.638 * kt ** 3 + 12.336 * kt ** 4
    return np.where(kt <= 0.22, 1.0 - 0.09 * kt, np.where(kt <= 0.80, mid, 0.165))


# ------------------------------------------------------------------ parsing
def _stamp_to_utc_min(stamp: str) -> float:
    """PVGIS time stamp 'YYYYMMDD:HHMM' (UTC) to minutes since epoch."""
    y, m, d = int(stamp[0:4]), int(stamp[4:6]), int(stamp[6:8])
    hh, mm = int(stamp[9:11]), int(stamp[11:13])
    return solar.days_from_civil(y, m, d) * 1440.0 + hh * 60.0 + mm


def _header_value(lines, key):
    for ln in lines:
        if ln.startswith(key):
            return ln.split(":", 1)[1].strip().replace("\t", " ").split()[0]
    return None


def _check_rows(kind: str, t) -> None:
    """A typical year must have 8760 hours; an hourly series must have no gaps."""
    n = len(t)
    if kind == "tmy" and n != 8760:
        raise ValueError(f"The PVGIS typical-year file has {n} hourly rows; 8760 expected. Download it again.")
    if kind == "hourly" and n > 1 and round((t[-1] - t[0]) / 60.0) + 1 != n:
        raise ValueError(f"The PVGIS hourly file has {n} rows but spans {round((t[-1] - t[0]) / 60.0) + 1} hours; hours are missing.")


def parse_pvgis(text: str) -> HourlyLight:
    """Read a PVGIS CSV: typical meteorological year (tmy) or hourly series (seriescalc, components=1,
    horizontal plane). Raises ValueError with a plain message if the file is not recognised."""
    lines = [ln.rstrip("\r") for ln in text.splitlines()]
    hdr_i = next((i for i, ln in enumerate(lines) if ln.startswith("time")), None)
    if hdr_i is None:
        raise ValueError("Not a PVGIS hourly or TMY file: no 'time' column header found.")
    cols = [c.strip() for c in lines[hdr_i].split(",")]
    rows = []
    for ln in lines[hdr_i + 1:]:
        if not ln.strip():                         # blank lines (e.g. doubled line endings) are skipped
            continue
        if len(ln) < 13 or not ln[:8].isdigit() or ln[8] != ":":
            if rows:
                break
            continue
        rows.append(ln.split(","))
    if not rows:
        raise ValueError("The PVGIS file has a header but no data rows.")
    lat = _header_value(lines, "Latitude"); lon = _header_value(lines, "Longitude")
    offset_h = float(_header_value(lines, "Irradiance Time Offset") or 0.0)
    database = _header_value(lines, "Radiation database") or ""
    t = np.array([_stamp_to_utc_min(r[0]) for r in rows]) + 60.0 * offset_h
    col = {c: j for j, c in enumerate(cols)}
    def get(name):
        return np.array([float(r[col[name]]) for r in rows])
    if "G(h)" in col and "Gd(h)" in col:          # TMY
        ghi, dhi, kind = get("G(h)"), get("Gd(h)"), "tmy"
        database = database or "PVGIS TMY"
    elif "Gb(i)" in col and "Gd(i)" in col:      # hourly series, components on the (horizontal) plane
        slope = _header_value(lines, "Slope")
        if slope is not None and float(slope) != 0.0:
            raise ValueError("This PVGIS file is for a tilted plane; download it with slope 0 (horizontal).")
        dhi = get("Gd(i)"); ghi = get("Gb(i)") + dhi; kind = "hourly"
    elif "G(i)" in col:
        raise ValueError("This PVGIS file has total irradiance only; download it with 'radiation components' ticked.")
    else:
        raise ValueError(f"Unrecognised PVGIS columns: {', '.join(cols)}")
    _check_rows(kind, t)
    wind = get("WS10m") if "WS10m" in col else None
    ghi = np.clip(ghi, 0.0, None); dhi = np.clip(np.minimum(dhi, ghi), 0.0, None)
    h = HourlyLight(t_utc=t, ghi=ghi, dhi=dhi, unit="W", wind=wind,
                    lat=float(lat) if lat else None, lon=float(lon) if lon else None,
                    source="PVGIS 5.3", database=database, kind=kind)
    return tmy_to_reference_year(h) if kind == "tmy" else h


def tmy_to_reference_year(h: HourlyLight) -> HourlyLight:
    """Re-date a TMY onto REF_YEAR: value k is the average for UTC hour k of the year (centred at k h + 30 min).
    TMY months come from different years, so only (month, day, hour) is kept. 29 February is dropped."""
    out_g = np.zeros(8760); out_d = np.zeros(8760); out_w = np.full(8760, np.nan)
    base = solar.days_from_civil(REF_YEAR, 1, 1)
    for i, tu in enumerate(h.t_utc):
        c = tu - 30.0
        _, mm, dd = solar.civil_from_days(int(c // 1440))
        if (mm, dd) == (2, 29):
            continue
        k = (solar.days_from_civil(REF_YEAR, mm, dd) - base) * 24 + int((c % 1440) // 60)
        out_g[k] = h.ghi[i]; out_d[k] = h.dhi[i]
        if h.wind is not None:
            out_w[k] = h.wind[i]
    t = base * 1440.0 + 30.0 + 60.0 * np.arange(8760)
    return HourlyLight(t_utc=t, ghi=out_g, dhi=out_d, unit=h.unit, wind=None if h.wind is None else out_w,
                       lat=h.lat, lon=h.lon, source=h.source, database=h.database, kind="tmy")


# ------------------------------------------------------------------ day series
@dataclass
class DayLight:
    """Light at the surface for one local day on a regular time grid (centers of steps)."""
    minutes: np.ndarray        # local standard time, minutes after midnight (step centers)
    step: float                # minutes
    zenith: np.ndarray         # apparent solar zenith, degrees (with noon shift)
    azimuth: np.ndarray        # degrees clockwise from north
    par_direct_h: np.ndarray   # direct PAR on a horizontal plane, umol m-2 s-1
    par_diffuse: np.ndarray    # diffuse PAR on a horizontal plane, umol m-2 s-1
    wind: np.ndarray           # m s-1 (nan if unknown)
    light_total: float = 0.0   # light in the hourly data for this day (data units x minutes)
    light_dropped: float = 0.0 # part of it dropped by the timing guard (hours brighter than KT_MAX allows)
    par_circumsolar_h: np.ndarray | None = None   # circumsolar part of the diffuse PAR (horizontal), from the sun's
                                                   # direction (Hay and Davies 1980); par_diffuse is then the isotropic rest


def hourly_window(h: HourlyLight, y: int, m: int, d: int, tz: float):
    """Hourly records overlapping the local day (y, m, d), re-dated onto that calendar day.
    Returns (t_utc_centers, ghi, dhi, wind) with t_utc in the requested calendar.
    TMY data: each UTC hour is looked up by (month, day, hour), ignoring the year, because TMY months come
    from different years; 29 February falls back to 28 February.
    Hourly series: the requested date must be inside the series."""
    start = solar.days_from_civil(y, m, d) * 1440.0 - 60.0 * tz          # local midnight in UTC minutes
    first = math.floor((start - 60.0) / 60.0) * 60.0 + 30.0                # hour centers at hh:30
    centers = np.arange(first, start + 1440.0 + 60.0, 60.0)
    centers = centers[(centers + 30.0 > start) & (centers - 30.0 < start + 1440.0)]
    wind_all = h.wind if h.wind is not None else np.full(len(h.ghi), np.nan)
    if h.kind == "tmy":
        base = solar.days_from_civil(REF_YEAR, 1, 1)
        idx = []
        for c in centers:
            _, mm, dd = solar.civil_from_days(int((c - 30.0) // 1440))
            if (mm, dd) == (2, 29):
                mm, dd = 2, 28
            idx.append((solar.days_from_civil(REF_YEAR, mm, dd) - base) * 24 + int(((c - 30.0) % 1440) // 60))
    else:
        pos = {round(float(tu), 3): i for i, tu in enumerate(h.t_utc)} if not hasattr(h, "_pos") else h._pos
        object.__setattr__(h, "_pos", pos)
        idx = []
        for c in centers:
            i = pos.get(round(float(c), 3))
            if i is None:
                raise ValueError(f"The light data do not cover {y}-{m:02d}-{d:02d}.")
            idx.append(i)
    idx = np.array(idx, dtype=int)
    return centers, h.ghi[idx], h.dhi[idx], wind_all[idx]


def day_light(h: HourlyLight, y: int, m: int, d: int, lat: float, lon: float, tz: float,
              step: float = 10.0, noon_shift: float = 0.0, circumsolar: bool = True) -> DayLight:
    """Surface light for one local day: hourly averages spread with a cos(zenith) shape inside each hour
    (each hour keeps its total exactly), converted to PAR, averaged onto steps of `step` minutes.
    Timing guard: an hour can hold at most KT_MAX times the light arriving on a horizontal plane above the atmosphere
    for the sun computed in that hour. More than that means the data are for another place or are mistimed; the excess
    is dropped (and counted in light_dropped) instead of being squeezed into the few minutes the sun is up."""
    centers, ghi, dhi, wind = hourly_window(h, y, m, d, tz)
    day0 = solar.days_from_civil(y, m, d) * 1440.0 - 60.0 * tz
    fine = np.arange(0.5, 1440.0, 1.0)                       # 1-min centers, local time
    cz = np.clip(np.cos(np.radians(solar.sun_with_noon(y, m, d, fine, lat, lon, tz, noon_shift).zenith_geometric)), 0.0, None)
    g_f = np.zeros_like(fine); b_f = np.zeros_like(fine); w_f = np.full_like(fine, np.nan); a_f = np.zeros_like(fine)
    doy = solar.days_from_civil(y, m, d) - solar.days_from_civil(y, 1, 1) + 1
    cap_unit = 1.0 if h.unit == "W" else PAR_FRACTION * Q_DIRECT     # W m-2 -> umol m-2 s-1 upper bound
    total = dropped = 0.0
    for c, G, D, W in zip(centers, ghi, dhi, wind):
        G = float(G); D = float(D)
        lo = c - 30.0 - day0                                  # hour start in local minutes (may be < 0)
        hour_fine = lo + np.arange(0.5, 60.0, 1.0)
        czh = np.clip(np.cos(np.radians(solar.sun_with_noon(y, m, d, hour_fine, lat, lon, tz, noon_shift).zenith_geometric)), 0.0, None)
        sel = (fine >= lo) & (fine < lo + 60.0)
        mean_s = czh.mean()
        inside = float(sel.sum())
        total += G * inside
        cap = KT_MAX * float(extraterrestrial_horizontal(doy, mean_s)) * cap_unit
        if G > cap:                                           # the data and the computed sun disagree
            dropped += (G - cap) * inside
            D = D * cap / G if G > 0 else 0.0
            G = cap
        if mean_s > 0:
            g_f[sel] = G * cz[sel] / mean_s
            b_f[sel] = (G - D) * cz[sel] / mean_s
            if circumsolar:      # Hay-Davies anisotropy index: DNI over the extraterrestrial normal irradiance
                dni = (G - D) / mean_s
                e0n = float(extraterrestrial_horizontal(doy, 1.0)) * cap_unit
                a_f[sel] = min(max(dni / e0n, 0.0), 1.0) if e0n > 0 else 0.0
        w_f[sel] = W
    d_f = g_f - b_f
    if h.unit == "W":
        pb, pd = to_par(g_f, d_f)
    else:
        pb, pd = b_f, d_f
    pc = a_f * pd; pd = pd - pc          # circumsolar part of the diffuse PAR; the rest is isotropic
    n = int(round(1440.0 / step))
    agg = lambda a: a.reshape(n, -1).mean(axis=1)
    mins = (np.arange(n) + 0.5) * step
    spc = solar.sun_with_noon(y, m, d, mins, lat, lon, tz, noon_shift)
    with np.errstate(invalid="ignore"), __import__("warnings").catch_warnings():
        __import__("warnings").simplefilter("ignore")
        wind_s = np.nanmean(w_f.reshape(n, -1), axis=1)
    return DayLight(minutes=mins, step=step, zenith=spc.zenith, azimuth=spc.azimuth,
                    par_direct_h=agg(pb), par_diffuse=agg(pd), wind=wind_s, light_total=total, light_dropped=dropped,
                    par_circumsolar_h=agg(pc))


def utc_offset_from_lon(lon: float) -> int:
    """Default UTC offset for a longitude: the nearest whole hour of solar time (round half up)."""
    return math.floor(lon / 15.0 + 0.5)


def distance_km(lat1: float, lon1: float, lat2: float, lon2: float) -> float:
    """Great-circle distance (km) on a sphere of radius 6371 km."""
    p1, p2 = math.radians(lat1), math.radians(lat2)
    a = math.sin((p2 - p1) / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(math.radians(lon2 - lon1) / 2) ** 2
    return 2.0 * 6371.0 * math.asin(min(1.0, math.sqrt(a)))


def clear_sky_light(lat: float, lon: float, wind: float = CLEAR_SKY_WIND) -> HourlyLight:
    """A typical year of cloud-free light for a site, for use until real data are loaded.
    Global irradiance: Haurwitz (1945) clear-sky model, G = 1098 cos z exp(-0.059 / cos z) W m-2 (constants as in
    Reno et al. 2012 and pvlib), averaged over each UTC hour from 10 samples. Diffuse share: Erbs et al. (1982)
    from the hourly clearness index. Wind: a constant `wind` m s-1."""
    n_s = 10
    off = (np.arange(n_s) + 0.5) * (60.0 / n_s)                     # minutes after the start of each hour
    base = solar.days_from_civil(REF_YEAR, 1, 1)
    ghi = np.zeros(365 * 24); dhi = np.zeros(365 * 24)
    for k in range(365):
        _, mm, dd = solar.civil_from_days(base + k)
        mins = (np.arange(24)[:, None] * 60.0 + off[None, :]).ravel()
        cz = np.cos(np.radians(solar.solar_position(REF_YEAR, mm, dd, mins, lat, lon, 0.0).zenith_geometric))
        cz = np.clip(cz, 0.0, None).reshape(24, n_s)
        with np.errstate(divide="ignore", invalid="ignore"):
            g = np.where(cz > 0, 1098.0 * cz * np.exp(-0.059 / np.where(cz > 0, cz, 1.0)), 0.0).mean(axis=1)
            e = extraterrestrial_horizontal(k + 1, cz.mean(axis=1))
            kt = np.where(e > 0, g / np.where(e > 0, e, 1.0), 0.0)
        ghi[k * 24:(k + 1) * 24] = g
        dhi[k * 24:(k + 1) * 24] = erbs_diffuse_fraction(kt) * g
    t = base * 1440.0 + 30.0 + 60.0 * np.arange(365 * 24)
    return HourlyLight(t_utc=t, ghi=ghi, dhi=dhi, unit="W", wind=np.full(365 * 24, float(wind)), lat=float(lat), lon=float(lon),
                       source="clear-sky estimate", database="clear sky (Haurwitz 1945)", kind="tmy",
                       notes=["Cloud-free model light; load PVGIS data for real weather."])


def daily_integral(values_umol, step_min: float) -> float:
    """Daily light integral (mol m-2 d-1) from a series in umol m-2 s-1 on steps of step_min minutes."""
    return float(np.sum(values_umol) * step_min * 60.0 / 1e6)
