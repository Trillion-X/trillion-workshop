#!/usr/bin/env python3
# tools/put-picked-options-into-a-filmcraft-project/do-work/publish_preview.py
"""Move a finished, checked preview into its round's previews folder, and link it into the watch folder (the person's
rule: never show an unfinished file). A file the person can open is never written in place.

filmcraft_preview.py renders into work-round-<n>/pending/<id>.mp4.

    action "publish"  move pending/<id>.mp4 (and its still) to previews-round-<n>/ once ffprobe reads one video stream of the
                      settings' frame size and one audio stream and the picture's duration matches the spec's preview range
                      (within duration_tolerance_s). The move is a rename: a new file appears whole, and the old preview's
                      inode is left to whatever links still point at it. The previews folder is not a watch folder.
    action "watch"    put the preview into the watch folder (settings layout.watch) under its spec's `watch` name: a hard
                      link made beside it under a temporary name, then renamed over the old name (ln -f, atomic). Refuses a
                      preview the rendered-video check has not measured (work-round-<n>/qa/<id>.json, newer than the
                      preview), and runs the content gate (settings content_gate.command) first: a refusal there refuses it.

Request: film, option (or options: [ids]), action, chapter?, options_folder?, spec?, settings_record?, settings?, plan?.
Answer: {"result": {"published": [{option, preview, duration_s}]}} or {"result": {"watching": [{option, name, preview}]}}."""
import json, os, subprocess, sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import option_folders as place  # noqa: E402
from option_folders import rdir, watch_dir, run_program  # noqa: E402


def require_gate(oid):
    """No route into a watch folder skips the content checklist: this hard link runs the settings' content gate for the option itself (the guard hook only sees
    commands that name the folder, not a script that links into it). Unanswered or failed MUST rows refuse it: the gate's command exits
    non-zero, its JSON answer naming unanswered_must, failed_must or problems. {film}, {option} and {python} in the command are filled in."""
    gate = place.PLACE.get('content_gate') or {}
    if not gate.get('command'):
        if place.PLACE.get('require_content_gate', True):
            raise SystemExit(f'{oid}: REFUSED, no content gate in the settings (preview.content_gate.command): a watch folder is only for a preview its checklist passed')
        return
    argv = [os.path.expanduser(a.format(film=place.PLACE['film'], option=oid, python=sys.executable)) for a in gate['command']]
    if place.planning():
        place.plan_note(argv=argv)
        return
    run = subprocess.run(argv, capture_output=True, text=True)
    if run.returncode:
        try:
            out = json.loads(run.stdout)
            rows = [f"{r['id']}" for r in out.get('unanswered_must', []) + out.get('failed_must', [])] + out.get('problems', [])
        except ValueError:
            rows = [(run.stderr or run.stdout).strip()[:300]]
        raise SystemExit(f'{oid}: REFUSED, the content checklist is not answered (content gate): {", ".join(rows[:20])}')


def probe(path):
    out = subprocess.run(['ffprobe', '-v', 'error', '-show_entries', 'stream=codec_type,width,height,duration', '-of', 'json', path],
                         capture_output=True, text=True, check=True).stdout
    return json.loads(out)  # read even in a plan: it writes nothing


def spec_of(oid):
    return place.spec_of(oid)


def publish(oid):
    src = rdir('work', oid, 'pending', oid + '.mp4')
    if not os.path.exists(src):
        raise SystemExit(f'{oid}: nothing pending at {src}')
    a, b = spec_of(oid)['edit']['preview']
    p = probe(src)
    v = [s for s in p['streams'] if s['codec_type'] == 'video']
    au = [s for s in p['streams'] if s['codec_type'] == 'audio']
    dur = float(v[0]['duration']) if v else 0.0  # the picture's length (the AAC track pads up to a packet past it)
    w, h = place.PLACE['frame']
    if len(v) != 1 or (v[0]['width'], v[0]['height']) != (w, h) or len(au) != 1 or abs(dur - (b - a)) > place.PLACE['duration_tolerance_s']:
        raise SystemExit(f'{oid}: ffprobe refused: {len(v)} video {v[0]["width"] if v else "-"}x{v[0]["height"] if v else "-"}, '
                         f'{len(au)} audio, {dur:.3f} s against {b - a:.3f} s')
    dst = rdir('previews', oid, oid + '.mp4')
    if place.planning():
        place.plan_note(move=[src, dst])
        return {'option': oid, 'preview': dst, 'duration_s': round(dur, 3)}
    os.makedirs(os.path.dirname(dst), exist_ok=True)
    os.replace(src, dst)
    if os.path.exists(src[:-4] + '.jpg'):
        os.replace(src[:-4] + '.jpg', dst[:-4] + '.jpg')
    print(f'{oid}: {dst} ({dur:.3f} s)', file=sys.stderr)
    return {'option': oid, 'preview': dst, 'duration_s': round(dur, 3)}


def watch(oid):
    name = spec_of(oid).get('watch')
    if not name:
        raise SystemExit(f'{oid}: the spec has no watch name')
    src = rdir('previews', oid, oid + '.mp4')
    qa = rdir('work', oid, 'qa', oid + '.json')
    names = [os.path.realpath(k) for k in json.load(open(qa)) if not k.startswith('_')] if os.path.exists(qa) else []
    if os.path.realpath(src) not in names or os.path.getmtime(qa) < os.path.getmtime(src):
        raise SystemExit(f'{oid}: the rendered-video check has not been run on {src} (expected {qa}, newer than the preview)')
    require_gate(oid)
    folder = watch_dir(oid)
    if place.planning():
        place.plan_note(link=[src, os.path.join(folder, name + '.mp4')])
        return {'option': oid, 'name': name + '.mp4', 'preview': src}
    os.makedirs(folder, exist_ok=True)
    link_into(src, folder, name + '.mp4', f'.{oid}.linking')
    print(f'{oid}: "{name}.mp4" -> {src}', file=sys.stderr)
    return {'option': oid, 'name': name + '.mp4', 'preview': src}


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


def publish_request(req):
    """The request's action ("publish" or "watch") for its option, or each of its options (one chapter's settings each)."""
    action = req.get('action', 'publish')
    if action not in ('publish', 'watch'):
        raise SystemExit(f'action {action!r}: use publish (pending -> previews folder) or watch (previews folder -> watch folder)')
    ids = req.get('options') or [req.get('option')]
    done = []
    for oid in ids:
        place.configure({**req, 'option': oid})
        done.append((publish if action == 'publish' else watch)(oid))
    out = {'published' if action == 'publish' else 'watching': done}
    if place.planning():
        out['plan'] = place.plan_steps()
    return out


if __name__ == '__main__':
    place.answer(publish_request)
