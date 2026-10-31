# tools/conversations/test/python/test_source_instagram_direct_messages.py
#
# Proves the `instagram-direct-messages` source row is a pure field mapping over
# the shared mapper: direct-thread-shaped snapshot JSON -> canonical
# {threads, atoms} with ZERO mapper changes. Fully offline: a fixture snapshot
# file, no network, no client library, no login.
import json
import os
import tempfile

import support  # noqa: E402

dec = support.source("instagram-direct-messages")

# Direct-thread-shaped snapshot: viewer (us) = pk "999".
# Thread A: 1-1 DM with @friend, mix of text + a media item (no text).
# Thread B: group DM, thread_title set, two other users.
# Thread C: media-only thread (no text at all) -> dropped by the mapper.
SNAPSHOT = {
    "self_pk": "999",
    "threads": [
        {
            "id": "340282366000000000001",
            "viewer_id": "999",
            "users": [
                {"pk": "111", "username": "friend", "full_name": "The Friend"},
                {"pk": "999", "username": "me_account", "full_name": "Me"},
            ],
            "messages": [
                {"user_id": "111", "text": "yo you around?", "item_type": "text",
                 "timestamp": 1_699_000_000_000_000},   # micros
                {"user_id": "999", "text": "yeah what's up", "item_type": "text",
                 "timestamp": 1_699_000_060_000_000},
                {"user_id": "111", "item_type": "media", "timestamp": 1_699_000_120_000_000},  # no text
                {"user_id": "111", "text": "check that pic", "item_type": "text",
                 "timestamp": 1_699_000_180_000_000},
            ],
        },
        {
            "id": "340282366000000000002",
            "viewer_id": "999",
            "thread_title": "Trip crew",
            "users": [
                {"pk": "222", "username": "alice"},
                {"pk": "333", "username": "bob"},
                {"pk": "999", "username": "me_account"},
            ],
            "messages": [
                {"user_id": "222", "text": "flights booked", "timestamp": "2026-06-01T10:00:00Z"},
                {"user_id": "333", "text": "nice", "timestamp": "2026-06-01T10:01:00Z"},
            ],
        },
        {
            "id": "340282366000000000003",
            "viewer_id": "999",
            "users": [{"pk": "444", "username": "silent"}],
            "messages": [
                {"user_id": "444", "item_type": "media", "timestamp": 1_699_100_000_000_000},
            ],
        },
    ],
}


def _write_snapshot(snap=SNAPSHOT):
    path = os.path.join(tempfile.mkdtemp(), "ig-dm-snapshot.json")
    with open(path, "w", encoding="utf-8") as fh:
        json.dump(snap, fh)
    return path


def _obs(path):
    return {"source_ref": "source:instagram", "native_ref": path,
            "batch_ref": "batch:ig1", "observed_at": "2026-07-03T00:00:00Z"}


DESC = {"display_mark_ref": "mark:instagram"}


def test_fan_out_drops_media_only_thread():
    out = dec.decode(_obs(_write_snapshot()), DESC)
    # Thread C (media-only) has no text -> dropped. A + B remain.
    assert len(out["threads"]) == 2
    ids = [t["session_id"] for t in out["threads"]]
    assert ids == ["340282366000000000001", "340282366000000000002"]
    assert out["rejections"] == []


def test_media_message_skipped_but_text_kept():
    out = dec.decode(_obs(_write_snapshot()), DESC)
    a = next(t for t in out["threads"] if t["session_id"] == "340282366000000000001")
    assert a["atom_count"] == 3          # 4 messages, 1 media -> 3 text atoms
    assert a["presentation"]["subtitle"] == "check that pic"
    assert a["presentation"]["title"] == "friend"        # other user's username
    assert a["presentation"]["mark_ref"] == "mark:instagram"


def test_me_resolved_by_viewer_id_and_handles_by_username():
    out = dec.decode(_obs(_write_snapshot()), DESC)
    atoms = [x for x in out["atoms"] if x["thread_ref"].endswith("340282366000000000001")]
    speakers = [x["speaker_ref"] for x in atoms]
    assert speakers == [
        "speaker:source:instagram:friend",   # 111 -> username
        "speaker:source:instagram:me",        # 999 == viewer_id -> me
        "speaker:source:instagram:friend",
    ]


def test_group_thread_title_and_iso_timestamps():
    out = dec.decode(_obs(_write_snapshot()), DESC)
    b = next(t for t in out["threads"] if t["session_id"] == "340282366000000000002")
    assert b["presentation"]["title"] == "Trip crew"     # explicit thread_title
    assert b["started_at"] == "2026-06-01T10:00:00Z"
    assert b["last_activity_at"] == "2026-06-01T10:01:00Z"


def test_micros_timestamp_normalized_to_iso():
    out = dec.decode(_obs(_write_snapshot()), DESC)
    a0 = next(x for x in out["atoms"] if x["content"]["text"] == "yo you around?")
    assert a0["at"] == "2023-11-03T08:26:40Z"            # 1_699_000_000_000_000 micros


def test_one_to_one_thread_emits_send_ref():
    # 1:1 DM (single non-self user) -> send_ref = the counterpart's uid, so the
    # chat send-route producer can publish a route.
    out = dec.decode(_obs(_write_snapshot()), DESC)
    a = next(t for t in out["threads"] if t["session_id"] == "340282366000000000001")
    assert a["send_ref"] == "111"


def test_group_thread_has_no_send_ref():
    # Group (2+ non-self users) fails closed: no single buddy -> no send_ref.
    out = dec.decode(_obs(_write_snapshot()), DESC)
    b = next(t for t in out["threads"] if t["session_id"] == "340282366000000000002")
    assert "send_ref" not in b


def test_unreadable_snapshot_is_rejection_not_crash():
    out = dec.decode(_obs("/nonexistent/ig.json"), DESC)
    assert out["threads"] == [] and out["atoms"] == []
    assert len(out["rejections"]) == 1
    assert out["rejections"][0]["violation_path"] == "native_ref"


def test_window_pages_and_identity_matches_full_decode():
    path = _write_snapshot()
    sid = "340282366000000000001"
    full = {x["content"]["text"]: x["atom_ref"]
            for x in dec.decode(_obs(path), DESC)["atoms"]}
    # Newest page: 2-message slice [2:4] = {media@2 (skipped), text@3} -> 1 atom.
    newest = dec.decode_window(_obs(path), DESC, before_cursor=None, limit=2, session_id=sid)
    assert newest["total_count"] == 4              # window counts ALL messages incl media
    assert [a["content"]["text"] for a in newest["atoms"]] == ["check that pic"]
    assert newest["has_older"] is True and newest["older_cursor"] == 2
    assert newest["has_newer"] is False
    # Older page: before_cursor=2 -> slice [0:2] = {text@0, text@1} -> 2 atoms.
    older = dec.decode_window(_obs(path), DESC, before_cursor=2, limit=2, session_id=sid)
    assert [a["content"]["text"] for a in older["atoms"]] == ["yo you around?", "yeah what's up"]
    assert older["has_older"] is False and older["older_cursor"] is None
    assert older["has_newer"] is True              # end(2) < total(4)
    # identity stability across BOTH pages vs the full decode.
    for x in newest["atoms"] + older["atoms"]:
        assert full[x["content"]["text"]] == x["atom_ref"], "identity drift full vs window"


def test_bare_list_snapshot_shape_accepted():
    # Tolerate a snapshot that is just a list of threads (no wrapper object).
    path = _write_snapshot(SNAPSHOT["threads"])
    out = dec.decode(_obs(path), DESC)
    assert len(out["threads"]) == 2       # still drops the media-only thread
