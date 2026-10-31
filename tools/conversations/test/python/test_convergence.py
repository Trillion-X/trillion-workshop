# tools/conversations/test/python/test_convergence.py
#
# Gauntlet for PROVENANCE-RANKED CONTENT CONVERGENCE — the generative primitive
# that lets the same utterance observed by two sources (an OPTIMISTIC outbound
# egress row + the AUTHORITATIVE native echo) render ONCE, while two genuinely
# distinct utterances (a real double "ok", two real sends of one body) render
# TWICE. Pure dict fixtures — NO source, NO network, NO FDA.
#
# The gauntlet composes op x op in the most hostile combinations: if any
# needs a special case the primitive is incomplete. The FAIL-SAFE direction is
# proven explicitly: a convergence miss yields a harmless DUPLICATE, never a
# hidden/lost message.
#
# Run:  python3 run_tests.py test_convergence.py
import os

import support  # noqa: E402,F401  (read-data on the import path)
import transcript_mapper as tm  # noqa: E402

SRC = "source:imessage:default"
GUID = "chat-guid-1"
THREAD = f"thread:{SRC}:{GUID}"


def _atom(text, rank, thread_ref=THREAD, role="me", at=None, ref=None, obs=None):
    """Build a canonical atom directly for precise combinatorial control."""
    return {
        "atom_ref": ref or f"atom:test:{text}:{rank}:{at}",
        "thread_ref": thread_ref,
        "kind": "utterance",
        "speaker_ref": f"speaker:{SRC}:{role}",
        "at": at,
        "content": {"text": text},
        "relations": [],
        "source_ref": SRC,
        "observation_refs": obs or [f"batch:{rank}"],
        "provenance": rank,
    }


def _texts(atoms):
    return [a["content"]["text"] for a in atoms]


# ---------------------------------------------------------------------------
# Headline: optimistic outbound converges with authoritative native echo
# ---------------------------------------------------------------------------
def test_optimistic_collapses_into_authoritative_echo():
    optimistic = _atom("ok", tm.OPTIMISTIC, at="2026-07-04T10:00:00Z", ref="atom:opt")
    native = _atom("ok", tm.AUTHORITATIVE, at="2026-07-04T10:00:02Z", ref="atom:native")
    out = tm.converge_atoms([optimistic, native])
    assert len(out) == 1, out
    survivor = out[0]
    # the AUTHORITATIVE copy wins — its identity + real chat.db timestamp survive
    assert survivor["atom_ref"] == "atom:native"
    assert survivor["at"] == "2026-07-04T10:00:02Z"
    assert survivor["provenance"] == tm.AUTHORITATIVE
    # the optimistic provenance trail is folded on, not lost
    assert survivor["converged_from"] == ["atom:opt"]
    assert set(survivor["observation_refs"]) >= {"batch:0", "batch:10"}


def test_order_independent_optimistic_first_or_last():
    optimistic = _atom("hey", tm.OPTIMISTIC, at="2026-07-04T10:00:00Z", ref="atom:opt")
    native = _atom("hey", tm.AUTHORITATIVE, at="2026-07-04T10:00:02Z", ref="atom:native")
    for pair in ([optimistic, native], [native, optimistic]):
        out = tm.converge_atoms(pair)
        assert len(out) == 1 and out[0]["atom_ref"] == "atom:native"


# ---------------------------------------------------------------------------
# Never merge genuinely distinct utterances (equal rank => no collapse)
# ---------------------------------------------------------------------------
def test_real_double_authoritative_preserved():
    # user genuinely said "ok" twice; both are native/authoritative -> equal rank
    a = _atom("ok", tm.AUTHORITATIVE, at="2026-07-04T10:00:00Z", ref="a1")
    b = _atom("ok", tm.AUTHORITATIVE, at="2026-07-04T10:05:00Z", ref="a2")
    out = tm.converge_atoms([a, b])
    assert len(out) == 2 and _texts(out) == ["ok", "ok"]


def test_two_real_optimistic_sends_preserved():
    # two real sends of the same body, neither echoed yet -> equal rank -> keep both
    a = _atom("on my way", tm.OPTIMISTIC, at="2026-07-04T10:00:00Z", ref="o1")
    b = _atom("on my way", tm.OPTIMISTIC, at="2026-07-04T10:02:00Z", ref="o2")
    out = tm.converge_atoms([a, b])
    assert len(out) == 2


# ---------------------------------------------------------------------------
# 1:1 greedy — one echo must not swallow two real sends (fail-safe direction)
# ---------------------------------------------------------------------------
def test_one_echo_absorbs_only_one_of_two_real_sends():
    # two real sends of "ping"; only the FIRST has a native echo so far.
    native = _atom("ping", tm.AUTHORITATIVE, at="2026-07-04T10:00:03Z", ref="n1")
    send1 = _atom("ping", tm.OPTIMISTIC, at="2026-07-04T10:00:00Z", ref="o1")
    send2 = _atom("ping", tm.OPTIMISTIC, at="2026-07-04T10:00:01Z", ref="o2")
    out = tm.converge_atoms([send1, send2, native])
    # 2 visible: the echo (authoritative) + the still-un-echoed second real send.
    # NEVER 1 (that would HIDE a real send). Fail-safe = duplicate, never loss.
    assert len(out) == 2
    ranks = sorted(a["provenance"] for a in out)
    assert ranks == [tm.OPTIMISTIC, tm.AUTHORITATIVE]


# ---------------------------------------------------------------------------
# Fail-to-show, not fail-to-send: an un-echoed optimistic send stays visible
# ---------------------------------------------------------------------------
def test_optimistic_without_echo_stays_visible():
    optimistic = _atom("still here", tm.OPTIMISTIC, at="2026-07-04T10:00:00Z", ref="o1")
    out = tm.converge_atoms([optimistic])
    assert len(out) == 1 and out[0]["provenance"] == tm.OPTIMISTIC


def test_idempotent_reconverge():
    optimistic = _atom("ok", tm.OPTIMISTIC, at="2026-07-04T10:00:00Z", ref="atom:opt")
    native = _atom("ok", tm.AUTHORITATIVE, at="2026-07-04T10:00:02Z", ref="atom:native")
    once = tm.converge_atoms([optimistic, native])
    twice = tm.converge_atoms(once)
    assert len(twice) == 1 and twice[0]["atom_ref"] == "atom:native"


# ---------------------------------------------------------------------------
# Keys that must NOT merge across their boundary
# ---------------------------------------------------------------------------
def test_different_people_same_text_not_merged():
    # same thread, same text, but two DIFFERENT speakers (roles) -> distinct keys
    me = _atom("thanks", tm.OPTIMISTIC, role="me", ref="m")
    them = _atom("thanks", tm.AUTHORITATIVE, role="+12025550111", ref="t")
    out = tm.converge_atoms([me, them])
    assert len(out) == 2


def test_different_thread_same_text_not_merged():
    a = _atom("hello", tm.OPTIMISTIC, thread_ref=f"thread:{SRC}:chatA", ref="a")
    b = _atom("hello", tm.AUTHORITATIVE, thread_ref=f"thread:{SRC}:chatB", ref="b")
    out = tm.converge_atoms([a, b])
    assert len(out) == 2


# ---------------------------------------------------------------------------
# Normalization: trivially-different renderings of the same utterance converge
# ---------------------------------------------------------------------------
def test_casefold_and_whitespace_normalized_for_convergence():
    optimistic = _atom("OK  Sounds   good", tm.OPTIMISTIC, at="2026-07-04T10:00:00Z", ref="o")
    native = _atom("ok sounds good", tm.AUTHORITATIVE, at="2026-07-04T10:00:02Z", ref="n")
    out = tm.converge_atoms([optimistic, native])
    assert len(out) == 1 and out[0]["atom_ref"] == "n"


# ---------------------------------------------------------------------------
# Provenance default: absent -> AUTHORITATIVE (pre-existing single-source decoders
# get IDENTICAL behaviour — two absent-provenance identical atoms never merge)
# ---------------------------------------------------------------------------
def test_absent_provenance_defaults_authoritative_never_merges():
    a = {**_atom("hi", tm.AUTHORITATIVE, ref="a1")}
    b = {**_atom("hi", tm.AUTHORITATIVE, ref="a2")}
    del a["provenance"]
    del b["provenance"]
    out = tm.converge_atoms([a, b])
    assert len(out) == 2  # both default to authoritative -> equal rank -> kept


def test_build_atoms_default_rank_is_authoritative():
    atoms, _ = tm._build_atoms(SRC, THREAD, "batch:x",
                               [{"index": 0, "speaker": "me", "text": "hi"}])
    assert atoms[0]["provenance"] == tm.AUTHORITATIVE


# ---------------------------------------------------------------------------
# Purity + ordering
# ---------------------------------------------------------------------------
def test_convergence_does_not_mutate_input():
    # in-window timestamps => a REAL merge happens; prove the INPUT atoms are
    # still untouched (purity during an actual collapse, not just a no-op).
    optimistic = _atom("ok", tm.OPTIMISTIC, at="2026-07-04T10:00:00Z", ref="o")
    native = _atom("ok", tm.AUTHORITATIVE, at="2026-07-04T10:00:02Z", ref="n")
    before = (dict(optimistic), dict(native))
    merged = tm.converge_atoms([optimistic, native])
    assert len(merged) == 1 and merged[0]["converged_from"] == ["o"]
    assert optimistic == before[0] and native == before[1]
    assert "converged_from" not in optimistic and "converged_from" not in native


def test_kept_order_preserved():
    a = _atom("first", tm.AUTHORITATIVE, at="2026-07-04T10:00:00Z", ref="a")
    opt = _atom("dup", tm.OPTIMISTIC, at="2026-07-04T10:00:01Z", ref="o")
    nat = _atom("dup", tm.AUTHORITATIVE, at="2026-07-04T10:00:02Z", ref="n")
    c = _atom("last", tm.AUTHORITATIVE, at="2026-07-04T10:00:03Z", ref="c")
    out = tm.converge_atoms([a, opt, nat, c])
    assert _texts(out) == ["first", "dup", "last"]


def test_empty_and_single_are_noops():
    assert tm.converge_atoms([]) == []
    one = _atom("solo", tm.OPTIMISTIC, ref="s")
    assert tm.converge_atoms([one]) == [one]


# ---------------------------------------------------------------------------
# End-to-end through the REAL mapper: two observations sharing source+session
# (projection-keyed convergence) produce convergeable atoms.
# ---------------------------------------------------------------------------
def test_end_to_end_projection_keyed_convergence():
    desc = {"display_mark_ref": "mark:imessage"}
    # native observation (authoritative, provenance absent)
    native_obs = {"source_ref": SRC, "batch_ref": "batch:native",
                  "observed_at": "2026-07-04T10:00:02Z"}
    native_spec = {"session_id": GUID, "title": "Mom",
                   "messages": [{"index": 0, "speaker": "me", "text": "omw",
                                 "at": "2026-07-04T10:00:02Z"}]}
    native = tm.map_transcript(native_obs, desc, [native_spec])["atoms"]
    # optimistic observation PROJECTED onto the SAME source_ref + session_id
    opt_obs = {"source_ref": SRC, "batch_ref": "batch:egress",
               "observed_at": "2026-07-04T10:00:00Z", "provenance": tm.OPTIMISTIC}
    opt_spec = {"session_id": GUID, "title": "Mom", "send_ref": "+15550100123",
                "messages": [{"index": 0, "speaker": "me", "text": "omw",
                              "at": "2026-07-04T10:00:00Z"}]}
    optimistic = tm.map_transcript(opt_obs, desc, [opt_spec])["atoms"]
    assert optimistic[0]["provenance"] == tm.OPTIMISTIC
    # SAME thread_ref (projection-keyed) is what makes them converge
    assert optimistic[0]["thread_ref"] == native[0]["thread_ref"] == THREAD
    out = tm.converge_atoms(optimistic + native)
    assert len(out) == 1 and out[0]["provenance"] == tm.AUTHORITATIVE


# ---------------------------------------------------------------------------
# TEMPORAL WINDOW — the time-blind convergence defect (auditor repro).
#
# content_key is (thread_ref, role, normalized_text) — deliberately time-BLIND
# so trivially-different renderings converge. But WITHOUT a temporal guard, a
# brand-new message that happens to share thread+role+text with an unrelated
# HISTORICAL message was silently absorbed (HIDDEN). The echo-delay window
# (DATA tolerance, default 300s) is the discriminant: the native echo lands
# seconds after the local send; a week-old same-body message is out of window.
# ---------------------------------------------------------------------------
def test_time_blind_defect_distant_same_body_not_merged():
    # AUTHORITATIVE "ok" said last week; a NEW optimistic "ok" sent today.
    # 7-day gap >> 300s window => the today message must NOT be hidden.
    old = _atom("ok", tm.AUTHORITATIVE, at="2026-06-27T09:00:00Z", ref="old")
    new_opt = _atom("ok", tm.OPTIMISTIC, at="2026-07-04T15:00:00Z", ref="new")
    out = tm.converge_atoms([old, new_opt])
    assert len(out) == 2, out  # 2 survivors, NOT 1 — the new send is visible
    assert set(a["atom_ref"] for a in out) == {"old", "new"}


def test_close_historical_authoritative_before_new_optimistic_not_merged():
    # THE DIRECTIONAL DEFECT (worse than the distant case above, because it lands
    # INSIDE the 300s window in the WRONG time direction): an AUTHORITATIVE "ok"
    # said at 10:00:00, then a genuinely NEW optimistic "ok" SENT at 10:04:59 —
    # only 299s later, WITHIN the window. A symmetric `abs(delta) <= window` guard
    # would let the OLDER authoritative atom (higher rank => the absorber) swallow
    # the NEWER optimistic send, HIDING a real just-sent message (the forbidden
    # failure direction). The directional guard (0 <= higher_epoch - lower_epoch
    # <= window) declines backward-time absorption: absorber(old 10:00:00) minus
    # absorbed(new 10:04:59) = -299 < 0 => no merge => the new send stays VISIBLE.
    old_auth = _atom("ok", tm.AUTHORITATIVE, at="2026-07-04T10:00:00Z", ref="old-auth")
    new_opt = _atom("ok", tm.OPTIMISTIC, at="2026-07-04T10:04:59Z", ref="new-send")
    out = tm.converge_atoms([old_auth, new_opt])
    assert len(out) == 2, out  # 2 survivors — the new optimistic send is NOT hidden
    assert set(a["atom_ref"] for a in out) == {"old-auth", "new-send"}
    # and NEITHER survivor may have absorbed the other (no converged_from trail).
    assert all(not a.get("converged_from") for a in out), out
    # Order-independent: the same wrong-direction pair fed in reverse still declines.
    assert len(tm.converge_atoms([new_opt, old_auth])) == 2


def test_forward_echo_still_converges_after_directional_fix():
    # The directional guard must NOT break the real case it exists for: the native
    # echo lands AFTER the optimistic send. absorber(echo 10:00:02) minus
    # absorbed(send 10:00:00) = +2 in [0,300] => converge to ONE AUTHORITATIVE.
    opt = _atom("omw", tm.OPTIMISTIC, at="2026-07-04T10:00:00Z", ref="opt")
    echo = _atom("omw", tm.AUTHORITATIVE, at="2026-07-04T10:00:02Z", ref="echo")
    out = tm.converge_atoms([opt, echo])
    assert len(out) == 1 and out[0]["atom_ref"] == "echo"
    assert out[0]["converged_from"] == ["opt"]


def test_missing_timestamp_fails_safe_to_duplicate():
    # a convergence candidate with NO parseable timestamp must DECLINE the merge
    # (fail-safe = harmless visible duplicate, never a hidden/lost message).
    opt = _atom("ok", tm.OPTIMISTIC, at=None, ref="o")
    nat = _atom("ok", tm.AUTHORITATIVE, at="2026-07-04T10:00:02Z", ref="n")
    assert len(tm.converge_atoms([opt, nat])) == 2
    # both missing -> also no merge
    opt2 = _atom("ok", tm.OPTIMISTIC, at="not-a-timestamp", ref="o2")
    nat2 = _atom("ok", tm.AUTHORITATIVE, at=None, ref="n2")
    assert len(tm.converge_atoms([opt2, nat2])) == 2


def test_window_boundary_inclusive_and_out_of_window_declines():
    # exactly at the window edge (300s) converges; one second past it does not.
    at_edge_opt = _atom("edge", tm.OPTIMISTIC, at="2026-07-04T10:00:00Z", ref="e0")
    at_edge_nat = _atom("edge", tm.AUTHORITATIVE, at="2026-07-04T10:05:00Z", ref="e1")
    assert len(tm.converge_atoms([at_edge_opt, at_edge_nat])) == 1
    past_opt = _atom("past", tm.OPTIMISTIC, at="2026-07-04T10:00:00Z", ref="p0")
    past_nat = _atom("past", tm.AUTHORITATIVE, at="2026-07-04T10:05:01Z", ref="p1")
    assert len(tm.converge_atoms([past_opt, past_nat])) == 2


def test_window_is_data_tunable():
    # the tolerance is DATA (window_seconds), not a hardcoded constant: a 10s
    # window declines a 30s-apart pair that the default 300s window would merge.
    opt = _atom("tune", tm.OPTIMISTIC, at="2026-07-04T10:00:00Z", ref="t0")
    nat = _atom("tune", tm.AUTHORITATIVE, at="2026-07-04T10:00:30Z", ref="t1")
    assert len(tm.converge_atoms([opt, nat], window_seconds=10)) == 2
    assert len(tm.converge_atoms([opt, nat], window_seconds=300)) == 1
    # a non-positive / unparseable window falls back to the safe default, never
    # disabling the guard (0 would otherwise merge NOTHING or EVERYTHING).
    assert len(tm.converge_atoms([opt, nat], window_seconds=0)) == 1
    assert len(tm.converge_atoms([opt, nat], window_seconds="junk")) == 1


# ---------------------------------------------------------------------------
# PROVISIONAL tier — a true 3-rank single-utterance ladder collapses to ONE
# AUTHORITATIVE survivor (proves the rank ladder is DATA, not a 2-value enum).
# ---------------------------------------------------------------------------
def test_three_tier_provenance_ladder_collapses_to_one():
    optimistic = _atom("omw", tm.OPTIMISTIC, at="2026-07-04T10:00:00Z", ref="opt")
    provisional = _atom("omw", tm.PROVISIONAL, at="2026-07-04T10:00:01Z", ref="prov")
    authoritative = _atom("omw", tm.AUTHORITATIVE, at="2026-07-04T10:00:03Z", ref="auth")
    out = tm.converge_atoms([optimistic, provisional, authoritative])
    assert len(out) == 1
    survivor = out[0]
    assert survivor["atom_ref"] == "auth"
    assert survivor["provenance"] == tm.AUTHORITATIVE
    # both lower-rank copies fold their trail onto the single survivor
    assert set(survivor["converged_from"]) == {"opt", "prov"}


def test_cli_converge_round_trip():
    import json
    import tempfile
    d = tempfile.mkdtemp()
    req, out = os.path.join(d, "req.json"), os.path.join(d, "out.json")
    optimistic = _atom("ok", tm.OPTIMISTIC, at="2026-07-04T10:00:00Z", ref="atom:opt")
    native = _atom("ok", tm.AUTHORITATIVE, at="2026-07-04T10:00:02Z", ref="atom:native")
    with open(req, "w") as f:
        json.dump({"mode": "converge", "atoms": [optimistic, native]}, f)
    assert tm.main(["transcript_mapper.py", req, out]) == 0
    result = json.load(open(out))
    assert len(result["atoms"]) == 1 and result["atoms"][0]["atom_ref"] == "atom:native"
