#!/usr/bin/env python3
# packages/motion-analysis/do-work/process-scripts/match/test_player_coverage.py
#
# Pure unit test for the player-coverage reduction leaf — deterministic, no models,
# no I/O (mirrors test_shot_speed / test_rally_events). Proves the dense per-frame
# player positions reduce to ONE coverage fact with correct per-side counts, range,
# centroid, and a court-extent occupancy grid (the movement-heat the dashboard draws).
import sys

from player_coverage import build_coverage_fact


def _approx(a, b, eps=1e-6):
    return abs(a - b) <= eps


def test_empty_positions_reduce_to_a_null_sided_fact():
    f = build_coverage_fact([])
    assert f["kind"] == "perception.player.coverage"
    assert f["total_positions"] == 0
    assert f["near_court"] is None and f["far_court"] is None
    print("ok: empty -> one fact, both sides null, no crash")


def test_side_split_count_and_centroid():
    # 3 near + 1 far; centroids/ranges computed per side
    pos = [
        {"court_xy_m": [4.0, 18.0], "side": "near"},
        {"court_xy_m": [2.0, 20.0], "side": "near"},
        {"court_xy_m": [6.0, 16.0], "side": "near"},
        {"court_xy_m": [4.0, 4.0], "side": "far"},
    ]
    f = build_coverage_fact(pos, grid=(2, 2), extent=(0.0, 8.0, 0.0, 24.0))
    assert f["total_positions"] == 4
    n = f["near_court"]
    assert n["samples"] == 3
    assert _approx(n["centroid_m"][0], 4.0) and _approx(n["centroid_m"][1], 18.0)
    assert n["x_range_m"] == [2.0, 6.0] and n["y_range_m"] == [16.0, 20.0]
    far = f["far_court"]
    assert far["samples"] == 1 and far["centroid_m"] == [4.0, 4.0]
    print("ok: per-side split, count, centroid, range")


def test_occupancy_grid_bins_into_court_extent():
    # extent = full singles court 8.23m x 23.77m, 2x2 grid.
    # near players: one in the left-near cell, one in the right-near cell.
    pos = [
        {"court_xy_m": [1.0, 20.0], "side": "near"},   # x small -> col 0 ; y large -> row 1
        {"court_xy_m": [7.0, 20.0], "side": "near"},   # x large -> col 1 ; y large -> row 1
    ]
    f = build_coverage_fact(pos, grid=(2, 2), extent=(0.0, 8.23, 0.0, 23.77))
    g = f["near_court"]["occupancy_grid"]
    assert len(g) == 2 and len(g[0]) == 2          # ny rows x nx cols
    assert g[1][0] == 1 and g[1][1] == 1           # both in the far-length row, split L/R
    assert g[0][0] == 0 and g[0][1] == 0           # near-length row empty
    total = sum(c for row in g for c in row)
    assert total == 2
    print("ok: occupancy grid bins positions into court-extent cells")


def test_tuple_positions_and_clamping():
    # tuple form (x, y, side) + a position OUTSIDE the extent must clamp into an edge cell
    pos = [(100.0, 100.0, "far"), (-5.0, -5.0, "far")]
    f = build_coverage_fact(pos, grid=(3, 3), extent=(0.0, 8.0, 0.0, 24.0))
    g = f["far_court"]["occupancy_grid"]
    assert g[2][2] == 1   # (100,100) clamps to the top-right cell
    assert g[0][0] == 1   # (-5,-5) clamps to the bottom-left cell
    print("ok: tuple form + out-of-extent clamps into edge cells (no IndexError)")


if __name__ == "__main__":
    test_empty_positions_reduce_to_a_null_sided_fact()
    test_side_split_count_and_centroid()
    test_occupancy_grid_bins_into_court_extent()
    test_tuple_positions_and_clamping()
    print("CV-PLAYER-COVERAGE: all reduction tests pass")
    sys.exit(0)
