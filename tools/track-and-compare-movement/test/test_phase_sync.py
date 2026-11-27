"""phase_sync.py and swing_landmarks.py on made-up swings whose landmarks are known: the racket hand of a made-up
skeleton follows a path with a still ready position, a takeback up and back, a held top, a drop, the fastest stretch
into contact and a follow-through that stops. The landmarks read from the pose track must be the planned ones, and the
sync must land the reference's landmarks on the target's output frames.

The made-up swings are also the swings test_synced_render.py renders (write_pair, CONTACT_TARGET, CONTACT_REFERENCE).
"""
import json
import shutil
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

import importlib.util

import numpy as np

DO_WORK = Path(__file__).resolve().parent.parent / "do-work"
SCRIPT = DO_WORK / "phase_sync.py"


def load(name, path):
    spec = importlib.util.spec_from_file_location(name, path)
    module = importlib.util.module_from_spec(spec)
    sys.modules[name] = module
    spec.loader.exec_module(module)
    return module


M = load("phase_sync", SCRIPT)
L = sys.modules["swing_landmarks"]
AUTHOR = load("author_comparison_edl", DO_WORK / "author_comparison_edl.py")

FPS = 30.0
TORSO = 100.0                                         # pixels from the hips' middle to the shoulders' middle
HIPS = np.array([200.0, 200.0])


def swing_plan(l1, top, l2, drop, contact, l4):
    """The racket hand's path, (second, x, y) in torso lengths from the hips' middle (y down): still until l1, up and
    back to the top, held there until l2, dropped, the fastest stretch into contact, then up across the body to a
    finish (at about a third of the contact speed) and still."""
    return [(0.0, -0.3, -0.3), (l1, -0.3, -0.3), (top, 0.8, -1.0), (l2, 0.8, -1.0), (drop, 0.9, 0.2), (contact, -0.4, -0.3),
            (l4, -1.66, -1.98)]


def posture(hand, hitting="r_wrist"):
    """A COCO-17 skeleton with the racket hand at `hand` (torso lengths) and the other hand following it at a third of
    the size, beside the body."""
    other = np.array([-0.6, 0.0]) + 0.3 * hand
    kp = [[HIPS[0], HIPS[1] - 1.4 * TORSO, 0.99]] * 5
    kp += [[HIPS[0] - 30, HIPS[1] - TORSO, 0.99], [HIPS[0] + 30, HIPS[1] - TORSO, 0.99]]
    kp += [[HIPS[0] - 40, HIPS[1] - 60, 0.9], [HIPS[0] + 40, HIPS[1] - 60, 0.9]]
    racket, free = HIPS + TORSO * hand, HIPS + TORSO * other
    wrists = {"r_wrist": racket, "l_wrist": free} if hitting == "r_wrist" else {"l_wrist": racket, "r_wrist": free}
    kp += [[float(wrists["l_wrist"][0]), float(wrists["l_wrist"][1]), 0.9], [float(wrists["r_wrist"][0]), float(wrists["r_wrist"][1]), 0.9]]
    kp += [[HIPS[0] - 20, HIPS[1], 0.99], [HIPS[0] + 20, HIPS[1], 0.99], [HIPS[0] - 22, HIPS[1] + 60, 0.9], [HIPS[0] + 22, HIPS[1] + 60, 0.9],
           [HIPS[0] - 24, HIPS[1] + 120, 0.9], [HIPS[0] + 24, HIPS[1] + 120, 0.9]]
    return kp


def track(seconds, plan, hitting="r_wrist", swap_at=()):
    """Pose frames at FPS; a frame index in `swap_at` has its wrist labels swapped (what a pose model does from behind)."""
    times, xs, ys = zip(*plan)
    frames = []
    for i in range(int(seconds * FPS) + 1):
        t = i / FPS
        hand = np.array([np.interp(t, times, xs), np.interp(t, times, ys)])
        kp = posture(hand, hitting)
        if i in swap_at:
            kp[9], kp[10] = kp[10], kp[9]
        frames.append({"t": round(t, 6), "i": i, "kp": kp})
    return {"video": {"width": 400, "height": 400, "fps": FPS}, "persons": [{"track_id": 1, "frames": frames}]}


# The target takes its time; the reference is quicker before contact. Both clips are long enough for a 0.6 s half
# around contact, as test_synced_render.py renders them.
TARGET_PLAN = swing_plan(l1=0.4, top=0.9, l2=1.35, drop=1.55, contact=1.7, l4=2.3)
REFERENCE_PLAN = swing_plan(l1=5.0, top=5.25, l2=5.9, drop=6.1, contact=6.2, l4=6.8)
CONTACT_TARGET, CONTACT_REFERENCE = 1.7, 6.2
TARGET_LANDMARKS = {"L1": 0.4, "L2": 1.35, "L3": 1.7, "L4": 2.3}
REFERENCE_LANDMARKS = {"L1": 5.0, "L2": 5.9, "L3": 6.2, "L4": 6.8}


def write_pair(folder, reference_plan=REFERENCE_PLAN, target_plan=TARGET_PLAN, reference_contact=CONTACT_REFERENCE):
    target, reference = folder / "target.json", folder / "reference.json"
    target.write_text(json.dumps(track(3.0, target_plan)))
    reference.write_text(json.dumps(track(8.0, reference_plan, hitting="l_wrist")))
    return {"fps": FPS, "target": {"kp": str(target), "contact": target_plan[5][0], "track_id": 1},
            "reference": {"kp": str(reference), "contact": reference_contact}}


def frames_of(plan, seconds=3.0, **kwargs):
    return track(seconds, plan, **kwargs)["persons"][0]["frames"]


class TheLandmarks(unittest.TestCase):
    def assert_within_a_frame(self, found, planned):
        for key, second in planned.items():
            self.assertLessEqual(abs(found[key] - second) * FPS, 1.0 + 1e-6, (key, found[key], second))

    def test_the_four_landmarks_are_found_within_one_frame(self):
        self.assert_within_a_frame(L.find_landmarks(frames_of(TARGET_PLAN), CONTACT_TARGET), TARGET_LANDMARKS)
        self.assert_within_a_frame(L.find_landmarks(frames_of(REFERENCE_PLAN, 8.0), CONTACT_REFERENCE), REFERENCE_LANDMARKS)

    def test_the_wrist_label_does_not_matter_even_when_it_swaps(self):
        for hitting in ("l_wrist", "r_wrist"):
            found = L.find_landmarks(frames_of(TARGET_PLAN, hitting=hitting, swap_at={20, 41, 50, 60}), CONTACT_TARGET)
            self.assert_within_a_frame(found, TARGET_LANDMARKS)

    def test_a_contact_that_is_not_the_fastest_moment_is_refused(self):
        with self.assertRaises(L.NoLandmark) as caught:
            L.find_landmarks(frames_of(TARGET_PLAN), CONTACT_TARGET - 0.3)
        self.assertEqual(caught.exception.facts["landmark"], "L3")
        self.assertAlmostEqual(caught.exception.facts["fastest"], CONTACT_TARGET, delta=M.SETTINGS["landmarks"]["contact_off_s"])

    def test_a_track_that_starts_mid_takeback_is_refused(self):
        late = [(t - 0.6, x, y) for t, x, y in TARGET_PLAN[2:]]       # the clip starts at the top: no ready position
        with self.assertRaises(L.NoLandmark) as caught:
            L.find_landmarks(frames_of([(0.0, 0.5, -0.8)] + late), CONTACT_TARGET - 0.6)
        self.assertEqual(caught.exception.facts["landmark"], "L1")

    def test_a_track_that_stops_mid_follow_through_is_refused(self):
        with self.assertRaises(L.NoLandmark) as caught:
            L.find_landmarks(frames_of(TARGET_PLAN, seconds=2.0), CONTACT_TARGET)
        self.assertEqual(caught.exception.facts["landmark"], "L4")


class TheSync(unittest.TestCase):
    def setUp(self):
        self.folder = tempfile.TemporaryDirectory()
        self.tmp = Path(self.folder.name)
        self.spec = write_pair(self.tmp)

    def tearDown(self):
        self.folder.cleanup()

    def test_every_landmark_of_the_reference_plays_on_the_targets_output_frame(self):
        sync = M.phase_sync(self.spec)
        self.assertEqual(sync["kind"], "phase_sync.v1")
        self.assertEqual(len(sync["pieces"]), 3)
        for key in M.KEYS:
            target_plays = sync["landmarks"]["target"][key] - sync["target"]["in"]
            reference_at = M.reference_second(sync, sync["landmarks"]["target"][key])
            self.assertLessEqual(abs(reference_at - sync["landmarks"]["reference"][key]) * FPS, 1.0, key)
            self.assertLessEqual(abs(M.plays_at(sync, sync["landmarks"]["reference"][key]) - target_plays) * FPS, 1.0, key)
        self.assertLessEqual(sync["max_phase_error_frames"], 1.0)
        self.assertEqual(set(sync["landmark_misses_frames"]), set(M.KEYS))

    def test_a_takeback_that_starts_0_6_s_earlier_is_aligned_at_its_start(self):
        # Every moment of the target from the top on is 0.6 s later in its clip; its takeback still starts at 0.4 s, so
        # it starts 1.9 s before contact against the usual target's 1.3 s and the reference's 1.2 s.
        early = swing_plan(l1=0.4, top=0.9, l2=1.95, drop=2.15, contact=2.3, l4=2.9)
        sync = M.phase_sync(write_pair(self.tmp, target_plan=early))
        target_l1, reference_l1 = sync["landmarks"]["target"]["L1"], sync["landmarks"]["reference"]["L1"]
        self.assertAlmostEqual(sync["landmarks"]["target"]["L3"] - target_l1, 1.9, delta=1 / FPS)
        self.assertLessEqual(abs(M.reference_second(sync, target_l1) - reference_l1) * FPS, 1.0)
        self.assertLessEqual(sync["landmark_misses_frames"]["L1"], 1.0)
        self.assertLessEqual(sync["target"]["in"], target_l1)
        self.assertLessEqual(sync["reference"]["in"], reference_l1)

    def test_the_window_runs_from_before_l1_to_after_l4_on_both_sides(self):
        sync = M.phase_sync(self.spec)
        lead, tail = M.SETTINGS["lead_s"], M.SETTINGS["tail_s"]
        self.assertAlmostEqual(sync["target"]["in"], sync["landmarks"]["target"]["L1"] - lead, places=5)
        self.assertAlmostEqual(sync["target"]["out"], sync["landmarks"]["target"]["L4"] + tail, places=5)
        self.assertEqual(sync["pieces"][0]["from"], sync["reference"]["in"])
        self.assertEqual(sync["pieces"][-1]["to"], sync["reference"]["out"])
        played = sum((p["to"] - p["from"]) / p["speed"] for p in sync["pieces"])
        self.assertAlmostEqual(played, sync["target"]["out"] - sync["target"]["in"], places=4)
        self.assertEqual([r["speed"] for r in sync["speed_ramp"]], [p["speed"] for p in sync["pieces"]])

    def test_a_lead_is_shortened_where_a_track_starts(self):
        spec = write_pair(self.tmp, target_plan=swing_plan(l1=0.15, top=0.65, l2=1.1, drop=1.3, contact=1.45, l4=2.05))
        spec["target"]["contact"] = 1.45
        sync = M.phase_sync(spec)
        self.assertGreaterEqual(sync["target"]["in"], 0.0)
        self.assertGreaterEqual(sync["reference"]["in"], 0.0)

    def test_a_retiming_beyond_the_speed_bounds_is_refused_not_distorted(self):
        rushed = swing_plan(l1=5.7, top=5.75, l2=5.9, drop=6.1, contact=6.2, l4=6.8)       # takeback 0.2 s against 0.95 s
        with self.assertRaises(M.Refused) as caught:
            M.phase_sync(write_pair(self.tmp, reference_plan=rushed))
        self.assertEqual(caught.exception.facts["piece"], 0)
        self.assertLess(caught.exception.facts["speed"], M.SETTINGS["min_speed"])
        self.assertIn("cannot be synced", str(caught.exception))

    def test_the_bounds_are_data(self):
        self.spec["settings"] = {"min_speed": 0.97}
        with self.assertRaises(M.Refused) as caught:
            M.phase_sync(self.spec)
        self.assertLess(caught.exception.facts["speed"], 0.97)

    def test_a_side_whose_landmarks_cannot_be_read_is_refused_and_named(self):
        spec = write_pair(self.tmp, reference_contact=CONTACT_REFERENCE - 0.3)
        with self.assertRaises(M.Refused) as caught:
            M.phase_sync(spec)
        self.assertEqual((caught.exception.facts["side"], caught.exception.facts["landmark"]), ("reference", "L3"))

    def test_a_fixed_window_is_refused(self):
        self.spec["target"]["in"] = 0.7
        with self.assertRaisesRegex(ValueError, "comes from the swing's landmarks"):
            M.phase_sync(self.spec)


class TheEdit(unittest.TestCase):
    """author_comparison_edl builds the comparison from the sync as phase_sync writes it."""

    def test_the_edit_plays_the_synced_reference_window(self):
        with tempfile.TemporaryDirectory() as folder:
            tmp = Path(folder)
            spec = write_pair(tmp)
            sync = M.phase_sync(spec)
            edit_spec = {"encode": {"width": 360, "height": 640, "fps": 30}, "layout": "v",
                         "left": {"clip": "reference.mp4", "kp": spec["reference"]["kp"], "peak": CONTACT_REFERENCE, "sync": sync},
                         "right": {"clip": "target.mp4", "kp": spec["target"]["kp"], "peak": CONTACT_TARGET},
                         "passes": [{"id": "full", "half": 0.6}]}
            edl = AUTHOR.build_edl(edit_spec, {"reference.mp4": 8.0, "target.mp4": 3.0})
            reference, target = edl["spine"]["segments"][0]["sources"]
            self.assertEqual((target["in"], target["out"]), (round(CONTACT_TARGET - 0.6, 3), round(CONTACT_TARGET + 0.6, 3)))
            wanted = M.reference_window(sync, CONTACT_TARGET - 0.6, CONTACT_TARGET + 0.6)
            self.assertEqual((reference["in"], reference["out"], reference["speed_ramp"]), (wanted["in"], wanted["out"], wanted["speed_ramp"]))
            knots = [r["t"] for r in reference["speed_ramp"]] + [reference["out"] - reference["in"]]
            played = sum((knots[i + 1] - knots[i]) / reference["speed_ramp"][i]["speed"] for i in range(len(reference["speed_ramp"])))
            self.assertAlmostEqual(played, 1.2, places=4)


def numbered_video(path, seconds):
    """A grey video whose brightness grows 4 levels a frame and starts again every 50 frames, the size of the made-up
    pose tracks (4 levels keep neighbouring frames apart through the sheet's RGB picture)."""
    subprocess.run(["ffmpeg", "-hide_banner", "-loglevel", "error", "-y", "-f", "lavfi", "-i", f"color=c=gray:s=400x400:r={int(FPS)}:d={seconds}",
                    "-vf", "geq=lum='16+mod(N\\,50)*4':cb=128:cr=128", "-c:v", "libx264", "-qp", "0", "-pix_fmt", "yuv420p", str(path)], check=True)


def grey_levels(path):
    """The grey of every frame of a numbered video, read the same way the sheet is read (so no level is assumed)."""
    raw = subprocess.run(["ffmpeg", "-hide_banner", "-loglevel", "error", "-i", str(path), "-vf", "crop=16:16:192:192,format=gray", "-f", "rawvideo", "-"],
                         check=True, capture_output=True).stdout
    return np.frombuffer(raw, dtype=np.uint8).reshape(-1, 256).mean(axis=1)


@unittest.skipUnless(shutil.which("ffmpeg"), "ffmpeg is needed for the landmark sheet")
class TheSheetAndTheCommand(unittest.TestCase):
    def test_the_sheet_shows_each_persons_frame_at_each_landmark_and_the_command_writes_both(self):
        with tempfile.TemporaryDirectory() as folder:
            tmp = Path(folder)
            spec = write_pair(tmp)
            numbered_video(tmp / "target.mp4", 3.0)
            numbered_video(tmp / "reference.mp4", 8.0)
            spec["target"]["clip"], spec["reference"]["clip"] = str(tmp / "target.mp4"), str(tmp / "reference.mp4")
            (tmp / "spec.json").write_text(json.dumps(spec))
            done = subprocess.run([sys.executable, str(SCRIPT), "--spec", str(tmp / "spec.json"), "--out", str(tmp / "o" / "sync.json")],
                                  capture_output=True, text=True, timeout=300)
            self.assertEqual(done.returncode, 0, done.stdout + done.stderr)
            result = json.loads(done.stdout.strip().splitlines()[-1])["result"]
            sheet = Path(result["landmark_sheet"])
            self.assertEqual(sheet, tmp / "o" / "sync.landmarks.png")
            cell_w, cell_h = M.SETTINGS["landmarks"]["sheet_cell"]
            size = subprocess.run(["ffprobe", "-v", "error", "-show_entries", "stream=width,height", "-of", "csv=p=0", str(sheet)],
                                  check=True, capture_output=True, text=True).stdout.strip()
            self.assertEqual(size, f"{4 * cell_w},{2 * cell_h}")
            raw = subprocess.run(["ffmpeg", "-hide_banner", "-loglevel", "error", "-i", str(sheet), "-vf", "format=gray", "-f", "rawvideo", "-"],
                                 check=True, capture_output=True).stdout
            picture = np.frombuffer(raw, dtype=np.uint8).reshape(2 * cell_h, 4 * cell_w)
            for row, side in enumerate(("target", "reference")):
                levels = grey_levels(tmp / f"{side}.mp4")
                for column, key in enumerate(M.KEYS):
                    middle_y, middle_x = row * cell_h + cell_h // 2, column * cell_w + cell_w // 2
                    grey = picture[middle_y - 8:middle_y + 8, middle_x - 8:middle_x + 8].mean()
                    wanted = round(result["landmarks"][side][key] * FPS)
                    near = range(max(wanted - 20, 0), min(wanted + 20, len(levels)))        # less than one 50-frame cycle
                    shown = min(near, key=lambda n: abs(levels[n] - grey))
                    self.assertEqual(shown, wanted, (side, key, grey))
            rushed = write_pair(tmp, reference_plan=swing_plan(l1=5.7, top=5.75, l2=5.9, drop=6.1, contact=6.2, l4=6.8))
            (tmp / "bad.json").write_text(json.dumps(rushed))
            done = subprocess.run([sys.executable, str(SCRIPT), "--spec", str(tmp / "bad.json"), "--out", str(tmp / "o" / "bad.json")],
                                  capture_output=True, text=True, timeout=300)
            self.assertEqual(done.returncode, 1)
            self.assertIn("speed", json.loads(done.stdout.strip().splitlines()[-1])["refused"])
            self.assertFalse((tmp / "o" / "bad.json").exists())


if __name__ == "__main__":
    unittest.main()
