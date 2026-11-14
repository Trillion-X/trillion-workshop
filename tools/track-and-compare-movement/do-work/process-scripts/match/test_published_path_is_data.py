#!/usr/bin/env python3
# packages/motion-analysis/do-work/process-scripts/match/test_published_path_is_data.py
#
# V4 (Codex gauntlet) / L120 SSOT gate: the published record path + address namespace are
# DATA (the TrackerDescriptor `_emits.published_path`), NOT hardcoded in emit source. Proves
# the emitter is GENERIC over the path — a DIFFERENT tracker reuses it by DATA alone, ZERO
# code change — and that the DEFAULT (no path supplied) stays `match-perception` (backward
# compat). Env-gated only because importing the emitter requires MATCH_VENDOR_ROOT.
import os
import sys

if not os.environ.get("MATCH_VENDOR_ROOT"):
    print("SKIP (env): MATCH_VENDOR_ROOT not set")
    sys.exit(0)

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import emit_match_facts as emf  # noqa: E402

# Minimal perception (empty) — the rally + shot.speed facts are always emitted (log:True),
# so there is at least one published record to inspect, with no models/frames needed.
EMPTY = dict(frames=[None], fps=30.0, H_mats=[], kps=[], cands=[], states=[])


def records(published_path=None):
    co = emf.build_command_output(EMPTY["frames"], EMPTY["fps"], EMPTY["H_mats"],
                                  EMPTY["kps"], EMPTY["cands"], EMPTY["states"],
                                  rid="t", video="v", published_path=published_path)
    return co["records"]


# 1) DATA-driven: a custom published_path relabels every record's namespace + path.
custom = records(["my-tracker", "my-evidence"])
assert custom, "expected at least one log record (rally/speed)"
for r in custom:
    assert r["address"].startswith("package::my-tracker::"), f"address not DATA-driven: {r['address']}"
    assert r["path"] == ["my-tracker", "my-evidence"], f"path not DATA-driven: {r['path']}"
    assert r["payload"]["command_run_id"] == "package::my-tracker::command-run-request::t", \
        f"command_run_id not DATA-driven: {r['payload']['command_run_id']}"

# 2) Default (no path supplied) stays match-perception — existing behavior unchanged (SSOT
#    default == the descriptor's `_emits.published_path` for the match-perception tracker).
default = records(None)
assert default, "expected default records"
for r in default:
    assert r["address"].startswith("package::match-perception::"), f"default namespace changed: {r['address']}"
    assert r["path"] == ["match-perception", "content-media-evidence"], f"default path changed: {r['path']}"

print(f"V4 PASS — published path + namespace are DATA-driven ({len(custom)} records relabeled with zero "
      f"code change); default = match-perception (backward compat)")
