"""face: overlays never cover or crowd the speaker's face. The face box comes from a
Haar face detector run on sampled video frames (the speaker barely moves, so the median box stands for the shot); the
overlay's alpha is then measured inside that box widened by a margin, for every overlay frame."""
import os

import cv2
import numpy as np

from .. import media
from ..report import Finding
from .in_frame import _runs
from .settle import matte_folder, occlusions

NAME = 'face'
_CASCADES = {}

OVERLAY_ONLY = True      # on a plain video (no overlay, no spec events) there is nothing of this kind to measure: an empty set, reported as a pass


def needs(ctx):
    return None if ctx.overlay else 'no overlay.mov'


def detect(gray):
    """Face boxes (x, y, w, h) in gray's pixels, frontal and profile cascades. Tests replace this function."""
    boxes = []
    for name in ('haarcascade_frontalface_default.xml', 'haarcascade_profileface.xml'):
        if name not in _CASCADES:
            _CASCADES[name] = cv2.CascadeClassifier(cv2.data.haarcascades + name)
        found = _CASCADES[name].detectMultiScale(gray, scaleFactor=1.1, minNeighbors=5, minSize=(24, 24))
        boxes += [tuple(int(v) for v in b) for b in found]
    return boxes


def face_box(ctx):
    """Median face box as fractions of the frame (x0, y0, x1, y1), the number of frames that found one, frames sampled."""
    c = ctx.cfg['face']
    w, h = c['detect_width'], c['detect_height']
    frames = media.frames(ctx.preview, w, h, 'gray', vf_pre=f'fps={c["sample_fps"]},')
    found = []
    for g in frames:
        boxes = detect(g)
        if boxes:
            x, y, bw, bh = max(boxes, key=lambda b: b[2] * b[3])
            found.append((x / w, y / h, (x + bw) / w, (y + bh) / h))
    if len(found) < c['min_detections']:
        return None, len(found), len(frames)
    return tuple(float(v) for v in np.median(np.array(found), axis=0)), len(found), len(frames)


def a_roll_hidden(ctx, alpha, ofps, c):
    """Per overlay frame: True while an element the spec declares `covers_a_roll` is active and the overlay is opaque over the whole
    frame (a full-frame cutaway, a held frame, full-screen B-roll), plus that element's declared exit window (`exit_start`, or `out` minus `exit_s`, up to `out`). The face is not on screen then. Nothing is guessed from pixels alone."""
    hidden = np.zeros(len(alpha), bool)
    full = (alpha > c['alpha_threshold']).mean(axis=(1, 2)) >= c['full_opaque_frac']
    for ev in ctx.spec.get('events', []):
        if not ev.get(c['covers_a_roll_key']):
            continue
        start = ctx.element_start(ev)
        if start is None:
            continue
        end = ev.get('out', ev.get('until'))
        secs = np.arange(len(alpha)) / ofps
        hidden |= ((secs >= start) & ((secs <= end) if end is not None else True)) & full
        if c['exit_start_key'] in ev or (end is not None and c['exit_len_key'] in ev):
            exit_from = ev.get(c['exit_start_key'], (end or 0.0) - ev.get(c['exit_len_key'], 0.0))
            hidden |= (secs >= exit_from) & (secs <= (end if end is not None else secs[-1]))    # the declared exit window, up to the element's end
    return hidden


def behind_him(ctx, a, ofps, box, c):
    """{overlay frame: covered fraction of the face} for the frames in which an element that declares `occluded_by` and `matte` (words or a surface behind the speaker, with a hole cut by the
    matte of the speaker) is on screen. There the face is the matte's person pixels inside the (widened) face box, and the overlay's coverage is counted over those pixels only: what is drawn
    beside the head in the box's margin is behind the speaker by design, while anything that really lies over the face (alpha over a person pixel) still counts in full."""
    n, h, w = a.shape
    X0, Y0, X1, Y1 = box
    out = {}
    for _, t_in, t_out, rel in occlusions(ctx):
        folder = matte_folder(ctx, rel)
        if not folder:
            continue
        for i in range(max(int(t_in * ofps), 0), min(int(t_out * ofps), n)):
            m = cv2.imread(os.path.join(folder, '%04d.png' % i), cv2.IMREAD_GRAYSCALE)      # 0000.png is the overlay's first frame
            if m is None:
                continue
            person = cv2.resize(m, (w, h), interpolation=cv2.INTER_AREA)[Y0:Y1, X0:X1] > c['person_level']
            out[i] = float((a[i, Y0:Y1, X0:X1][person] > c['alpha_threshold']).mean()) if person.any() else 0.0
    return out


def run(ctx):
    c = ctx.cfg['face']
    box, hits, sampled = face_box(ctx)
    if box is None:
        return [Finding(NAME, 'WARN', f'no face found in {sampled} sampled frames ({hits} hits, need {c["min_detections"]}); face clearance not measured', data={'not_measured': True})]
    x0, y0, x1, y1 = box
    mx, my = (x1 - x0) * c['margin_frac'], (y1 - y0) * c['margin_frac']
    a = ctx.overlay_alpha()
    n, h, w = a.shape
    X0, X1 = max(0, int((x0 - mx) * w)), min(w, int(np.ceil((x1 + mx) * w)))
    Y0, Y1 = max(0, int((y0 - my) * h)), min(h, int(np.ceil((y1 + my) * h)))
    covered = (a[:, Y0:Y1, X0:X1] > c['alpha_threshold']).mean(axis=(1, 2))
    ofps = ctx.overlay_fps()
    t0 = ctx.overlay_t0 or 0.0
    for i, frac in behind_him(ctx, a, ofps, (X0, Y0, X1, Y1), c).items():      # judged on the speaker's own pixels where something is declared to sit behind them
        covered[i] = frac
    covered = np.where(a_roll_hidden(ctx, a, ofps, c), 0.0, covered)
    out = []
    for i, j in _runs(covered > c['max_cover_frac']):
        if (j - i) / ofps >= c['min_run_s']:
            out.append(Finding(NAME, 'FAIL', f'overlay covers {covered[i:j].max() * 100:.0f}% of the speaker\'s face area (face box widened {c["margin_frac"] * 100:.0f}%) for {(j - i) / ofps:.1f}s; '
                               'resize, reshape or re-break the overlay into free space', t0 + i / ofps, t0 + j / ofps, {'cover': float(covered[i:j].max())}))
    return out or [Finding(NAME, 'INFO', f'face box found in {hits}/{sampled} frames; the overlay stays clear of it')]
