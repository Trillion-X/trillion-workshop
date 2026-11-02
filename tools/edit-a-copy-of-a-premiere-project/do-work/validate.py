"""Structural checks on a Premiere project: unique ids, every reference resolves,
no object is left unreferenced, track lists numbered in order, no item ends
before it starts, no overlaps.

usage: python3 -I validate.py PROJECT.prproj   (gzipped or plain XML)
"""
import os
import sys
import xml.etree.ElementTree as ET

sys.dont_write_bytecode = True
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from prproj import clip_track_item, read_text  # noqa: E402


def check(text):
    root = ET.fromstring(text)
    ids, uids, problems = {}, {}, []
    for el in root:
        for key, store in (('ObjectID', ids), ('ObjectUID', uids)):
            if key in el.attrib:
                if el.attrib[key] in store:
                    problems.append(f'duplicate {key} {el.attrib[key]}')
                store[el.attrib[key]] = el
    for el in root.iter():
        r = el.attrib.get('ObjectRef')
        if r is not None and r not in ids:
            problems.append(f'dangling ObjectRef {r} in <{el.tag}>')
        r = el.attrib.get('ObjectURef')
        if r is not None and r not in uids:
            problems.append(f'dangling ObjectURef {r} in <{el.tag}>')
    referenced = set()
    for el in root.iter():
        if 'ObjectRef' in el.attrib:
            referenced.add(el.attrib['ObjectRef'])
    for oid, el in ids.items():
        if oid not in referenced:
            problems.append(f'unreferenced object {el.tag} {oid}')
    owner = {}
    for uid, track in uids.items():
        if not track.tag.endswith('ClipTrack'):
            continue
        prev_end, prev = -1, None
        for n, it in enumerate(track.findall('.//ClipItems/TrackItems/TrackItem')):
            oid = it.attrib['ObjectRef']
            if oid in owner:
                problems.append(f'item {oid} listed on two tracks')
            owner[oid] = uid
            if int(it.attrib['Index']) != n:
                problems.append(f'track {uid[:8]}: index {it.attrib["Index"]} at position {n}')
            if oid not in ids:
                continue
            cti = clip_track_item(ids[oid])
            s = int(cti.findtext('TrackItem/Start') or 0)
            e = int(cti.findtext('TrackItem/End'))
            if e <= s:
                problems.append(f'item {oid} ends before it starts')
            if s < prev_end:
                problems.append(f'track {uid[:8]}: item {oid} overlaps item {prev}')
            prev_end, prev = e, oid
    return problems


if __name__ == '__main__':
    found = check(read_text(sys.argv[1]))
    print('\n'.join(found) if found else 'OK: no problems')
    sys.exit(1 if found else 0)
