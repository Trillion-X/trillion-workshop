#!/usr/bin/env python3
"""Check a folder of cut plans before anything is rendered: what the plan itself gets wrong, then every recorded span of it heard.

usage: check_plan_cuts.py --plans DIR --report FILE --words-folder DIR [--settings FILE] [--reader JSON | --model M] [<slug> ...]
       check_plan_cuts.py --plan-file PLAN.json --report FILE ...      (one plan; the others in its folder are what it may point at)

A plan is {slug, segments: [{kind, clip, from, to, text, ...}], sources?} (tool:assemble-a-plan-into-a-cut's plan). Each segment
with a clip is cut from its source (the cutter's own lookup, assemble-a-plan-into-a-cut/read-data/spans.py, so the check cuts what the
render cuts), read by the reader, and its first and last `end_words` words compared with the plan's text: a cut that starts or ends
in the wrong place, catching a neighbouring word or losing one, shows as a mismatch at that end.

Plan problems, each run only when the person's settings file names its keys:
  question_key, questions_file, question_id_pattern, refused_evidence
        a segment's question_key names a question of the person's question library (questions_file, relative to the settings file:
        {"questions": [{id, evidence}]},
        the id found by question_id_pattern); a name that matches no question fails, and so does a question whose evidence is one
        of refused_evidence (a question nobody asked must not be voiced as if someone had).
  card_kind, next_prefix, slug_key, title_keys
        a card_kind segment whose text starts with next_prefix points at another plan: by its slug_key field, which must name a plan
        in the folder, else by its words, which should equal a plan's title (any of title_keys); words matching no title are a note.
  gate_fields
        plan fields printed beside each plan ("not checked" when absent), such as the person's own sign-off fields.
  end_words
        how many words at each end are compared (default 3).

The report (a JSON list) holds one row per plan ({plan, gate fields, failures, notes}) and one per span ({plan, segment, clip, from,
to, start_ok, end_ok, heard_start, heard_end}). Exit 1 when a plan fails, 2 when only span ends are to check (a person listens),
0 when all is clean. The last line is {"result": {...}}.
"""
import argparse
import json
import re
import sys
import tempfile
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path[:0] = [str(HERE), str(HERE.parents[1] / 'assemble-a-plan-into-a-cut' / 'read-data')]

import spans  # noqa: E402   the cutter's span lookup: tool:assemble-a-plan-into-a-cut, packed by this row
from speech_reading import add_reader_options, cut_audio, reader_of, words  # noqa: E402


def question_evidence(settings):
    """question id -> its evidence, from the person's question library; None when the settings name no library"""
    if not settings.get('questions_file'):
        return None
    return {q['id']: q['evidence'] for q in json.loads(Path(settings['questions_file']).read_text())['questions']}


def plan_problems(plan, plans, evidence, settings):
    """(failures, notes) of a plan before any audio is heard"""
    fails, notes = [], []
    key = settings.get('question_key')
    if key and evidence is not None:
        pattern, refused = settings.get('question_id_pattern', r'.+'), set(settings.get('refused_evidence', []))
        for n, seg in enumerate(plan['segments']):
            named = seg.get(key)
            if not named:
                continue
            found = re.match(pattern, named)
            known = evidence.get(found.group(0)) if found else None
            if known is None:
                fails.append(f'segment {n} {key} {named!r} names no question in the library')
            elif known in refused:
                fails.append(f'segment {n} is drawn from {found.group(0)}, whose evidence is {known}, and is presented as asked')
    prefix = settings.get('next_prefix')
    if prefix and settings.get('card_kind'):
        slug_key = settings.get('slug_key', 'slug')
        titles = {p.get(k) for p in plans.values() for k in settings.get('title_keys', ['title'])} - {None}
        for n, seg in enumerate(plan['segments']):
            if seg.get('kind') != settings['card_kind'] or not seg.get('text', '').startswith(prefix):
                continue
            target = seg.get(slug_key)
            if target:
                if target not in plans:
                    fails.append(f'segment {n} card names plan {target!r}, which is not in the plans folder')
            elif seg['text'][len(prefix):].strip() not in titles:
                notes.append(f'segment {n} card names no plan {slug_key} and matches no plan title: not checked')
    return fails, notes


def span_row(plan, n, seg, heard, end_words):
    want, got = words(seg['text']), words(heard)
    return {'plan': plan['slug'], 'segment': n, 'clip': seg['clip'], 'from': seg['from'], 'to': seg['to'],
            'start_ok': want[:end_words] == got[:end_words], 'end_ok': want[-end_words:] == got[-end_words:],
            'heard_start': ' '.join(got[:2 * end_words]), 'heard_end': ' '.join(got[-2 * end_words:])}


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__.split('\n')[0])
    ap.add_argument('--plans', help='the folder of <slug>.json plans')
    ap.add_argument('--plan-file', help='one plan: its folder is --plans and only it is checked')
    ap.add_argument('--report', required=True, help='where the JSON report goes')
    ap.add_argument('--words-folder', help='the folder of <clip>.words.json, {source, words}: where a clip with no plan source is found')
    ap.add_argument('--settings', help='the person\'s settings file for the plan problems (see the top of this file)')
    add_reader_options(ap)
    ap.add_argument('slugs', nargs='*')
    a = ap.parse_args(argv)
    if a.plan_file:
        folder, only = Path(a.plan_file).resolve().parent, {Path(a.plan_file).stem}
    elif a.plans:
        folder, only = Path(a.plans), set(a.slugs)
    else:
        raise SystemExit('give --plans DIR or --plan-file PLAN.json')
    settings = json.loads(Path(a.settings).read_text()) if a.settings else {}
    if settings.get('questions_file'):   # a relative path is read from the settings file's folder
        settings['questions_file'] = str(Path(a.settings).resolve().parent / settings['questions_file'])
    end_words = int(settings.get('end_words', 3))
    plans = {p.stem: json.loads(p.read_text()) for p in sorted(folder.glob('*.json'))}
    unknown = sorted(only - set(plans))
    if unknown:
        raise SystemExit(f'no plan {", ".join(unknown)} in {folder}')
    chosen = [k for k in sorted(plans) if not only or k in only]
    evidence = question_evidence(settings)
    report, plan_fails = [], 0
    for slug in chosen:
        fails, notes = plan_problems(plans[slug], plans, evidence, settings)
        plan_fails += len(fails)
        gate = {f: plans[slug].get(f, 'not checked') for f in settings.get('gate_fields', [])}
        print(slug, *(f'{k}={v}' for k, v in gate.items()))
        for m in fails:
            print(f'  FAIL {m}')
        for m in notes:
            print(f'  note {m}')
        report.append({'plan': slug, **gate, 'failures': fails, 'notes': notes})
    read = None
    with tempfile.TemporaryDirectory() as tmp:
        for slug in chosen:
            plan = plans[slug]
            for n, seg in enumerate(plan['segments']):
                if not seg.get('clip'):
                    continue
                read = read or reader_of(a)
                try:
                    source = spans.source_for(seg['clip'], plan, a.words_folder)
                except LookupError:
                    raise SystemExit(f'{slug} segment {n} cuts clip {seg["clip"]}: the plan has no source for it, so give --words-folder')
                wav = Path(tmp) / f'{slug}-{n}.wav'
                cut_audio(source, seg['from'], seg['to'], wav)
                row = span_row(plan, n, seg, read(wav), end_words)
                report.append(row)
                print(f"{slug}#{n} {seg['clip']} {seg['from']}-{seg['to']} start={'ok' if row['start_ok'] else 'CHECK'} "
                      f"end={'ok' if row['end_ok'] else 'CHECK'} | {row['heard_start']} ... {row['heard_end']}", flush=True)
    Path(a.report).write_text(json.dumps(report, indent=1))
    segments = [r for r in report if 'segment' in r]
    bad = [r for r in segments if not (r['start_ok'] and r['end_ok'])]
    print(f'{len(segments)} segments, {len(segments) - len(bad)} matched at both ends, {len(bad)} to check, {plan_fails} plan failures')
    print(json.dumps({'result': {'report': str(a.report), 'plans': len(chosen), 'plan_failures': plan_fails, 'segments': len(segments),
                                 'to_check': [f"{r['plan']}#{r['segment']}" for r in bad]}}))
    return 1 if plan_fails else 2 if bad else 0


if __name__ == '__main__':
    sys.exit(main())
