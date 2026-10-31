#!/usr/bin/env python3
"""Assemble a plan into a cut, and the steps around it.

usage: python3 assemble.py <step> [--request <request.json>] [<slug> ...]
       (without --request the request is read from standard input; {"here": ...} paths then need "relative_to")

steps
  timeline         a plan's timeline and length, without making anything (request.plan_file)
  lay-out          the timeline and the overlay spec, with held frames and graphics placed, nothing encoded (request.plan_file)
  build            the cut of one plan: made in its work folder, moved to the seen folder once every check row passes (request.plan_file)
  run              voice-lines, then for every plan of request.plans (or the slugs named): its plan checks, then build
  voice-lines      a take of every voiced line of the plans that has none (request.plans)
  regroup          rebuild plans as groups of a lead segment and members (request.shapes)
  retitle          apply a titles list to every plan of a folder (request.titles)
  outline          each plan as a numbered outline (request.plan_files)
  string-together  made cuts in order, a text card between each two, into one reel (request.films)

The last line printed is {"result": ...} or {"error": "<what is wrong and what to change>"}.
"""
import json
import sys
import traceback
from pathlib import Path

HERE = Path(__file__).resolve().parent
WORKSHOP = str(HERE.parents[2])
sys.path[:0] = [str(HERE), str(HERE.parent / 'read-data')]

import cut  # noqa: E402
import plans  # noqa: E402
import reel  # noqa: E402
import voice  # noqa: E402
from fill import Refused, bind, merged  # noqa: E402


def plan_files(req, slugs):
    """the plans a run or voice-lines step works on: request.plans {"folder", "skip"?, "only"?}, every <slug>.json with segments,
    narrowed to the slugs named on the command line"""
    spec = req.get('plans') or {}
    if not spec.get('folder'):
        raise Refused('the request needs plans.folder, the folder of <slug>.json plans')
    folder, skip = Path(spec['folder']), set(spec.get('skip', []))
    only = set(slugs or spec.get('only') or [])
    out = []
    for f in sorted(folder.glob('*.json')):
        if f.stem in skip or (only and f.stem not in only):
            continue
        if json.loads(f.read_text()).get('segments'):
            out.append(f)
    unknown = sorted(only - {f.stem for f in out})
    if unknown:
        raise Refused(f'no plan with segments named {", ".join(unknown)} in {folder} (or it is in plans.skip)')
    return out


def plan_checks(req, plan_file, work):
    """the request's plan_checks rows on one plan before its cut: (go, results). A row passes on pass_exit_codes (default [0]); an
    exit code in advisory_exit_codes lets the cut go on with its output shown; any other result stops this plan."""
    work.mkdir(parents=True, exist_ok=True)
    results = cut.run_checks(req.get('plan_checks', []), {'plan_file': str(plan_file), 'work': str(work)}, work)
    return all(r['passed'] or r['advisory'] for r in results), results


def run(req, slugs):
    files = plan_files(req, slugs)
    voiced = voice.voice_lines(req, files) if (req.get('voice') or {}).get('say') else None
    done = []
    formats = set(req['pieces']['formats'])
    for f in files:
        plan = json.loads(f.read_text())
        fmt = (plan.get('format') or {}).get('option')
        if fmt not in formats:
            done.append({'slug': f.stem, 'status': 'format not renderable', 'format': fmt})
            continue
        go, checked = plan_checks(req, f, Path(req['folders']['work']) / f.stem / 'plan-checks')
        if not go:
            done.append({'slug': f.stem, 'status': 'plan check stopped it', 'plan_checks': checked})
            continue
        try:
            made = cut.build(req, f)
            done.append({'slug': f.stem, 'status': 'slides' if 'pdf' in made else 'built', 'plan_checks': checked, **made})
        except Refused as e:
            done.append({'slug': f.stem, 'status': 'refused', 'why': str(e), 'plan_checks': checked})
    return {'voice_lines': voiced, 'plans': done, 'all_made': all(d['status'] in ('built', 'slides', 'format not renderable') for d in done)}


def read_request(rest):
    """(request, the arguments left): --request <file> (paths relative to its folder), else standard input (relative to its
    "relative_to"); a top-level "extends" request is laid under it"""
    if '--request' in rest:
        at = rest.index('--request')
        path = Path(rest[at + 1]).absolute()
        raw, base, rest = json.loads(path.read_text()), str(path.parent), rest[:at] + rest[at + 2:]
    else:
        raw = json.loads(sys.stdin.read())
        base = raw.get('relative_to')
    under = raw.pop('extends', None)
    req = bind(raw, base, WORKSHOP)
    return (merged(bind(under, base, WORKSHOP), req) if under is not None else req), rest


def main(argv):
    if not argv:
        raise Refused(__doc__.strip())
    step, rest = argv[0], argv[1:]
    req, rest = read_request(rest)
    if step in ('timeline', 'lay-out', 'build'):
        if rest:
            if len(rest) != 1 or not (req.get('plans') or {}).get('folder'):
                raise Refused(f'{step} cuts one plan: name one slug, with plans.folder in the request')
            req['plan_file'] = str(Path(req['plans']['folder']) / f'{rest[0]}.json')
        if not req.get('plan_file'):
            raise Refused(f'{step} needs request.plan_file, the plan to cut (or one slug with plans.folder)')
        if step == 'timeline':
            return cut.timeline(req, req['plan_file'])
        return cut.build(req, req['plan_file'], make=step == 'build')
    if step == 'run':
        return run(req, rest)
    if step == 'voice-lines':
        return voice.voice_lines(req, plan_files(req, rest))
    if step == 'regroup':
        return plans.regroup(req)
    if step == 'retitle':
        return plans.retitle(req)
    if step == 'outline':
        return plans.outline(req)
    if step == 'string-together':
        return reel.string_together(req)
    raise Refused(f'unknown step {step}; the steps are timeline, lay-out, build, run, voice-lines, regroup, retitle, outline, string-together')


if __name__ == '__main__':
    try:
        print(json.dumps({'result': main(sys.argv[1:])}))
    except Refused as e:
        print(json.dumps({'error': str(e)}))
        sys.exit(1)
    except (KeyError, ValueError, OSError) as e:
        print(json.dumps({'error': f'{type(e).__name__}: {e}', 'where': traceback.format_exc().strip().splitlines()[-3:]}))
        sys.exit(1)
