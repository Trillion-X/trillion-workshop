#!/usr/bin/env python3
"""Check a made cut against its plan by ear: its loudness, its long silences, the words heard in each spoken segment against the
plan's lines, and a few frames to look at.

usage: check_cut_speech.py --cut CUT.mp4 --timeline timeline.json --work DIR [--kinds a,b] [--always-show a] [--frames kind:which,...]
                           [--share-below 0.9] [--silence-db -60] [--silence-s 1] [--reader JSON | --model M] [--report FILE]

The timeline is the one tool:assemble-a-plan-into-a-cut writes beside the cut (a list of {seg, kind, text, start, dur}, seconds in
the cut). Each segment of a kind in --kinds is read by the reader and compared with its text: the share of the plan's words heard,
the words missing, and whether the heard text starts and ends where the plan's does (one of its first two and last two words), so a
cut that catches a neighbouring word shows. A segment is listed when its kind is in --always-show, when the share is under
--share-below, or when an end is off.

--frames picks frames to look at, each `kind:first`, `kind:middle` or `kind:last` (the first, middle or last segment of that kind,
taken at its middle): written as <work>/frame<n>.jpg and side by side as <work>/frames.jpg.

The report (default <work>/verify.json) holds the loudness, the silences and the segments, and `listened_by`: who listened to the cut
end to end. Only a person sets it; a value already in the report is kept and never filled in here, so a cut nobody listened to says so.

Exit 2 when a segment is listed (a person checks it), else 0. The last line is {"result": {...}}.
"""
import argparse
import json
import re
import subprocess
import sys
import tempfile
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from speech_reading import add_reader_options, reader_of, words  # noqa: E402


def heard_share(text, heard):
    """(share of the text's words heard, the words missing, (start off, end off)) of a line and what was heard of it"""
    hw, w = words(heard), words(text)
    h = set(hw)
    miss = [x for x in w if x not in h]
    ends = (hw[:1] != w[:1] and hw[:2] != w[:2], hw[-1:] != w[-1:] and hw[-2:] != w[-2:])
    return 1 - len(miss) / max(1, len(w)), miss, ends


def loudness_and_silences(cut, silence_db, silence_s):
    """(integrated LUFS, [seconds of each silence longer than silence_s under silence_db])"""
    err = subprocess.run(['ffmpeg', '-nostdin', '-i', str(cut), '-af', f'ebur128=peak=true,silencedetect=n={silence_db}dB:d={silence_s}',
                          '-f', 'null', '-'], capture_output=True, text=True).stderr
    found = re.findall(r'I:\s+(-?[\d.]+) LUFS', err)
    if not found:
        raise SystemExit(f'ffmpeg measured no loudness in {cut}: {err.strip()[-300:]}')
    return float(found[-1]), [float(x) for x in re.findall(r'silence_duration: ([\d.]+)', err)]


def write_report(path, result):
    """the report, keeping listened_by as a person set it (null until one does)"""
    listened_by = json.loads(path.read_text()).get('listened_by') if path.exists() else None
    path.write_text(json.dumps({**result, 'listened_by': listened_by}, indent=1))
    return listened_by


def frame_picks(segs, picks):
    """[(n, segment index)] for picks such as answer:middle; a kind with no segment is skipped"""
    out = []
    for pick in picks:
        kind, _, which = pick.partition(':')
        found = [i for i, s in enumerate(segs) if s['kind'] == kind]
        if not found:
            continue
        if which not in ('first', 'middle', 'last'):
            raise SystemExit(f'--frames {pick}: say first, middle or last')
        out.append({'first': found[0], 'middle': found[len(found) // 2], 'last': found[-1]}[which])
    return list(enumerate(out, 1))


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__.split('\n')[0])
    ap.add_argument('--cut', required=True)
    ap.add_argument('--timeline', required=True, help='the cut\'s timeline.json: [{seg, kind, text, start, dur}]')
    ap.add_argument('--work', required=True, help='the folder the frames and the report go to')
    ap.add_argument('--report', help='the report file (default <work>/verify.json)')
    ap.add_argument('--kinds', default='', help='comma list: the segment kinds that are spoken and read (default: every kind)')
    ap.add_argument('--always-show', default='', help='comma list: kinds whose reading is always listed')
    ap.add_argument('--share-below', type=float, default=0.9, help='list a segment when less than this share of its words is heard')
    ap.add_argument('--silence-db', type=float, default=-60.0)
    ap.add_argument('--silence-s', type=float, default=1.0)
    ap.add_argument('--frames', default='', help='comma list of kind:first|middle|last')
    ap.add_argument('--frame-width', type=int, default=960)
    add_reader_options(ap)
    a = ap.parse_args(argv)
    work = Path(a.work)
    work.mkdir(parents=True, exist_ok=True)
    segs = json.loads(Path(a.timeline).read_text())
    kinds = {k for k in a.kinds.split(',') if k}
    show = {k for k in a.always_show.split(',') if k}
    lufs, silences = loudness_and_silences(a.cut, a.silence_db, a.silence_s)
    print(Path(a.cut).name, f'LUFS {lufs}', f'silences over {a.silence_s:g} s:', silences or 'none')
    read, listed, rows = None, [], []
    with tempfile.TemporaryDirectory() as tmp:
        for i, s in enumerate(segs):
            if kinds and s['kind'] not in kinds or not s.get('text'):
                continue
            read = read or reader_of(a)
            wav = Path(tmp) / f'{i}.wav'
            subprocess.run(['ffmpeg', '-nostdin', '-y', '-loglevel', 'error', '-ss', f"{s['start']:.3f}", '-t', f"{s['dur']:.3f}", '-i', str(a.cut),
                            '-vn', '-ac', '1', '-ar', '16000', str(wav)], check=True)
            heard = read(wav)
            share, miss, (lead, trail) = heard_share(s['text'], heard)
            row = {'seg': s.get('seg', i), 'kind': s['kind'], 'share': round(share, 3), 'missing': miss, 'start_off': lead, 'end_off': trail, 'heard': heard}
            rows.append(row)
            if s['kind'] in show or share < a.share_below or lead or trail:
                hw = words(heard)
                print(f"  {s['kind']} seg {i} {share:.0%}", f'missing {miss[:8]}' if miss else '', f'HEARD STARTS {hw[:3]}' if lead else '',
                      f'HEARD ENDS {hw[-3:]}' if trail else '')
                if share < a.share_below or lead or trail:
                    listed.append(i)
    shots = []
    for n, i in frame_picks(segs, [p for p in a.frames.split(',') if p]):
        out = work / f'frame{n}.jpg'
        subprocess.run(['ffmpeg', '-nostdin', '-y', '-loglevel', 'error', '-ss', f"{segs[i]['start'] + segs[i]['dur'] * 0.5:.2f}", '-i', str(a.cut),
                        '-frames:v', '1', '-vf', f'scale={a.frame_width}:-2', str(out)], check=True)
        shots.append(out)
    if len(shots) > 1:
        subprocess.run(['ffmpeg', '-nostdin', '-y', '-loglevel', 'error', *sum([['-i', str(p)] for p in shots], []),
                        '-filter_complex', f'{"".join(f"[{k}]" for k in range(len(shots)))}hstack=inputs={len(shots)}', str(work / 'frames.jpg')], check=True)
    report = Path(a.report) if a.report else work / 'verify.json'
    listened_by = write_report(report, {'cut': str(a.cut), 'lufs': lufs, 'silences': silences, 'segments': rows})
    print(f'  listened_by {listened_by}' if listened_by else '  listened_by null: nobody has listened to this cut end to end')
    print(json.dumps({'result': {'report': str(report), 'lufs': lufs, 'silences': silences, 'to_check': listed,
                                 'frames': [str(p) for p in shots], 'listened_by': listened_by}}))
    return 2 if listed else 0


if __name__ == '__main__':
    sys.exit(main())
