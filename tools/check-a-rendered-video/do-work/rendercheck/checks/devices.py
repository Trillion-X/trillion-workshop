"""devices: no device repeats as a pattern (for example the same pause symbol in moment after moment). The side of the screen is the placement
check's (film-wide side balance).
Over the variety ledger (the same scope as the variety check), for every built option the device tokens its spec uses (the spec found by devices.spec_glob,
relative to the folder holding the ledger's folder, with {lane} and {option} filled in; the last match wins):
  - a device token is `type:<event type>` for an event type that is not in neutral_types (entrance and narrator devices are event types: a pause, a cut-out,
    a tear), and `enter:`, `in_dir:`, `intro:`, `exit:`, `out_dir:` plus the declared value when the event declares one;
  - this option fails when one of its tokens is used in more than max_moments_per_device moments of the film, or when a declared entrance or exit token is the
    same in the moment before or after (the options of one moment are alternatives and count once);
Videos outside devices.scope_regex pass as an empty set."""
import glob
import os
import re

from .. import jsonio
from ..report import Finding
from .variety import find_full_film, ledger_rows, seconds

NAME = 'devices'
EMPTY_SET = 'outside the full-film ledger'

DECLARED = ('enter', 'in_dir', 'intro', 'exit', 'out_dir')


def needs(ctx):
    c = ctx.cfg['devices']
    if not re.search(c['scope_regex'], ctx.preview):
        return EMPTY_SET
    return None if find_full_film(ctx.preview, ctx.cfg['variety']) else f'no {ctx.cfg["variety"]["ledger"]} above the video'


def tokens(spec, neutral):
    out, declared = set(), set()
    for ev in spec.get('events', []):
        if ev.get('type') not in neutral:
            out.add(f'type:{ev.get("type")}')
        for k in DECLARED:
            if isinstance(ev.get(k), str):
                out.add(f'{k}:{ev[k]}')
                declared.add(f'{k}:{ev[k]}')
    return out, declared


def collect(base, rows, neutral, spec_glob):
    """{option id: {moment, tokens, declared}} for every built option with a spec."""
    out = {}
    for oid, r in rows.items():
        if r['kind'] != 'built':
            continue
        specs = sorted(glob.glob(os.path.join(base, spec_glob.format(lane=r['lane'], option=oid))))
        if not specs:
            continue
        toks, decl = tokens(jsonio.read(specs[-1]), neutral)
        out[oid] = {'moment': seconds(r['moment_time']), 'tokens': toks, 'declared': decl}
    return out


def run(ctx):
    c = ctx.cfg['devices']
    ledger_path, _ = find_full_film(ctx.preview, ctx.cfg['variety'])
    rows = ledger_rows(ledger_path)
    oid = os.path.splitext(os.path.basename(ctx.preview))[0]
    info = collect(os.path.dirname(os.path.dirname(ledger_path)), rows, set(c['neutral_types']), c['spec_glob'])
    me = info.get(oid)
    if not me:
        return [Finding(NAME, 'INFO', f'"{oid}" is not a built option of the ledger with a spec: nothing to compare')]
    moments = {}
    for o in info.values():
        for t in o['tokens']:
            moments.setdefault(t, set()).add(o['moment'])
    times = sorted({o['moment'] for o in info.values()})
    out = []
    for t in sorted(me['tokens']):
        n = len(moments[t] | {me['moment']})
        if n > c['max_moments_per_device']:
            out.append(Finding(NAME, 'FAIL', f'device "{t}" is used in {n} moments of the film (limit {c["max_moments_per_device"]}); choose a different entrance, exit or narrator device for this moment', data={'device': t, 'moments': n}))
    k = times.index(me['moment'])
    for nb in times[max(k - 1, 0):k] + times[k + 1:k + 2]:
        for o in (x for x in info.values() if x['moment'] == nb):
            for t in sorted(me['declared'] & o['declared']):
                out.append(Finding(NAME, 'FAIL', f'declared device "{t}" is also used in the adjacent moment {int(nb // 60)}:{int(nb % 60):02d}; vary it'))
    return out or [Finding(NAME, 'INFO', f'devices within limits ({len(info)} built options compared)')]
