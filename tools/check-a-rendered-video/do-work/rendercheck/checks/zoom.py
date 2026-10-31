"""zoom: a punch-in is not followed by a zoom out; cutting straight back to 100% reads better.
Read from the spec: the keyframes of `edit.scale` ([[seconds, percent], ...]) and the width of the `views` of a document-zoom event (a narrower view is a zoom in).
A zoom run is a rise of at least min_zoom_pct that is later followed by a fall back of at least min_zoom_pct; the fall fails when it is a ramp (it takes more than
cut_s between its keyframes). A fall of cut_s or less is the straight cut back that is wanted, and a rise with no fall (a slow push) passes."""
from ..report import Finding

NAME = 'zoom'
EMPTY_SET = 'no zoom in the spec'

OVERLAY_ONLY = True


def needs(ctx):
    return None if ctx.spec.get('edit', {}).get('scale') or any(e.get('views') for e in ctx.spec.get('events', [])) else EMPTY_SET


def series(ctx):
    """[(where, [(t, percent)])]: percent is 100 x the zoom factor; a document view's width is converted against the first view."""
    out = []
    if ctx.spec.get('edit', {}).get('scale'):
        out.append(('edit.scale', [(float(t), float(p)) for t, p in ctx.spec['edit']['scale']]))
    for ev in ctx.spec.get('events', []):
        views = ev.get('views')
        if views and all('width' in v and 'at' in v for v in views):
            base = float(views[0]['width'])
            out.append((f'{ev["type"]} "{ev.get("id")}" views', [(float(v['at']) + (ctx.element_start(ev) or 0.0), 100.0 * base / float(v['width'])) for v in views]))
    return out


def run(ctx):
    c = ctx.cfg['zoom']
    out, n = [], 0
    for where, pts in series(ctx):
        n += 1
        peak, rose = pts[0][1], False
        for (t0, p0), (t1, p1) in zip(pts, pts[1:]):
            if p1 >= peak + c['min_zoom_pct']:
                rose = True
            if p1 > peak:
                peak = p1
            if rose and p1 <= peak - c['min_zoom_pct'] and t1 - t0 > c['cut_s']:
                out.append(Finding(NAME, 'FAIL', f'{where}: zooms in to {peak:g}% and then ramps back to {p1:g}% over {t1 - t0:.2f}s: a zoom in followed by a zoom out; cut straight back to 100% instead (a fall of {c["cut_s"]}s or less)',
                                   t1 - (ctx.p0 or 0.0), data={'peak': peak, 'to': p1, 'ramp_s': t1 - t0}))
                break
    return out or [Finding(NAME, 'INFO', f'{n} zoom runs read; none zooms in and then ramps back out')]
