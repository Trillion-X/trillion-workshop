#!/usr/bin/env python3
#
# Purpose:
#   Convert direct compute.process git command results into git-worktree records.
#
# Invariants:
#   - This script never executes git or any other OS process.
#   - It consumes canonical ProcessResult JSON captured from compute.process.
#   - It owns git-output parsing and emits package-owned JSON records only.

from __future__ import annotations

import argparse
import base64
import datetime
import hashlib
import json
import pathlib
import re
from typing import Any


def iso_now() -> str:
    return datetime.datetime.now(datetime.timezone.utc).isoformat().replace("+00:00", "Z")


def scan_id_now() -> str:
    return "knowledge_git_worktree_scan:" + datetime.datetime.now(
        datetime.timezone.utc
    ).strftime("%Y%m%dT%H%M%S%fZ")


def sha_id(prefix: str, value: str) -> str:
    digest = hashlib.sha256(value.encode("utf-8")).hexdigest()
    return f"{prefix}:{digest}"


def read_json(path: str | None, fallback: Any) -> Any:
    if not path:
        return fallback
    try:
        return json.loads(pathlib.Path(path).read_text(encoding="utf-8"))
    except Exception:
        return fallback


def captured_fd_text(result: dict[str, Any], fd: int) -> str:
    captures = result.get("captured_fds")
    if not isinstance(captures, list):
        raise ValueError("compute.process result has no captured_fds array")
    matches = [capture for capture in captures if isinstance(capture, dict) and capture.get("fd") == fd]
    if len(matches) != 1:
        raise ValueError(f"compute.process result has no unique fd {fd} capture")
    value = matches[0].get("bytes")
    if not isinstance(value, str):
        raise ValueError(f"compute.process fd {fd} bytes are not canonical base64")
    try:
        return base64.b64decode(value, validate=True).decode("utf-8", errors="replace")
    except Exception as exc:
        raise ValueError(f"compute.process fd {fd} bytes are not canonical base64") from exc


def process_termination(result: dict[str, Any]) -> tuple[str, int]:
    termination = result.get("termination")
    if not isinstance(termination, dict):
        raise ValueError("compute.process result has no exact termination")
    kind = termination.get("kind")
    member = "code" if kind == "exited" else "signal" if kind == "signaled" else None
    value = termination.get(member) if member else None
    if member is None or not isinstance(value, int) or isinstance(value, bool) or not 0 <= value <= 255:
        raise ValueError("compute.process result has an invalid exact termination")
    return kind, value


def require_process_success(result: dict[str, Any], label: str) -> None:
    kind, value = process_termination(result)
    if kind == "exited" and value == 0:
        return
    stderr = captured_fd_text(result, 2).strip()[-8192:]
    stdout = captured_fd_text(result, 1).strip()[-8192:]
    termination = f"exited with code {value}" if kind == "exited" else f"terminated by signal {value}"
    raise RuntimeError(stderr or stdout or f"{label} {termination}")


def parse_branch_header(line: str) -> tuple[str, int, int]:
    text = line[3:].strip()
    ahead = 0
    behind = 0
    bracket = re.search(r"\[(.+)\]$", text)
    if bracket:
        details = bracket.group(1)
        ahead_match = re.search(r"ahead\s+(\d+)", details)
        behind_match = re.search(r"behind\s+(\d+)", details)
        if ahead_match:
            ahead = int(ahead_match.group(1))
        if behind_match:
            behind = int(behind_match.group(1))
        text = text[: bracket.start()].strip()
    branch = text.split("...", 1)[0].strip() or "HEAD"
    return branch, ahead, behind


def parse_porcelain(stdout: str, project: dict[str, Any], current_scan_id: str) -> tuple[dict[str, Any], list[dict[str, Any]]]:
    branch = "HEAD"
    ahead = 0
    behind = 0
    changes: list[dict[str, Any]] = []

    for raw_line in stdout.splitlines():
        if not raw_line:
            continue
        if raw_line.startswith("## "):
            branch, ahead, behind = parse_branch_header(raw_line)
            continue
        if len(raw_line) < 3:
            continue
        index_status = raw_line[0]
        worktree_status = raw_line[1]
        path_part = raw_line[3:]
        file_path = path_part.split(" -> ")[-1]
        if not file_path:
            continue

        def append_change(bucket: str, status: str) -> None:
            changes.append(
                {
                    "record_id": sha_id(
                        "knowledge_git_change",
                        f"{project['project_id']}:{current_scan_id}:{bucket}:{file_path}:{status}",
                    ),
                    "scan_id": current_scan_id,
                    "project_id": project["project_id"],
                    "project_name": project["project_name"],
                    "file_path": file_path,
                    "bucket": bucket,
                    "status": status,
                }
            )

        if index_status == "?" and worktree_status == "?":
            append_change("untracked", "?")
            continue
        if index_status not in (" ", "?"):
            append_change("staged", index_status)
        if worktree_status not in (" ", "?"):
            append_change("unstaged", worktree_status)

    bucket_order = {"staged": 0, "unstaged": 1, "untracked": 2}
    changes.sort(key=lambda item: (bucket_order.get(item["bucket"], 99), item["file_path"], item["status"]))
    worktree = {
        "record_id": f"knowledge_git_worktree:{project['project_id']}",
        "project_id": project["project_id"],
        "project_name": project["project_name"],
        "latest_scan_id": current_scan_id,
        "branch": branch,
        "ahead": ahead,
        "behind": behind,
        "refreshed_at": iso_now(),
    }
    return worktree, changes


def make_worktree_payload(request: dict[str, Any], status_result: dict[str, Any]) -> dict[str, Any]:
    require_process_success(status_result, "git status")
    project = request.get("project") if isinstance(request.get("project"), dict) else {}
    scan_id = scan_id_now()
    worktree, changes = parse_porcelain(captured_fd_text(status_result, 1), project, scan_id)
    return {"worktree": [worktree], "changes": changes}


def make_diff_payload(request: dict[str, Any], diff_result: dict[str, Any]) -> dict[str, Any]:
    require_process_success(diff_result, "git diff")
    project = request.get("project") if isinstance(request.get("project"), dict) else {}
    action_input = request.get("action_input") if isinstance(request.get("action_input"), dict) else {}
    return {
        "project_id": project.get("project_id"),
        "project_name": project.get("project_name"),
        "file_path": action_input.get("file_path") if isinstance(action_input.get("file_path"), str) else "",
        "diff": captured_fd_text(diff_result, 1),
    }


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--request-json", required=True)
    parser.add_argument("--primary-output-json")
    parser.add_argument("--refresh-output-json")
    parser.add_argument("--output-json", required=True)
    args = parser.parse_args()

    request = read_json(args.request_json, {})
    primary_output = read_json(args.primary_output_json, {})
    refresh_output = read_json(args.refresh_output_json, {})
    if not isinstance(request, dict):
        request = {}
    if not isinstance(primary_output, dict):
        primary_output = {}
    if not isinstance(refresh_output, dict):
        refresh_output = {}

    output_kind = request.get("output_kind")
    if output_kind == "diff":
        payload = make_diff_payload(request, primary_output)
    else:
        if primary_output:
            require_process_success(primary_output, "git command")
        payload = make_worktree_payload(request, refresh_output or primary_output)

    pathlib.Path(args.output_json).write_text(json.dumps(payload, ensure_ascii=False), encoding="utf-8")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
