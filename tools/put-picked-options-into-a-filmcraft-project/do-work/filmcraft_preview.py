import json, os, shutil, subprocess, sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
from rounds import OPT, filmcraft_cli as cli, filmcraft_export, odir, rdir, render_lock  # noqa: E402,F401  cli: lanes call fc_preview_r3.cli
T = 254016000000


def run(project, cmds):
    path = f'/tmp/fc-{os.getpid()}.jsonl'
    with open(path, 'w') as f:
        for c in cmds:
            f.write(json.dumps(c) + '\n')
    out = cli(project, 'run', path, save=True)
    return [json.loads(l) for l in out.splitlines() if l.strip().startswith('{')]


def seq(project):
    return json.loads(cli(project, 'inspect', 'sequence'))


def clip_at(s, track, t):
    tr = s['video' if track[0] == 'V' else 'audio'][int(track[1:]) - 1]
    for c in tr['items']:
        if c['start'] <= t < c['start'] + c['duration']:
            return c
    raise SystemExit(f'no clip on {track} at {t / T:.3f}')


FRAME_TICKS = T * 1001 // 24000  # one frame of the sequence in ticks (23.976 fps)


def frame_tick(t):
    return round(t * 24000 / 1001) * FRAME_TICKS


def prepend(proj, ranges):
    """Copy each [a, b] range of the graded cut (all tracks) to the start of the sequence in the order given, rippling the rest.
    Returns the length of the stitched part in seconds. Ranges are snapped to frames and must not overlap each other."""
    spans = sorted((frame_tick(a), frame_tick(b)) for a, b in ranges)
    for (_, b0), (a1, _) in zip(spans, spans[1:]):
        if a1 < b0:
            raise SystemExit('prepend: ranges overlap')
    cuts = sorted({p for sp in spans for p in sp})
    run(proj, [{'id': 'sequence.addEditAllTracks', 'params': {'time': p}} for p in cuts])
    s = seq(proj)
    names = {('video', i): f'V{i + 1}' for i in range(len(s['video']))} | {('audio', i): f'A{i + 1}' for i in range(len(s['audio']))}
    groups = []  # per range in the order asked: [(clip id, track name)]
    for a, b in ((frame_tick(a), frame_tick(b)) for a, b in ranges):
        g = [(c['clip'], names[(k, i)]) for k in ('video', 'audio') for i, tr in enumerate(s[k]) for c in tr['items']
             if c['start'] >= a and c['start'] + c['duration'] <= b]
        if not g:
            raise SystemExit(f'prepend: nothing between {a / T:.3f} and {b / T:.3f}')
        groups.append(g)
    end = 0
    for g in groups:
        now = {c['clip']: c for k in ('video', 'audio') for tr in seq(proj)[k] for c in tr['items']}  # ids stay; starts moved with earlier inserts
        first = min(now[cid]['start'] for cid, _ in g)
        last = max(now[cid]['start'] + now[cid]['duration'] for cid, _ in g)
        run(proj, [{'id': 'timeline.move', 'params': {'moves': [{'clip': cid, 'track': tr, 'time': end + now[cid]['start'] - first} for cid, tr in g],
                                                       'insert': True, 'copy': True}}])
        end += last - first
    return end / T


def main():
    """Build and export one option. Takes the render lock itself (reentrant), so a caller importing main() cannot skip it."""
    with render_lock():
        _main()


def _main():
    oid = sys.argv[1]
    spec = json.load(open(rdir('specs', oid, oid + '.json')))
    ed = spec['edit']
    os.makedirs(rdir('projects', oid), exist_ok=True)
    proj = rdir('projects', oid, oid + '.fcproj')
    shutil.copyfile(os.path.join(OPT, 'base-graded-copy.fcproj'), proj)
    build_edits(proj, oid, spec)
    a, b = ed['preview']
    raw, dst = export_paths(oid)
    os.makedirs(os.path.dirname(dst), exist_ok=True)
    filmcraft_export(proj, raw, a, b)
    master_loudness(raw, dst)
    os.remove(raw)  # scratch only; the mastered preview is dst (disk is short)
    st = spec.get('still_preview')
    if st is None and spec.get('still_at') is not None:
        st = spec['still_at'] - a
    if st is not None:
        subprocess.run(['ffmpeg', '-nostdin', '-v', 'error', '-y', '-ss', f'{st:.3f}', '-i', dst, '-frames:v', '1', '-q:v', '3', dst[:-4] + '.jpg'], check=True)
    print(f'{oid}: {dst} (pending; publish_r3.py moves it into the previews folder after ffprobe; film-qa then measures it there)')


def as_list(v):
    """An edit entry that is one dict or a list of them (hold, hold_picture), as a list."""
    return [] if not v else v if isinstance(v, list) else [v]


def build_edits(proj, oid, spec):
    """Every edit of the spec's "edit" block on the project copy `proj`, in FilmCraft's own commands (no export; the tests call this alone)."""
    ed = spec['edit']
    if ed.get('prepend'):
        prepend(proj, ed['prepend'])
    for a, b in sorted(ed.get('cuts', []), reverse=True):
        run(proj, [{'id': 'sequence.addEditAllTracks', 'params': {'time': round(a * T)}},
                   {'id': 'sequence.addEditAllTracks', 'params': {'time': round(b * T)}}])
        s = seq(proj)
        ids = [c['clip'] for k in ('video', 'audio') for tr in s[k] for c in tr['items']
               if c['start'] >= round(a * T) - T // 100 and c['start'] + c['duration'] <= round(b * T) + T // 100]
        run(proj, [{'id': 'edit.rippleDelete', 'params': {'clips': ids}}])
    for at, frames in ed.get('head_extend', []):  # reveal earlier frames of the clip starting at `at` (its own media), ripple
        v1 = min(seq(proj)['video'][0]['items'], key=lambda c: abs(c['start'] - at * T))  # the clip that starts at `at`
        if abs(v1['start'] - at * T) > T / 100:
            raise SystemExit(f'head_extend: no V1 clip starts at {at}')
        d = run(proj, [{'id': 'timeline.trim', 'params': {'clip': v1['clip'], 'edge': 'in', 'mode': 'ripple', 'deltaFrames': -frames}}])[0]['result']['delta']
        adj = clip_at(seq(proj), 'V2', round(at * T))
        run(proj, [{'id': 'timeline.trim', 'params': {'clip': adj['clip'], 'edge': 'out', 'mode': 'regular', 'delta': -d}}])
    for h in sorted(as_list(ed.get('hold')), key=lambda h: h['at'], reverse=True):  # latest first: each `at` stays a pre-hold time
        s = seq(proj)
        v1 = clip_at(s, 'V1', frame_tick(h['at']))
        res = run(proj, [{'id': 'clip.insertFrameHoldSegment', 'params': {'clip': v1['clip'], 'time': frame_tick(h['at']), 'seconds': h['seconds']}}])
        dur = res[0]['result']['duration']
        s = seq(proj)
        if h['at'] <= 0:  # a hold at the very start (a stitched cold open): no grade piece lies before it, so the first one reaches back over it
            adj = clip_at(s, 'V2', dur)
            run(proj, [{'id': 'timeline.trim', 'params': {'clip': adj['clip'], 'edge': 'in', 'mode': 'regular', 'delta': -dur}}])
        else:
            adj = clip_at(s, 'V2', frame_tick(h['at']) - 1)
            run(proj, [{'id': 'timeline.trim', 'params': {'clip': adj['clip'], 'edge': 'out', 'mode': 'regular', 'delta': dur}}])
    for a, b in ed.get('a1_mute', []):  # no sound from A1 between a and b (seconds after the hold); the picture plays on
        run(proj, [{'id': 'timeline.razor', 'params': {'time': round(a * T), 'track': 'A1'}},
                   {'id': 'timeline.razor', 'params': {'time': round(b * T), 'track': 'A1'}}])
        ids = [c['clip'] for c in seq(proj)['audio'][0]['items']
               if c['start'] >= round(a * T) - T // 1000 and c['start'] + c['duration'] <= round(b * T) + T // 1000]
        if not ids:
            raise SystemExit(f'a1_mute: no A1 clip between {a} and {b}')
        run(proj, [{'id': 'sequence.linkedSelection', 'params': {'on': False}}, {'id': 'clip.enable', 'params': {'clips': ids}},
                   {'id': 'sequence.linkedSelection', 'params': {'on': True}}])
    for a, b, db in ed.get('gain', []):
        run(proj, [{'id': 'timeline.razor', 'params': {'time': round(a * T), 'track': 'A1'}},
                   {'id': 'timeline.razor', 'params': {'time': round(b * T), 'track': 'A1'}}])
        c = clip_at(seq(proj), 'A1', round((a + b) / 2 * T))
        run(proj, [{'id': 'clip.audioGain', 'params': {'clips': [c['clip']], 'mode': 'adjust', 'db': db}}])
    if ed.get('scale'):
        s = seq(proj)
        cmds = []
        for t, pct in ed['scale']:
            c = clip_at(s, 'V1', round(t * T))
            cmds.append({'id': 'effects.setParam', 'params': {'clip': c['clip'], 'effect': 'motion', 'param': 'scale', 'value': pct,
                                                              'time': round(t * T), 'keyframe': True}})
        run(proj, cmds)
    ov_track = 'V3'
    pictures = as_list(ed.get('hold_picture'))
    if pictures:  # stills on V3 for the holds, the overlay above them on V4 (see the docstring)
        run(proj, [{'id': 'file.import', 'params': {'paths': sorted({hp['image'] for hp in pictures})}}])
        items = {c['name']: c['item'] for c in json.loads(cli(proj, 'inspect', 'project'))['root']['children']}
        run(proj, [{'id': 'sequence.addTracks', 'params': {'video': 1, 'videoAfter': 3}}])
        for hp in pictures:
            at = round(hp['at'] * T)
            run(proj, [{'id': 'timeline.place', 'params': {'item': items[os.path.basename(hp['image'])], 'track': 'V3', 'time': at, 'insert': False, 'audio': False}}])
            still = min(seq(proj)['video'][2]['items'], key=lambda c: abs(c['start'] - at))  # the one just placed (FilmCraft snaps it to a frame)
            run(proj, [{'id': 'timeline.trim', 'params': {'clip': still['clip'], 'edge': 'out', 'mode': 'regular', 'delta': round(hp['seconds'] * T) - still['duration']}},
                       {'id': 'clip.fillFrame', 'params': {'clips': [still['clip']]}}])
        ov_track = 'V4'
    if ed.get('overlay'):
        out = odir(oid)
        paths = [p for p in (os.path.join(out, 'overlay.mov'), os.path.join(out, 'sound.wav')) if os.path.exists(p)]
        run(proj, [{'id': 'file.import', 'params': {'paths': paths}}])
        items = json.loads(cli(proj, 'inspect', 'project'))['root']['children']
        by_name = {c['name']: c['item'] for c in items}
        at = round(ed['overlay']['at'] * T)
        cmds = []
        if 'overlay.mov' in by_name:
            cmds.append({'id': 'timeline.place', 'params': {'item': by_name['overlay.mov'], 'track': ov_track, 'time': at, 'insert': False, 'audio': False}})
        if 'sound.wav' in by_name:
            cmds.append({'id': 'timeline.place', 'params': {'item': by_name['sound.wav'], 'track': 'A2', 'time': at, 'insert': False}})
        run(proj, cmds)
        s = seq(proj)
        ov = [c for c in s['video'][int(ov_track[1:]) - 1]['items'] if c.get('name') == 'overlay.mov']
        if ov:
            run(proj, [{'id': 'clip.fillFrame', 'params': {'clips': [ov[0]['clip']]}}])


def export_paths(oid):
    """(raw export scratch, mastered preview) in work-round-<n>/pending/: the scratch is per option, so two exports never share a file."""
    pend = rdir('work', oid, 'pending')
    return os.path.join(pend, f'_export-{oid}.mp4'), os.path.join(pend, oid + '.mp4')


def master_loudness(src, dst):
    """Two-pass EBU R128 loudness on the preview's sound (picture copied), to look_r3.json preview_loudness."""
    L = json.load(open(os.path.join(HERE, 'look_r3.json')))['preview_loudness']
    tgt = f"I={L['I']}:TP={L['TP']}:LRA={L['LRA']}"
    err = subprocess.run(['ffmpeg', '-nostdin', '-i', src, '-af', f'loudnorm={tgt}:print_format=json', '-vn', '-f', 'null', '-'],
                         capture_output=True, text=True).stderr
    m = json.loads(err[err.rindex('{'):err.rindex('}') + 1])
    af = (f"loudnorm={tgt}:measured_I={m['input_i']}:measured_TP={m['input_tp']}:measured_LRA={m['input_lra']}"
          f":measured_thresh={m['input_thresh']}:offset={m['target_offset']},aresample=48000")
    subprocess.run(['ffmpeg', '-nostdin', '-v', 'error', '-y', '-i', src, '-c:v', 'copy', '-af', af, '-c:a', 'aac', '-b:a', '256k',
                    '-movflags', '+faststart', dst], check=True)


if __name__ == '__main__':
    main()
