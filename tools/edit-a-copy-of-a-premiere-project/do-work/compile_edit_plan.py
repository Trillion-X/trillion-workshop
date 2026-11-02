"""Compile an EDIT-PLAN.json (new_order) into an ops plan for premiere_insert.py.

The ops plan is plain JSON a person can read and change before it runs:
  1. insert ops for the inserted pieces, each at its timecode on the input timeline.
     They come from --inserts FILE (a JSON list of insert objects), or else from
     the EDIT-PLAN's own "inserts". A piece may be a file or a labelled black
     placeholder ({"placeholder": "...", "seconds": 14.2, "track": "V1"}).
  2. one assemble op: the new_order rows as source ranges, minus each row's
     inner_cuts, minus pause trims measured from the word timings. A row
     "INSERT-<id>" (or --insert-prefix) places insert <id>; an insert inside a source range rides along.

Pause trim: a gap between two words longer than --pause-over seconds keeps
--pause-keep seconds (half after the last word, half before the next). Pauses
in --protect rows or --protect-window ranges are kept, and so is a pause holding
an insert's "anchor" ({"clip": "A002", "src": 12.5}: where it sits in its
source), so an insert never loses its place. An insert's "resume"
({"clip": "A001", "frame": 300}: its freeze frame) sets the start of the row
after it, so the picture resumes on exactly that frame.

Word timings: DIR/<clip>.json holding {"words": [{"type": "word", "start": s, "end": s}, ...]}.

usage: python3 -I compile_edit_plan.py EDIT-PLAN.json --transcripts DIR --output OUT.prproj
         --plan-out OPS.json [--inserts INSERTS.json] [--protect ROW] [--protect-window A001:20:24]
         [--insert-prefix INSERT-] [--fps 24000/1001] [--project IN.prproj]
"""
import argparse
import json
import os

FPS = 24000 / 1001  # the sequence frame rate; --fps sets it
PREFIX = 'INSERT-'  # a new_order row id starting with this places an insert; --insert-prefix sets it


def words(transcripts, clip):
    data = json.load(open(os.path.join(transcripts, f'{clip}.json')))
    return [w for w in data['words'] if w['type'] == 'word']


def subtract(span, holes):
    """[a, b) minus a list of holes -> list of kept spans."""
    a, b = span
    out = []
    for h0, h1 in sorted(holes):
        if h1 <= a or h0 >= b:
            continue
        if h0 > a:
            out.append((a, h0))
        a = max(a, h1)
    if a < b:
        out.append((a, b))
    return [(x, y) for x, y in out if y - x >= 1 / FPS]


def pause_cuts(ws, a, b, over, keep, protected, anchors):
    cuts = []
    for w0, w1 in zip(ws, ws[1:]):
        g0, g1 = w0['end'], w1['start']
        # both words must lie inside the kept span, so no sliver of a word is left at its edge
        if g1 - g0 <= over or w0['start'] < a or w1['end'] > b:
            continue
        if any(p0 < g1 and g0 < p1 for p0, p1 in protected):
            continue
        if any(g0 <= t <= g1 for t in anchors):
            continue
        cuts.append((round(g0 + keep / 2, 3), round(g1 - keep / 2, 3)))
    return cuts


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('edit_plan')
    ap.add_argument('--transcripts', required=True)
    ap.add_argument('--output', required=True, help='the new .prproj to write')
    ap.add_argument('--plan-out', required=True)
    ap.add_argument('--inserts', help='JSON list of insert objects (overrides the EDIT-PLAN inserts)')
    ap.add_argument('--protect', action='append', default=[], help='new_order id whose pauses stay')
    ap.add_argument('--protect-window', action='append', default=[], help='CLIP:FROM:TO seconds whose pauses stay')
    ap.add_argument('--pause-over', type=float, default=0.9)
    ap.add_argument('--pause-keep', type=float, default=0.4)
    ap.add_argument('--insert-prefix', default=PREFIX, help='new_order row id prefix that places an insert')
    ap.add_argument('--fps', default='24000/1001', help='sequence frame rate, as N or N/D')
    ap.add_argument('--project', help='the input .prproj (overrides the EDIT-PLAN "project")')
    args = ap.parse_args()
    global FPS
    num, _, den = args.fps.partition('/')
    FPS = float(num) / float(den or 1)
    prefix = args.insert_prefix
    plan = json.load(open(args.edit_plan))
    rows = plan['new_order']
    inserts = json.load(open(args.inserts)) if args.inserts else plan.get('inserts', [])
    ops, notes, made, anchors = [], [], set(), {}
    for ins in sorted(inserts, key=lambda i: i['at']):  # time order, so "original" timecodes shift correctly
        ops.append({'op': 'insert', **{k: v for k, v in ins.items() if k not in ('anchor', 'resume')}})
        made.add(ins['id'])
        if 'anchor' in ins:
            anchors.setdefault(ins['anchor']['clip'], []).append(ins['anchor']['src'])
        for piece in ins['pieces']:
            if 'placeholder' in piece:
                notes.append(f'{ins["id"]}: black placeholder "{piece["placeholder"]}", {piece["seconds"]} s')
    windows = {}
    for w in args.protect_window:
        clip, a, b = w.split(':')
        windows.setdefault(clip, []).append((float(a), float(b)))

    # a row right after an insert starts on the insert's freeze frame ("resume"), so the picture continues exactly
    resume = {i['id']: i['resume'] for i in inserts if 'resume' in i}
    rows = [dict(r) for r in rows]
    for prev, r in zip(rows, rows[1:]):
        ins_id = prev['id'].split(prefix, 1)[1] if prev['id'].startswith(prefix) else None
        if ins_id in resume and r.get('clip') == resume[ins_id]['clip']:
            frame = resume[ins_id]['frame']
            if abs(frame / FPS - r['src_in']) > 0.1:
                raise SystemExit(f'{r["id"]} starts at {r["src_in"]} s but {ins_id} resumes at frame {frame}; check the plan')
            notes.append(f'{r["id"]}: start {r["src_in"]} s -> frame {frame} ({frame / FPS:.3f} s), where {ins_id} freezes')
            r['src_in'] = frame / FPS
    entries, total_trim = [], 0.0
    cache = {}
    for r in rows:
        if r['id'].startswith(prefix):
            ins_id = r['id'].split(prefix, 1)[1]
            if ins_id in made:
                entries.append({'insert': ins_id, 'label': r['id']})
            else:
                notes.append(f'{r["id"]}: left out (no insert with this id in the inserts list)')
            continue
        clip = r['clip']
        if clip not in cache:
            cache[clip] = words(args.transcripts, clip)
        holes = [(c['src_in'], c['src_out']) for c in r.get('inner_cuts', [])]
        pauses = []
        if r['id'] not in args.protect:
            for a, b in subtract((r['src_in'], r['src_out']), holes):
                pauses += pause_cuts(cache[clip], a, b, args.pause_over, args.pause_keep,
                                     windows.get(clip, []), anchors.get(clip, []))
        total_trim += sum(y - x for x, y in pauses)
        spans = subtract((r['src_in'], r['src_out']), holes + pauses)
        for n, (a, b) in enumerate(spans):
            entries.append({'clip': clip, 'src_in': round(a, 3), 'src_out': round(b, 3),
                            'label': f'{r["id"]}' + (f'.{n + 1}' if len(spans) > 1 else '')})
        r_note = f'{r["id"]}: {len(holes)} inner cuts, {len(pauses)} pause trims ({sum(y - x for x, y in pauses):.2f} s)'
        if r.get('pause_trim') is not None:
            r_note += f'; EDIT-PLAN estimated {r["pause_trim"]} s'
        notes.append(r_note)

    ops.append({'op': 'assemble', 'id': 'new_order', 'entries': entries})
    out = {
        'about': f'Compiled from {args.edit_plan} by compile_edit_plan.py. Edit this file to change the cut, '
                 'then run premiere_insert.py on it.',
        'project': args.project or plan['project'],
        'output': args.output,
        'sequence': plan.get('sequence'),
        'timecodes': 'original',
        'ops': ops,
        'notes': notes + [f'pause trims total {total_trim:.1f} s (over {args.pause_over} s kept at {args.pause_keep} s)'],
    }
    json.dump(out, open(args.plan_out, 'w'), indent=1)
    print('\n'.join(out['notes']))
    print(f'wrote {args.plan_out}: {len(ops) - 1} inserts, {len(entries)} assemble entries')


if __name__ == '__main__':
    main()
