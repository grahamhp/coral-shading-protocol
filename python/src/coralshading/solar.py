"""Solar position, solar noon, sunrise and sunset.

Algorithm: NOAA Global Monitoring Laboratory solar calculator equations, after Meeus (1998), Astronomical
Algorithms, 2nd edn. The same equations are used in the Sipaway paper code (09_wave_refraction.R). They are
accurate to well under 0.1 degree, which is ample for shading; the test suite checks them against the NREL
Solar Position Algorithm (Reda and Andreas 2004).

Conventions (identical in the TypeScript port, webapp/src/core/solar.ts):
- Dates are civil dates (year, month, day) at the site; times are minutes after local midnight on the
  site's standard clock (UTC + utc_offset_h). No daylight saving.
- Azimuth is measured clockwise from north (0 = N, 90 = E).
- Zenith includes atmospheric refraction (NOAA formula); geometric zenith is also returned.
"""
from __future__ import annotations

import math
from dataclasses import dataclass

import numpy as np

RAD = math.pi / 180.0


def days_from_civil(y: int, m: int, d: int) -> int:
    """Days since 1970-01-01 for a proleptic Gregorian date (H. Hinnant's algorithm)."""
    y -= m <= 2
    era = (y if y >= 0 else y - 399) // 400
    yoe = y - era * 400
    doy = (153 * (m + (-3 if m > 2 else 9)) + 2) // 5 + d - 1
    doe = yoe * 365 + yoe // 4 - yoe // 100 + doy
    return era * 146097 + doe - 719468


def civil_from_days(z: int) -> tuple[int, int, int]:
    """Inverse of days_from_civil."""
    z += 719468
    era = (z if z >= 0 else z - 146096) // 146097
    doe = z - era * 146097
    yoe = (doe - doe // 1460 + doe // 36524 - doe // 146096) // 365
    y = yoe + era * 400
    doy = doe - (365 * yoe + yoe // 4 - yoe // 100)
    mp = (5 * doy + 2) // 153
    d = doy - (153 * mp + 2) // 5 + 1
    m = mp + (3 if mp < 10 else -9)
    return y + (m <= 2), m, d


def _orbit(jd):
    """Declination (deg) and equation of time (min) from Julian day (scalar or array)."""
    jc = (jd - 2451545.0) / 36525.0
    L0 = np.mod(280.46646 + jc * (36000.76983 + jc * 0.0003032), 360.0)
    M = 357.52911 + jc * (35999.05029 - 0.0001537 * jc)
    e = 0.016708634 - jc * (0.000042037 + 0.0000001267 * jc)
    C = (np.sin(M * RAD) * (1.914602 - jc * (0.004817 + 0.000014 * jc))
         + np.sin(2 * M * RAD) * (0.019993 - 0.000101 * jc) + np.sin(3 * M * RAD) * 0.000289)
    omega = 125.04 - 1934.136 * jc
    app = L0 + C - 0.00569 - 0.00478 * np.sin(omega * RAD)
    eps0 = 23.0 + (26.0 + (21.448 - jc * (46.815 + jc * (0.00059 - jc * 0.001813))) / 60.0) / 60.0
    eps = eps0 + 0.00256 * np.cos(omega * RAD)
    decl = np.arcsin(np.sin(eps * RAD) * np.sin(app * RAD)) / RAD
    yy = np.tan(eps / 2 * RAD) ** 2
    eot = 4.0 / RAD * (yy * np.sin(2 * L0 * RAD) - 2 * e * np.sin(M * RAD)
                       + 4 * e * yy * np.sin(M * RAD) * np.cos(2 * L0 * RAD)
                       - 0.5 * yy * yy * np.sin(4 * L0 * RAD) - 1.25 * e * e * np.sin(2 * M * RAD))
    return decl, eot


def julian_day(y: int, m: int, d: int, minute_local, utc_offset_h: float):
    """Julian day for local standard time minute(s) on the civil date (y, m, d)."""
    return days_from_civil(y, m, d) + (np.asarray(minute_local, dtype=float) - 60.0 * utc_offset_h) / 1440.0 + 2440587.5


def atmospheric_refraction_deg(elev_deg):
    """NOAA approximation of atmospheric refraction (degrees) for apparent-elevation correction."""
    el = np.asarray(elev_deg, dtype=float)
    te = np.tan(np.clip(el, -89.0, 89.9) * RAD)
    with np.errstate(divide="ignore", invalid="ignore"):
        r = np.where(el > 85.0, 0.0,
            np.where(el > 5.0, 58.1 / te - 0.07 / te ** 3 + 0.000086 / te ** 5,
            np.where(el > -0.575, 1735.0 + el * (-518.2 + el * (103.4 + el * (-12.79 + el * 0.711))),
                     -20.772 / te)))
    return r / 3600.0


@dataclass(frozen=True)
class SunPosition:
    zenith: np.ndarray            # apparent (refracted) zenith, degrees
    azimuth: np.ndarray           # degrees clockwise from north
    zenith_geometric: np.ndarray  # degrees
    declination: np.ndarray       # degrees
    eot: np.ndarray               # equation of time, minutes


def solar_position(y: int, m: int, d: int, minute_local, lat: float, lon: float, utc_offset_h: float) -> SunPosition:
    """Sun position at local standard time minute(s) on (y, m, d). Arrays broadcast over minute_local."""
    mins = np.asarray(minute_local, dtype=float)
    jd = julian_day(y, m, d, mins, utc_offset_h)
    decl, eot = _orbit(jd)
    tst = np.mod(mins + eot + 4.0 * lon - 60.0 * utc_offset_h, 1440.0)
    ha = tst / 4.0 - 180.0
    cz = np.sin(lat * RAD) * np.sin(decl * RAD) + np.cos(lat * RAD) * np.cos(decl * RAD) * np.cos(ha * RAD)
    zen = np.arccos(np.clip(cz, -1.0, 1.0)) / RAD
    sz = np.sin(zen * RAD)
    with np.errstate(divide="ignore", invalid="ignore"):
        az_arg = (np.sin(lat * RAD) * np.cos(zen * RAD) - np.sin(decl * RAD)) / (np.cos(lat * RAD) * sz)
    az0 = np.arccos(np.clip(np.nan_to_num(az_arg, nan=1.0), -1.0, 1.0)) / RAD
    az = np.where(ha > 0, np.mod(az0 + 180.0, 360.0), np.mod(540.0 - az0, 360.0))
    elev = 90.0 - zen
    zen_app = zen - atmospheric_refraction_deg(elev)
    return SunPosition(zenith=zen_app, azimuth=az, zenith_geometric=zen, declination=decl, eot=eot)


def solar_noon(y: int, m: int, d: int, lon: float, utc_offset_h: float) -> float:
    """Local standard time of solar noon, minutes after midnight (two fixed-point iterations)."""
    t = 720.0
    for _ in range(3):
        _, eot = _orbit(julian_day(y, m, d, t, utc_offset_h))
        t = 720.0 - 4.0 * lon - float(eot) + 60.0 * utc_offset_h
    return t


def sunrise_sunset(y: int, m: int, d: int, lat: float, lon: float, utc_offset_h: float) -> tuple[float, float]:
    """Local standard times (minutes) of sunrise and sunset (apparent upper limb, zenith 90.833 deg).
    Returns (nan, nan) for polar day or night."""
    out = []
    for sign in (-1.0, 1.0):
        t = solar_noon(y, m, d, lon, utc_offset_h)
        for _ in range(4):
            decl, eot = _orbit(julian_day(y, m, d, t, utc_offset_h))
            arg = (math.cos(90.833 * RAD) / (math.cos(lat * RAD) * math.cos(float(decl) * RAD))
                   - math.tan(lat * RAD) * math.tan(float(decl) * RAD))
            if abs(arg) > 1:
                return float("nan"), float("nan")
            ha = math.acos(arg) / RAD
            t = 720.0 - 4.0 * (lon - sign * ha) - float(eot) + 60.0 * utc_offset_h
        out.append(t)
    return out[0], out[1]


# ---------------------------------------------------------------- solar noon control
NOON_MODES = ("computed", "user", "data")


def data_noon(minutes, ghi) -> float:
    """Solar noon estimated from a day of light data: the irradiance-weighted mean time (first moment).
    For a symmetric clear day this equals solar noon; clouds in the morning or afternoon shift it."""
    t = np.asarray(minutes, dtype=float); g = np.clip(np.asarray(ghi, dtype=float), 0, None)
    if g.sum() <= 0:
        raise ValueError("no light in the data")
    return float((t * g).sum() / g.sum())


def noon_shift(mode: str, computed: float, user: float | None = None, data: float | None = None) -> float:
    """Minutes to shift the sun's timing so that solar noon falls at the chosen time.
    The sun at clock time t is then evaluated at t - shift (declination and day length are unchanged)."""
    if mode == "computed":
        return 0.0
    if mode == "user":
        if user is None:
            raise ValueError("user noon not set")
        return float(user) - computed
    if mode == "data":
        if data is None:
            raise ValueError("data noon not available")
        return float(data) - computed
    raise ValueError(f"unknown noon mode {mode!r}")


def sun_with_noon(y, m, d, minute_local, lat, lon, utc_offset_h, shift_min: float = 0.0) -> SunPosition:
    """Sun position with the solar-noon shift applied."""
    return solar_position(y, m, d, np.asarray(minute_local, dtype=float) - shift_min, lat, lon, utc_offset_h)
