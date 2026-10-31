"""settle: a document or card that has finished arriving sits still and eases into place quickly.
Measured on the rendered overlay, per landing: the window runs from an element landing (timeline.json) to the next landing, the next spec `out`/`until`, or the end
of the stretch where the overlay is on screen, minus the exit run-in (exit_margin_s). In it the overlay's silhouette mass and its silhouette-weighted centroid (frame pixels; the silhouette is how much of each pixel the shape covers, not how opaque the shape is: a word that dims or brightens in place does not move, see silhouette())
come to rest at the median of the last rest_frac of the window (a window whose alpha mass moves more than rest_mass_frac at rest has other things arriving or leaving and is not judged); the distance from rest is r = centroid distance + mass_px_per_frac x mass difference.
  - residual drift: r over the rest part moves by more than max_residual_px peak to peak: the graphic keeps swaying after it landed;
  - slow finish: from the frame r is within approach_frac of its maximum to the last frame r exceeds settle_px plus the rest sway takes longer than max_ease_tail_s (and no longer than longest_ease_s, beyond which it is a camera push): the ease drags.
Drift is exempt only inside the box of the drifting element itself, and only when it is the declared slow drift: the element type is in settle.drift_types (for example framed pictures and cards), drift.px is above 0 and within movement.max_range_px, drift.period_s is at least settle.drift_min_period_s. Anything else moving in the same window, a text card, a type not on the list or drift over the bound is judged normally. A spec that declares `document_drift_purpose` (>= 12 characters) keeps the drift as INFO. An undeclared sway still fails. The slow-finish test is skipped for the same declared drift too: its sway is not an ease that drags. A video with no overlay is an empty set."""
import os

import cv2
import numpy as np

from .. import media
from ..report import Finding
from .dwell import stretches

NAME = 'settle'

OVERLAY_ONLY = True


def needs(ctx):
    return None if ctx.overlay else 'no overlay.mov'


def smooth(v, n):
    if n <= 1 or len(v) < n:
        return v
    pad = np.pad(v, (n // 2, n - 1 - n // 2), mode='edge')
    return np.convolve(pad, np.ones(n) / n, mode='valid')


def landing_windows(ctx, covered, ofps):
    """[(start frame, end frame)] per landing: to the next landing, the next out/until of a spec event, or the end of the covered stretch."""
    c = ctx.cfg['settle']
    marks = sorted({float(e['at']) for e in (ctx.timeline or {}).get('elements', []) if 'at' in e})
    outs = sorted(float(ev[k]) for ev in ctx.spec.get('events', []) for k in ('out', 'until') if isinstance(ev.get(k), (int, float)))
    strs = stretches(covered, ofps, ctx.cfg['dwell']['gap_s'])
    out = []
    for m in marks:
        f = int(m * ofps)
        st = [(i, j) for i, j in strs if i <= f + 2 < j]
        if not st:
            continue
        end_t = min([x for x in marks if x > m + 0.3] + [x for x in outs if x > m + 0.3] + [st[0][1] / ofps]) - c['exit_margin_s']
        out.append((f, int(end_t * ofps)))
    return out


def split_at_rests(cx, cy, mass, f, e, ofps, c):
    """[(start, end, split)] frames: the window f..e cut wherever the picture itself shows a true rest followed by motion. A rest is a run of at least rest_split_s in which the
    centroid stays within rest_band_px of where the run began and the alpha mass within the same band (mass_px_per_frac applied), so a slow ease, whose centroid keeps travelling, never
    contains one. Each beat then runs from the frame its motion resumes to the next resume, and is judged as a landing of its own (it holds its rest at the end). A window with no
    rest in the middle comes back whole, as before."""
    need = int(c['rest_split_s'] * ofps)
    starts, i = [f], f
    while i < e - need:
        j = i
        while j + 1 < e and np.hypot(cx[j + 1] - cx[i], cy[j + 1] - cy[i]) + c['mass_px_per_frac'] * abs(mass[j + 1] - mass[i]) / (mass[i] + 1e-9) <= c['rest_band_px']:
            j += 1
        if j - i >= need and j + 1 < e - 1:      # a rest that motion follows (a rest at the window's end is the landing's own)
            starts.append(j + 1)
            i = j + 1
        else:
            i = i + max(j - i, 1)
    ends = starts[1:] + [e]
    return [(s, t, len(starts) > 1) for s, t in zip(starts, ends)]


def approved_drift_boxes(ctx, c):
    """Frame-pixel boxes (padded by the drift) of the elements whose declared drift is the slow, small drift: the event type is one of config settle.drift_types
    (for example framed pictures and cards), `drift.px` is above 0 and within movement.max_range_px, and `drift.period_s` is at least settle.drift_min_period_s. A box is found by the element's id in
    the render's timeline.json `boxes` (an id or `<id>-...`); an element with no box is not exempt (fail closed)."""
    limit = ctx.cfg['movement']['max_range_px']
    boxes = (ctx.timeline or {}).get('boxes', [])
    out = []
    for ev in ctx.spec.get('events', []):
        d = ev.get('drift')
        if not (isinstance(d, dict) and ev.get('type') in c['drift_types'] and 0 < d.get('px', 0) <= limit and d.get('period_s', 0) >= c['drift_min_period_s']):
            continue
        for b in boxes:
            if b['id'] == ev.get('id') or str(b['id']).startswith(f'{ev.get("id")}-'):
                x0, y0, x1, y1 = b['box']
                pad = c['drift_box_pad_px'] + d['px']
                out.append((x0 - pad, y0 - pad, x1 + pad, y1 + pad))
    return out


def drift_budget(ctx, c):
    """(elements, px x seconds, peak simultaneous) of the approved drifting elements (the jitter budget: the more elements shake and the longer they stay, the less allowed): each counts its
    drift px over its seconds on screen, from its landing to its `out`/`until` or the end of the render."""
    total = (ctx.timeline or {}).get('duration_s') or ctx.info['duration']
    rows = []
    for ev in ctx.spec.get('events', []):
        d = ev.get('drift')
        if not (isinstance(d, dict) and ev.get('type') in c['drift_types'] and 0 < d.get('px', 0) <= ctx.cfg['movement']['max_range_px']):
            continue
        t = ctx.element_start(ev)
        if t is None:
            continue
        end = min([total] + [v for v in (ev.get('out'), ev.get('until')) if isinstance(v, (int, float))])
        rows.append((t, max(end, t), float(d['px'])))
    marks = sorted({r[0] for r in rows})
    peak = max((sum(1 for r in rows if r[0] <= m < r[1]) for m in marks), default=0)
    return len(rows), sum((e - t) * px for t, e, px in rows), peak


def occlusions(ctx):
    """[(box or None, first overlay second, last overlay second, matte folder)] of every element that declares an occlusion matte: `occluded_by` and `matte` on its spec event or on its
    timeline.json element (the renderer writes it). Its alpha has a hole where the matte cuts something out (a person standing in front of words), and the hole moves with that something."""
    total = (ctx.timeline or {}).get('duration_s') or ctx.info['duration']
    found = {}
    for ev in ctx.spec.get('events', []):
        found.setdefault(ev.get('id'), {}).update({k: v for k, v in ev.items() if k in ('occluded_by', 'matte', 'out', 'until')})
    for el in (ctx.timeline or {}).get('elements', []):
        found.setdefault(el.get('id'), {}).update({k: v for k, v in el.items() if k in ('occluded_by', 'matte', 'at')})
    out = []
    for eid, d in found.items():
        if not d.get('occluded_by') or not d.get('matte'):
            continue
        ev = next((e for e in ctx.spec.get('events', []) if e.get('id') == eid), {'id': eid, 'at': d.get('at', 0.0)})
        start = ctx.element_start(ev) if ev.get('id') else d.get('at', 0.0)
        ends = [v for v in (d.get('out'), d.get('until')) if isinstance(v, (int, float))]
        box = next((b['box'] for b in (ctx.timeline or {}).get('boxes', []) if b['id'] == eid), None)
        out.append((box, float(start or 0.0), float(min(ends) if ends else total), d['matte']))
    return out


def matte_folder(ctx, rel):
    """The folder of per-frame mattes: absolute, or relative to the overlay's own folder, or to the video's folder."""
    for root in (os.path.dirname(ctx.overlay or ''), os.path.dirname(ctx.preview)):
        p = os.path.join(root, rel)
        if os.path.isdir(p):
            return p
    return rel if os.path.isdir(rel) else None


def unmask(ctx, a, ofps):
    """The alpha as the element would be without its occlusion, so its own movement is judged and not the hole's: in each frame, inside the element's box, the pixels the matte cuts
    out take the element's own alpha at that pixel from the other frames where they are not cut (their best-seen value). Everything the matte leaves visible is untouched, so an
    element that really moves still moves. Returns (a, names of elements whose matte folder was not found)."""
    h, w = a.shape[1:]
    fw, fh = ctx.cfg['frame']['width'], ctx.cfg['frame']['height']
    missing = []
    for box, t_in, t_out, rel in occlusions(ctx):
        folder = matte_folder(ctx, rel)
        if not folder:
            missing.append(rel)
            continue
        f0, f1 = max(int(t_in * ofps), 0), min(int(t_out * ofps), len(a))
        x0, y0, x1, y1 = (0, 0, w, h) if not box else (max(int(box[0] * w / fw) - 2, 0), max(int(box[1] * h / fh) - 2, 0), min(int(np.ceil(box[2] * w / fw)) + 2, w), min(int(np.ceil(box[3] * h / fh)) + 2, h))
        cut = np.zeros((f1 - f0, y1 - y0, x1 - x0), np.float32)      # how much the matte cuts out of each pixel, 0..1
        for n in range(f0, f1):
            m = cv2.imread(os.path.join(folder, '%04d.png' % n), cv2.IMREAD_GRAYSCALE)      # 0000.png is the overlay's first frame
            if m is not None:
                cut[n - f0] = cv2.resize(m, (w, h), interpolation=cv2.INTER_AREA)[y0:y1, x0:x1] / 255.0
        view = a[f0:f1, y0:y1, x0:x1]
        known = cut < ctx.cfg['settle']['matte_exact_below']      # where the matte takes away only part of the alpha, the element's own alpha is what is left divided by what is kept
        own = np.where(known, np.minimum(view / np.maximum(1.0 - cut, 1e-3), 255.0), 0.0)
        best = own.max(axis=0)      # per pixel: the most the element shows where the matte hardly cuts it; used where the matte takes nearly everything
        a[f0:f1, y0:y1, x0:x1] = np.where(known, own, np.maximum(view, best[None]))
    return a, missing


def edge_shape(gray, window, floor):
    """The picture's edges as coverage, so a box is judged by where its shapes are and not how opaque they are (silhouette() for pictures with no alpha to read: over an opaque cover the alpha is 1 everywhere).
    In each frame the gradient magnitude of a pixel is divided by the largest gradient within `window` pixels of it (at least `floor`, so flat surfaces and rendering noise stay at nothing): a word at 0.75 or
    1.0 opacity has the same edge, one that moves has its edge move. Scaled to 0..255, the units box_change_eps is set in."""
    kernel = np.ones((window, window), np.uint8)
    out = np.empty_like(gray)
    for i, f in enumerate(gray):
        g = np.hypot(cv2.Sobel(f, cv2.CV_32F, 1, 0), cv2.Sobel(f, cv2.CV_32F, 0, 1))
        out[i] = 255.0 * g / np.maximum(cv2.dilate(g, kernel), floor)
    return out


def box_window(ctx, c, f, e, ofps, gray, alpha):
    """Settle of the elements drawn over an opaque full-frame cover, where the overlay's total alpha and centroid are saturated and say nothing: each element is read from its own
    timeline box, by the change of the overlay's own shapes in that box from frame to frame (`gray` is edge_shape() of the picture and `alpha` the silhouette of the alpha, so a shape that only
    dims or brightens does not change; the cover beneath is static, so it drops out of a difference). Elements that arrive later
    in the window are left to their own window. Returns ([Finding], elements judged). An element is judged by the same two rules as the alpha measure: it sits still in the last
    rest_frac of its window (no change above box_change_eps), and its change dies away within max_ease_tail_s of falling under approach_frac of its peak."""
    fw, fh = ctx.cfg['frame']['width'], ctx.cfg['frame']['height']
    h, w = gray.shape[1:]
    t0 = ctx.overlay_t0 or 0.0
    boxes = {}
    covers = {str(ev.get('id')) for ev in ctx.spec.get('events', []) if ev.get(c['cover_key'])}
    for b in (ctx.timeline or {}).get('boxes', []):
        x0, y0, x1, y1 = b['box']
        if (x1 - x0) * (y1 - y0) > c['cover_box_frac'] * fw * fh or str(b['id']).split('-')[0] in covers:
            continue      # the cover itself: everything drawn on it is inside its box, so its box cannot say how any one thing settles
        if b['t0'] <= f / ofps + c['box_arrives_s']:
            boxes[b['id']] = b['box']      # the latest box of an id that was there when the window began
    out, judged = [], 0
    for eid, (x0, y0, x1, y1) in boxes.items():
        ys, ye, xs, xe = max(int(y0 * h / fh), 0), min(int(np.ceil(y1 * h / fh)), h), max(int(x0 * w / fw), 0), min(int(np.ceil(x1 * w / fw)), w)
        if ye <= ys or xe <= xs:
            continue
        s = np.zeros(e - f - 1)
        for i in range(f, e - 1):
            s[i - f] = float(np.abs(gray[i + 1, ys:ye, xs:xe] - gray[i, ys:ye, xs:xe]).mean() + np.abs(alpha[i + 1, ys:ye, xs:xe] - alpha[i, ys:ye, xs:xe]).mean())
        if len(s) < 3:
            continue
        judged += 1      # measured: an element whose box does not change in the window sits still
        if s.max() <= c['box_change_eps']:
            continue
        rest = s[len(s) - int(len(s) * c['rest_frac']):]
        where = f'"{eid}" in the window from {t0 + f / ofps:.1f}s (over a full-frame cover, read from its own box)'
        if rest.max() > c['box_change_eps']:
            out.append(Finding(NAME, 'FAIL', f'{where} keeps changing after it landed (up to {rest.max():.1f} per pixel in its last {c["rest_frac"]:.0%} of {(e - f) / ofps:.1f}s; limit {c["box_change_eps"]}): a finished element sits still',
                               t0 + (e - len(rest)) / ofps, t0 + e / ofps, {'residual': float(rest.max()), 'element': eid}))
            continue
        peak = int(np.argmax(s))
        below = np.nonzero(s[peak:] <= c['approach_frac'] * s[peak])[0]
        approach = peak + int(below[0]) if len(below) else peak
        active = np.nonzero(s > c['box_change_eps'])[0]
        tail = max(int(active[-1]) + 1 - approach, 0) / ofps
        if c['max_ease_tail_s'] < tail <= c['longest_ease_s']:
            out.append(Finding(NAME, 'FAIL', f'{where} takes {tail:.1f}s to settle from {c["approach_frac"]:.0%} of its peak change (limit {c["max_ease_tail_s"]} s): the ease drags',
                               t0 + (f + approach) / ofps, t0 + (f + int(active[-1]) + 1) / ofps, {'tail_s': tail, 'element': eid}))
    return out, judged


def silhouette(a, window):
    """The overlay's alpha as coverage, so settle judges geometry (where things are and how big) and not opacity. In each frame a pixel's alpha is divided by the largest alpha within `window` pixels of
    it: the shape's own opacity next to it. Inside a shape that is 1 whatever its opacity (a word that dims to 0.75 and rises to 1.0 while it is spoken keeps its coverage, so its mass and centroid stay put,
    and a fade changes nothing); at an edge it is the fraction of the pixel the shape covers, so a shape that moves, or grows by a fraction of a pixel, is still seen and its total is conserved. Units stay
    alpha (each pixel's coverage times the most alpha it ever shows), so min_mass_px and the thresholds apply unchanged."""
    kernel = np.ones((window, window), np.uint8)
    cover = np.stack([f / np.maximum(cv2.dilate(f, kernel), 1e-3) for f in a])
    return cover * a.max(axis=0)


def run(ctx):
    c = ctx.cfg['settle']
    a = ctx.overlay_alpha().astype(np.float32)
    ofps = ctx.overlay_fps()
    a, missing = unmask(ctx, a, ofps)
    scale = ctx.cfg['frame']['width'] / a.shape[2]
    t0 = ctx.overlay_t0 or 0.0
    exempt = approved_drift_boxes(ctx, c)
    sx, sy = a.shape[2] / ctx.cfg['frame']['width'], a.shape[1] / ctx.cfg['frame']['height']
    for x0, y0, x1, y1 in exempt:      # only the drifting element's own box is exempt: whatever else moves in the window is still judged
        a[:, max(int(y0 * sy), 0):int(y1 * sy) + 1, max(int(x0 * sx), 0):int(x1 * sx) + 1] = 0
    a = silhouette(a, c['geometry_window_px'])
    mass = a.sum(axis=(1, 2))
    ys, xs = np.mgrid[0:a.shape[1], 0:a.shape[2]]
    cx = smooth((a * xs).sum(axis=(1, 2)) / (mass + 1e-9) * scale, int(c['smooth_s'] * ofps))
    cy = smooth((a * ys[None]).sum(axis=(1, 2)) / (mass + 1e-9) * scale, int(c['smooth_s'] * ofps))
    covered = (a > ctx.cfg['in_frame']['alpha_threshold']).mean(axis=(1, 2)) > ctx.cfg['dwell']['min_cover_frac']
    why = str((ctx.spec or {}).get(c['purpose_key'], '')).strip()
    out, measured, not_measured = [], 0, []
    count, budget, peak = drift_budget(ctx, c)
    if budget > c['drift_budget_px_seconds'] or peak > c['drift_max_simultaneous']:
        out.append(Finding(NAME, 'FAIL', f'{count} elements drift for {budget:.0f} px*s in total, up to {peak} at once (limits {c["drift_budget_px_seconds"]:g} px*s, {c["drift_max_simultaneous"]} at once): the more elements move and the longer they stay, the less movement is allowed; '
                           'drop drift from some or lower its px', data={'budget': budget, 'peak': peak}))
    windows = [(s, t, whole) for f0, e0 in landing_windows(ctx, covered, ofps) for s, t, whole in split_at_rests(cx, cy, mass, f0, e0, ofps, c)]
    blind = (a > ctx.cfg['in_frame']['alpha_threshold']).mean(axis=(1, 2)) >= c['blind_opaque_frac']      # an opaque full-frame cover: the total alpha and centroid cannot see anything drawn over it
    gray_alpha = None
    for f, e, beat in windows:
        if (e - f) / ofps < (c['beat_min_window_s'] if beat else c['min_window_s']):
            continue
        if blind[f:e].mean() >= 0.5:
            if gray_alpha is None:
                gray_alpha = (edge_shape(media.frames(ctx.overlay, a.shape[2], a.shape[1], 'gray').astype(np.float32), c['geometry_window_px'], c['box_edge_floor']),
                              silhouette(ctx.overlay_alpha().astype(np.float32), c['geometry_window_px']))
            found, judged = box_window(ctx, c, f, e, ofps, *gray_alpha)
            out += found
            measured += judged
            if not judged:
                not_measured.append(f'{t0 + f / ofps:.1f}-{t0 + e / ofps:.1f}s')
            continue
        rest = slice(e - int((e - f) * c['rest_frac']), e)
        px, py, pm = np.median(cx[rest]), np.median(cy[rest]), float(np.median(mass[rest]))
        if pm < c['min_mass_px']:
            continue      # nothing but exempt drifting elements in this window
        if np.abs(mass[rest] - pm).max() > c['rest_mass_frac'] * pm:
            continue      # something else arrives or leaves while this one rests: its movement is not a drifting document
        measured += 1
        r = np.hypot(cx[f:e] - px, cy[f:e] - py) + c['mass_px_per_frac'] * np.abs(mass[f:e] - pm) / (pm + 1e-9)
        peak = int(np.argmax(r))
        approach = peak + int(np.nonzero(r[peak:] <= c['approach_frac'] * r[peak])[0][0]) if (r[peak:] <= c['approach_frac'] * r[peak]).any() else peak
        span = float(max(np.ptp(cx[rest]), np.ptp(cy[rest])))
        moving = np.nonzero(r > c['settle_px'] + span)[0]      # a sway that never ends is the drift finding, not a slow ease
        settled = int(moving[-1]) + 1 if len(moving) else 0
        tail = max(settled - approach, 0) / ofps
        where = f'graphic landing at {t0 + f / ofps:.1f}s'
        if span > c['max_residual_px']:
            level = 'INFO' if len(why) >= c['min_purpose_chars'] else 'FAIL'
            out.append(Finding(NAME, level, f'{where} keeps moving {span:.1f} px after it landed (limit {c["max_residual_px"]} px): a finished document sits still' + (f'; declared: {why}' if level == 'INFO' else ''),
                               t0 + (e - int((e - f) * c['rest_frac'])) / ofps, t0 + e / ofps, {'residual_px': span}))
        if c['max_ease_tail_s'] < tail <= c['longest_ease_s']:      # a slower run is a deliberate camera push, not an ease
            out.append(Finding(NAME, 'FAIL', f'{where} takes {tail:.1f}s to settle from {c["approach_frac"]:.0%} of its way (limit {c["max_ease_tail_s"]} s): the ease into the final position drags',
                               t0 + (f + approach) / ofps, t0 + (f + settled) / ofps, {'tail_s': tail}))
    out += [Finding(NAME, 'WARN', f'an element declares an occlusion matte at "{rel}" but its folder is not found, so its settle is measured with the hole in it, not as the element alone', data={'not_measured': True}) for rel in missing]
    if not_measured:      # a window over an opaque cover in which no element's own box could be read is never a pass
        out.append(Finding(NAME, 'WARN', f'not measured: {", ".join(not_measured)} lie under or over an opaque full-frame cover and no element box in them could be read, so nothing in them is judged', data={'not_measured': True}))
    return out or [Finding(NAME, 'INFO', f'{measured} landing windows measured; each settles quickly and sits still')]
