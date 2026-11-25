"""make_matched_clips perceive reuses a kept descriptor only when it was made with the job's salience rules; one made
under other rules is described again (here the clip is missing, so the attempt shows as failed, not as kept)."""
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

    def keep_desc(self, fp):
        with open(self.desc, "w") as f:
            json.dump({"salience_fp": fp, "windows": []}, f)

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

    def test_the_fingerprint_ignores_key_order(self):
        a = json.dumps({"min_lead_s": 0.7, "quiet_edge_frac": 0.5})
        b = json.dumps({"quiet_edge_frac": 0.5, "min_lead_s": 0.7})
        self.assertEqual(m.salience_fingerprint(a), m.salience_fingerprint(b))


if __name__ == "__main__":
    unittest.main()
