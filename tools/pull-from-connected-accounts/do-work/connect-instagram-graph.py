#!/usr/bin/env python3
# packages/instagram-dm-connector/do-work/connect-instagram-graph.py
#
# =============================================================================
# PURPOSE
# =============================================================================
#
# The LIVE producer for INBOUND Instagram DMs pulled through the Meta GRAPH API
# (IG-User IGAA token from the service-connections connect flow), as opposed to
# the instagrapi username/password path in connect-instagram.py.
#
# It is DELIBERATELY thin: it builds a GraphInstagramClient (duck-typed
# `.user_id` + `.direct_threads`) from a mounted token file, then hands it to the
# EXISTING `connect-instagram.py::run_pull` — reusing that module's snapshot file
# naming (`_capture_file`), read/merge/write, and the PURE `ig_snapshot_store`
# fold VERBATIM.  Same account -> same snapshot file -> a future instagrapi pull
# and this Graph pull MERGE into one history (SSOT).  Nothing about "graph" leaks
# past this file: the snapshot, decoder, and sidebar stay blind (L069/L090/L098).
#
# =============================================================================
# NON-NEGOTIABLE INVARIANTS
# =============================================================================
# 1. NO SECRET ON ARGV. The token arrives ONLY as a file path (--token-file), a
#    credentials-vault credential_mount resolved into a runtime-only file for this
#    single run. The raw token never enters argv, env, DATA, the summary, or a log.
# 2. REUSE, DON'T FORK. run_pull + snapshot I/O come from connect-instagram.py
#    (loaded by path — its filename is hyphenated). This file owns ONLY "build the
#    Graph client -> delegate to the shared pull". Zero duplicated fold logic.
# 3. FAIL CLOSED + QUIET. A missing/empty token or an API error emits a structured
#    {"type":"error"} line (NO token bytes) and a non-zero exit; it never writes a
#    partial/garbage snapshot.
#
# CLI (compute.process):
#   connect-instagram-graph.py --account <vendor:id> [--capture-dir <dir>]
#       --token-file <path> [--amount 20] [--message-limit 20]
#       [--ig-user-id <igsid>] [--platform instagram] [--graph-base <https://host>]
#   ig-user-id / platform / graph-base are NON-SECRET spec DATA whose PRESENCE
#   selects which Meta messaging surface the client speaks (L090): the
#   Facebook-Login surface needs the IG Business id + platform param; the
#   Instagram-Login surface needs neither. No profile-name enum anywhere.
#   The default capture dir DERIVES from the account's vendor prefix
#   (`<vendor>:<id>` -> ~/.bitfield/captures/<vendor>), so the SAME generic Meta
#   -graph producer serves every Meta vendor as DATA — `instagram:default` ->
#   captures/instagram, `messenger:default` -> captures/messenger — with zero
#   per-vendor code and no absolute path or vendor name in DATA (L063/L090/L131).
#   An explicit --capture-dir still overrides. Vendor is DATA, never an enum.
import importlib.util
import json
import pathlib
import sys

HERE = pathlib.Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))

# Reuse the shared pull + snapshot I/O from the hyphenated sibling (SSOT). Loading
# by file path because "connect-instagram" is not an importable module name.
_ci_spec = importlib.util.spec_from_file_location(
    "connect_instagram", str(HERE / "connect-instagram.py"))
ci = importlib.util.module_from_spec(_ci_spec)
_ci_spec.loader.exec_module(ci)

from graph_instagram_client import GRAPH_BASE, make_graph_client_from_token_file  # noqa: E402


def main(argv, client_factory=None):
    args = ci._parse_args(argv)
    account_id = args.get("account", "instagram:default")
    # Default capture dir is DATA-derived from the account vendor prefix
    # (`<vendor>:<id>`), never a hardcoded vendor name: `instagram:default` ->
    # captures/instagram, `messenger:default` -> captures/messenger. One generic
    # Meta-graph producer, every vendor as DATA (L063/L090/L131). Explicit
    # --capture-dir still wins.
    vendor = str(account_id).split(":", 1)[0] or "instagram"
    capture_dir = args.get(
        "capture-dir",
        str(pathlib.Path.home() / ".bitfield" / "captures" / vendor))
    token_file = args.get("token-file")
    emit = lambda obj: print(json.dumps(obj), flush=True)  # noqa: E731

    try:
        if client_factory is not None:
            client = client_factory()
        else:
            if not token_file:
                emit({"type": "error", "account": account_id, "reason": "no_token_file"})
                return 3
            client = make_graph_client_from_token_file(
                token_file,
                ig_user_id=args.get("ig-user-id"),
                platform=args.get("platform"),
                base=args.get("graph-base", GRAPH_BASE))
        summary = ci.run_pull(
            client, capture_dir, account_id,
            int(args.get("amount", 20)), int(args.get("message-limit", 20)))
    except Exception as exc:  # noqa: BLE001 — never leak token; report class+msg only
        # Defensive: strip anything token-like from the message (token has no spaces).
        msg = str(exc)
        emit({"type": "error", "account": account_id,
              "reason": type(exc).__name__, "detail": msg[:200]})
        return 1

    emit({"type": "pulled", "account": account_id, **summary})
    emit({"type": "summary", "account": account_id, "reason": "graph", **summary})
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
