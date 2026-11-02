"""Render a small, UNGRADED proxy of a sequence straight from its track items, with ffmpeg.

It checks the edit itself (order, joins, pause trims, sync, inserts) without Premiere.
It is not Premiere's render: no effects, no Lumetri grade, no colour management
(S-Log3 footage looks flat), and no keyframes. V1 is the picture and V2+ are laid
over it in track order (adjustment layers are skipped). Every audio track is mixed
at unity gain. A placeholder or an empty stretch is black.

usage: python3 -I proxy_render.py PROJECT.prproj OUT.mp4 [--from TC --to TC] [--height 360]
"""
import argparse
import os
import shutil
import subprocess
import sys
import tempfile
from fractions import Fraction

sys.dont_write_bytecode = True
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from prproj import TPS, Project, parse_tc, read_text  # noqa: E402
import timeline  # noqa: E402


def media_path(p, cti):
    sub = p.ref(cti.find('SubClip'))
    clip = p.ref(sub.find('Clip'))
    src = p.ref(clip.find('Clip/Source'))
    media = p.ref(src.find('MediaSource/Media'))
    path = media.findtext('ActualMediaFilePath') or media.findtext('FilePath')
    return (path if path and os.path.isfile(path) else None), int(clip.findtext('Clip/InPoint') or 0)


def layers(p, tracks):
    """{label: [(start, end, path, in_ticks)]} for V and A tracks."""
    out = {}
    for label, uid in tracks.items():
        if label[0] not in 'VA':
            continue
        rows = []
        for oid, s, e, cti in p.track_items(uid):
            if p.is_adjustment_layer(cti):
                continue
            path, cin = media_path(p, cti)
            rows.append((s, e, path, cin))
        out[label] = rows
    return out


def render_segment(seg_s, seg_e, lay, tpf, height, path):
    width = height * 16 // 9
    rate = Fraction(TPS, tpf)  # the sequence frame rate, e.g. 24000/1001
    dur = (seg_e - seg_s) / TPS
    inputs, vchain, achain = [], [], []

    def add_input(src, cin, s):
        inputs.extend(['-ss', f'{(cin + seg_s - s) / TPS:.6f}', '-t', f'{dur:.6f}', '-i', src])
        return len(inputs) // 6 - 1

    base = None
    for label in sorted((k for k in lay if k[0] == 'V'), key=lambda k: int(k[1:])):
        for s, e, src, cin in lay[label]:
            if s <= seg_s and seg_e <= e and src:
                n = add_input(src, cin, s)
                if base is None:
                    vchain.append(f'[{n}:v]scale={width}:{height},setsar=1,format=yuva420p[v{n}]')
                    base = f'v{n}'
                else:
                    vchain.append(f'[{n}:v]scale={width}:{height},format=yuva420p[o{n}]')
                    vchain.append(f'[{base}][o{n}]overlay=format=auto[v{n}]')
                    base = f'v{n}'
    if base is None:
        vchain.append(f'color=black:s={width}x{height}:r={rate}:d={dur:.6f},format=yuva420p[vb]')
        base = 'vb'
    vchain.append(f'[{base}]format=yuv420p,fps={rate}[vout]')
    alabels = []
    for label in (k for k in lay if k[0] == 'A'):
        for s, e, src, cin in lay[label]:
            if s <= seg_s and seg_e <= e and src:
                n = add_input(src, cin, s)
                achain.append(f'[{n}:a]aresample=48000,aformat=channel_layouts=stereo[a{n}]')
                alabels.append(f'[a{n}]')
    if alabels:
        achain.append(''.join(alabels) + f'amix=inputs={len(alabels)}:normalize=0,apad[aout]')
    else:
        achain.append('anullsrc=r=48000:cl=stereo[aout]')
    graph = ';'.join(vchain + achain)
    cmd = ['ffmpeg', '-v', 'error', '-y', *inputs, '-filter_complex', graph, '-map', '[vout]', '-map', '[aout]',
           '-t', f'{dur:.6f}', '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '28', '-c:a', 'aac', '-b:a', '128k',
           path]
    subprocess.run(cmd, check=True)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('project')
    ap.add_argument('out')
    ap.add_argument('--from', dest='frm')
    ap.add_argument('--to')
    ap.add_argument('--height', type=int, default=360)
    args = ap.parse_args()
    p = Project(read_text(args.project))
    seq = p.sequences()[0]
    tracks, tpf = p.tracks(seq)

    class View:
        pass
    view = View()
    view.p, view.tracks = p, tracks
    end = timeline.timeline_end(view)
    lo = parse_tc(args.frm, tpf) * tpf if args.frm else 0
    hi = parse_tc(args.to, tpf) * tpf if args.to else end
    lay = layers(p, tracks)
    bounds = sorted({x for rows in lay.values() for s, e, _, _ in rows for x in (s, e) if lo < x < hi} | {lo, hi})
    work = tempfile.mkdtemp(prefix='proxy-')
    parts = []
    for n, (s, e) in enumerate(zip(bounds, bounds[1:])):
        part = os.path.join(work, f'{n:04d}.mp4')
        render_segment(s, e, lay, tpf, args.height, part)
        parts.append(part)
    listing = os.path.join(work, 'list.txt')
    with open(listing, 'w') as f:
        f.writelines(f"file '{x}'\n" for x in parts)
    subprocess.run(['ffmpeg', '-v', 'error', '-y', '-f', 'concat', '-safe', '0', '-i', listing, '-c', 'copy', args.out],
                   check=True)
    shutil.rmtree(work)  # the segment files this run made
    print(f'wrote {args.out}: {len(parts)} segments, {(hi - lo) / TPS:.1f} s')


if __name__ == '__main__':
    main()
