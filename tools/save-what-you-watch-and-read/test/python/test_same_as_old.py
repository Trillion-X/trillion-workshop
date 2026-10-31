# tools/save-what-you-watch-and-read/test/python/test_same_as_old.py
#
# Holds the new reader to what the decoders it replaced gave, on the same made-up exports: fixtures/old_outputs.json
# holds each export and the old answer. The new answer must have the same threads, the same messages (id, words, time,
# speaker) and the same count of rejections.
#
# How the fixtures were made: once, from the old decoders' own code, by
#   OLD_DECODER_PACKAGES=<folder holding the old decoder packages> python3 run_tests.py test_same_as_old.py
# which also rewrites fixtures/old_outputs.json (same_as_old.make_fixtures). Without that variable the test only reads
# the fixtures, so it runs anywhere.
import json
import os
import pathlib
import tempfile

import support  # noqa: E402

import same_as_old  # noqa: E402

FIXTURE_FILE = pathlib.Path(__file__).resolve().parent / "fixtures" / "old_outputs.json"


def test_a_make_the_fixtures_from_the_old_decoders_when_they_are_given():
    folder = os.environ.get("OLD_DECODER_PACKAGES")
    if folder:
        FIXTURE_FILE.parent.mkdir(exist_ok=True)
        FIXTURE_FILE.write_text(json.dumps({"fixtures": same_as_old.make_fixtures(folder)}, indent=1, sort_keys=True), encoding="utf-8")


def _fixtures():
    return json.loads(FIXTURE_FILE.read_text(encoding="utf-8"))["fixtures"]


def test_the_new_reader_gives_what_the_old_decoders_gave():
    fixtures = _fixtures()
    assert fixtures
    for fixture in fixtures:
        with tempfile.TemporaryDirectory() as tmp:
            path = pathlib.Path(tmp) / "input.json"
            path.write_text(json.dumps(fixture["snapshot"]), encoding="utf-8")
            observation = {**same_as_old.OBSERVATION, "native_ref": str(path)}
            new = same_as_old.projection(support.source(fixture["source"]).decode(observation, {}))
            assert new == fixture["old"], fixture["source"]


def test_every_fixture_has_threads_and_messages_so_the_comparison_means_something():
    for fixture in _fixtures():
        assert fixture["old"]["threads"] and fixture["old"]["atoms"], fixture["source"]
