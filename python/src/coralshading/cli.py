"""Command line: coralshading design --lat 10.4675 --lon 123.4506 --start 2025-04-28 --end 2025-08-08 --out results"""
from __future__ import annotations

import argparse
import json
import sys

from . import __version__, conditions, design as D, scenarios as sc, solar, surface
from .geometry import Panel


def _date(s: str) -> tuple:
    y, m, d = (int(x) for x in s.split("-"))
    return (y, m, d)


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(prog="coralshading", description=f"Coral Shading Protocol {__version__}")
    sub = ap.add_subparsers(dest="cmd", required=True)
    p = sub.add_parser("design", help="design a shade cloth and/or canopy")
    p.add_argument("--lat", type=float, required=True); p.add_argument("--lon", type=float, required=True)
    p.add_argument("--tz", type=float, help="UTC offset in hours (default: longitude / 15)")
    p.add_argument("--start", type=_date, required=True); p.add_argument("--end", type=_date, required=True)
    p.add_argument("--target", default="reef_star", help="reef_star | table | rope | rect:LXxLY | circle:D")
    p.add_argument("--depth", type=float, default=10.0); p.add_argument("--height", type=float, default=0.75)
    p.add_argument("--kd", type=float, default=0.10, help="Kd (PAR), m-1")
    p.add_argument("--w0", type=float, default=0.7, help="water scattering used for the design (0.3-0.95)")
    p.add_argument("--w0-range", default="0.5-0.9", help="range of w0 shown with every result, LOW-HIGH")
    p.add_argument("--w0-reading", nargs=4, type=float, metavar=("RATIO", "LX", "LY", "HEIGHT"),
                   help="field reading under an opaque panel at noon of the start date (light under / open water, panel size and "
                        "height in m); sets w0 and prints it")
    p.add_argument("--kd-series", help="CSV of 'date, Kd' through the deployment")
    p.add_argument("--tide", help="CSV of 'local date time, water level (m)' covering the deployment")
    p.add_argument("--fouling", nargs=4, type=float, metavar=("TAU_CLEAN", "TAU_FOULED", "DAYS_TO_FOUL", "CLEAN_EVERY"),
                   help="cloth fouling timeline: transmission clean and fouled, days to foul fully, days between cleanings (0 = never)")
    p.add_argument("--scenario", choices=["constant", "dynamic", "both"], default="both")
    p.add_argument("--no-sync", action="store_true", help="size the canopy for --reduction instead of matching the cloth")
    p.add_argument("--rating", type=float, default=80.0, help="cloth shade rating, percent")
    p.add_argument("--reduction", type=float, default=75.0, help="canopy target light reduction, percent")
    p.add_argument("--coral", default="typical")
    p.add_argument("--acclimate", choices=["time", "site", "shade", "none"], default="time")
    p.add_argument("--light", default="tmy", help="tmy | example | clearsky | YEAR0-YEAR1 | path to a PVGIS CSV")
    p.add_argument("--spacing", type=float, default=0.05)
    p.add_argument("--noon-shift", type=float, default=0.0, help="shift solar noon, minutes (+ = later)")
    p.add_argument("--wind", type=float, help="wind speed at 10 m, m s-1 (default: from the light data)")
    p.add_argument("--out", help="folder for CSV results")
    p.add_argument("--mc-check", action="store_true", help="check with the 3-D Monte Carlo (a few minutes)")
    a = ap.parse_args(argv)
    from .geometry import Target
    tgt = a.target
    if tgt.startswith("rect:"):
        lx, ly = (float(v) for v in tgt[5:].split("x")); tgt = Target("rect", lx, ly)
    elif tgt.startswith("circle:"):
        dd = float(tgt[7:]); tgt = Target("circle", dd, dd)
    light = a.light
    if "-" in light and light.replace("-", "").isdigit():
        y0, y1 = light.split("-"); light = (int(y0), int(y1))
    tz = a.tz if a.tz is not None else surface.utc_offset_from_lon(a.lon)
    lo, hi = (float(v) for v in a.w0_range.split("-"))
    w0 = a.w0
    if a.w0_reading:
        ratio, lx, ly, h = a.w0_reading
        noon = solar.solar_noon(*a.start, a.lon, tz)
        cal = sc.w0_from_reading(ratio, Panel(lx=lx, ly=ly, height=h, tau=0.0), (0.0, 0.0), a.kd, a.depth, a.start, noon, a.lat, a.lon, tz)
        w0 = cal["w0"]
        print(f"w0 from the reading: {w0:.3f} ({cal['status']})")
    kds = conditions.kd_series_from_csv(open(a.kd_series, encoding="utf-8").read()) if a.kd_series else None
    tide = conditions.tide_from_csv(open(a.tide, encoding="utf-8").read()) if a.tide else None
    foul = None
    if a.fouling:
        tc, tf, dtf, every = a.fouling
        foul = conditions.Fouling(tau_clean=tc, tau_fouled=tf, days_to_foul=dtf, clean_every=int(every))
    r = D.design(a.lat, a.lon, tz=tz, start=a.start, end=a.end, target=tgt, depth=a.depth, height=a.height, kd=a.kd, w0=w0,
                 w0_range=(lo, hi), scenario=a.scenario, sync=not a.no_sync, cloth_rating=a.rating, dynamic_reduction=a.reduction,
                 coral=a.coral, acclimate=a.acclimate, light=light, spacing=a.spacing, noon_shift=a.noon_shift, wind=a.wind,
                 kd_series=kds, tide=tide, fouling=foul, tau_clean=foul.tau_clean if foul else None)
    print(r.summary())
    if a.out:
        for f in r.to_csv(a.out):
            print("wrote", f)
    if a.mc_check:
        r.mc_check()
    return 0


if __name__ == "__main__":
    sys.exit(main())
