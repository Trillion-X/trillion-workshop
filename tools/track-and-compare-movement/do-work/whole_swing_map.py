#!/usr/bin/env python3
"""Match every moment of one swing to the same moment of another: a time map from the target's seconds to the
reference's, found by dynamic time warping on the body's pose, pinned at contact.

Why: landmarks alone (takeback start, furthest back, contact, finish) leave everything between them stretched evenly,
so the racket drop, the forward swing and the finish still drift apart (seen by the person who filmed the student,
Nov 26 2026: contact together, but the drop from the backswing and the finish not). Here each 1/60 s of the target
is matched to the reference moment whose pose is the same.

HOW (all in image space, in torso lengths from the hips' middle; no left/right labels are trusted):
1. Each side, from its own landmarks' window: the two wrists as swap-safe tracks (swing_landmarks.wrist_tracks), the
   racket hand being the faster one at contact. A pose per frame, resampled to `rate_hz`:
     racket hand x, y and the other hand x, y   (x signed so the racket hand's takeback side is +: a mirrored or
                                                 opposite-handed recording reads the same)
     racket hand speed / its peak                (where in the swing's acceleration this is)
     shoulder width and hip width (|dx|)         (how far the body has turned)
   Each feature is scaled by its spread over both swings, so none dominates by its units.
2. Two warps, joined at contact (both sides' contact is fixed: it is given, and checked by the landmark reader):
     before contact: the target from its window start; the reference may start anywhere in its search window
     after contact:  the target to its window end; the reference may end anywhere in its search window
   so neither the start nor the finish is forced onto a landmark that could be wrong.
3. The warp path is turned into a smooth time map: the mean reference moment per target moment, smoothed over
   `smooth_s`, then held within [min_speed, max_speed] reference seconds per target second, contact kept fixed.
Every number is DATA in phase-sync.json ("pose_map").
"""
from __future__ import annotations

from typing import Any

import numpy as np

import swing_landmarks
from swing_landmarks import JI, NoLandmark, speeds


def _middle(kp: list[list[float]], a: str, b: str) -> np.ndarray:
    return (np.array(kp[JI[a]][:2], dtype=float) + np.array(kp[JI[b]][:2], dtype=float)) / 2


def pose_features(frames: list[dict[str, Any]], contact: float, start: float, end: float, landmark_settings: dict[str, Any],
                  rate_hz: float) -> tuple[np.ndarray, np.ndarray]:
    """Seconds (M,) on a `rate_hz` grid over [start, end] and the pose per second (M, 7), unscaled."""
    times, tracks, torso = swing_landmarks.wrist_tracks(frames, start, end, landmark_settings)
    near = np.abs(times - contact) <= float(landmark_settings["peak_within_s"]) + 1e-6
    if not near.any():
        raise NoLandmark(f"no pose frame within {landmark_settings['peak_within_s']} s of contact {contact:.3f} s", {"contact": contact})
    both = np.stack([speeds(times, tracks[0]), speeds(times, tracks[1])])
    hitting = int(np.argmax(both[:, near].max(axis=1)))
    hand, other = tracks[hitting], tracks[1 - hitting]
    before = times <= contact
    reach = hand[before, 0]
    side = 1.0 if reach.max() >= -reach.min() else -1.0        # the takeback's side on screen is +
    speed = both[hitting] / max(float(both[hitting][near].max()), 1e-6)
    widths = []
    by_time = {round(float(f["t"]), 6): f for f in frames}
    for second in times:
        kp = by_time[round(float(second), 6)]["kp"]
        widths.append([abs(kp[JI["l_shoulder"]][0] - kp[JI["r_shoulder"]][0]) / torso, abs(kp[JI["l_hip"]][0] - kp[JI["r_hip"]][0]) / torso])
    widths = np.array(widths)
    raw = np.column_stack([hand[:, 0] * side, hand[:, 1], other[:, 0] * side, other[:, 1], speed, widths[:, 0], widths[:, 1]])
    grid = np.arange(max(start, times[0]), min(end, times[-1]) + 1e-9, 1.0 / rate_hz)
    if contact not in grid:
        grid = np.unique(np.append(grid, contact))
    return grid, np.column_stack([np.interp(grid, times, raw[:, k]) for k in range(raw.shape[1])])


def _warp(cost: np.ndarray, free_start: bool, free_end: bool) -> list[tuple[int, int]]:
    """Classic DTW path over cost (N target x M reference) with steps (1,1), (1,0), (0,1). Rows (the target) always
    run from first to last; the reference may begin anywhere when free_start and end anywhere when free_end."""
    n, m = cost.shape
    acc = np.full((n, m), np.inf)
    acc[0, :] = np.cumsum(cost[0, :]) if not free_start else cost[0, :]
    if not free_start:
        acc[0, 1:] = np.inf
        acc[0, 0] = cost[0, 0]
    for i in range(1, n):
        acc[i, 0] = acc[i - 1, 0] + cost[i, 0]
        for j in range(1, m):
            acc[i, j] = cost[i, j] + min(acc[i - 1, j - 1], acc[i - 1, j], acc[i, j - 1])
    j = int(np.argmin(acc[n - 1])) if free_end else m - 1
    i, path = n - 1, [(n - 1, j)]
    while i > 0 or (j > 0 and not (free_start and i == 0)):
        if i == 0:
            j -= 1
        elif j == 0:
            i -= 1
        else:
            k = int(np.argmin([acc[i - 1, j - 1], acc[i - 1, j], acc[i, j - 1]]))
            i, j = (i - 1, j - 1) if k == 0 else (i - 1, j) if k == 1 else (i, j - 1)
        path.append((i, j))
    return path[::-1]


def _smooth_map(t: np.ndarray, r: np.ndarray, smooth_s: float, low: float, high: float) -> np.ndarray:
    """r(t) smoothed, kept within [low, high] slope, ends kept."""
    step = float(np.median(np.diff(t))) if len(t) > 1 else 1.0
    width = max(int(round(smooth_s / step)) | 1, 1)
    padded = np.pad(r, width // 2, mode="edge")
    out = np.convolve(padded, np.ones(width) / width, mode="valid")
    out[0], out[-1] = r[0], r[-1]
    for _ in range(50):                                      # hold the speed within its bounds, keeping the ends
        slope = np.diff(out) / np.diff(t)
        if (slope >= low - 1e-9).all() and (slope <= high + 1e-9).all():
            break
        steps = np.clip(slope, low, high) * np.diff(t)
        fwd = out[0] + np.concatenate([[0.0], np.cumsum(steps)])
        bwd = out[-1] - np.concatenate([np.cumsum(steps[::-1])[::-1], [0.0]])
        weight = np.linspace(0.0, 1.0, len(out))
        out = fwd * (1 - weight) + bwd * weight
    return out


def pose_map(target: dict[str, Any], reference: dict[str, Any], landmark_settings: dict[str, Any], s: dict[str, Any]) -> dict[str, Any]:
    """{"t": target seconds, "r": reference seconds} knots over the target window, contact on contact, with the
    reference's start and end as found and each half's mean pose distance per moment."""
    rate = float(s["rate_hz"])
    tl, rl = target["landmarks"], reference["landmarks"]
    t_from, t_to = max(tl["L1"] - float(s["lead_s"]), target["from"]), min(tl["L4"] + float(s["tail_s"]), target["to"])
    r_from = max(rl["L3"] - float(s["reference_search_before_s"]), reference["from"])
    r_to = min(rl["L3"] + float(s["reference_search_after_s"]), reference["to"])
    tg, tf = pose_features(target["frames"], tl["L3"], t_from, t_to, landmark_settings, rate)
    rg, rf = pose_features(reference["frames"], rl["L3"], r_from, r_to, landmark_settings, rate)
    spread = np.concatenate([tf, rf]).std(axis=0)
    spread[spread < 1e-6] = 1.0
    weights = np.array(s["feature_weights"], dtype=float)
    tf, rf = tf / spread * weights, rf / spread * weights
    ti, ri = int(np.argmin(np.abs(tg - tl["L3"]))), int(np.argmin(np.abs(rg - rl["L3"])))
    knots_t, knots_r, cost_per = [], [], {}
    for half, (ta, tb, ra, rb, free_start, free_end) in (("before", (0, ti, 0, ri, True, False)), ("after", (ti, len(tg) - 1, ri, len(rg) - 1, False, True))):
        cost = np.linalg.norm(tf[ta:tb + 1, None, :] - rf[None, ra:rb + 1, :], axis=2)
        path = _warp(cost, free_start, free_end)
        rows: dict[int, list[int]] = {}
        for i, j in path:
            rows.setdefault(i, []).append(j)
        seconds_t = tg[ta:tb + 1]
        seconds_r = np.array([rg[ra + int(round(np.mean(rows[i])))] if i in rows else np.nan for i in range(tb - ta + 1)])
        seconds_r[0] = rg[ra + rows[0][0]] if free_start else rg[ra]
        seconds_r[-1] = rg[ra + rows[tb - ta][-1]] if free_end else rg[rb]
        if half == "before":
            seconds_r[-1] = rg[ri]
        else:
            seconds_r[0] = rg[ri]
        smoothed = _smooth_map(seconds_t, seconds_r, float(s["smooth_s"]), float(s["min_speed"]), float(s["max_speed"]))
        cost_per[half] = round(float(np.mean([cost[i, j] for i, j in path])), 4)
        if half == "after":
            seconds_t, smoothed = seconds_t[1:], smoothed[1:]
        knots_t += list(seconds_t)
        knots_r += list(smoothed)
    every = max(int(s["knot_every"]), 1)
    keep = sorted(set(range(0, len(knots_t), every)) | {len(knots_t) - 1, ti})
    return {"t": [float(knots_t[k]) for k in keep], "r": [float(knots_r[k]) for k in keep], "pose_distance": cost_per}
