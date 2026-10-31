# tools/conversations/test/python/test_same_as_old.py
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

# The one place the new reader is meant to differ: the old Slack decoder put the repr of a profile object into the
# speaker identity when a speaker had a profile ("{'real_name': 'Rosa'}"); the new reader uses the name itself.
# The old Gmail decoder named the person's own messages by their mailbox address; the new reader names them "me", as
# every other source does, so they are kept as the person's own words wherever the mailbox address was not known.
KNOWN_DIFFERENCES = {"speaker:source:proof:{'real_name': 'Rosa'}": "speaker:source:proof:Rosa",
                     "speaker:source:proof:me@example.com": "speaker:source:proof:me"}


# The new reader gives a Gemini log line its message id, and an assistant session event its place in the log, as its
# source id (so an edited or replayed line keeps one identity); the
# old decoders gave none. Only the source id is masked for these sources; words, time and speaker are compared.
NEW_SOURCE_ID = {"gemini-cli-logs", "agent-session-events"}


def _masked(projected, source):
    if source not in NEW_SOURCE_ID:
        return projected
    atoms = sorted([["", *atom[1:]] for atom in projected["atoms"]])
    return {**projected, "atoms": atoms}


def _as_new(old):
    text = json.dumps(old)
    for was, now in KNOWN_DIFFERENCES.items():
        text = text.replace(json.dumps(was)[1:-1], json.dumps(now)[1:-1])
    return json.loads(text)


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
            path = pathlib.Path(tmp) / fixture["file_name"]
            path.write_bytes(same_as_old.file_bytes(fixture))
            new = same_as_old.projection(same_as_old.decode_new(support, fixture, path))
            assert _masked(new, fixture["source"]) == _masked(_as_new(fixture["old"]), fixture["source"]), fixture["source"]


def test_every_fixture_has_threads_and_messages_so_the_comparison_means_something():
    for fixture in _fixtures():
        assert fixture["old"]["threads"] and fixture["old"]["atoms"], fixture["source"]
