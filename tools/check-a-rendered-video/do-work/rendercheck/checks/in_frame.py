"""in-frame: no overlay element runs past the title-safe margin unless the spec marks it deliberately off-frame."""
import cv2
import numpy as np

from ..report import Finding

NAME = 'in-frame'
SIDES = ('left', 'right', 'top', 'bottom')



def _box(ev, model, defaults):
    env = {**defaults, **{k: v for k, v in ev.items() if isinstance(v, (int, float))}}
    if isinstance(ev.get('rows'), list):
        env['rows_n'] = len(ev['rows'])
    try:
        w = eval(model['w'], {'__builtins__': {}}, env)
        h = eval(model['h'], {'__builtins__': {}}, env)
    except NameError:
        return None
    x, y = ev['pos']
    return x, y, x + w, y + h


def spec_findings(ctx):
    """Predicted boxes of spec elements against the safe margin."""
    c = ctx.cfg['in_frame']
    fw, fh = ctx.cfg['frame']['width'], ctx.cfg['frame']['height']
    mx, my = fw * c['safe_margin_pct']['x'] / 100, fh * c['safe_margin_pct']['y'] / 100
    out = []
    for ev in ctx.spec.get('events', []):
        model = c['spec_boxes'].get(ev['type'])
        if not model or 'pos' not in ev or ev.get(c['off_frame_ok_key']):
            continue
        box = _box(ev, model, c['spec_defaults'])
        if not box:
            continue
        x0, y0, x1, y1 = box
        over = {'left': mx - x0, 'right': x1 - (fw - mx), 'top': my - y0, 'bottom': y1 - (fh - my)}
        bad = {s: round(v) for s, v in over.items() if v > 0}
        if not bad:
            continue
        beyond = {s: round(v - (mx if s in ('left', 'right') else my)) for s, v in bad.items()}
        t0 = ctx.element_start(ev)
        at = ctx.overlay_t0 + t0 if t0 is not None and ctx.overlay_t0 is not None else None
        side_txt = ', '.join(f'{s} {v}px into the margin' + (f' ({beyond[s]}px past the frame edge)' if beyond[s] > 0 else '')
                             for s, v in bad.items())
        status = 'FAIL' if any(v > 0 for v in beyond.values()) else 'WARN'
        out.append(Finding(NAME, status, f'spec box of {ev["type"]} "{ev.get("id")}" at pos {ev["pos"]}: {side_txt}', at,
                           data={'id': ev.get('id'), 'box': box}))
    return out


def _strip_counts(mask, mx, my):
    h, w = mask.shape
    return {'left': int(mask[:, :mx].sum()), 'right': int(mask[:, w - mx:].sum()),
            'top': int(mask[:my, :].sum()), 'bottom': int(mask[h - my:, :].sum())}


def _drop_bleed(mask, area_frac):
    n, lab, stats, _ = cv2.connectedComponentsWithStats(mask.astype(np.uint8), connectivity=8)
    big = [i for i in range(1, n) if stats[i, cv2.CC_STAT_AREA] >= area_frac * mask.size]
    return mask & ~np.isin(lab, big) if big else mask


def _near(ev, side, fw, fh, frac=0.3):
    if 'pos' not in ev:
        return False
    x, y = ev['pos']
    return {'left': x < fw * frac, 'right': x > fw * (1 - frac), 'top': y < fh * frac, 'bottom': y > fh * (1 - frac)}[side]


def alpha_findings(ctx):
    c = ctx.cfg['in_frame']
    a = ctx.overlay_alpha()
    n, h, w = a.shape
    fw, fh = ctx.cfg['frame']['width'], ctx.cfg['frame']['height']
    mx, my = round(w * c['safe_margin_pct']['x'] / 100), round(h * c['safe_margin_pct']['y'] / 100)
    ofps = ctx.overlay_fps()
    series = {s: np.zeros(n, int) for s in SIDES}
    gap = {s: np.full(n, 10 ** 6) for s in SIDES}
    for i in range(n):
        m = _drop_bleed(a[i] > c['alpha_threshold'], c['bleed_area_frac'])
        for s, v in _strip_counts(m, mx, my).items():
            series[s][i] = v
        if series['left'][i] > 0:
            gap['left'][i] = int(np.argmax(m[:, :mx].any(axis=0)))
        if series['right'][i] > 0:
            gap['right'][i] = int(np.argmax(m[:, w - mx:][:, ::-1].any(axis=0)))
        if series['top'][i] > 0:
            gap['top'][i] = int(np.argmax(m[:my, :].any(axis=1)))
        if series['bottom'][i] > 0:
            gap['bottom'][i] = int(np.argmax(m[h - my:, :][::-1].any(axis=1)))
    out = []
    t0 = ctx.overlay_t0 or 0.0
    scale = fw / w
    tol = c['edge_tolerance_px'] / scale
    edge = {s: gap[s] <= tol for s in SIDES}
    for s in SIDES:
        margin_runs = [(i, j) for i, j in _runs(series[s] > c['min_overflow_px_at_analysis']) if (j - i) / ofps >= c['min_run_s']]
        for i, j in margin_runs:
            touching = int((edge[s][i:j] & (series[s][i:j] > 0)).sum())
            clipped = touching / ofps >= c['min_run_s'] and touching / (j - i) >= c['edge_min_fraction']
            who = [f'{e["type"]} "{e.get("id")}"' for e in ctx.spec.get('events', [])
                   if _near(e, s, fw, fh) and e['type'] not in c['non_box_types']]
            marked = bool(who) and all(e.get(c['off_frame_ok_key']) for e in ctx.spec.get('events', []) if _near(e, s, fw, fh))
            bleed = not who and any(e['type'] in c['deliberate_bleed_types'] and (ctx.element_start(e) or 0) <= j / ofps
                                    for e in ctx.spec.get('events', []))
            ok = marked or bleed
            px = int(np.median(gap[s][i:j]) * scale)
            what = f'runs off / touches the {s} frame edge' if clipped else f'sits inside the {s} title-safe margin, typically {px}px from the {s} edge'
            msg = f'overlay content {what} for {(j - i) / ofps:.1f}s' + (f'; candidates: {", ".join(who[:4])}' if who else '')
            status = 'INFO' if ok else ('FAIL' if clipped else 'WARN')
            out.append(Finding(NAME, status, msg + ('; deliberate: ' + ('marked off_frame in the spec' if marked else 'figure bleeds off the frame by design') if ok else ''),
                               t0 + i / ofps, t0 + j / ofps, {'side': s, 'clipped': clipped, 'px': px}))
    return sorted(out, key=lambda f: f.t)


def _runs(flags):
    out, i, n = [], 0, len(flags)
    while i < n:
        if not flags[i]:
            i += 1
            continue
        j = i
        while j < n and flags[j]:
            j += 1
        out.append((i, j))
        i = j
    return out

OVERLAY_ONLY = True      # on a plain video (no overlay, no spec events) there is nothing of this kind to measure: an empty set, reported as a pass


def needs(ctx):
    return None if ctx.overlay or ctx.spec.get('events') else 'no overlay.mov and no spec events'


def run(ctx):
    out = spec_findings(ctx)
    if ctx.overlay:
        out += alpha_findings(ctx)
    return out
