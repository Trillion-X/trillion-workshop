"""reused-footage: an option whose footage the source cut plays more than once says so in its write-up (for example one continuous take split into two
moments without saying that the second is the footage the film opens with at 0:00).
Read from the source in and out of the source cut's timeline, never from the words: the FilmCraft cut project (the file reused_footage.project, found in a
folder above the video) names, for every clip of the sequence whose name matches sequence_name, its media, its place on the timeline and its source in
(ticks_per_second). The video's range in the cut (`edit.preview`) is mapped to media source ranges; every other stretch of the cut that plays the same
source for at least min_overlap_s is a reuse. A reuse fails unless the option's section of the pick files (reused_footage.pick_glob, relative to the lane
folder above the video's folder; the heading that ends with its id in brackets) matches the `mention` pattern and writes the time of the other play
(m:ss or NNmSS, or says the opening for 0:00). An option with no reuse is an empty set. Without a pick section yet the check is not measured, never passed."""
import glob
import json
import os
import re

from ..report import Finding

NAME = 'reused-footage'
EMPTY_SET = 'outside the full-film folders'

_CACHE = {}


def needs(ctx):
    c = ctx.cfg['reused_footage']
    if not re.search(c['scope_regex'], ctx.preview):
        return EMPTY_SET
    return None if ctx.edit.get('preview') and project_path(ctx) else 'no cut project found above the preview, or no edit.preview in the spec'


def project_path(ctx):
    c = ctx.cfg['reused_footage']
    d = os.path.dirname(os.path.abspath(ctx.preview))
    while d != os.path.dirname(d):
        p = os.path.join(d, c['project'])
        if os.path.isfile(p):
            return p
        d = os.path.dirname(d)
    return None


def cut_clips(path, c):
    """[(media name, start s, end s, source in s)] of the cut sequence's video clips."""
    if path not in _CACHE:
        with open(path, encoding='utf-8') as f:
            items = json.load(f)['project']['items']
        seq = next(v['kind']['Sequence'] for v in items.values() if 'Sequence' in v['kind'] and re.search(c['sequence_name'], v['name']))
        t = c['ticks_per_second']
        _CACHE[path] = [(cl['name'], cl['start'] / t, (cl['start'] + cl['duration']) / t, cl['source_in'] / t)
                        for tr in seq['video_tracks'] for cl in tr['items'] if cl.get('item') is not None and cl.get('speed', 1.0) == 1.0 and 'Adjustment' not in cl['name']]
    return _CACHE[path]


def pick_section(ctx, oid):
    lane = os.path.dirname(os.path.dirname(os.path.abspath(ctx.preview)))
    for path in sorted(glob.glob(os.path.join(lane, ctx.cfg['reused_footage']['pick_glob']))):
        with open(path, encoding='utf-8') as f:
            text = f.read()
        for m in re.finditer(r'^### .*\(' + re.escape(oid) + r'\)\s*$', text, re.M):
            nxt = re.search(r'^### ', text[m.end():], re.M)
            return text[m.start():m.end() + (nxt.start() if nxt else len(text))]
    return None


def names_time(section, t):
    """True when the section writes the time t (within a second) as m:ss or NNmSS, or, for the opening of the film, says so."""
    for d in (-1, 0, 1):
        m, sec = divmod(max(int(t) + d, 0), 60)
        if f'{m}:{sec:02d}' in section or f'{m:02d}m{sec:02d}' in section or f'{m}m{sec:02d}' in section:
            return True
    return t < 1.0 and re.search(r'(?i)\b(opening|opens|first seconds)\b', section) is not None


def run(ctx):
    c = ctx.cfg['reused_footage']
    clips = cut_clips(project_path(ctx), c)
    oid = os.path.splitext(os.path.basename(ctx.preview))[0]
    mine = []
    for a, b in ctx.source_spans():      # a stitched cold open plays several stretches of the cut
        for name, s, e, src in clips:
            lo, hi = max(a, s), min(b, e)
            if hi > lo:
                mine.append((name, lo, hi, src + lo - s, src + hi - s))
    reuse = []
    for name, lo, hi, slo, shi in mine:
        for n2, s2, e2, src2 in clips:
            if n2 != name:
                continue
            olo, ohi = max(slo, src2), min(shi, src2 + (e2 - s2))
            if ohi - olo >= c['min_overlap_s']:
                at = s2 + (olo - src2)
                if not (lo - 0.01 <= at and at + (ohi - olo) <= hi + 0.01):      # the same stretch of the timeline is not a reuse
                    reuse.append((name, olo, ohi, at, at + (ohi - olo)))
    reuse = [r for r in reuse if not any(m_lo - 0.01 <= r[3] and r[4] <= m_hi + 0.01 for _, m_lo, m_hi, _, _ in mine)]
    if not reuse:
        return [Finding(NAME, 'INFO', 'no stretch of this option\'s footage is played elsewhere in the cut', data={'empty_set': True})]
    section = pick_section(ctx, oid)
    where = '; '.join(f'{n} source {x0:.1f}-{x1:.1f}s also plays at {int(t0 // 60)}:{int(t0 % 60):02d}' for n, x0, x1, t0, _ in reuse[:3])
    if section is None:
        return [Finding(NAME, 'WARN', f'{where}: no section for {oid} in a pick file of the lane yet, so whether it says so is not measured', data={'not_measured': True})]
    if re.search(c['mention'], section) and any(names_time(section, r[3]) for r in reuse):
        return [Finding(NAME, 'INFO', f'{where}; the pick section says so')]
    return [Finding(NAME, 'FAIL', f'{where}, and the pick section for {oid} does not say that this is footage the cut plays again (write it in plain words, naming where else it plays)', data={'reused': [r[:3] for r in reuse]})]
