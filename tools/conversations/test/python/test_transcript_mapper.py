# tools/conversations/test/python/test_transcript_mapper.py
#
# Offline proof of the canonical conversation mapping contract. Pure dict
# fixtures — NO source, NO network, NO FDA. Proves atom identity, speaker_ref,
# presentation, non-text skipping, multi-thread fan-out, rejections, and window
# paging, PLUS the cross-path identity-stability invariant (an atom produced by
# map_transcript has the SAME atom_ref as when produced by a paged map_window).
#
# Run:  python3 run_tests.py test_transcript_mapper.py
import os

import support  # noqa: E402,F401  (read-data on the import path)
from content_identity import content_hash  # noqa: E402
import transcript_mapper as tm  # noqa: E402

OBS = {"source_ref": "source:instagram:acct1", "native_ref": "/vault/ig/acct1/session.json",
       "batch_ref": "batch:xyz", "observed_at": "2026-07-03T00:00:00Z"}
DESC = {"display_mark_ref": "mark:instagram"}


def _thread(session_id, msgs, title=None):
    return {"session_id": session_id, "title": title,
            "messages": [dict(index=i, **m) for i, m in enumerate(msgs)]}


def test_basic_two_atoms_one_thread():
    spec = _thread("t1", [
        {"speaker": "me", "text": "hey", "at": "2026-07-01T10:00:00Z"},
        {"speaker": "alice", "text": "yo", "at": "2026-07-01T10:01:00Z"},
    ], title="alice")
    out = tm.map_transcript(OBS, DESC, [spec])
    assert len(out["threads"]) == 1 and len(out["atoms"]) == 2 and out["rejections"] == []
    thr = out["threads"][0]
    assert thr["thread_ref"] == "thread:source:instagram:acct1:t1"
    assert thr["session_id"] == "t1"
    assert thr["native_ref"] == "/vault/ig/acct1/session.json"
    assert thr["atom_count"] == 2
    assert thr["presentation"]["mark_ref"] == "mark:instagram"
    assert thr["presentation"]["title"] == "alice"
    assert thr["presentation"]["subtitle"] == "yo"  # last atom text
    assert thr["presentation"]["at"] == "2026-07-01T10:01:00Z"
    assert thr["started_at"] == "2026-07-01T10:00:00Z"
    assert thr["last_activity_at"] == "2026-07-01T10:01:00Z"


def test_atom_identity_and_speaker_ref_format():
    spec = _thread("t1", [{"speaker": "me", "text": "hey", "at": "2026-07-01T10:00:00Z"}])
    atom = tm.map_transcript(OBS, DESC, [spec])["atoms"][0]
    expected_id = content_hash(b'["thread:source:instagram:acct1:t1","source-index",0]')
    assert atom["atom_ref"] == f"atom:{expected_id}"
    assert atom["speaker_ref"] == "speaker:source:instagram:acct1:me"
    assert atom["kind"] == "utterance"
    assert atom["content"] == {"text": "hey"}
    assert atom["observation_refs"] == ["batch:xyz"]
    assert atom["source_ref"] == "source:instagram:acct1"


def test_occurrences_survive_full_content_edits_without_merging_repeated_events():
    prefix = "same prefix " * 20
    spec = _thread("stable", [
        {"native_ref": "message-a", "speaker": "me", "text": prefix + "one"},
        {"native_ref": "message-b", "speaker": "me", "text": prefix + "one"},
    ])
    before = tm.map_transcript(OBS, DESC, [spec])["atoms"]
    assert before[0]["atom_ref"] != before[1]["atom_ref"]
    spec["messages"][0]["text"] = prefix + "two"
    spec["messages"][0]["index"] = 100
    after = tm.map_transcript(OBS, DESC, [spec])["atoms"]
    assert after[0]["atom_ref"] == before[0]["atom_ref"]
    assert after[0]["content_revision"] != before[0]["content_revision"]
    assert after[1]["content_revision"] == before[1]["content_revision"]


def test_relation_resolution_changes_revision_without_changing_occurrence():
    reaction = {"native_ref": "reaction-one", "kind": "reaction", "speaker": "me",
                "reaction_symbol": "+1", "relations": [{"target_native_ref": "message-one"}]}
    alone = tm.map_transcript(OBS, DESC, [_thread("relations", [reaction])])["atoms"][0]
    together = tm.map_transcript(OBS, DESC, [_thread("relations", [
        {"native_ref": "message-one", "speaker": "them", "text": "hello"}, reaction,
    ])])["atoms"][1]
    assert alone["atom_ref"] == together["atom_ref"]
    assert "target_atom_ref" not in alone["relations"][0]
    assert together["relations"][0]["target_atom_ref"]
    assert alone["content_revision"] != together["content_revision"]


def test_skips_non_text_and_drops_empty_thread():
    spec = _thread("t1", [
        {"speaker": "me", "text": None, "at": "2026-07-01T10:00:00Z"},   # media-only
        {"speaker": "me", "text": "   ", "at": "2026-07-01T10:00:01Z"},  # whitespace
    ])
    out = tm.map_transcript(OBS, DESC, [spec])
    assert out["threads"] == [] and out["atoms"] == []
    # a thread with ONE text msg among media survives with exactly 1 atom
    spec2 = _thread("t2", [
        {"speaker": "me", "text": None, "at": "2026-07-01T10:00:00Z"},
        {"speaker": "bob", "text": "real", "at": "2026-07-01T10:00:02Z"},
    ])
    out2 = tm.map_transcript(OBS, DESC, [spec2])
    assert len(out2["threads"]) == 1 and out2["threads"][0]["atom_count"] == 1


def test_multi_thread_fan_out_and_rejection():
    good = _thread("a", [{"speaker": "me", "text": "x", "at": None}])
    bad = {"session_id": "", "messages": [{"index": 0, "speaker": "me", "text": "y"}]}
    out = tm.map_transcript(OBS, DESC, [good, bad])
    assert len(out["threads"]) == 1 and out["threads"][0]["session_id"] == "a"
    assert len(out["rejections"]) == 1
    assert out["rejections"][0]["violation_path"] == "thread_spec.session_id"


def test_send_ref_carried_opaquely_when_adapter_resolves_it():
    # A source adapter that resolved a single-recipient reply handle sets `send_ref`
    # on the thread spec; the mapper carries it verbatim onto the thread and never
    # interprets it. Threads without it stay read-only.
    spec = _thread("t1", [{"speaker": "me", "text": "hi", "at": None}])
    spec["send_ref"] = "+15550100123"
    thr = tm.map_transcript(OBS, DESC, [spec])["threads"][0]
    assert thr["send_ref"] == "+15550100123"


def test_send_ref_absent_yields_read_only_thread():
    spec = _thread("t1", [{"speaker": "me", "text": "hi", "at": None}])
    thr = tm.map_transcript(OBS, DESC, [spec])["threads"][0]
    assert "send_ref" not in thr


def test_map_page_metadata():
    # Adapter pre-paged: newest 2 of 5 (start_index=3, total=5)
    page = [{"index": 3, "speaker": "me", "text": "m3", "at": "2026-07-01T10:03:00Z"},
            {"index": 4, "speaker": "me", "text": "m4", "at": "2026-07-01T10:04:00Z"}]
    w = tm.map_page(OBS, DESC, "t1", "alice", page, start_index=3, total_count=5)
    assert w["total_count"] == 5
    assert [a["content"]["text"] for a in w["atoms"]] == ["m3", "m4"]
    assert w["has_older"] is True and w["older_cursor"] == 3 and w["has_newer"] is False
    # an older page (start_index=1, total=5) has both older and newer
    page2 = [{"index": 1, "speaker": "me", "text": "m1", "at": None},
             {"index": 2, "speaker": "me", "text": "m2", "at": None}]
    w2 = tm.map_page(OBS, DESC, "t1", "alice", page2, start_index=1, total_count=5)
    assert w2["has_older"] is True and w2["older_cursor"] == 1 and w2["has_newer"] is True
    # first page (start_index=0): no older
    w3 = tm.map_page(OBS, DESC, "t1", "alice", page2, start_index=0, total_count=5)
    assert w3["has_older"] is False and w3["older_cursor"] is None and w3["has_newer"] is True


def test_identity_stable_across_transcript_and_page():
    # The SAME message must get the SAME atom_ref via map_transcript OR map_page —
    # the adapter-assigned `index` guarantees it.
    msgs = [{"index": i, "speaker": "me", "text": f"m{i}", "at": None} for i in range(5)]
    spec = {"session_id": "t1", "title": "t", "messages": msgs}
    full = {a["content"]["text"]: a["atom_ref"]
            for a in tm.map_transcript(OBS, DESC, [spec])["atoms"]}
    page = msgs[3:5]  # adapter page carrying absolute indices 3,4
    win = {a["content"]["text"]: a["atom_ref"]
           for a in tm.map_page(OBS, DESC, "t1", "t", page, start_index=3, total_count=5)["atoms"]}
    for text, ref in win.items():
        assert full[text] == ref, f"identity drift for {text}"


def test_cli_round_trip(tmp_path=None):
    # Exercises main(): a Node/non-Python adapter invokes the mapper via the CLI
    # (request.json -> out.json). Proves the CLI produces the same atoms.
    import json
    import tempfile
    d = tempfile.mkdtemp()
    req = os.path.join(d, "req.json")
    out = os.path.join(d, "out.json")
    spec = _thread("t1", [{"speaker": "me", "text": "hey", "at": "2026-07-01T10:00:00Z"}])
    with open(req, "w") as f:
        json.dump({"observation": OBS, "descriptor": DESC, "thread_specs": [spec]}, f)
    rc = tm.main(["transcript_mapper.py", req, out])
    assert rc == 0
    with open(out) as output_file:
        result = json.load(output_file)
    assert len(result["threads"]) == 1 and len(result["atoms"]) == 1
    assert result["atoms"][0]["speaker_ref"] == "speaker:source:instagram:acct1:me"
    # page mode via CLI (adapter pre-paged)
    with open(req, "w") as f:
        json.dump({"mode": "page", "observation": OBS, "descriptor": DESC,
                   "session_id": "t1", "title": "a",
                   "page_messages": [{"index": 0, "speaker": "me", "text": "hey", "at": None}],
                   "start_index": 0, "total_count": 1}, f)
    assert tm.main(["transcript_mapper.py", req, out]) == 0
    with open(out) as output_file:
        assert json.load(output_file)["total_count"] == 1
