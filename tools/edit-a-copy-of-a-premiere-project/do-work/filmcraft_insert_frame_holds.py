#!/usr/bin/env python3
"""Copy a FilmCraft project and insert corrections as editable clips.

For each shot in <shots folder>/<id>.json, at the source frame where its freeze plate was cut:
  - ripple-insert a frame-hold segment of the same source clip (FilmCraft's Insert Frame Hold Segment:
    source_in = hold, frame_hold = hold, the clip's own effects, so its grade applies);
  - extend the adjustment layer over the inserted span;
  - place the overlay (ProRes 4444) on V3, the narrator WAV on A2 and the music + sound effects WAV on A3.

Each shot's three files are <out folder>/<id>/<id>-overlay-prores4444.mov, <id>-narrator.wav and <id>-sfx-music.wav.

Usage: filmcraft_insert_frame_holds.py <in.fcproj> <out.fcproj> --shots <folder> --out <folder> <shot-id> [<shot-id> ...]
The last line is {"result": {...}} or {"error": "what to change"}.
"""
import argparse
import copy
import json
import os
import subprocess
import sys

TPS = 254016000000  # FilmCraft ticks per second
# FilmCraft's own label colours for the three inserted files
OVERLAY_LABEL, NARRATOR_LABEL, MUSIC_LABEL = 'Rose', 'Caribbean', 'Mango'


class Refusal(Exception):
    """A request the tool cannot carry out; the message says what to change."""


def probe(path):
    out = subprocess.run(['ffprobe', '-v', 'error', '-show_entries', 'format=duration,size,bit_rate:stream=codec_type,codec_name,width,height,pix_fmt,sample_rate,channels,bits_per_raw_sample',
                          '-of', 'json', path], check=True, capture_output=True, text=True).stdout
    return json.loads(out)


def media_item(iid, path, label, rate):
    pr = probe(path)
    fmt = pr['format']
    v = next((s for s in pr['streams'] if s['codec_type'] == 'video'), None)
    a = next((s for s in pr['streams'] if s['codec_type'] == 'audio'), None)
    video = None
    if v:
        alpha = 'yuva' in v['pix_fmt']
        video = {'width': v['width'], 'height': v['height'], 'frame_rate': rate, 'par': [1, 1],
                 'codec': 'Apple ProRes 4444' if alpha else 'Apple ProRes 422 HQ',
                 'pixel_format': 'YUVA 4:4:4 12-bit' if alpha else 'YUV 4:2:2 10-bit',
                 'color': {'matrix': 'Bt709', 'transfer': 'Bt709', 'primaries': 'Bt709', 'range': 'Limited'},
                 'has_alpha': alpha, 'bitrate': int(fmt.get('bit_rate', 0))}
    audio = None
    if a:
        audio = {'sample_rate': int(a['sample_rate']), 'channels': a['channels'], 'codec': 'PCM', 'bits_per_sample': int(a.get('bits_per_raw_sample') or 24)}
    name = os.path.basename(path)
    return {'id': iid, 'name': name, 'label': label,
            'kind': {'Media': {'media': {'File': {'path': path}},
                               'info': {'name': name, 'kind': 'Movie' if v else 'AudioOnly', 'duration': round(float(fmt['duration']) * TPS),
                                        'video': video, 'audio': audio, 'container': 'QuickTime' if v else 'WAV', 'start_timecode': None,
                                        'file_size': int(fmt['size'])},
                               'interpret': {'frame_rate': None, 'par': None, 'ignore_alpha': False, 'invert_alpha': False},
                               'mark_in': None, 'mark_out': None, 'markers': [], 'offline': False, 'proxy': None}},
            'metadata': {}, 'created': iid}


def insert_frame_holds(d, shots, shots_folder, out_folder, sequence_suffix=' + corrections'):
    """Insert every shot into the project d (a parsed .fcproj); returns one log line per shot."""
    p = d['project']
    seq_item = next(v for v in p['items'].values() if 'Sequence' in v['kind'])
    seq = seq_item['kind']['Sequence']
    rate = seq['settings']['frame_rate']
    fd = TPS * rate['den'] // rate['num']
    vt, at = seq['video_tracks'], seq['audio_tracks']
    adj_id = next(k for k, v in p['items'].items() if 'AdjustmentLayer' in v['kind'])
    template_v = copy.deepcopy(vt[1]['items'][0])  # adjustment clip: motion + opacity defaults
    template_v['effects'] = [e for e in template_v['effects'] if e['effect'] in ('motion', 'opacity')]
    audio_fx = [{'effect': 'volume', 'enabled': True, 'params': {'bypass': {'value': {'Bool': False}}, 'level': {'value': {'Float': 0.0}}}},
                {'effect': 'channel_volume', 'enabled': True, 'params': {'bypass': {'value': {'Bool': False}}, 'left': {'value': {'Float': 0.0}}, 'right': {'value': {'Float': 0.0}}}},
                {'effect': 'panner', 'enabled': True, 'params': {'balance': {'value': {'Float': 0.0}}}}]

    def alloc():
        p['next_id'] += 1
        return p['next_id'] - 1

    media_path = {}
    for k, v in p['items'].items():
        if 'Media' in v['kind'] and 'File' in v['kind']['Media']['media']:
            media_path[v['kind']['Media']['media']['File']['path']] = int(k)

    log = []
    for sid in shots:
        shot_file = os.path.join(shots_folder, sid + '.json')
        if not os.path.isfile(shot_file):
            raise Refusal(f'shot {sid}: {shot_file} does not exist; name a shot file in --shots')
        with open(shot_file) as f:
            shot = json.load(f)
        out = os.path.join(out_folder, sid)
        overlay = os.path.join(out, f'{sid}-overlay-prores4444.mov')
        narrator = os.path.join(out, f'{sid}-narrator.wav')
        stem = os.path.join(out, f'{sid}-sfx-music.wav')
        for need in (overlay, narrator, stem):
            if not os.path.isfile(need):
                raise Refusal(f'shot {sid}: {need} does not exist; render the shot into --out first')
        if shot['plate']['source'] not in media_path:
            raise Refusal(f'shot {sid}: the plate source {shot["plate"]["source"]} is not a media file of the project')
        frames = int(subprocess.run(['ffprobe', '-v', 'error', '-select_streams', 'v', '-count_packets', '-show_entries', 'stream=nb_read_packets', '-of', 'csv=p=0', overlay],
                                    check=True, capture_output=True, text=True).stdout.strip())
        dur = frames * fd
        item = media_path[shot['plate']['source']]
        hold = shot['plate']['frame'] * fd
        host = next((c for c in vt[0]['items'] if c['item'] == item and c['source_in'] <= hold < c['source_in'] + c['duration']), None)
        if host is None:
            raise Refusal(f'shot {sid}: no clip on the first video track holds source frame {shot["plate"]["frame"]} of the plate source')
        t = host['start'] + (hold - host['source_in'])
        # ripple: razor every clip that spans t, shift everything at or after t by dur
        new_links = {}
        for tr in vt + at:
            keep = []
            for c in tr['items']:
                if c['start'] >= t:
                    c['start'] += dur
                elif c['start'] + c['duration'] > t:
                    if c['item'] == int(adj_id):
                        c['duration'] += dur
                    else:
                        right = copy.deepcopy(c)
                        right['id'] = alloc()
                        cut = t - c['start']
                        right['start'] = t + dur
                        right['source_in'] = c['source_in'] + round(cut * c['speed'])
                        right['duration'] = c['duration'] - cut
                        if c['link'] is not None:
                            right['link'] = new_links.setdefault(c['link'], alloc())
                        c['duration'] = cut
                        keep.append(right)
                keep.append(c)
            tr['items'] = sorted(keep, key=lambda c: c['start'])
        seg = copy.deepcopy(host)
        seg.update(id=alloc(), start=t, duration=dur, source_in=hold, frame_hold=hold, link=None, markers=[])
        vt[0]['items'] = sorted(vt[0]['items'] + [seg], key=lambda c: c['start'])
        # overlay + two audio stems
        for path, track, label in ((overlay, vt[2], OVERLAY_LABEL), (narrator, at[1], NARRATOR_LABEL), (stem, at[2], MUSIC_LABEL)):
            iid = alloc()
            p['items'][str(iid)] = media_item(iid, path, label, rate)
            p['root']['children'].append({'Item': iid})
            clip = copy.deepcopy(template_v) if track in vt else {'gain_db': 0.0, 'frame_hold': None, 'scale_to_frame': False}
            clip.update(id=alloc(), item=iid, name=os.path.basename(path), label=label, start=t, duration=dur, source_in=0, speed=1.0, reverse=False,
                        enabled=True, link=None, group=None, markers=[], gain_db=0.0, frame_hold=None, scale_to_frame=False)
            if track not in vt:
                clip['effects'] = copy.deepcopy(audio_fx)
            track['items'] = sorted(track['items'] + [clip], key=lambda c: c['start'])
        line = f'{sid}: inserted {frames} frames ({dur / TPS:.3f} s) at {t / TPS:.3f} s, hold = source frame {shot["plate"]["frame"]}'
        print(line)
        log.append({'shot': sid, 'frames': frames, 'seconds': round(dur / TPS, 3), 'at_seconds': round(t / TPS, 3), 'hold_frame': shot['plate']['frame']})
    seq_item['name'] = seq_item['name'] + sequence_suffix
    return log


def main():
    ap = argparse.ArgumentParser(description=__doc__.split('\n\n')[0])
    ap.add_argument('project_in')
    ap.add_argument('project_out')
    ap.add_argument('--shots', required=True, help='folder of <shot id>.json files')
    ap.add_argument('--out', required=True, help='folder holding <shot id>/<shot id>-overlay-prores4444.mov, -narrator.wav, -sfx-music.wav')
    ap.add_argument('--sequence-suffix', default=' + corrections', help='added to the sequence name')
    ap.add_argument('shot_ids', nargs='+')
    a = ap.parse_args()
    try:
        if os.path.abspath(a.project_in) == os.path.abspath(a.project_out):
            raise Refusal('the output project must be a new file, not the input project')
        with open(a.project_in) as f:
            d = json.load(f)
        d['project']['name'] = os.path.splitext(os.path.basename(a.project_out))[0]
        log = insert_frame_holds(d, a.shot_ids, a.shots, a.out, a.sequence_suffix)
        with open(a.project_out, 'w') as f:
            json.dump(d, f, separators=(',', ':'))
    except Refusal as e:
        print(json.dumps({'error': str(e)}))
        return 2
    print(json.dumps({'result': {'output': a.project_out, 'inserts': log}}))
    return 0


if __name__ == '__main__':
    sys.exit(main())
