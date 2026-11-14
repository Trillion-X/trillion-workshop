#!/usr/bin/env python3
# packages/motion-analysis/do-work/process-scripts/match/test_point_outcome.py
#
# CV10 acceptance (plan §24.10):
#   - a clear OUT with attribution -> winner = the OTHER side, confidence >= 0.92,
#     a live-score-event.draft is produced (for live-match-score.record-event)
#   - the SAME OUT WITHOUT attribution -> needs_human_confirmation, NO draft
#   - an ambiguous / unknown terminal -> needs_human_confirmation, NO draft
#   - NO-GOD-PACKAGE: the leaf NEVER returns a score/points/games — only a draft
#     event; scoring stays in live-match-score
#
# Run: python3 test_point_outcome.py

from dataclasses import asdict

from point_outcome import reduce_point_outcome


def main():
    # 1) clear OUT, attributed: near player hit it out -> far wins
    facts = [
        {"kind": "perception.ball.bounce", "frame": 30, "event_confidence": 0.95, "fact_id": "b1"},
        {"kind": "perception.line_call", "frame": 31, "call": "OUT", "call_confidence": 0.96,
         "hitter_side": "near", "fact_id": "lc1"},
    ]
    o = reduce_point_outcome(facts)
    assert o.winner_side == "far", o
    assert o.reason == "out", o
    assert o.confidence >= 0.92, o
    assert o.draft_event is not None and o.draft_event["winner_side"] == "far", o
    assert o.needs_human_confirmation is False, o

    # 2) same OUT, NO attribution -> can't name a winner -> fail closed
    facts_noattr = [{"kind": "perception.line_call", "frame": 31, "call": "OUT",
                     "call_confidence": 0.96, "fact_id": "lc1"}]
    o2 = reduce_point_outcome(facts_noattr)
    assert o2.winner_side is None, o2
    assert o2.draft_event is None, o2
    assert o2.needs_human_confirmation is True, o2

    # 3) NEEDS_YOUR_CALL line -> ambiguous -> human
    facts_amb = [{"kind": "perception.line_call", "frame": 20, "call": "NEEDS_YOUR_CALL",
                  "call_confidence": 0.0, "hitter_side": "far", "fact_id": "lc2"}]
    o3 = reduce_point_outcome(facts_amb)
    assert o3.needs_human_confirmation is True and o3.draft_event is None, o3

    # 4) empty / unknown -> human
    assert reduce_point_outcome([]).needs_human_confirmation is True

    # 5) explicit terminal (double bounce) with winner -> confident
    facts_db = [{"kind": "perception.point.terminal", "frame": 40, "reason": "double-bounce",
                 "winner_side": "near", "event_confidence": 0.94, "fact_id": "t1"}]
    o5 = reduce_point_outcome(facts_db)
    assert o5.winner_side == "near" and o5.reason == "double-bounce" and o5.draft_event is not None, o5

    # 6) NO-GOD-PACKAGE: the outcome NEVER carries a score/points/games field
    for oc in (o, o5):
        d = asdict(oc)
        keys = set(d.keys()) | set((oc.draft_event or {}).keys())
        for banned in ("score", "points", "games", "sets", "game_score"):
            assert banned not in keys, f"leaf leaked scoring field {banned!r} — that's live-match-score's job"

    print("CV10 PASS — point-outcome reducer (fail-closed, no god package)")
    print(f"  attributed OUT -> winner {o.winner_side}, conf {o.confidence}, draft event produced")
    print(f"  unattributed OUT -> needs_human_confirmation (no winner invented)")
    print(f"  ambiguous/empty -> needs_human_confirmation")
    print(f"  leaf emits a live-score-event.draft ONLY — never a score (live-match-score owns scoring) ✓")


if __name__ == "__main__":
    main()
