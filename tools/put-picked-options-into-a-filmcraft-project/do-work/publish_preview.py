
fc_preview_r3.py renders into work-round-<n>/pending/<id>.mp4.

    publish_r3.py <id> ...          move pending/<id>.mp4 (and its still) to previews-round-<n>/ once ffprobe reads one
                                    1920x1080 video stream and one audio stream and the picture's duration matches the
                                    spec's preview range. The move is a rename: a new file appears whole, and the old
                                    preview's inode is left to whatever links still point at it. previews-round-<n> is not
                                    a watch folder; film-qa then measures this shipped file (the gate refuses a pending copy).
    publish_r3.py --watch <id> ...  put each preview into "ROUND <n> - watch these" under its spec's `watch` name: a hard link
                                    made beside it under a temporary name, then renamed over the old name (ln -f, atomic).
                                    Refuses a preview film-qa has not measured. Run it after the content gate passes.
"""
import json, os, subprocess, sys

import pathlib
CHECKOUT = str(pathlib.Path(__file__).resolve().parents[5])  # this repository, wherever this place keeps it
HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
from rounds import OPT, rdir, watch_dir  # noqa: E402

CIS = CHECKOUT + '/tools/content-investigation/cis.py'
FILM = os.path.normpath(os.path.join(OPT, '..', '..'))


def require_gate(oid):
    """No route into a watch folder skips the content checklist: this hard link runs `cis.py gate` for the option itself (the guard hook only sees
    commands that name the folder, not a script that links into it). Unanswered or failed MUST rows refuse it. Delivery stage 'review' (cis.py: review is for a watch folder or PICK file, final for release), where the copy gate's advisory rows do not block."""
    run = subprocess.run([sys.executable, '-I', CIS, 'gate', FILM, '--stage', 'S5,S6', '--option', oid, '--at', 'review'], capture_output=True, text=True)
    if run.returncode:
        try:
            out = json.loads(run.stdout)
            rows = [f"{r['id']}" for r in out.get('unanswered_must', []) + out.get('failed_must', [])] + out.get('problems', [])
        except ValueError:
            rows = [(run.stderr or run.stdout).strip()[:300]]
        raise SystemExit(f'{oid}: REFUSED, the content checklist is not answered (cis.py gate): {", ".join(rows[:20])}')


def probe(path):
    out = subprocess.run(['ffprobe', '-v', 'error', '-show_entries', 'stream=codec_type,width,height,duration', '-of', 'json', path],
                         capture_output=True, text=True, check=True).stdout
    return json.loads(out)


def spec_of(oid):
    return json.load(open(rdir('specs', oid, oid + '.json')))


def publish(oid):
    src = rdir('work', oid, 'pending', oid + '.mp4')
    if not os.path.exists(src):
        raise SystemExit(f'{oid}: nothing pending at {src}')
    a, b = spec_of(oid)['edit']['preview']
    p = probe(src)
    v = [s for s in p['streams'] if s['codec_type'] == 'video']
    au = [s for s in p['streams'] if s['codec_type'] == 'audio']
    dur = float(v[0]['duration']) if v else 0.0  # the picture's length (the AAC track pads up to a packet past it)
    if len(v) != 1 or (v[0]['width'], v[0]['height']) != (1920, 1080) or len(au) != 1 or abs(dur - (b - a)) > 0.1:
        raise SystemExit(f'{oid}: ffprobe refused: {len(v)} video {v[0]["width"] if v else "-"}x{v[0]["height"] if v else "-"}, '
                         f'{len(au)} audio, {dur:.3f} s against {b - a:.3f} s')
    dst = rdir('previews', oid, oid + '.mp4')
    os.makedirs(os.path.dirname(dst), exist_ok=True)
    os.replace(src, dst)
    if os.path.exists(src[:-4] + '.jpg'):
        os.replace(src[:-4] + '.jpg', dst[:-4] + '.jpg')
    print(f'{oid}: {dst} ({dur:.3f} s)')


def watch(oid):
    name = spec_of(oid).get('watch')
    if not name:
        raise SystemExit(f'{oid}: the spec has no watch name')
    src = rdir('previews', oid, oid + '.mp4')
    qa = rdir('work', oid, 'qa', oid + '.json')
    names = [os.path.realpath(k) for k in json.load(open(qa)) if not k.startswith('_')] if os.path.exists(qa) else []
    if os.path.realpath(src) not in names or os.path.getmtime(qa) < os.path.getmtime(src):
        raise SystemExit(f'{oid}: film-qa has not been run on {src} (expected {qa}, newer than the preview)')
    require_gate(oid)
    folder = watch_dir(oid)
    os.makedirs(folder, exist_ok=True)
    link_into(src, folder, name + '.mp4', f'.{oid}.linking')
    print(f'{oid}: "{name}.mp4" -> {src}')


def link_into(src, folder, final_name, tmp_name):
    """Hard-link src into folder under final_name, atomically: link to tmp_name beside it, then rename over the final name.
    The temporary link never outlives the call: a stale one from an interrupted run is removed first, and it is removed
    afterwards whatever happened. rename(2) between two links of the same file does nothing and leaves the source name, so
    a final name that already is this file is left as it is and no temporary link is made."""
    final, tmp = os.path.join(folder, final_name), os.path.join(folder, tmp_name)
    if os.path.exists(final) and os.path.samefile(src, final):
        return
    if os.path.lexists(tmp):
        os.unlink(tmp)
    try:
        os.link(src, tmp)
        os.replace(tmp, final)
    finally:
        if os.path.lexists(tmp):
            os.unlink(tmp)


if __name__ == '__main__':
    args = sys.argv[1:]
    if args and args[0] == '--watch':
        for oid in args[1:]:
            watch(oid)
    else:
        for oid in args:
            publish(oid)
