"""The pose-track contract `pose.keypoints.v1`: COCO-17 keypoint names and the one place a keypoint is made safe.

A track is {"schema": "pose.keypoints.v1", "keypoint_names": COCO, "persons": [{"track_id", "frames": [{"t", "i", "kp"}]}]}
where `kp` is 17 rows of [x, y, confidence] in COCO order. A different pose engine is a new producer that writes
the same shape; nothing that reads a track names the engine.
"""
from __future__ import annotations

import math

COCO = ["nose", "l_eye", "r_eye", "l_ear", "r_ear", "l_shoulder", "r_shoulder", "l_elbow", "r_elbow",
        "l_wrist", "r_wrist", "l_hip", "r_hip", "l_knee", "r_knee", "l_ankle", "r_ankle"]


def kp3(value):
    """One keypoint as [x, y, confidence]. Anything malformed or non-finite becomes the absent point [0, 0, 0],
    which every reader skips by its confidence. A 2-element [x, y] has confidence 1.0."""
    def finite(number):
        return isinstance(number, (int, float)) and not isinstance(number, bool) and math.isfinite(number)

    if value is None:
        return [0.0, 0.0, 0.0]
    try:
        items = list(value)
    except TypeError:
        return [0.0, 0.0, 0.0]
    if len(items) < 2 or not finite(items[0]) or not finite(items[1]):
        return [0.0, 0.0, 0.0]
    if len(items) >= 3:
        return [float(items[0]), float(items[1]), float(items[2])] if finite(items[2]) else [0.0, 0.0, 0.0]
    return [float(items[0]), float(items[1]), 1.0]


def _canonical_frames(frames):
    for frame in frames or []:
        if isinstance(frame, dict) and isinstance(frame.get("kp"), list):
            frame["kp"] = [kp3(point) for point in frame["kp"]]


def canonicalize_pose_track(track):
    """Every keypoint of a loaded track through kp3, in place, so a NaN or infinity read from a file can never
    reach the alignment maths as a position. Handles a whole track (persons), one person (frames) and one pose
    (kp); only `kp` is touched. Returns the object it was given."""
    if not isinstance(track, dict):
        return track
    for person in track.get("persons", []) or []:
        if isinstance(person, dict):
            _canonical_frames(person.get("frames", []))
    _canonical_frames(track.get("frames", []))
    if isinstance(track.get("kp"), list):
        track["kp"] = [kp3(point) for point in track["kp"]]
    return track
