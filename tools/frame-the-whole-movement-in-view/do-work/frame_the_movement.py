#!/usr/bin/env python3
"""frame-the-whole-movement-in-view: keeps the whole movement inside the picture on every frame of a shot.

The law (video_style_laws the-whole-movement-stays-in-view): the number of frames where the subject's box or its
implement's box crosses the picture edge is 0. The layouts are the request's rows, tried in the request's order:

  measure  (request command) detects the subject and its implement on every sampled frame of each shot and writes the boxes
                     (out/boxes.json). A subject is the largest box of the subject class; an implement box counts when it
                     is near the subject box.
  gate     (request command) reads framing.json; exits 1 unless the gate passes, so the workflow goes back to the choice.
  choose   (request command) for each shot, every layout's window and the frames whose boxes cross that window's edge. The layout
                     picked is the first in the request's order with 0 such frames. Writes out/framing.json, whose
                     out_of_view_frames is the gate's count (0 passes; a shot with no passing layout is named and fails).

A layout is {name, aspect, sizing}: sizing 'full-height' is the whole source height at that aspect (its zoom is
out_h / window_h and must not exceed max_zoom); sizing 'around-movement' is the smallest window at that aspect that holds
the shot's whole extent plus margin, capped at the source; sizing 'follow' is a window at that aspect per frame, holding
the boxes of the frames within follow_window_frames of it, so it moves and widens with the movement.

The request's command is measure or choose. Run it under taskpolicy, one at a time. measure refuses while the 1-minute load is
LOAD_CEILING or more.
"""
import argparse
import json
import os
import subprocess
import sys

import numpy as np

LOAD_CEILING = 120.0
DETECT_SCALE = 0.5


def _guard_load():
    load = os.getloadavg()[0]
    if load >= LOAD_CEILING:
        raise SystemExit(f'load {load:.0f} is at or above {LOAD_CEILING:.0f}; wait for the Mac to quiet, then run again')


def _read(path):
    with open(path) as f:
        return json.load(f)


def _write(path, data):
    os.makedirs(os.path.dirname(os.path.abspath(path)), exist_ok=True)
    with open(path, 'w') as f:
        json.dump(data, f, indent=1)


def source_size(video):
    out = subprocess.run(['ffprobe', '-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=width,height',
                          '-of', 'csv=p=0', video], capture_output=True, text=True, check=True).stdout.strip()
    w, h = out.split(',')[:2]
    return int(w), int(h)


def _frames(video, start, duration, sample_fps, width, height):
    size = width * height * 3
    proc = subprocess.Popen(['ffmpeg', '-v', 'error', '-ss', str(start), '-t', str(duration), '-i', video,
                             '-vf', f'fps={sample_fps},scale={width}:{height}', '-f', 'rawvideo', '-pix_fmt', 'bgr24', '-'],
                            stdout=subprocess.PIPE)
    try:
        while True:
            raw = proc.stdout.read(size)
            if len(raw) < size:
                break
            yield np.frombuffer(raw, np.uint8).reshape(height, width, 3).copy()
    finally:
        proc.stdout.close()
        if proc.wait() != 0:
            raise RuntimeError(f'ffmpeg could not decode {video} from {start}s')


def frame_boxes(result, subject_class, implement_class, conf, scale, near):
    """Subject box (largest subject-class box) and the union with implement-class boxes near it, in source pixels, or None."""
    if result.boxes is None or not len(result.boxes):
        return None
    cls = result.boxes.cls.cpu().numpy()
    xy = result.boxes.xyxy.cpu().numpy() / scale
    people = xy[(cls == subject_class)]
    if not len(people):
        return None
    subject = people[np.argmax((people[:, 2] - people[:, 0]) * (people[:, 3] - people[:, 1]))]
    parts = [subject]
    for box in xy[cls == implement_class]:
        if box[0] < subject[2] + near and box[2] > subject[0] - near:
            parts.append(box)
    stacked = np.array(parts)
    return {'subject': [float(v) for v in subject],
            'extent': [float(stacked[:, 0].min()), float(stacked[:, 1].min()), float(stacked[:, 2].max()), float(stacked[:, 3].max())]}


def measure(request):
    from ultralytics import YOLO
    _guard_load()
    src_w, src_h = source_size(request['video'])
    model = YOLO(request['model'])
    w, h = int(src_w * DETECT_SCALE), int(src_h * DETECT_SCALE)
    shots = []
    for shot in request['shots']:
        duration = (shot['end'] - shot['start']) / shot.get('slow', 1)
        frames = []
        for index, frame in enumerate(_frames(request['video'], shot['start'], duration, request['sample_fps'], w, h)):
            r = model.predict(frame, classes=[request['subject_class'], request['implement_class']], verbose=False,
                              imgsz=request['imgsz'], conf=request['conf'])[0]
            found = frame_boxes(r, request['subject_class'], request['implement_class'], request['conf'], DETECT_SCALE,
                                request['near_px'])
            frames.append({'t': round(index / request['sample_fps'], 3), 'box': found and found['extent'],
                           'subject': found and found['subject']})
        shots.append({'id': shot['id'], 'start': shot['start'], 'end': shot['end'], 'slow': shot.get('slow', 1), 'frames': frames})
    out = {'video': request['video'], 'source': [src_w, src_h], 'sample_fps': request['sample_fps'], 'shots': shots}
    _write(os.path.join(request['out'], 'boxes.json'), out)
    return out


def _inside(box, window):
    return box[0] >= window[0] and box[1] >= window[1] and box[2] <= window[0] + window[2] and box[3] <= window[1] + window[3]


def _clamp_origin(centre, size, limit):
    return min(max(centre - size / 2, 0.0), limit - size)


def _static_window(layout, extent, src_w, src_h, margin):
    aspect = layout['aspect']
    if layout['sizing'] == 'full-height':
        win_h = float(src_h)
        win_w = win_h * aspect
        if win_w > src_w:
            return None
    elif layout['sizing'] == 'movement-shape':
        x0, y0, x1, y1 = extent
        ext_w, ext_h = (x1 - x0) * (1 + 2 * margin), (y1 - y0) * (1 + 2 * margin)
        if ext_w > src_w or ext_h > src_h:
            return None
        aspect = ext_w / ext_h
        win_h = min(float(src_h), src_w / aspect)
        win_w = win_h * aspect
    else:
        x0, y0, x1, y1 = extent
        ext_w, ext_h = (x1 - x0) * (1 + 2 * margin), (y1 - y0) * (1 + 2 * margin)
        win_h = max(ext_h, ext_w / aspect)
        win_w = win_h * aspect
        if win_w > src_w:
            win_w = float(src_w)
            win_h = win_w / aspect
        if win_h > src_h:
            return None
    cx, cy = (extent[0] + extent[2]) / 2, (extent[1] + extent[3]) / 2
    return [_clamp_origin(cx, win_w, src_w), _clamp_origin(cy, win_h, src_h), win_w, win_h]


def _follow_windows(layout, boxes, src_w, src_h, margin, reach):
    """One window per frame: the smallest at the aspect holding the boxes of the frames within reach of it."""
    n = len(boxes)
    windows = []
    for i in range(n):
        near = [b for b in boxes[max(0, i - reach):i + reach + 1] if b is not None]
        if not near:
            windows.append(None)
            continue
        x0 = min(b[0] for b in near); y0 = min(b[1] for b in near)
        x1 = max(b[2] for b in near); y1 = max(b[3] for b in near)
        ext_w, ext_h = (x1 - x0) * (1 + 2 * margin), (y1 - y0) * (1 + 2 * margin)
        win_h = max(ext_h, ext_w / layout['aspect'])
        win_w = win_h * layout['aspect']
        if win_h > src_h or win_w > src_w:
            windows.append(None)
            continue
        cx, cy = (x0 + x1) / 2, (y0 + y1) / 2
        windows.append([_clamp_origin(cx, win_w, src_w), _clamp_origin(cy, win_h, src_h), win_w, win_h])
    return windows


def _out_of_view(boxes, windows):
    """Frames whose box crosses a window's edge; a frame with no box or no window is counted as out of view."""
    count = 0
    for box, window in zip(boxes, windows):
        if box is None:
            continue
        if window is None or not _inside(box, window):
            count += 1
    return count


def _text_room_fits(layout, window, out_w, out_h, safe, room):
    """A layout keeps text room when one of its graphic areas holds the room's width and height (output pixels)."""
    if room is None:
        return True
    return any(aw >= room[0] and ah >= room[1] for _, _, aw, ah in graphic_areas(layout['name'], window, out_w, out_h, safe))


def _candidate(layout, shot, src_w, src_h, out_w, out_h, margin, reach, max_zoom, reference=None, text_room=None, safe=60):
    boxes = [f['box'] for f in shot['frames']]
    known = [b for b in boxes if b is not None]
    if not known:
        return {'layout': layout['name'], 'fits': False, 'out_of_view_frames': len(boxes), 'why': 'no subject found'}
    extent = [min(b[0] for b in known), min(b[1] for b in known), max(b[2] for b in known), max(b[3] for b in known)]
    if layout.get('needs_reference') and not reference:
        return {'layout': layout['name'], 'fits': False, 'out_of_view_frames': len(boxes), 'window': None,
                'why': 'this layout compares with a reference clip, and the request names none'}
    if layout['sizing'] == 'follow':
        windows = _follow_windows(layout, boxes, src_w, src_h, margin, reach)
        zoom = [out_h / win[3] for win in windows if win is not None]
        window = None
    else:
        window = _static_window(layout, extent, src_w, src_h, margin)
        windows = [window] * len(boxes)
        if window and layout['sizing'] == 'full-height':
            zoom = [out_h / window[3]]
        else:
            zoom = [out_w / window[2]] if window else []
    if window is None and layout['sizing'] != 'follow':
        return {'layout': layout['name'], 'fits': False, 'out_of_view_frames': len(boxes), 'window': None,
                'why': 'the window at this aspect does not fit the source'}
    if zoom and max(zoom) > max_zoom:
        return {'layout': layout['name'], 'fits': False, 'out_of_view_frames': _out_of_view(boxes, windows),
                'window': window, 'zoom': round(max(zoom), 3), 'why': f'zoom above {max_zoom}'}
    count = _out_of_view(boxes, windows)
    if not _text_room_fits(layout, window, out_w, out_h, safe, text_room):
        return {'layout': layout['name'], 'fits': False, 'out_of_view_frames': count, 'window': window,
                'why': f'no graphic area holds the text room {text_room[0]} by {text_room[1]} px'}
    return {'layout': layout['name'], 'fits': count == 0, 'out_of_view_frames': count, 'window': window,
            'zoom': round(max(zoom), 3) if zoom else None, 'extent': [int(v) for v in extent],
            'undetected_frames': len(boxes) - len(known)}


def graphic_areas(layout, window, out_w, out_h, safe, band_top=None):
    """Output-pixel rectangles [x, y, w, h] where graphics, captions and the chip may go without touching the picture.
    A layout that fills the frame gives none. The wide layout shows the window at full width in the middle, so the bars
    above and below it are the areas (inside the safe margin); the picture itself is never a graphic area. band_top is the
    output y where the window starts (the request's band_top); without it the window is centred."""
    if layout == 'full-bleed-9x16' or window is None:
        return []
    if layout == 'follow-and-widen':
        return []
    if layout == 'wide-with-blurred-bars':
        shown_h = out_w * window[3] / window[2]
        top = (out_h - shown_h) / 2 if band_top is None else band_top
        bottom = top + shown_h
        areas = []
        if top - safe > 0:
            areas.append([0, safe, out_w, int(top - 2 * safe)])
        if out_h - bottom - safe > 0:
            areas.append([0, int(bottom + safe), out_w, int(out_h - bottom - 2 * safe)])
        return [[int(v) for v in area] for area in areas if area[3] > 0]
    if layout == 'stacked-synced-comparison':
        return []
    raise SystemExit(f'no graphic areas rule for layout {layout!r}')


def choose(request):
    boxes = _read(os.path.join(request['out'], 'boxes.json'))
    src_w, src_h = boxes['source']
    out_w, out_h = request['output']
    results = []
    for shot in boxes['shots']:
        room = request.get('text_room', {}).get(shot['id'])
        candidates = [_candidate(layout, shot, src_w, src_h, out_w, out_h, request['margin'], request['follow_window_frames'],
                                 request['max_zoom'], request.get('reference'), room, request['safe_margin_px'])
                      for layout in request['layouts']]
        passing = [c for c in candidates if c['fits']]
        picked = passing[0] if passing else None
        results.append({'id': shot['id'], 'picked': picked and picked['layout'], 'window': picked and picked['window'],
                        'out_of_view_frames': picked['out_of_view_frames'] if picked else None,
                        'graphic_areas': picked and graphic_areas(picked['layout'], picked['window'], out_w, out_h, request['safe_margin_px'], request.get('band_top')),
                        'candidates': candidates, 'frames': len(shot['frames'])})
    gate = {'out_of_view_frames': sum(r['out_of_view_frames'] or 0 for r in results),
            'unpicked_shots': [r['id'] for r in results if r['picked'] is None]}
    gate['passes'] = gate['out_of_view_frames'] == 0 and not gate['unpicked_shots']
    out = {'source': [src_w, src_h], 'output': [out_w, out_h], 'shots': results, 'gate': gate}
    _write(os.path.join(request['out'], 'framing.json'), out)
    return out


def gate(request):
    """Reads out/framing.json from choose. Exits 1 unless every shot is picked with 0 frames out of view."""
    framing = _read(os.path.join(request['out'], 'framing.json'))
    result = {'out_of_view_frames': framing['gate']['out_of_view_frames'], 'unpicked_shots': framing['gate']['unpicked_shots'],
              'passes': framing['gate']['passes']}
    print(json.dumps(result))
    if not result['passes']:
        raise SystemExit(1)
    return result


def main(argv):
    parser = argparse.ArgumentParser(description=__doc__.split('\n')[0])
    parser.add_argument('--request', required=True, help='request JSON file; its command is measure or choose')
    args = parser.parse_args(argv)
    request = _read(args.request)
    if request['command'] == 'measure':
        result = measure(request)
        print(json.dumps({'shots': len(result['shots']), 'out': request['out']}))
    elif request['command'] == 'choose':
        print(json.dumps(choose(request)))
    elif request['command'] == 'gate':
        gate(request)
    else:
        raise SystemExit(f"unknown command {request['command']!r}: measure, choose or gate")
    return 0


if __name__ == '__main__':
    sys.exit(main(sys.argv[1:]))
