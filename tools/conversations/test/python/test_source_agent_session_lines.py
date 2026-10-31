# tools/conversations/test/python/test_source_agent_session_lines.py
#
# Proves the `agent-session-lines` source row: a JSON-lines chat log whose every line is {role, content, timestamp,
# id?} with a leading meta line -> one thread (the file) of ordered utterances through the shared mapper. Only user
# and assistant lines with words are messages; the rest (meta, tool, system lines) are skipped. Identity is the
# line's own id, else its place in the file.
import json
import pathlib
import tempfile

import support  # noqa: E402

dec = support.source("agent-session-lines")


def _file(lines, name="session.jsonl"):
    path = pathlib.Path(tempfile.mkdtemp()) / name
    path.write_text("".join(json.dumps(line) + "\n" for line in lines), encoding="utf-8")
    return path


def _obs(path):
    return {"source_ref": "source:fixture", "native_ref": str(path), "batch_ref": "batch:test",
            "observed_at": "2026-08-01T00:00:00Z"}


def test_user_and_assistant_lines_become_one_thread_and_the_rest_is_skipped():
    path = _file([
        {"role": "session_meta", "platform": "x"},
        {"role": "user", "content": "<@123> What is on today?", "timestamp": "2026-08-01T09:00:00Z"},
        {"role": "tool", "content": "ignored"},
        {"role": "assistant", "content": "Two meetings.", "timestamp": "2026-08-01T09:00:05Z"},
        {"role": "assistant", "content": "   ", "timestamp": "2026-08-01T09:00:06Z"},
        {"role": "assistant", "content": ["not text"], "timestamp": "2026-08-01T09:00:07Z"},
    ], name="20260801_a1.jsonl")
    decoded = dec.decode(_obs(path), {})
    assert decoded["rejections"] == []
    thread = decoded["threads"][0]
    assert thread["session_id"] == "20260801_a1" and thread["atom_count"] == 2
    assert thread["presentation"]["title"] == "What is on today?"         # a leading mention is not part of a title
    assert thread["presentation"]["subtitle"] == "Two meetings."
    assert thread["started_at"] == "2026-08-01T09:00:00Z" and thread["last_activity_at"] == "2026-08-01T09:00:05Z"
    assert [(a["speaker_ref"], a["content"]["text"]) for a in decoded["atoms"]] == [
        ("speaker:source:fixture:user", "<@123> What is on today?"),
        ("speaker:source:fixture:assistant", "Two meetings.")]


def test_a_wrapped_first_line_never_titles_the_thread():
    path = _file([{"role": "user", "content": "<system>wrapper</system>"},
                  {"role": "assistant", "content": "ok"}], name="s9.jsonl")
    assert dec.decode(_obs(path), {})["threads"][0]["presentation"]["title"] == "s9"


def test_native_identity_survives_suffix_edits_and_windowing():
    def row(identity, text):
        return {"id": identity, "role": "user", "content": text}
    path = _file([row("one", "x" * 100 + "A"), row("two", "x" * 100 + "A")])
    before = dec.decode(_obs(path), {})["atoms"]
    path.write_text("".join(json.dumps(r) + "\n" for r in (row("one", "x" * 100 + "B"), row("two", "x" * 100 + "A"))),
                    encoding="utf-8")
    after = dec.decode(_obs(path), {})["atoms"]
    page = dec.decode_window(_obs(path), {}, limit=1, session_id="session")
    assert page["atoms"][0]["atom_ref"] == after[-1]["atom_ref"]
    assert before[0]["atom_ref"] != before[1]["atom_ref"]
    assert before[0]["atom_ref"] == after[0]["atom_ref"]
    assert before[0]["content_revision"] != after[0]["content_revision"]


def test_a_line_without_an_id_is_keyed_by_its_place_in_the_file():
    lines = [{"role": "user", "content": "same words"}, {"role": "user", "content": "same words"}]
    atoms = dec.decode(_obs(_file(lines)), {})["atoms"]
    assert len(atoms) == 2 and atoms[0]["atom_ref"] != atoms[1]["atom_ref"]


def test_a_window_pages_the_file_newest_first_with_a_count():
    path = _file([{"role": "user" if n % 2 == 0 else "assistant", "content": f"line {n}"} for n in range(9)])
    page = dec.decode_window(_obs(path), {}, limit=4, session_id="session")
    assert [a["content"]["text"] for a in page["atoms"]] == ["line 5", "line 6", "line 7", "line 8"]
    assert page["total_count"] == 9 and page["has_older"] and not page["has_newer"]
    older = dec.decode_window(_obs(path), {}, before_cursor=page["older_cursor"], limit=4, session_id="session")
    assert [a["content"]["text"] for a in older["atoms"]] == ["line 1", "line 2", "line 3", "line 4"]


def test_a_file_that_holds_no_words_is_no_thread_and_an_unreadable_one_is_one_rejection():
    assert dec.decode(_obs(_file([{"role": "session_meta"}])), {}) == {"threads": [], "atoms": [], "rejections": []}
    result = dec.decode(_obs(pathlib.Path(tempfile.mkdtemp()) / "missing.jsonl"), {})
    assert result["threads"] == [] and result["rejections"][0]["violation_path"] == "native_ref"
