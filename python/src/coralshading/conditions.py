"""Conditions that change through a deployment (v5.1): water clarity by date, tide, and cloth fouling.

- Kd by date: values measured or retrieved (for example from satellite Kd(PAR) or Kd(490) products) on some
  dates. Each day of the deployment takes the value interpolated linearly between the nearest dates; before the
  first and after the last date the nearest value is held. The water's scattering (w0) is kept.
- Tide: a water-level series (local standard time, metres; any datum). Levels are taken relative to their
  time-weighted mean over the deployment, so the coral depth entered is the depth at mean water level. The water
  column is then deeper or shallower at every 10-minute step; its beam attenuation (c = tau / depth, from the
  day's Kd at mean depth) is kept, so the optical depth follows the water level.
- Cloth fouling: the cloth passes tau_clean after each cleaning, and fouling builds up linearly to tau_fouled over
  days_to_foul days, then stays there until the next cleaning. Cleanings happen on the start date, every
  `clean_every` days after it (0 = never) and on any listed dates.
Identical in webapp/src/core/conditions.ts.
"""
from __future__ import annotations

import math
from dataclasses import dataclass, field

import numpy as np

from . import solar

TAU_STEP = 2e-4      # tide: optical depths are rounded to steps of 0.02 % (log scale) so water states can be reused


def _parse_date(s: str) -> tuple:
    s = s.strip().strip('"')
    y, m, d = (int(x) for x in s[:10].replace("/", "-").split("-"))
    return (y, m, d)


def _parse_datetime_min(s: str) -> float:
    """'YYYY-MM-DD HH:MM[:SS]' or 'YYYY-MM-DDTHH:MM' (local standard time) -> minutes since 1970-01-01 00:00."""
    s = s.strip().strip('"').replace("T", " ")
    date, _, time = s.partition(" ")
    y, m, d = _parse_date(date)
    hh, mm, *rest = (time or "00:00").split(":")
    sec = float(rest[0]) if rest else 0.0
    return solar.days_from_civil(y, m, d) * 1440.0 + int(hh) * 60.0 + int(mm) + sec / 60.0


def _rows(text: str):
    """Data rows of a small CSV: comma, semicolon or tab separated; lines starting with # and a header row skipped."""
    for ln in text.splitlines():
        ln = ln.strip()
        if not ln or ln.startswith("#"):
            continue
        parts = [p.strip() for p in ln.replace(";", ",").replace("\t", ",").split(",")]
        if len(parts) < 2 or not parts[0][:4].isdigit():
            continue                      # header or anything that does not start with a year
        yield parts


# ------------------------------------------------------------------ Kd by date
def kd_series_from_csv(text: str) -> dict:
    """'date, Kd' rows -> {(y, m, d): Kd}. Kd in m-1 (PAR), positive."""
    out = {}
    for parts in _rows(text):
        kd = float(parts[1])
        if not kd > 0:
            raise ValueError(f"Kd must be positive (row starting {parts[0]}).")
        out[_parse_date(parts[0])] = kd
    if not out:
        raise ValueError("No 'date, Kd' rows found.")
    return out


def kd_for_days(series: dict, days) -> list[float]:
    """Kd for each day: linear interpolation in time between the given dates, the nearest value held outside."""
    ks = sorted(series)
    t = np.array([solar.days_from_civil(*k) for k in ks], float)
    v = np.array([series[k] for k in ks], float)
    q = np.array([solar.days_from_civil(*d) for d in days], float)
    return [float(x) for x in np.interp(q, t, v)]


# ------------------------------------------------------------------ tide
@dataclass
class Tide:
    t_local: np.ndarray          # minutes since 1970-01-01 00:00, local standard time, increasing
    level: np.ndarray            # m (any datum)
    source: str = ""

    def at(self, t) -> np.ndarray:
        t = np.asarray(t, float)
        if t.min() < self.t_local[0] - 1e-9 or t.max() > self.t_local[-1] + 1e-9:
            raise ValueError("The tide series does not cover the whole deployment.")
        return np.interp(t, self.t_local, self.level)

    def mean_between(self, t0: float, t1: float) -> float:
        """Time-weighted mean level over [t0, t1] (trapezoids on the series, with the end points interpolated)."""
        inner = (self.t_local > t0) & (self.t_local < t1)
        tt = np.concatenate([[t0], self.t_local[inner], [t1]])
        ll = np.concatenate([self.at([t0]), self.level[inner], self.at([t1])])
        return float(((ll[1:] + ll[:-1]) * 0.5 * np.diff(tt)).sum() / (t1 - t0))


def tide_from_csv(text: str) -> Tide:
    """'local date time, level (m)' rows -> Tide (sorted; duplicate times averaged away by keeping the last)."""
    pts = {}
    for parts in _rows(text):
        pts[_parse_datetime_min(parts[0])] = float(parts[1])
    if len(pts) < 2:
        raise ValueError("A tide series needs at least two 'date time, level' rows.")
    t = np.array(sorted(pts)); lv = np.array([pts[k] for k in t])
    return Tide(t_local=t, level=lv)


def quantize_tau(tau: float) -> float:
    """Round an optical depth to steps of TAU_STEP on a log scale (same rounding in TypeScript)."""
    k = math.floor(math.log(tau) / TAU_STEP + 0.5)
    return math.exp(k * TAU_STEP)


# ------------------------------------------------------------------ cloth fouling over time
@dataclass
class Fouling:
    tau_clean: float
    tau_fouled: float
    days_to_foul: float = 30.0             # days for fouling to build up fully after a cleaning (0 = at once)
    clean_every: int = 0                   # days between cleanings after the start (0 = never)
    clean_dates: list = field(default_factory=list)   # extra cleaning dates [(y, m, d), ...]

    def tau_by_day(self, days) -> list[float]:
        """Cloth transmission on each day (the start date counts as a cleaning)."""
        d0 = solar.days_from_civil(*days[0])
        extra = sorted(solar.days_from_civil(*d) for d in self.clean_dates)
        out = []
        for d in days:
            k = solar.days_from_civil(*d)
            last = d0
            if self.clean_every > 0:
                last = d0 + ((k - d0) // self.clean_every) * self.clean_every
            for e in extra:
                if d0 <= e <= k:
                    last = max(last, e)
            age = k - last
            f = 1.0 if self.days_to_foul <= 0 else min(1.0, age / self.days_to_foul)
            out.append(self.tau_clean + (self.tau_fouled - self.tau_clean) * f)
        return out
