# tools/conversations/test/python/test_source_gemini_cli_logs.py
#
# Proves the `gemini-cli-logs` source row: a JSON ARRAY of {sessionId, messageId, type, message, timestamp} records
# -> one thread per in-file session through the shared mapper. A repeated messageId keeps the latest record (an edit,
# decided by time then by the record's own BLAKE3 identity, never by input order); atom identity is the messageId, so
# an edit, a suffix change or a page of the thread keeps it; an unnumbered record is keyed by its original position.
import json
import pathlib
import tempfile

import support  # noqa: E402

dec = support.source("gemini-cli-logs")

FIXTURE = [
    {"sessionId": "s-1", "messageId": 1, "type": "user", "message": "first turn", "timestamp": "2026-07-24T10:00:00Z"},
    {"sessionId": "s-1", "messageId": 2, "type": "assistant", "message": "first reply",
     "timestamp": "2026-07-24T10:01:00Z"},
    {"sessionId": "s-1", "messageId": 2, "type": "assistant", "message": "edited reply",
     "timestamp": "2026-07-24T10:02:00Z", "attachments": [{"name": "proof.txt"}]},
    {"sessionId": "s-2", "messageId": 1, "type": "user", "message": "second session",
     "timestamp": "2026-07-24T11:00:00Z"},
]


def _file(records, name="logs.json"):
    path = pathlib.Path(tempfile.mkdtemp()) / name
    path.write_text(json.dumps(records), encoding="utf-8")
    return path


def _obs(path):
    return {"source_ref": "source:fixture", "native_ref": str(path), "batch_ref": "batch:test",
            "observed_at": "2026-07-24T12:00:00Z"}


def test_one_file_fans_out_to_one_thread_per_session_and_an_edit_replaces_its_record():
    decoded = dec.decode(_obs(_file(FIXTURE)), {})
    assert [t["session_id"] for t in decoded["threads"]] == ["s-1", "s-2"]
    first = [a for a in decoded["atoms"] if a["thread_ref"].endswith(":s-1")]
    assert [a["content"]["text"] for a in first] == ["first turn", "edited reply"]
    assert first[1]["attachments"] == [{"name": "proof.txt"}]
    assert "attachments" not in first[0]
    assert decoded["threads"][0]["presentation"]["title"] == "first turn"
    assert decoded["threads"][0]["presentation"]["subtitle"] == "edited reply"


def test_native_identity_survives_suffix_edits_and_windowing():
    def row(identity, text):
        return {"sessionId": "session", "messageId": identity, "type": "user", "message": text}
    path = _file([row("one", "x" * 100 + "A"), row("two", "x" * 100 + "A")])
    before = dec.decode(_obs(path), {})["atoms"]
    path.write_text(json.dumps([row("one", "x" * 100 + "B"), row("two", "x" * 100 + "A")]), encoding="utf-8")
    after = dec.decode(_obs(path), {})["atoms"]
    page = dec.decode_window(_obs(path), {}, limit=1, session_id="session")
    assert page["atoms"][0]["atom_ref"] == after[-1]["atom_ref"]
    assert before[0]["atom_ref"] != before[1]["atom_ref"]
    assert before[0]["atom_ref"] == after[0]["atom_ref"]
    assert before[0]["content_revision"] != after[0]["content_revision"]


def test_an_unnumbered_record_is_keyed_by_its_original_position_before_sorting():
    row = {"sessionId": "session", "type": "user", "message": "kept", "timestamp": "2026-01-02"}
    path = _file([row])
    before = dec.decode(_obs(path), {})["atoms"][0]
    path.write_text(json.dumps([row, {"sessionId": "session", "type": "user",
                                      "message": "later appended, earlier timestamp", "timestamp": "2026-01-01"}]),
                    encoding="utf-8")
    after = next(a for a in dec.decode(_obs(path), {})["atoms"] if a["content"]["text"] == "kept")
    assert before["atom_ref"] == after["atom_ref"]


def test_duplicate_records_at_one_time_are_decided_by_content_not_by_input_order():
    one = {"sessionId": "s", "messageId": "m", "type": "user", "message": "version one", "timestamp": "2026-01-01"}
    two = {"sessionId": "s", "messageId": "m", "type": "user", "message": "version two", "timestamp": "2026-01-01"}
    forward = dec.decode(_obs(_file([one, two])), {})["atoms"][0]["content"]["text"]
    backward = dec.decode(_obs(_file([two, one])), {})["atoms"][0]["content"]["text"]
    assert forward == backward


def test_a_file_without_session_ids_is_one_thread_named_by_the_file():
    path = _file([{"type": "user", "message": "hello", "messageId": 1}], name="chat-9.json")
    thread = dec.decode(_obs(path), {})["threads"][0]
    assert thread["session_id"] == "chat-9"


def test_summary_pages_cover_one_multisession_file_without_repeats():
    path = _file([{"sessionId": f"session-{index}", "messageId": f"message-{index}", "type": "user",
                   "message": f"Conversation {index}", "timestamp": f"2026-09-12T00:00:{index:02d}Z"}
                  for index in range(7)])
    observation = _obs(path)
    cursor, seen = None, []
    for expected_count in (3, 3, 1):
        page = dec.decode_summary_page(observation, {}, cursor, 3)
        assert len(page["threads"]) == expected_count
        refs = [thread["thread_ref"] for thread in page["threads"]]
        assert not set(refs).intersection(seen)
        seen.extend(refs)
        cursor = page["next_cursor"]
        assert page["has_more"] == (cursor is not None)
    assert cursor is None and len(seen) == 7


def test_a_summary_page_names_what_it_refuses():
    path = _file(FIXTURE)
    for cursor, limit, path_name in ((-1, 3, "cursor"), (0, 0, "limit"), (0, 65, "limit"), (True, 3, "cursor")):
        page = dec.decode_summary_page(_obs(path), {}, cursor, limit)
        assert page["threads"] == [] and page["rejections"][0]["violation_path"] == path_name
    assert dec.decode_summary_page(_obs(path), {}, 9, 3)["rejections"][0]["violation_path"] == "cursor"


def test_an_unreadable_file_is_one_structured_rejection():
    result = dec.decode(_obs(pathlib.Path(tempfile.mkdtemp()) / "missing.json"), {})
    assert result["threads"] == [] and result["rejections"][0]["violation_path"] == "native_ref"
