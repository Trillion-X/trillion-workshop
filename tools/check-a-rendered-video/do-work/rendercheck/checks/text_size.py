"""text-size: on-screen text is large enough to read on a phone.
The spec's font sizes (config text_size.size_keys, scalar values, outside the ignored sub-objects) are turned into a cap height at the 1080-line frame
(cap_height_ratio x px) and every text element's smallest size must reach min_cap_px, the cap height that is about 1.6 percent of the frame height: 2 mm on a 7 cm
tall phone picture. A long list is shown in parts or zoomed, not shrunk. A spec may declare `small_text_purpose` per element id."""
from ..report import Finding

NAME = 'text-size'

OVERLAY_ONLY = True


def needs(ctx):
    return None if ctx.spec.get('events') else 'no spec events'


def sizes(value, keys, skip, key=None):
    """[(key, px)] of every scalar size under a size key; a list under a key (a box size) and the skipped sub-objects are not font sizes."""
    if isinstance(value, dict):
        return [x for k, v in value.items() if k not in skip for x in sizes(v, keys, skip, k)]
    if isinstance(value, list):
        return [x for v in value if isinstance(v, (dict, list)) for x in sizes(v, keys, skip, key)]
    if isinstance(value, (int, float)) and not isinstance(value, bool) and key in keys:
        return [(key, float(value))]
    return []


def run(ctx):
    c = ctx.cfg['text_size']
    purposes = (ctx.spec or {}).get(c['purpose_key'], {}) or {}
    out, measured = [], 0
    for ev in ctx.spec.get('events', []):
        found = sizes(ev, set(c['size_keys']), set(c['skip_keys']))
        if not found:
            continue
        measured += 1
        key, px = min(found, key=lambda kv: kv[1])
        cap = px * c['cap_height_ratio']
        if cap + 1e-9 < c['min_cap_px']:
            at = ctx.element_start(ev)
            why = str(purposes.get(ev.get('id'), '')).strip()
            level = 'INFO' if len(why) >= c['min_purpose_chars'] else 'FAIL'
            out.append(Finding(NAME, level, f'{ev["type"]} "{ev.get("id")}" sets {key} {px:g} px: cap height {cap:.0f} px, under {c["min_cap_px"]} px for a phone screen; make it larger, or show the list in parts or zoomed'
                               + (f'; declared: {why}' if level == 'INFO' else ''), at + (ctx.overlay_t0 or 0.0) if at is not None else None, data={'key': key, 'px': px, 'cap_px': cap}))
    return out or [Finding(NAME, 'INFO', f'{measured} text elements measured; all reach a {c["min_cap_px"]} px cap height')]
