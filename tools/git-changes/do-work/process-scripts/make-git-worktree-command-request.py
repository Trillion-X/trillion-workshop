#!/usr/bin/env python3
#
# Purpose:
#   Build direct compute.process descriptors for git-worktree actions from
#   canonical project rows and workflow-supplied command templates.
#
# Invariants:
#   - This script never executes git or any other OS process.
#   - Git commands are data in the workflow; this file only renders descriptors.
#   - Project paths come from canonical project rows.

from __future__ import annotations

import argparse
import json
import pathlib
from typing import Any


def as_string(value: Any) -> str | None:
    return value if isinstance(value, str) and value else None


def parse_json(value: str | None, fallback: Any) -> Any:
    if not value:
        return fallback
    try:
        return json.loads(value)
    except Exception:
        return fallback


def build_project_index(rows: list[dict[str, Any]]) -> dict[str, dict[str, Any]]:
    projects: dict[str, dict[str, Any]] = {}
    for row in rows:
        subject_id = as_string(row.get("subject_id"))
        property_id = as_string(row.get("property_id"))
        value = row.get("value_json")
        if subject_id is None or property_id is None:
            continue
        project = projects.setdefault(
            subject_id,
            {"project_id": subject_id, "project_name": subject_id, "path": None},
        )
        if property_id in ("prop:managed_project:path", "prop:project:path") and isinstance(value, str) and value:
            project["path"] = value
        elif property_id == "prop:project:name" and isinstance(value, str) and value:
            project["project_name"] = value
    return projects


def resolve_project(project_id: str, rows: list[dict[str, Any]]) -> dict[str, str]:
    project = build_project_index(rows).get(project_id)
    if project is None:
        raise RuntimeError(f"Unknown project id: {project_id}")
    repo_path = as_string(project.get("path"))
    if repo_path is None:
        raise RuntimeError(f"Project has no canonical path: {project_id}")
    return {
        "project_id": project["project_id"],
        "project_name": project["project_name"],
        "path": repo_path,
    }


def read_path(value: Any, path: str) -> Any:
    current = value
    for part in path.split("."):
        if not part:
            continue
        if not isinstance(current, dict):
            return None
        current = current.get(part)
    return current


def resolve_template_value(part: Any, project: dict[str, str], action_input: dict[str, Any]) -> list[str]:
    if isinstance(part, str):
        return [part]
    if not isinstance(part, dict):
        return []
    source = part.get("from")
    path = as_string(part.get("path"))
    if source == "project" and path:
        value = read_path(project, path)
    elif source == "input" and path:
        value = read_path(action_input, path)
    else:
        value = part.get("literal")
    if part.get("spread") is True and isinstance(value, list):
        return [item for item in value if isinstance(item, str) and item]
    return [value] if isinstance(value, str) and value else []


def render_argv(template: Any, project: dict[str, str], action_input: dict[str, Any]) -> list[str]:
    if not isinstance(template, list):
        raise RuntimeError("Git command template must provide an argv array")
    argv: list[str] = []
    for part in template:
        argv.extend(resolve_template_value(part, project, action_input))
    if not argv:
        raise RuntimeError("Git command template rendered an empty argv")
    return argv


def build_descriptor(command: dict[str, Any], project: dict[str, str], action_input: dict[str, Any]) -> dict[str, Any]:
    cwd = as_string(command.get("cwd"))
    if cwd is not None and (pathlib.PurePath(cwd).is_absolute() or ".." in pathlib.PurePath(cwd).parts):
        raise RuntimeError("Git command cwd must be relative to a materialized process input tree")
    return {
        "argv": render_argv(command.get("argv"), project, action_input),
        "cwd": cwd if cwd not in (None, ".") else None,
        "timeout_ms": command.get("timeout_ms") if isinstance(command.get("timeout_ms"), int) else 300000,
        "termination_grace_ms": 1000,
        "expected_termination": None,
        "env": command.get("env") if isinstance(command.get("env"), dict) else {},
        "inputs": [],
        "input_trees": [],
        "outputs": [],
        "containment": {
            "kind": "descendant_effect_contained",
            "pipe_eof_timeout_ms": 1000,
            "publications": [],
        },
        "capture_fds": [1, 2],
        "collected_files": [],
    }


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--project-rows-json", required=True)
    parser.add_argument("--action-input-json", required=True)
    parser.add_argument("--command-json", required=True)
    parser.add_argument("--output-json", required=True)
    args = parser.parse_args()

    rows = parse_json(args.project_rows_json, [])
    action_input = parse_json(args.action_input_json, {})
    command_config = parse_json(args.command_json, {})
    if not isinstance(rows, list):
        rows = []
    if not isinstance(action_input, dict):
        action_input = {}
    if not isinstance(command_config, dict):
        command_config = {}

    project_id = as_string(action_input.get("project_id"))
    if project_id is None:
        raise RuntimeError("project_id is required")
    project = resolve_project(project_id, rows)

    payload: dict[str, Any] = {
        "project": project,
        "action_input": action_input,
        "output_kind": as_string(command_config.get("output_kind")) or "worktree",
    }
    primary = command_config.get("primary")
    refresh = command_config.get("refresh")
    if isinstance(primary, dict):
        payload["primary_process_descriptor"] = build_descriptor(primary, project, action_input)
    if isinstance(refresh, dict):
        payload["refresh_process_descriptor"] = build_descriptor(refresh, project, action_input)

    pathlib.Path(args.output_json).write_text(json.dumps(payload, ensure_ascii=False), encoding="utf-8")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
