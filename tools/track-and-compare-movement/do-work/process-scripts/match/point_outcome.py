#!/usr/bin/env python3
# packages/motion-analysis/do-work/process-scripts/match/point_outcome.py
#
# =============================================================================
# PURPOSE — CV10 (plan §24.5.5): the point-outcome reducer — NO GOD PACKAGE
# =============================================================================
#
# Vision must NOT own tennis scoring. `live-match-score` already derives
# points/games/sets/tiebreak/match from scoring-rule DATA. This leaf reduces a
# window of perception facts (line-calls, bounces, serve context) for ONE point
# into a `perception.point.outcome` — {winner_side, reason, evidence_refs,
# confidence} — and, only when confident, a `live-score-event.draft` for
# `live-match-score.record-event`. It NEVER mutates score state and NEVER
# computes the score itself (that crosses the package boundary = god package).
#
# Fail-closed (plan §24.5.6): a single monocular feed often cannot prove a touch,
# net-cord, let, or who actually struck the ball. Only an outcome with
# confidence >= `min_confidence` (0.92) may draft a score event; everything else
# is `needs_human_confirmation` with NO draft. A terminal `reason` is required —
# we never invent a winner from a missing signal.
#
# Reasons (DATA-driven, open set — not a closed enum baked in scoring logic):
#   out, winner-not-returned, double-bounce, serve-fault, double-fault, unknown
# `winner_side` requires shot ATTRIBUTION (which side struck the terminal ball).
# Today's court/ball vision does not attribute shots to a player, so live this
# fails closed; the leaf is ready for when attribution facts exist (CV-future).
#
# Pure leaf: zero I/O, zero scoring. Offline-testable (test_point_outcome.py).
# =============================================================================

from __future__ import annotations

from dataclasses import dataclass
from typing import Optional, Sequence


@dataclass
class PointOutcome:
    winner_side: Optional[str]          # "near" | "far" | None (unknown)
    reason: str                         # terminal reason (DATA taxonomy)
    evidence_refs: list[str]            # fact_ids that justify the call
    confidence: float
    draft_event: Optional[dict]         # live-score-event.draft, or None (fail-closed)
    needs_human_confirmation: bool


def _other(side: Optional[str]) -> Optional[str]:
    return {"near": "far", "far": "near"}.get(side or "", None)


def reduce_point_outcome(
    point_facts: Sequence[dict],
    *,
    min_confidence: float = 0.92,
) -> PointOutcome:
    """Reduce one point's perception facts to an outcome. The terminal fact (the
    last meaningful event) decides the reason; attribution (`hitter_side` on the
    terminal shot/bounce/call) decides the winner. Missing attribution or an
    ambiguous terminal → needs_human_confirmation (no draft)."""
    facts = list(point_facts)
    if not facts:
        return PointOutcome(None, "unknown", [], 0.0, None, True)

    # The terminal event = the highest-frame line_call / bounce / serve fact.
    def frame_of(f):
        return f.get("frame", -1)
    terminal = max(facts, key=frame_of)
    kind = terminal.get("kind", "")
    ev = [terminal.get("fact_id") or terminal.get("kind", "?")]
    hitter = terminal.get("hitter_side")            # attribution (may be absent)
    base_conf = float(terminal.get("call_confidence", terminal.get("event_confidence", 0.0)))

    winner: Optional[str] = None
    reason = "unknown"
    conf = 0.0

    if kind == "perception.line_call":
        call = terminal.get("call")
        if call == "OUT":
            # the side that HIT the out ball loses the point
            reason = "out"
            winner = _other(hitter)
            conf = base_conf if hitter else 0.0   # no attribution => can't name a winner
        elif call == "NEEDS_YOUR_CALL":
            reason = "out"     # line itself is ambiguous -> human
            conf = 0.0
        else:  # IN: not by itself a terminal — needs a follow-up (winner-not-returned)
            reason = "winner-not-returned"
            winner = hitter
            conf = base_conf * 0.8 if hitter else 0.0
    elif kind == "perception.point.terminal":   # an explicit terminal fact (e.g. double bounce)
        reason = terminal.get("reason", "unknown")
        winner = terminal.get("winner_side") or _other(terminal.get("loser_side"))
        conf = base_conf
    else:
        reason = "unknown"
        conf = 0.0

    confident = winner is not None and conf >= min_confidence
    draft = None
    if confident:
        draft = {
            "kind": "live-score-event.draft",
            "winner_side": winner,
            "reason": reason,
            "evidence_refs": ev,
            "source": "match-perception.point-outcome.v1",
            # NOTE: this is a DRAFT for live-match-score.record-event. This leaf
            # does NOT compute points/games/sets — that is live-match-score's job.
        }
    return PointOutcome(
        winner_side=winner if confident else None,
        reason=reason,
        evidence_refs=ev,
        confidence=round(conf, 4),
        draft_event=draft,
        needs_human_confirmation=not confident,
    )
