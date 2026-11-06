#!/usr/bin/env python3
"""A WORKING preview of a stitched cold open (edit.prepend, optional edit.hold at 0:00, overlay at 0:00) made with ffmpeg from a render of his
cut, for judging placement, timing and sound while the FilmCraft export cannot run (the project's source media, on the camera card, CAMERA_CLIPS, is not at this place).
It is not the delivered preview: the picture has no V2 grade layer, and it is never published (publish_r3.py reads work-round-<n>/pending, this writes
work-round-<n>/working/<id>.mp4). Same snapping and order as fc_preview_r3.prepend; same loudness mastering as the real export.
Usage: working_preview.py <id> --cut <the full render of his cut, 1201.2 s>"""
import json, os, subprocess, sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
from fc_preview_r3 import master_loudness  # noqa: E402
from rounds import odir, rdir  # noqa: E402

FPS = 24000 / 1001


def main():
    oid = sys.argv[1]
    cut = os.path.abspath(sys.argv[sys.argv.index('--cut') + 1])
    spec = json.load(open(rdir('specs', oid, oid + '.json')))
    ed = spec['edit']
    a, b = ed['preview']
    n_total = round((b - a) * FPS)
    parts = []   # (start frame in the cut, frames, held?)
    hold = ed.get('hold')
    segs = [(round(x * FPS), round(y * FPS) - round(x * FPS)) for x, y in ed['prepend']]
    if hold:
        parts.append((segs[0][0], round(hold['seconds'] * FPS), True))
    parts += [(s, n, False) for s, n in segs]
    parts.append((0, n_total - sum(p[1] for p in parts), False))   # then his film from 0:00
    inputs, chains, v, au = [], [], [], []
    for i, (s, n, held) in enumerate(parts):
        inputs += ['-ss', f'{s / FPS:.5f}', '-i', cut]
        if held:
            chains.append(f'[{i}:v]trim=end_frame=1,loop=loop={n - 1}:size=1:start=0,setpts=N/({FPS}*TB),scale=1920:1080:flags=lanczos,setsar=1[v{i}]')
            chains.append(f'anullsrc=r=48000:cl=stereo,atrim=0:{n / FPS:.5f}[a{i}]')
        else:
            chains.append(f'[{i}:v]trim=end_frame={n},setpts=PTS-STARTPTS,scale=1920:1080:flags=lanczos,setsar=1[v{i}]')
            chains.append(f'[{i}:a]atrim=0:{n / FPS:.5f},asetpts=PTS-STARTPTS,aresample=48000,aformat=channel_layouts=stereo[a{i}]')
        v.append(f'[v{i}]')
        au.append(f'[a{i}]')
    k = len(parts)
    inputs += ['-i', os.path.join(odir(oid), 'overlay.mov'), '-i', os.path.join(odir(oid), 'sound.wav')]
    chains.append(''.join(v) + f'concat=n={k}:v=1:a=0[base]')
    mutes = ''.join(f',volume=0:enable=\'between(t,{x:.5f},{y:.5f})\'' for x, y in ed.get('a1_mute', []))   # his sound off where the spec says (a1_mute)
    chains.append(''.join(au) + f'concat=n={k}:v=0:a=1{mutes}[bed]')
    chains.append(f'[{k}:v]format=yuva444p10le,setpts=PTS-STARTPTS[ovl]')
    chains.append('[base][ovl]overlay=0:0:eof_action=pass:format=auto,format=yuv420p[vout]')
    chains.append(f'[{k + 1}:a]aresample=48000,aformat=channel_layouts=stereo[fx]')
    chains.append('[bed][fx]amix=inputs=2:normalize=0:duration=first:dropout_transition=0[aout]')
    out_dir = rdir('work', oid, 'working')
    os.makedirs(out_dir, exist_ok=True)
    raw, dst = os.path.join(out_dir, f'_raw-{oid}.mp4'), os.path.join(out_dir, oid + '.mp4')
    subprocess.run(['nice', '-n', '10', 'ffmpeg', '-nostdin', '-v', 'error', '-y'] + inputs + ['-filter_complex', ';'.join(chains), '-map', '[vout]', '-map', '[aout]',
                    '-t', f'{n_total / FPS:.5f}', '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '18', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-b:a', '256k', raw], check=True)
    master_loudness(raw, dst)
    os.remove(raw)
    print(dst)


if __name__ == '__main__':
    main()
