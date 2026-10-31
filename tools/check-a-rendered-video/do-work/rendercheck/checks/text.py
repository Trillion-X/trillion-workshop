"""text lint: every on-screen string is a complete phrase (no transcript fragments), and in the rendered frames
text over footage has enough contrast against what is behind it, carries no outline, and nothing sits in the bottom
caption zone that YouTube's controls cover."""
import cv2
import numpy as np

from ..ctx import dotted
from ..report import Finding

NAME = 'text'

OVERLAY_ONLY = True      # on a plain video (no overlay, no spec events) there is nothing of this kind to measure: an empty set, reported as a pass


def needs(ctx):
    return None if ctx.spec.get('events') or ctx.overlay else 'no spec events and no overlay'


def strings(ctx):
    """[(event, text)] for every on-screen string; a card whose text continues in a nested `then` entry (config text.continued_by_then_types) is read as one string."""
    c = ctx.cfg['text']['fields']
    out = []
    for ev in ctx.spec.get('events', []):
        paths = c.get(ev['type'], [])
        if ev['type'] in ctx.cfg['text']['continued_by_then_types'] and isinstance(ev.get('then'), dict) and ev['then'].get('text'):
            out.append((ev, ev['text'].rstrip() + ' ' + ev['then']['text']))
            continue
        for p in paths:
            out += [(ev, v) for v in dotted(ev, p) if isinstance(v, str)]
    return out


def lint_strings(ctx):
    c = ctx.cfg['text']
    out = []
    for ev, text in strings(ctx):
        flat = ' '.join(text.split())
        at = ctx.element_start(ev)
        t = at + ctx.overlay_t0 if at is not None and ctx.overlay_t0 is not None else None
        where = f'{ev["type"]} "{ev.get("id")}"'
        if flat and flat[-1] in c['bad_trailing_chars']:
            out.append(Finding(NAME, 'FAIL', f'{where}: "{flat}" ends with "{flat[-1]}" (a transcript fragment, not a finished phrase)', t))
        last = flat.rstrip(''.join(c['bad_trailing_chars'])).split(' ')[-1].lower().strip('.,!?;:') if flat else ''
        if last in c['dangling_words'] and len(flat.split()) > 1:
            out.append(Finding(NAME, 'FAIL', f'{where}: "{flat}" ends on the dangling word "{last}"', t))
        if '  ' in text.replace('\n', ' ') or ',,' in flat or ' ,' in flat:
            out.append(Finding(NAME, 'WARN', f'{where}: "{flat}" has stray spacing or punctuation', t))
        for k in c['outline_keys']:
            if ev.get(k):
                out.append(Finding(NAME, 'FAIL', f'{where}: spec sets "{k}" on text (text depth is a soft drop shadow, never an outline)', t))
    return out


def _lin(v):
    v = np.asarray(v, np.float32)
    return np.where(v <= 0.03928, v / 12.92, ((v + 0.055) / 1.055) ** 2.4)


def _lum(rgb):
    r, g, b = _lin(rgb[..., 0]), _lin(rgb[..., 1]), _lin(rgb[..., 2])
    return 0.2126 * r + 0.7152 * g + 0.0722 * b


def _ratio(a, b):
    hi, lo = max(a, b), min(a, b)
    return (hi + 0.05) / (lo + 0.05)


def _sample_frames(ctx):
    """Overlay rgb+alpha and the matching preview frame at every sample_every_s, one decode pass each."""
    c = ctx.cfg['text']
    w, h = c['render_width'], c['render_height']
    every = c['sample_every_s']
    vf = f'fps=1/{every},scale={w}:{h}'
    def grab(path, pix, pre='', ss=0.0):
        cmd = ['ffmpeg', '-nostdin', '-v', 'error'] + (['-ss', f'{ss:.4f}'] if ss > 0 else []) + ['-i', path, '-vf', pre + vf, '-f', 'rawvideo', '-pix_fmt', pix, '-']
        ch = 3 if pix == 'rgb24' else 1
        import subprocess
        raw = subprocess.run(cmd, capture_output=True, check=True).stdout
        a = np.frombuffer(raw, np.uint8)
        return a.reshape(-1, h, w, 3) if ch == 3 else a.reshape(-1, h, w)
    rgb = grab(ctx.overlay, 'rgb24').astype(np.float32) / 255
    al = grab(ctx.overlay, 'gray', 'alphaextract,').astype(np.float32) / 255
    off = ctx.overlay_t0
    pv = grab(ctx.preview, 'rgb24', ss=max(off, 0.0)).astype(np.float32) / 255
    n = min(len(rgb), len(al), len(pv))
    return rgb[:n], al[:n], pv[:n], every


def _box_spans(ctx, ev_id):
    """[(box entry, seconds on screen from, seconds on screen to or None)] for every timeline box the event id names, in time order (overlay seconds). A box ends at its
    own `t1` when it has one; without one it stays until the next box of the same id replaces it, or to the end of the video (None) when none does."""
    entries = sorted((b for b in (ctx.timeline or {}).get('boxes', []) if b['id'] == ev_id), key=lambda b: b.get('t0') or 0.0)
    out = []
    for k, b in enumerate(entries):
        end = b.get('t1')
        if end is None and k + 1 < len(entries):
            end = entries[k + 1].get('t0')
        out.append((b, b.get('t0'), end))
    return out


def _direct_boxes(ctx):
    """[(event, x0, y0, x1, y1, on screen from, on screen to)] of the text blocks drawn straight over the footage; the times are overlay seconds, None when unknown (open)."""
    c = ctx.cfg['text']
    box = c['direct_text_box']
    out = []
    for ev in ctx.spec.get('events', []):      # a renderer that records its text block in the timeline (safe_box): the measured box, every one the event's id names
        if ev['type'] in c['timeline_box_types']:
            for b, start, end in _box_spans(ctx, ev.get('id')):
                x0, y0, x1, y1 = b['box']
                out.append((ev, x0 - box['pad_px'], y0 - box['pad_px'], x1 + box['pad_px'], y1 + box['pad_px'], start, end))
    for ev in ctx.spec.get('events', []):
        if ev['type'] not in c['direct_over_footage_types'] or 'pos' not in ev:
            continue
        size = ev.get('size') or ev.get('num_px') or 60
        n = len(str(ev.get('text', ev.get('value', 'xxxxxxxxxxxx'))))
        x, y = ev['pos']
        end = ev.get('until', ev.get('out'))
        out.append((ev, x - box['pad_px'], y - box['pad_px'], x + n * size * box['w_per_char_em'] + box['pad_px'], y + size * box['h_em'] + box['pad_px'],
                    ctx.element_start(ev), end if isinstance(end, (int, float)) else None))
    return out


def _on_screen(b, rel):
    """A box owns text only while its event is on screen (overlay seconds from..to; an unknown end stays open): another graphic later drawn over the same place is not its text."""
    return (b[5] is None or rel >= b[5]) and (b[6] is None or rel <= b[6])


def rendered_findings(ctx):
    c = ctx.cfg['text']
    rgb, al, pv, every = _sample_frames(ctx)
    n, h, w = al.shape
    sx, sy = w / ctx.cfg['frame']['width'], h / ctx.cfg['frame']['height']
    boxes = _direct_boxes(ctx)
    out = []
    stats_seen = ctx._cache.setdefault('text_stats', {'measured': 0, 'lowest': None})
    caption_hits = []
    zone_y = h * (1 - c['caption_zone_bottom_pct'] / 100)
    for k in range(n):
        t = ctx.overlay_t0 + k * every
        m = (al[k] >= c['alpha_core']).astype(np.uint8)
        cnt, lab, stats, cents = cv2.connectedComponentsWithStats(m, connectivity=8)
        hit_zone = False
        for i in range(1, cnt):
            area = stats[i, cv2.CC_STAT_AREA]
            if area < 12 or area > c['text_component_max_area_frac'] * w * h:
                continue
            px = lab == i
            er = cv2.erode(px.astype(np.uint8), np.ones((2 * c['outline_band_px'] + 1,) * 2, np.uint8)) > 0
            col = np.median(rgb[k][px], axis=0)
            lum = float(_lum(col))
            chroma = float(col.max() - col.min())
            text_like = chroma <= c['text_like_max_chroma'] and (lum >= c['text_like_min_lum'] or lum <= c['text_like_max_lum'])
            cx, cy = cents[i]
            if text_like and cy >= zone_y:
                hit_zone = True
            inside = [b for b in boxes if b[1] * sx <= cx <= b[3] * sx and b[2] * sy <= cy <= b[4] * sy and _on_screen(b, t - (ctx.overlay_t0 or 0.0))]
            # overlapping spec boxes (two stacked lines): the component belongs to the box whose centre is nearest
            owner = min(inside, key=lambda b: ((b[1] + b[3]) / 2 * sx - cx) ** 2 + ((b[2] + b[4]) / 2 * sy - cy) ** 2) if inside else None
            if owner is None or not text_like:
                continue
            x0, y0, bw, bh = stats[i, :4]
            pad = max(int(c['ring_px'] * sx), 3)
            ys, xs = slice(max(y0 - pad, 0), y0 + bh + pad), slice(max(x0 - pad, 0), x0 + bw + pad)
            dil = cv2.dilate(px[ys, xs].astype(np.uint8), np.ones((2 * pad + 1, 2 * pad + 1), np.uint8)) > 0
            free = dil & ~px[ys, xs] & (al[k][ys, xs] < c['alpha_core'])
            if free.sum() < 20:
                continue
            ev = owner[0]
            if ev.get(c['animated_keys'][0]) or ev.get(c['animated_keys'][1]):
                start = ctx.element_start(ev)
                if start is None or t - (ctx.overlay_t0 or 0.0) < start + ev.get('settle_s', c['default_settle_s']):  # start is overlay-relative, t is preview time
                    continue        # rolling or animated text is measured on settled frames only
            bg = float(_lum(pv[k][ys, xs][free]).mean())
            ratio = _ratio(lum, bg)
            stats_seen['measured'] += 1
            stats_seen['lowest'] = ratio if stats_seen['lowest'] is None else min(stats_seen['lowest'], ratio)
            if ratio < c['min_contrast_ratio']:
                out.append(Finding(NAME, 'FAIL', f'{ev["type"]} "{ev.get("id")}": text is {"white" if lum > 0.5 else "black"} on a background of luminance {bg:.2f}: contrast {ratio:.1f}:1 (needs {c["min_contrast_ratio"]:g}:1)',
                                   t, data={'ratio': ratio}))
            band = px & ~er
            if band.sum() >= 10:
                d = abs(float(_lum(rgb[k][band].mean(axis=0))) - lum)
                if d > c['outline_lum_delta']:
                    out.append(Finding(NAME, 'FAIL', f'{ev["type"]} "{ev.get("id")}": the edge of the letters is a different colour from their fill (outline/stroke, difference {d:.2f})', t))
        caption_hits.append(hit_zone)
    run = 0
    for k, hz in enumerate(caption_hits + [False]):
        if hz:
            run += 1
            continue
        if run * every >= c['caption_min_run_s']:
            t1 = ctx.overlay_t0 + (k - run) * every
            out.append(Finding(NAME, 'FAIL', f'text-like overlay content sits in the bottom {c["caption_zone_bottom_pct"]}% of the frame for {run * every:.1f}s (YouTube controls cover it)', t1, t1 + run * every))
        run = 0
    return _dedupe(out)


def _dedupe(findings):
    """One finding per (message prefix) with its first time and count of samples, so a steady problem prints once."""
    seen, out = {}, []
    for f in findings:
        key = (f.check, f.message.split(':')[0], f.message.split(':', 1)[1].split('contrast')[0] if 'contrast' in f.message else f.message[:60])
        if key in seen:
            seen[key].data['samples'] = seen[key].data.get('samples', 1) + 1
            seen[key].t_end = f.t
            continue
        seen[key] = f
        out.append(f)
    return out


def run(ctx):
    out = lint_strings(ctx)
    if ctx.overlay and ctx.overlay_t0 is not None:
        out += rendered_findings(ctx)
    if not out:
        n = len(strings(ctx))
        st = ctx._cache.get('text_stats')
        rendered = (f'; rendered frames: {st["measured"]} text-over-footage sample(s)' + (f', lowest contrast {st["lowest"]:.1f}:1' if st['lowest'] else '') + ', no outline, nothing in the caption zone') if st else '; no overlay, so rendered checks skipped'
        return [Finding(NAME, 'INFO', f'{n} on-screen string(s) linted{rendered}')]
    return sorted(out, key=lambda f: (f.t is None, f.t or 0))
