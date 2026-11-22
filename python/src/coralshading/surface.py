"""Light at the sea surface: reading data, converting to PAR, and spreading hourly values over the day.

Sources (see shared/references.json):
- PAR is 0.50 of global (broadband) irradiance, nearly constant across sky conditions for sun elevations
  above 10 degrees; the diffuse share of PAR is larger than that of global irradiance:
  k_PAR = [1 + 0.3 (1 - k^2)] k, with k = diffuse / global (Spitters et al. 1986, eqs. 9-10).
- Energy to photons: 4.57 umol J-1 for daylight (sun plus sky) and 4.24 umol J-1 for diffuse skylight
  (McCree 1972). The direct beam uses 4.57.
- When only global irradiance is known, the diffuse fraction is estimated from the clearness index with the
  Erbs et al. (1982) correlation.
- PVGIS files hold one value per hour with UTC time stamps. Where PVGIS uses the ERA5 reanalysis the value is the
  mean of a clock hour, centred at hh:30 (hourly series are stamped hh:30; TMY files are stamped hh:00 with an
  "Irradiance Time Offset" of 0.5 h). Where it uses the SARAH-3 satellite record (Europe, Africa, the Red Sea,
  the western Indian Ocean) the value is the irradiance at the satellite scan a few minutes after the hour
  (stamps such as hh:09; TMY offset such as 0.153 h). Each value is used as the mean of the hour centred on its
  own time (HourlyLight.center_min), so the light keeps its true position relative to the sun (v5.2; before, all
  values were placed on hh:30 hours, which put SARAH-3 data about 40 minutes early).
- Open-Meteo archive files (ERA5) are hourly means of the hour before each UTC stamp, so centred at hh:30 too.

Hourly values are spread over the day so that each hour keeps exactly its total (v5.2): the hour's clearness
(irradiance / cos zenith) is interpolated linearly in time between the centres of neighbouring hours, multiplied
by the cosine of the solar zenith angle at each minute, and rescaled so that the hour's mean equals the data.
Global and direct irradiance are treated alike. Before v5.2 the clearness was held constant within each hour,
which made the light jump at every hour boundary.
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
    wind: 10-m wind speed (m s-1) or None.
    center_min: minute of the UTC hour on which every value is centred (30 for clock-hour means; e.g. 9 for
    PVGIS-SARAH3). tmy_years: for a typical year built here, the year chosen for each calendar month."""
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
    center_min: float = 30.0
    tmy_years: list | None = None


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
                    source="PVGIS 5.3", database=database, kind=kind, center_min=center_minute(t[0]))
    return tmy_to_reference_year(h) if kind == "tmy" else h


def center_minute(t_utc_min: float) -> float:
    """Minute of the UTC hour (0 <= m < 60) of a time in minutes since the epoch."""
    return float(t_utc_min - 60.0 * math.floor(t_utc_min / 60.0))


def tmy_to_reference_year(h: HourlyLight) -> HourlyLight:
    """Re-date a TMY onto REF_YEAR: value k belongs to UTC hour k of the year and is centred at k h + center_min
    (30 min for clock-hour means). TMY months come from different years, so only (month, day, hour) is kept.
    29 February is dropped."""
    out_g = np.zeros(8760); out_d = np.zeros(8760); out_w = np.full(8760, np.nan)
    base = solar.days_from_civil(REF_YEAR, 1, 1)
    cm = h.center_min
    for i, tu in enumerate(h.t_utc):
        hh = int(round((tu - cm) / 60.0))                                  # whole UTC hours since the epoch
        _, mm, dd = solar.civil_from_days(hh // 24)
        if (mm, dd) == (2, 29):
            continue
        k = (solar.days_from_civil(REF_YEAR, mm, dd) - base) * 24 + hh % 24
        out_g[k] = h.ghi[i]; out_d[k] = h.dhi[i]
        if h.wind is not None:
            out_w[k] = h.wind[i]
    t = base * 1440.0 + cm + 60.0 * np.arange(8760)
    return HourlyLight(t_utc=t, ghi=out_g, dhi=out_d, unit=h.unit, wind=None if h.wind is None else out_w,
                       lat=h.lat, lon=h.lon, source=h.source, database=h.database, kind="tmy", center_min=cm,
                       tmy_years=h.tmy_years)


# ------------------------------------------------------------------ Open-Meteo (ERA5) and typical years
WIND_TO_MS = {"m/s": 1.0, "km/h": 1.0 / 3.6, "mp/h": 0.44704, "kn": 0.514444}


def _iso_to_utc_min(stamp: str) -> float:
    """'YYYY-MM-DDTHH:MM' (UTC) to minutes since the epoch."""
    y, m, d = int(stamp[0:4]), int(stamp[5:7]), int(stamp[8:10])
    hh, mm = int(stamp[11:13]), int(stamp[14:16])
    return solar.days_from_civil(y, m, d) * 1440.0 + hh * 60.0 + mm


def parse_open_meteo(data) -> HourlyLight:
    """Read an Open-Meteo archive (ERA5) reply: hourly shortwave_radiation and diffuse_radiation in W m-2 on a horizontal
    plane, requested with timezone=GMT; wind_speed_10m is used when present. `data` is the JSON text or the parsed object.
    Open-Meteo stamps each value at the END of the hour it averages, so a value stamped hh:00 is centred at hh:00 - 30 min.
    Hours not yet available (null) at the end are cut; a gap elsewhere is an error."""
    import json as _json
    j = _json.loads(data) if isinstance(data, (str, bytes)) else data
    if j.get("error"):
        raise ValueError(f"Open-Meteo: {j.get('reason', 'request refused')}")
    h = j.get("hourly") or {}
    if "time" not in h or "shortwave_radiation" not in h or "diffuse_radiation" not in h:
        raise ValueError("Not an Open-Meteo hourly reply with shortwave_radiation and diffuse_radiation.")
    if j.get("utc_offset_seconds", 0) != 0:
        raise ValueError("Open-Meteo data must be requested with timezone=GMT.")
    n = len(h["time"])
    while n > 0 and (h["shortwave_radiation"][n - 1] is None or h["diffuse_radiation"][n - 1] is None):
        n -= 1
    if n == 0:
        raise ValueError("The Open-Meteo reply holds no radiation values.")
    g = h["shortwave_radiation"][:n]; dd = h["diffuse_radiation"][:n]
    if any(v is None for v in g) or any(v is None for v in dd):
        raise ValueError("The Open-Meteo reply has gaps in the radiation values.")
    t = np.array([_iso_to_utc_min(x) for x in h["time"][:n]]) - 30.0
    if n > 1 and round((t[-1] - t[0]) / 60.0) + 1 != n:
        raise ValueError("The Open-Meteo reply is not a gap-free hourly series.")
    ghi = np.clip(np.array(g, dtype=float), 0.0, None); dhi = np.clip(np.minimum(np.array(dd, dtype=float), ghi), 0.0, None)
    wind = None
    if "wind_speed_10m" in h:
        f = WIND_TO_MS.get((j.get("hourly_units") or {}).get("wind_speed_10m", "km/h"), 1.0 / 3.6)
        wind = np.array([np.nan if v is None else float(v) * f for v in h["wind_speed_10m"][:n]])
    lat = j.get("latitude"); lon = j.get("longitude")
    return HourlyLight(t_utc=t, ghi=ghi, dhi=dhi, unit="W", wind=wind, lat=None if lat is None else float(lat),
                       lon=None if lon is None else float(lon), source="Open-Meteo archive API", database="ERA5 (Open-Meteo)",
                       kind="hourly", center_min=center_minute(t[0]))


def typical_year(h: HourlyLight, candidates: int = 3) -> HourlyLight:
    """A typical year from several years of hourly data: for every calendar month one year is chosen and its hours are
    copied. Choice (the irradiance part of ISO 15927-4): the daily global irradiation of each candidate year-month is
    compared with all years of that month by the Finkelstein-Schafer statistic (mean absolute difference between the
    two cumulative distributions); of the `candidates` closest years, the one whose monthly mean is nearest the
    all-year mean is taken. Days run from local solar midnight (whole hours from the longitude); the first and last
    part-days of a month are left out of the statistic. Only complete UTC months are candidates; 29 February is dropped.
    Returns a 'tmy' HourlyLight on REF_YEAR with tmy_years = the year chosen for each month."""
    if h.kind != "hourly":
        raise ValueError("typical_year needs an hourly series of real years")
    cm = h.center_min
    hours = np.rint((np.asarray(h.t_utc, dtype=float) - cm) / 60.0).astype(np.int64)      # whole UTC hours since the epoch
    h0 = int(hours[0])
    if not np.array_equal(hours, h0 + np.arange(len(hours))):
        raise ValueError("typical_year needs a gap-free hourly series")
    y_first, _, _ = solar.civil_from_days(h0 // 24)
    y_last, _, _ = solar.civil_from_days(int(hours[-1]) // 24)
    s0 = (-utc_offset_from_lon(h.lon)) % 24 if h.lon is not None else 0                    # UTC hour of local midnight
    blocks = {}                                                                            # (month, year) -> first index
    for y in range(y_first, y_last + 1):
        for m in range(1, 13):
            a = solar.days_from_civil(y, m, 1) * 24 - h0
            b = (solar.days_from_civil(y + (m == 12), m % 12 + 1, 1)) * 24 - h0
            if a >= 0 and b <= len(hours):
                blocks[(m, y)] = (a, b)
    base = solar.days_from_civil(REF_YEAR, 1, 1)
    out_g = np.zeros(8760); out_d = np.zeros(8760); out_w = np.full(8760, np.nan)
    chosen = []
    for m in range(1, 13):
        years = [y for (mm, y) in blocks if mm == m]
        if not years:
            raise ValueError(f"typical_year: no complete month {m} in the data")
        daily = {}
        for y in years:
            a, b = blocks[(m, y)]
            nd = (b - a - s0) // 24
            daily[y] = np.array([sum(h.ghi[a + s0 + 24 * k:a + s0 + 24 * k + 24].tolist()) for k in range(nd)])   # left-to-right sums, as the app
        allv = np.sort(np.concatenate([daily[y] for y in years]))
        mean_all = sum(allv.tolist()) / len(allv)
        rank = []
        for y in years:
            v = np.sort(daily[y]); n = len(v)
            f_all = np.searchsorted(allv, v, side="right") / len(allv)
            fs = sum(np.abs(f_all - (np.arange(n) + 1.0) / n).tolist()) / n
            rank.append((fs, y, abs(sum(v.tolist()) / n - mean_all)))
        rank.sort(key=lambda r: (r[0], r[1]))
        best = min(rank[:max(1, candidates)], key=lambda r: (r[2], r[0], r[1]))
        y = best[1]; chosen.append(int(y))
        a, b = blocks[(m, y)]
        for i in range(a, b):
            hh = h0 + i
            _, mm, dd = solar.civil_from_days(hh // 24)
            if (mm, dd) == (2, 29):
                continue
            k = (solar.days_from_civil(REF_YEAR, mm, dd) - base) * 24 + hh % 24
            out_g[k] = h.ghi[i]; out_d[k] = h.dhi[i]
            if h.wind is not None:
                out_w[k] = h.wind[i]
    t = base * 1440.0 + cm + 60.0 * np.arange(8760)
    return HourlyLight(t_utc=t, ghi=out_g, dhi=out_d, unit=h.unit, wind=None if h.wind is None else out_w, lat=h.lat, lon=h.lon,
                       source=h.source, database=f"{h.database} typical year {min(y for _, y in blocks)}-{max(y for _, y in blocks)}",
                       kind="tmy", center_min=cm, tmy_years=chosen)


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
    cm = h.center_min                                                      # hour centers at hh:cm (hh:30 for hour means)
    first = math.floor((start - 60.0 - cm) / 60.0) * 60.0 + cm
    centers = np.arange(first, start + 1440.0 + 90.0, 60.0)
    centers = centers[(centers + 30.0 > start) & (centers - 30.0 < start + 1440.0)]
    wind_all = h.wind if h.wind is not None else np.full(len(h.ghi), np.nan)
    if h.kind == "tmy":
        base = solar.days_from_civil(REF_YEAR, 1, 1)
        idx = []
        for c in centers:
            hh = int(round((c - cm) / 60.0))                               # whole UTC hours since the epoch
            _, mm, dd = solar.civil_from_days(hh // 24)
            if (mm, dd) == (2, 29):
                mm, dd = 2, 28
            idx.append((solar.days_from_civil(REF_YEAR, mm, dd) - base) * 24 + hh % 24)
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
    """Surface light for one local day from hourly values, converted to PAR and averaged onto steps of `step` minutes.
    Inside each hour the light follows cos(zenith) times the hour's clearness (irradiance / mean cos zenith), which is
    interpolated linearly in time between the centres of neighbouring hours; the result is rescaled so that each hour
    keeps its total exactly. Global and direct irradiance are treated alike (direct never above global).
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
    e0n = float(extraterrestrial_horizontal(doy, 1.0)) * cap_unit
    total = dropped = 0.0
    n_h = len(centers)
    lo = np.asarray(centers, dtype=float) - 30.0 - day0       # hour starts in local minutes (may be < 0)
    off = np.arange(0.5, 60.0, 1.0)
    czh = []; mean_s = np.zeros(n_h); G = np.zeros(n_h); B = np.zeros(n_h); inside = []
    for k in range(n_h):
        c = np.clip(np.cos(np.radians(solar.sun_with_noon(y, m, d, lo[k] + off, lat, lon, tz, noon_shift).zenith_geometric)), 0.0, None)
        czh.append(c); mean_s[k] = c.mean()
        g = float(ghi[k]); dd = float(dhi[k])
        sel = (fine >= lo[k]) & (fine < lo[k] + 60.0)
        inside.append(sel)
        n_in = float(sel.sum())
        total += g * n_in
        cap = KT_MAX * float(extraterrestrial_horizontal(doy, mean_s[k])) * cap_unit
        if g > cap:                                           # the data and the computed sun disagree
            dropped += (g - cap) * n_in
            dd = dd * cap / g if g > 0 else 0.0
            g = cap
        G[k] = g; B[k] = g - dd
    ok = (mean_s > 0) & (G > 0)                               # hours with sun and light (PVGIS-ERA5 gives 0 for the
    q = np.where(ok, G / np.where(ok, mean_s, 1.0), 0.0)      # hour of sunrise; no interpolation towards such hours)
    qb = np.where(ok, B / np.where(ok, mean_s, 1.0), 0.0)     # clearness of each hour: global and direct

    def interp(vals, k, t):
        """vals at the hour centres, linear in time towards the neighbouring hour (flat where it has no light)."""
        dt = (np.asarray(t, dtype=float) - (lo[k] + 30.0)) / 60.0     # -0.5 .. 0.5
        out = np.full(dt.shape, vals[k])
        if k > 0 and ok[k - 1]:
            w = np.clip(-dt, 0.0, None)
            out = np.where(dt < 0, vals[k] + w * (vals[k - 1] - vals[k]), out)
        if k + 1 < n_h and ok[k + 1]:
            w = np.clip(dt, 0.0, None)
            out = np.where(dt >= 0, vals[k] + w * (vals[k + 1] - vals[k]), out)
        return out

    for k in range(n_h):
        sel = inside[k]
        w_f[sel] = wind[k]
        if not ok[k]:
            continue
        th = lo[k] + off
        sg = float(np.sum(interp(q, k, th) * czh[k])); sb = float(np.sum(interp(qb, k, th) * czh[k]))
        fg = 60.0 * G[k] / sg if sg > 0 else 0.0              # keeps the hour's total
        fb = 60.0 * B[k] / sb if sb > 0 else 0.0
        tf = fine[sel]
        gg = interp(q, k, tf) * cz[sel] * fg
        dni = interp(qb, k, tf) * fb                          # direct normal irradiance at each minute
        g_f[sel] = gg
        b_f[sel] = np.minimum(dni * cz[sel], gg)
        if circumsolar:          # Hay-Davies anisotropy index: DNI over the extraterrestrial normal irradiance
            a_f[sel] = np.clip(dni / e0n, 0.0, 1.0) if e0n > 0 else 0.0
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
