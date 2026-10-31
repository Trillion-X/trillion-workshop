# tools/conversations/test/python/test_source_imessage_database.py
#
# Proves the `imessage-database` source row (read_source.py, reader `sqlite-rows`) over the shared mapper: a copy of
# the Messages database -> the canonical {threads, atoms, rejections}, and that the reaction (message-state)
# envelope is OPEN: every reaction (classic tapback, arbitrary emoji, sticker, or a code never seen before) surfaces
# with zero drops and zero crashes, and an add/remove pair shares ONE symbol so a (speaker, symbol) fold cancels it.
#
# Builds a fixture database inline: no Full Disk Access, no real Messages database, only made-up numbers, addresses
# and words.
import os
import sqlite3
import tempfile

import support  # noqa: E402

dec = support.source("imessage-database")


# ---------------------------------------------------------------------------
# FIXTURE SCHEMA — the columns the real decoder SELECTs (guid + attributedBody +
# lifecycle + associated-message/reaction), so the fixture exercises the exact
# read path a modern macOS chat.db drives, not a legacy subset.
# ---------------------------------------------------------------------------
_MESSAGE_COLS = (
    "ROWID INTEGER PRIMARY KEY", "guid TEXT", "text TEXT", "attributedBody BLOB",
    "date INTEGER", "is_from_me INTEGER", "handle_id INTEGER",
    "associated_message_guid TEXT", "associated_message_type INTEGER",
    "associated_message_emoji TEXT",
    "is_sent INTEGER", "is_delivered INTEGER", "date_delivered INTEGER",
    "is_read INTEGER", "date_read INTEGER", "error INTEGER",
    "date_edited INTEGER", "date_retracted INTEGER",
)


def _new_db():
    path = os.path.join(tempfile.mkdtemp(), "chat.db")
    c = sqlite3.connect(path)
    c.executescript(f"""
      CREATE TABLE handle(ROWID INTEGER PRIMARY KEY, id TEXT);
      CREATE TABLE chat(ROWID INTEGER PRIMARY KEY, guid TEXT, chat_identifier TEXT, display_name TEXT);
      CREATE TABLE message({", ".join(_MESSAGE_COLS)});
      CREATE TABLE chat_message_join(chat_id INTEGER, message_id INTEGER);
    """)
    return path, c


def _msg(c, rid, guid, text, date, is_from_me, handle_id, **extra):
    """Insert one message row; unspecified columns default NULL."""
    cols = ["ROWID", "guid", "text", "date", "is_from_me", "handle_id"]
    vals = [rid, guid, text, date, is_from_me, handle_id]
    for k, v in extra.items():
        cols.append(k)
        vals.append(v)
    placeholders = ",".join("?" for _ in cols)
    c.execute(f"INSERT INTO message({','.join(cols)}) VALUES({placeholders})", vals)


def _obs(db):
    return {"source_ref": "source:imessage", "native_ref": db,
            "batch_ref": "batch:test", "observed_at": "2026-07-03T00:00:00Z"}


DESC = {"display_mark_ref": "mark:imessage"}


# ---------------------------------------------------------------------------
# LEGACY CONTRACT — threads / atoms / send_ref / windowing still hold with the
# modern schema (guids present, no reactions).
# ---------------------------------------------------------------------------
def _fixture_db():
    path, c = _new_db()
    c.execute("INSERT INTO handle VALUES(1,'+15551234567')")
    c.execute("INSERT INTO handle VALUES(2,'friend@example.com')")
    c.execute("INSERT INTO chat VALUES(1,'iMessage;+;chat1','+15551234567','Weekend Plans')")
    c.execute("INSERT INTO chat VALUES(2,'iMessage;-;chat2','friend@example.com','')")
    rows = [
        (1, 'g1', 'Hey are we still on?', 600000000000000000, 0, 1),
        (2, 'g2', '',                     600000000001000000, 1, None),  # empty -> filtered
        (3, 'g3', 'Yeah 2pm works',       600000000002000000, 1, None),
        (4, 'g4', 'Perfect see you then', 600000000003000000, 0, 1),
        (5, 'g5', 'Did you get my email?',700000000000000000, 0, 2),
        (6, 'g6', 'Just replied',         700000000001000000, 1, None),
    ]
    for rid, guid, txt, dt, me, h in rows:
        _msg(c, rid, guid, txt, dt, me, h)
    for m in (1, 2, 3, 4):
        c.execute("INSERT INTO chat_message_join VALUES(1,?)", (m,))
    for m in (5, 6):
        c.execute("INSERT INTO chat_message_join VALUES(2,?)", (m,))
    c.commit(); c.close()
    return path


def test_decode_fans_out_and_shapes_threads():
    db = _fixture_db()
    out = dec.decode(_obs(db), DESC)
    assert len(out["threads"]) == 2
    assert len(out["atoms"]) == 5   # 6 msgs, 1 empty filtered
    assert out["rejections"] == []
    titles = [t["presentation"]["title"] for t in out["threads"]]
    assert titles == ["Weekend Plans", "friend@example.com"]
    t0 = out["threads"][0]
    assert t0["session_id"] == "iMessage;+;chat1"
    assert t0["thread_ref"] == "thread:source:imessage:iMessage;+;chat1"
    assert t0["atom_count"] == 3
    assert t0["presentation"]["subtitle"] == "Perfect see you then"
    assert t0["presentation"]["mark_ref"] == "mark:imessage"


def test_atom_shape_and_speaker():
    db = _fixture_db()
    atoms = dec.decode(_obs(db), DESC)["atoms"]
    a0 = atoms[0]
    assert a0["kind"] == "utterance"
    assert a0["content"]["text"] == "Hey are we still on?"
    assert a0["speaker_ref"] == "speaker:source:imessage:+15551234567"
    assert a0["observation_refs"] == ["batch:test"]
    assert a0["source_ref"] == "source:imessage"
    # native_ref anchors atom identity to the durable guid, not the row ordinal.
    assert a0["native_ref"] == "g1"
    assert atoms[1]["speaker_ref"] == "speaker:source:imessage:me"


def test_single_recipient_thread_carries_send_ref():
    db = _fixture_db()
    threads = dec.decode(_obs(db), DESC)["threads"]
    by_session = {t["session_id"]: t for t in threads}
    assert by_session["iMessage;+;chat1"]["send_ref"] == "+15551234567"
    assert by_session["iMessage;-;chat2"]["send_ref"] == "friend@example.com"


def _group_db():
    path, c = _new_db()
    c.execute("INSERT INTO handle VALUES(1,'+15551110000')")
    c.execute("INSERT INTO handle VALUES(2,'+15552220000')")
    c.execute("INSERT INTO chat VALUES(1,'iMessage;+;group','chat123','Trip Crew')")
    for rid, guid, txt, dt, me, h in [
        (1, 'gg1', 'who is driving', 600000000000000000, 0, 1),
        (2, 'gg2', 'i can',          600000000001000000, 0, 2),
        (3, 'gg3', 'thanks both',    600000000002000000, 1, None),
    ]:
        _msg(c, rid, guid, txt, dt, me, h)
        c.execute("INSERT INTO chat_message_join VALUES(1,?)", (rid,))
    c.commit(); c.close()
    return path


def test_group_thread_has_no_send_ref():
    db = _group_db()
    threads = dec.decode(_obs(db), DESC)["threads"]
    assert len(threads) == 1
    assert "send_ref" not in threads[0]


def test_unreadable_db_is_rejection_not_crash():
    out = dec.decode(_obs("/nonexistent/path/chat.db"), DESC)
    assert out["threads"] == [] and out["atoms"] == []
    assert len(out["rejections"]) == 1
    assert out["rejections"][0]["violation_path"] in ("native_ref", "schema")


def test_decode_window_pages_one_thread():
    db = _fixture_db()
    w = dec.decode_window(_obs(db), DESC, before_cursor=None, limit=2, session_id="iMessage;+;chat1")
    assert w["total_count"] == 3
    assert len(w["atoms"]) == 2
    assert w["has_older"] is True and w["older_cursor"] == 1 and w["has_newer"] is False
    assert w["title"] == "Weekend Plans"
    full = {a["content"]["text"]: a["atom_ref"] for a in dec.decode(_obs(db), DESC)["atoms"]}
    for a in w["atoms"]:
        assert full[a["content"]["text"]] == a["atom_ref"], "identity drift decode vs window"


# ---------------------------------------------------------------------------
# THE OPEN REACTION SYMBOL PRIMITIVE: unit-level on one reaction record. A CLOSED tapback map would silently drop
# a person's emoji reactions; these lock the symbol space OPEN.
# ---------------------------------------------------------------------------
def _symbol(record, source=dec):
    return source.reaction(record)["reaction_symbol"]


def test_reaction_symbol_classic_names_convenience_overlay():
    # The six classic codes get a readable name: a convenience, not the mechanism.
    assert _symbol({"amt": 2000, "emoji": None}) == "love"
    assert _symbol({"amt": 2004, "emoji": None}) == "emphasis"


def test_reaction_symbol_emoji_glyph_wins():
    # An arbitrary-emoji tapback: the glyph is in associated_message_emoji and the code sits OUTSIDE 2000-2005. It
    # must surface as the glyph, never dropped.
    assert _symbol({"amt": 2006, "emoji": "\U0001F525"}) == "\U0001F525"
    # An emoji present even on a classic code still wins (self-describing beats name).
    assert _symbol({"amt": 2000, "emoji": "\u2764\ufe0f"}) == "\u2764\ufe0f"


def test_reaction_symbol_unknown_code_falls_back_never_drops():
    # A sticker / brand-new tapback kind with no emoji column value: an opaque code, surfaced verbatim.
    assert _symbol({"amt": 2007, "emoji": None}) == "code:2007"
    assert _symbol({"amt": 2099}) == "code:2099"  # the 'emoji' key absent entirely: no crash


def test_reaction_symbol_add_remove_fold_invariance():
    # A remove (3000s) must give the SAME symbol as its add (2000s), so a (speaker, symbol) fold cancels the pair.
    assert _symbol({"amt": 3000, "emoji": None}) == "love"                  # == add 2000
    assert _symbol({"amt": 3006, "emoji": "\U0001F525"}) == "\U0001F525"     # == add 2006 emoji
    assert _symbol({"amt": 3007, "emoji": None}) == "code:2007"             # == add 2007 code


def test_reaction_symbol_deletion_test_passes():
    # Delete the classic-name overlay from the row entirely and every reaction STILL surfaces (code fallback): the
    # overlay is convenience, not the load-bearing mechanism.
    import copy
    row = copy.deepcopy(support.row("imessage-database"))
    symbol = row["sqlite"]["reaction"]["symbol"]["first"][1]
    assert "lookup" in symbol
    symbol["lookup"] = {"const": {}}
    bare = support.source("imessage-database", row)
    assert _symbol({"amt": 2000, "emoji": None}, bare) == "code:2000"
    assert _symbol({"amt": 2006, "emoji": "\U0001F525"}, bare) == "\U0001F525"


def test_reaction_message_never_none_and_family_kind():
    # A reaction record must NEVER give None (an old closed map returned None outside 2000-3005, dropping the
    # reaction). Any code produces a reaction subject.
    m_add = dec.reaction({"amt": 2007, "emoji": None, "native_guid": "r1", "native_rowid": 10,
                          "date": 700000000000000000, "is_from_me": 0, "handle": "+1", "assoc_guid": "p:0/t1"})
    assert m_add is not None
    assert m_add["reaction_kind"] == "added" and m_add["reaction_symbol"] == "code:2007"
    assert m_add["kind"] == "reaction" and m_add["text"] is None
    assert m_add["relations"][0] == {"role": "reaction_target", "target_native_ref": "t1"}
    m_rm = dec.reaction({"amt": 3000, "emoji": None, "native_guid": None, "native_rowid": 11,
                         "date": 700000000000000000, "is_from_me": 1, "handle": None, "assoc_guid": "bp:t2"})
    assert m_rm is not None and m_rm["reaction_kind"] == "removed"
    assert m_rm["reaction_symbol"] == "love"            # fold-invariant with add 2000
    assert m_rm["native_ref"] == "imsg-rowid:11"        # guid None -> ROWID fallback
    assert m_rm["speaker"] == "me"


# ---------------------------------------------------------------------------
# END-TO-END through decode() — the widened SQL actually PULLS emoji/sticker/
# unknown reaction rows out of chat.db and threads them onto their targets.
# ---------------------------------------------------------------------------
def _reaction_db():
    path, c = _new_db()
    c.execute("INSERT INTO handle VALUES(1,'+15550001111')")
    c.execute("INSERT INTO chat VALUES(1,'iMessage;+;rxn','+15550001111','Reactions')")
    # Target utterances (one outbound, to also carry lifecycle status).
    _msg(c, 1, 't-love', 'love this one', 600000000000000000, 0, 1)
    _msg(c, 2, 't-fire', 'fire target', 600000000001000000, 1, None,
         is_sent=1, is_delivered=1, date_delivered=600000000002000000,
         is_read=1, date_read=600000000003000000)
    _msg(c, 3, 't-code', 'sticker target', 600000000004000000, 0, 1)
    _msg(c, 4, 't-cancel', 'cancel target', 600000000005000000, 0, 1)
    # Reaction rows (text/attributedBody NULL -> excluded from the utterance query).
    #   classic love (2000), arbitrary emoji (2006 + glyph), sticker/unknown (2007),
    #   then an add(2000)+remove(3000) pair on the same target -> folds away.
    _msg(c, 10, 'r-love',   None, 600000000006000000, 1, None,
         associated_message_guid='p:0/t-love', associated_message_type=2000)
    _msg(c, 11, 'r-emoji',  None, 600000000007000000, 0, 1,
         associated_message_guid='p:0/t-fire', associated_message_type=2006,
         associated_message_emoji='🔥')
    _msg(c, 12, 'r-sticker', None, 600000000008000000, 0, 1,
         associated_message_guid='p:0/t-code', associated_message_type=2007)
    _msg(c, 13, 'r-add',    None, 600000000009000000, 1, None,
         associated_message_guid='p:0/t-cancel', associated_message_type=2000)
    _msg(c, 14, 'r-remove', None, 600000000010000000, 1, None,
         associated_message_guid='p:0/t-cancel', associated_message_type=3000)
    for m in range(1, 15):
        c.execute("INSERT INTO chat_message_join VALUES(1,?)", (m,))
    c.commit(); c.close()
    return path


def _reaction_atoms(out):
    return [a for a in out["atoms"] if a["kind"] == "reaction"]


def test_decode_surfaces_every_reaction_kind_none_dropped():
    out = dec.decode(_obs(_reaction_db()), DESC)
    assert out["rejections"] == []
    rxns = _reaction_atoms(out)
    # 5 reaction rows in, 5 reaction atoms out — the decoder drops NOTHING, even
    # the emoji (2006) and sticker (2007) codes the old BETWEEN 2000 AND 3005 map
    # would have mangled or dropped. (The add/remove FOLD happens later, in the
    # chat materializer; the decoder's job is to surface every event.)
    assert len(rxns) == 5
    symbols = sorted(a["content"]["symbol"] for a in rxns)
    assert symbols == sorted(["love", "🔥", "code:2007", "love", "love"])


def test_decode_emoji_reaction_carries_glyph():
    out = dec.decode(_obs(_reaction_db()), DESC)
    emoji = [a for a in _reaction_atoms(out) if a["content"]["symbol"] == "🔥"]
    assert len(emoji) == 1, "emoji tapback (code 2006) must surface as its glyph"
    assert emoji[0]["content"]["reaction_kind"] == "added"


def test_decode_unknown_code_reaction_surfaced_opaque():
    out = dec.decode(_obs(_reaction_db()), DESC)
    sticker = [a for a in _reaction_atoms(out) if a["content"]["symbol"] == "code:2007"]
    assert len(sticker) == 1, "unknown/sticker tapback must surface as an opaque code, never drop"


def test_decode_add_remove_share_symbol_for_fold():
    out = dec.decode(_obs(_reaction_db()), DESC)
    cancel_pair = [a for a in _reaction_atoms(out)
                   if a["relations"] and a["relations"][0].get("target_native_ref") == "t-cancel"]
    assert len(cancel_pair) == 2
    kinds = sorted(a["content"]["reaction_kind"] for a in cancel_pair)
    assert kinds == ["added", "removed"]
    # Both carry the SAME symbol -> the materializer's (speaker, symbol) fold cancels.
    assert {a["content"]["symbol"] for a in cancel_pair} == {"love"}


def test_decode_reaction_relation_binds_to_target_atom():
    out = dec.decode(_obs(_reaction_db()), DESC)
    native_to_ref = {a["native_ref"]: a["atom_ref"] for a in out["atoms"] if a.get("native_ref")}
    love = [a for a in _reaction_atoms(out)
            if a["relations"] and a["relations"][0].get("target_native_ref") == "t-love"][0]
    # The mapper's second pass resolves the reaction's target to the target atom_ref.
    assert love["relations"][0]["target_atom_ref"] == native_to_ref["t-love"]


def test_decode_outbound_message_carries_authoritative_lifecycle():
    out = dec.decode(_obs(_reaction_db()), DESC)
    fire = [a for a in out["atoms"] if a.get("native_ref") == "t-fire"][0]
    keys = {e["key"]: e for e in fire["state_events"]}
    assert "sent" in keys and "delivered" in keys and "read" in keys
    # Native store events are AUTHORITATIVE (provenance 10) — never optimistic.
    assert all(e["provenance"] == 10 for e in fire["state_events"])
    # An inbound message carries NO sender-visible outbound status (fail-closed).
    love_target = [a for a in out["atoms"] if a.get("native_ref") == "t-love"][0]
    assert love_target["state_events"] == []


def test_legacy_schema_without_assoc_columns_no_crash():
    # A chat.db variant missing the associated_message_* columns must yield an
    # empty reaction set, never a crash (blind-parser rule).
    path = os.path.join(tempfile.mkdtemp(), "chat.db")
    c = sqlite3.connect(path)
    c.executescript("""
      CREATE TABLE handle(ROWID INTEGER PRIMARY KEY, id TEXT);
      CREATE TABLE chat(ROWID INTEGER PRIMARY KEY, guid TEXT, chat_identifier TEXT, display_name TEXT);
      CREATE TABLE message(ROWID INTEGER PRIMARY KEY, guid TEXT, text TEXT, attributedBody BLOB,
                           date INTEGER, is_from_me INTEGER, handle_id INTEGER);
      CREATE TABLE chat_message_join(chat_id INTEGER, message_id INTEGER);
    """)
    c.execute("INSERT INTO handle VALUES(1,'+15550001111')")
    c.execute("INSERT INTO chat VALUES(1,'iMessage;+;legacy','+15550001111','Legacy')")
    c.execute("INSERT INTO message(ROWID,guid,text,date,is_from_me,handle_id) "
              "VALUES(1,'lg1','hi',600000000000000000,0,1)")
    c.execute("INSERT INTO chat_message_join VALUES(1,1)")
    c.commit(); c.close()
    out = dec.decode(_obs(path), DESC)
    assert out["rejections"] == []
    assert _reaction_atoms(out) == []
    assert len(out["atoms"]) == 1


# ---------------------------------------------------------------------------
# BOUNDED SIDEBAR SUMMARY — decode_summary is the O(threads x tail) counterpart
# of the O(all-messages) decode(). It must be BYTE-EQUIVALENT to decode() for
# every field the sidebar renders (session_id, title, subtitle, atom_count,
# send_ref, started_at, last_activity_at) while materialising only the newest
# `tail` messages per thread — so it can never starve the serial workflow slot
# and hang interactive transcript reads (a bound on the work, not a patch on one reader).
# ---------------------------------------------------------------------------
def _by_session(out):
    return {t["session_id"]: t for t in out["threads"]}


def test_summary_matches_decode_on_every_sidebar_field():
    db = _fixture_db()
    full = _by_session(dec.decode(_obs(db), DESC))
    summ = _by_session(dec.decode_summary(_obs(db), DESC, tail=6))
    # SAME set of threads and identity — a summary row still resolves on click.
    assert set(summ) == set(full) == {"iMessage;+;chat1", "iMessage;-;chat2"}
    for sid in full:
        f, s = full[sid], summ[sid]
        assert s["presentation"]["title"] == f["presentation"]["title"]
        assert s["presentation"]["subtitle"] == f["presentation"]["subtitle"]
        assert s["thread_ref"] == f["thread_ref"]
        # WHOLE-thread total, not the tail length.
        assert s["atom_count"] == f["atom_count"]
        assert s["started_at"] == f["started_at"]
        assert s["last_activity_at"] == f["last_activity_at"]
        assert s.get("send_ref") == f.get("send_ref")


def _long_thread_db(n=12):
    """One thread with n bodied inbound/outbound messages, so tail < n proves
    the summary carries whole-thread totals while materialising only the tail."""
    path, c = _new_db()
    c.execute("INSERT INTO handle VALUES(1,'+15559990000')")
    c.execute("INSERT INTO chat VALUES(1,'iMessage;+;long','+15559990000','Long Thread')")
    base = 600000000000000000
    for i in range(1, n + 1):
        _msg(c, i, f"lg{i}", f"message number {i}", base + i * 1000000, i % 2, 1 if i % 2 == 0 else None)
    for i in range(1, n + 1):
        c.execute("INSERT INTO chat_message_join VALUES(1,?)", (i,))
    c.commit(); c.close()
    return path


def test_summary_is_bounded_atom_count_is_whole_thread_not_tail():
    db = _long_thread_db(12)
    out = dec.decode_summary(_obs(db), DESC, tail=3)
    t = out["threads"][0]
    # atom_count DECLARES the whole thread (12) though only the tail was read.
    assert t["atom_count"] == 12
    # Only `tail` messages were ever materialised into Python atoms — this is the
    # bound that keeps the projection O(threads x tail), never O(all-messages).
    assert len(out["atoms"]) == 3
    # Subtitle is still the NEWEST message (proves tail ordering is correct).
    assert t["presentation"]["subtitle"] == "message number 12"


def test_summary_group_thread_has_no_send_ref():
    db = _group_db()
    summ = dec.decode_summary(_obs(db), DESC, tail=6)
    assert len(summ["threads"]) == 1
    assert "send_ref" not in summ["threads"][0]


def test_summary_unreadable_db_is_rejection_not_crash():
    out = dec.decode_summary(_obs("/nonexistent/path/chat.db"), DESC)
    assert out["threads"] == [] and out["atoms"] == []
    assert len(out["rejections"]) == 1
    assert out["rejections"][0]["violation_path"] == "native_ref"


def test_summary_default_tail_when_bad_arg():
    # A non-positive / non-int tail falls back to the default (6), never a crash
    # or an empty projection (blind-parser rule).
    db = _fixture_db()
    for bad in (0, -3, None, "x"):
        out = dec.decode_summary(_obs(db), DESC, tail=bad)
        assert set(_by_session(out)) == {"iMessage;+;chat1", "iMessage;-;chat2"}
