"""check-a-rendered-video check <video.mp4> [--spec <spec.json>] | check-a-rendered-video batch <videos-dir> [--specs <specs-dir>]

Checks a rendered video's frames, joins and audio and prints PASS / WARN / FAIL per check with the times."""
import argparse
import glob
import importlib
import json
import os
import sys

from . import config as config_mod
from . import jsonio, pins
from .ctx import Context
from .report import CHECK_ORDER, Finding, render, verdict


MODULES = {name: entry[0] for name, entry in pins.CHECK_SECTIONS.items()}      # one owner: pins.py lists every check, its module and what it reads


def _checks(selected):
    return {name: importlib.import_module(f'rendercheck.checks.{MODULES[name]}') for name in CHECK_ORDER if name in selected}


def _without_limits(name, cfg):
    """The limit sections a check reads that the person's file does not hold, or []."""
    return sorted(s for s in set(pins.SHARED_SECTIONS) | set(pins.CHECK_SECTIONS[name][1]) if s not in cfg)


def check_one(video, spec_path, args, cfg, selected, spec_required=False):
    if spec_required and not (spec_path and os.path.exists(spec_path)):
        # a video whose spec is missing is reported, never crashed on and never passed
        return None, {}, {name: 'no spec, not measured' for name in _checks(selected)}
    spec = jsonio.read(spec_path) if spec_path else {}
    ctx = Context(video, spec, cfg, overlay=args.overlay, timeline=args.timeline, words=args.words,
                  source_words=args.source_words, recipe=args.recipe, cache_dir=args.cache_dir)
    results, skipped = {}, {}
    for name, mod in _checks(selected).items():
        absent = _without_limits(name, cfg)
        if absent:
            skipped[name] = f'no limits for {", ".join(absent)}: this check runs only on limits the person gives'
            continue
        try:
            reason = mod.needs(ctx)
            if reason:
                if ctx.plain and getattr(mod, 'OVERLAY_ONLY', False):
                    results[name] = [Finding(mod.NAME, 'INFO', f'no overlay (a plain video, nothing laid over it): {reason}', data={'empty_set': True})]
                elif reason.startswith(getattr(mod, 'EMPTY_SET', '\0')):
                    results[name] = [Finding(mod.NAME, 'INFO', reason, data={'empty_set': True})]
                else:
                    skipped[name] = reason
                continue
            results[name] = mod.run(ctx)
        except KeyError as exc:
            skipped[name] = f'a key this check reads is missing from the limits or the spec: {exc.args[0]!r}'
    return ctx, results, skipped

def _spec_for(video, specs_dir):
    sid = os.path.splitext(os.path.basename(video))[0]
    p = os.path.join(specs_dir, sid + '.json') if specs_dir else None
    return p if p and os.path.exists(p) else None


def main(argv=None):
    ap = argparse.ArgumentParser(prog='check-a-rendered-video', description=__doc__)
    sub = ap.add_subparsers(dest='cmd', required=True)
    for name in ('check', 'batch'):
        p = sub.add_parser(name)
        p.add_argument('target', help='video .mp4' if name == 'check' else 'folder of video .mp4 files')
        p.add_argument('--spec' if name == 'check' else '--specs', dest='spec', help='spec .json' if name == 'check' else 'folder of <id>.json specs')
        p.add_argument('--limits', required=True, help='the person\'s limits file (JSON): which checks run and the numbers and word lists they use')
        p.add_argument('--only', help='comma list of checks: ' + ','.join(CHECK_ORDER))
        p.add_argument('--overlay', help='overlay .mov with alpha (default: the spec\'s overlay_file, else out*/<id>/overlay.mov beside the videos folder)')
        p.add_argument('--timeline', help='timeline.json of the overlay')
        p.add_argument('--words', help='word timings json of the video (skips transcription)')
        p.add_argument('--source-words', dest='source_words', help='word timings json of the footage the video was cut from')
        p.add_argument('--recipe', help='recipe.json (jitter amplitude: motion.jitter_px)')
        p.add_argument('--cache-dir', dest='cache_dir', help='where transcriptions are kept between runs (default: a folder under the system temp folder)')
        p.add_argument('--json', dest='json_out', help='write findings as json')
        if name == 'batch':
            p.add_argument('--ids', help='comma list of video ids (file names without .mp4): measure only these')
    args = ap.parse_args(argv)
    cfg = config_mod.load(args.limits)
    selected = set(args.only.split(',')) if args.only else set(CHECK_ORDER)
    videos = [args.target] if args.cmd == 'check' else sorted(glob.glob(os.path.join(args.target, '*.mp4')))
    if args.cmd == 'batch' and args.ids:
        wanted = set(args.ids.split(','))
        videos = [p for p in videos if os.path.splitext(os.path.basename(p))[0] in wanted]
    if not videos:
        print('no videos found', file=sys.stderr)
        return 2
    any_fail, dump, summary, answer = False, {}, [], []
    dump['_run'] = {'limits_blake3': config_mod.fingerprint(cfg), 'check_pins': pins.check_pins(cfg)}
    for pv in videos:
        spec = args.spec if args.cmd == 'check' else _spec_for(pv, args.spec)
        ctx, results, skipped = check_one(pv, spec, args, cfg, selected, spec_required=args.cmd == 'batch' or bool(args.spec))
        text, failed = render(pv, results, skipped)
        print(text)
        any_fail |= failed
        verdicts = {k: verdict(v) for k, v in results.items()}
        summary.append((os.path.basename(pv), verdicts))
        answer.append({'video': os.path.abspath(pv), 'verdict': 'FAIL' if 'FAIL' in verdicts.values() else 'WARN' if 'WARN' in verdicts.values() else 'PASS' if verdicts else 'NOT_MEASURED',
                       'failed': [k for k, v in verdicts.items() if v == 'FAIL'], 'warned': [k for k, v in verdicts.items() if v == 'WARN'], 'not_measured': skipped})
        dump[os.path.abspath(pv)] = {k: [f.__dict__ for f in v] for k, v in results.items()}
    if args.cmd == 'batch':
        print('\nsummary')
        for name, vs in summary:
            print(f'  {name:22s} ' + '  '.join(f'{k}={v}' for k, v in vs.items()))
    if args.json_out:
        jsonio.write(args.json_out, dump, indent=1, default=str)
    overall = 'FAIL' if any_fail else 'WARN' if any(a['verdict'] == 'WARN' for a in answer) else 'NOT_MEASURED' if all(a['verdict'] == 'NOT_MEASURED' for a in answer) else 'PASS'
    print(json.dumps({'result': {'verdict': overall, 'videos': answer}}))      # the last line, read by whoever runs this
    return 1 if any_fail else 0


if __name__ == '__main__':
    sys.exit(main())
