# tools/conversations/test/python/test_decode_source.py
#
# Proves the command the tool row runs (read-data/decode_source.py) the way the engine runs it: the granted folder in
# argv, one JSON request on standard input, the answer on the last line as {"result"} or {"error"}. Every export is a
# made-up one in a temporary folder.
import json
import os
import pathlib
import subprocess
import sys
import tempfile

import support  # noqa: E402

SCRIPT = support.READ_DATA / "decode_source.py"

SLACK = {"self_id": "U1", "channels": [
    {"id": "C1", "name": "bakery-orders", "messages": [
        {"ts": "1700000000.000100", "user": "U1", "text": "Fresh rye is up"},
        {"ts": "1700000060.000200", "user": "U2", "user_profile": {"real_name": "Rosa"}, "text": "Two loaves please"},
        {"ts": "1700000120.000300", "user": "U2", "text": ""},
    ]},
    {"id": "C2", "name": "deliveries", "messages": [
        {"ts": "1700000200.000100", "user": "U2", "user_profile": {"real_name": "Rosa"}, "text": "On my way"}]},
]}


def _folder(files):
    root = pathlib.Path(tempfile.mkdtemp())
    for name, content in files.items():
        path = root / name
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(content if isinstance(content, str) else json.dumps(content), encoding="utf-8")
    return root


def _run(folder, request, *extra):
    ran = subprocess.run([sys.executable, "-B", str(SCRIPT), str(folder), *extra], input=json.dumps(request),
                         capture_output=True, text=True)
    return ran.returncode, json.loads(ran.stdout.strip().splitlines()[-1])


def test_an_export_is_matched_to_its_row_and_answered_as_threads_atoms_and_conversations():
    status, answer = _run(_folder({"export/slack.json": SLACK}), {"file": "export/slack.json"})
    assert status == 0
    result = answer["result"]
    assert result["source"] == "slack-messages" and result["mode"] == "all"
    assert [t["session_id"] for t in result["threads"]] == ["C1", "C2"]
    assert result["total_atoms"] == 3 and result["next_cursor"] is None and result["rejections"] == []
    assert result["conversations"] == [
        {"conversation_id": "thread:source:slack-messages:C1", "title": "bakery-orders", "app": "Slack", "messages": [
            {"id": result["atoms"][0]["atom_ref"], "speaker": "person", "text": "Fresh rye is up",
             "at": "2023-11-14T22:13:20.000100Z"},
            {"id": result["atoms"][1]["atom_ref"], "speaker": "Rosa", "text": "Two loaves please",
             "at": "2023-11-14T22:14:20.000200Z"}]},
        {"conversation_id": "thread:source:slack-messages:C2", "title": "deliveries", "app": "Slack", "messages": [
            {"id": result["atoms"][2]["atom_ref"], "speaker": "Rosa", "text": "On my way",
             "at": "2023-11-14T22:16:40.000100Z"}]},
    ]


def test_the_run_names_its_source_and_the_app_the_conversations_are_kept_under():
    status, answer = _run(_folder({"s.json": SLACK}), {
        "file": "s.json", "source": "slack-messages", "descriptor": {"source_ref": "source:bakery-team", "app": "Team chat"}})
    result = answer["result"]
    assert status == 0 and result["source_ref"] == "source:bakery-team"
    assert result["threads"][0]["thread_ref"] == "thread:source:bakery-team:C1"
    assert result["conversations"][0]["app"] == "Team chat"
    assert result["conversations"][0]["conversation_id"] == "thread:source:bakery-team:C1"


def test_a_large_export_comes_a_page_of_atoms_at_a_time():
    status, first = _run(_folder({"s.json": SLACK}), {"file": "s.json", "limit": 2})
    result = first["result"]
    assert status == 0 and len(result["atoms"]) == 2 and result["next_cursor"] == 2 and result["total_atoms"] == 3
    assert [t["session_id"] for t in result["threads"]] == ["C1"]          # only the threads the page touches
    folder = _folder({"s.json": SLACK})
    _, second = _run(folder, {"file": "s.json", "limit": 2, "cursor": 2})
    assert len(second["result"]["atoms"]) == 1 and second["result"]["next_cursor"] is None
    assert [t["session_id"] for t in second["result"]["threads"]] == ["C2"]


def test_the_thread_list_is_a_page_of_threads_newest_first_without_their_atoms():
    status, answer = _run(_folder({"s.json": SLACK}), {"file": "s.json", "mode": "threads", "limit": 1})
    result = answer["result"]
    assert status == 0 and [t["session_id"] for t in result["threads"]] == ["C2"]
    assert result["total_threads"] == 2 and result["next_cursor"] == 1 and "atoms" not in result


def test_one_thread_of_a_log_is_read_newest_first_from_the_tail():
    log = "".join(json.dumps({"type": "user" if n % 2 == 0 else "assistant", "content": f"line {n}"}) + "\n"
                  for n in range(10))
    folder = _folder({"logs/session-1.jsonl": log})
    status, answer = _run(folder, {"file": "logs/session-1.jsonl", "mode": "page", "limit": 4, "source": "agent-session-events"})
    result = answer["result"]
    assert status == 0 and [a["content"]["text"] for a in result["atoms"]] == [f"line {n}" for n in range(6, 10)]
    assert result["next_cursor"] is not None and result["window"]["has_older"] is True
    assert [(m["speaker"], m["text"]) for m in result["conversations"][0]["messages"]] == [
        ("person", "line 6"), ("ai", "line 7"), ("person", "line 8"), ("ai", "line 9")]
    _, older = _run(folder, {"file": "logs/session-1.jsonl", "mode": "page", "limit": 4,
                            "source": "agent-session-events", "before_cursor": result["next_cursor"]})
    assert [a["content"]["text"] for a in older["result"]["atoms"]] == [f"line {n}" for n in range(2, 6)]


def test_a_path_that_leaves_the_granted_folder_is_refused_whether_by_dots_or_by_a_link():
    outside = _folder({"secret.json": SLACK})
    folder = _folder({"inner/export.json": SLACK})
    status, answer = _run(folder, {"file": "../" + outside.name + "/secret.json", "source": "slack-messages"})
    assert status == 2 and "outside the folder you granted" in answer["error"]
    os.symlink(outside / "secret.json", folder / "inner" / "link.json")
    status, answer = _run(folder, {"file": "inner/link.json", "source": "slack-messages"})
    assert status == 2 and "outside the folder you granted" in answer["error"]
    status, answer = _run(folder, {"file": str(outside / "secret.json"), "source": "slack-messages"})
    assert status == 2 and "outside the folder you granted" in answer["error"]
    status, answer = _run(folder, {"file": "inner/missing.json", "source": "slack-messages"})
    assert status == 2 and "is not in the folder you granted" in answer["error"]


def test_a_file_several_rows_could_read_is_refused_with_their_ids_and_an_unknown_source_is_named():
    both = {"threads": [{"id": 1, "messages": [{"message_id": 1, "date": 1, "timestamp": 1, "body": "x", "text": "x"}]}]}
    folder = _folder({"both.json": both, "nothing.json": {"unrelated": 1}})
    status, answer = _run(folder, {"file": "both.json"})
    assert status == 2 and "telegram-messages" in answer["error"] and "signal-messages" in answer["error"]
    status, answer = _run(folder, {"file": "both.json", "source": "signal-messages"})
    assert status == 0 and answer["result"]["source"] == "signal-messages"
    status, answer = _run(folder, {"file": "nothing.json"})
    assert status == 2 and "No source reads this file" in answer["error"]
    status, answer = _run(folder, {"file": "both.json", "source": "no-such-source"})
    assert status == 2 and "not a known source" in answer["error"]


def test_a_bad_request_says_what_to_do():
    folder = _folder({"s.json": SLACK})
    for request, words in (({}, "file is required"), ({"file": "s.json", "mode": "all-of-it"}, "mode is one of"),
                           ({"file": "s.json", "limit": 0}, "limit is a whole number"),
                           ({"file": "s.json", "cursor": -1}, "cursor is a whole number"),
                           ({"file": "s.json", "descriptor": "x"}, "descriptor is an object"),
                           ([], "one JSON object")):
        status, answer = _run(folder, request)
        assert status == 2 and words in answer["error"], (request, answer)
    ran = subprocess.run([sys.executable, "-B", str(SCRIPT)], input="{}", capture_output=True, text=True)
    assert ran.returncode == 2 and "needs the folder you granted" in json.loads(ran.stdout)["error"]


def test_a_person_s_own_rows_read_an_export_no_built_in_row_does():
    mine = {"sources": [{
        "id": "bakery-orders-export", "label": "Orders export", "reader": "fields", "unreadable_expected": "orders JSON",
        "file": {"format": "json"}, "input_shape": {"media_types": ["application/json"], "required_paths": [["orders"]]},
        "recording": {"app": "Orders"},
        "shape": {"threads": {"per_item": {"path": ["orders"]}},
                  "thread": {"id": {"path": ["order_id"]}, "title": {"path": ["customer"]}},
                  "message": {"speaker": {"path": ["customer"]}, "text": {"path": ["note"]},
                              "at": {"path": ["placed"], "ops": [{"op": "time", "from": "iso"}]},
                              "native_ref": {"path": ["order_id"]}}}}]}
    export = {"orders": [{"order_id": "o-1", "customer": "Rosa", "note": "No seeds", "placed": "2026-01-02T08:00:00Z"},
                         {"order_id": "o-2", "customer": "Ali", "note": "", "placed": "2026-01-02T09:00:00Z"}]}
    folder = _folder({"orders.json": export, "my-rows.json": mine})
    status, answer = _run(folder, {"file": "orders.json", "sources_file": "my-rows.json"})
    result = answer["result"]
    assert status == 0 and result["source"] == "bakery-orders-export"
    assert [(t["session_id"], t["presentation"]["title"]) for t in result["threads"]] == [("o-1", "Rosa")]
    assert result["conversations"][0]["app"] == "Orders"
    assert result["conversations"][0]["messages"] == [
        {"id": "o-1", "speaker": "Rosa", "text": "No seeds", "at": "2026-01-02T08:00:00Z"}]
    status, answer = _run(folder, {"file": "orders.json", "sources_file": "orders.json"})
    assert status == 2 and "sources_file holds" in answer["error"]


def test_an_extra_table_of_the_tool_s_own_adds_rows_without_touching_the_built_in_ones():
    table = _folder({"table.json": {"sources": [{
        "id": "slack-messages", "label": "Replaced", "reader": "fields", "unreadable_expected": "x",
        "file": {"format": "json"}, "shape": {"root_list_key": "channels", "threads": {"list": {"path": ["channels"]}, "messages": {"path": ["nope"]}},
                                             "thread": {"id": {"path": ["id"]}}, "message": {"speaker": {"const": "x"}, "text": {"path": ["t"]}}}}]}})
    folder = _folder({"s.json": SLACK})
    status, answer = _run(folder, {"file": "s.json", "source": "slack-messages"}, "--sources", str(table / "table.json"))
    assert status == 0 and answer["result"]["atoms"] == []                  # the later table replaced the row
    status, answer = _run(folder, {"file": "s.json", "source": "slack-messages"})
    assert len(answer["result"]["atoms"]) == 3


def test_a_mail_export_needs_the_person_s_address_to_say_which_words_are_theirs():
    page = {"historyId": "h9", "messages": [{
        "id": "m1", "threadId": "t1", "internalDate": "1700000000000", "labelIds": [],
        "payload": {"headers": [{"name": "From", "value": "me@example.com"}, {"name": "To", "value": "rosa@example.com"},
                                {"name": "Subject", "value": "Order"}],
                    "parts": [{"mimeType": "text/plain", "body": {"data": "SGVsbG8"}}]}}]}
    folder = _folder({"mail.json": page})
    status, answer = _run(folder, {"file": "mail.json", "descriptor": {"mailbox_address": "me@example.com"}})
    result = answer["result"]
    assert status == 0 and result["source"] == "gmail-page" and result["source_next_cursor"] == "h9"
    assert result["conversations"][0]["messages"][0]["speaker"] == "person"
    assert result["conversations"][0]["messages"][0]["text"] == "Hello"
