#!/usr/bin/env python3
"""A stand-in filmcraft-cli for the tests and the parity runs: a small timeline model kept in the project file itself.

It answers the commands the FilmCraft preview builder sends (inspect sequence, inspect project, run OPS with --save,
export) the way FilmCraft answers them as far as the builder reads them: clips with clip, name, start, duration,
sourceIn and enabled on video and audio tracks, in ticks (254016000000 a second; a frame of 23.976 fps is 10594584000
ticks; every time is snapped to a frame). A project file is JSON: {"sequence": {"video": [{"items": [...]}], "audio":
[...]}, "root": {"children": []}, "next": n, "linked": true, "media": {}}. Imported media last the "duration" a JSON
media file holds, else 10 s (5 s for a picture). An export writes a JSON file the stand-in ffprobe reads.

When FILMCRAFT_STAND_IN_LOG names a file, every call appends {"prog": "filmcraft-cli", "argv": [...], "ops": [...]} to
it (ops: the lines of the run file), so two programs' calls can be compared argv for argv. Made up; never FilmCraft."""
import json
import os
import sys

T = 254016000000
FT = T * 1001 // 24000


def snap(t):
    return round(t / FT) * FT


def tracks(state):
    return [('video', i, tr) for i, tr in enumerate(state['sequence']['video'])] + \
           [('audio', i, tr) for i, tr in enumerate(state['sequence']['audio'])]


def track_of(state, name):
    kind = 'video' if name[0] == 'V' else 'audio'
    n = int(name[1:]) - 1
    lst = state['sequence'][kind]
    while len(lst) <= n:
        lst.append({'items': []})
    return lst[n]


def find(state, cid):
    for _, _, tr in tracks(state):
        for c in tr['items']:
            if c['clip'] == cid:
                return tr, c
    raise SystemExit(f'stand-in filmcraft-cli: no clip {cid}')


def new_id(state):
    state['next'] += 1
    return f'c{state["next"]}'


def split_track(state, tr, t):
    for c in list(tr['items']):
        if c['start'] < t < c['start'] + c['duration']:
            right = dict(c, clip=new_id(state), start=t, duration=c['start'] + c['duration'] - t, sourceIn=c['sourceIn'] + (t - c['start']))
            c['duration'] = t - c['start']
            tr['items'].append(right)


def shift(state, at_or_after, by, keep=()):
    for _, _, tr in tracks(state):
        for c in tr['items']:
            if c['start'] >= at_or_after and c['clip'] not in keep:
                c['start'] += by


def op(state, cid, p):
    if cid == 'sequence.addEditAllTracks':
        t = snap(p['time'])
        for _, _, tr in tracks(state):
            split_track(state, tr, t)
        return {'time': t}
    if cid == 'edit.rippleDelete':
        found = [find(state, x) for x in p['clips']]
        if not found:
            return {'removed': 0}
        a = min(c['start'] for _, c in found)
        b = max(c['start'] + c['duration'] for _, c in found)
        for tr, c in found:
            tr['items'].remove(c)
        shift(state, b, a - b)
        return {'removed': len(found)}
    if cid == 'timeline.trim':
        tr, c = find(state, p['clip'])
        d = p['deltaFrames'] * FT if 'deltaFrames' in p else snap(p['delta'])
        if p['edge'] == 'out':
            if p.get('mode') == 'ripple':
                shift(state, c['start'] + c['duration'], d)
            c['duration'] += d
        elif p.get('mode') == 'ripple':  # the in edge moves inside the media; the clip keeps its start, later clips move
            partners = [x for _, _, t2 in tracks(state) for x in t2['items'] if state['linked'] and x is not c and x['start'] == c['start']
                        and x.get('name') == c.get('name')]
            shift(state, c['start'] + 1, -d, keep={c['clip']} | {x['clip'] for x in partners})
            for x in [c] + partners:
                x['duration'] -= d
                x['sourceIn'] += d
        else:
            c['start'] += d
            c['duration'] -= d
            c['sourceIn'] += d
        return {'delta': d}
    if cid == 'clip.insertFrameHoldSegment':
        _, c = find(state, p['clip'])
        t = snap(p['time'])
        dur = round(p['seconds'] * 24000 / 1001) * FT
        src = c['sourceIn'] + (t - c['start'])
        for _, _, tr in tracks(state):
            split_track(state, tr, t)
        shift(state, t, dur)
        track_of(state, 'V1')['items'].append({'clip': new_id(state), 'name': c['name'], 'start': t, 'duration': dur, 'sourceIn': src,
                                               'enabled': True, 'hold': True})
        return {'duration': dur}
    if cid == 'timeline.razor':  # sound is cut where asked (to the tick); picture on a frame
        split_track(state, track_of(state, p['track']), p['time'] if p['track'][0] == 'A' else snap(p['time']))
        return {}
    if cid == 'sequence.linkedSelection':
        state['linked'] = bool(p['on'])
        return {'on': state['linked']}
    if cid == 'clip.enable':
        for x in p['clips']:
            _, c = find(state, x)
            c['enabled'] = not c['enabled']
        return {}
    if cid == 'clip.audioGain':
        for x in p['clips']:
            _, c = find(state, x)
            c['gain_db'] = c.get('gain_db', 0) + p['db']
        return {}
    if cid == 'effects.setParam':
        _, c = find(state, p['clip'])
        c.setdefault('keyframes', []).append([p['effect'], p['param'], p['time'], p['value']])
        return {}
    if cid == 'file.import':
        items = []
        for path in p['paths']:
            state['next'] += 1
            item = f'i{state["next"]}'
            dur = 5.0 if path.lower().endswith(('.png', '.jpg', '.jpeg')) else 10.0
            try:
                with open(path) as fh:
                    dur = float(json.load(fh)['duration'])
            except (OSError, ValueError, KeyError, TypeError):
                pass
            state['media'][item] = {'name': os.path.basename(path), 'path': path, 'duration': dur}
            state['root']['children'].append({'name': os.path.basename(path), 'item': item})
            items.append(item)
        return {'items': items}
    if cid == 'sequence.addTracks':
        at = p.get('videoAfter', len(state['sequence']['video']))
        for _ in range(p.get('video', 0)):
            state['sequence']['video'].insert(at, {'items': []})
        return {}
    if cid == 'timeline.place':
        m = state['media'][p['item']]
        c = {'clip': new_id(state), 'name': m['name'], 'start': snap(p['time']), 'duration': snap(m['duration'] * T), 'sourceIn': 0, 'enabled': True}
        track_of(state, p['track'])['items'].append(c)
        return {'clip': c['clip']}
    if cid == 'clip.fillFrame':
        for x in p['clips']:
            find(state, x)[1]['fill'] = True
        return {}
    if cid == 'timeline.move':
        src = [(find(state, m['clip'])[1], m) for m in p['moves']]
        t0 = min(snap(m['time']) for _, m in src)
        span = max(snap(m['time']) + c['duration'] for c, m in src) - t0
        copies = [dict(c, clip=new_id(state), start=snap(m['time'])) for c, m in src]
        if p.get('insert'):
            shift(state, t0, span)
        if not p.get('copy'):
            for c, _ in src:
                for _, _, tr in tracks(state):
                    if c in tr['items']:
                        tr['items'].remove(c)
        for c, (_, m) in zip(copies, src):
            track_of(state, m['track'])['items'].append(c)
        return {'moved': len(copies)}
    raise SystemExit(f'stand-in filmcraft-cli: no command {cid}')


def sequence(state):
    return {k: [{'items': sorted(tr['items'], key=lambda c: c['start'])} for tr in state['sequence'][k]] for k in ('video', 'audio')}


def main(argv):
    log = os.environ.get('FILMCRAFT_STAND_IN_LOG')
    args = list(argv)
    project = args[args.index('--project') + 1]
    save = '--save' in args
    rest = [a for i, a in enumerate(args) if a not in ('--project', '--compact', '--save') and (i == 0 or args[i - 1] != '--project')]
    entry = {'prog': 'filmcraft-cli', 'argv': args}
    ops = []
    if rest[0] == 'run':
        with open(rest[1]) as fh:
            ops = [json.loads(line) for line in fh if line.strip()]
        entry['ops'] = ops
    if log:
        with open(log, 'a') as fh:
            fh.write(json.dumps(entry) + '\n')
    with open(project) as fh:
        state = json.load(fh)
    if rest[0] == 'inspect':
        print(json.dumps(sequence(state) if rest[1] == 'sequence' else {'root': state['root']}))
        return
    if rest[0] == 'run':
        for o in ops:
            print(json.dumps({'id': o['id'], 'result': op(state, o['id'], o.get('params', {}))}))
        if save:
            with open(project, 'w') as fh:
                json.dump(state, fh)
        return
    if rest[0] == 'export':
        out = rest[1]
        a, b = float(rest[rest.index('--start') + 1]), float(rest[rest.index('--end') + 1])
        os.makedirs(os.path.dirname(os.path.abspath(out)), exist_ok=True)
        with open(out, 'w') as fh:
            json.dump({'stand_in_export': True, 'duration': b - a, 'width': 1920, 'height': 1080, 'audio': 1}, fh)
        print(json.dumps({'exported': out}))
        return
    raise SystemExit(f'stand-in filmcraft-cli: no command {rest[0]}')


if __name__ == '__main__':
    main(sys.argv[1:])
