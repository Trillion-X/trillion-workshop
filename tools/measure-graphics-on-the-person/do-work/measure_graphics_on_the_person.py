#!/usr/bin/env python3
"""measure-graphics-on-the-person: deterministic checks of a vertical video's graphic layers.

Commands (run from this tool's folder):
  analyze          person and face masks of a clean picture (every frame), into OUT/masks
  measure          the request file: per-frame shares and pixels for each layer, the law verdicts, and optionally
                   the clip_quality_verdicts rows (write_verdicts names the held database connection)
  free-regions     the free rectangles of one frame or a span of frames: the safe zone minus the person and face masks, dilated by margin
  rows             the video_style_laws and platform_safe_zones rows, read from the held database, as JSON files
  identity         the BLAKE3 identity of a clean picture and its layer files

Heavy commands refuse while the 1-minute load is 90 or more. Run them as: taskpolicy -b nice -n 20 python3 ...
"""
import argparse
import json
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)

from measure_graphics import free, layers, measure, people, verdicts  # noqa: E402

LOAD_CEILING = 90.0
LAW_IDS = ('graphics-never-cover-the-person', 'everything-inside-platform-safe-zones')


def _guard_load():
    load = os.getloadavg()[0]
    if load >= LOAD_CEILING:
        raise SystemExit(f'refused: the 1-minute load is {load:.1f} (ceiling {LOAD_CEILING:.0f}); run again when it is lower')


def _video_size(path):
    info = layers.probe(path)
    return info['width'], info['height'], info['fps']


def _rows_by_id(path, key='id'):
    with open(path) as fh:
        rows = json.load(fh)
    return {row[key]: row for row in rows}


def cmd_analyze(args):
    _guard_load()
    width, height, fps = _video_size(args.clean)
    settings = {'person_conf': args.person_conf, 'keypoint_conf': args.keypoint_conf, 'face_pad_ratio': args.face_pad_ratio,
                'imgsz': args.imgsz, 'device': args.device, 'seg_model': args.seg_model, 'pose_model': args.pose_model}
    os.makedirs(args.out, exist_ok=True)
    meta = people.analyze(args.clean, args.out, width, height, fps, settings)
    print(json.dumps({'frames': meta['frames'], 'width': width, 'height': height, 'fps': fps,
                      'unresolved_face_frames': sum(1 for f in meta['per_frame'] if f['face_unresolved'])}))


def cmd_measure(args):
    with open(args.request) as fh:
        req = json.load(fh)
    _guard_load()
    width, height, fps = _video_size(req['clean'])
    for name, path in req['layers'].items():
        info = layers.probe(path)
        if (info['width'], info['height']) != (width, height):
            raise SystemExit(f'layer {name} is {info["width"]}x{info["height"]}, the clean picture is {width}x{height}')
    out = req['out']
    settings = req['person']
    if not os.path.exists(os.path.join(out, people.MASKS_DIR, 'meta.json')) or \
            people.read_meta(out).get('clean') != req['clean']:
        os.makedirs(out, exist_ok=True)
        people.analyze(req['clean'], out, width, height, fps, settings)
    zones = _rows_by_id(req['zones_file'])
    laws_rows = _rows_by_id(req['laws_file'])
    zone_rows = {}
    rects = {}
    for pid in req['platforms']:
        if pid not in zones:
            raise SystemExit(f'no platform_safe_zones row {pid}')
        zone_rows[pid] = zones[pid]['id']
        rects[pid] = free.zone_rect(zones[pid], width, height)
    laws = {}
    for law_id in LAW_IDS:
        if law_id not in laws_rows:
            raise SystemExit(f'no video_style_laws row {law_id}')
        bar = laws_rows[law_id]['bar']
        laws[law_id] = json.loads(bar) if isinstance(bar, str) else bar
    result = measure.measure_layers(out, req['layers'], rects, width, height)
    summary = measure.summarize(result)
    law_results = measure.laws_verdicts(result, summary, laws, zone_rows)
    identity = files_identity(req['clean'], req['layers'])
    run = f"measure-graphics-on-the-person {req.get('run_label', 'run')} clean={os.path.basename(req['clean'])}"
    rows = []
    for law_id, verdict in law_results.items():
        measured = {'summary': summary, 'per_frame': result['frames']}
        rows.append({'files_identity': identity, 'format_id': req['format_id'], 'check_id': verdict['check_id'],
                     'verdict': verdict['verdict'], 'measured': measured, 'bar': verdict['bar'], 'reason': verdict['reason'],
                     'evidence_ref': os.path.abspath(out), 'run': run})
    printed = {'files_identity': identity, 'rows': [{k: r[k] for k in ('check_id', 'verdict', 'reason')} for r in rows],
               'worst': summary}
    if req.get('write_verdicts'):
        printed['written'] = verdicts.write_rows(req['write_verdicts'], rows)
    print(json.dumps(printed, indent=1))


def files_identity(clean, layer_paths):
    import blake3
    digest = blake3.blake3()
    for label, path in [('clean', clean)] + sorted(layer_paths.items()):
        digest.update(label.encode() + b'\0')
        file_hash = blake3.blake3()
        with open(path, 'rb') as fh:
            for block in iter(lambda: fh.read(1 << 20), b''):
                file_hash.update(block)
        digest.update(file_hash.hexdigest().encode() + b'\n')
    return 'blake3:' + digest.hexdigest()


def cmd_free(args):
    zones = _rows_by_id(args.zones_file)
    rows = []
    for pid in args.platform.split(','):
        if pid not in zones:
            raise SystemExit(f'no platform_safe_zones row {pid}')
        rows.append(zones[pid])
    if args.span is not None:
        first, last = (int(v) for v in args.span.split(':'))
        result = free.free_regions_span(args.out, first, last, rows, args.margin, args.min_side)
    else:
        frame = args.frame if args.frame is not None else round(args.t * people.read_meta(args.out)['fps'])
        result = free.free_regions(args.out, frame, rows, args.margin, args.min_side)
    print(json.dumps(result, indent=1))


def cmd_rows(args):
    os.makedirs(args.out, exist_ok=True)
    laws = verdicts.fetch_rows(args.connection, 'video_style_laws', list(LAW_IDS))
    zones = verdicts.fetch_rows(args.connection, 'platform_safe_zones', [])
    for name, rows in (('video_style_laws.json', laws), ('platform_safe_zones.json', zones)):
        with open(os.path.join(args.out, name), 'w') as fh:
            json.dump(rows, fh, indent=1)
    print(json.dumps({'video_style_laws': len(laws), 'platform_safe_zones': len(zones)}))


def cmd_identity(args):
    print(files_identity(args.clean, dict(item.split('=', 1) for item in args.layer)))


def build_parser():
    p = argparse.ArgumentParser(prog='measure_graphics_on_the_person.py')
    sub = p.add_subparsers(dest='command', required=True)

    a = sub.add_parser('analyze')
    a.add_argument('--clean', required=True)
    a.add_argument('--out', required=True)
    a.add_argument('--seg-model', required=True)
    a.add_argument('--pose-model', required=True)
    a.add_argument('--person-conf', type=float, default=0.25)
    a.add_argument('--keypoint-conf', type=float, default=0.3)
    a.add_argument('--face-pad-ratio', type=float, default=0.6)
    a.add_argument('--imgsz', type=int, default=960)
    a.add_argument('--device', default='mps', help='ultralytics device: mps (Apple GPU) or cpu')
    a.set_defaults(func=cmd_analyze)

    m = sub.add_parser('measure')
    m.add_argument('--request', required=True, help='JSON: clean, layers{graphics,captions,pose}, out, platforms, zones_file, laws_file, person{...}, format_id, run_label?, write_verdicts?')
    m.set_defaults(func=cmd_measure)

    f = sub.add_parser('free-regions')
    f.add_argument('--out', required=True, help='the folder analyze wrote')
    f.add_argument('--zones-file', required=True)
    f.add_argument('--platform', required=True, help='platform id, or several separated by commas: the rectangle inside all of them')
    f.add_argument('--margin', type=int, required=True, help='pixels a graphic must keep from the person and face masks')
    f.add_argument('--min-side', type=int, default=40)
    when = f.add_mutually_exclusive_group(required=True)
    when.add_argument('--t', type=float)
    when.add_argument('--frame', type=int)
    when.add_argument('--span', help='FIRST:LAST frames (inclusive): the rectangles free on every one of them')
    f.set_defaults(func=cmd_free)

    r = sub.add_parser('rows')
    r.add_argument('--connection', required=True)
    r.add_argument('--out', required=True)
    r.set_defaults(func=cmd_rows)

    i = sub.add_parser('identity')
    i.add_argument('--clean', required=True)
    i.add_argument('--layer', action='append', default=[], help='name=path')
    i.set_defaults(func=cmd_identity)
    return p


if __name__ == '__main__':
    args = build_parser().parse_args()
    args.func(args)
