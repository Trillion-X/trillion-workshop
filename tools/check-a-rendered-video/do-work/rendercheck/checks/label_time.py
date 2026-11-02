"""label-time: the m:ss in an option's labels names a moment inside the stretch of the source footage the video plays (for example an option labelled
"18:04" whose video plays 18:15 to 18:32). Every label of the option must fall inside `edit.preview` [start, end], the video's range in the source, give or
take tolerance_s; the lead-in before the moment is fine:
  - the variety ledger row's moment_time (variety.ledger);
  - the heading of its section in the pick files (label_time.pick_glob, relative to the lane folder: the folder above the video's folder),
    written `### NN m:ss title (id)`;
  - the name of every watch file that is the same file as the video (matched by inode in the folders of label_time.watch_globs: `lane` patterns
    relative to the lane folder, `film` patterns relative to the folder holding the ledger's folder), written `NN m:ss title` or `NNmSS title`.
An option with no label anywhere is not measured, never passed."""
import glob
import json
import os
import re

from ..report import Finding
from .variety import find_full_film, seconds

NAME = 'label-time'
EMPTY_SET = 'outside the full-film folders'


def needs(ctx):
    c = ctx.cfg['label_time']
    if not re.search(c['scope_regex'], ctx.preview):
        return EMPTY_SET
    return None if ctx.edit.get('preview') else 'no edit.preview in the spec'


def parse(text):
    """Seconds of the first m:ss or NNmSS time in text, or None."""
    m = re.search(r'(?<!\d)(\d{1,2}):(\d{2})(?!\d)', text) or re.search(r'(?<![\d.])(\d{1,2})m(\d{2})(?!\d)', text)
    return int(m.group(1)) * 60 + int(m.group(2)) if m else None


def labels(ctx, oid):
    out = []
    found = find_full_film(ctx.preview, ctx.cfg['variety'])
    if found:
        with open(found[0], encoding='utf-8') as f:
            rows = {r['option_id']: r for r in (json.loads(x) for x in f if x.strip())}
        if oid in rows:
            out.append(('ledger moment_time', seconds(rows[oid]['moment_time'])))
    lane = os.path.dirname(os.path.dirname(os.path.abspath(ctx.preview)))
    for path in sorted(glob.glob(os.path.join(lane, ctx.cfg['label_time']['pick_glob']))):
        with open(path, encoding='utf-8') as f:
            for m in re.finditer(r'^### (.*)\(' + re.escape(oid) + r'\)\s*$', f.read(), re.M):
                t = parse(m.group(1))
                if t is not None:
                    out.append((f'{os.path.basename(path)} heading', t))
    ino = os.stat(ctx.preview).st_ino
    film = os.path.dirname(os.path.dirname(found[0])) if found else lane
    watch = ctx.cfg['label_time']['watch_globs']
    for pat in [os.path.join(lane, g) for g in watch.get('lane', [])] + [os.path.join(film, g) for g in watch.get('film', [])]:
        for folder in glob.glob(pat):
            for f in glob.glob(os.path.join(folder, '*.mp4')):
                if os.stat(f).st_ino == ino:
                    t = parse(os.path.basename(f))
                    if t is not None:
                        out.append((f'watch file {os.path.relpath(f, film)}', t))
    return out


def run(ctx):
    c = ctx.cfg['label_time']
    oid = os.path.splitext(os.path.basename(ctx.preview))[0]
    spans = ctx.source_spans()      # the stretches of the source the video plays: one range, or with a stitched cold open each piece and the rest after it
    start = float(min(lo for lo, _ in spans))
    found = labels(ctx, oid)
    if not found:
        return [Finding(NAME, 'WARN', f'{oid} has no time label (ledger row, pick heading or watch file name) yet, so it is not measured', data={'not_measured': True})]
    end = float(max(hi for _, hi in spans))
    clock = lambda x: f'{int(x // 60)}:{x % 60:04.1f}'
    plays = ' and '.join(f'{clock(lo)} to {clock(hi)}' for lo, hi in spans)
    out = []
    for src, t in found:
        if not any(lo - c['tolerance_s'] <= t <= hi + c['tolerance_s'] for lo, hi in spans):
            out.append(Finding(NAME, 'FAIL', f'{src} says {int(t // 60)}:{int(t % 60):02d} but the video plays {plays} of the source: the label names a time outside it; label the option with a moment it plays',
                               data={'label_s': t, 'start_s': start, 'end_s': end}))
    return out or [Finding(NAME, 'INFO', f'{len(found)} labels, each inside the range {plays}')]
