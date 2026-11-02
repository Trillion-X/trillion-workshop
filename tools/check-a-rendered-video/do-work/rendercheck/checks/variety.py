"""variety: the film must not repeat one pattern from moment to moment. Machine-answered from the person's variety ledger (the file the limits'
variety.ledger names, found in a folder above the video: one JSON row per option: lane, option_id, moment_time, technique_ids[] with the main technique
first, kind; the newest row for an option wins) and the technique map (variety.map: technique id -> the spec event types that render it, and whether it
belongs to the `chapter1` reference set). A film made as several options per moment, each option a video with a spec. For a video whose path matches
variety.scope_regex it fails when:
  - the option has no ledger row, or declares a technique id that is not in the map;
  - its spec renders a technique it did not declare (an event type of the spec maps to a technique missing from technique_ids) or an event
    type that is in no technique's row (the technique is added to the map when its event type is added);
  - one of its techniques is used in more than max_moments_per_technique moments of the ledger (a moment is a distinct moment_time; the
    options of a moment are alternatives and count once);
  - its main technique is the main technique of any option in the moment before or after;
  - its moment is a reference-set moment and those are over chapter1_max_share of all moments (judged once the ledger has
    min_moments_for_share moments). A moment is a reference-set moment when any of its options declares a technique marked chapter1.
Videos outside the scope pass as an empty set: the ledger does not cover them.
The commands `variety`, `declare` and `map-add` judge the whole ledger, append a ledger row and add a technique (under the ledger's lock file)."""
import json
import os
import re

from .. import jsonio
from ..report import Finding

NAME = 'variety'
EMPTY_SET = 'outside the full-film ledger'


def seconds(v):
    if isinstance(v, (int, float)):
        return float(v)
    parts = [float(p) for p in str(v).strip().split(':')]
    out = 0.0
    for p in parts:
        out = out * 60 + p
    return out


def ledger_rows(path):
    """Newest row per option_id, in file order of last appearance."""
    rows = {}
    with open(path) as f:
        for line in f:
            line = line.strip()
            if line:
                r = json.loads(line)
                rows[r['option_id']] = r
    return rows


def find_full_film(preview, rel):
    d = os.path.dirname(os.path.abspath(preview))
    while d != os.path.dirname(d):
        if os.path.isfile(os.path.join(d, rel['ledger'])):
            return os.path.join(d, rel['ledger']), os.path.join(d, rel['map'])
        d = os.path.dirname(d)
    return None


def load_map(path):
    tmap = jsonio.read(path)
    by_type, problems = {}, []
    for tid, row in tmap['techniques'].items():
        for t in row.get('event_types', []):
            if t in by_type:
                problems.append(f'event type "{t}" is claimed by both "{by_type[t]}" and "{tid}"')
            by_type[t] = tid
    return tmap, by_type, problems


def moments(rows):
    out = {}
    for r in rows.values():
        out.setdefault(seconds(r['moment_time']), []).append(r)
    return out


def evaluate(rows, tmap, cfg):
    """Ledger-wide facts: {technique: moment times}, adjacent main-technique clashes, chapter-1 share. Pure, so the whole film can be reported without a preview."""
    ms = moments(rows)
    times = sorted(ms)
    used, clashes = {}, []
    for t in times:
        for r in ms[t]:
            for tid in r['technique_ids']:
                used.setdefault(tid, set()).add(t)
    for a, b in zip(times, times[1:]):
        for ra in ms[a]:
            for rb in ms[b]:
                if ra['technique_ids'] and rb['technique_ids'] and ra['technique_ids'][0] == rb['technique_ids'][0]:
                    clashes.append((ra['option_id'], rb['option_id'], ra['technique_ids'][0]))
    ch1 = {tid for tid, row in tmap['techniques'].items() if row.get('chapter1')}
    ch1_moments = [t for t in times if any(set(r['technique_ids']) & ch1 for r in ms[t])]
    share = len(ch1_moments) / len(times) if times else 0.0
    return {'moments': times, 'used': used, 'clashes': clashes, 'chapter1_moments': ch1_moments, 'chapter1_share': share, 'chapter1_ids': ch1}


def needs(ctx):
    c = ctx.cfg['variety']
    if not re.search(c['scope_regex'], ctx.preview):
        return EMPTY_SET
    if not find_full_film(ctx.preview, c):
        return f'no {c["ledger"]} above the video (variety is not measured)'
    return None


def run(ctx):
    c = ctx.cfg['variety']
    ledger_path, map_path = find_full_film(ctx.preview, c)
    rows = ledger_rows(ledger_path)
    tmap, by_type, problems = load_map(map_path)
    oid = os.path.splitext(os.path.basename(ctx.preview))[0]
    out = [Finding(NAME, 'FAIL', p) for p in problems]
    row = rows.get(oid)
    if not row:
        return out + [Finding(NAME, 'FAIL', f'"{oid}" has no row in {os.path.basename(ledger_path)}: declare its technique ids there before it is built (a lane cannot ship an undeclared option)')]
    declared = row['technique_ids']
    unknown = [t for t in declared if t not in tmap['techniques']]
    if unknown:
        out.append(Finding(NAME, 'FAIL', f'declares technique id(s) {unknown} that are not in technique-map.json; add a row for each new technique (its event types and chapter1 flag)'))
    neutral = set(tmap.get('neutral_event_types', []))
    types = {e.get('type') for e in ctx.spec.get('events', [])} - neutral
    unmapped = sorted(t for t in types if t not in by_type)
    if unmapped:
        out.append(Finding(NAME, 'FAIL', f'the spec renders event type(s) {unmapped} that no technique in technique-map.json lists; add them to their technique so what is rendered can be compared with what is declared'))
    rendered = {by_type[t] for t in types if t in by_type}
    under = sorted(rendered - set(declared))
    if under:
        out.append(Finding(NAME, 'FAIL', f'under-declared: the spec renders {under} but the ledger row declares {declared}'))
    over = sorted(set(declared) - rendered - {t for t in declared if not tmap['techniques'].get(t, {}).get('event_types')})
    if over:
        out.append(Finding(NAME, 'INFO', f'declared but not rendered by any spec event (an event-less technique is not compared): {over}'))
    ev = evaluate(rows, tmap, c)
    for tid in declared:
        n = len(ev['used'].get(tid, ()))
        if n > c['max_moments_per_technique']:
            out.append(Finding(NAME, 'FAIL', f'technique "{tid}" is used in {n} moments of the film (limit {c["max_moments_per_technique"]})'))
    for a, b, tid in ev['clashes']:
        if oid in (a, b):
            out.append(Finding(NAME, 'FAIL', f'adjacent moments share the main technique "{tid}": {a} and {b}'))
    t = seconds(row['moment_time'])
    if len(ev['moments']) >= c['min_moments_for_share'] and ev['chapter1_share'] > c['chapter1_max_share'] and t in ev['chapter1_moments'] and set(declared) & ev['chapter1_ids']:
        out.append(Finding(NAME, 'FAIL', f'chapter-1 techniques appear in {len(ev["chapter1_moments"])} of {len(ev["moments"])} moments ({ev["chapter1_share"]:.0%}, limit {c["chapter1_max_share"]:.0%}); this option declares {sorted(set(declared) & ev["chapter1_ids"])}'))
    return out or [Finding(NAME, 'INFO', f'declared {declared} match what the spec renders; within the film limits ({len(ev["moments"])} moments in the ledger)')]


def report(full_film_dir, cfg):
    """check-a-rendered-video variety <ledger folder>: the whole ledger judged at once, with no preview, for the final check once every lane has declared its options. Exit 1 on any breach."""
    c = cfg['variety']
    rows = ledger_rows(os.path.join(full_film_dir, c['ledger'].split('/')[-1]))
    tmap, _, problems = load_map(os.path.join(full_film_dir, c['map'].split('/')[-1]))
    ev = evaluate(rows, tmap, c)
    bad = list(problems)
    print(f'{len(rows)} options in {len(ev["moments"])} moments')
    for tid, ts in sorted(ev['used'].items(), key=lambda kv: -len(kv[1])):
        over = len(ts) > c['max_moments_per_technique']
        print(f'  {"FAIL" if over else "ok  "} {tid}: {len(ts)} moments')
        if over:
            bad.append(tid)
    for a, b, tid in ev['clashes']:
        print(f'  FAIL adjacent moments share main technique "{tid}": {a}, {b}')
        bad.append(tid)
    share_bad = len(ev['moments']) >= c['min_moments_for_share'] and ev['chapter1_share'] > c['chapter1_max_share']
    print(f'  {"FAIL" if share_bad else "ok  "} chapter-1 techniques in {len(ev["chapter1_moments"])} of {len(ev["moments"])} moments ({ev["chapter1_share"]:.0%}, limit {c["chapter1_max_share"]:.0%})')
    bad += ['chapter1'] if share_bad else []
    for p in problems:
        print(f'  FAIL {p}')
    return 1 if bad else 0


def declare(full_film_dir, lane, option_id, moment_time, technique_ids, kind):
    """check-a-rendered-video declare: append one ledger row under the ledger lock, refusing technique ids that are not in the map (so a typo is caught before the build)."""
    import fcntl
    tmap, _, _ = load_map(os.path.join(full_film_dir, 'technique-map.json'))
    unknown = [t for t in technique_ids if t not in tmap['techniques']]
    if unknown:
        raise ValueError(f'technique id(s) {unknown} are not in technique-map.json; add a row for a new technique first')
    seconds(moment_time)
    row = {'lane': lane, 'option_id': option_id, 'moment_time': moment_time, 'technique_ids': technique_ids, 'kind': kind}
    with open(os.path.join(full_film_dir, '.ledger.lock'), 'a') as lock:
        _ledger_flock(lock, fcntl)
        with open(os.path.join(full_film_dir, 'technique-ledger.jsonl'), 'a') as f:
            f.write(json.dumps(row) + '\n')
    return row


def _ledger_flock(lock, fcntl):
    """Take the ledger lock unless a parent already holds it: a wrapper that already holds it exports FILM_LEDGER_LOCK_HELD with the
    lock's real path, and taking it again under that parent would wait forever."""
    held = os.environ.get('FILM_LEDGER_LOCK_HELD')
    if held and os.path.realpath(held) == os.path.realpath(lock.name):
        return
    fcntl.flock(lock, fcntl.LOCK_EX)


def map_add(full_film_dir, technique_id, event_types, chapter1):
    """check-a-rendered-video map-add: append one technique row to technique-map.json under the ledger lock. Refuses an id that exists and an event type already
    mapped to another technique, so no lane can move a chapter-1 event type into a new technique to dodge the limits."""
    import fcntl
    path = os.path.join(full_film_dir, 'technique-map.json')
    with open(os.path.join(full_film_dir, '.ledger.lock'), 'a') as lock:
        _ledger_flock(lock, fcntl)
        tmap, by_type, _ = load_map(path)
        if technique_id in tmap['techniques']:
            raise ValueError(f'technique id "{technique_id}" already exists; ids are never redefined')
        taken = {t: by_type[t] for t in event_types if t in by_type}
        if taken:
            raise ValueError(f'event type(s) already mapped to another technique: {taken}')
        if len(set(event_types)) != len(event_types):
            raise ValueError('an event type is listed twice')
        tmap['techniques'][technique_id] = {'event_types': event_types, 'chapter1': chapter1}
        tmp = path + '.tmp'
        jsonio.write(tmp, tmap, indent=1)
        os.replace(tmp, path)
    return tmap['techniques'][technique_id]
