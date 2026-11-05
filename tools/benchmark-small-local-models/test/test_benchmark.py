"""Tests of every command with made-up inputs. The model scripts run against stand-in modules (test/stubs, put first on
PYTHONPATH) and stand-in decider snapshots in a made-up Hugging Face cache, so each test knows the right answer: a
stand-in model prefers what shares words with the picture or text (test/stubs/stand_in_words.py). ffprobe and the
frame tool are stand-in programs (test/stand-in-programs) put first on PATH. A made-up picture is a file of words; a
made-up video is a file holding `<width>x<height> <seconds> <rotation>`."""
import json
import os
import shutil
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

HERE = Path(__file__).resolve().parent
WORK = HERE.parent / "do-work"
READ = HERE.parent / "read-data"
PROGRAMS = HERE / "stand-in-programs"


class Case(unittest.TestCase):
    def setUp(self):
        self.dir = Path(tempfile.mkdtemp())
        cache = self.dir / "hub"
        for repo in ("someone/decider-small", "someone/decider-small-vision"):
            shutil.copytree(HERE / "stand-in-decider", cache / f"models--{repo.replace('/', '--')}" / "snapshots" / "abc")
        self.env = dict(os.environ, PYTHONPATH=str(HERE / "stubs"), HF_HUB_CACHE=str(cache),
                        PATH=f"{PROGRAMS}{os.pathsep}{os.environ.get('PATH', '')}")
        self.env.pop("DECIDER_DEVICE", None)

    def tearDown(self):
        shutil.rmtree(self.dir)

    def run_script(self, script, request, isolated=False):
        path = (READ if script == "template_blanks.py" else WORK) / script
        args = [sys.executable] + (["-I"] if isolated else []) + [str(path)]
        done = subprocess.run(args, input=json.dumps(request), capture_output=True, text=True, env=self.env)
        lines = done.stdout.strip().splitlines()
        self.assertTrue(lines, done.stderr)
        return done.returncode, json.loads(lines[-1])

    def ok(self, script, request, isolated=False):
        code, last = self.run_script(script, request, isolated)
        self.assertEqual(code, 0, last)
        return last["result"]

    def file(self, name, text):
        path = self.dir / name
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(text if isinstance(text, str) else json.dumps(text))
        return str(path)


VOCAB = {"size": {"wide": "a wide shot of the whole place", "close": "a close shot of a face"},
         "colour": {"red": "a red frame", "blue": "a blue frame"}}


class Library(Case):
    """A made-up format library: formats/<creator>/<video>/shots.tsv and videos/<video>.mp4."""

    def video(self, creator, video, rows, size="1920x1080 30 0", media=True):
        folder = self.dir / "library" / "formats" / creator / video
        folder.mkdir(parents=True)
        (folder / "shots.tsv").write_text("t0\tt1\tsize\tkind\tscreen\n" + "".join(f"{a}\t{b}\t{s}\t{k}\t{sc}\n" for a, b, s, k, sc in rows))
        if media:
            (self.dir / "library" / "videos").mkdir(parents=True, exist_ok=True)
            (self.dir / "library" / "videos" / f"{video}.mp4").write_text(size)

    def test_shots_are_spread_over_creators_spaced_and_shaped(self):
        self.video("c1", "v1", [(0, 1, "wide,close", "a-roll", "none"), (1, 1.2, "close", "a-roll", "none"), ("", "", "close", "a-roll", "none")]
                   + [(k, k + 1, "close", "a-roll", "none") for k in range(2, 30)], "1080x1920 40 0")
        self.video("c2", "v2", [(0, 2, "unknown", "b-roll", "none")], "1920x1080 30 90")
        self.video("c3", "v3", [(0, 2, "close", "b-roll", "none")], media=False)
        request = {"library": str(self.dir / "library"), "seed": 17, "videos": 5, "rounds": 2, "big_creator": 10,
                   "per_video": 10, "min_seconds": 0.4, "fields": ["size", "kind"]}
        r = self.ok("sample_shots_across_groups.py", request, isolated=True)
        self.assertEqual((r["videos"], r["creators"]), (2, 2))
        v1 = [s for s in r["shots"] if s["video"] == "v1"]
        self.assertEqual(len(v1), 10)
        self.assertEqual(v1[0]["reference"], {"size": "wide,close", "kind": "a-roll"})
        self.assertNotIn(1, [s["row"] for s in v1])
        self.assertEqual((v1[0]["w"], v1[0]["h"]), (1080, 1920))
        v2 = next(s for s in r["shots"] if s["video"] == "v2")
        self.assertEqual((v2["w"], v2["h"], v2["t_mid"]), (1080, 1920, 1.0))
        self.assertEqual(r, self.ok("sample_shots_across_groups.py", request, isolated=True))

    def test_candidates_are_one_per_video_of_the_right_kind(self):
        for k in range(12):
            self.video(f"c{k}", f"v{k}", [(0, 2, "close", "screen", "screen-filmed"), (2, 4, "wide", "a-roll", "none")],
                       f"1920x1080 {500 if k == 3 else 30} 0")
        self.video("own", "own-1", [(0, 2, "close", "screen", "screen-filmed")])
        r = self.ok("sample_candidates_for_slots.py", {
            "library": str(self.dir / "library"), "exclude_prefix": "own",
            "slots": [{"slot": 1, "desc": "a filmed laptop screen", "kind": ["screen"], "need_screen": ["screen-filmed"]},
                      {"slot": 2, "desc": "a person talking", "kind": ["a-roll"]}]}, isolated=True)
        one, two = r["slots"]
        self.assertEqual(len(one["cands"]), 10)
        self.assertEqual(len({c["video"] for c in one["cands"]}), 10)
        self.assertNotIn("v3", [c["video"] for c in one["cands"]])
        self.assertNotIn("own-1", [c["video"] for c in one["cands"]])
        self.assertTrue(one["cands"][0]["text"].startswith("kind: screen; shot_size: ; angle: "))
        self.assertEqual(two["kind"], ["a-roll"])
        self.assertEqual(two["cands"][0]["t_mid"], 3.0)

    def test_frames_are_cut_per_video_and_copied_by_sample_order(self):
        self.video("c1", "v1", [], "1920x1080 5 0")
        shots = [{"video": "v1", "t_mid": 1.0}, {"video": "v1", "t_mid": 2.5}, {"video": "v1", "t_mid": 9.0}]
        out = self.dir / "work"
        r = self.ok("cut_sample_frames.py", {"shots": shots, "library": str(self.dir / "library"),
                                             "frame_tool": str(PROGRAMS / "hf-media"), "out_dir": str(out)}, isolated=True)
        self.assertEqual(r["frames"], 2)
        self.assertEqual(Path(r["shots"][1]["frame"]).read_text(), "v1 at 2.5")
        slots = [{"slot": 4, "cands": [{"video": "v1", "t_mid": 1.0}, {"video": "v1", "t_mid": 9.0}]}]
        r = self.ok("cut_candidate_frames.py", {"slots": {"slots": slots}, "library": str(self.dir / "library"),
                                                "frame_tool": str(PROGRAMS / "hf-media"), "out_dir": str(out)}, isolated=True)
        self.assertEqual(r["frames"], 1)
        self.assertTrue(r["slots"][0]["cands"][0]["frame"].endswith("s4-c0.png"))
        self.assertNotIn("frame", r["slots"][0]["cands"][1])
        code, last = self.run_script("cut_sample_frames.py", {"shots": shots, "library": str(self.dir / "library"),
                                                              "frame_tool": str(self.dir / "absent"), "out_dir": str(out)}, isolated=True)
        self.assertEqual(code, 2)
        self.assertIn("frame_tool", last["error"])


class Labels(Case):
    def shots(self):
        return [{"frame": self.file("a.png", "wide red"), "reference": {"place": "red room"}, "w": 1920, "h": 1080},
                {"frame": self.file("b.png", "close blue"), "reference": {"place": "blue sky"}, "w": 1080, "h": 1920},
                {"note": "no frame"}]

    def test_image_text_model_ranks_each_value_bare_and_defined(self):
        r = self.ok("label_frames_with_image_text_model.py", {"shots": self.shots(), "vocabulary": VOCAB, "model": "some/clip",
                                                              "tag": "clip", "device": "cpu"})
        a, b = r["rows"]
        for mode in ("bare", "defined"):
            self.assertEqual(a[f"size|{mode}"][0], "wide")
            self.assertEqual(b[f"colour|{mode}"][0], "blue")
            self.assertEqual(len(a[f"size|{mode}|all"]), 2)
        self.assertEqual((r["meta"]["tag"], r["meta"]["n"], r["meta"]["mps_GB"]), ("clip", 2, None))

    def test_vision_decider_runs_a_tournament_past_ten_values(self):
        many = {"size": {f"v{k}": f"value {k}" for k in range(11)} | {"wide": "a wide one"}}
        r = self.ok("label_frames_with_vision_decider.py", {
            "shots": self.shots()[:1], "vocabulary": many, "questions": {"size": "How wide?"}, "context": "One frame.",
            "model": "someone/decider-small-vision", "mode": "bare", "device": "mps"})
        row = r["rows"][0]
        self.assertEqual(row["size|bare"][0], "wide")
        self.assertGreater(row["size|bare|conf"], 0.9)
        self.assertEqual(r["meta"]["mps_GB"], 2.0)
        code, last = self.run_script("label_frames_with_vision_decider.py", {
            "shots": self.shots(), "vocabulary": VOCAB, "questions": {"size": "?"}, "context": "",
            "model": "someone/decider-small-vision", "mode": "bare", "device": "cpu"})
        self.assertEqual(code, 2)
        self.assertIn("colour", last["error"])

    def test_vision_language_model_answers_one_json_per_frame(self):
        r = self.ok("label_frames_with_vision_language_model.py", {
            "shots": self.shots(), "vocabulary": VOCAB, "phrases": {"place": "a short phrase for the kind of place"},
            "instruction": "Label this frame.", "model": "some/vlm", "max_tokens": 50})
        a, b = r["rows"]
        self.assertEqual((a["size"], a["colour"], b["size"], b["colour"]), ("wide", "red", "close", "blue"))
        self.assertEqual(a["place"], "wide red")
        self.assertEqual(r["meta"]["peak_mem_GB"], 3.0)

    def test_free_text_places_are_ranked_two_ways(self):
        phrased = self.file("phrased.json", {"meta": {"model": "vlm"}, "rows": [{"i": 0, "place": "red room"}, {"i": 1, "place": "blue sky"}]})
        r = self.ok("rank_free_text_places.py", {"shots": self.shots(), "field": "place", "phrased": phrased,
                                                 "embedder": "some/embedder", "image_text_model": "some/clip", "device": "cpu"})
        self.assertEqual(r["distinct_places"], 2)
        self.assertEqual(r["vlm_phrase+embedder"], {"n": 2, "top1": 1.0, "top5": 1.0})
        self.assertEqual(r["clip_image"]["top1"], 1.0)

    def test_scores_agreement_confusions_lines_centered_and_baseline(self):
        shots = [{"frame": "x", "w": 1920, "h": 1080, "reference": {"size": "wide"}},
                 {"frame": "x", "w": 1080, "h": 1920, "reference": {"size": "close"}},
                 {"frame": "x", "w": 1080, "h": 1080, "reference": {"size": "close; wide"}},
                 {"frame": "x", "w": 1920, "h": 1080, "reference": {"size": "unknown"}}]
        prob = self.file("p.json", {"meta": {"tag": "dec"}, "rows": [
            {"i": 0, "size|defined": ["wide"], "size|defined|conf": 0.9, "shape|defined": ["landscape"], "shape|defined|conf": 0.8},
            {"i": 1, "size|defined": ["wide"], "size|defined|conf": 0.6, "shape|defined": ["landscape"], "shape|defined|conf": 0.4},
            {"i": 2, "size|defined": ["wide"], "size|defined|conf": 0.95, "shape|defined": ["square"], "shape|defined|conf": 0.9},
            {"i": 3, "size|defined": ["close"], "size|defined|conf": 0.5, "shape|defined": ["landscape"], "shape|defined|conf": 0.9}]})
        sim = self.file("pred-sim.json", {"meta": {}, "rows": [
            {"i": i, "size|bare": [], "shape|bare": [], "size|bare|all": s, "shape|bare|all": [0.1, 0.2, 0.3]}
            for i, s in ((0, [0.9, 0.1]), (1, [0.8, 0.4]), (2, [0.7, 0.6]), (3, [0.5, 0.5]))]})
        vocab = {"size": {"wide": "w", "close": "c"}, "shape": {"tall": "t", "square": "s", "landscape": "l"}}
        r = self.ok("score_frame_labels.py", {"shots": shots, "vocabulary": vocab, "labels": [prob, sim], "reference_name": "labeller",
                                              "unknown": "unknown", "list_separator": ";", "shape_field": "shape",
                                              "shape_ratios": {"tall": 0.5625, "square": 1.0, "landscape": 1.7778}, "thresholds": [0.7, 0.9]},
                    isolated=True)
        size = r["dec|defined"]["fields"]["size"]
        self.assertEqual((size["n"], size["agree"]), (3, 0.667))
        self.assertEqual(size["top_confusions"], ["labeller close -> wide x1"])
        self.assertEqual(size["t0.7"], {"answered": 0.667, "agree_when_answered": 1.0})
        self.assertEqual(size["mean_conf"], 0.817)
        self.assertEqual(r["dec|defined"]["fields"]["shape"]["agree"], 0.75)
        self.assertEqual(r["pred-sim|bare-centered"]["fields"]["size"]["agree"], 0.667)
        self.assertEqual(r["majority-baseline"]["fields"]["size"], {"agree": 0.667, "value": "wide"})
        self.assertEqual(r["majority-baseline"]["fields"]["shape"]["value"], "landscape")


class Blanks(Case):
    def template(self):
        """A word template made by the Workshop's own template tool from a made-up transcript, with two blanks."""
        words = "Today we open our new lamp shop with 40 lamps and a kind note".split()
        transcript = {"words": [{"id": f"w{i}", "text": w, "start": i * 0.3, "end": i * 0.3 + 0.2, "type": "word", "speaker": "S0"}
                                for i, w in enumerate(words)], "language": "en"}
        spec = {"schema": "word-template-spec@1", "piece": {"id": "made-up", "medium": "video"},
                "sources": {"transcript_words": self.file("t.json", transcript)},
                "slots": [{"id": "thing", "type": "FEATURE", "note": "the new thing", "match": [{"dim": "speech.word", "phrase": "lamp shop"}]},
                          {"id": "count", "type": "NUMBER", "note": "how many", "match": [{"dim": "speech.word", "phrase": "40"}]}]}
        out = self.dir / "made.template.json"
        tool = HERE.parents[1] / "fill-a-template-without-changing-its-words" / "do-work" / "make_template.py"
        done = subprocess.run([sys.executable, str(tool), self.file("spec.json", spec), str(out), "--root", str(self.dir)], capture_output=True, text=True)
        self.assertEqual(done.returncode, 0, done.stderr)
        return str(out)

    def git(self, *args, date="2026-01-01T12:00:00"):
        env = dict(os.environ, GIT_AUTHOR_DATE=date, GIT_COMMITTER_DATE=date, GIT_AUTHOR_NAME="Sample", GIT_AUTHOR_EMAIL="sample@example.com",
                   GIT_COMMITTER_NAME="Sample", GIT_COMMITTER_EMAIL="sample@example.com")
        subprocess.run(["git", "-C", str(self.dir / "repo"), *args], check=True, capture_output=True, env=env)

    def pool(self):
        (self.dir / "repo").mkdir()
        self.git("init", "-q")
        self.git("commit", "-q", "--allow-empty", "-m", "Open the lamp shop", date="2026-01-01T12:00:00")
        self.git("commit", "-q", "--allow-empty", "-m", "Add three lamps", date="2026-01-15T12:00:00")
        listing = self.file("listings/lamps.json", {"title": "Lamp shop", "steps": ["Pick a lamp"], "job": "Sell lamps, then ship them. 40 lamps wait."})
        self.file("site/src/pages.json", '{\n "heading": "Lamps for every desk",\n "x": 1\n}\n')
        self.file("site/src/more.json", '[\n "Brightlamp makes the warmest lamps in town",\n "Brightlamp ships"\n]\n')
        return self.ok("make_candidate_pool.py", {
            "listing": listing, "listing_root": str(self.dir), "site": str(self.dir / "site" / "src"), "site_label": "site",
            "site_files": ["pages.json", "more.json"], "name": "Brightlamp", "name_files": ["more.json"],
            "repos": [str(self.dir / "repo")], "age_repos": [str(self.dir / "repo")], "as_of": "2026-01-29", "most_words": 14}, isolated=True)

    def test_pool_keeps_a_checkable_source_for_every_phrase(self):
        pool = {p["text"]: p for p in self.pool()["pool"]}
        self.assertEqual(pool["Lamp shop"]["source"], "listings/lamps.json:1")
        self.assertEqual(pool["Sell lamps"]["origin"], "listing")
        self.assertEqual(pool["Lamps for every desk"]["source"], "site:src/pages.json:2")
        self.assertEqual(pool["Open the lamp shop"]["origin"], "git")
        self.assertEqual(pool["2 commits since 2026-01-01"]["origin"], "git-fact")
        self.assertEqual(pool["40 lamps wait"]["origin"], "listing")
        self.assertEqual(pool["three lamps"]["origin"], "git-number")
        self.assertEqual(pool["Brightlamp"], {"text": "Brightlamp", "source": "site:src/more.json:2", "origin": "site-name"})
        self.assertEqual((pool["28 days"]["origin"], pool["4 weeks"]["origin"]), ("git-fact", "git-fact"))

    def test_blanks_ranked_typed_chosen_and_rendered_as_fills(self):
        template = self.template()
        blanks = self.ok("template_blanks.py", {"template": template}, isolated=True)
        self.assertEqual(set(blanks["slots"]), {"thing", "count"})
        self.assertIn("[thing]", next(iter(blanks["lines"].values()))["text"])
        pool = self.pool()
        ranked = self.ok("rank_pool_for_blanks.py", {"template": template, "pool": pool, "model": "some/reranker", "device": "cpu"})
        self.assertEqual(len(ranked["slots"]["thing"]["options"]), 12)
        self.assertEqual(ranked["meta"]["tag"], "reranker")
        typed = self.ok("make_typed_options.py", {"pool": pool, "ranked": ranked}, isolated=True)
        texts = [o["text"] for o in typed["slots"]["count"]["options"]]
        self.assertIn("three lamps", texts)
        self.assertIn("28 days", texts)
        self.assertEqual(typed, self.ok("make_typed_options.py", {"pool": pool, "ranked": ranked}, isolated=True))
        listing = str(self.dir / "listings" / "lamps.json")
        chose = self.ok("choose_fills_with_decider.py", {"options": typed, "listing": listing, "model": "someone/decider-small", "device": "cpu"})
        self.assertEqual(set(chose["choices"]), {"thing", "count"})
        self.assertIn("any_fits_yes", chose["choices"]["thing"])
        judged = self.ok("judge_filled_lines_with_decider.py", {"options": typed, "listing": listing, "product": "Brightlamp",
                                                                "model": "someone/decider-small", "device": "cpu"})
        self.assertEqual(len(judged["choices"]["count"]["ranked"]), 4)
        said = self.ok("choose_fills_with_language_model.py", {"options": typed, "listing": listing, "model": "some/lm", "max_tokens": 8})
        self.assertTrue(all("index" in c for c in said["choices"].values()))
        choice = self.file("choice.json", {"choices": {"thing": {"choice": "Lamp shop", "confidence": 0.9},
                                                       "count": {"choice": "three lamps", "confidence": 0.4}}})
        fills = self.ok("render_choices_as_fills.py", {"choice": choice, "options": typed, "tag": "made-up", "conf_key": "confidence",
                                                       "abstain": 0.7, "template": template, "root": str(self.dir), "title": "chosen by {tag}",
                                                       "out_dir": str(self.dir / "render")}, isolated=True)
        self.assertEqual(fills["fills"]["thing"], {"value": "Lamp shop", "sources": ["listings/lamps.json:1"], "note": "chosen by made-up"})
        self.assertIn("needs", fills["fills"]["count"])
        self.assertTrue(Path(fills["written"]["md"]).is_file())
        self.assertIsNotNone(fills["drift"])


class Ranks(Case):
    def slots(self):
        cands = [{"frame": self.file(f"c{k}.png", words), "text": words} for k, words in enumerate(["red lamp", "blue screen person", "wide"])]
        return [{"slot": 1, "desc": "a person at a blue screen", "cands": cands}]

    def test_every_method_ranks_and_agreement_counts_the_reference(self):
        models = {"siglip": "some/clip", "decider-vision": "someone/decider-small-vision", "decider-text": "someone/decider-small",
                  "bge-text": "some/reranker", "qwen3vl": "some/vlm"}
        for method, model in models.items():
            r = self.ok("rank_candidate_frames.py", {"slots": self.slots(), "method": method, "model": model, "device": "cpu",
                                                     "reference": {"1": ["c1", "c0", "c2"]}, "reference_name": "editor"})
            self.assertEqual(r["rank"]["1"][0], str(self.dir / "c1.png"), method)
            self.assertEqual(r["agreement"], {"top1": "1/1", "top1_in_editor_top3": "1/1"}, method)
        code, last = self.run_script("rank_candidate_frames.py", {"slots": self.slots(), "method": "nope", "model": "m", "device": "cpu"})
        self.assertEqual(code, 2)
        self.assertIn("is not siglip", last["error"])


class Decider(Case):
    def test_takes_are_labelled_by_construction_and_scored(self):
        folder = self.dir / "transcripts"
        folder.mkdir()
        for k in range(20):
            words = [{"text": w, "type": "word"} for w in f"This is sentence number {k} and it has enough words in it to count. Short one.".split()]
            (folder / f"t{k:02d}.json").write_text(json.dumps({"words": words}))
        r = self.ok("check_takes_with_decider.py", {"transcripts": str(folder), "model": "someone/decider-small", "device": "cpu"})
        kinds = [row["kind"] for row in r["rows"]]
        self.assertEqual(kinds, ["complete", "complete", "cut"])
        self.assertTrue(r["rows"][2]["take"].count(" ") < r["rows"][0]["take"].count(" "))
        self.assertEqual(r["meta"]["n"], 3)
        self.assertEqual(set(r["meta"]["abstain"]), {"0.7", "0.8", "0.9"})

    def test_titles_are_ranked_by_yes(self):
        titles = self.file("titles.json", {"a": "A plain title", "b": "Yes, a person on a red screen"})
        r = self.ok("rank_titles_with_decider.py", {"titles": titles, "question": "Would a viewer click this?",
                                                    "model": "someone/decider-small", "device": "cpu"})
        self.assertEqual([x["ref"] for x in r["ranked"]], ["b", "a"])

    def test_a_decider_is_timed(self):
        r = self.ok("time_a_decider.py", {"model": "someone/decider-small", "revision": "abc", "device": "cpu"})
        self.assertEqual((r["device"], len(r["ms"])), ("cpu", 4))
        code, last = self.run_script("time_a_decider.py", {"model": "someone/absent", "device": "cpu"})
        self.assertEqual(code, 2)
        self.assertIn("hf download someone/absent", last["error"])


class Settings(Case):
    """The person's own paths, models and words come from their list:settings row, read by the shared reader
    (tools/settings); the request's own fields win."""
    ROW = {"id": "record:setting:benchmark-small-local-models~person~sample-person", "type": "record:setting",
           "value": {"name": "small-model benchmarks", "tool": "tool:benchmark-small-local-models", "scope_kind": "person",
                     "scope_id": "sample-person", "status": "active", "from": "made-up@0000000",
                     "settings": json.dumps({"commands": {"rank_titles_with_decider": {
                         "question": "Would a viewer click this?", "model": "someone/decider-small", "device": "cpu"}}})}}

    def test_a_settings_record_gives_each_commands_defaults(self):
        titles = {"a": "A plain title", "b": "Yes, a red screen"}
        r = self.ok("rank_titles_with_decider.py", {"settings_record": self.ROW, "titles": titles})
        self.assertEqual(r["meta"]["question"], "Would a viewer click this?")
        path = self.file("rows.json", [self.ROW, {**self.ROW, "id": "record:setting:benchmark-small-local-models~film~sample-film",
                                                   "value": {**self.ROW["value"], "scope_kind": "film", "scope_id": "sample-film",
                                                             "settings": json.dumps({"commands": {"rank_titles_with_decider": {
                                                                 "question": "Film question?", "model": "someone/decider-small"}}})}}])
        r = self.ok("rank_titles_with_decider.py", {"settings_record": path, "scopes": [["film", "sample-film"], ["person", "sample-person"]],
                                                    "titles": titles, "device": "cpu"})
        self.assertEqual(r["meta"]["question"], "Film question?")
        r = self.ok("rank_titles_with_decider.py", {"settings_record": self.ROW, "titles": titles, "question": "Own words?"})
        self.assertEqual(r["meta"]["question"], "Own words?")

    def test_a_wrong_or_retired_row_and_a_missing_field_are_refused(self):
        retired = {**self.ROW, "value": {**self.ROW["value"], "status": "retired"}}
        code, last = self.run_script("rank_titles_with_decider.py", {"settings_record": retired, "titles": {}})
        self.assertEqual(code, 2)
        self.assertIn("retired", last["error"])
        code, last = self.run_script("rank_titles_with_decider.py", {"settings_record": self.ROW, "scopes": [["film", "other"]], "titles": {}})
        self.assertEqual(code, 2)
        self.assertIn("no settings row", last["error"])
        code, last = self.run_script("make_typed_options.py", {"pool": []}, isolated=True)
        self.assertEqual(code, 2)
        self.assertIn("`ranked`", last["error"])
        code, last = self.run_script("make_typed_options.py", "not an object", isolated=True)
        self.assertEqual(code, 2)


if __name__ == "__main__":
    unittest.main()
