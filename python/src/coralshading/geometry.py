"""Structures (shade panels), the shaded target area, and ray tests.

Coordinates: x east, y north, z up, in metres, origin at the centre of the target area on the target plane
(the top of the corals or the nursery table). The sea surface is at z = depth.

A panel is a flat rectangle at height `height` above the target plane, centred at (cx, cy), with sides
lx and ly. rot_deg turns it clockwise as seen on a map (rot 0: lx runs east-west). Transmission tau is the
fraction of light passing straight through (0 = opaque canopy; 0.2 = shade cloth rated 80 %).
A panel at height >= depth sits at or above the sea surface; rays then travel the rest of the way in air.
Identical in webapp/src/core/geometry.ts.
"""
from __future__ import annotations

import math
from dataclasses import dataclass

import numpy as np

from .optics import N_WATER


@dataclass(frozen=True)
class Panel:
    cx: float = 0.0
    cy: float = 0.0
    lx: float = 2.0
    ly: float = 2.0
    height: float = 0.75
    tau: float = 0.0
    rot_deg: float = 0.0

    def inside(self, x, y):
        r = math.radians(self.rot_deg)
        dx = np.asarray(x) - self.cx; dy = np.asarray(y) - self.cy
        u = dx * math.cos(r) - dy * math.sin(r)
        v = dx * math.sin(r) + dy * math.cos(r)
        return (np.abs(u) <= self.lx / 2) & (np.abs(v) <= self.ly / 2)


@dataclass(frozen=True)
class Target:
    shape: str = "rect"      # 'rect' or 'circle'
    lx: float = 1.1          # east-west size (rect) or diameter (circle), m
    ly: float = 1.1          # north-south size (rect), m

    def grid(self, spacing: float = 0.025):
        """Points on a regular grid covering the target (cell centres), each of equal area."""
        nx = max(1, int(round(self.lx / spacing))); ny = max(1, int(round((self.ly if self.shape == "rect" else self.lx) / spacing)))
        xs = (np.arange(nx) + 0.5) * (self.lx / nx) - self.lx / 2
        Ly = self.ly if self.shape == "rect" else self.lx
        ys = (np.arange(ny) + 0.5) * (Ly / ny) - Ly / 2
        X, Y = np.meshgrid(xs, ys)
        X = X.ravel(); Y = Y.ravel()
        if self.shape == "circle":
            keep = X ** 2 + Y ** 2 <= (self.lx / 2) ** 2 + 1e-12
            X, Y = X[keep], Y[keep]
        return X, Y


PRESETS = {
    "reef_star": dict(label="MARRS Reef Star (1.1 m across)", target=Target("circle", 1.1, 1.1)),
    "nursery_table_1x2": dict(label="Nursery table 1 x 2 m (long north-south)", target=Target("rect", 1.0, 2.0)),
    "rope_nursery_1x4": dict(label="Rope nursery 1 x 4 m (long north-south)", target=Target("rect", 1.0, 4.0)),
}


def ray_hit_xy(px, py, up, height: float, depth: float, air_dir=None):
    """Where a ray leaving the target point (px, py) upward along the underwater direction `up`
    (unit vector, z > 0) crosses the plane z = height. If the panel is at or above the surface
    (height >= depth), the ray is refracted into air at the surface: along `air_dir` if given (the sun's
    true direction), otherwise by Snell's law through a flat surface. Returns (hx, hy, valid); valid is False
    for rays that cannot reach the plane (e.g. total internal reflection on the way up)."""
    up = np.asarray(up, dtype=float)
    ux, uy, uz = up[..., 0], up[..., 1], np.clip(up[..., 2], 1e-12, None)
    if height <= depth:
        return px + height * ux / uz, py + height * uy / uz, np.ones(np.shape(ux), bool)
    sx = px + depth * ux / uz; sy = py + depth * uy / uz
    if air_dir is not None:
        a = np.asarray(air_dir, dtype=float)
        az_ = np.clip(a[..., 2], 1e-12, None)
        return sx + (height - depth) * a[..., 0] / az_, sy + (height - depth) * a[..., 1] / az_, np.ones(np.shape(ux), bool)
    sw = np.sqrt(np.clip(ux * ux + uy * uy, 0, None))
    sa = N_WATER * sw
    valid = sa < 1.0
    ca = np.sqrt(np.clip(1 - sa * sa, 1e-12, None))
    with np.errstate(divide="ignore", invalid="ignore"):
        hx_dir = np.where(sw > 0, ux / sw, 0.0); hy_dir = np.where(sw > 0, uy / sw, 0.0)
    t = (height - depth) * sa / ca
    return sx + t * hx_dir, sy + t * hy_dir, valid


def transmission_along(px, py, up, panels, depth: float, air_dir=None):
    """Fraction of light arriving at (px, py) from direction `up` after passing all panels (product of tau of
    every panel the ray crosses). Broadcasts over points and directions."""
    out = np.ones(np.broadcast(np.asarray(px), np.asarray(up)[..., 0]).shape)
    for p in panels:
        hx, hy, ok = ray_hit_xy(px, py, up, p.height, depth, air_dir)
        out = np.where(ok & p.inside(hx, hy), out * p.tau, out)
    return out
