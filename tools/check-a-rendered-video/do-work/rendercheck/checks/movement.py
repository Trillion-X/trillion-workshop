"""movement: a drifting element's movement, when used, is slow and continuous (a gentle drift the whole time) with small travel, not
fast micro-jitter and not wide.
Each element with a box in the overlay's timeline.json is followed in the overlay's own pixels: the box region of frame i is matched to frame
i-1 (phase correlation, sub-pixel), giving a step (dx, dy) per frame. Over every sliding second after the element has landed, the path
(sum of step lengths) and the net travel (length of the summed steps) tell a drift from a jitter: a drift keeps going one way (net is most of
the path), a jitter shuffles (a long path, little net). A second that is jittery (path of at least jitter_path_px_per_s and net under
jitter_net_over_path of it) for at least min_run_s in a row is a FAIL, and so is a total travel (end to end, after landing) over
max_range_px; otherwise the peak speed and range are reported. Steps longer than max_micro_step_px are landings and exits, not movement, and
are left out. Travel is the smaller of the summed frame-to-frame steps and a chain of half-second hops (the steadier on a low-texture picture). Pixels that change from frame to frame over the run (a video playing inside a card, letters typed into a strip) are left out of the correlation, so only the element's own motion is measured. Elements whose box changes over time (typed letters) are not drifting movers and are skipped."""
import subprocess

import cv2
import numpy as np

from ..report import Finding

NAME = 'movement'

OVERLAY_ONLY = True      # on a plain video (no overlay, no spec events) there is nothing of this kind to measure: an empty set, reported as a pass


def needs(ctx):
    if not ctx.overlay:
        return 'no overlay.mov'
    if not ctx.timeline or 'boxes' not in ctx.timeline:
        return 'no timeline.json boxes (element positions unknown)'
    return None


def movers(ctx):
    """{id: (t0, box)} for ids that have exactly one box (a card or piece that sits somewhere), not a typed run of letters."""
    by_id = {}
    for b in ctx.timeline['boxes']:
        by_id.setdefault(b['id'], []).append(b)
    return {k: (v[0]['t0'], v[0]['box']) for k, v in by_id.items() if len(v) == 1}


def crop_frames(overlay, box, pad, fw, fh):
    x0, y0 = max(int(box[0]) - pad, 0), max(int(box[1]) - pad, 0)
    x1, y1 = min(int(box[2]) + pad, fw), min(int(box[3]) + pad, fh)
    w, h = (x1 - x0) // 2 * 2, (y1 - y0) // 2 * 2
    cmd = ['ffmpeg', '-nostdin', '-v', 'error', '-i', overlay, '-vf', f'crop={w}:{h}:{x0}:{y0},format=gray', '-f', 'rawvideo', '-pix_fmt', 'gray', '-']
    raw = subprocess.run(cmd, capture_output=True, check=True).stdout
    return np.frombuffer(raw, np.uint8).reshape(-1, h, w).astype(np.float32)


def still_window(frames, still_levels, blur_px, others=()):
    """Correlation window that gives no weight where the picture itself changes from frame to frame over the run (a video playing inside a card,
    letters typed into a strip). Activity is smoothed over blur_px so a moving edge (a thin line) does not count but a playing picture (an area)
    does; pixels busier than still_levels grey levels are left out."""
    h, w = frames.shape[1:]
    activity = cv2.blur(np.abs(np.diff(frames, axis=0)).mean(axis=0), (blur_px, blur_px))
    weight = cv2.GaussianBlur((activity < still_levels).astype(np.float32), (0, 0), blur_px / 3)
    for ox0, oy0, ox1, oy1 in others:      # another element's box inside this crop (a neighbour landing) is not this element moving
        weight[max(oy0, 0):max(oy1, 0), max(ox0, 0):max(ox1, 0)] = 0.0
    return cv2.createHanningWindow((w, h), cv2.CV_32F) * weight


def reference_range(frames, win, first, last, every):
    """End-to-end travel of every `every`-th frame measured against ONE reference frame (the first after landing). Nothing accumulates, so a
    low-texture picture cannot add travel hop by hop the way a chain does. A picture that changes (a video) correlates to nothing steady and reads
    large, which is why this is only ever one of several readings and the smallest wins."""
    o = np.array([cv2.phaseCorrelate(frames[first], frames[i], win)[0] for i in range(first, last, every)])
    return float(np.hypot(*(o.max(axis=0) - o.min(axis=0)))) if len(o) > 1 else 0.0


def steps_of(frames, win):
    """(dx, dy) between consecutive frames, in px of the overlay, by phase correlation inside the window."""
    out = np.zeros((len(frames), 2))
    for i in range(1, len(frames)):
        (dx, dy), _ = cv2.phaseCorrelate(frames[i - 1], frames[i], win)
        out[i] = (dx, dy)
    return out


def chained_range(frames, win, first, last, hop, max_step):
    """End-to-end travel measured in hops of `hop` frames (steps longer than max_step are landings and exits and count as none). Chaining a few long
    hops adds far less correlation noise than summing every frame's step, so on a low-texture picture it is the steadier of the two readings."""
    pos, path = np.zeros(2), [np.zeros(2)]
    for i in range(first, last - hop, hop):
        d = np.array(cv2.phaseCorrelate(frames[i], frames[i + hop], win)[0])
        pos = pos + (d if np.hypot(*d) <= max_step else 0.0)
        path.append(pos.copy())
    path = np.array(path)
    return float(np.hypot(*(path.max(axis=0) - path.min(axis=0))))


def run(ctx):
    c = ctx.cfg['movement']
    fw, fh = ctx.cfg['frame']['width'], ctx.cfg['frame']['height']
    fps = ctx.overlay_fps()
    t0_overlay = ctx.overlay_t0 or 0.0
    win = max(int(round(fps * c['window_s'])), 2)
    out = []
    movers_all = movers(ctx)
    for eid, (t0, box) in movers_all.items():
        frames = crop_frames(ctx.overlay, box, c['pad_px'], fw, fh)
        cx0, cy0 = max(int(box[0]) - c['pad_px'], 0), max(int(box[1]) - c['pad_px'], 0)
        others = [(int(b[0]) - cx0 - 8, int(b[1]) - cy0 - 8, int(b[2]) - cx0 + 9, int(b[3]) - cy0 + 9) for oid, (_, b) in movers_all.items() if oid != eid]
        win_px = still_window(frames, c['still_levels'], c['blur_px'], others)
        steps = steps_of(frames, win_px)
        mag = np.hypot(steps[:, 0], steps[:, 1])
        first = int((t0 + c['land_s']) * fps)
        live = np.zeros(len(steps), bool)
        live[first:] = True
        micro = live & (mag <= c['max_micro_step_px'])
        s = np.where(micro[:, None], steps, 0.0)
        if micro.any():
            s[micro] -= np.median(steps[micro], axis=0)      # a constant per-frame bias (an animating tick mark) is not movement
        jittery = np.zeros(len(steps), bool)
        for i in range(first, len(steps) - win):
            seg = s[i:i + win]
            path = float(np.hypot(seg[:, 0], seg[:, 1]).sum()) * (fps / win)
            net = float(np.hypot(*seg.sum(axis=0))) * (fps / win)
            jittery[i] = path >= c['jitter_path_px_per_s'] and net <= c['jitter_net_over_path'] * path
        run_len, best, best_at = 0, 0, 0
        for i, j in enumerate(jittery):
            run_len = run_len + 1 if j else 0
            if run_len > best:
                best, best_at = run_len, i - run_len + 1
        peak = float(np.max(np.hypot(*np.vstack([np.convolve(s[:, 0], np.ones(win) / win, 'same'), np.convolve(s[:, 1], np.ones(win) / win, 'same')])) * fps)) if len(s) else 0.0
        seconds = best / fps
        path = np.cumsum(s, axis=0)[first:] if first < len(s) else np.zeros((1, 2))
        span = float(np.hypot(*(path.max(axis=0) - path.min(axis=0)))) if len(path) else 0.0
        hop, every, last = max(int(round(fps * c['chain_s'])), 1), max(int(round(fps * c['ref_every_s'])), 1), len(frames) - int(fps)
        span = min([span] + [chained_range(frames, win_px, first, last, hop, c['max_micro_step_px']), reference_range(frames, win_px, first, last, every)])
        if span > c['max_range_px']:
            out.append(Finding(NAME, 'FAIL', f'"{eid}" travels {span:.1f} px from end to end (limit {c["max_range_px"]:g} px, the travel of the small reference); movement should be slow and small, not wide',
                               t0_overlay + first / fps, None, {'range_px': span}))
        elif seconds >= c['min_run_s']:
            out.append(Finding(NAME, 'FAIL', f'"{eid}" shuffles in fast small steps for {seconds:.1f}s (about {c["jitter_path_px_per_s"]:g}+ px/s of travel, most of it back and forth); '
                               'a drifting element must move as a slow, small, continuous drift or not at all', t0_overlay + best_at / fps, t0_overlay + (best_at + best) / fps, {'run_s': seconds, 'range_px': span}))
        else:
            out.append(Finding(NAME, 'INFO', f'"{eid}": {"drifts" if peak >= c["still_px_per_s"] else "holds still"}, peak speed {peak:.1f} px/s, travel range {span:.1f} px; no fast small-step shuffling', data={'range_px': span, 'peak_px_s': peak}))
    return out or [Finding(NAME, 'INFO', 'no drifting element: nothing to measure (n/a)')]
