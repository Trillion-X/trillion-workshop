"""Person and face masks of the clean picture, from detection, one per frame.

Person: every instance of class 0 (person) from the segmentation model, unioned. Face: the nose, eyes and ears of every
detected person from the pose model; the face region is the box round those points, padded by face_pad_ratio times
the larger side of the points' box. A frame where a person is present but no face point is found is counted as
unresolved; the verdict fails on it, never passes it.
"""
import json
import os
import subprocess

import cv2
import numpy as np

FACE_KEYPOINTS = (0, 1, 2, 3, 4)  # COCO: nose, left eye, right eye, left ear, right ear
MASKS_DIR = 'masks'


def _frames(clean, width, height):
    proc = subprocess.Popen(['ffmpeg', '-v', 'error', '-i', clean, '-f', 'rawvideo', '-pix_fmt', 'bgr24', '-'],
                            stdout=subprocess.PIPE)
    size = width * height * 3
    index = 0
    try:
        while True:
            raw = proc.stdout.read(size)
            if len(raw) < size:
                break
            yield index, np.frombuffer(raw, np.uint8).reshape(height, width, 3).copy()
            index += 1
    finally:
        proc.stdout.close()
        if proc.wait() != 0:
            raise RuntimeError(f'ffmpeg could not decode {clean}')


def _face_box(keypoints, keypoint_conf, face_pad_ratio):
    visible = [(x, y) for i, (x, y, c) in enumerate(keypoints) if i in FACE_KEYPOINTS and c >= keypoint_conf]
    if not visible:
        return None
    xs = [p[0] for p in visible]
    ys = [p[1] for p in visible]
    x0, x1, y0, y1 = min(xs), max(xs), min(ys), max(ys)
    pad = face_pad_ratio * max(x1 - x0, y1 - y0, 1.0)
    return (int(x0 - pad), int(y0 - pad), int(x1 + pad + 1), int(y1 + pad + 1))


def analyze(clean, out_dir, width, height, fps, settings, models=None):
    """Writes out_dir/masks/person-NNNNN.png and face-NNNNN.png (255 = inside) and out_dir/masks/meta.json.

    settings: person_conf, keypoint_conf, face_pad_ratio, imgsz, device, seg_model, pose_model (all required, see cli).
    models: optional (seg, pose) already loaded, for tests that reuse them.
    """
    from ultralytics import YOLO
    seg_model, pose_model = models or (YOLO(settings['seg_model']), YOLO(settings['pose_model']))
    masks_dir = os.path.join(out_dir, MASKS_DIR)
    os.makedirs(masks_dir, exist_ok=True)
    per_frame = []
    for index, frame in _frames(clean, width, height):
        person = np.zeros((height, width), np.uint8)
        seg = seg_model.predict(frame, classes=[0], conf=settings['person_conf'], imgsz=settings['imgsz'],
                                device=settings['device'], verbose=False)[0]
        if seg.masks is not None and len(seg.masks):
            for mask in seg.masks.data.cpu().numpy():
                resized = cv2.resize(mask, (width, height), interpolation=cv2.INTER_LINEAR)
                person[resized > 0.5] = 255
        face = np.zeros((height, width), np.uint8)
        found_points = 0
        pose = pose_model.predict(frame, conf=settings['person_conf'], imgsz=settings['imgsz'],
                                  device=settings['device'], verbose=False)[0]
        if pose.keypoints is not None and len(pose.keypoints.data):
            for kp in pose.keypoints.data.cpu().numpy():
                box = _face_box(kp, settings['keypoint_conf'], settings['face_pad_ratio'])
                if box is None:
                    continue
                found_points += 1
                x0, y0, x1, y1 = (max(box[0], 0), max(box[1], 0), min(box[2], width), min(box[3], height))
                face[y0:y1, x0:x1] = 255
        person_px = int((person > 0).sum())
        unresolved = person_px > 0 and found_points == 0
        cv2.imwrite(os.path.join(masks_dir, f'person-{index:05d}.png'), person)
        cv2.imwrite(os.path.join(masks_dir, f'face-{index:05d}.png'), face)
        per_frame.append({'frame': index, 't': round(index / fps, 6), 'person_px': person_px,
                          'faces_found': found_points, 'face_unresolved': unresolved})
    meta = {'width': width, 'height': height, 'fps': fps, 'frames': len(per_frame), 'clean': clean,
            'settings': settings, 'per_frame': per_frame}
    with open(os.path.join(masks_dir, 'meta.json'), 'w') as fh:
        json.dump(meta, fh, indent=1)
    return meta


def load_masks(out_dir, index):
    masks_dir = os.path.join(out_dir, MASKS_DIR)
    person = cv2.imread(os.path.join(masks_dir, f'person-{index:05d}.png'), cv2.IMREAD_GRAYSCALE) > 0
    face = cv2.imread(os.path.join(masks_dir, f'face-{index:05d}.png'), cv2.IMREAD_GRAYSCALE) > 0
    return person, face


def read_meta(out_dir):
    with open(os.path.join(out_dir, MASKS_DIR, 'meta.json')) as fh:
        return json.load(fh)
