"""camera: a push-in reads as intentional and moves on a purposeful curve.
Read from the spec: every zoom run of `edit.scale` ([[seconds, percent], ...]) and every zoom of a still-picture event type (config camera.still_zoom_types) ([from, to] factors over at..until).
  - push-in: a rise that lasts at least min_push_s covers at least min_gain_pct of scale, or at least min_rate_pct_per_s per second; a smaller push is too timid to read as
    intentional and fails;
  - creep: the keyframes of an `edit.scale` rise lasting at least creep_min_s move at a nearly constant speed (the fastest segment under creep_speed_ratio times the slowest):
    a constant-speed creep fails; a quick ease in and a settle varies the speed and passes. A still-picture zoom has no curve of its own (the renderer drifts it mostly
    linearly), so one longer than creep_min_s is a WARN.
A video with neither is an empty set."""
from ..report import Finding

NAME = 'camera'
EMPTY_SET = 'no camera push in the spec'


def needs(ctx):
    return None if runs(ctx) else EMPTY_SET


def runs(ctx):
    """[(where, t0, t1, from percent, to percent, [(t, percent)] keyframes or None)] for every rise."""
    out = []
    pts = [(float(t), float(p)) for t, p in ctx.spec.get('edit', {}).get('scale', [])]
    k = 0
    while k < len(pts) - 1:
        if pts[k + 1][1] > pts[k][1]:
            j = k + 1
            while j < len(pts) - 1 and pts[j + 1][1] > pts[j][1]:
                j += 1
            out.append(('edit.scale', pts[k][0], pts[j][0], pts[k][1], pts[j][1], pts[k:j + 1]))
            k = j
        else:
            k += 1
    for ev in ctx.spec.get('events', []):
        z = ev.get('zoom')
        if ev.get('type') in ctx.cfg['camera']['still_zoom_types'] and isinstance(z, list) and len(z) == 2 and z[1] > z[0] and isinstance(ev.get('at'), (int, float)) and isinstance(ev.get('until'), (int, float)):
            out.append((f'{ev["type"]} "{ev.get("id")}"', float(ev['at']), float(ev['until']), 100 * float(z[0]), 100 * float(z[1]), None))
    return out


def run(ctx):
    c = ctx.cfg['camera']
    out = []
    t0 = ctx.overlay_t0 or 0.0
    for where, a, b, p0, p1, keys in runs(ctx):
        dur, gain = b - a, 100 * (p1 / p0 - 1)
        at = a - (ctx.p0 if where == 'edit.scale' else -t0)
        if dur >= c['min_push_s'] and gain < c['min_gain_pct'] and gain / dur < c['min_rate_pct_per_s']:
            out.append(Finding(NAME, 'FAIL', f'{where}: the push-in covers {gain:.1f}% of scale in {dur:.1f}s ({gain / dur:.1f}% per second): too timid to read as intentional (needs {c["min_gain_pct"]}% or {c["min_rate_pct_per_s"]}% per second); '
                               'push in further in the same time', at, data={'gain_pct': gain, 'dur_s': dur}))
        if dur >= c['creep_min_s']:
            if keys:
                speeds = [(q1 - q0) / (u1 - u0) for (u0, q0), (u1, q1) in zip(keys, keys[1:]) if u1 > u0]
                if speeds and max(speeds) < c['creep_speed_ratio'] * max(min(speeds), 1e-9):
                    out.append(Finding(NAME, 'FAIL', f'{where}: the zoom runs at a near-constant speed for {dur:.1f}s (a creep: fastest segment {max(speeds):.1f} against slowest {min(speeds):.1f} percent per second); use a quick ease in then a settle', at,
                                       data={'dur_s': dur}))
            else:
                out.append(Finding(NAME, 'WARN', f'{where}: a {dur:.1f}s still push with no curve of its own (the renderer drifts it mostly linearly): a creep unless it is eased in and settled', at, data={'dur_s': dur}))
    return out or [Finding(NAME, 'INFO', f'{len(runs(ctx))} zoom runs read; each pushes far enough and is not a constant-speed creep')]
