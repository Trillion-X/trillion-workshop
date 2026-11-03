#!/usr/bin/env python3
# guard_rows.py
"""Which check rows apply to one hook event, and the one answer made from the answers of the checks that ran.

Purpose
    The hook dispatcher (hook_dispatch_body.py) reads its rows from DATA, picks the rows for this harness, event,
    scope and tool with `chosen`, runs them, and answers the harness with `merge`. These functions read nothing but
    their arguments, so any runner of the same rows (wherever its rows come from) picks and answers the same way.

Non-negotiable invariants
    1. Nothing here names a check, a tool or a vendor: what runs when is the rows' DATA.
    2. `acts_on` only ever SKIPS a row whose own first check would let the call through.
    3. A deny from any row is the answer's deny, with that row's reason unchanged; exit 2 is a refusal, and any other
       failure refuses only when the row's `failure_policy` is "deny".
"""
from __future__ import annotations

import json
import os
import re
import shlex
from pathlib import Path


def tool_matches(pattern: str | None, tool: str) -> bool:
    if pattern in (None, "", "*", ".*"):
        return True
    return bool(re.fullmatch(pattern, tool or ""))


def scope_matches(scope: str, chain: dict, env: dict) -> bool:
    if scope == "global":
        return True
    root = chain.get("scopes", {}).get(scope)
    project = env.get("CLAUDE_PROJECT_DIR", "")
    return bool(root) and (project == root or project.startswith(root.rstrip("/") + "/"))


def field_text(payload: dict, fields: list[str]) -> str:
    source = payload.get("tool_input") if isinstance(payload.get("tool_input"), dict) else {}
    parts = []
    for name in fields:
        value = payload.get(name) if name in ("tool_name", "prompt", "cwd") else source.get(name)
        if value is None:
            continue
        parts.append(value if isinstance(value, str) else json.dumps(value))
    return "\n".join(parts)


def grew_enough(guard: dict, payload: dict) -> bool:
    """True unless the file named by the guard's own --since-file marks shows less growth than its minimum."""
    rule = guard["grew_since"]
    argv = shlex.split(guard["run"])
    def arg(name):
        return argv[argv.index(name) + 1] if name in argv and argv.index(name) + 1 < len(argv) else None
    minimum, marks_path = arg(rule["min_arg"]), arg(rule["marks_arg"])
    watched = payload.get(rule["size_of"])
    if not (minimum and marks_path and isinstance(watched, str)):
        return True
    try:
        size = os.stat(watched).st_size
        marks = json.loads(Path(marks_path).read_text())
    except (OSError, ValueError):
        return True
    before = marks.get(watched) if isinstance(marks, dict) else None
    if not isinstance(before, (int, float)):
        return True
    # Bytes are never fewer than characters, so too little byte growth means too little character growth.
    return size - before >= float(minimum)


def acts(guard: dict, payload: dict, env: dict) -> bool:
    for name in guard.get("requires_env", []):
        if not env.get(name):
            return False
    rule = guard.get("acts_on")
    if rule and tool_matches(rule.get("tools"), payload.get("tool_name", "")):
        if not re.search(rule["matches"], field_text(payload, rule["fields"]), re.MULTILINE):
            return False
    if guard.get("grew_since") and not grew_enough(guard, payload):
        return False
    # A skip row names calls the guard itself would let through, decided without starting it: the WHOLE of its fields
    # must match (re.fullmatch), so a call that only contains a skipped command is still judged.
    for row in guard.get("skip_when", []):
        if tool_matches(row.get("tools"), payload.get("tool_name", "")) and re.fullmatch(
                row["matches"], field_text(payload, row["fields"]), re.DOTALL):
            return False
    return True


def chosen(chain: dict, harness: str, event: str, payload: dict, env: dict) -> list[dict]:
    tool = payload.get("tool_name", "") or ""
    picked = []
    for guard in chain["guards"]:
        if any(on["harness"] == harness and on["event"] == event and scope_matches(on.get("scope", "global"), chain, env)
               and tool_matches(on.get("tools"), tool) for on in guard["on"]) and acts(guard, payload, env):
            picked.append(guard)
    return picked


DECISION_RANK = {"deny": 3, "block": 3, "ask": 2, "allow": 1, "approve": 1}


def parse(stdout: str):
    text = stdout.strip()
    if text.startswith("{"):
        try:
            value = json.loads(text)
            if isinstance(value, dict):
                return value
        except ValueError:
            pass
    return None


def join(values: list[str]) -> str:
    return "\n\n".join(v for v in values if v)


def merge(event: str, results: list[tuple[dict, int, str, str]]) -> tuple[int, str, str]:
    """The one answer the harness reads, built from every guard's answer in DATA order."""
    # Exit 2 is an explicit refusal. Other failures deny only when the DATA row
    # says this guard is required to decide whether the action may proceed;
    # advisory/report hooks keep their existing nonfatal behavior.
    blocking = [(g, err or out or f"hook-dispatch: guard {g['id']} exited {code}\n")
                for g, code, out, err in results
                if code == 2 or (code != 0 and g.get("failure_policy") == "deny")]
    objects = [(g, parse(out)) for g, code, out, err in results if code == 0 and parse(out) is not None]
    plain = [out.rstrip("\n") for g, code, out, err in results if code == 0 and out.strip() and parse(out) is None]
    failures = [err.rstrip("\n") for g, code, out, err in results if code not in (0, 2) and err.strip()]

    if blocking:
        denied = [o.get("hookSpecificOutput", {}).get("permissionDecisionReason") or o.get("reason")
                  for _, o in objects if DECISION_RANK.get(o.get("hookSpecificOutput", {}).get("permissionDecision")
                                                          or o.get("decision"), 0) == 3]
        return 2, "", join([text.rstrip("\n") for _, text in blocking] + [d for d in denied if d]) + "\n"

    if not objects:
        return 0, ("\n".join(plain) + "\n") if plain else "", ("\n".join(failures) + "\n") if failures else ""

    merged: dict = {}
    specific: dict = {}
    reasons: dict[int, list[str]] = {}
    contexts, messages, block_reasons, stops = [], [], [], []
    for _, obj in objects:
        for key, value in obj.items():
            if key == "hookSpecificOutput" and isinstance(value, dict):
                for inner, item in value.items():
                    if inner == "permissionDecision":
                        reasons.setdefault(DECISION_RANK.get(item, 0), []).append(value.get("permissionDecisionReason", ""))
                        if DECISION_RANK.get(item, 0) > DECISION_RANK.get(specific.get(inner), 0):
                            specific[inner] = item
                    elif inner == "additionalContext":
                        contexts.append(item)
                    elif inner not in ("permissionDecisionReason", "hookEventName"):
                        specific.setdefault(inner, item)
            elif key == "systemMessage":
                messages.append(value)
            elif key == "decision":
                if value == "block":
                    block_reasons.append(obj.get("reason", ""))
                if DECISION_RANK.get(value, 0) > DECISION_RANK.get(merged.get("decision"), 0):
                    merged["decision"] = value
            elif key == "reason":
                continue
            elif key == "continue":
                if value is False:
                    merged["continue"] = False
                    stops.append(obj.get("stopReason", ""))
            elif key == "stopReason":
                continue
            elif key == "suppressOutput":
                merged["suppressOutput"] = merged.get("suppressOutput", False) or bool(value)
            else:
                merged.setdefault(key, value)
    if event in ("UserPromptSubmit", "SessionStart"):
        contexts = plain + contexts
    if "permissionDecision" in specific:
        rank = DECISION_RANK.get(specific["permissionDecision"], 0)
        specific["permissionDecisionReason"] = join(reasons.get(rank, []))
        if rank == 3:
            specific.pop("updatedInput", None)
    if contexts:
        specific["additionalContext"] = join(contexts)
    if specific:
        specific.setdefault("hookEventName", event)
        merged["hookSpecificOutput"] = specific
    if messages:
        merged["systemMessage"] = join(messages)
    if merged.get("decision") == "block":
        merged["reason"] = join(block_reasons)
    if stops:
        merged["stopReason"] = join(stops)
    return 0, (json.dumps(merged) + "\n") if merged else "", ("\n".join(failures) + "\n") if failures else ""
