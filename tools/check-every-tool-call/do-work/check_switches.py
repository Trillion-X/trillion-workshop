#!/usr/bin/env python3
# check_switches.py
"""Which checks the person switched off in their check lists, and every check row itself, for whatever runs the checks.

Purpose
    Each check is a row of a check list with a choice field `on`.
    The dispatcher asks `switched_off(state)` which guard ids are marked Off before it runs the chosen guards. The rows
    are read from a local snapshot so a tool call never waits for the door; `refresh(state)` rewrites the snapshot from
    the door and runs detached (`python3 check_switches.py refresh <state folder> <settings file>`), started by
    `start_refresh_if_stale`. The snapshot also keeps every row's value (`rows`), so a session that has no other copy
    of the rows can run them: `python3 check_switches.py run <settings file> < hook event`, which a repository's own
    hook settings start for every tool call (`run_the_check_list`). The person's check rows (`record:check`, read with
    the door's `where { kind: "check" }` and kept as `checks`) are judged on each call by the one judge through
    `check_rows.judge` (`judge_check_rows`): the rows whose `kinds` name the call's unit kind (`git-commit`, `git-push`,
    else `tool-call`).

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
       {"env": name}), and sent only in the Authorization header. The door's address is `door.url`, or the environment
       variable `door.url_from` names ({"env": name}), so a repository's files need not name anyone's door.
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


def door_url(rules: dict):
    door = rules["door"]
    return door.get("url") or os.environ.get((door.get("url_from") or {}).get("env") or "") or None


def list_page(rules: dict, key: str, kind: dict, after) -> dict:
    door = rules["door"]
    payload = {"type": kind["type"], "limit": door["page"]}
    if kind.get("where"):
        payload["where"] = kind["where"]
    if after:
        payload["after"] = after
    body = {"jsonrpc": "2.0", "id": 1, "method": "tools/call", "params": {"name": "run_resource_operation", "arguments": {
        "address": door["address"], "method": door["method"],
        "request_key": "check-switches:%s:%s:%d" % (kind["type"], after or "", int(time.time())), "input": payload}}}
    request = urllib.request.Request(door_url(rules), data=json.dumps(body).encode(), method="POST", headers={
        "content-type": "application/json", "accept": "application/json, text/event-stream", "authorization": f"Bearer {key}"})
    with urllib.request.urlopen(request, timeout=door["timeout_seconds"]) as response:
        answer = json.loads(response.read().decode() or "null")
    result = (answer or {}).get("result") or {}
    if result.get("isError"):
        raise RuntimeError("the door refused records:list for %s" % kind["type"])
    return result.get("structuredContent") or json.loads(result["content"][0]["text"])


def read_rows(rules: dict, key: str) -> dict:
    """{snapshot key: {row id: (record id, value)}} for every row of every declared type, across every page. A type is
    kept under its `into` (default "rows", the hook-guard rows) and read with its `where`, if it names one."""
    rows = {}
    for kind in rules["types"]:
        into = rows.setdefault(kind.get("into", "rows"), {})
        after = None
        while True:
            page = list_page(rules, key, kind, after)
            for record in page.get("records") or []:
                if str(record.get("id", "")).startswith(kind["id_prefix"]):
                    into[record["id"][len(kind["id_prefix"]):]] = (record["id"], record.get("value") or {})
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
        if not door_url(rules):
            raise RuntimeError("no door (%s)" % json.dumps(rules["door"].get("url_from")))
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
        json.dump({"read_at": time.strftime("%Y-%m-%dT%H:%M:%S%z"), "off": read_off(rules, rows.get("rows", {})),
                   "rows": {}, **{into: {guard: value for guard, (_, value) in kept.items()} for into, kept in rows.items()}},
                  handle, indent=1)
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


def state_folder(settings_file: str) -> str:
    """Where `run` keeps its snapshot: CHECK_LIST_STATE, else a folder named for the settings file."""
    import hashlib
    tag = hashlib.blake2b(os.path.abspath(settings_file).encode(), digest_size=8).hexdigest()
    return os.environ.get("CHECK_LIST_STATE") or os.path.join(os.path.expanduser("~"), ".cache",
                                                               "check-every-tool-call", tag)


def unit_kinds(rules: dict, event: dict) -> list[str]:
    """The unit kinds one call is judged as: each of the settings' `check_rows.unit_kinds` whose `acts_on` matches the
    call (the same tool and command match a hook-guard row's `acts_on` uses), else `check_rows.otherwise`."""
    import re
    import guard_rows
    config = rules.get("check_rows") or {}
    kinds = []
    for one in config.get("unit_kinds", []):
        match = one["acts_on"]
        if guard_rows.tool_matches(match.get("tools"), event.get("tool_name", "")) and re.search(
                match["matches"], guard_rows.field_text(event, match["fields"]), re.MULTILINE):
            kinds.append(one["kind"])
    return kinds or ([config["otherwise"]] if config.get("otherwise") else [])


def judge_check_rows(rules: dict, taken: dict, event: dict, filled) -> list:
    """The results of judging the call against the person's check rows (`checks` in the snapshot): for each unit kind
    of the call, the rows whose `kinds` name it, judged by the one judge through `check_rows.judge` (exit 2 refuses
    with each finding's words). A call whose input carries a check row's fixtures is judged too, so a row whose
    fixtures do not hold cannot be written through it. A judge that cannot run is said and refuses nothing."""
    config = rules.get("check_rows") or {}
    if not config.get("judge") or event.get("hook_event_name", "") not in config.get("events", ["PreToolUse"]):
        return []
    rows = [{**value, "id": value.get("id") or row_id} for row_id, value in sorted((taken.get("checks") or {}).items())
            if isinstance(value, dict)]
    writes_a_row = config.get("fixtures_field", "fixtures") in json.dumps(event.get("tool_input") or {})
    results = []
    for kind in unit_kinds(rules, event):
        kept = [row for row in rows if isinstance(row.get("kinds"), list) and kind in row["kinds"]]
        if not kept and not writes_a_row:
            continue
        guard = {"id": "check-rows:%s" % kind}
        try:
            done = subprocess.run([filled(one).replace("{kind}", kind) for one in config["judge"]], capture_output=True,
                                  text=True, input=json.dumps({"rows": kept, "event": event}),
                                  timeout=config.get("timeout_seconds", 120), cwd=filled("{repository}"))
            if done.returncode in (0, 2):
                results.append((guard, done.returncode, done.stdout, done.stderr))
            else:
                why = (done.stderr or done.stdout).strip() or "exit %d" % done.returncode
                results.append((guard, 0, json.dumps({"systemMessage": "check rows unjudged for %s: %s" % (kind, why)}), ""))
        except subprocess.TimeoutExpired:
            results.append((guard, 0, json.dumps({"systemMessage": "check rows unjudged for %s: timed out after %s s"
                                                                 % (kind, config.get("timeout_seconds", 120))}), ""))
        except OSError as error:
            results.append((guard, 0, json.dumps({"systemMessage": "check rows unjudged for %s: could not start: %s"
                                                                 % (kind, error)}), ""))
        writes_a_row = False  # the written row is judged once, with the first kind
    return results


def run_the_check_list(event: dict, settings_file: str) -> tuple[int, str, str]:
    """(exit code, stdout, stderr) for one hook event: every row that names `workshop_run`, in the settings' one scope,
    picked and answered by guard_rows.py as the dispatcher picks and answers its own rows. Placeholders in
    `workshop_run`: {tools} the Workshop's tools folder, {repository} the session's project folder,
    {tool_input.<field>} one field of the call.

    A list that cannot be read is said on every call ("check list unreachable: <why>") and refuses nothing. A tool call
    waits for the door only while there is no snapshot at all (the first call of a session)."""
    import re
    import guard_rows
    os.environ["CHECK_LIST_SETTINGS"] = settings_file
    rules = settings()
    state = state_folder(settings_file)
    path = snapshot_path(state, rules)
    failed = path + ".unreachable"
    if not os.path.exists(path) and not (os.path.exists(failed) and time.time() - os.path.getmtime(failed)
                                         < rules["snapshot"]["refresh_seconds"]):
        refresh(state)  # the first call waits once; a door that just failed is asked again in the background
    why = None
    try:
        with open(failed, encoding="utf-8") as handle:
            why = handle.read()
    except OSError:
        pass
    try:
        with open(path, encoding="utf-8") as handle:
            taken = json.load(handle)
    except (OSError, ValueError):
        taken = {}
    guards = []
    for guard, value in sorted((taken.get("rows") or {}).items()):
        try:
            definition = json.loads(value.get("full_definition") or "{}")
        except ValueError:
            continue
        if isinstance(definition, dict) and definition.get("workshop_run"):
            guards.append({**definition, "id": definition.get("id") or guard})
    project = os.environ.get("CLAUDE_PROJECT_DIR") or event.get("cwd") or os.getcwd()
    tools = os.path.dirname(os.path.dirname(os.path.dirname(os.path.realpath(__file__))))
    tool_input = event.get("tool_input") if isinstance(event.get("tool_input"), dict) else {}
    event_name = event.get("hook_event_name", "")
    guards = guard_rows.chosen({"guards": guards, "scopes": {rules["scope"]: "/"}}, rules["harness"], event_name, event,
                               {"CLAUDE_PROJECT_DIR": project})
    guards, notes = apply(guards, state)

    def filled(argument: str) -> str:
        out = argument.replace("{tools}", tools).replace("{repository}", project)
        return re.sub(r"\{tool_input\.([A-Za-z_]+)\}", lambda match: str(tool_input.get(match.group(1), "")), out)

    results = []
    results.extend(judge_check_rows(rules, taken, event, filled))
    for guard in guards:
        try:
            done = subprocess.run([filled(one) for one in guard["workshop_run"]], capture_output=True, text=True,
                                  timeout=guard.get("timeout_s", 60), cwd=project, stdin=subprocess.DEVNULL)
            # A row's command is a plain command, not a hook: exit 0 passes in silence, a refusal says its output.
            results.append((guard, done.returncode, done.stdout if done.returncode else "", done.stderr))
        except subprocess.TimeoutExpired:
            results.append((guard, 1, "", "%s timed out after %s s\n" % (guard["id"], guard.get("timeout_s", 60))))
        except OSError as error:
            results.append((guard, 1, "", "%s could not start: %s\n" % (guard["id"], error)))
    said = (["check list unreachable: %s" % why] if why else []) + [note.strip() for note in notes]
    if said:
        results.insert(0, ({"id": "check-list"}, 0, json.dumps({"systemMessage": "\n".join(said)}), ""))
    code, out, err = guard_rows.merge(event_name, results)
    return code, out, ("\n".join(said) + "\n" + err) if code == 2 and said else err


if __name__ == "__main__":
    if len(sys.argv) == 3 and sys.argv[1] == "run":
        try:
            event = json.load(sys.stdin)
            code, out, err = run_the_check_list(event if isinstance(event, dict) else {}, sys.argv[2])
        except Exception as error:  # a runner that cannot run says so; it never refuses every call
            code, out, err = 0, json.dumps({"systemMessage": "check list unreachable: the runner failed: %s: %s"
                                                             % (type(error).__name__, error)}) + "\n", ""
        sys.stdout.write(out)
        sys.stderr.write(err)
        sys.exit(code)
    if len(sys.argv) == 3 and sys.argv[1] == "refresh":
        try:
            why = refresh(sys.argv[2])
        finally:
            try:
                os.remove(snapshot_path(sys.argv[2], settings()) + ".refreshing")
            except Exception:
                pass
        sys.exit(0 if why is None else 1)
    sys.stderr.write("usage: check_switches.py run <settings file> < hook event\n"
                     "       CHECK_LIST_SETTINGS=<settings file> check_switches.py refresh <state folder>\n")
    sys.exit(2)
