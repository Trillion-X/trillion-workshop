"""check-a-rendered-video check <video.mp4> [--spec <spec.json>] | check-a-rendered-video batch <videos-dir> [--specs <specs-dir>]
  | check-a-rendered-video review-pack <videos-dir> --out <dir> --rules <rules.json> --limits <file>
  | check-a-rendered-video variety <ledger folder> --limits <file>
  | check-a-rendered-video map-add <ledger folder> --id T --event-types a,b [--chapter1]
  | check-a-rendered-video declare <ledger folder> --lane L --option ID --moment 2:19 --techniques a,b --kind K
  | check-a-rendered-video pins --limits <file> [--reviewed <pins.json>]
  | check-a-rendered-video inspect settle|type-sync|eyes|placement ...   (rendercheck/inspect_<what>.py)
  | check-a-rendered-video export-spans <specs dir> --limits <file> --bases-key REGEX ...   (rendercheck/spans.py)
  | check-a-rendered-video request < {"argv": [...], "settings_record": <list:settings row>}   (under tools/settings run-with-settings.mjs)

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


def pins_report(cfg, reviewed):
    """The pin of every check now, and against the person's reviewed pins ({check: pin}) which changed, which are new and which are gone:
    a check whose pin changed has new code or limits, and its recorded answers are void until the person reviews it again."""
    now = pins.check_pins(cfg)
    return {'pins': now,
            'changed': [{'check': k, 'reviewed': reviewed[k], 'now': v} for k, v in now.items() if k in reviewed and reviewed[k] != v],
            'added': sorted(k for k in now if k not in reviewed), 'gone': sorted(k for k in reviewed if k not in now)}


NEEDS_LIMITS = {'check', 'batch', 'pins', 'variety', 'review-pack', 'export-spans', 'inspect'}


def request_argv(request, folder):
    """`request`: one JSON request on standard input, {"argv": [command...], "settings_record": <the list:settings row>, "settings"?: {...}}, as
    tools/settings/do-work/run-with-settings.mjs hands it. The settings are read by the shared reader (request_settings: the row, then the
    request's own settings over it); settings.limits and settings.reviewed_pins are written to files in `folder` and named by --limits/--reviewed."""
    argv = list(request.get('argv') or [])
    if not argv or not all(isinstance(x, str) for x in argv):
        raise ValueError('the request needs argv: a list of strings, the command first (check, batch, pins, ...)')
    if any(x in ('--limits', '--reviewed') for x in argv):
        raise ValueError('give the limits and reviewed pins as settings (settings.limits, settings.reviewed_pins), not as --limits or --reviewed')
    reader = config_mod.settings_reader()
    try:
        settings = reader.request_settings(request, {}, folder=config_mod.FOLDER, tool=config_mod.TOOL)
    except reader.SettingError as exc:
        raise ValueError(str(exc)) from None
    for key, flag, name in (('limits', '--limits', 'limits.json'), ('reviewed_pins', '--reviewed', 'reviewed-pins.json')):
        wanted = argv[0] in NEEDS_LIMITS and not argv[1:2] in (['eyes'], ['placement']) if key == 'limits' else argv[0] == 'pins'
        if wanted and not isinstance(settings.get(key), dict) and key == 'limits':
            raise ValueError(f"{argv[0]} needs the person's limits: name their list:settings row in settings_record (run under tools/settings/do-work/run-with-settings.mjs), or give settings.limits")
        if wanted and isinstance(settings.get(key), dict):
            jsonio.write(os.path.join(folder, name), settings[key])
            argv += [flag, os.path.join(folder, name)]
    return argv


def request_main(stdin=None):
    import tempfile
    try:
        request = json.loads((stdin or sys.stdin).read() or '{}')
        with tempfile.TemporaryDirectory(prefix='check-a-rendered-video-') as folder:
            return main(request_argv(request, folder))
    except ValueError as exc:
        print(json.dumps({'error': str(exc)}))
        return 2


def main(argv=None):
    argv = sys.argv[1:] if argv is None else argv
    if argv and argv[0] == 'inspect':
        what = {'settle': 'settle', 'type-sync': 'type', 'eyes': 'eyes', 'placement': 'placement'}.get(argv[1] if len(argv) > 1 else '')
        if not what:
            print('usage: check-a-rendered-video inspect settle|type-sync|eyes|placement ...', file=sys.stderr)
            return 2
        return importlib.import_module(f'rendercheck.inspect_{what}').main(argv[2:])
    if argv and argv[0] == 'export-spans':
        from . import spans
        return spans.main(argv[1:])
    if argv and argv[0] == 'request':
        return request_main()
    ap = argparse.ArgumentParser(prog='check-a-rendered-video', description=__doc__)
    sub = ap.add_subparsers(dest='cmd', required=True)
    pp = sub.add_parser('pins', help="each check's pin now, and which differ from the person's reviewed pins")
    pp.add_argument('--limits', required=True, help="the person's limits file, or their list:settings row for this tool")
    pp.add_argument('--reviewed', help='JSON {check: pin} of the pins the person reviewed, or their list:settings row (its settings.reviewed_pins)')
    vp = sub.add_parser('variety', help='judge the whole variety ledger at once (exit 1 on any breach)')
    vp.add_argument('target', help='the folder holding the ledger and the technique map')
    vp.add_argument('--limits', required=True, help='the person\'s limits file (its variety section)')
    mp = sub.add_parser('map-add', help='add a technique to technique-map.json, under the ledger lock')
    mp.add_argument('target', help='the folder holding the ledger and the technique map')
    mp.add_argument('--id', required=True, help='new technique id')
    mp.add_argument('--event-types', dest='event_types', default='', help='comma list of spec event types that render it (empty for none)')
    mp.add_argument('--chapter1', action='store_true', help='belongs to the reference set whose share of moments the variety check limits')
    dp = sub.add_parser('declare', help='append one row to technique-ledger.jsonl, under the ledger lock')
    dp.add_argument('target', help='the folder holding the ledger and the technique map')
    dp.add_argument('--lane', required=True)
    dp.add_argument('--option', required=True, help='option id (the video file name without .mp4); unique across the film')
    dp.add_argument('--moment', required=True, help='moment time, m:ss or seconds')
    dp.add_argument('--techniques', required=True, help='comma list of technique ids, the main technique first')
    dp.add_argument('--kind', required=True)
    rp = sub.add_parser('review-pack', help='contact sheets, transcript and rules for a fresh-viewer review of each video')
    rp.add_argument('target', help='folder of video .mp4 files')
    rp.add_argument('--out', required=True, help='folder that gets one <id>/ pack per video')
    rp.add_argument('--rules', required=True, help='rules file ({rows: [{id, rule, kinds}]})')
    rp.add_argument('--kind', default='film-edit', help='the rows of this kind go in rules.txt (default film-edit)')
    rp.add_argument('--limits', required=True, help='the person\'s limits file (transcription settings)')
    rp.add_argument('--ids', help='comma list of video ids: pack only these')
    rp.add_argument('--cache-dir', dest='cache_dir', help='where transcriptions are kept between runs (default: a folder under the system temp folder)')
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
    if args.cmd in ('map-add', 'declare'):
        from .checks import variety
        try:
            if args.cmd == 'map-add':
                print(json.dumps(variety.map_add(args.target, args.id, [t for t in args.event_types.split(',') if t], args.chapter1)))
            else:
                print(json.dumps(variety.declare(args.target, args.lane, args.option, args.moment, args.techniques.split(','), args.kind)))
        except ValueError as exc:
            print(f'refused: {exc}', file=sys.stderr)
            return 2
        return 0
    cfg = config_mod.load(args.limits)
    if args.cmd == 'pins':
        print(json.dumps({'result': pins_report(cfg, config_mod.load_reviewed(args.reviewed) if args.reviewed else {})}))
        return 0
    if args.cmd == 'variety':
        from .checks import variety
        return variety.report(args.target, cfg)
    if args.cmd == 'review-pack':
        from . import review_pack
        for pack in review_pack.run(args.target, args.out, args.rules, cfg, args.ids.split(',') if args.ids else None, args.kind, args.cache_dir):
            print(pack)
        return 0
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
