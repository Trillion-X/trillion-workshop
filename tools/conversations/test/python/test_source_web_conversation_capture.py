# tools/conversations/test/python/test_source_web_conversation_capture.py
#
# Proves the `web-conversation-capture` source row (read_web_capture.py): one captured page of a person's web AI
# conversations -> the canonical {threads, atoms, rejections} through the shared mapper. The page is atomic: a
# signed-out, expired, rate-limited, partial or inconsistent capture is ONE typed rejection with no rows and no cursor
# advance; ids and provider revisions are exact; a provider is named by the run, never by the reader. Fixtures are
# made-up captures written to temporary files.
import json
import pathlib
import tempfile

import support  # noqa: E402
import read_web_capture as reader  # noqa: E402

ROW = support.row("web-conversation-capture")


REV_A = "1f:" + "a" * 64
REV_B = "1f:" + "b" * 64
REV_C = "sha256:" + "c" * 64
DESC = {"source_ref": "source:chatgpt-web", "expected_provider": "chatgpt-web", "display_mark_ref": "mark:chatgpt"}


def snapshot(**overrides):
    value = {
        "kind": "authenticated-web-conversation-page",
        "provider": "chatgpt-web",
        "revision": REV_A,
        "capture_binding": {
            "captured_by": "capture:fixture",
            "surface": "surface:fixture",
            "authorization": "grant:fixture",
        },
        "capture_state": {"status": "active"},
        "complete": True,
        "page": {"request_cursor": None, "next_cursor": "provider-page-2", "has_more": True},
        "conversations": [{
            "id": "conversation:one",
            "revision": REV_B,
            "title": "Fixture conversation",
            "updated_at": "2026-09-15T10:01:00Z",
            "deleted": False,
            "total_message_count": 2,
            "message_page": {"request_cursor": None, "next_cursor": None, "has_more": False},
            "messages": [
                {"id": "message:user:1", "revision": REV_A, "position": 0,
                 "role": "user", "text": "hello", "created_at": "2026-09-15T10:00:00Z"},
                {"id": "message:assistant:1", "revision": REV_B, "position": 1,
                 "role": "assistant", "text": "hi", "created_at": "2026-09-15T10:01:00Z"},
            ],
        }],
    }
    value.update(overrides)
    return value


def run(value, descriptor=DESC, cursor=None, limit=50, category_key="threads"):
    with tempfile.TemporaryDirectory() as directory:
        path = pathlib.Path(directory) / "snapshot.json"
        path.write_text(json.dumps(value), encoding="utf-8")
        return reader.decode({
            "source_ref": "source:chatgpt-web",
            "native_ref": str(path),
            "batch_ref": "batch:fixture",
            "observed_at": "2026-09-15T11:00:00Z",
        }, ROW, descriptor, request_cursor=cursor, limit=limit, category_key=category_key)


def reason(result):
    return result["rejections"][0]["reason_ref"]


def test_normalizes_exact_ids_revisions_pagination_and_dedupe_identity():
    first = run(snapshot())
    assert first["rejections"] == []
    assert first["next_cursor"] == "provider-page-2" and first["has_more"] is True
    assert first["snapshot_revision"] == REV_A
    assert first["threads"][0]["session_id"] == "conversation:one"
    assert first["threads"][0]["source_content_revision"] == REV_B
    assert first["threads"][0]["message_page"]["has_more"] is False
    atoms = first["atoms"]
    assert [atom["native_ref"] for atom in atoms] == ["message:user:1", "message:assistant:1"]
    assert [atom["source_content_revision"] for atom in atoms] == [REV_A, REV_B]
    assert atoms[0]["source_locator"] == [atoms[0]["thread_ref"], ["native", "message:user:1"]]

    changed = snapshot()
    changed["conversations"][0]["messages"][0].update({
        "revision": REV_C, "text": "hello edited", "edited_at": "2026-09-15T10:02:00Z",
    })
    second = run(changed)
    assert second["atoms"][0]["atom_ref"] == atoms[0]["atom_ref"]
    assert second["atoms"][0]["content_revision"] != atoms[0]["content_revision"]
    assert second["atoms"][0]["source_content_revision"] == REV_C
    assert second["atoms"][0]["state_events"][0]["key"] == "edited"


def test_deleted_message_and_conversation_remain_visible_as_retractions():
    value = snapshot()
    conversation = value["conversations"][0]
    conversation["deleted"] = True
    conversation["messages"][1].update({"deleted": True, "text": None,
                                         "deleted_at": "2026-09-15T10:03:00Z"})
    out = run(value)
    deleted = next(atom for atom in out["atoms"] if atom["native_ref"] == "message:assistant:1")
    assert deleted["content"]["text"] is None
    assert deleted["state_events"][0]["key"] == "retracted"
    assert out["threads"][0]["state_events"][0]["key"] == "retracted"


def test_empty_deleted_conversation_emits_a_lifecycle_tombstone():
    value = snapshot()
    conversation = value["conversations"][0]
    conversation.update({"deleted": True, "messages": [], "total_message_count": 0})
    out = run(value)
    assert out["rejections"] == [] and len(out["threads"]) == 1 and len(out["atoms"]) == 1
    assert out["atoms"][0]["native_ref"] == "conversation-deletion:conversation:one"
    assert out["atoms"][0]["state_events"][0]["key"] == "retracted"


def test_partial_capture_is_atomic_and_preserves_retry_cursor_without_advancing():
    value = snapshot(complete=False, retry_cursor="retry:page:1")
    out = run(value)
    assert out["threads"] == [] and out["atoms"] == [] and out["next_cursor"] is None
    assert reason(out) == "reason:web-conversation-partial-capture"
    assert out["rejections"][0]["retry_cursor"] == "retry:page:1"


def test_logout_expiry_and_rate_limit_are_typed_failures():
    for status, expected in [
        ("logged_out", "reason:web-conversation-logged-out"),
        ("session_expired", "reason:web-conversation-session-expired"),
        ("rate_limited", "reason:web-conversation-rate-limited"),
    ]:
        state = {"status": status}
        if status == "rate_limited":
            state["retry_after"] = "2026-09-15T12:00:00Z"
        out = run(snapshot(capture_state=state))
        assert reason(out) == expected
        assert out["threads"] == [] and out["next_cursor"] is None


def test_provider_cursor_and_binding_mismatches_fail_closed():
    assert reason(run(snapshot(provider="gemini-web"))) == "reason:web-conversation-provider-mismatch"
    assert reason(run(snapshot(), cursor="forged-skip")) == "reason:web-conversation-cursor-mismatch"
    value = snapshot(capture_binding={})
    assert reason(run(value)) == "reason:invalid-web-conversation-snapshot"


def test_duplicate_ids_positions_and_over_limit_refuse_whole_page():
    value = snapshot()
    value["conversations"][0]["messages"].append(dict(value["conversations"][0]["messages"][0]))
    assert reason(run(value)) == "reason:duplicate-web-message-id"
    value = snapshot()
    value["conversations"][0]["messages"][1]["position"] = 0
    assert reason(run(value)) == "reason:duplicate-web-message-position"
    value = snapshot()
    value["conversations"].append({**value["conversations"][0], "id": "conversation:two"})
    assert reason(run(value, limit=1)) == "reason:web-conversation-page-over-limit"


def test_page_cursor_consistency_and_canonical_revisions_are_required():
    value = snapshot(page={"request_cursor": None, "next_cursor": None, "has_more": True})
    assert reason(run(value)) == "reason:invalid-web-conversation-snapshot"
    value = snapshot(revision="ABC")
    assert reason(run(value)) == "reason:invalid-web-conversation-snapshot"


def test_gemini_uses_the_same_contract_without_provider_specific_branching():
    value = snapshot(provider="gemini-web")
    out = run(value, descriptor={"source_ref": "source:chatgpt-web", "expected_provider": "gemini-web", "display_mark_ref": "mark:gemini"})
    assert out["rejections"] == []
    assert out["threads"][0]["presentation"]["mark_ref"] == "mark:gemini"


def test_descriptor_data_can_name_a_new_provider_without_decoder_code_change():
    value = snapshot(provider="future-conversation-service")
    out = run(value, descriptor={"source_ref": "source:chatgpt-web",
                                 "expected_provider": "future-conversation-service",
                                 "display_mark_ref": "mark:future"})
    assert out["rejections"] == []


def test_nested_message_page_is_callable_through_the_existing_opaque_cursor():
    value = snapshot()
    value["conversations"][0]["message_page"] = {
        "request_cursor": None, "next_cursor": "older-provider-page", "has_more": True,
    }
    listed = run(value)
    current = listed["threads"][0]["message_page"]["current_cursor"]
    next_cursor = listed["threads"][0]["message_page"]["next_cursor"]
    current_page = run(value, cursor=current, category_key="messages")
    assert [atom["native_ref"] for atom in current_page["atoms"]] == [
        "message:user:1", "message:assistant:1",
    ]
    assert current_page["next_cursor"] == next_cursor and current_page["has_more"] is True

    older = snapshot()
    older["conversations"][0]["message_page"] = {
        "request_cursor": "older-provider-page", "next_cursor": None, "has_more": False,
    }
    older_page = run(older, cursor=next_cursor, category_key="messages")
    assert older_page["rejections"] == [] and older_page["next_cursor"] is None


def test_a_request_with_two_captured_files_is_refused_whole():
    with tempfile.TemporaryDirectory() as directory:
        directory = pathlib.Path(directory)
        good_path, bad_path = directory / "good.json", directory / "bad.json"
        good_path.write_text(json.dumps(snapshot()), encoding="utf-8")
        bad_path.write_text(json.dumps(snapshot(provider="gemini-web")), encoding="utf-8")
        out = reader.decode_request({
            "descriptor": DESC, "limit": 50,
            "batch": {"accepted": [
                {"source_ref": "source:chatgpt-web", "native_ref": str(good_path), "batch_ref": "b"},
                {"source_ref": "source:chatgpt-web", "native_ref": str(bad_path), "batch_ref": "b"},
            ]},
        }, ROW)
        assert out["threads"] == [] and out["atoms"] == [] and out["next_cursor"] is None
        assert out["rejections"][0]["reason_ref"] == "reason:web-conversation-snapshot-count"
        assert out["snapshot_revision"] is None


def test_a_request_with_one_captured_file_gives_the_page_and_its_revision():
    with tempfile.TemporaryDirectory() as directory:
        path = pathlib.Path(directory) / "good.json"
        path.write_text(json.dumps(snapshot()), encoding="utf-8")
        out = reader.decode_request({"descriptor": DESC, "observation": {
            "source_ref": "source:chatgpt-web", "native_ref": str(path), "batch_ref": "b"}}, ROW)
        assert out["rejections"] == [] and len(out["atoms"]) == 2
        assert out["snapshot_revision"] == REV_A and out["has_more"] is True


def test_a_capture_that_cannot_say_where_it_came_from_is_refused():
    for missing in ("captured_by", "surface", "authorization"):
        value = snapshot()
        del value["capture_binding"][missing]
        assert reason(run(value)) == "reason:invalid-web-conversation-snapshot", missing


def test_the_binding_a_row_asks_for_is_the_rows_to_change():
    import copy
    row = copy.deepcopy(ROW)
    row["web_capture"]["binding_fields"] = ["captured_by"]
    value = snapshot(capture_binding={"captured_by": "capture:fixture"})
    with tempfile.TemporaryDirectory() as directory:
        path = pathlib.Path(directory) / "snapshot.json"
        path.write_text(json.dumps(value), encoding="utf-8")
        out = reader.decode({"source_ref": "source:chatgpt-web", "native_ref": str(path), "batch_ref": "b"},
                            row, DESC)
    assert out["rejections"] == [] and len(out["atoms"]) == 2


def test_output_size_is_bounded_below_the_workflow_response_ceiling():
    value = snapshot()
    value["conversations"][0]["messages"][0]["text"] = "x" * (reader.MAX_OUTPUT_BYTES + 1)
    out = run(value)
    assert reason(out) == "reason:web-conversation-output-too-large"
    assert out["atoms"] == [] and out["next_cursor"] is None
