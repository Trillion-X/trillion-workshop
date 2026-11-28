"""make_matched_clips progression, with each heavy piece stood in for: it picks the reference swing that partners the
most dates, per date the closest pair whose sync holds, spreads the swings over time within the length, holds one
reference crop, times one date caption per swing and renders the framed swings once with the captions."""
import json
import os
import subprocess
import sys
import tempfile
import unittest

DO = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "do-work")
sys.path.insert(0, DO)
import make_matched_clips as m  # noqa: E402

# made-up people and dates: a test may fake dates, a kept clip never does
DATES = ["2023-11-04", "2024-03-09", "2024-08-17", "2025-01-25", "2025-06-14", "2026-09-10"]
TARGETS = [{"path": f"/t{i}.mp4", "identity": "1f:" + str(i) * 64, "people": ["Ada Lane"], "date": d} for i, d in enumerate(DATES)]
REF_A = {"path": "/ra.mp4", "identity": "1f:" + "a" * 64, "people": ["Bo Reyes"], "year": "2019"}
REF_B = {"path": "/rb.mp4", "identity": "1f:" + "b" * 64, "people": ["Bo Reyes"], "year": "2017"}
SWING_S = 2.5   # each target swing's synced span


def pair(target, ref, ref_window, dist, window=0):
    peak = 10.0 + window * 5
    return {"target": m.key(target), "target_window": window, "target_peak": peak, "target_t": [peak - 1.5, peak + 1.5],
            "reference": m.key(ref), "reference_window": ref_window, "reference_peak": 1.2, "reference_t": [0.4, 2.2],
            "motion_dist": dist, "parity": "same"}


class ProgressionStage(unittest.TestCase):
    def setUp(self):
        self.work = tempfile.mkdtemp()
        self.job = {"work": self.work, "models": self.work, "targets": [dict(t) for t in TARGETS], "references": [REF_A, REF_B],
                    "movement": "forehand", "view": "back",
                    "progression": {"count": 4, "seconds": [8, 30], "label": {"format": "%b %Y", "style": {"id": "white-words-light-up", "reveal": "line"},
                                    "letters": {"edge": "top", "at": 0.5}, "fontsdir": "/fonts"}, "slow_last": {"speed": 0.5, "smooth": True}}}
        pairs = [pair(t, REF_A, 0, 0.5 + i / 10) for i, t in enumerate(TARGETS)]           # A window 0: every date
        pairs += [pair(TARGETS[0], REF_A, 0, 0.1, window=1)]                                # a closer swing that day
        pairs += [pair(t, REF_B, 2, 0.05) for t in TARGETS[:3]]                             # B: closer, fewer dates
        with open(os.path.join(self.work, "pairs.json"), "w") as f:
            json.dump({"pairs": pairs, "refused": []}, f)
        os.makedirs(os.path.join(self.work, "references-index", "_work"))
        for ref in (REF_A, REF_B):
            with open(m.kp_of(self.job, "references", m.key(ref)), "w") as f:
                json.dump({"video": {"width": 1920, "height": 1080, "fps": 30}}, f)
        self.calls, self.refuse_sync, self.refuse_framing, self.caption_in, self.rendered = [], set(), set(), None, None
        self.saved = (m.run_json, m.subprocess.run)
        m.run_json = self.fake_run_json
        m.subprocess.run = self.fake_run

    def tearDown(self):
        m.run_json, m.subprocess.run = self.saved

    def arg(self, cmd, name):
        return cmd[cmd.index(name) + 1]

    def fake_run_json(self, cmd, env=None, input_text=None):
        piece = os.path.basename(cmd[1])
        self.calls.append(piece)
        if piece == "contact_moment.py":
            return {"result": {"time": float(self.arg(cmd, "--wrist-peak")), "source": "wrist"}}
        if piece == "phase_sync.py":
            spec = m.read(self.arg(cmd, "--spec"))
            tc = spec["target"]["contact"]
            if (spec["target"]["kp"], tc) in self.refuse_sync or spec["reference"]["kp"] in self.refuse_sync:
                return {"error": "piece L2..L3 would play the reference at 5x"}
            with open(self.arg(cmd, "--out"), "w") as f:
                json.dump({"kind": "phase_sync.v1", "target": {"in": tc - 1.5, "contact": tc, "out": tc - 1.5 + SWING_S}}, f)
            return {"result": {"pieces": 9, "max_phase_error_frames": 0.2}}
        if piece == "author_comparison_edl.py":
            spec = m.read(self.arg(cmd, "--spec"))
            self.assertEqual(spec["layout"], "v")
            self.assertIn("sync", spec["left"])                        # the reference (top) is the retimed side
            sync = m.read(spec["left"]["sync"])["target"]
            x = len(self.calls)                                        # each swing's reference crop differs a little
            segs = [{"id": p["id"], "kind": "split", "layout": "v", **({"speed": p["speed"]} if p.get("speed") else {}),
                     "sources": [{"source": spec["left"]["clip"], "in": 0.4, "out": 2.2, "crop": {"x": 100 + x, "y": 50, "w": 900, "h": 800}},
                                 {"source": spec["right"]["clip"], "in": sync["in"], "out": sync["out"], "crop": {"x": 0, "y": 0, "w": 900, "h": 800}}]}
                    for p in spec["passes"]]
            with open(self.arg(cmd, "--out"), "w") as f:
                json.dump({"encode": {"width": 1080, "height": 1920, "fps": 30}, "base": {"kind": "color", "color": "black"},
                           "spine": {"segments": segs}}, f)
            return {"result": {"segments": len(segs)}}
        if piece == "caption-subtitle.mjs":
            self.caption_in = json.loads(input_text)
            return {"result": {"ass": "[Script Info]\n", "lines": [{**ln, "y": 0.535, "letters": {"top": 960, "bottom": 1011}}
                                                                    for ln in self.caption_in["lines"]]}}
        if piece == "whole_movement_check.py":
            if any(name in self.arg(cmd, "--edit") for name in self.refuse_framing):
                return {"result": {"cells_refused": 1}}
            with open(self.arg(cmd, "--write-edit"), "w") as f:
                json.dump(m.read(self.arg(cmd, "--edit")), f)
            return {"result": {"cells_refused": 0, "passes": True}}
        raise AssertionError(piece)

    def fake_run(self, cmd, **kw):
        self.calls.append(os.path.basename(cmd[1]))
        self.rendered = json.loads(self.arg(cmd, "--edl"))
        open(self.arg(cmd, "--output"), "w").close()
        return subprocess.CompletedProcess(cmd, 0, "", "")

    def test_the_reference_swing_with_the_most_dates_and_each_dates_closest_pair(self):
        got = m.progression(self.job)
        self.assertEqual(got["reference"]["key"], m.key(REF_A))      # B is closer but partners only 3 dates
        self.assertEqual(got["dates"], ["2023-11-04", "2024-08-17", "2025-06-14", "2026-09-10"])  # oldest and newest in
        record = m.read(got["record"])
        self.assertEqual(record["swings"][0]["target_window"], 1)     # that day's closest swing, not its first
        self.assertEqual(self.calls[-1], "render-an-edit.mjs")

    def test_one_segment_per_swing_the_newest_slowed_and_one_held_reference_crop(self):
        m.progression(self.job)
        segs = self.rendered["spine"]["segments"]
        self.assertEqual([s["id"] for s in segs], ["00-swing", "01-swing", "02-swing", "03-swing", "03-slow"])
        self.assertEqual(segs[-1]["speed"], 0.5)
        crops = {json.dumps(s["sources"][0]["crop"], sort_keys=True) for s in segs}
        self.assertEqual(len(crops), 1)                               # the reference never jumps
        crop = segs[0]["sources"][0]["crop"]
        self.assertAlmostEqual(crop["w"] / crop["h"], 1080 / 960, places=2)
        self.assertTrue(crop["x"] + crop["w"] <= 1920 and crop["y"] + crop["h"] <= 1080)

    def test_one_date_caption_per_swing_timed_on_whole_frames_and_burned_on_the_framed_edit(self):
        m.progression(self.job)
        lines = self.caption_in["lines"]
        self.assertEqual([ln["text"] for ln in lines], ["Nov 2023", "Aug 2024", "Jun 2025", "Sep 2026"])
        self.assertEqual(lines[0]["start"], 0)
        for a, b in zip(lines, lines[1:]):
            self.assertEqual(a["end"], b["start"])                    # no gap and no overlap between dates
        self.assertAlmostEqual(lines[1]["start"], SWING_S)
        self.assertAlmostEqual(lines[-1]["end"] - lines[-1]["start"], SWING_S + SWING_S / 0.5)  # the slow pass keeps its date
        self.assertEqual(self.caption_in["letters"], {"edge": "top", "at": 0.5})
        self.assertEqual(self.rendered["subtitles"]["fontsdir"], "/fonts")
        self.assertTrue(self.rendered["subtitles"]["ass"].startswith("[Script Info]"))

    def test_a_refused_sync_takes_that_dates_next_pair_and_a_date_with_none_is_dropped(self):
        t0 = m.kp_of(self.job, "targets", m.key(TARGETS[0]))
        t1 = m.kp_of(self.job, "targets", m.key(TARGETS[1]))
        self.refuse_sync = {(t0, 15.0), (t1, 10.0)}                  # day 0's closest swing, and day 1's only one
        got = m.progression({**self.job, "progression": {**self.job["progression"], "count": 6, "seconds": None}})
        record = m.read(got["record"])
        self.assertEqual(record["swings"][0]["target_window"], 0)
        self.assertNotIn("2024-03-09", got["dates"])
        self.assertEqual(record["dropped"][0]["date"], "2024-03-09")

    def test_a_swing_whose_cell_cannot_hold_the_movement_is_not_shown(self):
        self.refuse_framing = {f"{m.key(TARGETS[0])}-1-vs-"}             # day 0's closest swing loses its racket
        got = m.progression(self.job)
        record = m.read(got["record"])
        self.assertEqual(record["swings"][0]["target_window"], 0)    # that day's next swing is shown instead
        self.assertEqual(self.calls.count("render-an-edit.mjs"), 1)  # the whole video renders once, already framed

    def test_a_reference_swing_none_of_whose_swings_can_be_shown_gives_way_to_the_next(self):
        self.refuse_sync = {m.kp_of(self.job, "references", m.key(REF_A))}   # A partners every date, none syncs
        got = m.progression(self.job)
        self.assertEqual(got["reference"]["key"], m.key(REF_B))
        self.assertEqual(got["dates"], ["2023-11-04", "2024-03-09", "2024-08-17"])
        tried = m.read(got["record"])["references_tried"]
        self.assertEqual([(t["dates"], t["shown"]) for t in tried], [(6, 0), (3, 3)])

    def test_the_length_bounds_take_fewer_swings(self):
        got = m.progression({**self.job, "progression": {**self.job["progression"], "count": 6, "seconds": [5, 12]}})
        self.assertEqual(got["swings"], 2)                            # 3 swings and the slowed newest last 12.5 s; 2 last 10 s
        self.assertEqual(got["dates"], ["2023-11-04", "2026-09-10"])

    def test_a_named_reference_and_targets_play_in_the_order_given(self):
        p = {**self.job["progression"], "reference": {"identity": REF_B["identity"], "window": 2},
             "targets": [{"identity": TARGETS[2]["identity"]}, {"identity": TARGETS[0]["identity"]}]}
        got = m.progression({**self.job, "progression": p})
        self.assertEqual(got["reference"]["key"], m.key(REF_B))
        self.assertEqual(got["dates"], ["2024-08-17", "2023-11-04"])

    def test_a_held_reference_crop_too_big_for_the_cell_shape_is_shown_whole_on_a_fill(self):
        segs = [{"sources": [{"crop": {"x": 0, "y": 0, "w": 1080, "h": 1000}}, {}]},
                {"sources": [{"crop": {"x": 0, "y": 200, "w": 1080, "h": 1000}, "fit": {"fill": "blur"}}, {}]}]
        crop = m.hold_reference_crop(segs, {"width": 1080, "height": 1920}, 1080, 1920, "v")
        self.assertEqual(crop, {"w": 1080, "h": 1200, "x": 0, "y": 0})        # the union, cut only by the source
        fits = [s["sources"][0]["fit"] for s in segs]
        self.assertEqual(fits[0], fits[1])
        self.assertEqual(fits[0]["inner"], {"w": 864, "h": 960, "x": 108, "y": 0})
        small = [{"sources": [{"crop": {"x": 10, "y": 10, "w": 900, "h": 800}, "fit": {"fill": "blur"}}, {}]}]
        m.hold_reference_crop(small, {"width": 1920, "height": 1080}, 1080, 1920, "v")
        self.assertNotIn("fit", small[0]["sources"][0])                      # a cell-shaped crop fills its cell

    def test_no_progression_does_nothing(self):
        del self.job["progression"]
        self.assertEqual(m.progression(self.job), {"skipped": "the job has no progression"})
        self.assertEqual(self.calls, [])


if __name__ == "__main__":
    unittest.main()
