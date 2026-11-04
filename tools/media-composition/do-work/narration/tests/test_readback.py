#!/usr/bin/env python3
"""Focused adopted narration matcher/readback regressions, derived from Showtime.

Old launcher, render, QA/receipt consumers and real synthesis cases are outside
this adopted source closure. This suite makes no acoustic or film-quality claim.
"""
from __future__ import annotations



import json
import os
import subprocess
import sys
import tempfile
import time
import unittest
from pathlib import Path

TESTS_DIR = Path(__file__).resolve().parent
SKILL = TESTS_DIR.parent
sys.path.insert(0, str(SKILL / "lib"))

FAST = "--fast" in sys.argv
FIXTURE = TESTS_DIR / "fixtures" / "readback" / "openai-swallowed.ogg"
BAD = "Now Open A I says its internal model showed five never work."
HEARD_BAD = "Now OpenI says its internal model showed five never work."   # what Parakeet wrote for the posted video


def words(text, step=0.3):
    return [{"text": w, "start": round(i * step, 3), "end": round(i * step + 0.2, 3)} for i, w in enumerate(text.split())]


def espeak_ok():
    try:
        from st.voice import espeak
        return bool(espeak.phonemize(["test"], "en-us")[0])
    except Exception:  # noqa: BLE001
        return False


ESPEAK = espeak_ok()


class Base(unittest.TestCase):
    def setUp(self):
        if not ESPEAK:
            self.skipTest("espeak-ng is not available here (showtime setup)")
        from st.voice import lexicon as lm
        from st.voice import readback as rb
        self.rb = rb
        self.lex = lm.load()

    def flagged(self, script, heard, lang="en-gb", **kw):
        r = self.rb.compare_line(script, words(heard), lang, self.lex, self.rb.capital_words([script]), **kw)
        return [(s["word"], s["heard"]) for s in r["suspects"]]


class MatcherTests(Base):
    def test_openai_spellings(self):
        good = "Now OpenAI says its internal model showed five."
        for heard in ("Now OpenAI says its internal model showed five.",
                      "Now open AI says its internal model showed five.",
                      "Now Open A I says its internal model showed five.",
                      "now openai says its internal model showed five"):
            self.assertEqual(self.flagged(good, heard), [], heard)
        for heard, got in (("Now OpenI says its internal model showed five.", "OpenI"),
                           ("Now open eye says its internal model showed five.", "open eye")):
            self.assertEqual(self.flagged(good, heard), [("OpenAI", got)], heard)

    def test_numbers(self):
        s = "Four to seven, for sixty-eight years. Then in twenty eighteen, a huge drawing ruled out four."
        self.assertEqual(self.flagged(s, "Four to seven, for 68 years. Then, in 2018, a huge drawing ruled out four."), [])
        self.assertEqual(self.flagged("It was 2018 when it began.", "It was two thousand eighteen when it began."), [])
        self.assertEqual(self.flagged("It is three point five times faster.", "It is 3.5 times faster."), [])
        self.assertEqual(self.flagged("The model showed nine.", "The model showed five."), [("nine", "five")])
        self.assertEqual(self.flagged("For sixty-eight years.", "For sixty years."), [("sixty-eight", "sixty")])
        nv = self.rb.number_value
        self.assertEqual(nv(["sixty-eight"], "en"), "68")
        self.assertEqual(nv(["twenty", "eighteen"], "en"), "2018")
        self.assertEqual(nv(["two", "thousand", "and", "eighteen"], "en"), "2018")
        self.assertEqual(nv(["nineteen", "ninety-nine"], "en"), "1999")
        self.assertEqual(nv(["three", "point", "five"], "en"), "3.5")
        self.assertEqual(nv(["1,000"], "en"), "1000")
        self.assertEqual(nv(["sesenta", "y", "ocho"], "es"), "68")
        self.assertEqual(nv(["dos", "mil", "dieciocho"], "es"), "2018")
        self.assertIsNone(nv(["sixty", "apples"], "en"))

    def test_harmless_noise_passes(self):
        cases = [("Colour the plane so points exactly one apart always differ.",
                  "Color the plane, so points exactly one apart always differ."),
                 ("If it holds up, it's six or seven. Which one? Still open.",
                  "If it holds up, it's six or seven, which one still open?"),
                 ("with a Lean proof a computer can check.", "with a lean proof a computer can check."),
                 ("Ask Claude about it.", "Ask clawed about it."),               # the same sound
                 ("This week CUDA is in the news.", "This week Cuta is in the news."),
                 ("This week JSON is in the news.", "This week Jason is in the news."),
                 ("Use the S Q L shell.", "Use the SQL shell.")]
        for s, h in cases:
            self.assertEqual(self.flagged(s, h), [], s)

    def test_short_names_keep_every_sound(self):
        self.assertEqual(self.flagged("Ask Claude about it.", "Ask cloud about it."), [("Claude", "cloud")])
        self.assertEqual(self.flagged("It runs on Nvidia chips.", "It runs on in video chips."),
                         [("Nvidia", "in video")])

    def test_spoken_math_affixes_preserve_operators_and_variables(self):
        self.assertEqual(self.flagged("N × N matters.", "N times n matters."), [])
        self.assertEqual(self.flagged("N ÷ N matters.", "N divided by n matters."), [])
        for heard in ("N n matters.", "N plus n matters.", "M times n matters."):
            self.assertTrue(self.flagged("N × N matters.", heard), heard)
        self.assertTrue(self.flagged("N ÷ N matters.", "N times n matters."))
        # A compact spelling currently loses the symbol in this front end.
        # Refuse that source limitation even when ASR repeats the lost symbol.
        for heard in ("N n matters.", "N times n matters."):
            result = self.rb.compare_line("N×N matters.", words(heard), "en", self.lex)
            self.assertEqual(result["suspects"][0]["source_issue"], "math_operator_not_verbalized")
        self.assertTrue(self.flagged("Now Open A I says so.", "Now Open a I says so."))

    def test_number_identifiers_keep_prefix_and_leading_zeros(self):
        for heard in ("M zero one seven checks the parts.", "M zero seventeen checks the parts."):
            self.assertEqual(self.flagged("M017 checks the parts.", heard), [], heard)
        self.assertEqual(self.flagged("M116 helps choose.", "M one one six helps choose."), [])
        self.assertEqual(self.flagged("GPT017 helps.", "G P T zero one seven helps."), [])
        for heard in ("M seventeen checks the parts.", "N zero one seven checks the parts.",
                      "M zero one eight checks the parts.", "M zero zero one seven checks the parts."):
            self.assertTrue(self.flagged("M017 checks the parts.", heard), heard)
        self.assertTrue(self.flagged("M116 helps choose.", "M1116 helps choose."))


    def test_what_matters(self):
        from st.voice.textnorm import normalize_tokens, tokenize
        text = "Colour the plane. Now Open A I and GitHub say I was right in 2018 with Lean."
        toks = tokenize(text)
        normalize_tokens(toks, "en")
        got = [(u["text"], u["kind"]) for u in self.rb.units(toks, "en", self.lex, self.rb.capital_words([text]))]
        self.assertEqual(got, [("Open A I", "name"), ("GitHub", "name"), ("2018", "number"), ("Lean", "name")])
        # a brand written in lower case counts when it is a title/brand name
        toks = tokenize("Made with showtime.")
        self.assertEqual([u["text"] for u in self.rb.units(toks, "en", None, set(), {"showtime"})], ["showtime"])

    def test_lone_a_is_told_as_the_article(self):
        r = self.rb.compare_line("Now Open A I says so.", words("Now Open a I says so."), "en-gb", self.lex)
        self.assertEqual(len(r["suspects"]), 1)
        s = r["suspects"][0]
        self.assertTrue(s["lone_a"])
        self.assertIn("one word (OpenAI)", self.rb.fix_for(s))
        # spelled-out letters the voice reads as letters are fine
        self.assertEqual(self.flagged("Use the S Q L shell.", "Use the S Q L shell."), [])

    def test_symbols(self):
        sym = self.rb.symbols
        self.assertEqual(sym("kˈʌlɚ"), sym("kʌlɚ"))
        self.assertEqual(sym("ˈɑːnɪks"), ["ɑ", "n", "ɪ", "k", "s"])
        self.assertEqual(sym("ɒŋŋks"), sym("ɒŋks"))
        self.assertEqual(sym("sjˈuːdoʊ"), sym("sˈuːdoʊ"))
        self.assertEqual(self.rb.letters("Open A I"), self.rb.letters("OpenAI"))


class FixtureTests(Base):
    """The posted video's line: the script respelled the name "Open A I", the voice swallowed the "A"."""

    def test_heard_text_of_the_posted_line_is_flagged(self):
        got = self.flagged(BAD, HEARD_BAD)
        self.assertEqual(got, [("Open A I", "OpenI")])

    @unittest.skip('The original soundtrack fixture is outside this focused source adoption; no acoustic claim.')
    def test_fixture_audio_is_flagged(self):
        ok, why = self.rb.asr_ready("en")
        if not ok:
            self.skipTest(why)
        self.assertTrue(FIXTURE.is_file())
        heard = self.rb.heard_words(FIXTURE, "en")
        self.assertTrue(heard, "nothing heard in the fixture")
        script = "Now Open A I says its internal model showed."      # the fixture: 3 s of that line
        r = self.rb.compare_line(script, heard, "en-gb", self.lex)
        self.assertEqual([s["word"] for s in r["suspects"]], ["Open A I"], r)
        self.assertNotIn("openai", self.rb.letters(r["heard"]))      # Parakeet hears "open an eye" here
        # judged on the sound alone (the name written as one word, no lone "A" to lint): still flagged
        r2 = self.rb.compare_line(script.replace("Open A I", "OpenAI"), heard, "en-gb", self.lex)
        self.assertEqual([s["word"] for s in r2["suspects"]], ["OpenAI"], r2)


def _wav(path, seconds=1.0):
    import numpy as np
    from st.voice import audio_io as aio
    path.parent.mkdir(parents=True, exist_ok=True)
    aio.write(path, (0.01 * np.sin(np.arange(int(48000 * seconds)) / 9.0)).astype("float32"), 48000, bits=16)




class VoiceScriptTests(Base):
    def test_heard_back_lines(self):
        rep = {"summary": "read-back: 1 word heard differently in 7 lines (\"Open A I\" as \"OpenI\")", "suspects": [
            {"line": "shot-6", "word": "Open A I", "heard": "OpenI", "t": 26.66, "kind": "name", "lone_a": True,
             "clip": "lines/05-shot-6.wav"}]}
        out = self.rb.report_lines(rep)
        self.assertEqual(out[0], rep["summary"])
        self.assertIn('WARN  26.66s  shot-6: "Open A I" heard as "OpenI"', out[1])
        self.assertTrue(out[2].strip().startswith("fix: "))
        self.assertIn("write the name as one word (OpenAI)", out[2])
        s = dict(rep["suspects"][0], word="Qwen", heard="Kuen", lone_a=False)
        self.assertIn("lexicon.json", self.rb.fix_for(s, "lines/02-x.wav"))
        self.assertIn("voice ipa", self.rb.fix_for(s))
        self.assertEqual(self.rb.report_lines({"skipped": "no recognizer"}), ["read-back skipped: no recognizer"])



class LexiconTests(Base):
    def test_project_lexicon_overrides_the_built_in_one(self):
        from st.voice import lexicon as lm
        d = Path(tempfile.mkdtemp(prefix="st-rb-lex-"))
        builtin = lm.load()
        self.assertTrue(builtin.ipa("LaTeX", "en"), "LaTeX is in the starter list")
        (d / "lexicon.json").write_text(json.dumps({"LaTeX": {"say": "lah tek"}, "Acme": {"say": "ak mee"}}),
                                        encoding="utf-8")
        lex = lm.load(project_dir=d)
        self.assertEqual(lex.say("LaTeX", "en"), "lah tek")
        self.assertIsNone(lex.ipa("LaTeX", "en"))
        names = self.rb.critical_names(d, lex)
        self.assertIn("latex", names)                  # the project's own entries are its names
        self.assertIn("acme", names)
        self.assertNotIn("kubectl", names)             # the built-in list is not
        # a lexicon word is checked even at a sentence start
        r = self.rb.compare_line("Acme ships today.", words("Akme ships today."), "en-us", lex)
        self.assertEqual(r["checked"], 1)

    def test_starter_entries(self):
        from st.voice import lexicon as lm
        data = json.loads(lm.BUILTIN.read_text(encoding="utf-8"))
        for w, e in data.items():
            if w.startswith("_"):
                continue
            self.assertTrue(isinstance(e, (str, dict)) and (isinstance(e, str) or {"ipa", "say"} & set(e)), w)


class ClearedPhraseTests(unittest.TestCase):
    """A cleared name also clears the name as whole words inside a longer phrase, but only when the phrase's other
    words were heard as written (issue #46)."""

    def rep(self, *items):
        return {"lines": [{"id": "l1"}], "checked": len(items), "suspects": [
            dict({"word": w, "heard": h, "kind": "name", "line": "l1", "t": float(i)}, **(x[2] if len(x) > 2 else {}))
            for i, x in enumerate(items) for w, h in [x[:2]]]}

    def test_a_name_clears_the_phrases_that_contain_it(self):
        from st.voice import readback as rb
        out = rb.apply_cleared(self.rep(("Qwen", "QN"), ("Qwen Image", "QN image"), ("the Qwen Image Edit", "the QN image edit"),
                                        ("Quenched", "x")), ["Qwen"])
        self.assertEqual([s["word"] for s in out["cleared"]], ["Qwen", "Qwen Image", "the Qwen Image Edit"])
        self.assertEqual([s["word"] for s in out["suspects"]], ["Quenched"], "only whole words clear, not pieces of a word")

    def test_words_nobody_listened_to_are_not_cleared(self):
        from st.voice import readback as rb
        out = rb.apply_cleared(self.rep(("Hugging Face Hub", "hugging face hob"), ("GPT 4o", "GPT for oh"),
                                        ("Open A I", "open eye", {"lone_a": True}), ("Hugging Face Hub", "hugging face hub")),
                               ["Hugging Face", "GPT", "AI", "I"])
        self.assertEqual([(s["word"], s["heard"]) for s in out["cleared"]], [("Hugging Face Hub", "hugging face hub")])
        self.assertEqual([s["word"] for s in out["suspects"]], ["Hugging Face Hub", "GPT 4o", "Open A I"])

    def test_a_phrase_and_a_respelling_still_clear(self):
        from st.voice import readback as rb
        out = rb.apply_cleared(self.rep(("Hugging Face", "hugging faced"), ("Open A I", "open eye"), ("Face", "x")),
                               ["Hugging Face", "OpenAI"])
        self.assertEqual([s["word"] for s in out["cleared"]], ["Hugging Face", "Open A I"])
        self.assertEqual([s["word"] for s in out["suspects"]], ["Face"])

    def test_accents_match_inside_a_phrase(self):
        from st.voice import readback as rb
        out = rb.apply_cleared(self.rep(("Caf\u00e9 Image", "cafe image")), ["Cafe"])
        self.assertEqual([s["word"] for s in out["cleared"]], ["Caf\u00e9 Image"])

    def test_a_stale_noted_flag_is_dropped_once_cleared(self):
        from st.voice import readback as rb
        out = rb.apply_cleared(self.rep(("Qwen", "QN")), [], ["Qwen"])
        self.assertTrue(out["suspects"][0]["noted"])
        out = rb.apply_cleared(out, ["Qwen"], ["Qwen"])
        self.assertNotIn("noted", out["cleared"][0])



if __name__ == "__main__":
    argv = [a for a in sys.argv if a != "--fast"]
    t0 = time.time()
    prog = unittest.main(argv=argv, exit=False, verbosity=2 if "-v" in argv else 1)
    res = prog.result
    n = res.testsRun - len(res.skipped)
    print("\n%d checks passed, %d skipped in %.1fs" % (n - len(res.failures) - len(res.errors), len(res.skipped),
                                                      time.time() - t0))
    sys.exit(0 if res.wasSuccessful() else 1)
