# tools/conversations/test/python/test_recording_messages.py
#
# Proves for_recording.py: decoded threads and atoms become conversations in the shape the person's message-keeping
# owner takes a chat read off its own page ({conversation_id, title, app, messages: [{id, speaker, text, at}]}). Only
# what was SAID is a message; the person's own words are "person", an assistant's "ai", anyone else's their own name;
# a time is never invented; and a message keeps the id of its place in its source, so bringing the export in again adds
# nothing twice.
import support  # noqa: E402,F401  (read-data on the import path)

import for_recording  # noqa: E402
import transcript_mapper as tm  # noqa: E402

OBS = {"source_ref": "source:test", "native_ref": "/x", "batch_ref": "batch:test", "observed_at": "2026-01-01T00:00:00Z"}


def _recorded(specs, row, descriptor=None):
    mapped = tm.map_transcript(OBS, descriptor or {}, specs)
    return for_recording.conversations_for_recording(mapped["threads"], mapped["atoms"], row, descriptor), mapped


def test_the_person_the_assistant_and_anyone_else_are_said_in_the_owner_s_words():
    row = {"label": "Agent logs", "recording": {"app": "AI session", "person_speakers": ["user"], "ai_speakers": ["assistant"]}}
    conversations, _ = _recorded([{"session_id": "s", "title": "A chat", "messages": [
        {"index": 0, "speaker": "user", "text": "hi", "at": "2026-01-01T10:00:00Z", "native_ref": "m1"},
        {"index": 1, "speaker": "assistant", "text": "hello", "at": "2026-01-01T10:00:05Z", "native_ref": "m2"},
        {"index": 2, "speaker": "me", "text": "thanks", "native_ref": "m3"},
        {"index": 3, "speaker": "Rosa", "text": "welcome", "native_ref": "m4"}]}], row)
    assert conversations == [{"conversation_id": "thread:source:test:s", "title": "A chat", "app": "AI session", "messages": [
        {"id": "m1", "speaker": "person", "text": "hi", "at": "2026-01-01T10:00:00Z"},
        {"id": "m2", "speaker": "ai", "text": "hello", "at": "2026-01-01T10:00:05Z"},
        {"id": "m3", "speaker": "person", "text": "thanks"},
        {"id": "m4", "speaker": "Rosa", "text": "welcome"}]}]


def test_only_what_was_said_is_a_message_and_a_time_is_never_invented():
    row = {"label": "Log", "recording": {"person_speakers": ["user"], "ai_speakers": ["assistant"]}}
    conversations, mapped = _recorded([{"session_id": "s", "messages": [
        {"index": 0, "speaker": "user", "text": "run it", "native_ref": "u"},
        {"index": 1, "speaker": "assistant", "kind": "tool-call", "text": "shell", "native_ref": "t",
         "tool": {"name": "shell"}},
        {"index": 2, "speaker": "assistant", "kind": "thought", "text": "hmm", "native_ref": "h"},
        {"index": 3, "speaker": "system", "kind": "status", "text": "waiting", "native_ref": "st"},
        {"index": 4, "speaker": "Rosa", "kind": "reaction", "text": None, "reaction_symbol": "like", "native_ref": "r",
         "relations": [{"role": "reaction_target", "target_native_ref": "u"}]},
        {"index": 5, "speaker": "assistant", "text": "done", "native_ref": "d"}]}], row)
    assert len(mapped["atoms"]) == 6
    assert [(m["id"], m["speaker"]) for m in conversations[0]["messages"]] == [("u", "person"), ("d", "ai")]
    assert all("at" not in m for m in conversations[0]["messages"])


def test_the_app_is_the_runs_choice_then_the_rows_then_its_label():
    spec = [{"session_id": "s", "messages": [{"index": 0, "speaker": "me", "text": "x", "native_ref": "m"}]}]
    assert _recorded(spec, {"label": "Label", "recording": {"app": "Row app"}}, {"app": "Mine"})[0][0]["app"] == "Mine"
    assert _recorded(spec, {"label": "Label", "recording": {"app": "Row app"}})[0][0]["app"] == "Row app"
    assert _recorded(spec, {"label": "Label"})[0][0]["app"] == "Label"


def test_a_message_without_a_source_id_is_known_by_its_atom_and_a_thread_with_nothing_said_is_left_out():
    row = {"label": "Log"}
    conversations, mapped = _recorded([
        {"session_id": "a", "messages": [{"index": 0, "speaker": "me", "text": "hello"}]},
        {"session_id": "b", "messages": [{"index": 0, "speaker": "me", "kind": "reaction", "text": None,
                                          "reaction_symbol": "like", "native_ref": "r"}]}], row)
    assert [c["conversation_id"] for c in conversations] == ["thread:source:test:a"]
    assert conversations[0]["messages"][0]["id"] == mapped["atoms"][0]["atom_ref"]
    again, _ = _recorded([{"session_id": "a", "messages": [{"index": 0, "speaker": "me", "text": "hello"}]}], row)
    assert again[0]["messages"][0]["id"] == conversations[0]["messages"][0]["id"]


def test_a_speaker_name_with_colons_is_kept_whole():
    conversations, _ = _recorded([{"session_id": "s", "messages": [
        {"index": 0, "speaker": "team:ops", "text": "deploying", "native_ref": "m"}]}], {"label": "Log"})
    assert conversations[0]["messages"][0]["speaker"] == "team:ops"
