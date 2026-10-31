"""Checks of the pure readers on synthetic speech: measure, the grade rules, the duck, the span file, the phrase split, the word-error count.

Prints "ok" when every promise holds; an assertion says which one does not.
"""
import json
import sys
import tempfile
from pathlib import Path

import numpy as np
import soundfile as sf

here = Path(__file__).resolve().parent
sys.path.insert(0, str(here))
sys.path.insert(0, str(here.parent / "read-data"))
sys.path.insert(0, str(here.parent / "do-work"))

import gap_duck  # noqa: E402
import grade_rules  # noqa: E402
import measure  # noqa: E402
import phrases  # noqa: E402
import reading  # noqa: E402
import settings  # noqa: E402
import spans  # noqa: E402
import synthetic_speech as synth  # noqa: E402

work = Path(tempfile.mkdtemp(prefix="grade-speech-"))
T = settings.load(str(here / "settings-for-synthetic-speech.json"))


def measured(name, **options):
    words = synth.write(work / f"{name}.wav", **options)
    return measure.measure(str(work / f"{name}.wav"), words)


clean = measured("clean")
noisy = measured("noisy", noise_db=-38.0, hum_db=-30.0)
clipped = measured("clipped", clip=True)

# the noise floor is read from the pauses: a clean take measures far better than a noisy one
assert clean["noise_method"] == "word-gaps", clean
assert clean["snr_db"] > noisy["snr_db"] + 20, (clean["snr_db"], noisy["snr_db"])
assert clean["noise_floor_dbfs"] < -70 and noisy["noise_floor_dbfs"] > -45, (clean, noisy)
# a hum under the noise is found on the mains grid and a clean take shows none
assert noisy["hum_hz"] in measure.HUM_HZ and noisy["hum_prominence_db"] >= T["hum_prominence_db_max"], noisy
assert clean["hum_prominence_db"] < T["hum_prominence_db_max"], clean
assert clipped["clip_fraction"] > T["clip_fraction_max"], clipped
assert clean["clip_fraction"] == 0 and clean["sample_rate"] == synth.SR and clean["channels"] == 1

# the grade rules read DATA thresholds: clean is good; noise, hum and clipping each say why; a very noisy cut stays bad after a remaster
assert grade_rules.grade_raw(clean, T) == ("good", []), grade_rules.grade_raw(clean, T)
grade, reasons = grade_rules.grade_raw(noisy, T)
assert grade == "remaster" and any(r.startswith("noise") for r in reasons), reasons
grade, reasons = grade_rules.grade_raw(clipped, T)
assert grade == "remaster" and any(r.startswith("clipping") for r in reasons), reasons
assert grade_rules.grade_after_remaster(clipped, T)[0] == "clone", "clipping is a hard fault a remaster is not trusted to fix"
assert grade_rules.grade_after_remaster({**noisy, "snr_db": 20.0, "clip_fraction": 0}, T)[0] == "clone"
assert grade_rules.grade_after_remaster({**noisy, "snr_db": 30.0, "hum_prominence_db": 0, "clip_fraction": 0, "true_peak_db": -3}, T)[0] == "remaster"

# when the words leave under 0.3 s of pause the quietest tenth of the frames stands in for the pauses
assert measure.measure(str(work / "clean.wav"), [{"text": "all", "start": 0.0, "end": 5.6}])["noise_method"] == "quietest-10%"

# the duck pulls the pauses down by DUCK_DB and leaves the words alone
x, words = synth.speech(noise_db=-40.0)
ducked = gap_duck.duck(x, synth.SR, words, T["duck_db"], T["duck_min_gap_seconds"])
loud = slice(int(0.55 * synth.SR), int(0.85 * synth.SR))
pause = slice(int(1.9 * synth.SR), int(2.2 * synth.SR))
assert np.allclose(ducked[loud], x[loud]), "a word is not touched"
drop = 20 * np.log10(np.sqrt((ducked[pause] ** 2).mean()) / np.sqrt((x[pause] ** 2).mean()))
assert abs(drop - T["duck_db"]) < 1.0, drop
sf.write(work / "x.wav", x, synth.SR, subtype="PCM_24")
gap_duck.duck_file(str(work / "x.wav"), str(work / "d.wav"), words, T["duck_db"], T["duck_min_gap_seconds"])
assert sf.read(work / "d.wav")[0].shape == x.shape

# the span file: ids, dedupe, refusals, words inside the span
spans_path = work / "spans.json"
good = {"clip": "take", "source": str(work / "clean.wav"), "from": 0.4, "to": 5.0, "text": "alpha", "words": words}
spans_path.write_text(json.dumps({"spans": [good, dict(good), {**good, "to": 4.0}]}))
loaded = spans.load_spans(str(spans_path))
assert list(loaded) == ["take_0.40_5.00", "take_0.40_4.00"], list(loaded)
assert spans.graded_audio_name("take_0.40_5.00") == "audio/take_0.40_5.00.wav"
inside = spans.span_words(words, good)
assert [w["text"] for w in inside] == ["alpha", "bravo", "charlie", "delta", "echo"] and inside[0]["start"] == 0.1, inside
assert spans.span_words(None, good) == []
for broken, why in (({k: v for k, v in good.items() if k != "text"}, "lacks text"),
                    ({**good, "to": 0.1}, "before it starts"),
                    ({**good, "source": str(work / "missing.wav")}, "is not a file")):
    spans_path.write_text(json.dumps({"spans": [broken]}))
    try:
        spans.load_spans(str(spans_path))
    except SystemExit as stop:
        assert why in str(stop), stop
    else:
        raise AssertionError(f"a span that {why} is refused")

# phrases split at pauses, and after sentence ends, never inside a quick run of words
w = lambda text, a, b: {"text": text, "start": a, "end": b}  # noqa: E731
run = [w("one", 0.0, 0.3), w("two", 0.32, 0.6), w("three.", 0.8, 1.1), w("four", 1.15, 1.4), w("five", 1.9, 2.2)]
split = [[x["text"] for x in p] for p in phrases.phrases(run)]
assert split == [["one", "two"], ["three.", "four"], ["five"]] or split == [["one", "two", "three.", "four"], ["five"]], split

# word errors: punctuation, case and spoken contractions do not count, a changed word does
assert reading.errors("Going to the shop, wanna buy milk.", "going to the shop want to buy milk", T["spoken_forms"]) == 0
assert reading.errors("wanna", "want to", {}) == 2, "a spoken form counts only when the settings name it"
assert reading.errors("Café ünï", "cafe ünï", {}) == 1, "words in any script are counted, not dropped"
assert reading.errors("one two three", "one too three", {}) == 1
assert reading.errors("one two three", "one three", {}) == 1

# the settings: a file that lacks a key or gives it the wrong type stops the run naming it; nothing has a default
for broken, why in (({k: v for k, v in json.load(open(here / "settings-for-synthetic-speech.json")).items() if k != "snr_db_min"}, "snr_db_min is missing"),
                   ({**T, "language": 5}, "language must be a string"),
                   ({**T, "handle_seconds": True}, "handle_seconds must be a number")):
    path = work / "broken-settings.json"
    path.write_text(json.dumps(broken))
    try:
        settings.load(str(path))
    except SystemExit as stop:
        assert why in str(stop), stop
    else:
        raise AssertionError(f"settings where {why} are refused")
assert set(T) == set(settings.KEYS)

print("ok")
