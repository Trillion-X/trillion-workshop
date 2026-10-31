"""joins: around every cut and hold entry/exit, and anywhere in the clip, find a stray frame (frozen or out of
sequence) or a jump the edit did not intend. Overlay pixels are masked out so only the footage is compared."""
import numpy as np
from scipy.ndimage import maximum_filter1d

from .. import media
from ..report import Finding

NAME = 'joins'


def needs(ctx):
    return None


def declared_covers(ctx, n):
    """Frame ranges where the spec declares a full-frame element over the A-roll (`covers_a_roll`), from the overlay start to its `until`
    plus its declared `exit_s` (default joins.cover_exit_tail_s). Used when there is no overlay.mov to read the covered pixels from: the
    footage is not visible there, so it is not judged. With an overlay the real alpha is used instead and this adds nothing."""
    c = ctx.cfg['joins']
    if ctx.overlay or ctx.overlay_t0 is None:
        return []
    out = []
    for ev in ctx.spec.get('events', []):
        if not ev.get(c['covers_a_roll_key']) or not isinstance(ev.get('until', ev.get('out')), (int, float)):
            continue
        start = ctx.element_start(ev)
        lo = ctx.overlay_t0 + (start if start is not None else 0.0)
        hi = ctx.overlay_t0 + ev.get('until', ev.get('out')) + ev.get('exit_s', c['cover_exit_tail_s'])
        out.append((max(int(lo * ctx.fps), 0), min(int(np.ceil(hi * ctx.fps)) + 1, n)))
    return out


def _diffs(ctx):
    """d[i]: mean abs diff of footage pixels between frame i-1 and i; s[i]: between i-1 and i+1; both nan where too
    little footage is visible. Returns (d, s, cov)."""
    c, an = ctx.cfg['joins'], ctx.cfg['analysis']
    w, h = an['width'], an['height']
    f = media.frames(ctx.preview, w, h).astype(np.float32)
    n = len(f)
    if ctx.overlay and ctx.overlay_t0 is not None:
        al = media.alpha_frames(ctx.overlay, w, h)
        off = round(ctx.overlay_t0 * ctx.fps)
        full = np.zeros((n, h, w), np.uint8)
        lo, hi = max(off, 0), min(off + len(al), n)
        if hi > lo:
            full[lo:hi] = al[lo - off:hi - off]
        hidden = maximum_filter1d(full, size=2 * c['alpha_dilate_frames'] + 1, axis=0) >= c['alpha_threshold']
    else:
        hidden = np.zeros((n, h, w), bool)
    for lo, hi in declared_covers(ctx, n):
        hidden[lo:hi] = True
    d = np.full(n, np.nan)
    s = np.full(n, np.nan)
    cov = np.zeros(n)
    for i in range(1, n):
        m = ~hidden[i]
        cov[i] = m.mean()
        if cov[i] < c['min_visible_fraction']:
            continue
        d[i] = np.abs(f[i] - f[i - 1])[m].mean()
        if i + 1 < n:
            s[i] = np.abs(f[i + 1] - f[i - 1])[m].mean()
    return d, s, cov


def run(ctx):
    c = ctx.cfg['joins']
    d, s, cov = _diffs(ctx)
    n = len(d)
    fps = ctx.fps
    valid = d[~np.isnan(d)]
    if len(valid) < 10:
        return [Finding(NAME, 'INFO', 'too little visible footage (overlay covers the frame) to compare joins')]
    base = max(float(np.median(valid)), 0.3)
    thr = max(c['jump_abs'], c['jump_ratio'] * base)
    jump = np.nan_to_num(d, nan=0.0) > thr
    out = []
    joins = ctx.joins()
    slack = c['hold_exit_slack_frames']
    near_join = np.zeros(n, bool)
    for j in joins:
        k = round(j['t'] * fps)
        near_join[max(k - slack, 0):k + slack + 1] = True
        win = range(max(k - c['window_frames_before'], 1), min(k + c['window_frames_after'], n))
        hits = [i for i in win if jump[i]]
        if j['kind'] == 'cut':
            if len(hits) > 1:
                out.append(Finding(NAME, 'FAIL', f'cut at {j["t"]:.2f}s shows {len(hits)} discontinuities (frames at '
                                   + ', '.join(f'{i / fps:.2f}s' for i in hits) + '); one is a stray frame', hits[0] / fps))
            continue
        # hold entry/exit must be continuous: the held frame is the frame on either side
        near = [i for i in hits if abs(i - k) <= slack]
        if near:
            i = near[0]
            side = 'before the hold' if j['kind'] == 'hold-entry' else 'after the hold'
            out.append(Finding(NAME, 'FAIL', f'{j["kind"]} at {j["t"]:.2f}s: the held frame does not match the footage {side} '
                               f'(frame difference {d[i]:.1f} vs normal motion {base:.2f}); a frozen frame shows at the join', i / fps,
                               data={'diff': float(d[i]), 'baseline': base}))
    # stray single out-of-sequence frame anywhere (A B A)
    if c['scan_whole_clip_for_stray_frames']:
        for i in range(1, n - 1):
            if np.isnan(d[i]) or np.isnan(d[i + 1]) or np.isnan(s[i]):
                continue
            if jump[i] and jump[i + 1] and s[i] < c['stray_skip_ratio'] * min(d[i], d[i + 1]):
                out.append(Finding(NAME, 'FAIL', f'one out-of-sequence frame at {i / fps:.2f}s (it differs {d[i]:.1f} from both '
                                   f'neighbours, which match each other: {s[i]:.1f})', i / fps))
    # isolated frozen frame next to a join: duplicate of the previous frame between moving frames
    moving = np.nan_to_num(d, nan=0.0) > max(c['frozen_eps'] * 4, 0.5 * base)
    for j in joins:
        if j['kind'].startswith('hold'):
            continue
        k = round(j['t'] * fps)
        for i in range(max(k - slack, 2), min(k + slack, n - 2)):
            if not np.isnan(d[i]) and d[i] < c['frozen_eps'] and moving[i - 1] and moving[i + 1]:
                out.append(Finding(NAME, 'FAIL', f'single frozen frame at {i / fps:.2f}s next to the {j["kind"]} at {j["t"]:.2f}s '
                                   f'(difference {d[i]:.2f} between moving frames)', i / fps))
    if not out:
        covered = float(np.mean(cov[1:] >= c['min_visible_fraction']))
        return [Finding(NAME, 'INFO', f'{len(joins)} join(s) checked; footage visible to compare on {covered:.0%} of frames')]
    return sorted(out, key=lambda f: f.t)
