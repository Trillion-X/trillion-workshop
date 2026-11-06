#!/usr/bin/env python3
# tools/put-picked-options-into-a-filmcraft-project/do-work/composite_preview.py
"""Build one option's FilmCraft project and its preview, into work-round-<n>/pending (publish_preview then moves it), with
the preview composited from a FilmCraft export of the base cut instead of a new export: the request's how "composite".

Project: projects-round-<n>/<id>.fcproj, a byte copy of the chapter's base project, changed only by FilmCraft's own
commands (the same steps as filmcraft_preview.py): overlay.mov on V3 and sound.wav on A2 at edit.overlay.at, the overlay
filling the frame. This project is what a pick applies.

Preview: a FilmCraft export of a long range can take about 11 s per film second under the shared render lock, so the
preview of an overlay-only option is composited from the FilmCraft export of the graded cut (the chapter's settings
composite.base, starting at composite.base_t0 seconds of the cut) instead of re-exporting it: the same pixels FilmCraft rendered for
V1+V2, overlay.mov placed at the same time, sound.wav added to the cut's sound, then the same two-pass loudness master
(filmcraft_preview.master_loudness). A plain option (spec `plain`) is the base range itself. An option that changes V1
(edit.scale) is exported by FilmCraft (filmcraft_preview.main), so what you see is what FilmCraft makes."""
import json, os, shutil, subprocess, sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import filmcraft_preview as fc  # noqa: E402
import option_folders as rounds  # noqa: E402

T = fc.T


def base_export():
    """(the chapter's FilmCraft export of the graded cut, the second of the cut it starts at): settings composite {base, base_t0}."""
    c = rounds.PLACE.get('composite') or {}
    if not c.get('base'):
        raise SystemExit('how "composite" needs the chapter\'s settings composite {base, base_t0}: the FilmCraft export of the cut to composite onto')
    return os.path.expanduser(rounds.under(rounds.OPT, c['base'])), float(c.get('base_t0', 0.0))


def project(oid, spec):
    ed = spec['edit']
    rounds.makedirs(rounds.rdir('projects', oid))
    proj = rounds.rdir('projects', oid, oid + '.fcproj')
    rounds.copy_project(rounds.base_project(), proj)
    if ed.get('overlay'):
        out = rounds.odir(oid)
        paths = [p for p in (os.path.join(out, 'overlay.mov'), os.path.join(out, 'sound.wav')) if os.path.exists(p)]
        fc.run(proj, [{'id': 'file.import', 'params': {'paths': paths}}])
        by_name = {c['name']: c['item'] for c in json.loads(fc.cli(proj, 'inspect', 'project'))['root']['children']}
        at = round(ed['overlay']['at'] * T)
        cmds = [{'id': 'timeline.place', 'params': {'item': by_name['overlay.mov'], 'track': 'V3', 'time': at, 'insert': False, 'audio': False}}]
        if 'sound.wav' in by_name:
            cmds.append({'id': 'timeline.place', 'params': {'item': by_name['sound.wav'], 'track': 'A2', 'time': at, 'insert': False}})
        fc.run(proj, cmds)
        ov = [c for c in fc.seq(proj)['video'][2]['items'] if c.get('name') == 'overlay.mov']
        fc.run(proj, [{'id': 'clip.fillFrame', 'params': {'clips': [ov[0]['clip']]}}])
    return proj


def placed(proj):
    """Where the option's own FilmCraft project puts overlay.mov (V3) and sound.wav (A2), in seconds of his cut. The project is
    the one placement owner: the preview reads these starts from it and never re-derives them from the spec."""
    s = fc.seq(proj)
    at = {}
    for kind, track, name in (('video', 2, 'overlay.mov'), ('audio', 1, 'sound.wav')):
        items = [c for c in s[kind][track]['items'] if c.get('name') == name] if len(s[kind]) > track else []
        if items:
            at[name] = items[0]['start'] / T
    return at


def composite(oid, spec):
    a, b = spec['edit']['preview']
    pend = rounds.rdir('work', oid, 'pending')
    rounds.makedirs(pend)
    raw, dst = os.path.join(pend, f'_scratch-{oid}.mov'), os.path.join(pend, oid + '.mp4')  # per option, so two composites never share a scratch
    BASE, BASE_T0 = base_export()
    cmd = ['ffmpeg', '-nostdin', '-v', 'error', '-y', '-ss', f'{a - BASE_T0:.4f}', '-t', f'{b - a:.4f}', '-i', BASE]
    if spec['edit'].get('overlay'):
        at = placed(rounds.rdir('projects', oid, oid + '.fcproj'))
        out = rounds.odir(oid)
        # picture: overlay follows timestamps, so the overlay input is shifted to its project start
        cmd += ['-itsoffset', f'{at["overlay.mov"] - a:.6f}', '-i', os.path.join(out, 'overlay.mov')]
        fg = '[1:v]format=yuva444p10le[ov];[0:v][ov]overlay=0:0:eof_action=pass:format=auto,format=yuv420p[v]'
        if 'sound.wav' in at:
            # sound: amix mixes by sample, not by timestamp, so the stem is placed in samples (adelay), never by -itsoffset
            # (SYNC-INVESTIGATION-2026-10-21.md: -itsoffset here played every effect early by the whole pre-roll)
            delay = round((at['sound.wav'] - a) * 48000)
            cmd += ['-i', os.path.join(out, 'sound.wav')]
            fg += (f';[0:a]aresample=48000[a0];[2:a]aresample=48000,adelay=delays={delay}S:all=1[a1];'
                   '[a0][a1]amix=inputs=2:normalize=0:duration=first[a]')
            cmd += ['-filter_complex', fg, '-map', '[v]', '-map', '[a]']
        else:
            cmd += ['-filter_complex', fg, '-map', '[v]', '-map', '0:a']
    else:
        cmd += ['-map', '0:v', '-map', '0:a']
    cmd += ['-c:v', 'libx264', '-crf', '17', '-preset', 'medium', '-pix_fmt', 'yuv420p', '-color_primaries', 'bt709', '-color_trc', 'bt709',
            '-colorspace', 'bt709', '-r', '24000/1001', '-c:a', 'pcm_s16le', '-t', f'{b - a:.4f}', raw]
    rounds.run_program(['nice', '-n', str(rounds.NICE)] + cmd, check=True)
    fc.master_loudness(raw, dst)
    st = spec.get('still_at')
    if st is not None:
        rounds.run_program(['ffmpeg', '-nostdin', '-v', 'error', '-y', '-ss', f'{st - a:.3f}', '-i', dst, '-frames:v', '1', '-q:v', str(rounds.PLACE['still_qscale']), dst[:-4] + '.jpg'], check=True)
    print(f'{oid}: {dst} (pending)', file=sys.stderr)
    return {'option': oid, 'preview': dst, **({'still': dst[:-4] + '.jpg'} if st is not None else {})}


def main(oid):
    spec = rounds.spec_of(oid)
    if spec['edit'].get('scale'):
        with rounds.render_lock():
            out = fc.main(oid)  # builds the project with FilmCraft and exports the preview from it
    else:
        out = {}
        if not spec.get('plain'):
            out['project'] = project(oid, spec)
        out.update(composite(oid, spec))
    if rounds.planning():
        out['plan'] = rounds.plan_steps()
    return out


if __name__ == '__main__':
    rounds.answer(fc.build)
