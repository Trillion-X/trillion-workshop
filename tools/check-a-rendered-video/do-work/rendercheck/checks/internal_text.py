"""internal-text: nothing on screen shows process or internal notes (for example a "label text: ..." note or "read <date>" in a caption).
Every string the spec puts on screen, on any element and any key except the non-text keys, is matched against the ban patterns of config
internal_text: process words ("label text", "listing", "excerpt"), a "read <date>" note, file names and extensions, tool and pipeline words. A source credit is
fine when it names the real publication or page; it is not when it carries a process note."""
import re

from ..report import Finding
from .dwell import element_strings

NAME = 'internal-text'

OVERLAY_ONLY = True


def needs(ctx):
    return None if ctx.spec.get('events') else 'no spec events'


def run(ctx):
    c = ctx.cfg['internal_text']
    bans = [(re.compile(p, re.I), why) for p, why in c['patterns'].items()]
    skip = set(ctx.cfg['dwell']['non_text_keys'])
    out, seen = [], 0
    for ev in ctx.spec.get('events', []):
        at = ctx.element_start(ev)
        t = at + (ctx.overlay_t0 or 0.0) if at is not None else None
        for s in element_strings(ev, skip):
            if not s.strip() or s.startswith('/') or s.lower().endswith(('.ttf', '.otf')):
                continue
            seen += 1
            for rx, why in bans:
                m = rx.search(s)
                if m:
                    out.append(Finding(NAME, 'FAIL', f'{ev["type"]} "{ev.get("id")}" shows "{" ".join(s.split())}" on screen: "{m.group(0)}" is {why}; show the real source (a screenshot of the real page with the key words highlighted) or nothing', t, data={'match': m.group(0)}))
                    break
    return out or [Finding(NAME, 'INFO', f'{seen} on-screen strings read; none is internal or process text')]
