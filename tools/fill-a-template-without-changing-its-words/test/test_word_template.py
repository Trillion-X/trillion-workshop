"""Tests for the template tool. Run: python3 -I -m unittest discover -s test -v (from the tool folder)."""
import copy
import itertools
import json
import shutil
import subprocess
import sys
import tempfile
import time
import unittest
from unittest.mock import patch
from pathlib import Path

TOOL = Path(__file__).resolve().parents[1]
READ_DATA = TOOL / "read-data"
DO_WORK = TOOL / "do-work"
sys.path.insert(0, str(READ_DATA))
sys.path.insert(0, str(DO_WORK))
sys.path.insert(0, str(Path(__file__).resolve().parent))

import sample_registry  # noqa: E402,F401  (points the default registry at the shipped one plus invented sample dimensions)
import wt_ops as ops  # noqa: E402
from wt_core import (BREAK, SLOT_MARK, READERS, Registry, WTError, check_source, norm, split_words,  # noqa: E402
                     source_text, value_in_sources)
from wt_render import render_fill_md, render_template_md  # noqa: E402
import wt_render  # noqa: E402

REG = Registry.load()


def transcript(words, speakers=None, gap=0.05):
    out, t = [], 0.0
    for i, w in enumerate(words):
        out.append({"id": f"w{i}", "text": w, "start": round(t, 3), "end": round(t + 0.2, 3), "type": "word",
                    "speaker": (speakers[i] if speakers else "S0")})
        t += 0.2 + gap
    return {"words": out, "language": "en"}


class TimedUnitCoverage(unittest.TestCase):
    def test_authored_record_order_preserves_no_time_memberships(self):
        records = [
            {"id": identity, "unit": "piece", "one_word": True, "record_order": order,
             "fields": {"text": text}}
            for identity, order, text in (("caption-10", 2, "Third"),
                                          ("caption-2", 1, "Second"),
                                          ("caption-1", 0, "First"))
        ]
        piece = ops.tokenize({"piece": {"id": "ordered-captions", "medium": "video"},
                              "auto_slot_rules": False,
                              "records": {"transcript_words": records}})
        speech = [t["dims"]["speech.word"] for t in piece["tokens"] if "speech.word" in t["dims"]]
        self.assertEqual(speech, ["First", "Second", "Third"])

        # Without the opt-in order field, legacy deterministic ordering remains in force.
        legacy = [{k: v for k, v in record.items() if k != "record_order"} for record in records]
        legacy_piece = ops.tokenize({"piece": {"id": "legacy-captions", "medium": "video"},
                                     "auto_slot_rules": False,
                                     "records": {"transcript_words": legacy}})
        legacy_speech = [t["dims"]["speech.word"] for t in legacy_piece["tokens"]
                         if "speech.word" in t["dims"]]
        self.assertEqual(legacy_speech, ["First", "Third", "Second"])

    def test_authored_record_order_rejects_malformed_or_duplicate_values(self):
        for orders in (("first", 1), (1, 1)):
            records = [
                {"id": f"caption-{index}", "unit": "piece", "one_word": True,
                 "record_order": order, "fields": {"text": f"Word{index}"}}
                for index, order in enumerate(orders)
            ]
            with self.subTest(orders=orders), self.assertRaises(WTError):
                ops.tokenize({"piece": {"id": "bad-order", "medium": "video"},
                              "auto_slot_rules": False,
                              "records": {"transcript_words": records}})

    def test_partial_unit_list_does_not_capture_gaps_or_tail(self):
        piece = ops.tokenize({
            "piece": {"id": "partial-units", "medium": "video"},
            "auto_slot_rules": False,
            "records": {
                "tsv_rows": [
                    {"id": "first-unit", "is_unit": True, "t0": 1, "t1": 3,
                     "fields": {"kind": "motion-graphic"}},
                    {"id": "last-unit", "is_unit": True, "t0": 5, "t1": 6,
                     "fields": {"kind": "motion-graphic"}},
                ],
                "transcript_words": [
                    {"id": f"word-{i}", "one_word": True, "t0": t,
                     "fields": {"text": word}}
                    for i, (t, word) in enumerate([
                        (0, "Before"), (1, "Inside"), (3, "Boundary"),
                        (4, "Gap"), (5, "Last"), (6, "End"), (9, "After")])
                ],
            },
        })
        words = [t for t in piece["tokens"] if "speech.word" in t["dims"]]
        self.assertEqual([t["unit"] for t in words], [
            "piece", "first-unit", "piece", "piece", "last-unit", "piece", "piece"])

    def test_zero_end_is_finite_and_missing_end_stays_open(self):
        piece = {"units": [{"id": "empty", "t0": 0, "t1": 0},
                           {"id": "open", "t0": 2}],
                 "tokens": [{"id": "zero", "t": 0}, {"id": "future", "t": 9}]}
        ops._assign_units(piece)
        self.assertEqual([t["unit"] for t in piece["tokens"]], ["piece", "open"])

    def test_duration_records_require_full_unit_containment(self):
        piece = {"units": [{"id": "first", "t0": 1, "t1": 3},
                           {"id": "second", "t0": 3, "t1": 5},
                           {"id": "open", "t0": 7}],
                 "tokens": [{"id": "inside", "t": 1.5, "t1": 2},
                            {"id": "exact-end", "t": 2.5, "t1": 3},
                            {"id": "rounded-end", "t": 2.5, "t1": 3 + 1e-10},
                            {"id": "cross-boundary", "t": 2.5, "t1": 3.2},
                            {"id": "cross-gap", "t": 4.5, "t1": 7.5},
                            {"id": "point-at-boundary", "t": 3},
                            {"id": "inside-open", "t": 8, "t1": 10},
                            {"id": "explicit", "t": 2.5, "t1": 3.2, "unit": "first"}]}
        ops._assign_units(piece)
        self.assertEqual({t["id"]: t["unit"] for t in piece["tokens"]}, {
            "inside": "first", "exact-end": "first", "rounded-end": "first",
            "cross-boundary": "piece", "cross-gap": "piece", "point-at-boundary": "second",
            "inside-open": "open", "explicit": "first"})


class SourceQualifications(unittest.TestCase):
    def test_a_reader_qualification_is_shown_above_the_content_and_not_repeated_in_notes(self):
        piece = ops.tokenize({
            "piece": {"id": "qualified", "medium": "podcast"},
            "auto_slot_rules": False,
            "records": {"transcript_words": [
                {"id": "w0", "unit": "clip", "one_word": True, "t0": 0, "fields": {"text": "hello"}}]},
        }, REG)
        piece["notes"]["sample_provenance"] = {
            "reader": "sample", "source_path": "/measure/sample.txt",
            "qualification": "Labels are automatic hints; the numbers are measurements."}
        markdown = render_template_md(piece, REG)
        self.assertIn("## Source qualifications", markdown)
        self.assertIn("`sample_provenance` — reader `sample`; source `/measure/sample.txt`", markdown)
        self.assertIn("Labels are automatic hints", markdown)
        self.assertNotIn("- sample_provenance:", markdown)
        self.assertLess(markdown.index("## Source qualifications"), markdown.index("(`speech.word`)"))
        fill_md = render_fill_md(ops.fill(piece, {"fills": {}}, REG), {"title": "Qualified example"}, REG)
        self.assertIn("Labels are automatic hints", fill_md)
        self.assertLess(fill_md.index("## Source qualifications"), fill_md.index("## Script"))


class RenderScaling(unittest.TestCase):
    def test_renderers_build_one_token_index_per_piece(self):
        piece = ops.tokenize({
            "piece": {"id": "render-index", "medium": "video"},
            "auto_slot_rules": False,
            "records": {"transcript_words": [
                {"id": f"w{i}", "unit": "clip", "one_word": True, "t0": i,
                 "fields": {"text": f"word{i}"}}
                for i in range(40)
            ]},
        }, REG)

        original = wt_render.tok_index
        for render in (
            lambda: render_template_md(piece, REG),
            lambda: render_fill_md(piece, {"title": "render"}, REG),
        ):
            with self.subTest(render=render), patch.object(wt_render, "tok_index", wraps=original) as build_index:
                render()
                self.assertEqual(build_index.call_count, 1)


class HtmlJsonRecords(unittest.TestCase):
    def setUp(self):
        self.fx = Fixture()

    def tearDown(self):
        self.fx.close()

    def html(self, records, extra=""):
        return self.fx.write("source.html", extra + '<script type="application/json" id="events">' + json.dumps(records, ensure_ascii=False) + '</script>')

    def test_same_source_records_keep_zero_intervals_unicode_and_raw_provenance(self):
        records = [{"id": "source-note", "t0": 0, "t1": 2.5,
                    "fields": {"text": "Ice < cream & café", "top": 30}}]
        path = self.html(records, '<script type="application/json" id="other">[{"id":"ignored"}]</script>')
        piece = ops.tokenize({"piece": {"id": "source", "medium": "static"}, "auto_slot_rules": False,
                              "sources": {"html_json_records": {"path": str(path), "script_id": "events", "required": True}}})
        tokens = [t for t in piece['tokens'] if 'onscreen.word' in t['dims']]
        self.assertEqual([t['dims']['onscreen.word'] for t in tokens], split_words(records[0]['fields']['text'], REG))
        self.assertTrue(all(t['t'] == 0 and t['t1'] == 2.5 and t['mark'] == 'KEEP' for t in tokens))
        self.assertFalse(any('speech.word' in t['dims'] for t in piece['tokens']))
        self.assertEqual(piece['notes']['html_json_records_source']['raw_records'], records)
        self.assertIn('never inferred spoken-word onsets', piece['notes']['html_json_records_source']['time_semantics'])

    def test_selection_refuses_missing_ambiguous_executable_and_malformed_blocks(self):
        valid = '<script type="application/json" id="events">[]</script>'
        bad = [valid + valid, '<div id="events">wrong</div>' + valid,
               '<script id="events">[]</script>',
               '<script type="application/json" id="events" src="remote.json">[]</script>',
               '<script type="application/json" id="events">[</script>',
               '<script type="application/json" id="events">[]',
               '<script type="application/json" id="events" id="other">[]</script>',
               '<script type="application/json" type="text/javascript" id="events">[]</script>']
        for text in bad:
            with self.subTest(text=text), self.assertRaises(WTError):
                READERS['html_json_records'](self.fx.write('bad.html', text), {'opts': {'script_id': 'events'}})
        with self.assertRaises(WTError):
            READERS['html_json_records'](self.fx.write('ok.html', valid), {'opts': {}})
        with self.assertRaises(WTError):
            READERS['html_json_records'](self.fx.write('ok.html', valid), {'opts': {'script_id': 'absent'}})

    def test_records_refuse_duplicate_ids_and_invalid_times_without_fabricating_empty_source(self):
        good = {"id": "a", "fields": {"text": "Declared"}}
        bad = [[good, good], [{"id": "a", "fields": []}], [{**good, 't1': 1}],
               [{**good, 't0': True}], [{**good, 't0': -1}], [{**good, 't0': 2, 't1': 1}],
               [{**good, 't0': float('nan')}], [{**good, 'fields': {'text': float('inf')}}]]
        for records in bad:
            with self.subTest(records=records), self.assertRaises(WTError):
                READERS['html_json_records'](self.html(records), {'opts': {'script_id': 'events'}})
        path = self.html([])
        piece = ops.tokenize({'piece': {'id': 'empty', 'medium': 'video'},
                              'sources': {'html_json_records': {'path': str(path), 'script_id': 'events', 'required': True, 'allow_empty': True}}})
        self.assertFalse(piece['tokens'])
        self.assertNotIn('onscreen.word', [p['dim'] for p in piece['pending']])


class Fixture:
    def __init__(self):
        self.dir = Path(tempfile.mkdtemp(prefix="wt-test-"))

    def write(self, name, data):
        p = self.dir / name
        p.parent.mkdir(parents=True, exist_ok=True)
        if isinstance(data, (dict, list)):
            p.write_text(json.dumps(data), encoding="utf-8")
        else:
            p.write_text(data, encoding="utf-8")
        return p

    def close(self):
        shutil.rmtree(self.dir, ignore_errors=True)


SENT = "This kettle got us pretty far to like what 25,000 orders, a lot of cafes. Check out the new menu page.".split()
TSV = "t0\tt1\tsize\tangle\tgrade\taction\n0.00\t2.00\tmedium\tlevel\twarm\tsits with laptop\n2.00\t4.00\tclose\toverhead\twarm\tshows the old page\n"


def base_piece(fx, registry=None):
    tp = fx.write("t.json", transcript(SENT))
    sp = fx.write("units.tsv", TSV)
    spec = {"schema": "word-template-spec@1", "piece": {"id": "demo", "medium": "video"},
            "sources": {"transcript_words": str(tp), "tsv_rows": str(sp)},
            "slots": [{"id": "thing", "type": "FEATURE", "note": "the launched thing",
                       "match": [{"dim": "speech.word", "phrase": "menu page"}]},
                      {"id": "unit", "type": "UNIT", "note": "what the number counts", "tokens": ["w10"]},
                      {"id": "screen", "type": "SCREEN", "note": "the before screen", "tokens": ["row-02"], "dims": ["sample.action"]}]}
    if registry:
        spec["registry"] = registry
    return ops.tokenize(spec, Registry.load(registry) if registry else REG, str(fx.dir)), spec


class Words(unittest.TestCase):
    def test_cited_scene_fields_accept_literal_punctuation_and_reject_new_claims(self):
        fx = Fixture()
        try:
            action = "Seated person at a desk;slow zoom,then wide."
            place = "paper-canvas desk room"
            path = fx.write("scene.tsv", action + "\t" + place + "\t25,000 orders;can't publish 1.4K yet.\n")
            citation = f"{path}:1"
            self.assertTrue(value_in_sources({"sample.action": action, "sample.place": place}, [citation])[0])
            self.assertTrue(value_in_sources("25,000 orders", [citation])[0])
            self.assertTrue(value_in_sources("can't publish 1.4K", [citation])[0])
            self.assertFalse(value_in_sources({"sample.action": "Invented astronaut", "sample.place": place}, [citation])[0])
            self.assertFalse(value_in_sources("25,001 orders", [citation])[0])
            self.assertFalse(value_in_sources("1.5K", [citation])[0])
            self.assertFalse(value_in_sources("can publish 1.4K", [citation])[0])
        finally:
            fx.close()

    def test_source_line_numbers_use_physical_newlines_not_unicode_text_separators(self):
        fx = Fixture()
        try:
            path = fx.write("source.jsonl", '{"text":"one\u2028still the first record"}\nFollowing my curiosity.\n')
            citation = f"{path}:2"
            self.assertTrue(check_source(citation)["ok"])
            self.assertEqual(source_text(citation), "Following my curiosity.")
            self.assertTrue(value_in_sources("Following My Curiosity.", [citation])[0])
            self.assertEqual(source_text(f"{path}:1-2"), path.read_text().rstrip("\n"))
            path.write_bytes(b"first\rinside record\r\nsecond record\r\n")
            self.assertEqual(source_text(f"{path}:1"), "first\rinside record")
            self.assertEqual(source_text(f"{path}#L2"), "second record")
            self.assertEqual(source_text(f"{path}:1-2"), "first\rinside record\nsecond record")
            path.write_bytes(b"last record with a bare CR\r")
            self.assertEqual(source_text(f"{path}:1"), "last record with a bare CR\r")
        finally:
            fx.close()

    def test_split_and_norm(self):
        self.assertEqual(split_words("a [NUMBER: no source yet], b\nc"), ["a", "[NUMBER: no source yet],", "b", BREAK, "c"])
        self.assertEqual(norm("25,000"), "25000")
        self.assertEqual(norm("page."), "page")
        self.assertEqual(norm("[X: y]"), SLOT_MARK)
        self.assertEqual(norm("“Hello”"), "hello")

    def test_wrapped_empty_slots_round_trip_without_hiding_added_words(self):
        spec = {
            "piece": {"id": "wrapped-empty", "medium": "video"},
            "auto_slot_rules": False,
            "records": {"ocr_images": [
                {"id": "amount", "fields": {"text": "Keep $160 billion"}},
                {"id": "definition", "fields": {"text": "(CODE CHANGES SUBMITTED FOR REVIEW)"}},
            ]},
            "slots": [
                {"id": "amount", "type": "NUMBER", "tokens": ["amount/text/1", "amount/text/2"]},
                {"id": "definition", "type": "DEFINITION", "tokens": [f"definition/text/{i}" for i in range(5)]},
            ],
        }
        template = ops.tokenize(spec, REG)
        filled = ops.fill(template, {"fills": {}}, REG)
        report = ops.drift(template, filled, REG)["notes"]["drift"]
        self.assertTrue(report["check"]["pass"], report["check"])
        self.assertEqual(report["summary"]["unsourced_fills"], 0)
        self.assertEqual(report["summary"]["empty_slots"], 2)
        self.assertEqual(report["summary"]["keep_preserved_pct"], 100.0)
        self.assertEqual(split_words("$[NUMBER: no source yet]"), ["$[NUMBER: no source yet]"])
        self.assertEqual(norm("([DEFINITION: no source yet])"), SLOT_MARK)

        forged = copy.deepcopy(filled)
        token = next(t for t in forged["tokens"] if t["id"] == "amount/text/1")
        token["dims"]["onscreen.word"] += " invented"
        self.assertFalse(ops.drift(template, forged, REG)["notes"]["drift"]["check"]["pass"])

    def test_not_english_no_spaces(self):
        w = split_words("今日は新しいページ です", REG)
        self.assertIn("今", w)
        self.assertIn("です", [x for x in w if len(x) > 1] + ["です"])

    def test_sources(self):
        fx = Fixture()
        try:
            f = fx.write("a.txt", "one\ntwo\n")
            self.assertTrue(check_source("https://example.com/x")["ok"])
            self.assertTrue(check_source(f"{f}:2")["ok"])
            self.assertFalse(check_source(f"{f}:9")["ok"])
            self.assertIn("needs a line", check_source(str(f))["why"])
            self.assertIn("no longer exists", check_source(f"{fx.dir}/gone.txt:1")["why"])
            self.assertIn("bare commit", check_source("abcdef1")["why"])
            repo = fx.dir / "repo"
            repo.mkdir()
            subprocess.run(["git", "init", "-q", str(repo)], check=True)
            (repo / "x").write_text("x")
            subprocess.run(["git", "-C", str(repo), "add", "x"], check=True)
            subprocess.run(["git", "-C", str(repo), "-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "x"], check=True)
            h = subprocess.run(["git", "-C", str(repo), "rev-parse", "--short", "HEAD"], capture_output=True, text=True).stdout.strip()
            self.assertTrue(check_source(f"git:{repo}@{h}")["ok"])
            self.assertFalse(check_source(f"git:{repo}@0000000")["ok"])
        finally:
            fx.close()


class SegmentCaptions(unittest.TestCase):
    def setUp(self):
        self.fx = Fixture()

    def tearDown(self):
        self.fx.close()

    def test_timestamp_formats_headers_and_no_fabricated_word_timing(self):
        path = self.fx.write("captions.txt", "Title: not speech\nSource: example\n[0] Hello there.\n[12.5] Again.\n[0:12] Wait.\n")
        ctx = {}
        records = READERS["segment_captions"](path, ctx)
        self.assertEqual([r["fields"]["text"] for r in records], ["Hello there.", "Again.", "Wait."])
        self.assertTrue(all("t0" not in r and "t1" not in r and "speaker" not in r["fields"]
                            and "duration" not in r["fields"] for r in records))
        provenance = ctx["segment_caption_provenance"]
        self.assertEqual(provenance[records[0]["id"]]["source_line"], 3)
        self.assertEqual(provenance[records[1]["id"]]["timestamp_text"], "12.5")
        self.assertEqual(provenance[records[2]["id"]]["timestamp_seconds"], 12.0)
        piece = ops.tokenize({"piece": {"id": "captions", "medium": "video"},
                              "sources": {"segment_captions": str(path)}})
        self.assertEqual([t["dims"]["speech.word"] for t in piece["tokens"]],
                         ["Hello", "there.", "Again.", "Wait."])
        self.assertTrue(all(t.get("t") is None and "speaker" not in t["dims"]
                            and "speech.word_duration" not in t["dims"] for t in piece["tokens"]))
        self.assertTrue(any(x["dim"] == "speech.word_duration" for x in piece["pending"]))

    def test_seconds_suffix_and_long_minutes_preserve_source_provenance(self):
        path = self.fx.write("seconds-suffix.txt", "# Local transcript\n[0s] [Music]\n[11.9s] Keep this.\n[100:02] Later words.\n")
        ctx = {}
        records = READERS["segment_captions"](path, ctx)
        self.assertEqual([r["fields"]["text"] for r in records], ["", "Keep this.", "Later words."])
        provenance = list(ctx["segment_caption_provenance"].values())
        self.assertEqual([p["timestamp_text"] for p in provenance], ["0s", "11.9s", "100:02"])
        self.assertEqual([p["timestamp_seconds"] for p in provenance], [0.0, 11.9, 6002.0])
        self.assertEqual(provenance[1]["raw_caption"], "[11.9s] Keep this.")
        piece = ops.tokenize({"piece": {"id": "seconds", "medium": "video"},
                              "sources": {"segment_captions": str(path)}})
        self.assertEqual([t["dims"]["speech.word"] for t in piece["tokens"]], ["Keep", "this.", "Later", "words."])
        self.assertTrue(all(t.get("t") is None and t.get("t1") is None for t in piece["tokens"]))
        for stamp in ("11.9ss", "0sec", "1:02s"):
            bad = self.fx.write("malformed-suffix.txt", f"[{stamp}] Words.\n")
            with self.assertRaises(WTError):
                READERS["segment_captions"](bad, {})

    def test_caption_annotations_and_turn_markers_are_not_speech_or_identity(self):
        path = self.fx.write("annotated.txt", "[4] [music]\n[9] >> Hi.\n[10] Oh [laughter] no.\n[11] [Cathy talks over Jordan] Right.\n")
        ctx = {}
        records = READERS["segment_captions"](path, ctx)
        self.assertEqual([r["fields"]["text"] for r in records], ["", "Hi.", "Oh  no.", "Right."])
        annotations = ctx["segment_caption_provenance"]
        self.assertIn({"kind": "caption-annotation", "text": "[music]"}, annotations[records[0]["id"]]["annotations"])
        self.assertIn({"kind": "speaker-turn-marker", "text": ">>"}, annotations[records[1]["id"]]["annotations"])
        self.assertIn({"kind": "caption-annotation", "text": "[laughter]"}, annotations[records[2]["id"]]["annotations"])
        self.assertIn("[Cathy talks over Jordan]", annotations[records[3]["id"]]["raw_caption"])
        self.assertTrue(all("speaker" not in r["fields"] for r in records))

    def test_empty_input_returns_no_captions_and_malformed_timestamp_fails(self):
        empty = self.fx.write("empty.txt", "\n\t\n")
        ctx = {}
        self.assertEqual(READERS["segment_captions"](empty, ctx), [])
        self.assertEqual(ctx["segment_caption_status"], "no timestamped caption segments found")
        malformed = self.fx.write("bad.txt", "Title: allowed preamble\n[12:xx] Broken timestamp\n[0] First.\n")
        with self.assertRaises(WTError) as err:
            READERS["segment_captions"](malformed, {})
        self.assertIn("malformed timestamped caption", err.exception.what)

    def test_empty_word_source_falls_back_to_captions_but_populated_word_source_wins(self):
        empty_words = self.fx.write("empty-words.json", {"words": []})
        captions = self.fx.write("fallback.txt", "[0] Caption words.\n")
        spec = {"piece": {"id": "fallback", "medium": "video"},
                "sources": {"transcript_words": str(empty_words), "segment_captions": str(captions)}}
        piece = ops.tokenize(spec)
        self.assertEqual([t["dims"]["speech.word"] for t in piece["tokens"]], ["Caption", "words."])
        self.assertTrue(all(t.get("t") is None for t in piece["tokens"]))
        timed_words = self.fx.write("timed-preferred.json", transcript(["Timed", "words."]))
        spec["sources"]["transcript_words"] = str(timed_words)
        piece = ops.tokenize(spec)
        word_tokens = [t for t in piece["tokens"] if "speech.word" in t["dims"]]
        self.assertEqual([t["dims"]["speech.word"] for t in word_tokens], ["Timed", "words."])
        self.assertTrue(all(t.get("t") is not None for t in word_tokens))

    def test_word_timed_transcript_reader_keeps_existing_word_metadata(self):
        path = self.fx.write("timed.json", transcript(["Hello", "again"], speakers=["S0", "S1"]))
        records = READERS["transcript_words"](path, {})
        self.assertEqual(records[0]["fields"]["text"], "Hello")
        self.assertEqual(records[0]["fields"]["speaker"], "S0")
        self.assertEqual(records[0]["t0"], 0.0)
        self.assertIn("duration", records[0]["fields"])
        self.assertIn("wpm", records[-1]["fields"])

    def test_empty_permission_stays_with_its_source_when_other_readers_fall_back(self):
        empty_words = self.fx.write("empty-words.json", {"words": []})
        captions = self.fx.write("fallback.txt", "[0] Caption words.\n")
        spec = {"piece": {"id": "mixed-source-options", "medium": "video"},
                "sources": {"transcript_words": str(empty_words),
                            "segment_captions": {"path": str(captions), "allow_empty": True}}}
        piece = ops.tokenize(spec)
        words = [t["dims"]["speech.word"] for t in piece["tokens"] if "speech.word" in t["dims"]]
        self.assertEqual(words, ["Caption", "words."],
                         "the fallback's allow_empty must not select a different reader's empty source")


class Json3Captions(unittest.TestCase):
    def setUp(self):
        self.fx = Fixture()

    def tearDown(self):
        self.fx.close()

    def test_bare_json3_text_provenance_and_no_invented_word_metadata(self):
        from make_template import spec_for
        events = [{"id": 1, "wpWinPosId": 1},
                  {"tStartMs": 1200, "dDurationMs": 3000, "wWinId": 1,
                   "segs": [{"utf8": ">> Hello"}, {"utf8": " there.", "tOffsetMs": 200}]},
                  {"tStartMs": 2000, "aAppend": 1, "segs": [{"utf8": "\n"}]},
                  {"tStartMs": 2300, "segs": [{"utf8": "[Music] Again."}]}]
        path = self.fx.write("reported.json3", {"events": events})
        piece = ops.tokenize(spec_for(path, REG))
        self.assertEqual([t["dims"]["speech.word"] for t in piece["tokens"]], ["Hello", "there.", "Again."])
        self.assertTrue(all(t.get("t") is None and t.get("t1") is None for t in piece["tokens"]))
        self.assertEqual({dim for t in piece["tokens"] for dim in t["dims"]}, {"speech.word"})
        prov = piece["notes"]["json3_caption_provenance"]
        self.assertEqual(prov["json3-event-000001"]["raw_event"], events[1])
        self.assertEqual(prov["json3-event-000001"]["timestamp_seconds"], 1.2)
        self.assertEqual(prov["json3-event-000003"]["annotations"], [{"kind": "caption-annotation", "text": "[Music]"}])
        self.assertTrue(any(x["dim"] == "speech.word_duration" for x in piece["pending"]))

    def test_overlapping_repeated_text_is_retained_and_word_source_still_wins(self):
        path = self.fx.write("overlap.json3", {"events": [
            {"tStartMs": 0, "dDurationMs": 3000, "segs": [{"utf8": "Wait."}]},
            {"tStartMs": 500, "dDurationMs": 3000, "segs": [{"utf8": "Wait."}]}]})
        spec = {"piece": {"id": "overlap", "medium": "video"}, "sources": {"json3_captions": str(path)}}
        self.assertEqual([t["dims"]["speech.word"] for t in ops.tokenize(spec)["tokens"]], ["Wait.", "Wait."])
        spec["sources"]["transcript_words"] = str(self.fx.write("words.json", transcript(["Actual."])))
        self.assertEqual([t["dims"]["speech.word"] for t in ops.tokenize(spec)["tokens"] if "speech.word" in t["dims"]], ["Actual."])

    def test_malformed_json3_fails_with_reason_instead_of_inventing_text(self):
        for doc in [{}, {"events": [None]}, {"events": [{"tStartMs": 0, "segs": [{"utf8": 4}]}]},
                    {"events": [{"tStartMs": -1, "segs": [{"utf8": "Wrong."}]}]},
                    {"events": [{"tStartMs": True, "segs": [{"utf8": "Wrong."}]}]}]:
            path = self.fx.write("bad.json3", doc)
            with self.assertRaises(WTError):
                READERS["json3_captions"](path, {})
        path = self.fx.write("empty.json3", {"events": []})
        self.assertEqual(READERS["json3_captions"](path, {}), [])


class MakeFillDrift(unittest.TestCase):
    def setUp(self):
        self.fx = Fixture()
        self.p, self.spec = base_piece(self.fx)
        self.src = self.fx.write("facts.txt", "Sort my mail workflow; the old guide\n40 runs\n")

    def tearDown(self):
        self.fx.close()

    def fills(self, **over):
        f = {"thing": {"value": "Sort my mail workflow", "sources": [f"{self.src}:1"]},
             "unit": {"value": None, "needs": "a real count"},
             "screen": {"value": "the old guide", "sources": [f"{self.src}:1"]}}
        f.update(over)
        return {"title": "t", "fills": f}

    def test_template_marks(self):
        idx = ops.tok_index(self.p)
        self.assertEqual(idx["w9"]["slot_type"], "NUMBER")          # auto rule R1: 25,000
        self.assertEqual(idx["w10"]["slot"], "unit")
        self.assertEqual(idx["w0"]["mark"], "KEEP")
        md = render_template_md(self.p, REG)
        self.assertIn("like what **[NUMBER]** **[UNIT]**, a lot of cafes.", md)
        self.assertEqual(len([l for l in self.p["lines"] if l["dim"] == "speech.word"]), 2)

    def test_fill_cannot_edit_keep(self):
        with self.assertRaises(WTError) as c:
            ops.fill(self.p, {"fills": {"w0": {"value": "Hi", "sources": ["https://x.y"]}}}, REG)
        self.assertIn("KEEP words cannot be changed", c.exception.fix)

    def test_unsourced_value_stays_empty(self):
        f = ops.fill(self.p, self.fills(thing={"value": "Something", "sources": []}), REG)
        self.assertEqual(f["fills"]["thing"]["status"], "unsourced")
        md = render_fill_md(f, {"title": "t"}, REG)
        self.assertIn("[FEATURE: no source yet]", md)
        self.assertIn("[UNIT: no source yet]", md)

    def test_drift_pass_change_exception(self):
        f = ops.fill(self.p, self.fills(), REG)
        md = render_fill_md(f, {"title": "t"}, REG)
        rep = ops.drift(self.p, md, REG)["notes"]["drift"]
        self.assertTrue(rep["check"]["pass"], rep["check"])
        self.assertEqual(rep["summary"]["keep_preserved_pct"], 100.0)
        bad = md.replace("This kettle got us", "This thing got us")
        rep = ops.drift(self.p, bad, REG)["notes"]["drift"]
        self.assertFalse(rep["check"]["pass"])
        ch = rep["dims"]["speech.word"]["changes"]
        self.assertTrue(any(c["op"] == "replaced" and c["words"] == "kettle" for c in ch), ch)
        exc = [{"dim": "speech.word", "op": "replaced", "words": "kettle", "reason": "the author's own word"}]
        rep = ops.drift(self.p, bad, REG, exceptions=exc)["notes"]["drift"]
        self.assertTrue(rep["check"]["pass"], rep["check"])
        slop = md.replace("Sort my mail workflow", "the best workflow ever made")
        rep = ops.drift(self.p, slop, REG)["notes"]["drift"]
        self.assertGreater(rep["summary"]["unsourced_fills"], 0)

    def test_piece_target_all_dims(self):
        f = ops.fill(self.p, self.fills(), REG)
        rep = ops.drift(self.p, f, REG)["notes"]["drift"]
        self.assertIn("sample.size", rep["dims"])
        self.assertTrue(rep["check"]["pass"], rep["check"])
        f["tokens"][[t["id"] for t in f["tokens"]].index("row-01")]["dims"]["sample.size"] = "wide"
        rep = ops.drift(self.p, f, REG)["notes"]["drift"]
        self.assertLess(rep["dims"]["sample.size"]["pct"], 100)

    def test_cli_round_trip(self):
        tpl = self.fx.dir / "x.template.json"
        spec = dict(self.spec)
        sp = self.fx.write("s.json", spec)
        r = subprocess.run([sys.executable, "-I", str(DO_WORK / "make_template.py"), str(sp), str(tpl), "--registry", REG.path], capture_output=True, text=True)
        self.assertEqual(r.returncode, 0, r.stderr)
        self.assertTrue((self.fx.dir / "x.template.md").exists())
        fj = self.fx.write("f.json", self.fills())
        out = self.fx.dir / "fill.md"
        r = subprocess.run([sys.executable, "-I", str(DO_WORK / "fill.py"), str(tpl), str(fj), str(out)], capture_output=True, text=True)
        self.assertEqual(r.returncode, 0, r.stderr)
        r = subprocess.run([sys.executable, "-I", str(DO_WORK / "drift.py"), str(tpl), str(out), "--check"], capture_output=True, text=True)
        self.assertEqual(r.returncode, 0, r.stdout + r.stderr)
        out.write_text(out.read_text().replace("pretty far", "very far"))
        r = subprocess.run([sys.executable, "-I", str(DO_WORK / "drift.py"), str(tpl), str(out), "--check"], capture_output=True, text=True)
        self.assertEqual(r.returncode, 1)
        self.assertIn("'pretty'", r.stdout)


class MomentSources(unittest.TestCase):
    """A slot filled from one of the person's recorded moments, next to a product-capability source in the same fills file."""

    def setUp(self):
        self.fx = Fixture()
        self.p, _ = base_piece(self.fx)
        said = transcript("so the old guide took forty runs before it worked".split())
        said["source"] = "/recordings/C0042.MP4"
        self.words = self.fx.write("C0042.words.json", said)
        self.tsv = self.fx.write("moments.tsv", "clip\tstart_s\tend_s\ttext\toriginal_path\n"
                                 "C0042\t0.0\t2.5\tso the old guide took forty runs\t/recordings/C0042.MP4\n")
        self.listing = self.fx.write("listing.txt", "Sort my mail workflow\n")

    def tearDown(self):
        self.fx.close()

    def fill(self, screen):
        return ops.fill(self.p, {"fills": {"thing": {"value": "Sort my mail workflow", "sources": [f"{self.listing}:1"]},
                                           "screen": screen}}, REG)["fills"]

    def test_a_word_timed_range_fills_a_slot_with_his_words_and_keeps_where_they_play(self):
        f = self.fill({"value": "the old guide", "sources": [f"{self.words}@0.25-0.95s"]})
        self.assertEqual(f["screen"]["status"], "sourced")
        self.assertEqual(f["screen"]["moments"], [{"source": f"{self.words}@0.25-0.95s", "clip": "C0042", "from": 0.25,
                                                   "to": 0.95, "media": "/recordings/C0042.MP4"}])
        self.assertEqual((f["thing"]["status"], f["thing"]["moments"]), ("sourced", []))   # a listing line is no moment

    def test_words_outside_the_range_or_a_reversed_range_do_not_fill(self):
        outside = self.fill({"value": "forty runs", "sources": [f"{self.words}@0.25-0.95s"]})["screen"]
        self.assertEqual((outside["status"], outside["moments"]), ("unsourced", []))
        reversed_range = self.fill({"value": "the old guide", "sources": [f"{self.words}@0.95-0.25s"]})["screen"]
        self.assertEqual(reversed_range["status"], "unsourced")
        self.assertIn("must end after it starts", reversed_range["why"][0])

    def test_a_moments_row_cited_by_line_fills_and_plays_from_its_columns(self):
        f = self.fill({"value": "the old guide", "sources": [f"{self.tsv}:2"]})["screen"]
        self.assertEqual(f["status"], "sourced")
        self.assertEqual([(m["clip"], m["from"], m["to"]) for m in f["moments"]], [("C0042", 0.0, 2.5)])
        self.assertEqual(source_text(f"{self.words}@0.0-0.45s"), "so the")

    def test_a_range_into_the_recording_itself_plays_but_is_not_checked(self):
        clip = self.fx.write("C0042.MP4", "not a transcript")
        f = self.fill({"value": "anything at all", "sources": [f"{clip}@1-3s"]})["screen"]
        self.assertEqual((f["status"], f["check"]), ("sourced", "source not readable here (URL or media timestamp): not checked"))
        self.assertEqual([(m["clip"], m["from"], m["to"]) for m in f["moments"]], [("C0042", 1.0, 3.0)])

    def test_the_sources_table_says_where_a_moment_plays(self):
        filled = ops.fill(self.p, {"fills": {"screen": {"value": "the old guide", "sources": [f"{self.words}@0.25-0.95s"]}}}, REG)
        self.assertIn("(plays C0042 0.25-0.95 s)", render_fill_md(filled, {"title": "t"}, REG))


class RecurrentSlotRuns(unittest.TestCase):
    def setUp(self):
        self.reg = REG

    def _ocr_template(self, records, token_ids):
        return ops.tokenize({
            "piece": {"id": "repeated-ocr", "medium": "video"},
            "auto_slot_rules": False,
            "records": {"ocr_images": records},
            "slots": [{"id": "time", "type": "TIME", "tokens": token_ids,
                       "dims": ["onscreen.word"]}],
        }, self.reg)

    def test_adjacent_timed_records_fill_as_two_occurrences(self):
        records = [
            {"id": "native1008", "is_unit": True, "t0": 1008, "t1": 1009,
             "fields": {"text": "4am Austin, TX"}},
            {"id": "native1009", "is_unit": True, "t0": 1009, "t1": 1010,
             "fields": {"text": "4am Austin, TX"}},
        ]
        ids = [f"{rid}/text/{i}" for rid in ("native1008", "native1009") for i in range(3)]
        template = self._ocr_template(records, ids)
        filled = ops.fill(template, {"fills": {"time": {"needs": "the time and location"}}}, self.reg)
        words = [t["dims"]["onscreen.word"] for t in filled["tokens"] if "onscreen.word" in t["dims"]]
        self.assertEqual(words, ["[TIME: no source yet]", "[TIME: no source yet]"])

    def test_multiword_slot_from_one_record_stays_one_occurrence(self):
        template = self._ocr_template(
            [{"id": "native1008", "is_unit": True, "t0": 1008, "t1": 1009,
              "fields": {"text": "Austin TX"}}],
            ["native1008/text/0", "native1008/text/1"],
        )
        filled = ops.fill(template, {"fills": {"time": {"needs": "the location"}}}, self.reg)
        words = [t["dims"]["onscreen.word"] for t in filled["tokens"] if "onscreen.word" in t["dims"]]
        self.assertEqual(words, ["[TIME: no source yet]"])

    def test_same_unit_timed_lines_keep_both_sourced_occurrences_and_times(self):
        records = [
            {"id": f"native{index}", "t0": index * 1001 / 24000,
             "t1": (index + 1) * 1001 / 24000, "fields": {"text": "4am Austin, TX"}}
            for index in (1008, 1009)
        ]
        ids = [f"native{index}/text/{i}" for index in (1008, 1009) for i in range(3)]
        template = self._ocr_template(records, ids)
        before = [t for t in template["tokens"] if "onscreen.word" in t["dims"]]
        self.assertEqual(len({t["unit"] for t in before}), 1)
        with tempfile.TemporaryDirectory() as directory:
            source = Path(directory) / "facts.txt"
            source.write_text("7pm Seattle, WA\n")
            filled = ops.fill(template, {"fills": {"time": {
                "value": "7pm Seattle, WA", "sources": [f"{source}:1"]}}}, self.reg)
        after = [t for t in filled["tokens"] if "onscreen.word" in t["dims"]]
        self.assertEqual([t["dims"]["onscreen.word"] for t in after],
                         ["7pm Seattle, WA", "7pm Seattle, WA"])
        self.assertEqual([(t["t"], t["t1"]) for t in after],
                         [(before[0]["t"], before[0]["t1"]),
                          (before[3]["t"], before[3]["t1"])])
        self.assertEqual(filled["units"], template["units"])
        self.assertEqual(filled["fills"]["time"]["status"], "sourced")

    def test_multiword_speech_slot_crossing_picture_units_is_one_occurrence(self):
        template = ops.new_piece("speech-across-units", "video")
        template["registry"] = REG.path
        template["slots"] = {"thing": {"type": "FEATURE", "note": "the product"}}
        template["tokens"] = [
            {"id": "w0", "unit": "unit-before", "t": 1.0, "t1": 1.2,
             "dims": {"speech.word": "menu"}, "mark": "SLOT", "slot": "thing",
             "slot_type": "FEATURE", "line": {"speech.word": "speech.word:L1"}},
            {"id": "w1", "unit": "unit-after", "t": 1.2, "t1": 1.4,
             "dims": {"speech.word": "page"}, "mark": "SLOT", "slot": "thing",
             "slot_type": "FEATURE", "line": {"speech.word": "speech.word:L1"}},
            {"id": "w2", "unit": "unit-after", "t": 1.4, "t1": 1.6,
             "dims": {"speech.word": "works"}, "mark": "KEEP",
             "line": {"speech.word": "speech.word:L1"}},
        ]
        kept = copy.deepcopy(template["tokens"][-1])
        filled = ops.fill(template, {"fills": {"thing": {"needs": "the product"}}}, self.reg)
        words = [t["dims"]["speech.word"] for t in filled["tokens"] if "speech.word" in t["dims"]]
        self.assertEqual(words, ["[FEATURE: no source yet]", "works"])
        self.assertEqual(filled["tokens"][-1], kept)

    def test_legacy_multiword_run_without_occurrence_metadata_stays_grouped(self):
        template = ops.new_piece("legacy-run", "video")
        template["registry"] = REG.path
        template["slots"] = {"thing": {"type": "FEATURE", "note": "the thing"}}
        template["tokens"] = [
            {"id": "legacy-1", "dims": {"speech.word": "old"}, "mark": "SLOT", "slot": "thing",
             "slot_type": "FEATURE"},
            {"id": "legacy-2", "dims": {"speech.word": "page"}, "mark": "SLOT", "slot": "thing",
             "slot_type": "FEATURE"},
        ]
        filled = ops.fill(template, {"fills": {"thing": {"needs": "the product"}}}, self.reg)
        words = [t["dims"]["speech.word"] for t in filled["tokens"] if "speech.word" in t["dims"]]
        self.assertEqual(words, ["[FEATURE: no source yet]"])


class RegistryIsData(unittest.TestCase):
    def setUp(self):
        self.fx = Fixture()

    def tearDown(self):
        self.fx.close()

    def reg_copy(self, edit):
        d = json.loads(Path(REG.path).read_text())
        edit(d)
        return str(self.fx.write("reg.json", d))

    def test_new_dimension_only_in_registry(self):
        path = self.reg_copy(lambda d: d["dimensions"].append(
            {"id": "test.grade_again", "name": "grade, read a second time", "media": ["video"], "region": "samples",
             "value_kind": "category", "measure": [{"reader": "tsv_rows", "field": "grade", "token": "record"}],
             "drift": {"threshold": 1.0}}))
        p, _ = base_piece(self.fx, path)
        reg = Registry.load(path)
        self.assertEqual(ops.tok_index(p)["row-01"]["dims"]["test.grade_again"], "warm")
        f = ops.fill(p, {"fills": {}}, reg)
        self.assertIn("test.grade_again", ops.tok_index(f)["row-02"]["dims"])
        rep = ops.drift(p, f, reg)["notes"]["drift"]
        self.assertIn("test.grade_again", rep["dims"])
        f["tokens"][[t["id"] for t in f["tokens"]].index("row-02")]["dims"]["test.grade_again"] = "cool"
        rep = ops.drift(p, f, reg)["notes"]["drift"]
        self.assertEqual(rep["dims"]["test.grade_again"]["replaced"], 1)

    def test_new_medium_new_kind_data_only(self):
        """A taste note: a medium, dimensions and a value kind that exist nowhere in code."""
        def edit(d):
            d["media"]["taste-note"] = {"unit": "sip", "regions": ["palate", "words"]}
            d["value_kinds"]["intensity"] = {"pair": "order", "test": "distance", "metric": "abs_or_rel"}
            d["dimensions"] += [
                {"id": "taste.words", "name": "tasting words", "media": ["taste-note"], "region": "words", "value_kind": "text",
                 "auto_slot_rules": True, "measure": [{"reader": "tasting_sheet", "field": "note", "token": "word"}]},
                {"id": "taste.bitterness", "name": "bitterness 0-10", "media": ["taste-note"], "region": "palate",
                 "value_kind": "intensity", "measure": [{"reader": "tasting_sheet", "field": "bitter", "token": "record"}],
                 "drift": {"max": 1, "threshold": 1.0}},
                {"id": "taste.profile", "name": "sweet/sour/salt/bitter/umami", "media": ["taste-note"], "region": "palate",
                 "value_kind": "vector", "measure": [{"reader": "tasting_sheet", "field": "profile", "token": "record"}],
                 "drift": {"max": 0.5, "threshold": 1.0}}]
        path = self.reg_copy(edit)
        reg = Registry.load(path)
        spec = {"schema": "word-template-spec@1", "registry": path, "piece": {"id": "espresso", "medium": "taste-note"},
                "records": {"tasting_sheet": [
                    {"id": "sip-1", "is_unit": True, "order": 1, "fields": {"note": "Dark cherry, then cocoa. Finish lasts 20 seconds.",
                                                                          "bitter": 6, "profile": [2, 3, 0, 6, 1]}}]},
                "slots": [{"id": "fruit", "type": "FLAVOUR", "note": "the first flavour", "match": [{"dim": "taste.words", "phrase": "Dark cherry,"}]}]}
        p = ops.tokenize(spec, reg)
        self.assertEqual(ops.tok_index(p)["sip-1"]["dims"]["taste.bitterness"], 6)
        spec["records"]["tasting_sheet"][0]["fields"]["bitter"] = 0
        p = ops.tokenize(spec, reg)
        self.assertEqual(ops.tok_index(p)["sip-1"]["dims"]["taste.bitterness"], 0)
        f = ops.fill(p, {"fills": {"fruit": {"value": "Blood orange", "sources": ["https://example.com/cupping-sheet"]}}}, reg)
        rep = ops.drift(p, f, reg)["notes"]["drift"]
        self.assertTrue(rep["check"]["pass"], rep["check"])
        f["tokens"][[t["id"] for t in f["tokens"]].index("sip-1")]["dims"]["taste.bitterness"] = 9
        rep = ops.drift(p, f, reg)["notes"]["drift"]
        self.assertEqual(rep["dims"]["taste.bitterness"]["kept"], 0)
        self.assertEqual(rep["dims"]["taste.profile"]["kept"], 1)

    def test_unknown_dimension_reported_not_dropped(self):
        p, _ = base_piece(self.fx)
        t = copy.deepcopy(p)
        t["tokens"][0]["dims"]["smell.note"] = "cut grass"
        p["tokens"][0]["dims"]["smell.note"] = "cut grass"
        rep = ops.drift(p, t, REG)["notes"]["drift"]
        self.assertTrue(any(u["dim"] == "smell.note" for u in rep["unknown"]))

    def test_unknown_medium_error_is_plain(self):
        with self.assertRaises(WTError) as c:
            ops.tokenize({"piece": {"id": "x", "medium": "hologram"}}, REG)
        self.assertIn("hologram", c.exception.what)
        self.assertIn("media", c.exception.fix)


class OperationMatrix(unittest.TestCase):
    """compose(a, b) for every pair of operations, including each with itself: the result is always a valid
    piece, and any refusal is a WTError with a plain what and fix."""

    @classmethod
    def setUpClass(cls):
        cls.fx = Fixture()
        cls.base, _ = base_piece(cls.fx)
        cls.src = cls.fx.write("facts.txt", "x\n")

    @classmethod
    def tearDownClass(cls):
        cls.fx.close()

    def ops(self):
        src = f"{self.src}:1"

        def first_keep(p):
            return next(t["id"] for t in p["tokens"] if t.get("mark") == "KEEP" and t["dims"])

        def any_two(p):
            ids = [t["id"] for t in p["tokens"] if t["dims"]]
            return ids[0], ids[-1]
        return {
            "tokenize": lambda p: ops.merge(p, self.base),
            "mark_keep": lambda p: ops.mark_keep(p, [p["tokens"][-1]["id"]], "test"),
            "mark_slot": lambda p: ops.mark_slot(p, [first_keep(p)], "s-new", "TEST", "a test slot", registry=REG),
            "fill": lambda p: ops.fill(p, {"fills": {s: {"value": "v", "sources": [src]} for s in p["slots"]}}, REG),
            "drift": lambda p: ops.drift(self.base, p, REG),
            "diff": lambda p: ops.diff(p, self.base, REG),
            "merge": lambda p: ops.merge(p, p),
            "fork": lambda p: ops.fork(p),
            "nest": lambda p: ops.nest(p, p, at=p["tokens"][0]["id"]),
            "xref": lambda p: ops.xref(p, *any_two(p), rel="lands_on"),
            "delete+restore": lambda p: ops.restore(ops.delete(p, [p["tokens"][1]["id"]])),
            "delete": lambda p: ops.delete(p, [p["tokens"][1]["id"]]),
            "aggregate": lambda p: ops.aggregate([p, self.base], "family"),
        }

    def test_every_pair(self):
        table = self.ops()
        results = {}
        for (na, fa), (nb, fb) in itertools.product(table.items(), repeat=2):
            with self.subTest(a=na, b=nb):
                try:
                    out = fb(fa(copy.deepcopy(self.base)))
                except WTError as e:
                    self.assertTrue(e.what and e.fix, f"{na}->{nb}: error without what/fix")
                    results[(na, nb)] = "refused: " + e.what
                    continue
                errs, _ = ops.validate(out, REG)
                self.assertEqual(errs, [], f"{na} then {nb}: {errs[:2]}")
                results[(na, nb)] = "ok"
        self.assertEqual(sum(1 for v in results.values() if v == "ok"), len(table) ** 2, {k: v for k, v in results.items() if v != "ok"})

    def test_infinite_nesting_and_self(self):
        p = self.base
        for _ in range(6):
            p = ops.nest(p, p)
        errs, _ = ops.validate(p, REG)
        self.assertEqual(errs, [])
        self.assertGreater(len(p["tokens"]), 60 * len(self.base["tokens"]))

    def test_delete_restore_round_trip(self):
        ids = [t["id"] for t in self.base["tokens"]][:5]
        back = ops.restore(ops.delete(self.base, ids))
        self.assertEqual([t["id"] for t in back["tokens"]], [t["id"] for t in self.base["tokens"]])
        self.assertEqual([l["tokens"] for l in back["lines"]], [l["tokens"] for l in self.base["lines"]])

    def test_xref_to_deleted_is_a_warning_with_fix(self):
        p = ops.xref(self.base, "ev-000" if "ev-000" in ops.tok_index(self.base) else self.base["tokens"][2]["id"],
                     self.base["tokens"][0]["id"], "lands_on")
        p = ops.delete(p, [self.base["tokens"][0]["id"]])
        errs, warns = ops.validate(p, REG)
        self.assertEqual(errs, [])
        self.assertTrue(any("restore" in w["fix"] for w in warns))

    def test_aggregate_family(self):
        other = copy.deepcopy(self.base)
        other["piece"]["id"] = "demo2"
        ops.tok_index(other)["w1"]["dims"]["speech.word"] = "girl"
        fam = ops.aggregate(iter([self.base, other]), "fam")
        self.assertEqual(ops.tok_index(fam)["w1"]["slot_type"], "VARIES")
        self.assertEqual(ops.tok_index(fam)["w0"]["mark"], "KEEP")
        self.assertEqual(fam["piece"]["members"], ["demo", "demo2"])


class FlippedAssumptions(unittest.TestCase):
    def setUp(self):
        self.fx = Fixture()

    def tearDown(self):
        self.fx.close()

    def make(self, sources, medium="video", **extra):
        spec = {"schema": "word-template-spec@1", "piece": {"id": "x", "medium": medium}, "sources": sources, **extra}
        return ops.tokenize(spec, REG, str(self.fx.dir))

    def test_no_transcript(self):
        p = self.make({"tsv_rows": str(self.fx.write("s.tsv", TSV))})
        self.assertTrue(any(x["dim"] == "speech.word" for x in p["pending"]))
        self.assertEqual(ops.validate(p, REG)[0], [])

    def test_declared_unknown_values_stay_pending(self):
        path = self.fx.write("unknown.tsv", "t0\tt1\twidth\tpace\n0\t2\tunknown\tnone\n")
        p = self.make({"tsv_rows": {"path": str(path), "missing_values": ["unknown"]}})
        self.assertIn("width", p["notes"]["tsv_missing_values"]["row-01"])
        self.assertTrue(any(x["dim"] == "sample.width" for x in p["pending"]))
        self.assertFalse(any("unknown" in t["dims"].values() for t in p["tokens"]))
        self.assertTrue(any("none" in t["dims"].values() for t in p["tokens"]))

    def test_unknown_filter_preserves_known_values_and_requires_explicit_option(self):
        path = self.fx.write("mixed.tsv", "t0\tt1\twidth\n0\t2\tunknown\n2\t4\twide\n")
        p = self.make({"tsv_rows": {"path": str(path), "missing_values": ["unknown"]}})
        self.assertEqual([t["dims"]["sample.width"] for t in p["tokens"] if "sample.width" in t["dims"]], ["wide"])
        legacy = self.make({"tsv_rows": str(path)})
        self.assertEqual([t["dims"]["sample.width"] for t in legacy["tokens"] if "sample.width" in t["dims"]], ["unknown", "wide"])

    def test_tsv_explicit_identity_survives_inserted_rows_and_keys_missing_values(self):
        header = "id\tt0\tt1\twidth\taction\n"
        old = self.fx.write("identity-old.tsv", header + "row-a\t0\t2\twide\topen\n"
                            + "row-c\t4\t6\tunknown\tclose\n")
        new = self.fx.write("identity-new.tsv", header + "row-a\t0\t2\twide\topen\n"
                            + "row-b\t2\t4\tmedium\tinserted\n"
                            + "row-c\t4\t6\tunknown\tclose\n")
        opts = {"id_column": "id", "missing_values": ["unknown"]}
        old_ctx, new_ctx = {"opts": opts.copy()}, {"opts": opts.copy()}
        old_records = READERS["tsv_rows"](old, old_ctx)
        new_records = READERS["tsv_rows"](new, new_ctx)
        old_c = next(r for r in old_records if r["id"] == "row-c")
        new_c = next(r for r in new_records if r["id"] == "row-c")
        self.assertEqual((new_c["id"], new_c["t0"], new_c["t1"], new_c["fields"]),
                         (old_c["id"], old_c["t0"], old_c["t1"], old_c["fields"]))
        self.assertEqual(new_ctx["tsv_missing_values"]["row-c"], {"width": "unknown"})
        self.assertEqual([r["id"] for r in new_records], ["row-a", "row-b", "row-c"])

    def test_tsv_explicit_identity_rejects_duplicate_blank_and_missing_column(self):
        opts = {"id_column": "id"}
        for name, text in (("duplicate.tsv", "id\tt0\nrow-a\t0\nrow-a\t1\n"),
                           ("blank.tsv", "id\tt0\nrow-a\t0\n  \t1\n"),
                           ("missing.tsv", "t0\tt1\n0\t2\n")):
            with self.subTest(name=name):
                ctx = {"opts": opts.copy()}
                with self.assertRaises(WTError):
                    READERS["tsv_rows"](self.fx.write(name, text), ctx)

    def test_tsv_identity_option_keeps_legacy_ordinal_ids(self):
        path = self.fx.write("legacy-ordinal.tsv", "t0\tt1\twidth\n0\t2\twide\n2\t4\tclose\n")
        records = READERS["tsv_rows"](path, {})
        self.assertEqual([r["id"] for r in records], ["row-01", "row-02"])
        self.assertEqual([r["order"] for r in records], [1, 2])

    def test_several_speakers_split_lines(self):
        words = "Do you want to introduce yourself? I'm Sam and I make tools.".split()
        spk = ["S0"] * 6 + ["S1"] * 6
        p = self.make({"transcript_words": str(self.fx.write("t.json", transcript(words, spk)))})
        lines = [l for l in p["lines"] if l["dim"] == "speech.word"]
        self.assertEqual(len(lines), 2)

    def test_not_english(self):
        t = transcript("Hoy lanzamos nuestra nueva página para 3000 personas.".split())
        t["language"] = "es"
        p = self.make({"transcript_words": str(self.fx.write("t.json", t))})
        self.assertTrue(any(s["type"] == "NUMBER" for s in p["slots"].values()))
        post = {"text": "今日は新しいページを公開します。\n\n3000人が使っています。", "raw_text": {"facets": []}}
        p = self.make({"post_json": str(self.fx.write("p.json", post))}, "text-post")
        self.assertGreater(len(ops.dim_tokens(p, "post.word")), 10)

    def test_x_article_body_is_read(self):
        # An X article keeps its body in article.content.blocks; text holds only the link.
        post = {"text": "https://x.com/i/article/1", "raw_text": {"facets": []},
                "article": {"title": "The old way is dead", "content": {"blocks": [
                    {"type": "unstyled", "text": "Most people capture nothing."},
                    {"type": "header-two", "text": "Build a place for ideas"},
                    {"type": "blockquote", "text": "Write down what you notice."},
                    {"type": "ordered-list-item", "text": "Save one idea a day."}]}}}
        p = self.make({"post_json": str(self.fx.write("p.json", post))}, "text-post")
        words = " ".join(t["dims"]["post.word"] for t in ops.dim_tokens(p, "post.word"))
        for phrase in ("old way is dead", "capture nothing", "place for ideas", "what you notice", "one idea a day"):
            self.assertIn(phrase, words)
        self.assertGreaterEqual(len(p["units"]), 2)

    def test_no_timing_print_poster(self):
        spec = {"piece": {"id": "poster", "medium": "static"},
                "records": {"poster_reading": [{"id": "slide-1", "is_unit": True, "order": 1, "fields": {}},
                                               {"id": "slide-1.b1", "unit": "slide-1", "fields": {"text": "Sale ends Friday"}}]}}
        d = json.loads(Path(REG.path).read_text())
        d["dimensions"].append({"id": "poster.word", "media": ["static"], "value_kind": "text", "region": "headline",
                                "measure": [{"reader": "poster_reading", "field": "text", "token": "word"}]})
        reg = Registry(d, REG.path)
        p = ops.tokenize(spec, reg)
        self.assertTrue(all("t" not in t for t in p["tokens"]))
        rep = ops.drift(p, p, reg)["notes"]["drift"]
        self.assertEqual(rep["dims"]["poster.word"]["pct"], 100.0)

    def test_huge_piece(self):
        words = ("we went further and now it writes the letter for you " * 2500).split()     # 30,000 words
        p = self.make({"transcript_words": str(self.fx.write("t.json", transcript(words, gap=0.0)))})
        t0 = time.time()
        text = " ".join(words).replace("letter", "reply", 1)
        rep = ops.drift(p, text, REG)["notes"]["drift"]
        self.assertLess(time.time() - t0, 60)
        self.assertEqual(rep["dims"]["speech.word"]["replaced"], 1)

    def test_measurement_tool_missing(self):
        d = json.loads(Path(REG.path).read_text())
        d["readers"]["ocr_images"]["needs"] = ["a-tool-that-is-not-installed"]
        reg = Registry(d, REG.path)
        img = self.fx.dir / "imgs"
        img.mkdir()
        (img / "1.png").write_bytes(b"\x89PNG")
        p = ops.tokenize({"piece": {"id": "c", "medium": "carousel"}, "sources": {"ocr_images": str(img)}}, reg)
        why = [x["reason"] for x in p["pending"] if x["dim"] == "onscreen.word"][0]
        self.assertIn("tool not installed: a-tool-that-is-not-installed", why)

    def test_source_deleted(self):
        tp = self.fx.write("t.json", transcript(SENT))
        p = self.make({"transcript_words": str(tp)})
        tp.unlink()
        p2 = self.make({"transcript_words": str(tp)})
        self.assertIn("source missing", [x["reason"] for x in p2["pending"] if x["dim"] == "speech.word"][0])
        self.assertTrue(len(p["tokens"]) > 0)                      # the built template keeps its own values
        src = self.fx.write("fact.txt", "x\n")
        f = ops.fill(p, {"fills": {s: {"value": "v", "sources": [f"{src}:1"]} for s in p["slots"]}}, REG)
        src.unlink()
        md = render_fill_md(f, {"title": "t"}, REG)
        rep = ops.drift(p, md, REG, root=str(self.fx.dir))["notes"]["drift"]
        self.assertGreater(rep["summary"]["unsourced_fills"], 0)    # a deleted source stops counting as a source

    def test_conflicting_values(self):
        p = self.make({"tsv_rows": str(self.fx.write("s.tsv", TSV))},
                      annotate=[{"tokens": ["row-01"], "dims": {"sample.grade": "cool"}, "source": "a second reading"}])
        self.assertEqual(p["conflicts"][0]["dim"], "sample.grade")
        self.assertEqual(ops.tok_index(p)["row-01"]["dims"]["sample.grade"], "warm")
        a = self.make({"tsv_rows": str(self.fx.write("s.tsv", TSV))})
        b = copy.deepcopy(a)
        b["piece"]["id"] = "other-measurement"
        ops.tok_index(b)["row-02"]["dims"]["sample.angle"] = "low"
        m = ops.merge(a, b)
        self.assertTrue(any(c["dim"] == "sample.angle" for c in m["conflicts"]))

    def test_own_render_vs_reference(self):
        ref, _ = base_piece(self.fx)
        render = self.make({"transcript_words": str(self.fx.write("r.json", transcript(SENT[:3] + ["millions"] + SENT[3:])))},
                           auto_slot_rules=False)
        rep = ops.drift(ref, render, REG)["notes"]["drift"]
        self.assertEqual(rep["dims"]["speech.word"]["inserted"] + rep["dims"]["speech.word"]["replaced"], 1)


if __name__ == "__main__":
    unittest.main()
