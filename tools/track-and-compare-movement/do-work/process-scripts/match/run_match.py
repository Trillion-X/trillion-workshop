#!/usr/bin/env python3
# tools/match/run_match.py
#
# PURPOSE: The ONE match entrypoint — a subject motion descriptor (perception output) + a reference
# descriptor INDEX in, a self-describing certified-match envelope (motion-match.v1) out. It is the single
# process-job the `motion-comparison` package runs as DATA (a ProcessDescriptor); the package never knows
# the internal gates/certify/correspondence machinery, only the schema-tagged envelope.
#
# This is a THIN WRAPPER, not a reimplementation (L030 — move, don't rebuild). It calls the existing,
# proven, calibrated selection seam EXACTLY as the live drivers + the CLI already invoke it:
#   tools/match/select_partner.select(subject_desc[:win], subject_kp, win, index_dir, ...)
# select() is the 0-wrong-safe matcher: view-family + heading + elevation + salience + full-swing gates,
# the CERTIFIED worst-reliable-channel admission (motion_certify), and the ambiguity gate — returning an
# ADMISSIBLE SET ranked by the certified correspondence, or no_match (it NEVER fabricates a wrong pair).
#
# NON-NEGOTIABLE INVARIANTS:
#   * BYTE-IDENTICAL TO THE SOURCE MATCHER: run_match passes select()'s OWN defaults (the same values
#     select_partner.main() passes), so the inner `result` is byte-identical to `select_partner.py` for
#     the same inputs. This wrapper adds an envelope, it does NOT change the match (a parity test proves it).
#   * FAIL-CLOSED (mirrors run_perception): missing subject descriptor / subject pose / index, OR any
#     exception inside select(), is surfaced as a non-zero rc with a machine-readable reason — NEVER a
#     silent/partial/stale success. A no_match is a VALID success (rc 0): the matcher correctly refused;
#     the envelope carries no_match:true so the package record-maker records "no credible partner".
#   * GENERIC / no domain literals: the salient-joint crop is DATA (`--salience-config`) and the certified
#     comparison channel set is DATA (`--comparison-spec`); omitted => select()'s byte-identical tennis
#     defaults. No "tennis"/"ball"/"wrist"/"forehand" appears in this file's logic — a footwork or
#     basketball domain passes its own config + its own index, zero code change (L069 emergence).
#
# USAGE: run_match.py --subject-desc SUBJ.desc.json[:WIN] --subject-kp SUBJ.kp.json --index INDEX_DIR
#                     --out MATCH.json
#                     [--salience-config '{"salience_keypoints":["r_ankle","l_ankle"]}']
#                     [--comparison-spec '{"channels":[...],"mirror":{...},"epsilon":0.3}']
#                     [--max-dist 1.0]
#   --subject-desc may carry a ":WIN" window suffix (the swing window to match); default window 0.

from __future__ import annotations
import argparse
import json
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
# LAYOUT-AGNOSTIC: select_partner is always a sibling (source `tools/match/` AND the flat package bundle).
# Importing it (not re-implementing) is the whole point — the matcher logic has ONE home (SSOT).
sys.path.insert(0, str(HERE))

MATCH_SCHEMA = "motion-match.v1"


def log(m: str) -> None:
    print(f"[match] {m}", file=sys.stderr, flush=True)


def run_match(subject_desc: str, subject_kp: Path, index_dir: Path, out: Path,
              win: int = 0, salience_config: str | None = None,
              comparison_spec: str | None = None, max_dist: float = 1.0) -> int:
    """subject descriptor + pose + reference index -> certified-match envelope JSON. rc 0 = success
    (INCLUDING a correct no_match). Fail-closed: missing inputs => rc 2; matcher exception => rc 1."""
    # The descriptor path may carry a ":WIN" suffix (select_partner's own addressing convention).
    desc_path, _, win_suffix = str(subject_desc).partition(":")
    if win_suffix:
        try:
            win = int(win_suffix)
        except ValueError:
            log(f"REFUSED: bad window suffix in --subject-desc: {win_suffix!r}")
            return 2
    desc_file = Path(desc_path)
    subject_kp = Path(subject_kp)
    index_dir = Path(index_dir)
    out = Path(out)

    # FAIL-CLOSED input existence (never match on absent/partial inputs).
    if not desc_file.exists():
        log(f"REFUSED: subject descriptor does not exist: {desc_file}")
        return 2
    if not subject_kp.exists():
        log(f"REFUSED: subject pose (kp) does not exist: {subject_kp}")
        return 2
    if not index_dir.is_dir():
        log(f"REFUSED: reference index dir does not exist: {index_dir}")
        return 2

    # DATA seams (omitted => select()'s byte-identical tennis defaults). Bad joints/spec fail LOUD downstream.
    # "Effectively empty" (absent, blank, or JSON ""/null/{}) means "use the default", never a crash. A workflow
    # binding that stringifies an omitted config emits '""' (json.loads -> "") or 'null'/'{}'; these are the datum
    # describing itself as empty (L090), so the handler defaults instead of calling .get on a str (AttributeError)
    # or from_dict on a non-dict (L083 -1000IQ default; fail-GRACEFUL on empty). A genuinely MALFORMED (non-JSON)
    # config still raises LOUD via json.loads, and a non-dict resolves to the STRICT default (never a loosened bar,
    # preserving the iter136 safety: empty never widens the cert bar, it only re-selects the strict default).
    def _cfg(s):
        if not s or not str(s).strip():
            return None
        v = json.loads(s)                       # non-JSON garbage still raises LOUD (fail-closed on malformed)
        return v if isinstance(v, dict) and v else None
    _sal = _cfg(salience_config)
    sk = tuple(_sal["salience_keypoints"]) if _sal and _sal.get("salience_keypoints") else None
    cspec = None
    _csp = _cfg(comparison_spec)
    if _csp:
        from pose_schema import ComparisonSpec  # the ONE dict->spec parser (CSSOT); raises on a bad spec.
        cspec = ComparisonSpec.from_dict(_csp)

    import select_partner as SP

    # Call select() with select_partner.main()'s OWN defaults so `result` is byte-identical to the source
    # matcher: the legacy positional `weights` is the dead arg (ignored), max_dist=1.0 is the select default,
    # and every gate/ranking kwarg already defaults to the same value in the select() signature (CSSOT).
    try:
        result = SP.select(desc_path, str(subject_kp), win, str(index_dir),
                           max_dist=max_dist, salience_keypoints=sk, comparison_spec=cspec)
    except Exception as e:  # any matcher failure is a HARD fail (never a silent wrong/empty match)
        log(f"REFUSED: matcher error: {type(e).__name__}: {str(e)[-160:]}")
        return 1

    if not isinstance(result, dict):
        log(f"REFUSED: matcher returned non-dict: {type(result).__name__}")
        return 1

    envelope = {
        "schema": MATCH_SCHEMA,
        "subject": {"descriptor": desc_path, "pose": str(subject_kp), "window": win},
        "index": str(index_dir),
        "result": result,
    }
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(json.dumps(envelope, indent=2))
    if result.get("no_match"):
        log(f"no credible partner in {result.get('pool_windows', 0)} windows "
            f"(best_dist {result.get('best_dist')}) -> {out.name}")
    else:
        partner = Path(result["partner_clip"]).name if result.get("partner_clip") else "?"
        log(f"partner: {partner} (dist {result.get('dist')}, {result.get('parts')}) -> {out.name}")
    return 0


def main() -> int:
    ap = argparse.ArgumentParser(description="One match process-job: subject descriptor + index -> motion-match.v1")
    ap.add_argument("--subject-desc", required=True, help="subject motion descriptor (perception output); may carry ':WIN'")
    ap.add_argument("--subject-kp", required=True, help="subject pose.json (perception stage-1 output)")
    ap.add_argument("--index", required=True, help="reference descriptor index dir (.desc.json + _work/*.kp.json)")
    ap.add_argument("--out", required=True, help="match envelope JSON output path (motion-match.v1)")
    ap.add_argument("--salience-config", default=None,
                    help="JSON {'salience_keypoints':[...]} for the certified crop; omitted = select default (byte-identical tennis)")
    ap.add_argument("--comparison-spec", default=None,
                    help="JSON ComparisonSpec dict (channels/mirror/cert bars); omitted = default COCO limb+trunk (byte-identical)")
    ap.add_argument("--max-dist", type=float, default=1.0, help="legacy null bar pass-through (select default 1.0)")
    a = ap.parse_args()
    return run_match(a.subject_desc, Path(a.subject_kp), Path(a.index), Path(a.out),
                     salience_config=a.salience_config, comparison_spec=a.comparison_spec, max_dist=a.max_dist)


if __name__ == "__main__":
    raise SystemExit(main())
