#!/usr/bin/env python3
"""Four checkable moments of one swing, read from its pose track around a given contact second, and a sheet of the
frames at those moments for a person to check.

  L1 takeback start  the hands leave their ready position
  L2 furthest back   the racket laid back: the racket hand's last moment at the top of the takeback, before the drop
  L3 contact         given by the caller (contact_moment.py); checked, never moved
  L4 finish          the end of the follow-through: the hands have lost most of their contact speed

Everything is read in IMAGE space, from the two wrists relative to the middle of the hips, in torso lengths (shoulder
middle to hip middle), so neither where the player stands nor how far away the camera is changes a number. A pose
model seen from behind can swap the left/right labels, even for one frame, so nothing is read by label:
  - the two wrists are followed as two tracks: each frame's two points go to the two tracks so that the tracks move
    the least (a label swap is undone, a one-frame glitch is taken out by a 3-frame median);
  - the racket hand is the track that is fastest around contact, whatever label it carries;
  - the hands speed is the mean of the two tracks' speeds (torso lengths per second: central difference, 3-frame
    mean), the same whichever track is the racket hand.
Height, not left/right, decides L2: the camera's place around the player changes where a takeback goes on screen
left/right, but not how high the hand goes.

With `peak` = the hands speed's highest value within `peak_within_s` of contact:
  L3 is refused when the hands are fastest more than `contact_off_s` from it (within `contact_check_s`): a sync
     pinned to a wrong contact shows the wrong moments side by side;
  L2 = walking back from contact down the forward swing to the racket hand's lowest point (the drop), then up to its
       highest point before the drop: the last frame from there whose hand is within `turn_torso` of that height;
  L1 = back from L2, past the frames with the hand within `hold_torso` of its L2 place (a hold at the top), the frame
       after the last stretch of at least `ready_frames` frames whose hands speed stays at or under
       `ready_fraction` x peak (the ready position: the hands are still while the player waits);
  L4 = after contact, the first frame of the first stretch of at least `finish_frames` frames whose hands speed is at
       or under `finish_fraction` x peak.
The numbers were chosen on 11 real swings filmed from behind and checked on their landmark sheets; the measurements
are in README.md ("Landmark rules"). A swing whose track starts mid-takeback or stops mid-follow-through has no L1 or
L4 and is refused, never guessed.

Every number is DATA: the `landmarks` block of phase-sync.json.

USAGE: swing_landmarks.py --kp POSE.json --contact S [--track-id N] [--clip VIDEO --sheet OUT.png]
Last line: {"result": {"L1", "L2", "L3", "L4", "hitting_wrist", "track", "sheet"?}} or {"error": ..., "refused"?: {...}}.
"""
from __future__ import annotations

import argparse
import json
import shutil
import subprocess
import sys
from pathlib import Path
from typing import Any

import numpy as np

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
sys.path.insert(0, str(HERE / "process-scripts" / "perception"))
from pose_schema import JI  # noqa: E402  the one keypoint schema
from describe_clip import main_track  # noqa: E402  the same player the swing windows were found on (as stroke_side.py)

SETTINGS = json.loads((HERE / "phase-sync.json").read_text(encoding="utf-8"))["landmarks"]
NAMES = {"L1": "takeback start", "L2": "furthest back", "L3": "contact", "L4": "finish"}


class NoLandmark(ValueError):
    """A landmark is not in the track; `facts` say which and what was seen."""

    def __init__(self, message: str, facts: dict[str, Any]):
        super().__init__(message)
        self.facts = facts


def person_frames(track: dict[str, Any], track_id: int | None) -> list[dict[str, Any]]:
    if track_id is None:
        return (main_track(track) or {}).get("frames", [])
    for person in track.get("persons") or []:
        if person.get("track_id") == track_id:
            return person.get("frames", [])
    raise ValueError(f"the pose track has no person with track_id {track_id}")


def _middle(kp: list[list[float]], a: str, b: str) -> np.ndarray:
    return np.array([(kp[JI[a]][0] + kp[JI[b]][0]) / 2, (kp[JI[a]][1] + kp[JI[b]][1]) / 2])


def wrist_tracks(frames: list[dict[str, Any]], start: float, end: float, settings: dict[str, Any]) -> tuple[np.ndarray, np.ndarray, float]:
    """Seconds (N,) and the two wrist tracks (2, N, 2) in torso lengths from the hips' middle (image y down), label
    swaps undone; the torso length in pixels. Frames without confident hips and shoulders are left out; a wrist under
    the confidence is filled in time from its neighbours."""
    floor = float(settings["min_confidence"])
    kept = []
    for frame in frames:
        if not start - 1e-6 <= float(frame["t"]) <= end + 1e-6:
            continue
        kp = frame["kp"]
        if min(kp[JI[n]][2] for n in ("l_hip", "r_hip", "l_shoulder", "r_shoulder")) < floor:
            continue
        kept.append(frame)
    if len(kept) < 8:
        raise NoLandmark(f"only {len(kept)} frames from {start:.3f} s to {end:.3f} s show the hips and shoulders (8 needed)",
                         {"frames": len(kept), "from": start, "to": end})
    torso = float(np.median([np.linalg.norm(_middle(f["kp"], "l_shoulder", "r_shoulder") - _middle(f["kp"], "l_hip", "r_hip")) for f in kept]))
    if not torso > 0:
        raise NoLandmark("the torso has no length in this track", {"from": start, "to": end})
    times = np.array([float(f["t"]) for f in kept])
    raw = np.full((2, len(kept), 2), np.nan)
    for k, frame in enumerate(kept):
        hips = _middle(frame["kp"], "l_hip", "r_hip")
        for side, name in enumerate(("l_wrist", "r_wrist")):
            point = frame["kp"][JI[name]]
            if point[2] >= floor:
                raw[side, k] = (np.array(point[:2], dtype=float) - hips) / torso
    for side in range(2):
        seen = np.isfinite(raw[side, :, 0])
        if seen.sum() < 2:
            raise NoLandmark(f"a wrist is seen in only {int(seen.sum())} frames", {"from": start, "to": end})
        for axis in range(2):
            raw[side, :, axis] = np.interp(times, times[seen], raw[side, seen, axis])
    tracks = raw.copy()
    for k in range(1, len(times)):
        kept_order = np.linalg.norm(raw[0, k] - tracks[0, k - 1]) + np.linalg.norm(raw[1, k] - tracks[1, k - 1])
        swapped = np.linalg.norm(raw[1, k] - tracks[0, k - 1]) + np.linalg.norm(raw[0, k] - tracks[1, k - 1])
        if swapped < kept_order:
            tracks[0, k], tracks[1, k] = raw[1, k], raw[0, k]
    smooth = tracks.copy()
    for k in range(1, len(times) - 1):
        smooth[:, k] = np.median(tracks[:, k - 1:k + 2], axis=1)
    return times, smooth, torso


def speeds(times: np.ndarray, track: np.ndarray) -> np.ndarray:
    """Torso lengths per second along one track: central difference, then a 3-frame mean."""
    speed = np.zeros(len(times))
    speed[1:-1] = np.linalg.norm(track[2:] - track[:-2], axis=1) / (times[2:] - times[:-2])
    speed[0], speed[-1] = speed[1], speed[-2]
    padded = np.pad(speed, 1, mode="edge")
    return (padded[:-2] + padded[1:-1] + padded[2:]) / 3


def takeback_top(height: np.ndarray, first: int, contact: int, turn: float) -> int:
    """The end of the takeback, walking back from contact over the racket hand's image y (down is +): first down the
    forward swing to the racket drop (its lowest point before contact), then up to the highest point before that drop;
    L2 is the last frame from there on whose hand is still within `turn` torso lengths of that height (the racket is
    laid back with the hand up; the next frame starts the drop into the forward swing). A turn smaller than `turn`
    torso lengths is pose noise and is walked over."""
    k, low = contact, contact
    while k > first:                                 # back from contact while the hand was lower: the forward swing
        k -= 1
        if height[k] > height[low]:
            low = k
        elif height[k] < height[low] - turn:
            break
    k, top = low, low
    while k > first:                                 # back from the drop while the hand was higher: the takeback
        k -= 1
        if height[k] < height[top]:
            top = k
        elif height[k] > height[top] + turn:
            break
    last = top
    while last + 1 < low and height[last + 1] <= height[top] + turn:
        last += 1                                    # the hand stays up while the racket is laid back: its last moment up
    return last


def find_landmarks(frames: list[dict[str, Any]], contact: float, settings: dict[str, Any] | None = None) -> dict[str, Any]:
    """L1..L4 (seconds of the clip) of the swing whose contact is `contact`, with what they were read from."""
    s = {**SETTINGS, **(settings or {})}
    times, tracks, torso = wrist_tracks(frames, contact - float(s["search_before_s"]), contact + float(s["search_after_s"]), s)
    if not times[0] < contact < times[-1]:
        raise NoLandmark(f"contact {contact:.3f} s is not inside the track's frames {times[0]:.3f}..{times[-1]:.3f} s",
                         {"contact": contact, "from": float(times[0]), "to": float(times[-1])})
    step = float(np.median(np.diff(times)))
    around = times[max(int(np.searchsorted(times, contact)) - 1, 0):int(np.searchsorted(times, contact)) + 1]
    if len(around) == 2 and around[1] - around[0] > 2.5 * step:
        raise NoLandmark(f"the track has no frames from {around[0]:.3f} s to {around[1]:.3f} s, around contact {contact:.3f} s; "
                         "the hitting wrist cannot be followed through contact", {"contact": contact, "gap": [float(around[0]), float(around[1])]})
    near = np.abs(times - contact) <= float(s["peak_within_s"]) + 1e-6
    both = np.stack([speeds(times, tracks[0]), speeds(times, tracks[1])])
    hitting = int(np.argmax(both[:, near].max(axis=1)))
    track = tracks[hitting]
    hands = both.mean(axis=0)                        # the same whichever track is the racket hand
    at_contact = int(np.argmin(np.abs(times - contact)))
    peak_index = int(np.flatnonzero(near)[np.argmax(hands[near])])
    peak = float(hands[peak_index])

    around_contact = np.flatnonzero(np.abs(times - contact) <= float(s["contact_check_s"]) + 1e-6)
    fastest = int(around_contact[np.argmax(hands[around_contact])])
    if abs(times[fastest] - contact) > float(s["contact_off_s"]) + 1e-6:
        raise NoLandmark(f"contact {contact:.3f} s is not the swing's fastest moment: within {s['contact_check_s']} s of it the hands are "
                         f"fastest at {times[fastest]:.3f} s ({times[fastest] - contact:+.3f} s); a sync pinned to a wrong contact would "
                         "show the wrong moments side by side, so the contact must be checked first",
                         {"landmark": "L3", "contact": contact, "fastest": round(float(times[fastest]), 6),
                          "off_s": round(float(times[fastest] - contact), 6)})
    if at_contact < 2:
        raise NoLandmark("contact is at the start of the track; no takeback is seen", {"landmark": "L2", "contact": contact})
    l2 = takeback_top(track[:, 1], 0, at_contact, float(s["turn_torso"]))
    if not l2 < at_contact:
        raise NoLandmark(f"the racket hand never rises before contact {contact:.3f} s; no takeback is seen", {"landmark": "L2", "contact": contact})
    ready = float(s["ready_fraction"]) * peak
    still = hands <= ready
    held = l2
    while held > 0 and np.linalg.norm(track[held - 1] - track[l2]) <= float(s["hold_torso"]):
        held -= 1                                    # the hand already at the top (a player waiting for the ball) is not ready
    run, l1 = 0, None
    for k in range(held - 1, -1, -1):                # back from the top: the last still stretch before the hand moved to it
        run = run + 1 if still[k] else 0
        if run >= int(s["ready_frames"]):
            l1 = k + run
            break
    if l1 is None or not l1 < l2:
        raise NoLandmark(f"no ready position before the takeback's top at {times[l2]:.3f} s: the hands are never still (at or under "
                         f"{ready:.2f} torso lengths/s for {s['ready_frames']} frames) from {times[0]:.3f} s; the track starts mid-takeback",
                         {"landmark": "L1", "ready_speed": round(ready, 3), "top": float(times[l2]), "from": float(times[0]), "contact": contact})
    finish = float(s["finish_fraction"]) * peak
    run, l4 = 0, None
    for k in range(max(peak_index, at_contact) + 1, len(times)):   # after contact: the first stretch where the hands have slowed down
        run = run + 1 if hands[k] <= finish else 0
        if run >= int(s["finish_frames"]):
            l4 = k - run + 1
            break
    if l4 is None:
        raise NoLandmark(f"the follow-through does not end before {times[-1]:.3f} s (the hands never stay at or under {finish:.2f} torso "
                         f"lengths/s, {s['finish_fraction']} of their contact speed, for {s['finish_frames']} frames); the track stops mid-swing",
                         {"landmark": "L4", "to": float(times[-1]), "peak_speed": round(peak, 3)})
    return {
        "L1": round(float(times[l1]), 6), "L2": round(float(times[l2]), 6), "L3": round(float(contact), 6), "L4": round(float(times[l4]), 6),
        "hitting_wrist": {"label_at_contact": ("l_wrist", "r_wrist")[_label_at(tracks, hitting, at_contact, frames, times)],
                          "peak_speed": round(peak, 3), "ready_speed": round(ready, 3), "torso_px": round(torso, 1)},
        "track": {"from": float(times[0]), "to": float(times[-1])},
    }


def _label_at(tracks: np.ndarray, hitting: int, k: int, frames: list[dict[str, Any]], times: np.ndarray) -> int:
    """Which label the pose model gave the hitting wrist at frame k (for a person to read; nothing decides on it)."""
    frame = next(f for f in frames if abs(float(f["t"]) - float(times[k])) < 1e-6)
    hips = _middle(frame["kp"], "l_hip", "r_hip")
    torso = np.linalg.norm(_middle(frame["kp"], "l_shoulder", "r_shoulder") - hips) or 1.0
    places = [(np.array(frame["kp"][JI[n]][:2], dtype=float) - hips) / torso for n in ("l_wrist", "r_wrist")]
    return int(np.argmin([np.linalg.norm(place - tracks[hitting, k]) for place in places]))


def player_box(frames: list[dict[str, Any]], second: float, width: int, height: int, aspect: float, floor: float) -> tuple[int, int, int, int]:
    """A crop (w, h, x, y) of the given aspect around the player's confident keypoints at `second`, padded so the arms
    and the racket beyond the wrist stay in, inside the frame."""
    frame = min(frames, key=lambda f: abs(float(f["t"]) - second))
    points = np.array([p[:2] for p in frame["kp"] if p[2] >= floor], dtype=float)
    if not len(points):
        return width, height, 0, 0
    low, high = points.min(axis=0), points.max(axis=0)
    centre = (low + high) / 2
    box_h = max((high[1] - low[1]) * 1.9, (high[0] - low[0]) * 1.9 / aspect, 64.0)
    box_h = min(box_h, height, width / aspect)
    box_w = box_h * aspect
    x = int(round(min(max(centre[0] - box_w / 2, 0), width - box_w)))
    y = int(round(min(max(centre[1] - box_h / 2, 0), height - box_h)))
    return int(box_w) // 2 * 2, int(box_h) // 2 * 2, x, y


def landmark_sheet(rows: list[dict[str, Any]], out: str, settings: dict[str, Any] | None = None) -> str:
    """One row per person: that person's frames at L1..L4, side by side, each labelled with the person, the landmark
    and its second. Each row is {"name", "clip", "frames", "landmarks", "width", "height", "fps"}. Each cell is the video
    frame of the pose frame nearest the landmark second, taken from the source clip by ffmpeg."""
    s = {**SETTINGS, **(settings or {})}
    if not shutil.which("ffmpeg"):
        raise RuntimeError("ffmpeg is needed for the landmark sheet")
    cell_w, cell_h = int(s["sheet_cell"][0]), int(s["sheet_cell"][1])
    args = ["ffmpeg", "-hide_banner", "-loglevel", "error", "-y"]
    chains, labels = [], []
    index = 0
    columns = 4
    for row in rows:
        moments = row.get("moments") or [(f"{key} {NAMES[key]}", row["landmarks"][key]) for key in ("L1", "L2", "L3", "L4")]
        columns = len(moments)
        for title, second in moments:
            second = float(second)
            number = video_frame(row["frames"], second, float(row["fps"]))
            # The frame is picked by its number, not by a seek: which frame ffmpeg's -ss lands on differs between files
            # (the first at or after the second in one clip, the one on screen in another). Reading stops just after it.
            args += ["-t", f"{(number + 3) / float(row['fps']):.4f}", "-i", str(row["clip"])]
            w, h, x, y = player_box(row["frames"], second, int(row["width"]), int(row["height"]), cell_w / cell_h, float(s["min_confidence"]))
            text = f"{row['name']}  {title}  {second:.3f} s".replace(":", "\\:")
            chains.append(f"[{index}:v]select=eq(n\\,{number}),setpts=PTS-STARTPTS,crop={w}:{h}:{x}:{y},scale={cell_w}:{cell_h},setsar=1,"
                          f"drawtext=text='{text}':x=8:y=8:fontsize={max(cell_h // 24, 12)}:fontcolor=white:box=1:boxcolor=black@0.6[c{index}]")
            labels.append(f"[c{index}]")
            index += 1
    layout = "|".join(f"{(k % columns) * cell_w}_{(k // columns) * cell_h}" for k in range(index))
    graph = ";".join(chains) + f";{''.join(labels)}xstack=inputs={index}:layout={layout}[sheet]"
    Path(out).parent.mkdir(parents=True, exist_ok=True)
    done = subprocess.run(args + ["-filter_complex", graph, "-map", "[sheet]", "-frames:v", "1", "-update", "1", str(out)],
                          capture_output=True, text=True)
    if done.returncode != 0 or not Path(out).exists():
        raise RuntimeError(f"ffmpeg could not make the landmark sheet: {done.stderr.strip()[-400:]}")
    return str(out)


def video_frame(frames: list[dict[str, Any]], second: float, fps: float) -> int:
    """The video frame number of the pose frame nearest `second`: its own `i` when the track records it (a track may
    skip frames), else its second times the frame rate."""
    frame = min(frames, key=lambda f: abs(float(f["t"]) - second))
    return int(frame["i"]) if "i" in frame else int(round(float(frame["t"]) * fps))


def video_facts(track: dict[str, Any]) -> dict[str, float]:
    """The width, height and frame rate of the video a pose track was made from, as the track records them."""
    video = track.get("video") or {}
    if not video.get("width") or not video.get("height") or not video.get("fps"):
        raise ValueError("the pose track does not say its video's width, height and fps (video.width, video.height, video.fps)")
    return {"width": int(video["width"]), "height": int(video["height"]), "fps": float(video["fps"])}


def main() -> int:
    parser = argparse.ArgumentParser(description="a swing's takeback start, furthest back, contact and finish from its pose track")
    parser.add_argument("--kp", required=True)
    parser.add_argument("--contact", type=float, required=True)
    parser.add_argument("--track-id", type=int)
    parser.add_argument("--clip")
    parser.add_argument("--sheet")
    args = parser.parse_args()
    try:
        track = json.loads(Path(args.kp).read_text(encoding="utf-8"))
        frames = person_frames(track, args.track_id)
        found = find_landmarks(frames, args.contact)
        if args.sheet:
            if not args.clip:
                raise ValueError("--sheet needs --clip, the video the pose track was made from")
            found["sheet"] = landmark_sheet([{"name": "swing", "clip": args.clip, "frames": frames, "landmarks": found,
                                              **video_facts(track)}], args.sheet)
    except NoLandmark as missing:
        print(json.dumps({"error": str(missing), "refused": missing.facts}))
        return 1
    except (OSError, ValueError, KeyError, RuntimeError) as error:
        print(json.dumps({"error": f"{type(error).__name__}: {error}"}))
        return 2
    print(json.dumps({"result": found}))
    return 0


if __name__ == "__main__":
    sys.exit(main())
