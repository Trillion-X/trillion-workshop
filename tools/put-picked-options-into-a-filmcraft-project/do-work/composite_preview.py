#!/usr/bin/env python3
"""Build one chapter-4 option's FilmCraft project and its preview, into work-round-<n>/pending (publish_r3 then moves it).

    preview4.py <id> ...

Project: projects-round-<n>/<id>.fcproj, a byte copy of options-ch4/base-graded-copy.fcproj (a copy of options-ch1's copy of his graded cut), changed only by
FilmCraft's own commands (the same steps as fc_preview_r3.py): overlay.mov on V3 and sound.wav on A2 at edit.overlay.at,
the overlay filling the frame; edit.scale as Motion scale keyframes on V1. This project is what a pick applies.

Preview: a FilmCraft export of a 272 s range here takes about 11 s per film second under the shared render lock, so the
preview of an overlay-only option is composited from the FilmCraft export of his graded cut (work/ch4-base-1080.mp4,
690.0-962.0 s) instead of re-exporting it: the same pixels FilmCraft rendered for V1+V2, overlay.mov placed at the same time,
sound.wav added to his sound, then the same two-pass loudness master (fc_preview_r3.master_loudness). A plain option is the
base range itself. An option that changes V1 (edit.scale) is exported by FilmCraft (fc_preview_r3.main), so what you see is
what FilmCraft makes."""
import json, os, shutil, subprocess, sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import ch4  # noqa: E402

ch4.install_rounds()
fc = ch4.load('fc_preview_r3')
rounds = sys.modules['rounds']
T = fc.T


def project(oid, spec):
    ed = spec['edit']
    os.makedirs(rounds.rdir('projects', oid), exist_ok=True)
    proj = rounds.rdir('projects', oid, oid + '.fcproj')
    shutil.copyfile(os.path.join(ch4.OPT, 'base-graded-copy.fcproj'), proj)
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
    os.makedirs(pend, exist_ok=True)
    raw, dst = os.path.join(pend, '_scratch.mov'), os.path.join(pend, oid + '.mp4')  # one scratch file, overwritten each time
    cmd = ['ffmpeg', '-nostdin', '-v', 'error', '-y', '-ss', f'{a - ch4.BASE_T0:.4f}', '-t', f'{b - a:.4f}', '-i', ch4.BASE]
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
    subprocess.run(['nice', '-n', '10'] + cmd, check=True)
    fc.master_loudness(raw, dst)
    st = spec.get('still_at')
    if st is not None:
        subprocess.run(['ffmpeg', '-nostdin', '-v', 'error', '-y', '-ss', f'{st - a:.3f}', '-i', dst, '-frames:v', '1', '-q:v', '3', dst[:-4] + '.jpg'], check=True)
    print(f'{oid}: {dst} (pending)')


def main(oid):
    spec = json.load(open(rounds.rdir('specs', oid, oid + '.json')))
    if spec['edit'].get('scale'):
        sys.argv = ['fc_preview_r3.py', oid]
        with rounds.render_lock():
            fc.main()  # builds the project with FilmCraft and exports the preview from it
        return
    if not spec.get('plain'):
        project(oid, spec)
    composite(oid, spec)


if __name__ == '__main__':
    for oid in sys.argv[1:]:
        main(oid)
