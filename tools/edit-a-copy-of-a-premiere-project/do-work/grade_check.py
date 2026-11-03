"""Check that pre-graded inserts match the grade of the footage they hand back to.

For every item on a video track above the adjustment layer that ends exactly where a V1
item starts (a graded plate handing back to camera footage), compare:
  - the plate's last frame (decoded from its file), with
  - the next V1 item's first source frame as Premiere graded it, taken from a graded export
    of the ORIGINAL sequence (the export is the only graded render that exists without Premiere).
The V1 frame is found by looking up its clip and source frame in the original project's V1.
Prints PSNR and the mean colour difference per channel, and writes a side-by-side PNG per join.

usage: python3 -I grade_check.py NEW.prproj ORIGINAL.prproj GRADED_EXPORT.mp4 OUT_DIR
"""
import os
import re
import subprocess
import sys

sys.dont_write_bytecode = True
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from prproj import TPS, Project, read_text, tc  # noqa: E402
from proxy_render import media_path  # noqa: E402


def rows(p, uid):
    out = []
    for oid, s, e, cti in p.track_items(uid):
        sub = p.ref(cti.find('SubClip'))
        clip = p.ref(sub.find('Clip')) if sub is not None else None
        cin = int(clip.findtext('Clip/InPoint') or 0) if clip is not None else 0
        out.append((oid, s, e, cti, cin, (sub.findtext('Name') or '') if sub is not None else ''))
    return out


def frame_png(src, seconds, out, scale=960):
    """The frame shown at `seconds` (also at the very end of a file): decode a short window up to it
    and keep the last frame."""
    start = max(0.0, seconds - 0.5)
    subprocess.run(['ffmpeg', '-v', 'error', '-y', '-ss', f'{start:.6f}', '-i', src, '-t', f'{seconds - start + 0.02:.6f}',
                    '-vf', f'scale={scale}:-1,format=rgb24', '-update', '1', out], check=True)


def compare(a, b):
    """PSNR between two stills, and each still's mean Y, U, V (8-bit)."""
    out = subprocess.run(['ffmpeg', '-i', a, '-i', b, '-lavfi', 'psnr', '-f', 'null', '-'],
                         capture_output=True, text=True).stderr
    psnr = re.search(r'average:([\d.inf]+)', out).group(1)
    means = []
    for f in (a, b):
        vals = subprocess.run(['ffprobe', '-v', 'error', '-f', 'lavfi', '-i', f'movie={f},signalstats',
                               '-show_entries',
                               'frame_tags=lavfi.signalstats.YAVG,lavfi.signalstats.UAVG,lavfi.signalstats.VAVG',
                               '-of', 'csv=p=0'], capture_output=True, text=True, check=True).stdout.strip().split(',')
        means.append([float(v) for v in vals[:3]])
    return psnr, means


def main():
    new_path, orig_path, export, out_dir = sys.argv[1:5]
    os.makedirs(out_dir, exist_ok=True)
    new, orig = Project(read_text(new_path)), Project(read_text(orig_path))
    ntracks, tpf = new.tracks(new.sequences()[0])
    otracks, _ = orig.tracks(orig.sequences()[0])
    adj_level = min((int(l[1:]) for l, u in ntracks.items() if l[0] == 'V' and
                     any(new.is_adjustment_layer(c) for _, _, _, c in new.track_items(u))), default=None)
    if adj_level is None:
        sys.exit('no adjustment layer track')
    v1 = rows(new, ntracks['V1'])
    ov1 = rows(orig, otracks['V1'])
    # the plate at a hand-back is the lowest item above the adjustment layer that ends there; overlays sit higher
    plates, taken = [], set()
    for level in sorted(int(l[1:]) for l in ntracks if l[0] == 'V' and int(l[1:]) > adj_level):
        for row in rows(new, ntracks[f'V{level}']):
            if row[2] not in taken:
                taken.add(row[2])
                plates.append((f'V{level}', row))
    for label, (oid, s, e, cti, cin, name) in plates:
        path, _ = media_path(new, cti)
        nxt = [r for r in v1 if r[1] == e]
        if not nxt or not path:
            print(f'{label} {name} {tc(s, tpf)}-{tc(e, tpf)}: no V1 item starts at its end (end of film or not a plate)')
            continue
        _, ns, _, _, ncin, nname = nxt[0]
        hit = [r for r in ov1 if r[5] == nname and r[4] <= ncin < r[4] + (r[2] - r[1])]
        if not hit:
            print(f'{label} {name}: next clip {nname} at source {ncin / TPS:.3f} s is not in the original sequence')
            continue
        _, os_, _, _, ocin, _ = hit[0]
        export_frame = (os_ + ncin - ocin) // tpf
        stem = os.path.join(out_dir, re.sub(r'[^\w.-]+', '_', name.rsplit('.', 1)[0]))
        plate_png, next_png = stem + '-plate-last.png', stem + '-next-graded.png'
        frame_png(path, (cin + (e - s) - tpf) / TPS, plate_png)
        frame_png(export, export_frame * tpf / TPS, next_png)
        subprocess.run(['ffmpeg', '-v', 'error', '-y', '-i', plate_png, '-i', next_png, '-filter_complex', 'hstack',
                        stem + '-join.png'], check=True)
        psnr, (pm, nm) = compare(plate_png, next_png)
        diff = [round(a - b, 1) for a, b in zip(pm, nm)]
        print(f'{label} {name} -> {nname} src {ncin / TPS:.3f} s (export frame {export_frame}): '
              f'PSNR {psnr} dB; mean Y/U/V plate {[round(x, 1) for x in pm]} vs next {[round(x, 1) for x in nm]}, '
              f'difference {diff}; picture {stem}-join.png')


if __name__ == '__main__':
    main()
