"""List a sequence's track items with timecodes, optionally only around a range.

usage: python3 -I prdump.py PROJECT.prproj [FROM TO]   (FROM/TO: frames or HH:MM:SS:FF)
"""
import os
import sys

sys.dont_write_bytecode = True
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from prproj import TPS, Project, parse_tc, read_text, tc  # noqa: E402


def main():
    p = Project(read_text(sys.argv[1]))
    for seq in p.sequences():
        tracks, tpf = p.tracks(seq)
        lo = parse_tc(int(sys.argv[2]) if sys.argv[2:3] and sys.argv[2].isdigit() else sys.argv[2], tpf) if len(sys.argv) > 3 else None
        hi = parse_tc(int(sys.argv[3]) if sys.argv[3].isdigit() else sys.argv[3], tpf) if len(sys.argv) > 3 else None
        print(f'SEQUENCE {seq.findtext("Name")}')
        for label, uid in tracks.items():
            items = p.track_items(uid)
            print(f'  {label} ({len(items)} items)')
            for oid, s, e, cti in items:
                if lo is not None and (e <= lo * tpf or s > hi * tpf):
                    continue
                adj = ' [adjustment layer]' if p.is_adjustment_layer(cti) else ''
                src = ''
                sub = p.ref(cti.find('SubClip'))
                clip = p.ref(sub.find('Clip')) if sub is not None else None
                if clip is not None and clip.findtext('Clip/InPoint') is not None and not adj and label[0] != 'D':
                    cin = int(clip.findtext('Clip/InPoint'))
                    src = f'  src {cin / TPS:.3f}-{(cin + e - s) / TPS:.3f}'
                print(f'    {tc(s, tpf)} -> {tc(e, tpf)}  ({s // tpf}-{e // tpf}f)  id={oid}  {p.item_name(cti)}{adj}{src}')


if __name__ == '__main__':
    main()
