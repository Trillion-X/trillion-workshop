# tools/conversations/test/python/test_source_whatsapp_messages.py
#
# Proves the `whatsapp-messages` source row is a pure field mapping over the
# shared mapper: a web-client message snapshot -> canonical {threads, atoms} with
# ZERO mapper changes. Fully offline: fixture JSON, no network, no pairing.
import json
import os
import tempfile

import support  # noqa: E402

dec = support.source("whatsapp-messages")

FRIEND = "15550100001@s.whatsapp.net"
ALICE = "15550100002@s.whatsapp.net"
BOB = "15550100003@s.whatsapp.net"
GROUP = "120363000000000000@g.us"

# `chats`-shaped snapshot: a 1:1 DM + a group. Covers conversation,
# extendedTextMessage.text, imageMessage.caption, a caption-less media (dropped),
# fromMe, group participant senders, and a Long{low} timestamp.
SNAPSHOT = {
    "self_jid": "15550100000@s.whatsapp.net",
    "contacts": {FRIEND: "Sam", ALICE: "Alice", BOB: "Bob"},
    "chats": [
        {"id": FRIEND, "messages": [
            {"key": {"remoteJid": FRIEND, "fromMe": False, "id": "m1"},
             "message": {"conversation": "yo you up?"}, "messageTimestamp": 1699000000},
            {"key": {"remoteJid": FRIEND, "fromMe": True, "id": "m2"},
             "message": {"extendedTextMessage": {"text": "yeah what's up"}},
             "messageTimestamp": {"low": 1699000060, "high": 0, "unsigned": False}},
            {"key": {"remoteJid": FRIEND, "fromMe": False, "id": "m3"},
             "message": {"imageMessage": {"caption": "look at this", "mimetype": "image/jpeg"}},
             "messageTimestamp": 1699000120},
            {"key": {"remoteJid": FRIEND, "fromMe": False, "id": "m4"},
             "message": {"imageMessage": {"mimetype": "image/jpeg"}},   # no caption -> dropped
             "messageTimestamp": 1699000180},
        ]},
        {"id": GROUP, "subject": "Weekend Trip", "messages": [
            {"key": {"remoteJid": GROUP, "fromMe": False, "participant": ALICE, "id": "g1"},
             "message": {"conversation": "flights booked"}, "messageTimestamp": 1699100000},
            {"key": {"remoteJid": GROUP, "fromMe": False, "participant": BOB, "id": "g2"},
             "message": {"conversation": "nice"}, "messageTimestamp": 1699100060},
        ]},
    ],
}


def _write(snap=SNAPSHOT):
    path = os.path.join(tempfile.mkdtemp(), "wa-snapshot.json")
    with open(path, "w", encoding="utf-8") as fh:
        json.dump(snap, fh)
    return path


def _obs(path):
    return {"source_ref": "source:whatsapp", "native_ref": path,
            "batch_ref": "batch:wa1", "observed_at": "2026-07-03T00:00:00Z"}


DESC = {"display_mark_ref": "mark:whatsapp"}


def test_fan_out_two_chats():
    out = dec.decode(_obs(_write()), DESC)
    assert len(out["threads"]) == 2
    assert [t["session_id"] for t in out["threads"]] == [FRIEND, GROUP]
    assert out["rejections"] == []


def test_text_extraction_across_message_types_and_media_drop():
    out = dec.decode(_obs(_write()), DESC)
    dm = next(t for t in out["threads"] if t["session_id"] == FRIEND)
    assert dm["atom_count"] == 3           # conversation + extendedText + caption; media dropped
    assert dm["presentation"]["title"] == "Sam"           # contacts map
    assert dm["presentation"]["subtitle"] == "look at this"  # imageMessage.caption
    texts = [a["content"]["text"] for a in out["atoms"] if a["thread_ref"].endswith(FRIEND)]
    assert texts == ["yo you up?", "yeah what's up", "look at this"]


def test_fromMe_and_group_participant_speakers():
    out = dec.decode(_obs(_write()), DESC)
    dm = [a for a in out["atoms"] if a["thread_ref"].endswith(FRIEND)]
    assert dm[0]["speaker_ref"] == "speaker:source:whatsapp:Sam"   # remoteJid -> contact
    assert dm[1]["speaker_ref"] == "speaker:source:whatsapp:me"    # fromMe
    grp = [a for a in out["atoms"] if a["thread_ref"].endswith(GROUP)]
    assert grp[0]["speaker_ref"] == "speaker:source:whatsapp:Alice"  # participant
    assert grp[1]["speaker_ref"] == "speaker:source:whatsapp:Bob"


def test_group_subject_title_and_long_timestamp():
    out = dec.decode(_obs(_write()), DESC)
    grp = next(t for t in out["threads"] if t["session_id"] == GROUP)
    assert grp["presentation"]["title"] == "Weekend Trip"    # chat.subject
    # Long{low:1699000060} normalized same as int 1699000060.
    a = next(x for x in out["atoms"] if x["content"]["text"] == "yeah what's up")
    assert a["at"] == "2023-11-03T08:27:40Z"


def test_flat_message_list_grouped_by_remote_jid():
    flat = {"contacts": {FRIEND: "Sam"}, "messages": [
        {"key": {"remoteJid": FRIEND, "fromMe": False, "id": "x1"},
         "message": {"conversation": "hi"}, "messageTimestamp": 1699000000},
        {"key": {"remoteJid": FRIEND, "fromMe": True, "id": "x2"},
         "message": {"conversation": "hello"}, "messageTimestamp": 1699000010},
    ]}
    out = dec.decode(_obs(_write(flat)), DESC)
    assert len(out["threads"]) == 1
    assert out["threads"][0]["session_id"] == FRIEND
    assert out["threads"][0]["atom_count"] == 2


def test_unreadable_snapshot_is_rejection_not_crash():
    out = dec.decode(_obs("/nonexistent/wa.json"), DESC)
    assert out["threads"] == [] and out["atoms"] == []
    assert len(out["rejections"]) == 1
    assert out["rejections"][0]["violation_path"] == "native_ref"


def test_window_pages_and_identity_matches_full_decode():
    path = _write()
    full = {x["content"]["text"]: x["atom_ref"]
            for x in dec.decode(_obs(path), DESC)["atoms"]}
    # Newest 2-message slice [2:4] = {caption@2, media@3 (dropped)} -> 1 atom.
    newest = dec.decode_window(_obs(path), DESC, before_cursor=None, limit=2, session_id=FRIEND)
    assert newest["total_count"] == 4
    assert [a["content"]["text"] for a in newest["atoms"]] == ["look at this"]
    assert newest["has_older"] is True and newest["older_cursor"] == 2
    assert newest["has_newer"] is False
    older = dec.decode_window(_obs(path), DESC, before_cursor=2, limit=2, session_id=FRIEND)
    assert [a["content"]["text"] for a in older["atoms"]] == ["yo you up?", "yeah what's up"]
    assert older["has_older"] is False and older["has_newer"] is True
    for x in newest["atoms"] + older["atoms"]:
        assert full[x["content"]["text"]] == x["atom_ref"], "identity drift full vs window"
