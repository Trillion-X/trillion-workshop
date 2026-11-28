"""make_matched_clips perceive reuses a kept descriptor only when it was made with the job's salience rules; one made
under other rules is described again (here the clip is missing, so the attempt shows as failed, not as kept). A
recording measured before under the same perception settings is fetched from Files by identity, not perceived, and
one refused before is not tried again."""
import json
import os
import sys
import tempfile
import unittest

DO = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "do-work")
sys.path.insert(0, DO)
import make_matched_clips as m  # noqa: E402


class PerceiveReuse(unittest.TestCase):
    def setUp(self):
        self.d = tempfile.mkdtemp()
        self.clip = {"path": os.path.join(self.d, "missing.mp4"), "identity": "1f:" + "e" * 64}
        self.job = {"work": self.d, "models": self.d, "targets": [self.clip],
                    "salience": {"quiet_edge_frac": 0.5, "min_lead_s": 0.7, "min_follow_s": 0.5}}
        index = os.path.join(self.d, "targets-index")
        os.makedirs(index)
        self.desc = os.path.join(index, f"{m.key(self.clip)}.desc.json")
        self.saved = (m.ensure_media,)
        m.ensure_media = lambda job, clip: clip["path"]   # a missing clip stays missing: perception refuses it

    def tearDown(self):
        m.ensure_media, = self.saved

    def kept_row(self, value):
        with open(os.path.join(self.d, "measured-rows.json"), "w") as f:
            json.dump([{"identity": self.clip["identity"], "fact": "perception", "part": "",
                        "fingerprint": m.perception_fingerprint(self.job), "value": value, "measured_by": {}}], f)

    def keep_desc(self, fp):
        with open(self.desc, "w") as f:
            json.dump({"salience_fp": fp, "windows": []}, f)
        os.makedirs(os.path.dirname(m.kp_of(self.job, "targets", m.key(self.clip))), exist_ok=True)
        with open(m.kp_of(self.job, "targets", m.key(self.clip)), "w") as f:   # its pose track beside it
            json.dump({"persons": []}, f)

    def test_a_descriptor_made_with_the_same_rules_is_kept(self):
        self.keep_desc(m.salience_fingerprint(json.dumps(self.job["salience"])))
        got = m.perceive(self.job, "targets")
        self.assertEqual(got["already"], [m.key(self.clip)])
        self.assertEqual(got["failed"], [])

    def test_a_descriptor_made_with_other_rules_is_described_again(self):
        self.keep_desc(m.salience_fingerprint(json.dumps({})))
        got = m.perceive(self.job, "targets")
        self.assertEqual(got["already"], [])
        self.assertEqual([f["clip"] for f in got["failed"]], [self.clip["path"]])

    def test_a_recording_measured_before_is_fetched_by_identity_not_perceived(self):
        self.job["call"] = ["engine"]
        self.kept_row({"descriptor": "1f:" + "d" * 64, "pose_track": "1f:" + "f" * 64})
        import files_road
        fetched, saved = [], files_road.fetch

        def fetch(call, identity, dest):
            fetched.append(identity)
            field = "source" if identity.startswith("1f:d") else "video"
            with open(dest, "w") as f:
                json.dump({field: {"path": "/another/work/folder/clip.mp4"}, "windows": []}, f)
        files_road.fetch = fetch
        try:
            got = m.perceive(self.job, "targets")
        finally:
            files_road.fetch = saved
        self.assertEqual((got["reused"], got["failed"]), ([m.key(self.clip)], []))
        self.assertEqual(fetched, ["1f:" + "d" * 64, "1f:" + "f" * 64])
        self.assertEqual(m.read(self.desc)["source"]["path"], self.clip["path"])   # this work folder's clip

    def test_a_recording_refused_before_is_not_tried_again(self):
        self.kept_row({"refused": "no athlete track"})
        got = m.perceive(self.job, "targets")
        self.assertEqual(([b["why"] for b in got["refused_before"]], got["failed"]), (["no athlete track"], []))

    def test_other_perception_settings_measure_again(self):
        self.kept_row({"refused": "no athlete track"})
        self.job["model_identities"] = {"pose.onnx": "1f:" + "9" * 64}
        got = m.perceive(self.job, "targets")
        self.assertEqual((got["refused_before"], len(got["failed"])), ([], 1))

    def test_the_fingerprint_ignores_key_order(self):
        a = json.dumps({"min_lead_s": 0.7, "quiet_edge_frac": 0.5})
        b = json.dumps({"quiet_edge_frac": 0.5, "min_lead_s": 0.7})
        self.assertEqual(m.salience_fingerprint(a), m.salience_fingerprint(b))


class PerceiveSeveralAtOnce(unittest.TestCase):
    """Clips not yet described are described perceive_parallel at a time; each result lands in made or failed."""

    def test_clips_are_described_several_at_once(self):
        import subprocess
        import threading
        import time
        d = tempfile.mkdtemp()
        clips = [{"path": os.path.join(d, f"{c}.mp4"), "identity": "1f:" + c * 64} for c in "abcde"]
        job = {"work": d, "models": d, "targets": clips, "perceive_parallel": 3}
        live, most, lock = [0], [0], threading.Lock()

        real = m.subprocess.run

        def run(cmd, **kw):
            if "--out" not in cmd:                        # other tools (the fingerprint's b3sum) run for real
                return real(cmd, **kw)
            with lock:
                live[0] += 1
                most[0] = max(most[0], live[0])
            time.sleep(0.2)
            with lock:
                live[0] -= 1
            out = cmd[cmd.index("--out") + 1]
            if not os.path.basename(out).startswith("e-"):   # every clip but the last is described
                os.makedirs(os.path.dirname(out), exist_ok=True)
                open(out, "w").write("{}")
            return subprocess.CompletedProcess(cmd, 1 if os.path.basename(out).startswith("e-") else 0, "", "no athlete track")
        saved = (m.ensure_media, m.subprocess.run)
        m.ensure_media = lambda job, clip: clip["path"]
        m.subprocess.run = run
        try:
            got = m.perceive(job, "targets")
        finally:
            m.ensure_media, m.subprocess.run = saved
        self.assertEqual(most[0], 3)
        self.assertEqual(got["made"], [m.key(c) for c in clips[:4]])     # in the job's order
        self.assertEqual([f["identity"] for f in got["failed"]], [clips[4]["identity"]])


if __name__ == "__main__":
    unittest.main()
