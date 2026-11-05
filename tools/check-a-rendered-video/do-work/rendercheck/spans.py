"""check-a-rendered-video export-spans: export only the stretches of the source footage that a folder of specs plays, as placement base footage
(the footage without the overlay, which placement and held-face read through the limits' placement.bases).

  export-spans <specs dir> --limits L --bases-key REGEX --out-dir D --export '["cmd", "...", "{out}", "{from}", "{to}"]' --fps F --pad P
               --duration-tolerance-s T [--files-relative-to DIR] [--name 'base-{from}-{to}.mp4'] [--lock FILE] [--dry-run]

  1. For every spec, the cut seconds the preview plays: ctx.source_time at every frame of edit.preview (prepend, cuts and hold mapped), padded by --pad each side.
  2. The union of those, minus what the limits' placement.bases[REGEX] already holds (a range that rounds to nothing is not exported).
  3. Each remaining range is exported by the --export command (argv; {out}, {from} and {to} are filled in; the exporter is the person's, for example
     their editor's command line), one at a time, under an exclusive lock on --lock when given (a parent that already holds that lock exports
     FILM_RENDER_LOCK_HELD with its path and is not waited on), checked (the limits' frame size, --fps, duration within --duration-tolerance-s), and listed.
     With --project (an editor's project JSON whose media items name files), nothing is exported while any of those files is offline (exit 2).
  It prints the lines the old script printed, then {"result": {"needed", "held", "to_export", "exported": [{file, from, to}], "bases_key"}} as the last
  line: the rows to add to the person's placement.bases[REGEX]. It never edits the limits; the person's AI writes the rows back to their settings row.
Exit 2 when the export command fails (for example its source footage is offline), 1 when an exported file is refused."""
import argparse
import fcntl
import json
import os
import pathlib
import subprocess
import sys

from rendercheck import config  # noqa: E402
from rendercheck.ctx import Context  # noqa: E402

LOCK_HELD_ENV = 'FILM_RENDER_LOCK_HELD'
FPS = None      # the source footage's frame rate, set from --fps


def needed(specs_dir, pad):
    out = []
    for f in sorted(pathlib.Path(specs_dir).glob('*.json')):
        edit = json.load(open(f)).get('edit') or {}
        if not edit.get('preview'):
            continue
        c = Context.__new__(Context)
        c.edit, c.p0 = edit, edit['preview'][0]
        src = [c.source_time(k / FPS) for k in range(int((edit['preview'][1] - edit['preview'][0]) * FPS))]
        k = 0
        while k < len(src):      # one range per stretch of consecutive source frames (a stitched cold open is several stretches)
            j = k
            while j + 1 < len(src) and abs(src[j + 1] - src[j] - 1 / FPS) < 0.5 / FPS:
                j += 1
            if j > k:
                out.append((f.stem, max(src[k] - pad, 0.0), src[j] + 1 / FPS + pad))
            k = j + 1
    return out


def union(ranges):
    merged = []
    for a, b in sorted(ranges):
        if merged and a <= merged[-1][1]:
            merged[-1][1] = max(merged[-1][1], b)
        else:
            merged.append([a, b])
    return merged


def subtract(ranges, covered):
    for ca, cb in covered:
        nxt = []
        for a, b in ranges:
            if cb <= a or ca >= b:
                nxt.append([a, b])
                continue
            if a < ca:
                nxt.append([a, ca])
            if cb < b:
                nxt.append([cb, b])
        ranges = nxt
    return ranges


def probe(path):
    r = subprocess.run(['ffprobe', '-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=width,height,r_frame_rate:format=duration', '-of', 'json', str(path)],
                       capture_output=True, text=True, check=True)
    j = json.loads(r.stdout)
    return j['streams'][0]['width'], j['streams'][0]['height'], j['streams'][0]['r_frame_rate'], float(j['format']['duration'])


def run(args):
    global FPS
    cfg = config.load(args.limits)
    specs_dir, pad, FPS = args.specs, args.pad, args.fps
    covered = [[s['from'], s['to']] for s in (cfg.get('placement', {}).get('bases') or {}).get(args.bases_key) or []]
    per_option = needed(specs_dir, pad)
    todo = [[round(a, 2), round(b, 2)] for a, b in subtract(union([(a, b) for _, a, b in per_option]), covered)]
    todo = [r for r in todo if r[1] > r[0]]      # a sliver left by floating point rounds to nothing: nothing to export
    for name, a, b in per_option:
        print(f'{name}: his cut {a:.1f}-{b:.1f}s')
    print(f'already held: {covered}\nto export: {todo}, {sum(b - a for a, b in todo):.1f} s')
    result = {'bases_key': args.bases_key, 'needed': [{'spec': n, 'from': round(lo, 2), 'to': round(hi, 2)} for n, lo, hi in per_option],
              'held': covered, 'to_export': todo, 'exported': []}
    if args.dry_run or not todo:
        return result, 0
    if args.project:
        PROJECT = args.project
        items = json.load(open(PROJECT))['project']['items']
        gone = [p for p in (v['kind']['Media']['media']['File']['path'] for v in items.values() if 'Media' in v['kind'] and 'File' in v['kind']['Media'].get('media', {})) if not os.path.isfile(p)]
        if gone:
            print('source media offline, nothing exported:\n  ' + '\n  '.join(gone))
            result['error'] = f'source media offline: {len(gone)} files of {os.path.basename(PROJECT)}'
            return result, 2
    os.makedirs(args.out_dir, exist_ok=True)
    rel_root = args.files_relative_to or args.out_dir
    lock = open(args.lock, 'a') if args.lock else None
    try:
        if lock and os.path.realpath(os.environ.get(LOCK_HELD_ENV) or '\0') != os.path.realpath(args.lock):
            fcntl.flock(lock, fcntl.LOCK_EX)
            os.environ[LOCK_HELD_ENV] = os.path.realpath(args.lock)
        for lo, hi in todo:
            out = pathlib.Path(args.out_dir) / args.name.format(**{'from': f'{lo:g}', 'to': f'{hi:g}'})
            r = subprocess.run([str(x).format(out=out, **{'from': lo, 'to': hi}) for x in json.loads(args.export)], capture_output=True, text=True)
            if r.returncode:
                result['error'] = f'the export command failed for {lo:g}-{hi:g}s: {(r.stdout + r.stderr)[-600:]}'
                return result, 2
            w, h, rate, dur = probe(out)
            num, den = (rate.split('/') + ['1'])[:2]
            want = (cfg['frame']['width'], cfg['frame']['height'])
            if (w, h) != want or abs(float(num) / float(den) - FPS) > 1e-3 or abs(dur - (hi - lo)) > args.duration_tolerance_s:
                result['error'] = f'{out.name} is {w}x{h} {rate} {dur:.2f}s, wanted {want[0]}x{want[1]} at {FPS:.3f} fps, {hi - lo:.2f} s'
                return result, 1
            result['exported'].append({'file': os.path.relpath(out, rel_root), 'from': lo, 'to': hi})
            print(f'wrote {out.name}, {dur:.2f} s')
    finally:
        if lock:
            lock.close()
    return result, 0


def main(argv):
    ap = argparse.ArgumentParser(prog='check-a-rendered-video export-spans', description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('specs', help='folder of <id>.json specs whose previews play the footage')
    ap.add_argument('--limits', required=True, help="the person's limits or settings row (frame size; placement.bases already held)")
    ap.add_argument('--bases-key', required=True, help='the placement.bases key (a regex on the video path) the new spans belong under')
    ap.add_argument('--out-dir', required=True, help='where the exported files go')
    ap.add_argument('--export', required=True, help='JSON argv of the exporter, with {out}, {from} and {to}')
    ap.add_argument('--fps', type=float, required=True, help='frame rate of the source footage (for example 23.976)')
    ap.add_argument('--files-relative-to', help='the folder the rows name files from (the limits\' lane_root_regex folder); default --out-dir')
    ap.add_argument('--name', default='base-{from}-{to}.mp4', help='file name of each export, with {from} and {to}')
    ap.add_argument('--pad', type=float, required=True, help='seconds added before and after each played range')
    ap.add_argument('--duration-tolerance-s', dest='duration_tolerance_s', type=float, required=True, help='how far an export may differ from its range in seconds')
    ap.add_argument('--lock', help='a lock file every export holds, shared with the person\'s other renders')
    ap.add_argument('--project', help="an editor's project JSON ({project: {items}}) whose media files must all be on disk before anything is exported")
    ap.add_argument('--dry-run', action='store_true', help='say what would be exported, export nothing')
    args = ap.parse_args(argv)
    sys.stdout.flush()
    result, code = run(args)
    print(json.dumps({'result': result}))
    return code


if __name__ == '__main__':
    sys.exit(main(sys.argv[1:]))
