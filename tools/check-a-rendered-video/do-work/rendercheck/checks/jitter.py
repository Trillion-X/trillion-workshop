"""jitter budget: stop-motion jitter is allowed in small doses.
Budget = sum over jittering elements of amplitude (px) x seconds on screen, plus how many jitter at once and how long
any one element keeps shaking. Everything is read from the spec; the amplitude comes from the recipe when given."""
from .. import jsonio
from ..report import Finding

NAME = 'jitter'

OVERLAY_ONLY = True      # on a plain video (no overlay, no spec events) there is nothing of this kind to measure: an empty set, reported as a pass


def needs(ctx):
    return None if ctx.spec.get('events') else 'no spec events'


def _amplitude(ctx):
    c = ctx.cfg['jitter']
    if ctx.recipe:
        cur = jsonio.read(ctx.recipe)
        for part in c['amplitude_px_key'].split('.'):
            cur = cur[part]
        return float(cur)
    return float(c['default_amplitude_px'])


def _exit_times(ctx, total, c):
    """Seconds (from the overlay start) at which each element id leaves; ids not listed stay to the end."""
    sounds = [s for s in (ctx.timeline or {}).get('sounds', [])]
    seen = {}
    gone = {}
    everything = None
    for ev in ctx.spec.get('events', []):
        kind = ev['type']
        if kind not in c['exit_types']:
            continue
        at = ev.get('at')
        if not isinstance(at, (int, float)):
            k = seen.get(kind, 0)
            seen[kind] = k + 1
            same = [s['t'] for s in sounds if s['kind'] == c['exit_types'][kind]]
            at = same[k] if k < len(same) else total
        if kind in c['clears_all_types']:
            everything = at if everything is None else min(everything, at)
        for tid in ev.get('targets', []):
            gone[tid] = min(gone.get(tid, total), at)
    return gone, everything


def run(ctx):
    c = ctx.cfg['jitter']
    amp = _amplitude(ctx)
    total = (ctx.timeline or {}).get('duration_s') or ctx.spec.get('duration_s') or ctx.info['duration']
    gone, everything = _exit_times(ctx, total, c)
    rows = []
    for ev in ctx.spec.get('events', []):
        on = ev.get(c['explicit_key'], ev['type'] in c['default_on_types'])
        drift = ev.get('drift') if isinstance(ev.get('drift'), dict) else None
        fast_drift = bool(drift) and 2 * 3.141592653589793 * drift.get('px', 0) / max(drift.get('period_s', 1), 1e-6) > c['drift_fast_px_s']
        if drift and not fast_drift:
            on = ev.get(c['explicit_key'], False)       # a slow drift is movement, not jitter: it is not in the budget
        if fast_drift:
            on = True                                    # a drift fast enough to read as shaking counts like a jitter
        if not on:
            continue
        t0 = ctx.element_start(ev)
        if t0 is None:
            continue
        end = min(gone.get(ev.get('id'), total), everything if everything is not None else total, *[v for v in (ev.get('out'), ev.get('until')) if isinstance(v, (int, float))])
        if isinstance(ev.get(c['jitter_seconds_key']), (int, float)):
            end = min(end, t0 + ev[c['jitter_seconds_key']])        # the shake stops after jitter_s seconds
        rows.append((ev.get('id', ev['type']), ev['type'], t0, max(end, t0), float(drift['px']) if fast_drift else amp))
    out = []
    if not rows:
        return [Finding(NAME, 'INFO', 'no element is set to jitter')]
    budget = sum(a * (e - s) for _, _, s, e, a in rows)
    base = ctx.overlay_t0 or 0.0
    # peak simultaneous jitterers
    events = sorted([(s, 1) for _, _, s, _, _ in rows] + [(e, -1) for _, _, _, e, _ in rows])
    cur = peak = 0
    peak_t = 0.0
    for t, d in events:
        cur += d
        if cur > peak:
            peak, peak_t = cur, t
    summary = f'{len(rows)} jittering elements, {amp:g}px each, {budget:.0f} px*s in total, up to {peak} at once'
    status = 'INFO'
    if budget > c['budget_px_seconds']:
        out.append(Finding(NAME, 'FAIL', f'jitter budget {budget:.0f} px*s is over {c["budget_px_seconds"]:g} ({summary})', base))
        status = None
    if peak > c['max_simultaneous']:
        out.append(Finding(NAME, 'FAIL', f'{peak} elements shake at the same time (limit {c["max_simultaneous"]}) around {base + peak_t:.1f}s', base + peak_t))
        status = None
    for eid, typ, s, e, _ in rows:
        if e - s > c['max_single_s']:
            out.append(Finding(NAME, 'FAIL', f'{typ} "{eid}" shakes for {e - s:.1f}s (limit {c["max_single_s"]:g}s); stop-motion jitter should only read as hand-made for a moment', base + s, base + e))
            status = None
    if status:
        out.append(Finding(NAME, 'INFO', summary))
    return out
