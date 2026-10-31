"""dwell: a finished graphic holds long enough to read everything on it.
A graphic is a stretch where overlay alpha is on screen; its hold is the time from the last element landing (timeline.json
or spec `at`) to the end of the stretch. Needed hold = max(minimum, unnarrated words x s_per_word + items x s_per_item), and at
least dense_min_s when the graphic is dense; an element on screen long enough to read its own words by the end of the stretch (own words x s_per_word + items x s_per_item) is already read and does not count against the final hold; a word spoken aloud as it lands (video word timings, when present) counts as read."""
import re

from ..report import Finding

NAME = 'dwell'

OVERLAY_ONLY = True      # on a plain video (no overlay, no spec events) there is nothing of this kind to measure: an empty set, reported as a pass


def needs(ctx):
    return None if ctx.overlay and (ctx.spec.get('events') or ctx.timeline) else 'no overlay.mov, or neither spec events nor timeline'


def element_strings(value, ignore, key=None):
    """Every string on an element and its children, whatever the element type, except values under the ignored keys."""
    if isinstance(value, str):
        return [] if key in ignore else [value]
    if isinstance(value, dict):
        return [s for k, v in value.items() for s in element_strings(v, ignore, k)]
    if isinstance(value, list):
        return [s for v in value for s in element_strings(v, ignore, key)]
    return []


def tokens(text):
    return [w for w in re.findall(r"[a-z0-9']+", text.lower()) if w]


def narrated_words(ctx, ev, text, spoken, c):
    """How many of the element's words are spoken aloud as it lands: the same word occurs in the preview's word timings within
    narrate_window_s after the element appears (and narrate_lead_s before it)."""
    start = ctx.element_start(ev)
    if start is None or not spoken:
        return 0
    lo = (ctx.overlay_t0 or 0.0) + start - c['narrate_lead_s']
    hi = (ctx.overlay_t0 or 0.0) + start + c['narrate_window_s']
    said = [tokens(w['w'])[0] for w in spoken if lo <= w['s'] <= hi and tokens(w['w'])]
    return sum(1 for w in tokens(text) if w in said)


def stretches(covered, ofps, gap_s):
    out, start, last = [], None, None
    for i, on in enumerate(covered):
        if on:
            if start is None:
                start = i
            last = i
        elif start is not None and (i - last) / ofps > gap_s:
            out.append((start, last + 1))
            start = None
    if start is not None:
        out.append((start, last + 1))
    return out


def run(ctx):
    c = ctx.cfg['dwell']
    if not any(element_strings(ev, set(c['non_text_keys'])) for ev in ctx.spec.get('events', [])):
        return [Finding(NAME, 'INFO', 'no on-screen text anywhere in the spec: nothing to read, n/a for reading time', data={'empty_set': True})]
    a = ctx.overlay_alpha()
    ofps = ctx.overlay_fps()
    t0 = ctx.overlay_t0 or 0.0
    covered = (a > ctx.cfg['in_frame']['alpha_threshold']).mean(axis=(1, 2)) > c['min_cover_frac']
    landings = [float(e['at']) for e in (ctx.timeline or {}).get('elements', []) if 'at' in e]
    events = [(ctx.element_start(ev), ev) for ev in ctx.spec.get('events', [])]
    spoken = ctx.words_if_present()
    out = []
    prev_end = float('-inf')
    for i, j in stretches(covered, ofps, c['gap_s']):
        s, e = i / ofps, j / ofps
        last = [t for t in landings if s - c["lead_s"] <= t <= e] or [t for t, ev in events if t is not None and s - c["lead_s"] <= t <= e]
        if not last:
            continue
        hold = e - max(last)
        # an event timed by its first child can start well before its graphic is opaque: it belongs to the first graphic that ends after it
        inside = [ev for t, ev in events if t is not None and prev_end - c["lead_s"] < t <= e]
        prev_end = e
        content = [ev for ev in inside if ev['type'] not in c['non_content_types']]
        if inside and not content:
            out.append(Finding(NAME, 'INFO', f'graphic at {t0 + s:.1f}-{t0 + e:.1f}s holds only non-content elements ({", ".join(ev["type"] for ev in inside)}); n/a for reading time', t0 + s, t0 + e))
            continue
        skip_keys = set(c['non_text_keys'])
        total_words = sum(len(s.split()) for ev in content for s in element_strings(ev, skip_keys))

        def own_need(ev):
            n = sum(len(x.split()) for x in element_strings(ev, skip_keys))
            return n * c['s_per_word'] + (len(ev['rows']) if isinstance(ev.get('rows'), list) else 1) * c['s_per_item']
        # an element that has been on screen long enough to read its own words by the end of the stretch is already read; only the rest count against the final hold
        pending = [ev for ev in content if (ctx.element_start(ev) is None) or (e - ctx.element_start(ev) < own_need(ev))]
        words = sum(len(s.split()) for ev in pending for s in element_strings(ev, skip_keys))
        items = sum(len(ev['rows']) if isinstance(ev.get('rows'), list) else 1 for ev in pending)
        if not total_words and content and all(ev['type'] in c['picture_types'] for ev in content):
            out.append(Finding(NAME, 'INFO', f'graphic at {t0 + s:.1f}-{t0 + e:.1f}s is picture only ({", ".join(ev["type"] for ev in content)}, no string on it); nothing to read, n/a for reading time', t0 + s, t0 + e))
            continue
        if not total_words:
            out.append(Finding(NAME, 'WARN', f'graphic at {t0 + s:.1f}-{t0 + e:.1f}s: no on-screen text was found on its elements ({", ".join(ev["type"] for ev in content) or "no spec events resolve to it"}), '
                               'so the reading time is not measured', t0 + s, t0 + e, {'not_measured': True}))
            continue
        heard = sum(narrated_words(ctx, ev, ' '.join(element_strings(ev, set(c['non_text_keys']))), spoken, c) for ev in pending)
        heard = min(heard, words)
        need = max(c['min_hold_s'], (words - heard) * c['s_per_word'] + items * c['s_per_item'])
        if words >= c['dense_words'] or items >= c['dense_items']:
            need = max(need, c['dense_min_s'])
        status = 'FAIL' if hold + c['tolerance_s'] < need else 'INFO'
        out.append(Finding(NAME, status, f'graphic at {t0 + s:.1f}-{t0 + e:.1f}s holds {hold:.1f}s after its last element lands; reading {words} words ({heard} spoken as they land) and {items} items needs {need:.1f}s',
                           t0 + s, t0 + e, {'hold': hold, 'need': need, 'words': words, 'narrated': heard, 'items': items}))
    return out or [Finding(NAME, 'INFO', 'no graphic with a resolvable last landing was found')]
