# tools/conversations/test/python/test_source_gmail_page.py
#
# Proves the `gmail-page` source row (read_mail.py, wire `mime-part-tree`) over the shared mapper: a page of message
# resources -> the canonical {threads, atoms, rejections} plus the page's own cursor, with a fail-closed send_ref,
# opaque label facts, HTML-only body projection, attachment references (never bytes), a structured rejection for a
# service error page, and cursor emission. Fixture pages are inline dicts: no mail service, no token.
import base64
import json
import os
import tempfile

import support  # noqa: E402

dec = support.source("gmail-page")

ME = "me@example.com"
DESC = {"mailbox_address": ME}


def _b64(text):
    return base64.urlsafe_b64encode(text.encode("utf-8")).decode("ascii")


def _msg(mid, thread_id, sender, to, subject, body_text=None, body_html=None,
         internal_ms=1_700_000_000_000, labels=None, attachments=None, cc=None):
    parts = []
    if body_text is not None:
        parts.append({"mimeType": "text/plain", "body": {"data": _b64(body_text)}})
    if body_html is not None:
        parts.append({"mimeType": "text/html", "body": {"data": _b64(body_html)}})
    for a in attachments or []:
        parts.append({"mimeType": a.get("mime", "application/pdf"), "filename": a["filename"],
                      "body": {"attachmentId": a["fetch_ref"], "size": a.get("size", 10)}})
    headers = [{"name": "From", "value": sender}, {"name": "To", "value": to}, {"name": "Subject", "value": subject}]
    if cc:
        headers.append({"name": "Cc", "value": cc})
    return {"id": mid, "threadId": thread_id, "internalDate": str(internal_ms), "labelIds": labels or [],
            "payload": {"mimeType": "multipart/mixed", "headers": headers, "parts": parts}}


def _obs(page):
    path = os.path.join(tempfile.mkdtemp(), "page.json")
    with open(path, "w", encoding="utf-8") as f:
        json.dump(page, f)
    return {"source_ref": "source:mail", "native_ref": path, "batch_ref": "batch:test",
            "observed_at": "2026-07-18T00:00:00Z"}


def test_basic_thread_atoms_and_send_ref():
    page = {"historyId": "h123", "messages": [
        _msg("m1", "t1", "Alice <alice@x.com>", f"Me <{ME}>", "Hello", body_text="hey there",
             internal_ms=1_700_000_000_000, labels=["INBOX", "user-made-label"]),
        _msg("m2", "t1", f"Me <{ME}>", "alice@x.com", "Re: Hello", body_text="hey alice",
             internal_ms=1_700_000_060_000),
    ]}
    result = dec.decode(_obs(page), DESC)
    assert result["rejections"] == []
    assert result["next_cursor"] == "h123"
    assert len(result["threads"]) == 1
    thread = result["threads"][0]
    assert thread["session_id"] == "t1"
    assert thread["send_ref"] == "alice@x.com"          # single counterparty
    assert thread["presentation"]["title"] == "Hello"
    assert thread["atom_count"] == 2
    atoms = result["atoms"]
    assert [a["content"]["text"] for a in atoms] == ["hey there", "hey alice"]
    assert atoms[0]["speaker_ref"].endswith(":alice@x.com")
    assert atoms[1]["speaker_ref"].endswith(":me")
    assert atoms[0]["native_ref"] == "m1"
    # label facts are opaque self-describing state-events, never an enum
    assert {e["key"] for e in atoms[0]["state_events"]} == {"label:INBOX", "label:user-made-label"}


def test_group_thread_has_no_send_ref():
    page = {"messages": [_msg("m1", "t2", "alice@x.com", f"{ME}, bob@y.com", "Group", body_text="hi all")]}
    assert "send_ref" not in dec.decode(_obs(page), DESC)["threads"][0]      # fails closed


def test_html_only_body_is_projected_to_text():
    page = {"messages": [_msg("m1", "t3", "alice@x.com", ME, "Newsletter",
                              body_html="<style>p{}</style><div>Hello <b>world</b><br>line two</div>")]}
    text = dec.decode(_obs(page), DESC)["atoms"][0]["content"]["text"]
    assert "Hello world" in text and "line two" in text and "<" not in text


def test_attachments_become_relations_never_bytes():
    page = {"messages": [_msg("m1", "t4", "alice@x.com", ME, "Docs", body_text="see attached",
                              attachments=[{"filename": "deck.pdf", "mime": "application/pdf",
                                            "fetch_ref": "att-1", "size": 12345}])]}
    assert dec.decode(_obs(page), DESC)["atoms"][0]["relations"] == [{"role": "attachment", "attachment_ref": {
        "filename": "deck.pdf", "mime": "application/pdf", "size": 12345, "fetch_ref": "att-1"}}]


def test_api_error_page_is_structured_rejection():
    page = {"error": {"code": 401, "status": "UNAUTHENTICATED", "message": "Token expired"}}
    result = dec.decode(_obs(page), DESC)
    assert result["threads"] == [] and result["atoms"] == []
    assert len(result["rejections"]) == 1
    rejection = result["rejections"][0]
    assert rejection["violation_path"] == "page.error"
    assert "Token expired" in rejection["got"]


def test_empty_page_and_unreadable_file():
    result = dec.decode(_obs({"messages": []}), DESC)
    assert result == {"threads": [], "atoms": [], "rejections": [], "next_cursor": None}
    bad = {"source_ref": "source:mail", "native_ref": "/nonexistent/page.json", "batch_ref": "b", "observed_at": None}
    result = dec.decode(bad, DESC)
    assert result["threads"] == []
    assert result["rejections"][0]["violation_path"] == "native_ref"


def test_malformed_message_rejected_others_survive():
    page = {"nextPageToken": "npt-9", "messages": [
        {"garbage": True},
        _msg("m1", "t5", "alice@x.com", ME, "Ok", body_text="fine"),
    ]}
    result = dec.decode(_obs(page), DESC)
    assert len(result["rejections"]) == 1
    assert result["rejections"][0]["violation_path"] == "messages[0]"
    assert len(result["threads"]) == 1
    assert result["next_cursor"] == "npt-9"


def test_ordering_by_internal_date():
    page = {"messages": [
        _msg("m2", "t6", "alice@x.com", ME, "s", body_text="second", internal_ms=2_000),
        _msg("m1", "t6", "alice@x.com", ME, "s", body_text="first", internal_ms=1_000),
    ]}
    assert [a["content"]["text"] for a in dec.decode(_obs(page), DESC)["atoms"]] == ["first", "second"]


def test_without_the_person_s_own_address_nobody_is_me():
    page = {"messages": [_msg("m1", "t7", ME, "alice@x.com", "s", body_text="from me")]}
    atoms = dec.decode(_obs(page), {})["atoms"]
    assert atoms[0]["speaker_ref"].endswith(f":{ME}")
    page = {"messages": [_msg("m1", "t7", ME, "alice@x.com", "s", body_text="from me")]}
    assert dec.decode(_obs(page), DESC)["atoms"][0]["speaker_ref"].endswith(":me")


def test_a_window_pages_one_thread_of_a_page():
    page = {"messages": [
        _msg(f"m{n}", "t8", "alice@x.com", ME, "s", body_text=f"word {n}", internal_ms=1000 + n) for n in range(5)]}
    window = dec.decode_window(_obs(page), DESC, limit=2, session_id="t8")
    assert [a["content"]["text"] for a in window["atoms"]] == ["word 3", "word 4"]
    assert window["has_older"] and not window["has_newer"] and window["total_count"] == 5
    older = dec.decode_window(_obs(page), DESC, before_cursor=window["older_cursor"], limit=2, session_id="t8")
    assert [a["content"]["text"] for a in older["atoms"]] == ["word 1", "word 2"]
