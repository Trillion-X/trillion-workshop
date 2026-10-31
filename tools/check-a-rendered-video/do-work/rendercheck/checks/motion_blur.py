"""motion-blur: a smooth, fast move in or out carries motion blur; a stop-motion style does not.
Measured on the rendered overlay at every move sound of the timeline (config motion_blur.move_kinds: slide_in, slide_out, card_in, card_out, whoosh, word_out): the
softness of the alpha edge (pixels with alpha between soft_lo and soft_hi, at measure_width x measure_height) over window_s of the move against the settled frame next
to it (soft_ref_frames after a move in, before a move out). A move whose softest frame is under blur_ratio times the settled one has no motion blur: a WARN (not a FAIL) while only one known-good control exists. A spec
declares a stop-motion move on purpose with `stop_motion_moves: {kind: reason}` (>= 12 characters). A settled frame under min_ref_px soft pixels is too small to
compare and is not judged."""
import numpy as np

from .. import media
from ..report import Finding

NAME = 'motion-blur'
EMPTY_SET = 'no move sound'

OVERLAY_ONLY = True


def needs(ctx):
    if ctx.plain:
        return EMPTY_SET
    if not ctx.overlay or not ctx.timeline:
        return 'no overlay.mov and timeline.json'
    return None if any(s['kind'] in ctx.cfg['motion_blur']['move_kinds'] for s in ctx.timeline.get('sounds', [])) else EMPTY_SET + ' in the timeline'


def run(ctx):
    c = ctx.cfg['motion_blur']
    w, h = c['measure_width'], c['measure_height']
    a = media.alpha_frames(ctx.overlay, w, h).astype(np.float32) / 255
    fps = ctx.overlay_fps()
    t0 = ctx.overlay_t0 or 0.0
    soft = ((a > c['soft_lo']) & (a < c['soft_hi'])).sum(axis=(1, 2)).astype(float)
    declared = (ctx.spec or {}).get(c['purpose_key'], {}) or {}
    out, judged = [], 0
    for s in ctx.timeline.get('sounds', []):
        if s['kind'] not in c['move_kinds']:
            continue
        k = int(s['t'] * fps)
        lo, hi = max(k - 1, 0), min(k + int(c['window_s'] * fps), len(a) - 1)
        if hi <= lo:
            continue
        inward = s['kind'] in c['inward_kinds']
        ref = soft[min(k + int(c['soft_ref_frames']), len(a) - 1)] if inward else soft[max(k - 2, 0)]
        if ref < c['min_ref_px']:
            continue
        judged += 1
        ratio = float(soft[lo:hi + 1].max() / ref)
        if ratio < c['blur_ratio']:
            why = str(declared.get(s['kind'], '')).strip()
            level = 'INFO' if len(why) >= c['min_purpose_chars'] else 'WARN'      # WARN while only one known-good control exists (c2m09-r1-1): look at the frames
            out.append(Finding(NAME, level, f'"{s["kind"]}" moves with no motion blur (edge softness {ratio:.2f}x its settled picture, needs {c["blur_ratio"]}x): a smooth move carries blur matched to its speed'
                               + (f'; declared stop-motion: {why}' if level == 'INFO' else f'; or declare a stop-motion style in the spec ({c["purpose_key"]})'), t0 + s['t'], data={'kind': s['kind'], 'ratio': ratio}))
    return out or [Finding(NAME, 'INFO', f'{judged} moves measured; each carries motion blur')]
