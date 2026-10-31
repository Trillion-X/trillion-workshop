"""cue: a graphic that points at something in the footage arrives when the speaker first shows or points at it, not after the sentence is finished.
Applies to the events whose cue is something the speaker does in the footage (config cue.visual_types, a ring that follows a spot; or any event with `cue_kind: "visual"`) and that carry a `track` (its first point is where the subject is). A label whose cue is a spoken word is anchored to the word and not judged here. The footage under that spot is read
from the video frames before the graphic lands: the mean absolute grey change in a box around the first track point (cue_box_px at the 1080 frame), against the baseline_pct percentile of the look-back window (a burst held for most of the window must not become its own baseline). The cue is the start of the first burst (at least burst_ratio times the baseline and burst_min grey levels, held burst_hold_s) in the look_back_s before the
graphic lands. The graphic fails when it lands more than max_late_s after that cue. Events with no burst in the window, or no track, are not judged; a spec may declare the cue
itself with `cue_t` (seconds from the overlay start) on the event, which replaces the measured one."""
import numpy as np

from .. import media
from ..report import Finding

NAME = 'cue'
EMPTY_SET = 'no tracked graphic in the spec'


def tracks(ctx):
    """[(event, label, first point (x, y) in frame px, landing seconds from the overlay start)] for every tracked element."""
    out = []
    for ev in ctx.spec.get('events', []):
        if ev.get('type') not in ctx.cfg['cue']['visual_types'] and ev.get('cue_kind') != 'visual':
            continue
        owners = [(ev, ev.get('track'), ev.get('at'))] + [(ev, lb.get('track'), lb.get('at')) for lb in ev.get('labels', []) if isinstance(lb, dict)]
        for e, trk, at in owners:
            if isinstance(trk, list) and trk and isinstance(trk[0], list):
                land = at if isinstance(at, (int, float)) else ctx.element_start(e)
                if land is not None:
                    out.append((e, str(e.get('id')), (float(trk[0][1]), float(trk[0][2])), float(land)))
    return out


def needs(ctx):
    return None if tracks(ctx) else EMPTY_SET


def run(ctx):
    c = ctx.cfg['cue']
    w, h = c['grid_width'], c['grid_height']
    fw, fh = ctx.cfg['frame']['width'], ctx.cfg['frame']['height']
    g = media.frames(ctx.preview, w, h, 'gray').astype(np.float32)
    d = np.abs(np.diff(g, axis=0))
    fps = ctx.info['fps']
    t0 = ctx.overlay_t0 or 0.0
    out, judged = [], 0
    for ev, name, (x, y), land in tracks(ctx):
        declared = ev.get('cue_t')
        land_p = t0 + land
        if isinstance(declared, (int, float)):
            late, cue_p = land - float(declared), t0 + float(declared)
        else:
            half = c['cue_box_px'] / 2
            x0, x1, y0, y1 = int(max(x - half, 0) * w / fw), int(min(x + half, fw) * w / fw) + 1, int(max(y - half, 0) * h / fh), int(min(y + half, fh) * h / fh) + 1
            lo, hi = max(int((land_p - c['look_back_s']) * fps), 0), min(int(land_p * fps), len(d))
            if hi - lo < int(c['burst_hold_s'] * fps) + 2:
                continue
            reg = d[lo:hi, y0:y1, x0:x1].mean(axis=(1, 2))
            thr = max(c['burst_ratio'] * float(np.percentile(reg, c['baseline_pct'])), c['burst_min'])
            hold = max(int(c['burst_hold_s'] * fps), 1)
            on = np.convolve((reg >= thr).astype(int), np.ones(hold, int), 'valid') == hold
            if not on.any():
                continue
            cue_p = (lo + int(np.argmax(on))) / fps
            late = land_p - cue_p
        judged += 1
        if late > c['max_late_s']:
            out.append(Finding(NAME, 'FAIL', f'"{name}" lands {late:.1f}s after its cue: the footage under it first moves at {cue_p:.1f}s (the speaker shows or points at it) and the graphic lands at {land_p:.1f}s (limit {c["max_late_s"]} s); '
                               'bring it in on the cue, not after the sentence', land_p, data={'late_s': late, 'cue_s': cue_p}))
    return out or [Finding(NAME, 'INFO', f'{judged} tracked graphics judged; each lands within {c["max_late_s"]} s of its cue')]
