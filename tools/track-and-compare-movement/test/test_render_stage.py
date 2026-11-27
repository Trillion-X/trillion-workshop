"""make_matched_clips render runs its pieces in order for every format, with each piece stood in for: contact, phase
sync, the edit per format, the framing check and the renderer. A refused sync or a refused framing makes no clip."""
import json
import os
import subprocess
import sys
import tempfile
import unittest

DO = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "do-work")
sys.path.insert(0, DO)
import make_matched_clips as m  # noqa: E402

T = {"path": "/t.mp4", "identity": "1f:" + "a" * 64, "people": ["Ada Lane"], "date": "2026-09-10"}
R = {"path": "/r.mp4", "identity": "1f:" + "b" * 64, "people": ["Bo Reyes"], "year": "2019", "class": "forehand"}


class RenderStage(unittest.TestCase):
    def setUp(self):
        self.work = tempfile.mkdtemp()
        self.job = {"work": self.work, "models": self.work, "targets": [T], "references": [R], "movement": "forehand", "view": "back"}
        pair = {"target": m.key(T), "reference": m.key(R), "target_window": 0, "reference_window": 3, "target_peak": 40.6,
                "reference_peak": 1.2, "target_t": [39.9, 41.4], "reference_t": [0.5, 2.0], "parity": "reflected"}
        with open(os.path.join(self.work, "pairs.json"), "w") as f:
            json.dump({"pairs": [pair], "refused": []}, f)
        self.calls, self.refuse = [], set()
        self.saved = (m.run_json, m.subprocess.run)
        m.run_json = self.fake_run_json
        m.subprocess.run = self.fake_run

    def tearDown(self):
        m.run_json, m.subprocess.run = self.saved

    def arg(self, cmd, name):
        return cmd[cmd.index(name) + 1]

    def fake_run_json(self, cmd, env=None):
        piece = os.path.basename(cmd[1])
        self.calls.append(piece)
        if piece in self.refuse:
            return {"error": f"{piece} refused"}
        if piece == "contact_moment.py":
            return {"result": {"time": float(self.arg(cmd, "--wrist-peak")), "source": "wrist"}}
        if piece == "phase_sync.py":
            with open(self.arg(cmd, "--out"), "w") as f:
                json.dump({"kind": "phase_sync.v1"}, f)
            return {"result": {"pieces": 3, "max_phase_error_frames": 0.4}}
        if piece == "author_comparison_edl.py":
            out = self.arg(cmd, "--out")
            for fid in ("9x16", "16x9"):
                with open(out[:-5] + f".{fid}.json", "w") as f:
                    json.dump({"spine": {"segments": []}}, f)
            return {"result": {"segments": [5, 5]}}
        if piece == "whole_movement_check.py":
            self.assertTrue(os.path.exists(self.arg(cmd, "--edit")), "the framing check must get the edit the author wrote")
            with open(self.arg(cmd, "--write-edit"), "w") as f:
                json.dump({"spine": {"segments": []}}, f)
            return {"result": {"cells_refused": 0, "passes": True}}
        raise AssertionError(piece)

    def fake_run(self, cmd, **kw):
        self.calls.append(os.path.basename(cmd[1]))
        open(self.arg(cmd, "--output"), "w").close()
        return subprocess.CompletedProcess(cmd, 0, "", "")

    def test_every_format_is_made_by_the_pieces_in_order(self):
        got = m.render(self.job)
        self.assertEqual(got["made"], 2)
        self.assertEqual(self.calls[:4], ["contact_moment.py", "contact_moment.py", "phase_sync.py", "author_comparison_edl.py"])
        self.assertEqual(self.calls[4:], ["whole_movement_check.py", "render-an-edit.mjs"] * 2)
        made = json.load(open(os.path.join(self.work, "rendered.json")))["made"]
        self.assertEqual(sorted(x["format"] for x in made), ["16x9", "9x16"])
        self.assertTrue(all(x["file"].endswith(f".{x['format']}.mp4") for x in made))
        spec = json.load(open(made[0]["file"].rsplit(".", 2)[0] + ".spec.json"))
        self.assertIn("sync", spec["left"])          # the reference (top / left) is the synced side
        self.assertNotIn("flip", spec["left"])        # both right-handed, both from behind: no mirror, whatever the parity

    def test_a_left_handed_reference_is_mirrored(self):
        self.job["references"][0] = {**R, "hand": "left"}
        m.render(self.job)
        made = json.load(open(os.path.join(self.work, "rendered.json")))["made"]
        spec = json.load(open(made[0]["file"].rsplit(".", 2)[0] + ".spec.json"))
        self.assertEqual(spec["left"]["flip"], "h")
        self.assertEqual(made[0]["steps"]["mirror"]["matcher_parity"], "reflected")

    def test_a_refused_sync_is_cut_on_contact_alone_and_says_so(self):
        self.refuse = {"phase_sync.py"}
        got = m.render(self.job)
        self.assertEqual((got["made"], got["failed"]), (2, 0))
        made = json.load(open(os.path.join(self.work, "rendered.json")))["made"]
        self.assertEqual(made[0]["steps"]["sync"]["aligned"], "contact only")
        spec = json.load(open(made[0]["file"].rsplit(".", 2)[0] + ".spec.json"))
        self.assertNotIn("sync", spec["left"])

    def test_a_marked_contact_wins_over_the_detectors(self):
        self.job["contact_marks"] = {T["identity"]: [12.0, 40.75], R["identity"]: [1.33]}  # 12.0 is another swing's
        m.render(self.job)
        self.assertNotIn("contact_moment.py", self.calls)
        folder = os.path.join(self.work, "clips")
        spec = next(f for f in os.listdir(folder) if f.endswith(".sync-spec.json"))
        spec = json.load(open(os.path.join(folder, spec)))
        self.assertEqual((spec["target"]["contact"], spec["reference"]["contact"]), (40.75, 1.33))
        self.assertEqual((spec["target"]["clip"], spec["reference"]["clip"]), ("/t.mp4", "/r.mp4"))  # landmark sheet
        self.assertNotIn("in", spec["target"])                       # each window comes from the swing's landmarks
        self.assertEqual(spec["settings"]["landmarks"]["contact_off_s"], 0.35)  # a mark is not refused as early

    def test_a_refused_framing_makes_no_clip_of_that_format(self):
        self.refuse = {"whole_movement_check.py"}
        got = m.render(self.job)
        self.assertEqual((got["made"], got["failed"]), (0, 2))
        self.assertNotIn("render-an-edit.mjs", self.calls)


if __name__ == "__main__":
    unittest.main()
