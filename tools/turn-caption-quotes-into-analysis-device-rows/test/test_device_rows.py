#!/usr/bin/env python3
"""The pure readers on made-up rows: quotes checked against captions, counts, cells from the person's templates, the index added once."""
import json
import os
import sys
import unittest

sys.path.insert(0, os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "read-data"))
sys.path.insert(0, os.path.join(os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))),
                                "cite-principles-from-captions", "read-data"))
import device_rows as d  # noqa: E402
import captions as c  # noqa: E402

CAPTIONS = {
    "vidA": {"events": [{"tStartMs": 0, "segs": [{"utf8": "welcome to the potting bench"}]},
                        {"tStartMs": 178960, "segs": [{"utf8": "water the roots,\nnot the leaves"}]},
                        {"tStartMs": 185000, "aAppend": 1},
                        {"tStartMs": 190500, "segs": [{"utf8": "  It’s   that simple "}]}]},
    "vidB": {"events": [{"tStartMs": 61000, "segs": [{"utf8": "Prune in late winter"}]}]},
}


def settings():
    return {
        "family": "garden-tips", "title": "Garden tips", "introduction": "Made-up rows.",
        "channels": {"vidA": ["BenchTalk", "Potting basics"], "vidB": ["OrchardHour", "Pruning"]},
        "groups": ["Care", "Seasons"],
        "rows": [
            {"group": "Care", "name": "say the rule, then the reason", "also": ["root rule", "plain words"],
             "what": "The viewer remembers the rule.", "transfer": "Use it for chores.",
             "seen": [["vidA", "water the roots, not the leaves"], ["vidA", "it's that simple"]],
             "fits": "how-to", "cost": "low", "verification": "verified"},
            {"group": "Seasons", "name": "name the season first", "also": [], "what": "The viewer knows when.",
             "seen": [["vidB", "prune in LATE winter"], [None, "a seed catalogue, page 4"]], "extra": "frames 0-60 s",
             "fits": "calendar", "cost": "med", "verification": "verified"},
            {"group": "Care", "name": "an unmeasured row", "also": [], "what": "Read elsewhere.",
             "seen": [[None, "a magazine piece"]], "fits": "any", "cost": "low", "verification": "unchecked"},
        ],
        "columns": [
            {"head": "tip", "parts": [{"text": "**{name}**"}, {"text": " (also: {also})", "when": "also"},
                                      {"text": " <br>_from {family}_"}]},
            {"head": "what", "parts": [{"text": "{what}"}, {"text": " Transfer: {transfer}", "when": "transfer"}]},
            {"head": "seen in", "parts": [{"text": "**{creators} {creators|maker|makers}, {items} {items|clip|clips}:** {seen_text}"}]},
            {"head": "cost", "parts": [{"text": "{cost}"}]},
        ],
        "file_head": ["# {title}", "", "{introduction}", "", "- Rows: {rows}", ""],
        "index_marker": "<!-- {family} -->",
        "seen_quote": "{channel}/{video} [{stamp}] \"{quote}\"",
        "seen_join": "; ",
        "list_join": "; ",
        "checked_fields": ["group", "name", "cost"],
    }


def finder():
    texts = {video: c.CaptionText(d.exact_segs_from_json3(doc)) for video, doc in CAPTIONS.items()}
    return lambda video, quote: texts[video].second_of(quote) if video in texts else "MISSING"


class DeviceRowsTest(unittest.TestCase):
    def test_quotes_are_found_whatever_the_case_space_and_apostrophes_and_their_second_is_cut_not_rounded(self):
        rows, bad = d.check_rows(settings(), finder())
        self.assertEqual(bad, [])
        self.assertEqual(rows[0]["t"], [["vidA", 178, "water the roots, not the leaves"], ["vidA", 190, "it's that simple"]])
        self.assertEqual(rows[0]["seen_text"], 'BenchTalk/vidA [2:58] "water the roots, not the leaves"; BenchTalk/vidA [3:10] "it\'s that simple"')
        self.assertEqual((rows[0]["creators"], rows[0]["items"]), (1, 1))

    def test_unmeasured_evidence_and_extra_are_kept_in_order_and_a_row_without_quotes_counts_one(self):
        rows, _ = d.check_rows(settings(), finder())
        self.assertEqual(rows[1]["seen_text"], 'OrchardHour/vidB [1:01] "prune in LATE winter"; a seed catalogue, page 4; frames 0-60 s')
        self.assertEqual((rows[2]["creators"], rows[2]["items"]), (1, 1))
        self.assertNotIn("t", rows[2])

    def test_a_wrong_quote_and_a_video_without_captions_are_told_apart(self):
        s = settings()
        s["rows"][0]["seen"] = [["vidA", "water the leaves"]]
        s["channels"]["vidC"] = ["Nobody", "No captions"]
        s["rows"][1]["seen"] = [["vidC", "anything"]]
        _, bad = d.check_rows(s, finder())
        self.assertEqual([(b["video"], b["reason"]) for b in bad], [("vidA", "not in the captions"), ("vidC", "no caption file")])

    def test_a_video_the_channels_do_not_name_is_refused(self):
        s = settings()
        s["rows"][0]["seen"] = [["vidZ", "x"]]
        with self.assertRaises(d.SettingsError):
            d.check_rows(s, finder())

    def test_cells_follow_the_templates_and_drop_parts_whose_field_is_empty(self):
        rows, _ = d.check_rows(settings(), finder())
        s = settings()
        self.assertEqual(d.cells(rows[0], s)[0], "**say the rule, then the reason** (also: root rule; plain words) <br>_from garden-tips_")
        self.assertEqual(d.cells(rows[1], s)[0], "**name the season first** <br>_from garden-tips_")
        self.assertEqual(d.cells(rows[1], s)[1], "The viewer knows when.")
        self.assertTrue(d.cells(rows[0], s)[2].startswith("**1 maker, 1 clip:**"))

    def test_plural_words_follow_the_count(self):
        self.assertEqual(d.fill("{n} {n|clip|clips}", {"n": 2}), "2 clips")
        self.assertEqual(d.fill("{n} {n|clip|clips}", {"n": 1}), "1 clip")

    def test_a_cell_with_a_bar_is_refused_and_a_template_naming_an_unknown_field_is_refused(self):
        rows, _ = d.check_rows(settings(), finder())
        rows[0]["what"] = "a | b"
        with self.assertRaises(d.SettingsError):
            d.cells(rows[0], settings())
        with self.assertRaises(d.SettingsError):
            d.fill("{nothing}", {})

    def test_the_family_file_has_the_head_then_a_table_per_group_in_order(self):
        rows, _ = d.check_rows(settings(), finder())
        text = d.family_text(rows, settings())
        lines = text.split("\n")
        self.assertEqual(lines[:6], ["# Garden tips", "", "Made-up rows.", "", "- Rows: 3", ""])
        self.assertEqual(lines[6:10], ["## Care", "", "| tip | what | seen in | cost |", "|---|---|---|---|"])
        self.assertLess(text.index("## Care"), text.index("## Seasons"))
        self.assertEqual(sum(line.startswith("| **") for line in lines), 3)

    def test_the_index_gets_the_family_once(self):
        rows, _ = d.check_rows(settings(), finder())
        once, added = d.index_with_family("# Index\n\nold rows\n\n\n", rows, settings())
        self.assertTrue(added)
        self.assertTrue(once.startswith("# Index\n\nold rows\n\n<!-- garden-tips -->\n\n## Care"))
        twice, added_again = d.index_with_family(once, rows, settings())
        self.assertFalse(added_again)
        self.assertEqual(twice, once)

    def test_the_checked_records_keep_the_named_fields_and_t(self):
        rows, _ = d.check_rows(settings(), finder())
        records = d.checked_records(rows, settings())
        self.assertEqual(list(records[0]), ["group", "name", "cost", "t"])
        self.assertEqual(list(records[2]), ["group", "name", "cost"])
        json.dumps(records)

    def test_missing_settings_are_named(self):
        self.assertEqual(d.missing_settings({"family": "x"})[:2], ["title", "introduction"])
        self.assertEqual(d.missing_settings(settings()), [])


if __name__ == "__main__":
    unittest.main()
