"""Command line: coralshading design --lat 10.4675 --lon 123.4506 --start 2025-04-28 --end 2025-08-08 --out results"""
from __future__ import annotations

import argparse
import json
import sys

from . import __version__, design as D


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
    p.add_argument("--kd", type=float, default=0.10); p.add_argument("--w0", type=float, default=0.9)
    p.add_argument("--scenario", choices=["constant", "dynamic", "both"], default="both")
    p.add_argument("--no-sync", action="store_true", help="size the canopy for --reduction instead of matching the cloth")
    p.add_argument("--rating", type=float, default=80.0, help="cloth shade rating, percent")
    p.add_argument("--reduction", type=float, default=75.0, help="canopy target light reduction, percent")
    p.add_argument("--coral", default="typical"); p.add_argument("--acclimate", choices=["site", "shade", "none"], default="site")
    p.add_argument("--light", default="tmy", help="tmy | example | YEAR0-YEAR1 | path to a PVGIS CSV")
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
    r = D.design(a.lat, a.lon, a.tz, a.start, a.end, tgt, a.depth, a.height, a.kd, a.w0, a.scenario, not a.no_sync, a.rating,
                 dynamic_reduction=a.reduction, coral=a.coral, acclimate=a.acclimate, light=light, spacing=a.spacing,
                 noon_shift=a.noon_shift, wind=a.wind)
    print(r.summary())
    if a.out:
        for f in r.to_csv(a.out):
            print("wrote", f)
    if a.mc_check:
        r.mc_check()
    return 0


if __name__ == "__main__":
    sys.exit(main())
