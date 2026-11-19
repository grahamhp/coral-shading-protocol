"""Build the fast engine's light tables with the forward Monte Carlo (run once; results ship in shared/tables).

For each water type (single-scattering albedo w0), sun zenith angle and optical depth tau = c z, the table
holds, per unit downwelling irradiance just below the surface:
- beam: light arriving within 3 deg of the refracted sun (unscattered or forward-scattered within the cone);
- sun_A[m][theta]: Fourier coefficients (m = 0..4) in relative azimuth of the remaining sunlight, per 3-deg
  zenith band, so that its planar irradiance from zenith band theta and azimuth phi (relative to the sun)
  has density sum_m A_m cos(m phi) per radian;
- sky_A0[theta]: the same for uniform skylight (azimuthally symmetric, m = 0 only);
- sun_total, sky_total: open-water Ed(tau) / Ed(0-).

Run: python -m coralshading.build_tables [n_photons] [workers]
"""
from __future__ import annotations

import json
import math
import sys
import time

import numpy as np

from . import SHARED, mc

W0S_V50 = [0.5, 0.6, 0.7, 0.8, 0.9]          # shipped in v5.0 (seeds from 1000)
W0S_V51 = [0.3, 0.4, 0.95]                     # added in v5.1 (seeds from 7000; split runs in chunks of 20,000 photons for memory)
W0S = sorted(W0S_V50 + W0S_V51)
# Split-transport runs re-done with 1,000,000 photons (same seeds): at 200,000 one heavily weighted photon left a
# spike in the deep profile (light rising with depth over one step, at depths below 10^-5 of surface light).
SPLIT_PHOTONS_OVERRIDE = {(0.4, "sun", 80.0): 1_000_000, (0.3, "sun", 40.0): 1_000_000}
SUN_ZENITHS = [0.0, 10.0, 20.0, 30.0, 40.0, 50.0, 60.0, 70.0, 80.0, 88.0]
TAUS = [round(float(x), 5) for x in np.geomspace(0.05, 40.0, 24)]          # simulated optical depths
_RATIO = (40.0 / 0.05) ** (1 / 23)
TAUS_OUT = TAUS + [round(40.0 * _RATIO ** k, 5) for k in (1, 2, 3)]         # + asymptotic extension to ~96
M_MAX = 4
MIN_TALLY = 2500        # a tabulated value is trusted while n_photons * value >= this (relative noise <= ~2 %)


def _extend(values: np.ndarray, n_photons: int):
    """values[tau, ...] with values[:, 0] the quantity tested for reliability (a total). Keeps entries up to the
    last reliable tau (n * total >= MIN_TALLY, all shallower ones too) and replaces deeper ones, and the three
    extension depths, by asymptotic decay: fixed shape, rate from a log-linear fit over the last four reliable
    depths. Returns (extended array over TAUS_OUT, index of the last reliable tau)."""
    tot = values[:, 0]
    ok = np.ones(len(tot), bool) if n_photons is None else n_photons * tot >= MIN_TALLY   # None: split-resolved
    ok &= tot > 0
    r = len(TAUS) - 1 if ok.all() else max(int(np.argmin(ok)) - 1, 3)
    tt = np.array(TAUS_OUT)
    k = slice(r - 3, r + 1)
    kappa = -np.polyfit(tt[k], np.log(np.clip(tot[k], 1e-300, None)), 1)[0]
    out = np.zeros((len(TAUS_OUT),) + values.shape[1:])
    out[: r + 1] = values[: r + 1]
    scale = np.exp(-kappa * (tt[r + 1:] - tt[r]))
    out[r + 1:] = values[r][None, ...] * scale.reshape((-1,) + (1,) * (values.ndim - 1))
    return out, r, float(kappa)


def fourier_from_bins(bins: np.ndarray) -> np.ndarray:
    """bins[theta, dphi] over dphi in [0, pi] (both sides summed) -> A[m, theta], exact projection of the
    piecewise-constant azimuthal density."""
    e = mc.DPHI_EDGES
    dphi = np.diff(e)
    A = np.zeros((M_MAX + 1, bins.shape[0]))
    A[0] = bins.sum(axis=1) / (2 * math.pi)
    for m in range(1, M_MAX + 1):
        kern = (np.sin(m * e[1:]) - np.sin(m * e[:-1])) / (m * dphi)
        A[m] = (bins * kern[None, :]).sum(axis=1) / math.pi
    return A


def _run(args, split: bool = False):
    w0, source, sunz, n, seed = args
    t0 = time.time()
    chunk = 20_000 if (split and w0 in W0S_V51) else 100_000
    if split:
        n = SPLIT_PHOTONS_OVERRIDE.get((w0, source, float(sunz)), n)
    r = mc.forward_tables(w0, source, sunz, taus=TAUS, n_photons=n, seed=seed + (50_000 if split else 0), split=split, chunk=chunk)
    bins = np.array(r["bins"])
    A = np.array([fourier_from_bins(bins[k]) for k in range(len(TAUS))])          # [tau, m, theta]
    beam = (np.array(r["unscattered"]) + np.array(r["cone"])) if source == "sun" else np.zeros(len(TAUS))
    return dict(w0=w0, source=source, sunz=sunz, beam=beam.tolist(), total=r["total"], A=A.tolist(), seconds=time.time() - t0)


def job_list(n_photons: int):
    jobs = []
    for start, grid in ((1000, W0S_V50), (7000, W0S_V51)):      # seeds as used for the shipped tables
        seed = start
        for w0 in grid:
            for sz in SUN_ZENITHS:
                seed += 1; jobs.append((w0, "sun", sz, n_photons, seed))
            seed += 1; jobs.append((w0, "sky", 0.0, n_photons, seed))
    return jobs


def run_part(part: int, of: int, n_photons: int, split: bool = False) -> str:
    """Run every of-th job starting at part; write the raw results to shared/tables/parts[_split]/part_<part>.json.
    (Independent processes, because this sandbox blocks multiprocessing pipes.)"""
    jobs = job_list(n_photons)[part::of]
    res = [_run(j, split) for j in jobs]
    d = SHARED / "tables" / ("parts_split" if split else "parts"); d.mkdir(parents=True, exist_ok=True)
    p = d / f"part_{part}.json"
    p.write_text(json.dumps(res), encoding="utf-8")
    return str(p)


def _load_parts(folder: str, n_photons: int):
    res = []
    for f in sorted((SHARED / "tables" / folder).glob("part_*.json")):
        res += json.loads(f.read_text(encoding="utf-8"))
    if len(res) != len(job_list(n_photons)):
        raise RuntimeError(f"{folder}: expected {len(job_list(n_photons))} runs, found {len(res)}")
    return res


def merge(n_photons: int, n_split: int = 0) -> str:
    res = _load_parts("parts", n_photons)
    if n_split:
        key = lambda r: (r["w0"], r["source"], r["sunz"])
        sp = {key(r): r for r in _load_parts("parts_split", n_split)}
        for r in res:
            r["split"] = sp[key(r)]
    return _assemble(res, n_photons, n_split)


def build(n_photons: int = 500_000, workers: int = 1) -> str:
    return _assemble([_run(j) for j in job_list(n_photons)], n_photons)


def _combine(r: dict, n_photons: int) -> dict:
    """Use the plain (unsplit) tallies where reliable (n * value >= MIN_TALLY) and the split-transport tallies
    below; both estimators are unbiased, the split one resolves the deep planes."""
    s = r.get("split")
    if s is None:
        return r
    out = dict(r)
    tot = np.array(r["total"]) - np.array(r["beam"]); ok = n_photons * tot >= MIN_TALLY
    k = len(TAUS) if ok.all() else int(np.argmin(ok))
    for key in ("total", "beam", "A"):
        a = np.array(r[key], float); b_ = np.array(s[key], float)
        a[k:] = b_[k:]
        out[key] = a.tolist()
    bm = np.array(r["beam"]); okb = n_photons * bm >= MIN_TALLY            # beam: same rule on its own counts
    kb = len(TAUS) if okb.all() else int(np.argmin(okb))
    beam = np.array(out["beam"]); beam[:kb] = bm[:kb]; beam[kb:] = np.array(s["beam"])[kb:]
    out["beam"] = beam.tolist()
    out["total"] = (np.array(out["beam"]) + 2 * math.pi * np.array(out["A"])[:, 0, :].sum(axis=1)).tolist()
    out["switch_tau"] = TAUS[k] if k < len(TAUS) else None
    return out


def _assemble(res, n_photons: int, n_split: int = 0) -> str:
    """Combine the runs; apply the reliability cut and asymptotic extension (see _extend)."""
    if n_split:
        res = [_combine(r, n_photons) for r in res]
    out = dict(
        description="Coral Shading Protocol v5 light tables (forward Monte Carlo). Per unit downwelling irradiance just "
                    "below a flat sea surface. Fournier-Forand phase function (n 1.10, mu 3.5835, bb/b 0.0183), "
                    "delta-truncated at 3 deg; uniform sky; no bottom reflection. Beyond the last reliable depth of "
                    "each run (n_photons x value >= min_tally) values follow asymptotic exponential decay with the "
                    "angular shape fixed (see build_tables._extend).",
        w0=W0S, sun_zeniths=SUN_ZENITHS, taus=TAUS_OUT, taus_simulated=TAUS,
        theta_edges_deg=[round(math.degrees(x), 6) for x in mc.THETA_EDGES],
        m_max=M_MAX, cone_deg=mc.CONE_DEG, n_photons=n_photons, n_photons_split=n_split, min_tally=MIN_TALLY,
        sun_beam=[[None] * len(SUN_ZENITHS) for _ in W0S], sun_total=[[None] * len(SUN_ZENITHS) for _ in W0S],
        sun_A=[[None] * len(SUN_ZENITHS) for _ in W0S], sky_total=[None] * len(W0S), sky_A0=[None] * len(W0S),
        reliable_tau_sun=[[None] * len(SUN_ZENITHS) for _ in W0S], reliable_tau_sky=[None] * len(W0S),
        seconds=sum(r["seconds"] for r in res))
    sig = lambda x: float(f"{x:.5g}")
    for r in res:
        i = W0S.index(r["w0"])
        A = np.array(r["A"]); beam = np.array(r["beam"]); total = np.array(r["total"])
        if r["source"] == "sun":
            j = SUN_ZENITHS.index(r["sunz"])
            broad = total - beam                                           # == 2 pi sum A0
            # broad part (with its angular shape) and beam extended separately, each with its own reliability
            packed = np.concatenate([broad[:, None], A.reshape(len(TAUS), -1)], axis=1)
            ext, rb, _ = _extend(packed, None if n_split else n_photons)
            beam_ext, rbeam, _ = _extend(np.stack([beam, beam], 1), None if n_split else n_photons) if beam[0] > 0 else (np.zeros((len(TAUS_OUT), 2)), 0, 0.0)
            A_ext = ext[:, 1:].reshape((len(TAUS_OUT),) + A.shape[1:])
            beam_e = beam_ext[:, 0]; tot_e = beam_e + ext[:, 0]
            out["sun_beam"][i][j] = [sig(v) for v in beam_e]
            out["sun_total"][i][j] = [sig(v) for v in tot_e]
            out["sun_A"][i][j] = [[[sig(v) for v in row] for row in Am] for Am in A_ext]
            out["reliable_tau_sun"][i][j] = [TAUS[rb], TAUS[rbeam]]
        else:
            packed = np.concatenate([total[:, None], A[:, 0, :]], axis=1)
            ext, rs, _ = _extend(packed, None if n_split else n_photons)
            out["sky_total"][i] = [sig(v) for v in ext[:, 0]]
            out["sky_A0"][i] = [[sig(v) for v in row] for row in ext[:, 1:]]
            out["reliable_tau_sky"][i] = TAUS[rs]
    p = SHARED / "tables" / "light_tables.json"
    p.parent.mkdir(parents=True, exist_ok=True)
    p.write_text(json.dumps(out, separators=(",", ":")), encoding="utf-8")
    return str(p)


if __name__ == "__main__":
    # python -m coralshading.build_tables part K N n_photons [split]  |  merge n_photons [n_split]  |  all [n_photons]
    cmd = sys.argv[1] if len(sys.argv) > 1 else "all"
    t0 = time.time()
    if cmd == "part":
        out = run_part(int(sys.argv[2]), int(sys.argv[3]), int(sys.argv[4]) if len(sys.argv) > 4 else 500_000,
                       split=len(sys.argv) > 5 and sys.argv[5] == "split")
    elif cmd == "merge":
        out = merge(int(sys.argv[2]) if len(sys.argv) > 2 else 500_000, int(sys.argv[3]) if len(sys.argv) > 3 else 0)
    else:
        out = build(int(sys.argv[2]) if len(sys.argv) > 2 else 500_000)
    print("wrote", out, "in", round(time.time() - t0), "s")
