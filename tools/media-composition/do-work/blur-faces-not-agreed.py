#!/usr/bin/env python3
"""
blur-faces-not-agreed.py: make a copy of a video in which every face is blurred except the faces of the people who
agreed to be filmed, and every word said by anyone else is silenced. The original is never changed. As with faces,
anyone not shown to have agreed is hidden: without agreed voices every word is silenced, and a video with no speech
keeps its sound as it is.

Faces are found in every frame with YuNet (OpenCV Zoo, MIT) and recognized with SFace (OpenCV Zoo, Apache 2.0), both
ONNX through onnxruntime, so the container needs no OpenCV. A face is kept only when it matches one of the agreed
pictures closely enough (cosine similarity at least `match`, 0.363 by default, the SFace threshold); anything less is
blurred, so an unknown or uncertain face is never shown. A face stays blurred for a few frames after the detector last
saw it, so a missed frame never shows it.

Voices are told apart with the CAM++ voice model the container already holds (find-recurring-voices.py): speech
(webrtcvad) is compared with the agreed recordings in 1.5 s windows every half second, and each half second whose
windows do not all match one of them (cosine below `voice_match`, 0.5 by default) is silenced; speech too short to
judge (under a second) is silenced too.

Reads the tool's input as one JSON object on stdin:
  video          the video, as the local path the container was given
  agreed         pictures of the people who agreed, as local paths (each picture's largest face is theirs)
  agreed_voices  optional recordings of each person who agreed speaking, as local paths; with none, all speech is silenced
  voice_match    optional cosine similarity a stretch of speech must reach to be kept
  match          optional cosine similarity a face must reach to be kept
  out, models    optional, for running it by hand: where to write the copy and { detector, recognizer, voice } model paths
Writes the copy to OUT (the tool's output) unless `out` says otherwise.
Prints one JSON line, which the tool keeps as its result: { frames, seconds, width, height, faces, blurred, kept,
agreed_faces, pictures_without_a_face, agreed_voices, silenced, silenced_seconds, video_bytes }.
"""
import importlib.util
import json
import os
import subprocess
import sys

import numpy as np
import onnxruntime as ort
from PIL import Image, ImageFilter

ort.set_default_logger_severity(3)

SIDE = 640                       # YuNet 2023mar takes a fixed 640x640 picture
STRIDES = (8, 16, 32)
SCORE = 0.6                      # a detection below this is not a face
NMS_IOU = 0.3
KEEP_BLURRED_FRAMES = 6          # frames a face stays blurred after it was last seen
RECOGNIZE_EVERY = 15             # frames between recognizing the same tracked face again
OUT = '/opt/media-composition/out/blurred.mp4'
MODELS = {'detector': '/opt/models/faces/face_detection_yunet_2023mar.onnx', 'recognizer': '/opt/models/faces/face_recognition_sface_2021dec.onnx'}
TEMPLATE = np.array([[38.2946, 51.6963], [73.5318, 51.5014], [56.0252, 71.7366], [41.5493, 92.3655], [70.7299, 92.2041]], dtype=np.float64)


class Faces:
    def __init__(self, detector, recognizer):
        self.detector = ort.InferenceSession(detector, providers=['CPUExecutionProvider'])
        self.recognizer = ort.InferenceSession(recognizer, providers=['CPUExecutionProvider'])
        self.grids = {}
        for stride in STRIDES:
            cells = SIDE // stride
            rows, cols = np.divmod(np.arange(cells * cells), cells)
            self.grids[stride] = (cols.astype(np.float32), rows.astype(np.float32))

    def find(self, rgb):
        """Faces in an RGB picture (H, W, 3 uint8): rows of [x1, y1, x2, y2, score, 10 landmark coordinates]."""
        height, width = rgb.shape[:2]
        scale = SIDE / max(height, width)
        shown = np.asarray(Image.fromarray(rgb).resize((max(1, round(width * scale)), max(1, round(height * scale))), Image.BILINEAR))
        board = np.zeros((SIDE, SIDE, 3), dtype=np.float32)
        board[:shown.shape[0], :shown.shape[1]] = shown[:, :, ::-1]  # the model reads BGR, 0..255
        out = dict(zip([o.name for o in self.detector.get_outputs()], self.detector.run(None, {'input': board.transpose(2, 0, 1)[None]})))
        found = []
        for stride in STRIDES:
            cols, rows = self.grids[stride]
            score = np.sqrt(np.clip(out[f'cls_{stride}'][0, :, 0], 0, 1) * np.clip(out[f'obj_{stride}'][0, :, 0], 0, 1))
            pick = score >= SCORE
            if not pick.any():
                continue
            box, kps = out[f'bbox_{stride}'][0][pick], out[f'kps_{stride}'][0][pick]
            cx, cy = (cols[pick] + box[:, 0]) * stride, (rows[pick] + box[:, 1]) * stride
            w, h = np.exp(box[:, 2]) * stride, np.exp(box[:, 3]) * stride
            marks = np.empty_like(kps)
            marks[:, 0::2] = (kps[:, 0::2] + cols[pick][:, None]) * stride
            marks[:, 1::2] = (kps[:, 1::2] + rows[pick][:, None]) * stride
            found.append(np.column_stack([cx - w / 2, cy - h / 2, cx + w / 2, cy + h / 2, score[pick], marks]))
        if not found:
            return np.zeros((0, 15), dtype=np.float32)
        faces = np.concatenate(found)
        faces = faces[nms(faces[:, :4], faces[:, 4], NMS_IOU)]
        faces[:, :4] /= scale
        faces[:, 5:] /= scale
        return faces

    def print_of(self, rgb, face):
        """The face's 128-number print, its length 1, from the picture aligned to SFace's template by its landmarks."""
        landmarks = face[5:15].reshape(5, 2).astype(np.float64)
        matrix = similarity(landmarks, TEMPLATE)
        inverse = np.linalg.inv(np.vstack([matrix, [0, 0, 1]]))[:2]
        aligned = Image.fromarray(rgb).transform((112, 112), Image.AFFINE, tuple(inverse.flatten()), resample=Image.BILINEAR)
        blob = np.asarray(aligned, dtype=np.float32).transpose(2, 0, 1)[None]  # SFace reads RGB, 0..255
        vector = self.recognizer.run(None, {'data': blob})[0][0]
        return vector / (np.linalg.norm(vector) or 1.0)


def nms(boxes, scores, threshold):
    order = scores.argsort()[::-1]
    keep = []
    while order.size:
        first = order[0]
        keep.append(first)
        rest = order[1:]
        x1 = np.maximum(boxes[first, 0], boxes[rest, 0])
        y1 = np.maximum(boxes[first, 1], boxes[rest, 1])
        x2 = np.minimum(boxes[first, 2], boxes[rest, 2])
        y2 = np.minimum(boxes[first, 3], boxes[rest, 3])
        inter = np.clip(x2 - x1, 0, None) * np.clip(y2 - y1, 0, None)
        area = lambda b: (b[..., 2] - b[..., 0]) * (b[..., 3] - b[..., 1])
        order = rest[inter / (area(boxes[first]) + area(boxes[rest]) - inter + 1e-9) <= threshold]
    return np.array(keep, dtype=int)


def similarity(source, target):
    """The 2x3 similarity transform (rotation, one scale, shift) taking source points onto target points (Umeyama)."""
    source_mean, target_mean = source.mean(0), target.mean(0)
    s, t = source - source_mean, target - target_mean
    u, d, vt = np.linalg.svd(t.T @ s / len(source))
    sign = np.eye(2)
    if np.linalg.det(u) * np.linalg.det(vt) < 0:
        sign[1, 1] = -1
    rotation = u @ sign @ vt
    scale = np.trace(np.diag(d) @ sign) / s.var(0).sum()
    shift = target_mean - scale * rotation @ source_mean
    return np.column_stack([scale * rotation, shift])


def iou(a, b):
    x1, y1, x2, y2 = max(a[0], b[0]), max(a[1], b[1]), min(a[2], b[2]), min(a[3], b[3])
    inter = max(0.0, x2 - x1) * max(0.0, y2 - y1)
    return inter / ((a[2] - a[0]) * (a[3] - a[1]) + (b[2] - b[0]) * (b[3] - b[1]) - inter + 1e-9)


def blur(frame, box):
    """Blurs a face past recognition: its area (a fifth larger each way) shrunk to a few pixels and smoothed back."""
    height, width = frame.shape[:2]
    pad_x, pad_y = (box[2] - box[0]) * 0.2, (box[3] - box[1]) * 0.2
    x1, y1 = max(0, int(box[0] - pad_x)), max(0, int(box[1] - pad_y))
    x2, y2 = min(width, int(box[2] + pad_x)), min(height, int(box[3] + pad_y))
    if x2 - x1 < 2 or y2 - y1 < 2:
        return
    area = Image.fromarray(frame[y1:y2, x1:x2])
    small = area.resize((max(1, (x2 - x1) // 16), max(1, (y2 - y1) // 16)), Image.BILINEAR)
    frame[y1:y2, x1:x2] = np.asarray(small.resize(area.size, Image.BILINEAR).filter(ImageFilter.GaussianBlur(max(2, (x2 - x1) // 10))))


def voices_module():
    here = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'find-recurring-voices.py')
    spec = importlib.util.spec_from_file_location('find_recurring_voices', here)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


VOICE_WINDOW, VOICE_HOP = 1.5, 0.5   # seconds: each half second of speech is judged by the windows that cover it


def speech_regions(voices, audio, longest=None):
    """Stretches of speech as (first, last) sample positions, cut at `longest` samples when given; none is dropped."""
    import webrtcvad
    vad = webrtcvad.Vad(2)
    frame = voices.FRAME
    flags = [vad.is_speech(audio[at:at + frame].tobytes(), voices.RATE) for at in range(0, len(audio) - frame + 1, frame)]
    regions, first, last = [], None, None
    for index, active in enumerate(flags + [False] * 11):
        if active:
            first = index if first is None else first
            last = index
        elif first is not None and index - last > 10:
            start, end = first * frame, (last + 1) * frame
            while start < end:
                stop = min(start + longest, end) if longest else end
                regions.append((start, stop))
                start = stop
            first = last = None
    return regions


def silenced_stretches(video, agreed_voices, voice_match, model=None):
    """(from, to) seconds of speech in the video by no one who agreed, judged against their recordings. Speakers can
    follow each other with no pause, so each half second of speech is scored by the 1.5 s windows that cover it and
    takes the lowest of their scores: a boundary between someone who agreed and someone who did not is silenced."""
    voices = voices_module()
    session = ort.InferenceSession(model or voices.MODEL, providers=['CPUExecutionProvider'])
    rate = voices.RATE
    print_of = lambda piece: voices.embed(session, piece.astype(np.float32) / 32768.0)
    agreed = []
    for path in agreed_voices:
        audio = voices.audio_from(path, 600)
        prints = [print_of(audio[a:b]) for a, b in speech_regions(voices, audio, rate * 8)]
        prints = [vector for vector in prints if vector is not None]
        if prints:
            agreed.append(voices.unit(np.mean(prints, axis=0)))
    agreed = np.array([vector for vector in agreed if vector is not None])
    score = lambda piece: (lambda vector: -1.0 if vector is None or not len(agreed) else float((agreed @ vector).max()))(print_of(piece))
    audio = voices.audio_from(video, 4 * 3600)
    silenced = []
    for first, last in speech_regions(voices, audio):
        start, end = first / rate, last / rate
        if end - start < VOICE_WINDOW:
            if score(audio[first:last]) < voice_match:
                silenced.append((start, end))
            continue
        windows = [min(at, end - VOICE_WINDOW) for at in np.arange(start, end - VOICE_WINDOW + VOICE_HOP, VOICE_HOP)]
        scores = [(at, score(audio[int(at * rate):int((at + VOICE_WINDOW) * rate)])) for at in windows]
        for cell in np.arange(start, end, VOICE_HOP):
            stop = min(cell + VOICE_HOP, end)
            covering = [value for at, value in scores if at < stop and at + VOICE_WINDOW > cell]
            if min(covering) < voice_match:
                if silenced and abs(silenced[-1][1] - cell) < 1e-6:
                    silenced[-1] = (silenced[-1][0], stop)
                else:
                    silenced.append((cell, stop))
    return silenced, int(len(agreed))


def has_sound(path):
    answer = subprocess.run(['ffprobe', '-v', 'error', '-select_streams', 'a', '-show_entries', 'stream=index', '-of', 'csv=p=0', path], capture_output=True, check=True, text=True)
    return bool(answer.stdout.strip())


def probe(path):
    answer = subprocess.run(['ffprobe', '-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=width,height,avg_frame_rate:format=duration', '-of', 'json', path], capture_output=True, check=True, text=True)
    info = json.loads(answer.stdout)
    stream = info['streams'][0]
    top, bottom = (stream.get('avg_frame_rate') or '30/1').split('/')
    fps = float(top) / float(bottom or 1) if float(bottom or 1) else 30.0
    return int(stream['width']), int(stream['height']), fps or 30.0, float(info.get('format', {}).get('duration') or 0)


def main():
    asked = json.load(sys.stdin)
    models = {**MODELS, **(asked.get('models') or {})}
    out = asked.get('out') or OUT
    os.makedirs(os.path.dirname(os.path.abspath(out)), exist_ok=True)
    faces = Faces(models['detector'], models['recognizer'])
    match = float(asked.get('match') or 0.363)

    agreed, without = [], []
    for path in asked.get('agreed') or []:
        picture = np.asarray(Image.open(path).convert('RGB'))
        found = faces.find(picture)
        if not len(found):
            without.append(path.rsplit('/', 1)[-1])
            continue
        largest = found[np.argmax((found[:, 2] - found[:, 0]) * (found[:, 3] - found[:, 1]))]
        agreed.append(faces.print_of(picture, largest))
    agreed = np.array(agreed) if agreed else np.zeros((0, 128))

    agreed_voices = asked.get('agreed_voices') or []
    silenced, voices_used = silenced_stretches(asked['video'], agreed_voices, float(asked.get('voice_match') or 0.5), models.get('voice')) if has_sound(asked['video']) else ([], 0)
    sound = ['-c:a', 'copy'] if not silenced else [
        '-af', 'volume=0:enable=' + "'" + '+'.join(f'between(t,{first:.3f},{last:.3f})' for first, last in silenced) + "'", '-c:a', 'aac', '-b:a', '192k']

    width, height, fps, seconds = probe(asked['video'])
    size = width * height * 3
    reader = subprocess.Popen(['ffmpeg', '-v', 'error', '-i', asked['video'], '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-'], stdout=subprocess.PIPE)
    writer = subprocess.Popen(['ffmpeg', '-v', 'error', '-y', '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-s', f'{width}x{height}', '-r', f'{fps}', '-i', '-',
                               '-i', asked['video'], '-map', '0:v', '-map', '1:a?', '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '20',
                               '-pix_fmt', 'yuv420p', *sound, '-movflags', '+faststart', out], stdin=subprocess.PIPE)

    tracks = []  # each: box, kept (agreed), last frame seen, last frame recognized, id
    seen_ids, blurred_ids, kept_ids = set(), set(), set()
    frames, next_id = 0, 0
    while True:
        raw = reader.stdout.read(size)
        if len(raw) < size:
            break
        frame = np.frombuffer(raw, dtype=np.uint8).reshape(height, width, 3).copy()
        for face in faces.find(frame):
            box = face[:4]
            track = max(tracks, key=lambda t: iou(t['box'], box), default=None)
            if track is None or iou(track['box'], box) < 0.3:
                track = {'id': next_id, 'kept': False, 'recognized': -RECOGNIZE_EVERY}
                next_id += 1
                tracks.append(track)
            track['box'], track['seen'] = box, frames
            if frames - track['recognized'] >= RECOGNIZE_EVERY:
                track['recognized'] = frames
                track['kept'] = bool(len(agreed)) and float((agreed @ faces.print_of(frame, face)).max()) >= match
        tracks = [track for track in tracks if frames - track['seen'] <= KEEP_BLURRED_FRAMES]
        for track in tracks:
            seen_ids.add(track['id'])
            if track['kept']:
                kept_ids.add(track['id'])
            else:
                blurred_ids.add(track['id'])
                blur(frame, track['box'])
        writer.stdin.write(frame.tobytes())
        frames += 1
    reader.wait()
    writer.stdin.close()
    if writer.wait() != 0:
        raise SystemExit('The blurred copy could not be written.')
    print(json.dumps({
        'frames': frames, 'seconds': seconds or frames / fps, 'width': width, 'height': height,
        'faces': len(seen_ids), 'blurred': len(blurred_ids), 'kept': len(kept_ids - blurred_ids),
        'agreed_faces': int(len(agreed)), 'pictures_without_a_face': without, 'agreed_voices': voices_used,
        'silenced': len(silenced), 'silenced_seconds': round(sum(last - first for first, last in silenced), 2), 'video_bytes': os.path.getsize(out),
    }))


if __name__ == '__main__':
    main()
