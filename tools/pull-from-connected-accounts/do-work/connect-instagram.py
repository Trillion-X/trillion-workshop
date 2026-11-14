#!/usr/bin/env python3
# packages/instagram-dm-connector/do-work/connect-instagram.py
#
# =============================================================================
# PURPOSE
# =============================================================================
#
# The LIVE shell for the Instagram DM connector. One bounded run:
#   load session (instagrapi settings) from the vault  ->  (first time) login with
#   vault-held credentials (2FA is the user's action)  ->  pull direct_threads  ->
#   fold through the PURE ig_snapshot_store  ->  write the durable snapshot to the
#   capture dir  ->  persist refreshed session back to the vault.  Optional reply
#   mode: direct_send to a thread (used by the ai-action-guard-gated auto-reply).
#
# This is the ONLY module that imports instagrapi (lazily), so ig_snapshot_store +
# its test stay dependency-free and offline. The connector is not a god package:
# instagrapi = the source lib; the session/creds store = credentials-vault
# (injected blob I/O); the ledger = file-glob/observed-content; decode = the
# decoder. This shell owns ONLY "wire real deps -> pull -> snapshot / send".
#
# =============================================================================
# NON-NEGOTIABLE INVARIANTS
# =============================================================================
# 1. NO SECRETS ON ARGV. Credentials + session come from the vault blob (injected
#    read/write), never from the command line (visible in `ps`). Respects
#    "tokens only via credentials-vault".
# 2. NO UNPROMPTED LOGIN. A run with no session AND no vault credentials does
#    NOT attempt network — it reports `needs_login` for the connect surface. Login
#    (incl. 2FA/challenge) is the user's explicit consent action (macOS/account
#    Physics boundary — no bypass).
# 3. instagrapi is imported lazily inside the live path ONLY.
# 4. MERGE, never overwrite — folds onto the existing snapshot (dedup in the store).
#
# CLI (compute.process):
#   connect-instagram.py --account <id> --capture-dir <dir> \
#       --session-blob <path> --creds-blob <path> \
#       [--amount 20] [--message-limit 20] \
#       [--send-thread <id> --send-text <text>]
#   Emits JSON lines: {"type":"needs_login"|"pulled"|"sent"|"summary", ...}.
import json
import os
import pathlib
import sys

HERE = pathlib.Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
# The package vendors its own instagrapi (vendor/ sibling of do-work/) so the
# producer runs from ANY cwd with the system python — no global pip install,
# no environment coupling. The package owns its dependency location.
sys.path.insert(0, str(HERE.parent / "vendor"))
import ig_snapshot_store as store  # noqa: E402  (the PURE fold — no instagrapi)


# ---- opaque vault blob I/O (file-backed default; production injects the vault) --
def _read_json_blob(path):
    try:
        return json.loads(pathlib.Path(path).read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return None


def _write_json_blob(path, obj):
    p = pathlib.Path(path)
    p.parent.mkdir(parents=True, exist_ok=True)
    p.write_text(json.dumps(obj), encoding="utf-8")


def _capture_file(capture_dir, account_id):
    safe = "".join(c if (c.isalnum() or c in "._-") else "_" for c in str(account_id))
    return pathlib.Path(capture_dir) / (safe + ".json")


def _read_snapshot(capture_dir, account_id):
    try:
        return json.loads(_capture_file(capture_dir, account_id).read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return None


def _write_snapshot(capture_dir, account_id, snapshot):
    pathlib.Path(capture_dir).mkdir(parents=True, exist_ok=True)
    _capture_file(capture_dir, account_id).write_text(json.dumps(snapshot), encoding="utf-8")


def _thread_dicts(threads):
    """DirectThread objects -> plain dicts (pydantic `.dict()`), tolerant of a
    plain-dict client in tests."""
    out = []
    for t in threads or []:
        if isinstance(t, dict):
            out.append(t)
        elif hasattr(t, "dict"):
            out.append(t.dict())
        elif hasattr(t, "model_dump"):
            out.append(t.model_dump())
    return out


def make_instagrapi_client():
    """Real instagrapi client factory (lazy import — only the live path needs it)."""
    from instagrapi import Client  # noqa: PLC0415  (intentional lazy import)
    return Client()


def establish_session(client, session_settings, creds):
    """Restore an instagrapi session from vault settings; if none, log in with
    vault-held credentials (username/password[/verification_code]). Returns
    (ok, refreshed_settings, self_pk, reason). Never puts secrets on argv."""
    if session_settings:
        client.set_settings(session_settings)
        # A restored session may still need a login to refresh tokens; instagrapi
        # `login` with existing settings is a cheap re-auth. Username optional here.
        if creds and creds.get("username"):
            client.login(creds["username"], creds.get("password", ""),
                         relogin=False,
                         verification_code=creds.get("verification_code", ""))
        return True, client.get_settings(), getattr(client, "user_id", None), "session"
    if creds and creds.get("username") and creds.get("password"):
        client.login(creds["username"], creds["password"],
                     verification_code=creds.get("verification_code", ""))
        return True, client.get_settings(), getattr(client, "user_id", None), "login"
    return False, None, None, "needs_login"


def run_pull(client, capture_dir, account_id, amount, message_limit):
    """Pull direct_threads -> fold onto the snapshot -> write. Returns summary."""
    threads = client.direct_threads(amount=amount, thread_message_limit=message_limit)
    thread_dicts = _thread_dicts(threads)
    self_pk = getattr(client, "user_id", None)
    prior = _read_snapshot(capture_dir, account_id) or store.empty_snapshot(self_pk)
    before = sum(len(t.get("messages", [])) for t in prior.get("threads", []))
    snapshot = store.merge_threads(prior, thread_dicts, self_pk=self_pk)
    after = sum(len(t.get("messages", [])) for t in snapshot.get("threads", []))
    _write_snapshot(capture_dir, account_id, snapshot)
    return {"threads": len(snapshot.get("threads", [])),
            "messages": after, "new_messages": after - before}


def run_send(client, thread_id, text):
    """Send one reply (the ai-action-guard-gated auto-reply path)."""
    return client.direct_send(text, thread_ids=[str(thread_id)])


def _parse_args(argv):
    a = {}
    i = 0
    while i < len(argv):
        key = argv[i].lstrip("-")
        if i + 1 < len(argv) and not argv[i + 1].startswith("--"):
            a[key] = argv[i + 1]
            i += 2
        else:
            a[key] = True
            i += 1
    return a


def main(argv, client_factory=make_instagrapi_client):
    args = _parse_args(argv)
    account_id = args.get("account", "instagram:default")
    capture_dir = args.get("capture-dir",
                           str(pathlib.Path.home() / ".bitfield" / "captures" / "instagram"))
    session_blob = args.get("session-blob")
    creds_blob = args.get("creds-blob")
    emit = lambda obj: print(json.dumps(obj), flush=True)  # noqa: E731

    session_settings = _read_json_blob(session_blob) if session_blob else None
    creds = _read_json_blob(creds_blob) if creds_blob else None

    client = client_factory()
    ok, refreshed, self_pk, reason = establish_session(client, session_settings, creds)
    if not ok:
        emit({"type": "needs_login", "account": account_id})
        return 3  # connect surface must collect credentials into the vault
    if session_blob and refreshed:
        _write_json_blob(session_blob, refreshed)  # persist refreshed tokens

    if args.get("send-thread") and args.get("send-text") is not None:
        run_send(client, args["send-thread"], args["send-text"])
        emit({"type": "sent", "account": account_id, "thread": args["send-thread"]})
        return 0

    summary = run_pull(client, capture_dir, account_id,
                       int(args.get("amount", 20)), int(args.get("message-limit", 20)))
    emit({"type": "pulled", "account": account_id, **summary})
    emit({"type": "summary", "account": account_id, "reason": reason, **summary})
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
