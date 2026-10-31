# tools/conversations/test/python/test_choose_source.py
#
# Proves choose_source.py: a file is matched to the row that reads it by what it looks like (name, media type, the
# paths it holds, the tables of a database), a file several rows could read matches them all so the caller must name
# one, a file nothing reads matches none, and a person's own row is chosen from the same way.
import json
import pathlib
import sqlite3
import tempfile

import support  # noqa: E402

import choose_source  # noqa: E402

ROWS = support.SOURCES


def _file(name, content):
    path = pathlib.Path(tempfile.mkdtemp()) / name
    path.write_text(content if isinstance(content, str) else json.dumps(content), encoding="utf-8")
    return path


def _choose(path, rows=None):
    return choose_source.choose(rows or ROWS, path)


def test_each_chat_export_is_matched_to_its_own_row():
    cases = {
        "discord-messages": {"threads": [{"id": "1", "messages": [{"id": "9", "content": "hi", "author": {"id": "5"}}]}]},
        "slack-messages": {"channels": [{"id": "C1", "messages": [{"ts": "1700000000.000100", "text": "hi"}]}]},
        "telegram-messages": {"threads": [{"id": 1, "messages": [{"message_id": 1, "date": 1700000000, "text": "hi"}]}]},
        "signal-messages": {"threads": [{"id": "t", "messages": [{"timestamp": 1700000000000, "body": "hi"}]}]},
        "instagram-direct-messages": {"threads": [{"id": "t", "messages": [{"user_id": "1", "text": "hi"}]}]},
        "whatsapp-messages": {"messages": [{"key": {"remoteJid": "1@s.whatsapp.net"}, "message": {"conversation": "hi"}}]},
        "gmail-page": {"messages": [{"id": "m", "payload": {"headers": [{"name": "From", "value": "a@b.c"}]}}]},
        "web-conversation-capture": {"capture_binding": {}, "conversations": []},
    }
    for source_id, content in cases.items():
        assert _choose(_file("export.json", content)) == [source_id], source_id


def test_a_file_name_and_its_lines_choose_between_the_two_json_lines_shapes():
    lines = "\n".join(json.dumps(line) for line in ({"role": "user", "content": "hi"},))
    assert _choose(_file("a.jsonl", lines)) == ["agent-session-lines"]
    events = "\n".join(json.dumps(line) for line in ({"type": "user", "payload": {"x": 1}},))
    assert _choose(_file("b.jsonl", events)) == ["agent-session-events"]
    assert _choose(_file("c.json", [{"sessionId": "s", "type": "user", "message": "hi"}])) == ["gemini-cli-logs"]


def test_a_message_file_is_matched_by_its_extension_alone():
    assert _choose(_file("note.eml", "From: a@b.c\r\n\r\nhi")) == ["mail-message"]


def test_a_database_is_matched_by_its_tables():
    path = pathlib.Path(tempfile.mkdtemp()) / "chat.db"
    connection = sqlite3.connect(path)
    connection.executescript("CREATE TABLE chat(a); CREATE TABLE message(a); CREATE TABLE handle(a); "
                             "CREATE TABLE chat_message_join(a);")
    connection.close()
    assert _choose(path) == ["imessage-database"]
    other = pathlib.Path(tempfile.mkdtemp()) / "other.db"
    sqlite3.connect(other).close()
    assert _choose(other) == []


def test_a_file_several_rows_could_read_matches_them_all():
    both = {"threads": [{"id": 1, "messages": [{"message_id": 1, "date": 1, "timestamp": 1, "body": "x", "text": "x"}]}]}
    assert _choose(_file("export.json", both)) == ["telegram-messages", "signal-messages"]


def test_a_file_nothing_reads_matches_nothing():
    assert _choose(_file("export.json", {"unrelated": [1, 2, 3]})) == []
    assert _choose(_file("export.json", "not json at all")) == []
    assert _choose(pathlib.Path(tempfile.mkdtemp()) / "missing.json") == []


def test_a_person_s_own_row_is_chosen_from_the_same_way():
    mine = {"id": "my-notes", "input_shape": {"media_types": ["application/json"], "required_paths": [["my_notes"]]}}
    assert _choose(_file("export.json", {"my_notes": []}), ROWS + [mine]) == ["my-notes"]
    assert _choose(_file("export.json", {"threads": []}), [mine]) == []
    assert _choose(_file("export.json", {"my_notes": []}), [{"id": "no-shape"}]) == []
