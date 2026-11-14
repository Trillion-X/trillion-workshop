#!/usr/bin/env python3
# packages/motion-analysis/do-work/process-scripts/match/player_coverage.py
#
# =============================================================================
# PURPOSE — REDUCE dense per-frame player positions to ONE coverage fact
# =============================================================================
#
# The player-detect stage emits one `perception.player.position` per detected
# player per frame (court metres + near/far side) — DENSE (kept in the command
# artifact, never exploded into the log: cont.16 trap policy). This leaf reduces
# that dense stream to ONE consumable `perception.player.coverage` fact — per-side
# sample count, spatial range, centroid, and a coarse occupancy grid (the "court
# coverage / movement heat" the dashboard's HeatGrid renders) — exactly as
# `rally_events.build_rally_fact` reduces dense bounces to one rally fact.
#
# It is a PURE leaf: no models, no I/O, no hardcoded court geometry. The court
# extent (the grid's metre bounds) is INJECTED by the caller from the court spec
# (court_geometry.tennis_polygons), so a different court/sport reduces with ZERO
# change here. The ONE place the coverage reduction lives (L100); a richer movement
# measure can compose over the same position facts downstream (progression-evaluator).
# =============================================================================

from __future__ import annotations

import numpy as np


def _cell(value, lo, hi, n):
    """Bucket `value` into [0, n) over [lo, hi] (clamped). A zero-width span -> bin 0."""
    if hi <= lo:
        return 0
    return min(n - 1, max(0, int((value - lo) / (hi - lo) * n)))


def _side_summary(pts, grid, extent):
    """pts: list[(x_m, y_m)] for ONE side. Returns its coverage summary or None."""
    if not pts:
        return None
    xs = [p[0] for p in pts]
    ys = [p[1] for p in pts]
    nx, ny = grid
    x0, x1, y0, y1 = extent
    counts = [[0] * nx for _ in range(ny)]  # ny rows (court length) x nx cols (court width)
    for (x, y) in pts:
        counts[_cell(y, y0, y1, ny)][_cell(x, x0, x1, nx)] += 1
    return {
        "samples": len(pts),
        "x_range_m": [round(min(xs), 2), round(max(xs), 2)],
        "y_range_m": [round(min(ys), 2), round(max(ys), 2)],
        "centroid_m": [round(float(np.mean(xs)), 2), round(float(np.mean(ys)), 2)],
        "occupancy_grid": counts,  # raw counts; a heat MEASURE normalizes downstream
    }


def build_coverage_fact(positions, *, grid=(3, 4), extent=None, provenance=None):
    """Reduce dense player positions to ONE perception.player.coverage fact.

    positions: iterable of {"court_xy_m": [x, y], "side": "near"|"far"} dicts
               (or (x, y, side) tuples).
    grid:      (nx, ny) — occupancy-grid resolution (width cells, length cells).
    extent:    (x0, x1, y0, y1) metre bounds of the court for the grid; when None,
               falls back to the data's own bounding box (caller SHOULD pass the
               court extent so grids are comparable across sides and matches).
    """
    near, far = [], []
    for p in positions:
        if isinstance(p, dict):
            xy = p.get("court_xy_m")
            side = p.get("side")
        else:
            xy, side = (p[0], p[1]), p[2]
        if xy is None:
            continue
        (far if side == "far" else near).append((float(xy[0]), float(xy[1])))

    allpts = near + far
    if extent is None:
        if allpts:
            xs = [p[0] for p in allpts]
            ys = [p[1] for p in allpts]
            extent = (min(xs), max(xs), min(ys), max(ys))
        else:
            extent = (0.0, 1.0, 0.0, 1.0)

    return {
        "kind": "perception.player.coverage",
        "near_court": _side_summary(near, grid, extent),
        "far_court": _side_summary(far, grid, extent),
        "total_positions": len(allpts),
        "grid": list(grid),
        "extent_m": [round(float(v), 2) for v in extent],
        "provenance": provenance or {"stage": "player-coverage.v1",
                                     "over": ["perception.player.position"]},
    }
