"""Tests of fine-tune-a-small-model-on-a-persons-rules with made-up laws and lines. Building the rows, the report and
reporting again from kept scores run for real; training and scoring need a decider model and torch, so only their
refusals are tested here."""
import json
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

HERE = Path(__file__).resolve().parent
TOOL = HERE.parent
sys.path.insert(0, str(TOOL / "read-data"))
sys.path.insert(0, str(TOOL / "do-work"))
from score_held_out_lines import at_fpr, auc, report  # noqa: E402
from common import with_settings  # noqa: E402

LAWS = {
    "plain-words": {"question": "Does this line use a word a child would not know?", "options": ["no", "yes"], "fail": "yes", "bad_from": ["plain-words"]},
    "said-aloud": {"question": "Would a person say this line out loud?", "options": ["no", "yes"], "fail": "no", "bad_from": ["said-aloud", "stiff"]},
}


def run(script, req):
    p = subprocess.run([sys.executable, "-I", str(TOOL / "do-work" / script), "-"], input=json.dumps(req), capture_output=True, text=True)
    return p.returncode, json.loads(p.stdout.strip().splitlines()[-1]), p


class Fixture:
    def __init__(self, root):
        self.root = Path(root)
        docs = self.root / "docs"
        docs.mkdir()
        (docs / "guide.md").write_text("# Plain words\n\nBad: We leverage synergies.\nGood: We fix the sink.\n\n# Out loud\n\nBad: Herewith the parcel.\n")
        (self.root / "talk.txt").write_text("00:00:01 start\n" + " ".join(f"I walked to shop number {i} today." for i in range(12)))
        caps = self.root / "captions"
        caps.mkdir()
        for v in range(6):
            (caps / f"vid{v}.info.json").write_text(json.dumps({"subtitles": {"en": []}}))
            events = [{"segs": [{"utf8": f"Video {v} says the bread was warm and the tea was sweet number {k}. "}]} for k in range(5)]
            (caps / f"vid{v}.en.json3").write_text(json.dumps({"events": events}))
        self.labelled = [
            {"text": "We leverage synergies.", "sets": ["bad-set"], "bad_for": ["plain-words"]},
            {"text": "We fix the sink.", "sets": ["good-set"], "bad_for": []},
            {"text": "Herewith the parcel.", "sets": ["bad-set"], "bad_for": ["stiff"]},
            {"text": "A line ruled nothing.", "sets": ["other"], "bad_for": []},
        ]
        self.synthetic = [
            {"law": "plain-words", "text": "Utilise the paradigm.", "label": "bad"},
            {"law": "plain-words", "text": "Use the plan.", "label": "good"},
            {"law": "said-aloud", "text": "Pursuant to the aforementioned.", "label": "bad"},
            {"law": "said-aloud", "text": "As I said before.", "label": "good"},
            {"law": "said-aloud", "text": "Whereupon.", "label": "bad", "kind": "short-bad"},
            {"law": "*", "text": "Open the door.", "label": "good", "kind": "short"},
            {"law": "*", "text": "The held-out card.", "label": "good", "kind": "short"},
        ]

    def request(self, **over):
        req = {"laws": LAWS, "out_dir": str(self.root / "out"), "seed": 7, "test_share": 0.5, "good_sets": ["good-set", "spoken", "captions"],
               "fail_set": "bad-set", "pass_set": "good-set", "group_by_headings_in": str(self.root / "docs"),
               "labelled_lines": self.labelled,
               "spoken": {"set": "spoken", "transcript_file": str(self.root / "talk.txt"), "per_split": 4},
               "captions": {"set": "captions", "folder": str(self.root / "captions"), "per_video": 2, "train": 3, "test": 3,
                            "max_characters": 8000, "min_words": 6, "max_words": 40},
               "never_train": ["Herewith the parcel."], "held_out": [{"text": "The held-out card.", "kind": "card", "breaks": [], "unsure": []}],
               "synthetic": self.synthetic, "per_law": {"spoken_goods": 2, "other_goods": 1, "short_goods": 1},
               "short_kinds": ["short"], "no_other_goods": ["said-aloud"]}
        req.update(over)
        return req


class BuildRows(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.fx = Fixture(self.tmp.name)

    def tearDown(self):
        self.tmp.cleanup()

    def test_builds_items_and_rows(self):
        code, ans, p = run("build_training_rows.py", self.fx.request())
        self.assertEqual(code, 0, p.stderr)
        res = ans["result"]
        items = json.loads(Path(res["items_file"]).read_text())
        self.assertEqual(items["narrator"], ["Herewith the parcel."])
        texts = {it["text"] for it in items["items"]}
        self.assertNotIn("Herewith the parcel.", texts)                      # never-train lines are never items
        self.assertNotIn("A line ruled nothing.", texts)                     # only the fail and pass sets are kept
        bad = next(it for it in items["items"] if it["text"] == "We leverage synergies.")
        self.assertEqual(bad["bad_laws"], ["plain-words"])
        self.assertFalse(bad["good"])
        self.assertEqual(bad["group"], "guide.md::# Plain words")
        spoken = [it for it in items["items"] if "spoken" in it["sets"]]
        self.assertTrue(all(it["group"] == ("spoken-a" if it["split"] == "train" else "spoken-b") for it in spoken))
        caps = [it for it in items["items"] if "captions" in it["sets"]]
        self.assertTrue(caps and all(it["group"].startswith("video:vid") for it in caps))
        rows = [json.loads(ln) for ln in Path(res["train_file"]).read_text().splitlines()]
        self.assertEqual(len(rows), res["train_rows"])
        self.assertNotIn("The held-out card.", {r["text"] for r in rows})    # a held-out line never trains
        self.assertEqual(res["synthetic_dropped"], 1)
        said = [r for r in rows if r["law"] == "said-aloud"]
        self.assertFalse([r for r in said if r["source"] == "synthetic-other-law-good"])
        bad_said = next(r for r in said if r["text"] == "Pursuant to the aforementioned.")
        self.assertEqual(bad_said["gold"], 0)                                  # fail is "no": a bad line's gold is "no"
        self.assertTrue(bad_said["bad"])
        self.assertIn("Whereupon.", {r["text"] for r in said if r["bad"]})    # a law's own short bad line trains that law
        self.assertIn("items ", p.stdout.splitlines()[0])                      # the summary comes before the answer

    def test_same_request_same_rows(self):
        run("build_training_rows.py", self.fx.request())
        first = (self.fx.root / "out/train.jsonl").read_text()
        run("build_training_rows.py", self.fx.request())
        self.assertEqual(first, (self.fx.root / "out/train.jsonl").read_text())

    def test_explicit_families_and_source_labels_survive_training_projection(self):
        labelled = [
            {**self.fx.labelled[0], "id": "source:bad", "family": "shared-scene", "provenance": {"record": "source:bad"}},
            {**self.fx.labelled[1], "id": "source:good", "family": "shared-scene", "provenance": {"record": "source:good"}},
            {**self.fx.labelled[1], "id": "source:good-copy", "family": "shared-scene", "provenance": {"record": "source:good-copy"}},
        ]
        for share in (0, 1):
            code, answer, process = run("build_training_rows.py", self.fx.request(
                labelled_lines=labelled, test_share=share, synthetic=[], never_train=[]))
            self.assertEqual(code, 0, process.stderr)
            items = json.loads(Path(answer["result"]["items_file"]).read_text())["items"]
            bound = [item for item in items if "family" in item]
            self.assertEqual({item["group"] for item in bound}, {"family:shared-scene"})
            self.assertEqual({item["split"] for item in bound}, {"test" if share else "train"})
            good = next(item for item in bound if item["good"])
            self.assertEqual({source["id"] for source in good["source_records"]}, {"source:good", "source:good-copy"})
            self.assertEqual(good["source_records"][0]["sets"], ["good-set"])
            self.assertEqual(good["source_records"][0]["provenance"], {"record": "source:good"})
            training = [json.loads(line) for line in Path(answer["result"]["train_file"]).read_text().splitlines()]
            bound_rows = [row for row in training if "family" in row]
            self.assertEqual(bool(bound_rows), not bool(share))
            self.assertTrue(all(row["source_records"] for row in bound_rows))

    def test_conflicting_source_families_are_refused_before_writing(self):
        labelled = [{**self.fx.labelled[0], "id": "source:a", "family": "scene-a"},
                    {**self.fx.labelled[0], "id": "source:b", "family": "scene-b"}]
        code, answer, _ = run("build_training_rows.py", self.fx.request(labelled_lines=labelled))
        self.assertEqual(code, 2)
        self.assertIn("conflicting source families", answer["error"])
        self.assertFalse((self.fx.root / "out/train.jsonl").exists())

    def test_source_identity_requires_a_family_and_valid_provenance(self):
        for extra, message in (({"id": "source:a"}, "family"),
                               ({"family": "scene-a"}, "id"),
                               ({"id": "source:a", "family": "scene-a", "provenance": []}, "provenance")):
            code, answer, _ = run("build_training_rows.py", self.fx.request(labelled_lines=[{**self.fx.labelled[0], **extra}]))
            self.assertEqual(code, 2)
            self.assertIn(message, answer["error"])

    def test_held_out_real_line_keeps_its_whole_family_out_of_training(self):
        labelled = [{**line, "id": f"source:{index}", "family": "shared-scene"}
                    for index, line in enumerate(self.fx.labelled[:2])]
        code, answer, process = run("build_training_rows.py", self.fx.request(
            labelled_lines=labelled, test_share=0, held_out=[{"text": labelled[0]["text"]}]))
        self.assertEqual(code, 0, process.stderr)
        items = json.loads(Path(answer["result"]["items_file"]).read_text())["items"]
        self.assertEqual({item["split"] for item in items if "family" in item}, {"test"})
        training = [json.loads(line) for line in Path(answer["result"]["train_file"]).read_text().splitlines()]
        self.assertFalse([row for row in training if "family" in row])

    def test_conflicting_source_ids_or_labels_are_refused(self):
        cases = [
            ([{**line, "id": "source:one", "family": "scene"} for line in self.fx.labelled[:2]], "source id"),
            ([{**self.fx.labelled[0], "id": "source:a", "family": "scene"},
              {**self.fx.labelled[0], "id": "source:b", "family": "scene", "sets": ["good-set"]}], "pass and fail"),
        ]
        for labelled, message in cases:
            code, answer, _ = run("build_training_rows.py", self.fx.request(labelled_lines=labelled))
            self.assertEqual(code, 2)
            self.assertIn(message, answer["error"])

    def test_filtered_held_out_line_still_excludes_its_source_family(self):
        for filter_kind in ("never_train", "unlabelled"):
            labelled = [{**line, "id": f"source:{index}", "family": "shared-scene"}
                        for index, line in enumerate(self.fx.labelled[:2])]
            never_train = []
            if filter_kind == "never_train":
                never_train = [labelled[0]["text"]]
            else:
                labelled[0]["sets"] = ["not-a-training-label"]
            code, answer, process = run("build_training_rows.py", self.fx.request(
                labelled_lines=labelled, test_share=0, never_train=never_train,
                held_out=[{"text": labelled[0]["text"]}]))
            self.assertEqual(code, 0, process.stderr)
            items = json.loads(Path(answer["result"]["items_file"]).read_text())["items"]
            bound = [item for item in items if "family" in item]
            self.assertEqual({item["text"] for item in bound}, {labelled[1]["text"]})
            self.assertEqual({item["split"] for item in bound}, {"test"})
            training = [json.loads(line) for line in Path(answer["result"]["train_file"]).read_text().splitlines()]
            self.assertFalse([row for row in training if "family" in row])

    def test_unsampled_spoken_and_caption_lines_hold_out_their_groups(self):
        request = self.fx.request(labelled_lines=[], test_share=0, synthetic=[], never_train=[], held_out=[])
        code, answer, process = run("build_training_rows.py", request)
        self.assertEqual(code, 0, process.stderr)
        first = json.loads(Path(answer["result"]["items_file"]).read_text())["items"]
        sampled = {item["text"] for item in first}
        spoken = next(f"I walked to shop number {index} today." for index in range(6)
                      if f"I walked to shop number {index} today." not in sampled)
        caption_group = next(item["group"] for item in first if item["group"].startswith("video:"))
        video = int(caption_group.removeprefix("video:vid"))
        caption = next(f"Video {video} says the bread was warm and the tea was sweet number {index}." for index in range(5)
                       if f"Video {video} says the bread was warm and the tea was sweet number {index}." not in sampled)
        request["held_out"] = [{"text": spoken}, {"text": caption}]
        code, answer, process = run("build_training_rows.py", request)
        self.assertEqual(code, 0, process.stderr)
        items = json.loads(Path(answer["result"]["items_file"]).read_text())["items"]
        self.assertTrue(any(item["group"] == "spoken-a" for item in items))
        self.assertTrue(any(item["group"] == caption_group for item in items))
        self.assertTrue(all(item["split"] == "test" for item in items if item["group"] in ("spoken-a", caption_group)))
        training = [json.loads(line) for line in Path(answer["result"]["train_file"]).read_text().splitlines()]
        excluded = {item["text"] for item in items if item["group"] in ("spoken-a", caption_group)}
        self.assertTrue(excluded.isdisjoint(row["text"] for row in training))

    def test_lines_from_a_file(self):
        f = self.fx.root / "labelled.jsonl"
        f.write_text("".join(json.dumps(x) + "\n" for x in self.fx.labelled))
        req = self.fx.request(labelled_lines={"file": str(f)})
        del req["spoken"], req["captions"]
        code, ans, p = run("build_training_rows.py", req)
        self.assertEqual(code, 0, p.stderr)
        self.assertEqual(ans["result"]["items"], 2)

    def test_refusals_say_what_to_change(self):
        code, ans, _ = run("build_training_rows.py", self.fx.request(laws={}))
        self.assertEqual(code, 2)
        self.assertIn("laws", ans["error"])
        bad = {"x": {"question": "Q?", "options": ["no", "yes"], "fail": "maybe", "bad_from": []}}
        code, ans, _ = run("build_training_rows.py", self.fx.request(laws=bad))
        self.assertIn("fail must be one of them", ans["error"])
        req = self.fx.request()
        del req["seed"]
        code, ans, _ = run("build_training_rows.py", req)
        self.assertIn("seed is required", ans["error"])


class Settings(unittest.TestCase):
    def test_the_steps_settings_lie_under_the_request(self):
        with tempfile.TemporaryDirectory() as tmp:
            fx = Fixture(tmp)
            full = fx.request()
            step = {k: full[k] for k in ("seed", "test_share", "good_sets", "fail_set", "pass_set", "per_law", "short_kinds", "no_other_goods", "never_train")}
            step["spoken"] = {"set": "spoken", "per_split": 4}
            given = {k: full[k] for k in ("laws", "out_dir", "labelled_lines", "synthetic", "held_out", "group_by_headings_in")}
            given["spoken"] = {"transcript_file": full["spoken"]["transcript_file"]}
            req = with_settings({**given, "settings": {"build": step, "train": {"rank": 8}}}, "build", "fine-tune-a-small-model-on-a-persons-rules")
            self.assertEqual(req["spoken"], {"set": "spoken", "per_split": 4, "transcript_file": full["spoken"]["transcript_file"]})
            self.assertEqual(req["seed"], 7)
            self.assertNotIn("rank", req)
            code, ans, p = run("build_training_rows.py", {**given, "settings": {"build": step}})
            self.assertEqual(code, 0, p.stdout)
            del full["captions"]
            run_full = run("build_training_rows.py", {**full, "out_dir": str(Path(tmp) / "full")})
            self.assertEqual(run_full[0], 0)
            self.assertEqual((Path(tmp) / "out/train.jsonl").read_text(), (Path(tmp) / "full/train.jsonl").read_text())

    def test_a_settings_record_as_the_door_reads_it(self):
        folder = "fine-tune-a-small-model-on-a-persons-rules"
        value = {"name": "made-up", "tool": "tool:score-held-out-lines-with-a-small-model", "scope_kind": "account", "scope_id": "my-rules", "status": "active",
                 "settings": json.dumps({"score": {"batch": 4, "pass_set": "good-set"}}, sort_keys=True)}
        record = {"id": f"record:setting:{folder}~account~my-rules", "type": "record:setting", "value": value}
        req = with_settings({"name": "n", "batch": 8, "settings_record": record}, "score", folder)
        self.assertEqual(req, {"pass_set": "good-set", "batch": 8, "name": "n"})   # the request wins over its settings
        with tempfile.TemporaryDirectory() as tmp:
            items = Path(tmp) / "items.json"
            items.write_text(json.dumps({"laws": LAWS, "narrator": [], "items": []}))
            retired = {**record, "value": {**value, "status": "retired"}}
            code, ans, _ = run("score_held_out_lines.py", {"name": "x", "items_file": str(items), "out_dir": tmp, "settings_record": retired})
            self.assertEqual(code, 2)
            self.assertIn("retired", ans["error"])
            other = {**record, "id": "record:setting:another-tool~account~my-rules"}
            code, ans, _ = run("score_held_out_lines.py", {"name": "x", "items_file": str(items), "out_dir": tmp, "settings_record": other})
            self.assertIn("holds no row record:setting:fine-tune-a-small-model-on-a-persons-rules~", ans["error"])
            two = [record, {**record, "id": f"record:setting:{folder}~account~other"}]
            req = with_settings({"name": "n", "settings_record": two, "settings_scope": ["account", "my-rules"]}, "score", folder)
            self.assertEqual(req["batch"], 4)

    def test_no_settings_leaves_the_request(self):
        self.assertEqual(with_settings({"a": 1}, "build", "x"), {"a": 1})


class Report(unittest.TestCase):
    def test_auc_and_threshold(self):
        self.assertEqual(auc([0.9, 0.8], [0.1, 0.2]), 1.0)
        self.assertEqual(auc([0.5], [0.5]), 0.5)
        t, recall, failed = at_fpr([0.9, 0.3], [0.1, 0.2, 0.4], 0.0)
        self.assertEqual((recall, failed), (0.5, 0.0))
        self.assertEqual(t, 0.4)                                            # 0.4 plus the tie step, rounded

    def test_report_per_law(self):
        test = [{"text": "a", "good": False, "bad_laws": ["r"], "bad_for": ["r"], "sets": ["bad"]},
                {"text": "b", "good": True, "bad_laws": [], "bad_for": [], "sets": ["good"]},
                {"text": "c", "good": True, "bad_laws": [], "bad_for": [], "sets": ["spoken"]},
                {"text": "d", "good": False, "bad_laws": [], "bad_for": ["other"], "sets": ["bad"]}]
        held = [{"text": "e", "kind": "card", "breaks": [], "unsure": []}, {"text": "f", "kind": "card", "breaks": ["r"], "unsure": []}]
        pf = {("r", 0): 0.9, ("r", 1): 0.1, ("r", 2): 0.2, ("r", 3): 0.95, ("r", "never"): 0.99, ("r", ("film", 0)): 0.05, ("r", ("film", 1)): 0.97}
        out = report({"r": {"question": "Q?", "fail": "yes"}}, test, {"narrator": ["never"]}, held, pf, "good")["r"]
        self.assertEqual(out["auc"], 1.0)
        self.assertEqual(out["written_good"]["n_good"], 1)
        self.assertEqual(out["other_law_bad_flagged_at_2pct"]["rate"], 1.0)
        self.assertEqual(out["film"]["bad_caught_at_2pct"], "1/1")
        self.assertTrue(out["narrator"]["never"]["fails_at_2pct"])

    def test_a_held_out_set_with_no_good_lines(self):
        test = [{"text": "a", "good": False, "bad_laws": ["r"], "bad_for": ["r"], "sets": ["bad"]},
                {"text": "b", "good": True, "bad_laws": [], "bad_for": [], "sets": ["good"]}]
        held = [{"text": "f", "kind": "card", "breaks": ["r"], "unsure": []}]
        pf = {("r", 0): 0.9, ("r", 1): 0.1, ("r", ("film", 0)): 0.97}
        out = report({"r": {"question": "Q?", "fail": "yes"}}, test, {"narrator": []}, held, pf, "good")["r"]
        self.assertEqual(out["film"], {"n_good": 0, "n_bad": 1})


class ScoreAgain(unittest.TestCase):
    def test_reports_again_from_kept_scores(self):
        with tempfile.TemporaryDirectory() as tmp:
            fx = Fixture(tmp)
            _, built, _ = run("build_training_rows.py", fx.request())
            items = json.loads(Path(built["result"]["items_file"]).read_text())
            n = sum(it["split"] == "test" for it in items["items"])
            kept = {"adapter": "an-adapter", "scores": {lid: {"test": [0.5] * n, "narrator": {"Herewith the parcel.": 0.7}, "film": [0.2]} for lid in LAWS}}
            (Path(tmp) / "kept.json").write_text(json.dumps(kept))
            req = {"name": "again", "items_file": built["result"]["items_file"], "out_dir": tmp, "pass_set": "good-set",
                   "held_out": fx.request()["held_out"], "scores_from": str(Path(tmp) / "kept.json")}
            code, ans, p = run("score_held_out_lines.py", req)
            self.assertEqual(code, 0, p.stderr)
            again = json.loads(Path(ans["result"]["results_file"]).read_text())
            self.assertEqual(again["adapter"], "an-adapter")
            self.assertEqual(again["scores"]["plain-words"]["test"], [0.5] * n)
            req["held_out"] = []
            code, ans, _ = run("score_held_out_lines.py", req)
            self.assertIn("score them again", ans["error"])

    def test_model_runs_refuse_a_folder_that_is_not_a_decider(self):
        with tempfile.TemporaryDirectory() as tmp:
            items = Path(tmp) / "items.json"
            items.write_text(json.dumps({"laws": LAWS, "narrator": [], "items": []}))
            train = Path(tmp) / "train.jsonl"
            train.write_text("")
            req = {"name": "x", "items_file": str(items), "out_dir": tmp, "pass_set": "p", "base_model": tmp, "frame": "{text}"}
            code, ans, _ = run("score_held_out_lines.py", req)
            self.assertEqual(code, 2)
            self.assertIn("is not a decider model folder", ans["error"])
            code, ans, _ = run("train_an_adapter.py", {"base_model": tmp})
            self.assertIn("out is required", ans["error"])
            full = {"base_model": tmp, "frame": "{text}", "train_file": str(train), "out": str(Path(tmp) / "a"), "rank": 8, "epochs": 1,
                    "lr": 0.0001, "batch": 8, "budget_minutes": 1, "seed": 1, "lora_targets": ["q_proj"]}
            code, ans, _ = run("train_an_adapter.py", full)
            self.assertIn("is not a decider model folder", ans["error"])
            code, ans, _ = run("train_an_adapter.py", {**full, "frame": "no slot"})
            self.assertIn("is not a decider model folder", ans["error"])


if __name__ == "__main__":
    unittest.main()
