# tools/conversations/test/python/test_source_agent_session_events.py
#
# Proves the `agent-session-events` source row (read_session_events.py): a JSON-lines session log of an AI coding
# assistant -> one thread of ordered atoms (utterance, thought, tool call, tool result, status, error) through the
# shared mapper, with atom identity that survives replays, edits and paging, a page read from the tail of the file,
# and human-origin marking only where the log's own `session_meta` says a person started the session. Every
# fixture is a synthetic log written to a temporary file.
import json
import pathlib
import tempfile

import support  # noqa: E402

dec = support.source("agent-session-events")


def _write(events, name="session.jsonl", final_newline=True):
    path = pathlib.Path(tempfile.mkdtemp()) / name
    path.write_text("\n".join(json.dumps(event) for event in events) + ("\n" if final_newline else ""),
                    encoding="utf-8")
    return path


def _obs(path, source_ref="source:test"):
    return {"source_ref": source_ref, "native_ref": str(path), "batch_ref": "batch:test",
            "observed_at": "2026-06-21T00:30:00Z"}


def test_ordered_open_atoms_for_utterance_thought_tool_status_and_error_shapes():
    path = _write([
        {"timestamp": "2026-06-21T00:00:00Z", "type": "user", "content": "hello"},
        {"timestamp": "2026-06-21T00:00:01Z",
         "message": {"role": "assistant", "content": [{"type": "thinking", "thinking": "checking"}]}},
        {"timestamp": "2026-06-21T00:00:02Z",
         "payload": {"type": "function_call", "name": "read_file", "arguments": '{"path":"a"}', "call_id": "call-1"}},
        {"timestamp": "2026-06-21T00:00:03Z",
         "payload": {"type": "function_call_output", "output": "done", "call_id": "call-1"}},
        {"timestamp": "2026-06-21T00:00:04Z", "type": "status", "status": "waiting"},
        {"timestamp": "2026-06-21T00:00:05Z", "type": "error", "error": {"message": "input rejected"}},
    ])
    decoded = dec.decode(_obs(path), {})
    assert [a["kind"] for a in decoded["atoms"]] == ["utterance", "thought", "tool-call", "tool-result", "status", "error"]
    assert decoded["threads"][0]["atom_count"] == 1                  # the sidebar counts what was said
    assert decoded["threads"][0]["presentation"]["subtitle"] == "hello"
    assert decoded["atoms"][2]["tool"] == {"name": "read_file", "input": {"path": "a"}, "call_ref": "call-1"}
    assert decoded["atoms"][3]["tool"] == {"call_ref": "call-1"}
    assert decoded["atoms"][4]["content"]["text"] == "waiting"
    assert decoded["atoms"][5]["content"]["text"] == "input rejected"
    for atom in decoded["atoms"]:
        assert atom["thread_ref"] == decoded["threads"][0]["thread_ref"]
        assert atom["source_ref"] == "source:test" and atom["observation_refs"] == ["batch:test"]
        assert atom["atom_ref"].startswith("atom:1f:") and len(atom["atom_ref"]) == 8 + 64
    assert len({a["atom_ref"] for a in decoded["atoms"]}) == 6


def test_content_blocks_become_one_atom_each_and_the_first_human_words_title_the_thread():
    path = _write([
        {"uuid": "u1", "message": {"role": "user", "content": [{"type": "text", "text": "<wrapped>machine</wrapped>"},
                                                              {"type": "text", "text": "Please fix the intake"}]}},
        {"uuid": "u2", "message": {"role": "assistant", "content": [
            {"type": "text", "text": "On it"},
            {"type": "tool_use", "name": "grep", "input": {"q": "intake"}, "id": "t1"},
            {"type": "tool_result", "tool_use_id": "t1", "content": [{"type": "text", "text": "3 hits"}]}]}},
    ])
    decoded = dec.decode(_obs(path), {})
    assert [(a["kind"], a["content"]["text"]) for a in decoded["atoms"]] == [
        ("utterance", "<wrapped>machine</wrapped>"), ("utterance", "Please fix the intake"),
        ("utterance", "On it"), ("tool-call", "grep"), ("tool-result", "3 hits")]
    assert decoded["threads"][0]["presentation"]["title"] == "Please fix the intake"   # wrapped text never titles
    assert decoded["threads"][0]["session_id"] == "session"
    assert decoded["atoms"][3]["tool"]["call_ref"] == "t1"


def test_a_session_is_titled_by_its_file_when_no_human_words_qualify():
    path = _write([{"type": "assistant", "content": "Hi"}], name="rollout-7.jsonl")
    thread = dec.decode(_obs(path), {})["threads"][0]
    assert thread["session_id"] == "rollout-7" and thread["presentation"]["title"] == "rollout-7"


def test_a_person_s_own_row_can_widen_the_wrapped_text_that_never_titles():
    row = dict(support.row("agent-session-events"), session_events={"title": {"skip_prefixes": ["<", "# Notes for "]}})
    path = _write([{"type": "user", "content": "# Notes for the assistant: be brief"},
                   {"type": "user", "content": "What is next?"}])
    thread = support.source("agent-session-events", row).decode(_obs(path), {})["threads"][0]
    assert thread["presentation"]["title"] == "What is next?"


def test_unknown_shapes_are_skipped_and_a_missing_file_is_one_structured_rejection():
    decoded = dec.decode(_obs(_write([{"type": "unknown", "payload": {"anything": True}}])), {})
    assert decoded["atoms"] == [] and decoded["threads"] == [] and decoded["rejections"] == []
    missing = dec.decode(_obs(pathlib.Path(tempfile.mkdtemp()) / "missing.jsonl"), {})
    assert missing["threads"] == [] and missing["rejections"][0]["violation_path"] == "native_ref"


def test_a_half_written_last_line_is_skipped():
    path = _write([{"type": "user", "content": "kept"}], final_newline=True)
    with open(path, "a", encoding="utf-8") as handle:
        handle.write('{"type": "assistant", "content": "cut off')
    assert [a["content"]["text"] for a in dec.decode(_obs(path), {})["atoms"]] == ["kept"]


def test_the_latest_page_reads_from_the_tail_with_an_opaque_older_cursor():
    path = _write([{"timestamp": f"2026-06-21T00:00:{n:02d}Z", "type": "user" if n % 2 == 0 else "assistant",
                    "content": f"line {n}"} for n in range(12)], final_newline=False)
    window = dec.decode_window(_obs(path), {"display_mark_ref": "mark:test"}, limit=5)
    assert [a["content"]["text"] for a in window["atoms"]] == [f"line {n}" for n in range(7, 12)]
    assert window["total_count"] is None and window["has_older"] and isinstance(window["older_cursor"], int)
    assert window["has_newer"] is False and window["mark_ref"] == "mark:test"
    assert window["started_at"] == "2026-06-21T00:00:07Z" and window["last_activity_at"] == "2026-06-21T00:00:11Z"


def test_pages_joined_are_the_whole_read_and_every_source_occurrence_is_kept():
    events = [{"type": "user", "message": {"role": "user", "content": "same-prefix-" * 10 + str(i)}} for i in range(8)]
    events.append({"type": "assistant", "message": {"role": "assistant",
                                                    "content": [{"type": "text", "text": str(i)} for i in range(5)]}})
    path = _write(events)
    observation = _obs(path, "synthetic")
    full = dec.decode(observation, {})["atoms"]
    cursor, pages = None, []
    while True:
        page = dec.decode_window(observation, {}, before_cursor=cursor, limit=2)
        pages = page["atoms"] + pages
        if not page["has_older"]:
            break
        cursor = page["older_cursor"]
    assert pages == full
    assert len({a["atom_ref"] for a in full}) == len(full)
    assert full[0]["content_revision"] != full[1]["content_revision"]


def test_the_five_blocks_of_one_event_are_never_split_across_two_pages():
    path = _write([{"type": "assistant", "message": {"role": "assistant",
                                                     "content": [{"type": "text", "text": f"b{i}"} for i in range(5)]}}])
    window = dec.decode_window(_obs(path), {}, limit=2)
    assert len(window["atoms"]) == 5 and window["has_older"] is False


def test_native_identity_survives_an_edit_beyond_any_prefix_and_a_replay():
    def decode(text, batch):
        path = _write([{"uuid": "source-event", "type": "user", "message": {"role": "user", "content": text}}])
        return dec.decode({**_obs(path), "batch_ref": batch}, {})["atoms"][0]
    before, after = decode("x" * 64 + "before", "batch:one"), decode("x" * 64 + "after", "batch:two")
    assert before["atom_ref"] == after["atom_ref"]
    assert before["content_revision"] != after["content_revision"]


def test_an_event_without_an_id_is_keyed_by_where_its_line_starts():
    events = [{"type": "user", "content": "first"}, {"type": "user", "content": "second"}]
    one = dec.decode(_obs(_write(events)), {})["atoms"]
    again = dec.decode(_obs(_write(events)), {})["atoms"]
    grown = dec.decode(_obs(_write(events + [{"type": "user", "content": "third"}])), {})["atoms"]
    assert [a["atom_ref"] for a in one] == [a["atom_ref"] for a in again] == [a["atom_ref"] for a in grown[:2]]
    assert len({a["atom_ref"] for a in grown}) == 3


def test_a_payload_message_user_event_keeps_source_identity_on_replay():
    event = {"type": "response_item", "timestamp": "2026-09-23T21:43:56.211Z",
             "payload": {"type": "message", "role": "user",
                         "content": [{"type": "input_text", "text": "Fix the intake route"}]}}
    first = dec.decode(_obs(_write([event])), {})["atoms"]
    replay = dec.decode({**_obs(_write([event])), "batch_ref": "batch:two"}, {})["atoms"]
    assert len(first) == 1 and first[0]["kind"] == "utterance"
    assert first[0]["speaker_ref"] == "speaker:source:test:user" and first[0]["content"]["text"] == "Fix the intake route"
    assert first[0]["atom_ref"] == replay[0]["atom_ref"]


def test_only_an_explicit_root_session_marks_a_user_message_as_human():
    message = {"type": "response_item", "payload": {"type": "message", "role": "user",
                                                    "content": [{"type": "input_text", "text": "Please fix this"}]}}
    for origin, metadata, expected in [
        ("root", {"thread_source": "user", "source": "editor"}, "human-root-session"),
        ("human fork", {"thread_source": "agent_forked_thread", "source": "editor", "forked_from_id": "parent"},
         "human-root-session"),
        ("ambiguous fork", {"thread_source": "user", "forked_from_id": "parent"}, None),
        ("child", {"thread_source": "subagent", "parent_thread_id": "parent"}, None),
        ("child fork", {"thread_source": "subagent", "forked_from_id": "parent"}, None),
        ("unknown", {}, None),
    ]:
        path = _write([{"type": "session_meta", "payload": metadata}, message])
        assert dec.decode(_obs(path), {})["atoms"][0].get("origin_ref") == expected, origin
