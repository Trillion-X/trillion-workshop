# tools/conversations/test/python/test_source_telegram_messages.py
#
# Proves the `telegram-messages` source row is a pure field mapping over the
# shared mapper: bot-API-shaped snapshot JSON -> canonical {threads, atoms} with
# ZERO mapper changes. Fully offline: a fixture snapshot file, no network, no
# token. Source-specific proofs: unix-epoch date/edit_date -> ISO in the atom;
# text|caption fallback; channel_post (no `from`) authored AS the channel; is_me
# by from.id == self_id.
import json
import os
import tempfile

import support  # noqa: E402

dec = support.source("telegram-messages")

# Connector-store-shaped snapshot: bot (us) = id 999, offset already advanced.
# Chat 100: text conversation (a member + the bot), incl. a caption-only photo
#   message (text falls back to caption) and a sticker (no text -> dropped).
# Chat 200: a channel_post (no `from`, authored AS the channel).
# Chat 300: only a service/sticker item (no text) -> mapper drops -> no atoms.
# 1719828000 = 2024-07-01T10:00:00Z ; +N*60 for later messages.
SNAPSHOT = {
    "account_ref": "telegram:samplebot",
    "self_id": 999,
    "offset": 42,
    "threads": [
        {
            "id": 100,
            "title": "Sam Sample",
            "messages": [
                {"message_id": 1, "date": 1719828000, "text": "when is practice?",
                 "from": {"id": 7, "first_name": "Sam", "last_name": "Sample",
                          "username": "samsample"},
                 "chat": {"id": 100, "title": "Sam Sample", "type": "private"}},
                {"message_id": 2, "date": 1719828300, "text": "Tuesday 6pm court 3",
                 "from": {"id": 999, "username": "sample_bot"},
                 "chat": {"id": 100, "type": "private"}},
                {"message_id": 3, "date": 1719828360, "caption": "here's the schedule",
                 "from": {"id": 7, "first_name": "Sam"},
                 "chat": {"id": 100, "type": "private"}, "photo": [{"file_id": "abc"}]},
                {"message_id": 4, "date": 1719828420,
                 "from": {"id": 7, "first_name": "Sam"},
                 "chat": {"id": 100, "type": "private"}, "sticker": {"file_id": "s1"}},
            ],
        },
        {
            "id": 200,
            "title": "Sample Announcements",
            "messages": [
                {"message_id": 50, "date": 1719828600,
                 "text": "Courts resurfaced this weekend.",
                 "chat": {"id": 200, "title": "Sample Announcements", "type": "channel"}},
            ],
        },
        {
            "id": 300,
            "title": "Silent",
            "messages": [
                {"message_id": 90, "date": 1719828900,
                 "from": {"id": 7}, "chat": {"id": 300}, "sticker": {"file_id": "s2"}},
            ],
        },
    ],
}


def _decode(snapshot):
    with tempfile.TemporaryDirectory() as td:
        path = os.path.join(td, "snap.json")
        with open(path, "w", encoding="utf-8") as f:
            json.dump(snapshot, f)
        obs = {"source_ref": "source:telegram", "native_ref": path}
        return dec.decode(obs, {"display_mark_ref": "mark:telegram"})


def test_threads_atoms_and_me_resolution():
    out = _decode(SNAPSHOT)
    # chat 300 (sticker-only) dropped; chats 100 (text) + 200 (channel_post) present
    titles = {t["presentation"]["title"] for t in out["threads"]}
    assert titles == {"Sam Sample", "Sample Announcements"}, titles
    speakers = [a["speaker_ref"] for a in out["atoms"]]
    # the bot's own message resolves to "me" structurally (from.id == self_id)
    assert any(s.endswith(":me") for s in speakers), speakers
    # the member resolves to the human handle (first + last preferred)
    assert any("Sam Sample" in s for s in speakers), speakers


def _text(atom):
    c = atom.get("content")
    if isinstance(c, dict):
        return c.get("text")
    return atom.get("text")


def test_caption_fallback_and_sticker_dropped():
    out = _decode(SNAPSHOT)
    texts = [_text(a) for a in out["atoms"]]
    # caption became transcript text; the sticker (no text/caption) is dropped
    assert any(t == "here's the schedule" for t in texts), texts
    # chat 100 had 4 messages, one sticker (msg 4) -> 3 text atoms in that thread
    chat100 = [a for a in out["atoms"] if _text(a) in (
        "when is practice?", "Tuesday 6pm court 3", "here's the schedule")]
    assert len(chat100) == 3, texts


def test_channel_post_authored_as_channel():
    out = _decode(SNAPSHOT)
    # the channel_post (no `from`) is authored AS the chat, never "me"
    post = [a for a in out["atoms"] if (_text(a) or "").startswith("Courts")]
    assert len(post) == 1, out["atoms"]
    assert not post[0]["speaker_ref"].endswith(":me")
    assert "Sample Announcements" in post[0]["speaker_ref"], post[0]["speaker_ref"]


def test_unix_epoch_converted_to_iso():
    # decode_window keeps the atom timestamps observable; edit_date beats date.
    with tempfile.TemporaryDirectory() as td:
        path = os.path.join(td, "snap.json")
        edited = {"account_ref": "telegram:samplebot", "self_id": 999, "offset": 1,
                  "threads": [{"id": 100, "title": "Sam", "messages": [
                      {"message_id": 1, "date": 1719828000, "edit_date": 1719914400,
                       "text": "edited text", "from": {"id": 7, "first_name": "Sam"},
                       "chat": {"id": 100}}]}]}
        with open(path, "w", encoding="utf-8") as f:
            json.dump(edited, f)
        obs = {"source_ref": "source:telegram", "native_ref": path}
        page = dec.decode_window(obs, {"display_mark_ref": "mark:telegram"},
                                 session_id="100", limit=10)
        assert len(page["atoms"]) == 1
        at = page["atoms"][0].get("at") or page["atoms"][0].get("occurred_at")
        # edit_date 1719914400 = 2024-07-02T10:00:00Z (edit_date preferred over date)
        assert at is not None and at.startswith("2024-07-02"), at


def test_unreadable_snapshot_single_rejection():
    obs = {"source_ref": "source:telegram", "native_ref": "/nonexistent/snap.json"}
    out = dec.decode(obs, {})
    assert out["threads"] == [] and out["atoms"] == []
    assert len(out["rejections"]) == 1
    assert out["rejections"][0]["violation_path"] == "native_ref"


def test_thread_without_id_rejected_not_crash():
    out = _decode({"self_id": 999,
                   "threads": [{"title": "no id", "messages": []},
                               SNAPSHOT["threads"][0]]})
    assert any(r["violation_path"] == "thread.id" for r in out["rejections"])
    # the valid chat still decodes
    assert any(t["presentation"]["title"] == "Sam Sample" for t in out["threads"])


def test_private_chat_emits_send_ref():
    # chat.type == "private" (1:1) -> send_ref = chat id (egress routes on the
    # chat id), so the chat send-route producer can publish a route.
    out = _decode(SNAPSHOT)
    sam = next(t for t in out["threads"] if t["session_id"] == "100")
    assert sam["send_ref"] == "100"


def test_channel_chat_has_no_send_ref():
    # Non-private chats (channel/group/supergroup) fail closed: no send_ref.
    out = _decode(SNAPSHOT)
    chan = next(t for t in out["threads"] if t["session_id"] == "200")
    assert "send_ref" not in chan


def test_decode_window_pages_one_chat():
    with tempfile.TemporaryDirectory() as td:
        path = os.path.join(td, "snap.json")
        with open(path, "w", encoding="utf-8") as f:
            json.dump(SNAPSHOT, f)
        obs = {"source_ref": "source:telegram", "native_ref": path}
        # limit=2 -> page = [caption msg3, sticker msg4]; mapper drops the
        # text-less sticker -> 1 atom, and older messages exist.
        page = dec.decode_window(obs, {"display_mark_ref": "mark:telegram"},
                                 session_id="100", limit=2)
        assert page["session_id"] == "100"
        assert len(page["atoms"]) == 1, page["atoms"]
        assert page["has_older"] is True
        # unknown chat -> honest empty
        empty = dec.decode_window(obs, {}, session_id="404")
        assert empty["atoms"] == []
