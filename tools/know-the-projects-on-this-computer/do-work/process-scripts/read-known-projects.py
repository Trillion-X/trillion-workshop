#!/usr/bin/env python3
#
# Purpose:
#   Owner-side project discovery helper executed by workflow through
#   `compute.process`. It scans caller-provided roots/paths and emits normalized
#   project records for workflow ingestion.
#
# Invariants:
#   - No browser code reads the filesystem.
#   - Roots and paths are caller/configuration data, not hardcoded in this file.
#   - The script emits JSON only; workflow owns durable EEAF writes.

from __future__ import annotations

import datetime
import hashlib
import json
import pathlib
import sys
from typing import Any

PROJECT_MARKERS = (
    "package.json",
    "Cargo.toml",
    "pyproject.toml",
    "go.mod",
    "deno.json",
    "bun.lockb",
    ".git",
    ".claude",
)


def iso_from_epoch(epoch: float) -> str:
    return datetime.datetime.fromtimestamp(
        epoch,
        datetime.timezone.utc,
    ).isoformat().replace("+00:00", "Z")


def sha_id(prefix: str, value: str) -> str:
    digest = hashlib.sha256(value.encode("utf-8")).hexdigest()[:24]
    slug = pathlib.Path(value).name.strip().lower().replace(" ", "-") or "project"
    safe_slug = "".join(ch if ch.isalnum() or ch in "-_" else "-" for ch in slug).strip("-")
    return f"{prefix}:{safe_slug or 'project'}-{digest}"


def read_config(raw: str | None) -> dict[str, Any]:
    if not raw:
        return {}
    try:
        value = json.loads(raw)
    except Exception:
        return {"paths": [raw]}
    return value if isinstance(value, dict) else {}


def expand_path(value: Any) -> pathlib.Path | None:
    if not isinstance(value, str) or not value.strip():
        return None
    return pathlib.Path(value.strip()).expanduser().resolve()


def is_project_dir(path_obj: pathlib.Path) -> bool:
    if not path_obj.is_dir():
        return False
    return any((path_obj / marker).exists() for marker in PROJECT_MARKERS)


def iter_candidate_projects(config: dict[str, Any]) -> list[pathlib.Path]:
    candidates: dict[str, pathlib.Path] = {}

    for value in config.get("paths") or []:
        path_obj = expand_path(value)
        if path_obj and is_project_dir(path_obj):
            candidates[str(path_obj)] = path_obj

    for value in config.get("roots") or []:
        root = expand_path(value)
        if not root or not root.is_dir():
            continue
        if is_project_dir(root):
            candidates[str(root)] = root
        try:
            children = sorted(child for child in root.iterdir() if child.is_dir())
        except Exception:
            continue
        for child in children:
            if is_project_dir(child):
                candidates[str(child)] = child

    return [candidates[key] for key in sorted(candidates)]


def read_preview_descriptor(path_obj: pathlib.Path) -> dict[str, Any]:
    descriptor = path_obj / ".architect-preview.json"
    if not descriptor.exists():
        return {}
    try:
        payload = json.loads(descriptor.read_text(encoding="utf-8"))
    except Exception:
        return {}
    return payload if isinstance(payload, dict) else {}


def normalize_preview_command(value: Any, project_path: pathlib.Path) -> dict[str, Any] | None:
    if not isinstance(value, dict):
        return None
    argv = value.get("argv")
    if not isinstance(argv, list) or not all(isinstance(item, str) for item in argv):
        return None
    cwd = value.get("cwd")
    env = value.get("env")
    timeout_ms = value.get("timeout_ms")
    cwd_path = project_path
    if isinstance(cwd, str) and cwd.strip():
        candidate = pathlib.Path(cwd.strip()).expanduser()
        cwd_path = candidate if candidate.is_absolute() else (project_path / candidate)
    command: dict[str, Any] = {
        "argv": argv,
        "cwd": str(cwd_path.resolve()),
        "env": env if isinstance(env, dict) else {},
    }
    if isinstance(timeout_ms, int) and timeout_ms > 0:
        command["timeout_ms"] = timeout_ms
    return command


def normalize_status_probe(value: Any, project_path: pathlib.Path) -> dict[str, Any] | None:
    if not isinstance(value, dict):
        return None
    command = normalize_preview_command(value.get("command"), project_path)
    if command:
        return {"kind": "command", "command": command}
    return None


def normalize_project(path_obj: pathlib.Path) -> dict[str, Any]:
    stat_info = path_obj.stat()
    resolved_path = str(path_obj)
    is_git_repo = (path_obj / ".git").exists()
    record = {
        "project_id": sha_id("project", resolved_path),
        "path": resolved_path,
        "name": path_obj.name,
        "source": "git_scan" if is_git_repo else "user_config",
        "is_git_repo": is_git_repo,
        "has_claude_dir": (path_obj / ".claude").exists(),
        "last_activity": iso_from_epoch(stat_info.st_mtime),
    }
    preview = read_preview_descriptor(path_obj)
    url = preview.get("url") if isinstance(preview.get("url"), str) else None
    if url:
        record["resolved_url"] = url.strip()
    command = normalize_preview_command(preview.get("command"), path_obj)
    if command:
        record["preview_command"] = command
    status_probe = normalize_status_probe(preview.get("status_probe"), path_obj)
    if status_probe:
        record["preview_status_probe"] = status_probe
    return record


def main() -> int:
    out_path = sys.argv[1] if len(sys.argv) > 1 else "known-projects.json"
    config = read_config(sys.argv[2] if len(sys.argv) > 2 else None)
    projects = [normalize_project(path_obj) for path_obj in iter_candidate_projects(config)]
    with open(out_path, "w", encoding="utf-8") as handle:
        json.dump({"projects": projects}, handle, ensure_ascii=False)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
