# tools/conversations/test/python/test_source_discord_messages.py
#
# Proves the `discord-messages` source row, read by the one generic reader and
# the one mapper: channel-message-shaped snapshot JSON -> canonical
# {threads, atoms} with ZERO mapper changes. Fully offline: a fixture snapshot
# file, no network, no token.
#
# It ALSO proves the renderable-parts rule: a message's text is `content` + each
# embed's renderable text + each attachment's renderable metadata, concatenated in
# source order, so a bot rich card that carries content:"" with the payload in
# embeds[] surfaces as an atom instead of vanishing. Generic over ANY embed or
# attachment; never fabricates a placeholder; drops only when nothing anywhere is
# renderable.
import json
import os
import tempfile

import support  # noqa: E402

dec = support.source("discord-messages")

# Connector-store-shaped snapshot: bot (us) = id "999".
# Channel 100: a human text conversation (bot + a member) plus an embed-only bot
# rich card (surfaced as an atom, not dropped).
# Channel 101: a single opaque-id-only attachment -> nothing renderable -> the
# channel produces no atoms (dropped), exactly like a text-less row.
SNAPSHOT = {
    "self_id": "999",
    "threads": [
        {
            "id": "100",
            "title": "#general - Sample Guild",
            "messages": [
                {"id": "1", "content": "when is practice?",
                 "timestamp": "2026-07-01T10:00:00Z",
                 "author": {"id": "7", "username": "student", "global_name": "Sam"}},
                {"id": "2", "content": "Tuesday 6pm court 3",
                 "timestamp": "2026-07-01T10:05:00Z",
                 "author": {"id": "999", "username": "sample_bot"}},
                {"id": "3", "content": "", "timestamp": "2026-07-01T10:06:00Z",
                 "author": {"id": "999", "username": "sample_bot"},
                 "embeds": [{"title": "Weekly Briefing",
                             "description": "3 lessons booked",
                             "fields": [{"name": "Court", "value": "3"},
                                        {"name": "Coach", "value": "Alex"}],
                             "footer": {"text": "Sample School"}}]},
            ],
        },
        {
            "id": "101",
            "title": "#media-only - Sample Guild",
            "messages": [
                {"id": "9", "content": "", "timestamp": "2026-07-01T11:00:00Z",
                 "author": {"id": "7"}, "attachments": [{"id": "a"}]},
            ],
        },
    ],
}


def _decode(snapshot):
    with tempfile.TemporaryDirectory() as td:
        path = os.path.join(td, "snap.json")
        with open(path, "w", encoding="utf-8") as f:
            json.dump(snapshot, f)
        obs = {"source_ref": "source:discord", "native_ref": path}
        return dec.decode(obs, {"display_mark_ref": "mark:discord"})


def _one_msg(msg):
    """Decode a single-message channel and return its atoms (0 or 1)."""
    snap = {"self_id": "999",
            "threads": [{"id": "500", "title": "t", "messages": [msg]}]}
    return _decode(snap)["atoms"]


def _text_of(atoms):
    return [a["content"]["text"] for a in atoms]


# --- adapter / mapper contract -------------------------------------------------

def test_threads_atoms_and_me_resolution():
    out = _decode(SNAPSHOT)
    # opaque-attachment-only channel 101 dropped; text channel 100 present
    assert len(out["threads"]) == 1, [t["thread_ref"] for t in out["threads"]]
    t = out["threads"][0]
    assert t["presentation"]["title"] == "#general - Sample Guild"
    assert t["presentation"]["mark_ref"] == "mark:discord"
    # 3 atoms: question + reply + the embed-only rich card (surfaced)
    assert len(out["atoms"]) == 3, _text_of(out["atoms"])
    speakers = [a["speaker_ref"] for a in out["atoms"]]
    # the bot's own message resolves to "me" structurally (author.id == self_id)
    assert any(s.endswith(":me") for s in speakers), speakers
    # the member resolves to the human handle (global_name preferred)
    assert any("Sam" in s for s in speakers), speakers


def test_dm_channel_emits_send_ref():
    # A direct-message channel (type 1) -> send_ref = channel id (egress posts to
    # the channel), so the chat send-route producer can publish a route.
    snap = {"self_id": "999",
            "threads": [{"id": "600", "title": "Sam", "type": 1, "messages": [
                {"id": "1", "content": "hey", "timestamp": "2026-07-01T10:00:00Z",
                 "author": {"id": "7", "username": "sam"}}]}]}
    out = _decode(snap)
    assert out["threads"][0]["send_ref"] == "600"


def test_guild_channel_has_no_send_ref():
    # Guild text channels (no type-1 marker) fail closed: no send_ref.
    out = _decode(SNAPSHOT)
    assert all("send_ref" not in t for t in out["threads"])


def test_unreadable_snapshot_single_rejection():
    obs = {"source_ref": "source:discord", "native_ref": "/nonexistent/snap.json"}
    out = dec.decode(obs, {})
    assert out["threads"] == [] and out["atoms"] == []
    assert len(out["rejections"]) == 1
    assert out["rejections"][0]["violation_path"] == "native_ref"


def test_thread_without_id_rejected_not_crash():
    out = _decode({"self_id": "999",
                   "threads": [{"title": "no id", "messages": []},
                               SNAPSHOT["threads"][0]]})
    assert len(out["threads"]) == 1
    assert any(r["violation_path"] == "thread.id" for r in out["rejections"])


# --- renderable-parts rule (embeds + attachments) ------------------------------

def test_embed_only_description_surfaces():
    atoms = _one_msg({"id": "e1", "content": "",
                      "author": {"id": "7"},
                      "embeds": [{"description": "practice moved to 7pm"}]})
    assert _text_of(atoms) == ["practice moved to 7pm"]


def test_embed_fields_render_name_value_pairs():
    atoms = _one_msg({"id": "e2", "content": "",
                      "author": {"id": "7"},
                      "embeds": [{"title": "Match Report",
                                  "fields": [{"name": "Score", "value": "6-4"},
                                             {"name": "Winner", "value": "Sam"}]}]})
    text = _text_of(atoms)[0]
    assert "Match Report" in text
    assert "Score: 6-4" in text and "Winner: Sam" in text


def test_embed_author_and_footer_render():
    atoms = _one_msg({"id": "e3", "content": "",
                      "author": {"id": "7"},
                      "embeds": [{"author": {"name": "Coach Alex"},
                                  "description": "well played",
                                  "footer": {"text": "Sample School"}}]})
    text = _text_of(atoms)[0]
    # author first, description, footer last - reading order preserved
    assert text.index("Coach Alex") < text.index("well played") < text.index("Sample School")


def test_embed_media_url_when_no_prose():
    atoms = _one_msg({"id": "e4", "content": "",
                      "author": {"id": "7"},
                      "embeds": [{"image": {"url": "https://cdn.example.com/x.png"}}]})
    assert _text_of(atoms) == ["https://cdn.example.com/x.png"]


def test_attachment_only_renders_filename_and_url():
    atoms = _one_msg({"id": "a1", "content": "",
                      "author": {"id": "7"},
                      "attachments": [{"filename": "drill.mp4",
                                       "url": "https://cdn.example.com/drill.mp4"}]})
    text = _text_of(atoms)[0]
    assert "drill.mp4" in text and "https://cdn.example.com/drill.mp4" in text


def test_attachment_opaque_id_only_is_dropped():
    # nothing renderable -> text-less -> mapper drops it (never "[attachment]")
    assert _one_msg({"id": "a2", "content": "",
                     "author": {"id": "7"},
                     "attachments": [{"id": "opaque"}]}) == []


def test_multiple_embeds_join_into_one_atom():
    atoms = _one_msg({"id": "m1", "content": "",
                      "author": {"id": "7"},
                      "embeds": [{"description": "first"},
                                 {"description": "second"}]})
    # one message -> one atom, both embeds concatenated (no double-count)
    assert len(atoms) == 1
    text = _text_of(atoms)[0]
    assert "first" in text and "second" in text


def test_content_and_embed_both_surface_content_first():
    atoms = _one_msg({"id": "c1", "content": "see the card",
                      "author": {"id": "7"},
                      "embeds": [{"description": "card body"}]})
    text = _text_of(atoms)[0]
    assert text.index("see the card") < text.index("card body")


def test_opaque_embed_no_renderable_part_dropped():
    # embed carries only structural/id keys the walk doesn't render -> None -> drop
    assert _one_msg({"id": "o1", "content": "",
                     "author": {"id": "7"},
                     "embeds": [{"type": "rich", "color": 5814783}]}) == []


def test_system_message_no_text_dropped_not_fabricated():
    # a type!=0 message with nothing renderable is dropped, never "user joined"
    assert _one_msg({"id": "s1", "type": 7, "content": "",
                     "author": {"id": "7"}}) == []


# --- durable identity (native_ref) ---------------------------------------------

def test_native_ref_set_from_message_id():
    atoms = _one_msg({"id": "42", "content": "hello", "author": {"id": "7"}})
    assert atoms[0]["native_ref"] == "42"


def test_native_ref_absent_when_no_id():
    atoms = _one_msg({"content": "no id here", "author": {"id": "7"}})
    # falls back to the mapper's content-derived identity; no fabricated ref
    assert atoms[0].get("native_ref") is None


def test_atom_identity_stable_across_text_edit_when_native_ref_present():
    a = _one_msg({"id": "77", "content": "original", "author": {"id": "7"}})
    b = _one_msg({"id": "77", "content": "edited body", "author": {"id": "7"}})
    # durable id anchors identity -> atom_ref invariant under a text edit
    assert a[0]["atom_ref"] == b[0]["atom_ref"]
    assert a[0]["content"]["text"] != b[0]["content"]["text"]


# --- windowing -----------------------------------------------------------------

def test_decode_window_pages_one_channel():
    with tempfile.TemporaryDirectory() as td:
        path = os.path.join(td, "snap.json")
        with open(path, "w", encoding="utf-8") as f:
            json.dump(SNAPSHOT, f)
        obs = {"source_ref": "source:discord", "native_ref": path}
        # limit=2 -> page = [reply msg2, embed-card msg3]; both surface -> 2 atoms
        page = dec.decode_window(obs, {"display_mark_ref": "mark:discord"},
                                 session_id="100", limit=2)
        assert page["session_id"] == "100"
        assert len(page["atoms"]) == 2, page["atoms"]
        assert page["has_older"] is True
        # unknown channel -> honest empty
        empty = dec.decode_window(obs, {}, session_id="404")
        assert empty["atoms"] == []
