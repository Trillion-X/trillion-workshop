"""cutout-bottom: a cut-out of a person whose body is cut by a straight line sits flush on the bottom edge of the frame; it
floats with a gap only when the bottom edge is itself styled.
The cut-out shape is the tall opaque shape in the overlay that reaches down near the frame bottom. Its lowest opaque row is read at
full resolution; the gap is the rows between it and the frame bottom. The spec exempts a cut-out with `bottom_edge` set to a styled
value (torn, textured, outlined)."""
import subprocess

import cv2
import numpy as np

from ..report import Finding
from .in_frame import _runs

EMPTY_SET = 'no cut-out element'      # a needs() reason that means the spec has no element of this kind: reported as a pass, not a skip
NAME = 'cutout-bottom'


def cutout_events(ctx):
    types = set(ctx.cfg['cutout_bottom']['types'])
    return [ev for ev in ctx.spec.get('events', []) if ev.get('type') in types or ev.get('kind') in types]


def occluded_ids(ctx):
    """Ids of the elements that declare `occluded_by` (on the spec event or on the render's timeline element): graphics behind the person, cut by a matte of them, never their own cut-out."""
    return {x.get('id') for x in ctx.spec.get('events', []) + (ctx.timeline or {}).get('elements', []) if x.get('occluded_by')}


def undeclared_cutouts(ctx):
    """Spec events that look like a person cut-out (a cut-out, person, segment or matte type, kind or field) but are not declared as type
    `cutout`, so the bottom check would skip them. An element that declares `occluded_by` is a graphic behind the person, not a cut-out of them: its `matte` field is the hole they leave in it."""
    la = ctx.cfg['cutout_bottom']['look_alike']
    real = {id(ev) for ev in cutout_events(ctx)}
    behind = occluded_ids(ctx)
    not_person = set(ctx.cfg['cutout_bottom']['not_person_types'])      # from the limits: cut-outs of objects, never of the person on screen
    return [ev for ev in ctx.spec.get('events', []) if id(ev) not in real and ev.get('type') not in not_person and ev.get('id') not in behind and
            (any(s in str(ev.get('type', '')) for s in la['type_substrings']) or ev.get('kind') in la['kinds'] or any(k in ev for k in la['keys']))]


def needs(ctx):
    if not cutout_events(ctx) and not undeclared_cutouts(ctx):
        return 'no cut-out element in the spec'          # a fact about the spec: needs no overlay
    return None if ctx.overlay else 'no overlay.mov'


def strip_frames(overlay, width, height, strip_px, fps):
    """The bottom strip_px rows of the overlay at full resolution, as rgba, fps frames a second."""
    cmd = ['ffmpeg', '-nostdin', '-v', 'error', '-i', overlay, '-vf', f'fps={fps},crop={width}:{strip_px}:0:{height - strip_px}',
           '-f', 'rawvideo', '-pix_fmt', 'rgba', '-']
    raw = subprocess.run(cmd, capture_output=True, check=True).stdout
    return np.frombuffer(raw, np.uint8).reshape(-1, strip_px, width, 4)


def preview_strips(preview, width, height, strip_px, fps):
    """The bottom strip_px rows of the rendered preview (what the viewer sees) at 1920x1080 scale, as rgb, fps frames a second."""
    cmd = ['ffmpeg', '-nostdin', '-v', 'error', '-i', preview, '-vf', f'fps={fps},scale={width}:{height},crop={width}:{strip_px}:0:{height - strip_px}',
           '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-']
    raw = subprocess.run(cmd, capture_output=True, check=True).stdout
    return np.frombuffer(raw, np.uint8).reshape(-1, strip_px, width, 3).astype(np.float32)


def band_gap(strip, x0, x1, c):
    """Rows of paper-coloured band between the figure's straight bottom edge and the frame bottom, measured on the rendered preview.
    Bottom rows count as band while, across the figure's columns, they are uniform (low spread), close in hue to the page colour read beside
    the figure and no darker than a shadow of it; the band must also end in a step (the figure's edge) of at least min_step in lightness."""
    w = strip.shape[1]
    lo, hi = max(x0 - c['ref_offset_px'], 0), min(x1 + c['ref_offset_px'], w)
    ref_cols = np.r_[lo - c['ref_width_px']:lo, hi:hi + c['ref_width_px']]
    ref_cols = ref_cols[(ref_cols >= 0) & (ref_cols < w)]
    if len(ref_cols) < 10:
        return 0
    lum = strip[..., 0] * 0.2126 + strip[..., 1] * 0.7152 + strip[..., 2] * 0.0722
    span = slice(x0, x1)
    row_mean = strip[:, span].mean(axis=1)
    row_std = lum[:, span].std(axis=1)
    page = strip[:, ref_cols].mean(axis=1)                      # the page colour beside the figure, per row
    gap = 0
    for y in range(len(strip) - 1, -1, -1):
        hue_off = np.abs(row_mean[y] / max(row_mean[y].sum(), 1) - page[y] / max(page[y].sum(), 1)).max()
        ratio = lum[y, span].mean() / max(float(lum[y, ref_cols].mean()), 1.0)
        if row_std[y] <= c['band_std_max'] and hue_off <= c['band_hue_tol'] and c['band_min_ratio'] <= ratio <= c['band_max_ratio']:
            gap += 1
        else:
            break
    if gap == 0 or gap == len(strip):
        return 0 if gap == 0 else gap
    step = abs(float(lum[len(strip) - gap, span].mean()) - float(lum[len(strip) - gap - 1, span].mean()))
    return gap if step >= c['min_step'] else 0


def small_frames(overlay, w, h, fps):
    cmd = ['ffmpeg', '-nostdin', '-v', 'error', '-i', overlay, '-vf', f'fps={fps},scale={w}:{h}', '-f', 'rawvideo', '-pix_fmt', 'rgba', '-']
    raw = subprocess.run(cmd, capture_output=True, check=True).stdout
    return np.frombuffer(raw, np.uint8).reshape(-1, h, w, 4)


def foreground(rgba, c):
    """Mask of what is not background. Over a full-sheet overlay (paper under everything) it is whatever differs from the sheet's colour;
    over a transparent overlay it is whatever is opaque."""
    rgba = rgba.astype(np.int16)
    opaque = rgba[..., 3] > c['pixel_alpha']
    if opaque.mean() >= c['sheet_opaque_frac']:
        paper = np.median(rgba[..., :3].reshape(-1, 3), axis=0)
        return np.abs(rgba[..., :3] - paper).max(axis=-1) > c['paper_delta']
    return opaque


def run(ctx):
    c = ctx.cfg['cutout_bottom']
    events = cutout_events(ctx)
    undeclared = [Finding(NAME, 'WARN', f'{ev.get("type")} "{ev.get("id")}" looks like a person cut-out but is not declared as type "{ctx.cfg["cutout_bottom"]["types"][0]}" in the spec, '
                          'so its bottom gap is not measured; declare it', data={'not_measured': True}) for ev in undeclared_cutouts(ctx)]
    if not events:
        return undeclared
    styled = [ev for ev in events if ev.get(c['edge_key']) in c['styled_values']]
    if len(styled) == len(events):
        return undeclared + [Finding(NAME, 'INFO', f'every cut-out declares a styled bottom edge ({", ".join(str(e[c["edge_key"]]) for e in styled)}); a gap is allowed')]
    fw, fh = ctx.cfg['frame']['width'], ctx.cfg['frame']['height']
    w, h = ctx.cfg['analysis']['overlay_width'], ctx.cfg['analysis']['overlay_height']
    fps = c['sample_fps']
    small = small_frames(ctx.overlay, w, h, fps)
    strips = preview_strips(ctx.preview, fw, fh, c['strip_px'], fps)
    own = strip_frames(ctx.overlay, fw, fh, c['strip_px'], fps)
    t0 = ctx.overlay_t0 or 0.0
    gaps = np.full(len(strips), -1)
    for k in range(min(len(small), len(own))):
        kp = int(round((t0 + k / fps) * fps))                       # the preview frame that plays at this overlay frame
        if not 0 <= kp < len(strips):
            continue
        mask = cv2.morphologyEx(foreground(small[k], c).astype(np.uint8), cv2.MORPH_OPEN, np.ones((3, 3), np.uint8))
        cnt, lab, stats, _ = cv2.connectedComponentsWithStats(mask, connectivity=8)
        for s in range(1, cnt):
            x, y, cw, ch, area = stats[s]
            if ch >= c['min_height_frac'] * h and y + ch >= h - c['reach_px'] / (fh / h):
                x0, x1 = int(x * fw / w), int((x + cw) * fw / w)
                gaps[k] = band_gap(strips[kp], x0, x1, c)
                break
    bad = gaps > c['max_gap_px']
    out = []
    for i, j in _runs(bad):
        if (j - i) / fps >= c['min_run_s']:
            out.append(Finding(NAME, 'FAIL', f'a straight-cut person cut-out floats {int(np.median(gaps[i:j]))}px above the bottom of the frame (limit {c["max_gap_px"]}px) for {(j - i) / fps:.1f}s; '
                               'move it down to sit on the frame edge, or style its bottom edge (torn, textured) and declare it in the spec',
                               t0 + i / fps, t0 + j / fps, {'gap_px': int(np.median(gaps[i:j]))}))
    seen = int((gaps >= 0).sum())
    if not seen:
        return undeclared + [Finding(NAME, 'WARN', 'no cut-out shape reaching the frame bottom was found in the overlay, so its bottom gap is not measured', data={'not_measured': True})]
    return undeclared + (out or [Finding(NAME, 'INFO', f'cut-out bottom measured on {seen} sampled frames; gap at most {int(gaps.max())}px')])
