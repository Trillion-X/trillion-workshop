"""One render: a spec's events drawn into overlay.mov (ProRes 4444 with alpha), its sound stem sound.wav (the voice, if the spec
mixes one, and every placed sound), sfx-only.wav (the sounds without the voice) and timeline.json (every element, sound and
placed box with its time); or, with stills, single frames over the spec's still background.

The overlay's last frame must be empty (exit-leaves-frame): a render whose last frame still shows something stops and says
where, so duration_s can be lengthened."""
import json
import os
import re
import subprocess

import numpy as np
from PIL import Image

from overlay import events, look, stage
from overlay.build import Build
from overlay.lock import render_lock, wait_while  # noqa: F401  (the entry takes the lock from here)


def sound_events(sounds, library, trim):
    """Every placed sound resolved to what is mixed: kind, time, recording, the used part, fades and final gain (library gain
    plus the spec's sound_trim_db, all sounds (dB) or per kind ({kind: dB}); 'roll' covers every roll-* kind). The mix and the
    level checks both read this list, so what is measured is what is heard. A copy of one recording that would start within
    look3 sound_overlap.within_s of another copy of it is moved later by stagger_s until it is clear (no doubled sounds)."""
    gap = look.LOOK3['sound_overlap']
    out = []
    for kind, t in sorted(sounds, key=lambda x: x[1]):
        add = (trim.get(kind, trim.get('roll', 0) if kind.startswith('roll-') else 0) if isinstance(trim, dict) else trim)
        if kind not in library:
            raise SystemExit(f'the spec plays the sound `{kind}`, which the settings\' sound table (recipe.sound.events and sound_layers) does not hold; add it')
        for s in library[kind]:
            ts = t
            while any(o['file'] == look.asset(s['file']) and o['start_s'] == s.get('start_s', 0) and abs(o['t'] - ts) < gap['within_s'] for o in out):
                ts += gap['stagger_s']
            out.append({'kind': kind, 't': round(ts, 3), 'file': look.asset(s['file']), 'start_s': s.get('start_s', 0), 'max_s': s.get('max_s'),
                        'fade_in_s': s.get('fade_in_s'), 'gain_db': s['gain_db'] + add})
    return out


def event_input(ev):
    return ['-ss', str(ev['start_s']), '-i', ev['file']]  # start_s: where in the recording the used part starts


def event_filter(ev):
    """One sound as mixed (before its delay and the stem gain): 48 kHz stereo, the used part with a short fade, its gain."""
    cut = f'atrim=0:{ev["max_s"]},afade=t=out:st={max(0.0, ev["max_s"] - 0.08)}:d=0.08,' if ev.get('max_s') else ''
    cut += f'afade=t=in:d={ev["fade_in_s"]},' if ev.get('fade_in_s') else ''
    return f'aresample=48000,aformat=channel_layouts=stereo,{cut}volume={ev["gain_db"]}dB'


def shift_inputs(graph):
    """Renumber input pads [k:a] -> [k-1:a] after dropping the first input (the voice)."""
    return re.sub(r'\[(\d+):a\]', lambda m: f'[{int(m.group(1)) - 1}:a]', graph)


def render(spec, stills=None):
    """spec: the spec object. Returns the answer: what was written."""
    events.bind(Build)
    stage.W, stage.H = spec.get('canvas', (stage.W, stage.H))  # a still slide (a carousel's 1080x1350) draws on its own canvas
    b = Build(spec)
    b.build()
    out = look.FOLDERS['out']
    os.makedirs(out, exist_ok=True)
    look.R['sound']['events'].update(b.extra_sounds)
    if stills:
        bg = spec.get('still_bg')
        fmt = spec.get('still_format', 'jpg')  # png: the still is the deliverable (a slide), kept lossless; jpg: a preview of an overlay frame
        written = []
        for s in stills:
            im = b.frame(int(round(float(s) * stage.FPS)))
            if bg == 'none':  # the overlay frame alone, alpha kept (png): what a graphic covers, measured by its opaque box
                path = os.path.join(out, f'still-{float(s):05.2f}.png')
                im.save(path)
                written.append(path)
                continue
            base = Image.open(look.at_root(bg)).convert('RGBA').resize((stage.W, stage.H)) if bg else Image.new('RGBA', (stage.W, stage.H), (40, 40, 40, 255))
            base.alpha_composite(im)
            path = os.path.join(out, f'still-{float(s):05.2f}.{fmt}')
            base.convert('RGB').save(path, **({'quality': 88} if fmt == 'jpg' else {}))
            written.append(path)
        return {'id': spec['id'], 'stills': written}
    ov = os.path.join(out, 'overlay.mov')
    p = subprocess.Popen(['nice', '-n', '10', 'ffmpeg', '-v', 'error', '-y', '-f', 'rawvideo', '-pix_fmt', 'rgba', '-s', f'{stage.W}x{stage.H}',
                          '-r', f'{stage.FPS_N}/{stage.FPS_D}', '-i', '-', '-c:v', 'prores_ks', '-profile:v', '4', '-pix_fmt', 'yuva444p10le',
                          '-alpha_bits', '16', '-vendor', 'apl0', '-threads', '4', '-qscale:v', str(spec.get('qscale', 6)),
                          '-color_primaries', 'bt709', '-color_trc', 'bt709', '-colorspace', 'bt709', ov], stdin=subprocess.PIPE)
    for n in range(b.n_frames):
        last = b.frame(n)
        p.stdin.write(last.tobytes())
    p.stdin.close()
    if p.wait():
        raise SystemExit('overlay encode failed')
    a = np.asarray(last.getchannel('A'))
    if (a > 8).sum() > 200:  # exit-leaves-frame: when the overlay ends, anything still on it vanishes on screen
        ys, xs = np.nonzero(a > 8)
        raise SystemExit(f'{spec["id"]}: the last overlay frame still shows something at [{xs.min()},{ys.min()},{xs.max()},{ys.max()}]; '
                         'lengthen duration_s until every element has left the frame')
    snd = look.R['sound']
    dur = b.n_frames / stage.FPS
    inputs, chains, labels, idx = [], [], [], 0
    v = (spec.get('voice') or {}).get('wav') and spec['voice']  # a voice with only word times (a whole cut's spec) mixes no sound
    if v:
        ms = int(v['start_s'] * 1000)
        inputs += ['-i', v['wav']]
        chains.append(f'[{idx}:a]aresample=48000,aformat=channel_layouts=stereo,volume={snd["voice_gain_db"]}dB,adelay={ms}|{ms}[s{idx}]')
        labels.append(f'[s{idx}]'); idx += 1
    placed = sound_events(b.sounds, snd['events'], spec.get('sound_trim_db', 0))
    for ev in placed:
        inputs += event_input(ev)
        chains.append(f'[{idx}:a]{event_filter(ev)},adelay={max(0, int(ev["t"] * 1000))}|{max(0, int(ev["t"] * 1000))}[s{idx}]')
        labels.append(f'[s{idx}]'); idx += 1
    wav = os.path.join(out, 'sound.wav')
    answer = {'id': spec['id'], 'frames': b.n_frames, 'duration_s': round(dur, 4), 'overlay': ov}
    if labels:
        graph = ';'.join(chains) + ';' + ''.join(labels) + f'amix=inputs={len(labels)}:normalize=0:dropout_transition=0,volume={snd["stem_gain_db"]}dB,apad=whole_len={int(round(dur * 48000))},atrim=0:{dur:.4f}[out]'
        subprocess.run(['ffmpeg', '-nostdin', '-v', 'error', '-y'] + inputs + ['-filter_complex', graph, '-map', '[out]', '-c:a', 'pcm_s24le', wav], check=True)
        answer['sound'] = wav
        if v and len(labels) > 1:  # effects alone, for measuring them against the voices
            g2 = ';'.join(chains[1:]) + ';' + ''.join(labels[1:]) + f'amix=inputs={len(labels) - 1}:normalize=0:dropout_transition=0,volume={snd["stem_gain_db"]}dB,apad=whole_len={int(round(dur * 48000))},atrim=0:{dur:.4f}[out]'
            subprocess.run(['ffmpeg', '-nostdin', '-v', 'error', '-y'] + inputs[2:] + ['-filter_complex', shift_inputs(g2), '-map', '[out]', '-c:a', 'pcm_s24le',
                            os.path.join(out, 'sfx-only.wav')], check=True)
            answer['sfx_only'] = os.path.join(out, 'sfx-only.wav')
    # an element carried off by tear_exit (or slide_out) keeps being a box while it moves: one box per frame from its exit to the frame it
    # has left, so a placement check follows it over the footage it passes instead of reading it at its resting place. Elements that share
    # an id (the letters of a title) have no single resting box and are left as recorded.
    for sp in b.sprites:
        rest = [x for x in b.boxes if x[0] == sp.id]
        if sp.t_out is None or len(rest) != 1 or len([s for s in b.sprites if s.id == sp.id]) != 1:
            continue
        st0 = sp.state(sp.t_out)
        if st0 is None:
            continue
        _, _, _, rx0, ry0, rx1, ry1 = rest[0]
        for n in range(int(sp.t_out * stage.FPS), b.n_frames):
            st = sp.state(n / stage.FPS)
            if st is None:
                break
            dx, dy = st[1] - st0[1], st[2] - st0[2]
            b.boxes.append((sp.id, n / stage.FPS, n / stage.FPS, rx0 + dx, ry0 + dy, rx1 + dx, ry1 + dy))
    timeline = os.path.join(out, 'timeline.json')
    json.dump({'id': spec['id'], 'duration_s': round(dur, 4), 'frames': b.n_frames, 'elements': b.log,
               'sounds': [{'kind': k, 't': round(t, 3)} for k, t in sorted(b.sounds, key=lambda x: x[1])],
               'sound_events': placed, 'stem_gain_db': snd['stem_gain_db'],
               'boxes': [{'id': x[0], 't0': round(x[1], 3), 'box': [round(v, 1) for v in x[3:]]} for x in b.boxes]},
              open(timeline, 'w'), indent=1)
    answer['timeline'] = timeline
    return answer
