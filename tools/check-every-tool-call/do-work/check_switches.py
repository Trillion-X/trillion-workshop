#!/usr/bin/env python3
# check_switches.py
"""Which checks the person switched off in their check lists, and every check row itself, for whatever runs the checks.

Purpose
    Each check is a row of a check list with a choice field `on`.
    The dispatcher asks `switched_off(state)` which guard ids are marked Off before it runs the chosen guards. The rows
    are read from a local snapshot so a tool call never waits for the door; `refresh(state)` rewrites the snapshot from
    the door and runs detached (`python3 check_switches.py refresh <state folder> <settings file>`), started by
    `start_refresh_if_stale`. The snapshot also keeps every row's value (`rows`), which run_the_check_list.py reads to
    run the checks in a session that has no other copy of them.

    The settings (the door's address, how its key is read, the list types) are the caller's DATA: `configure(rules)`
    from a process that already holds them, else the JSON file named by CHECK_LIST_SETTINGS. On one computer the door
    is that computer's own; in a session anywhere else it is the public door with the session's own key.

Non-negotiable invariants
    1. Off only on an exact "Off". Absent, "On", any other value, a missing row, an unreadable list, a failed refresh or
       a missing snapshot all mean ON: nothing here can switch every check off.
    2. A failed refresh keeps the previous snapshot. The snapshot is replaced whole (written beside it, then renamed).
    3. The tool call never waits for the door: reading is one local file; refreshing is a detached process.
    4. Honouring is DATA (`honour_off` in the settings). While it is false, a guard marked Off
       still runs and the dispatcher reports the mark, because any agent key can write "Off" until the engine
       requires the person's passkey for it.
    5. The door key is read at refresh time, from where the settings say (`door.key_from`: {"keychain": item} or
       {"env": name}), and sent only in the Authorization header.
"""
from __future__ import annotations

import json
import os
import subprocess
import sys
import time
import urllib.error
import urllib.request

_CONFIGURED: dict | None = None


def configure(rules: dict) -> None:
    """Use these settings in this process (the hook dispatcher reads its own committed DATA and hands it here)."""
    global _CONFIGURED
    _CONFIGURED = rules


def settings() -> dict:
    if _CONFIGURED is not None:
        return _CONFIGURED
    with open(os.environ["CHECK_LIST_SETTINGS"], encoding="utf-8") as handle:
        return json.load(handle)


def snapshot_path(state, rules: dict) -> str:
    return os.path.join(str(state), rules["snapshot"]["file"])


def switched_off(state) -> tuple[dict, dict]:
    """({guard id: details} for every guard marked Off in the snapshot, the rules). Empty on any failure."""
    try:
        rules = settings()
        with open(snapshot_path(state, rules), encoding="utf-8") as handle:
            snapshot = json.load(handle)
        off = snapshot.get("off") or {}
        return (off if isinstance(off, dict) else {}), rules
    except Exception:
        return {}, {}


def is_off(value, rules: dict) -> bool:
    return isinstance(value, dict) and value.get(rules["field"]) == rules["off_value"]


def door_key(rules: dict):
    source = rules["door"]["key_from"]
    if "env" in source:
        return os.environ.get(source["env"]) or None
    answer = subprocess.run(["security", "find-generic-password", "-s", source["keychain"], "-w"],
                            capture_output=True, text=True, timeout=5)
    return answer.stdout.strip() or None


def list_page(rules: dict, key: str, kind: dict, after) -> dict:
    door = rules["door"]
    payload = {"type": kind["type"], "limit": door["page"]}
    if after:
        payload["after"] = after
    body = {"jsonrpc": "2.0", "id": 1, "method": "tools/call", "params": {"name": "run_resource_operation", "arguments": {
        "address": door["address"], "method": door["method"],
        "request_key": "check-switches:%s:%s:%d" % (kind["type"], after or "", int(time.time())), "input": payload}}}
    request = urllib.request.Request(door["url"], data=json.dumps(body).encode(), method="POST", headers={
        "content-type": "application/json", "accept": "application/json, text/event-stream", "authorization": f"Bearer {key}"})
    with urllib.request.urlopen(request, timeout=door["timeout_seconds"]) as response:
        answer = json.loads(response.read().decode() or "null")
    result = (answer or {}).get("result") or {}
    if result.get("isError"):
        raise RuntimeError("the door refused records:list for %s" % kind["type"])
    return result.get("structuredContent") or json.loads(result["content"][0]["text"])


def read_rows(rules: dict, key: str) -> dict:
    """{guard id: (record id, value)} for every row of every declared type, across every page."""
    rows = {}
    for kind in rules["types"]:
        after = None
        while True:
            page = list_page(rules, key, kind, after)
            for record in page.get("records") or []:
                if str(record.get("id", "")).startswith(kind["id_prefix"]):
                    rows[record["id"][len(kind["id_prefix"]):]] = (record["id"], record.get("value") or {})
            after = page.get("next")
            if not after:
                break
    return rows


def read_off(rules: dict, rows: dict) -> dict:
    """{guard id: details} for every row whose `on` is exactly "Off"."""
    return {guard: {"record": record, **{f: value.get(f) for f in rules.get("detail_fields", [])}}
            for guard, (record, value) in rows.items() if is_off(value, rules)}


def refresh(state) -> str | None:
    """Rewrite the snapshot from the door. None when it did; else why not, in words, with the old snapshot kept and
    the reason written beside it (`<snapshot>.unreachable`) for whoever reads the snapshot next."""
    rules = settings()
    path = snapshot_path(state, rules)
    os.makedirs(os.path.dirname(path), exist_ok=True)
    try:
        key = door_key(rules)
        if not key:
            raise RuntimeError("no key (%s)" % json.dumps(rules["door"]["key_from"]))
        rows = read_rows(rules, key)
    except urllib.error.HTTPError as error:
        return _unreachable(path, "%s %s" % (error.code, error.reason))
    except Exception as error:
        return _unreachable(path, str(error) or type(error).__name__)
    scratch = "%s.%d.tmp" % (path, os.getpid())
    with open(scratch, "w", encoding="utf-8") as handle:
        json.dump({"read_at": time.strftime("%Y-%m-%dT%H:%M:%S%z"), "off": read_off(rules, rows),
                   "rows": {guard: value for guard, (_, value) in rows.items()}}, handle, indent=1)
    os.replace(scratch, path)
    try:
        os.remove(path + ".unreachable")
    except OSError:
        pass
    return None


def _unreachable(path: str, why: str) -> str:
    with open(path + ".unreachable", "w", encoding="utf-8") as handle:
        handle.write(why)
    return why


def start_refresh_if_stale(state, rules: dict) -> None:
    """Start a detached refresh when the snapshot is missing or older than refresh_seconds; never waits for it."""
    try:
        path = snapshot_path(state, rules)
        age = time.time() - os.path.getmtime(path) if os.path.exists(path) else None
        claim = path + ".refreshing"
        if age is not None and age < rules["snapshot"]["refresh_seconds"]:
            return
        if os.path.exists(claim) and time.time() - os.path.getmtime(claim) < rules["door"]["timeout_seconds"] * 3:
            return
        os.makedirs(os.path.dirname(path), exist_ok=True)
        open(claim, "w").close()
        subprocess.Popen([sys.executable, os.path.abspath(__file__), "refresh", str(state)], stdin=subprocess.DEVNULL,
                         stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, start_new_session=True,
                         env={**os.environ, "CHECK_LIST_SETTINGS": _settings_file(state, rules)})
    except Exception:
        return


def _settings_file(state, rules: dict) -> str:
    """The settings as a file the detached refresh can read: the caller's file, or a copy beside the snapshot."""
    if _CONFIGURED is None and os.environ.get("CHECK_LIST_SETTINGS"):
        return os.environ["CHECK_LIST_SETTINGS"]
    path = snapshot_path(state, rules) + ".settings"
    with open(path + ".tmp", "w", encoding="utf-8") as handle:
        json.dump(rules, handle)
    os.replace(path + ".tmp", path)
    return path


def apply(guards: list, state) -> tuple[list, list[str]]:
    """(guards to run, notes) after the switches: removes guards marked Off only when honour_off is true."""
    off, rules = switched_off(state)
    if rules:
        start_refresh_if_stale(state, rules)
    else:
        try:
            start_refresh_if_stale(state, settings())
        except Exception:
            pass
    if not off:
        return guards, []
    keep, notes = [], []
    for guard in guards:
        mark = off.get(guard["id"])
        if not mark:
            keep.append(guard)
            continue
        said = "%s is marked Off in the person's checks list (%s; by %s at %s: %s)" % (
            guard["id"], mark.get("record"), mark.get("switched_by") or "unknown", mark.get("switched_at") or "unknown",
            mark.get("why_off") or "no reason given")
        if rules.get("honour_off"):
            notes.append("hook-dispatch: did not run %s.\n" % said)
        else:
            keep.append(guard)
            notes.append("hook-dispatch: ran anyway: %s. Off is honoured only once switching a check off needs the person's "
                         "passkey (honour_off in the settings).\n" % said)
    return keep, notes


if __name__ == "__main__":
    if len(sys.argv) == 3 and sys.argv[1] == "refresh":
        try:
            why = refresh(sys.argv[2])
        finally:
            try:
                os.remove(snapshot_path(sys.argv[2], settings()) + ".refreshing")
            except Exception:
                pass
        sys.exit(0 if why is None else 1)
    sys.stderr.write("usage: CHECK_LIST_SETTINGS=<settings file> check_switches.py refresh <state folder>\n")
    sys.exit(2)
