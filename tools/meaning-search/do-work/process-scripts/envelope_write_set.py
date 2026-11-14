#!/usr/bin/env python3
"""Materialize generic process-produced Envelope write-set manifests.

The manifest is deliberately only routing metadata.  Every payload is written
to a separate relative file so process-engine can validate the complete batch
and commit it atomically without a large JSON value crossing Workflow.
"""
from __future__ import annotations

import json
import os
import tempfile
from pathlib import Path
from typing import Any


def _required_text(value: Any, field: str) -> str:
    if not isinstance(value, str) or not value:
        raise ValueError(f"{field} must be a non-empty string")
    return value


def _path_labels(value: Any, index: int) -> list[str]:
    if not isinstance(value, list) or not value:
        raise ValueError(f"rows[{index}].path must be a non-empty array of strings")
    labels: list[str] = []
    for path_index, label in enumerate(value):
        labels.append(_required_text(label, f"rows[{index}].path[{path_index}]"))
    return labels


def _payload_bytes(value: Any, index: int) -> bytes:
    if not isinstance(value, dict):
        raise ValueError(f"rows[{index}].payload must be an object")
    try:
        return json.dumps(value, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
    except (TypeError, ValueError) as exc:
        raise ValueError(f"rows[{index}].payload must be JSON serializable") from exc


def manifest_and_payloads(rows: Any) -> tuple[dict[str, Any], dict[str, bytes]]:
    """Convert existing generic fact rows into a version-1 write-set.

    Rows are intentionally strict: an add has exactly ``address``, ``path``,
    and ``payload``; a retract has exactly ``address``, ``path``, and
    ``remove: true``.  This makes malformed mixed add/retract rows impossible
    to reinterpret at the process-engine boundary.
    """
    if not isinstance(rows, list):
        raise ValueError("rows must be an array")
    writes: list[dict[str, Any]] = []
    payloads: dict[str, bytes] = {}
    seen_targets: set[tuple[str, tuple[str, ...]]] = set()
    for index, row in enumerate(rows):
        if not isinstance(row, dict):
            raise ValueError(f"rows[{index}] must be an object")
        address = _required_text(row.get("address"), f"rows[{index}].address")
        path_labels = _path_labels(row.get("path"), index)
        target = (address, tuple(path_labels))
        if target in seen_targets:
            raise ValueError(f"rows[{index}] duplicates an earlier address/path target")
        seen_targets.add(target)
        remove = row.get("remove", False)
        if not isinstance(remove, bool):
            raise ValueError(f"rows[{index}].remove must be a boolean")
        is_retract = remove is True
        expected_keys = {"address", "path", "remove"} if is_retract else {"address", "path", "payload"}
        if set(row) != expected_keys:
            kind = "retraction" if is_retract else "addition"
            raise ValueError(f"rows[{index}] {kind} has unsupported or missing fields")
        write: dict[str, Any] = {
            "address_label": address,
            "address_mode": "identity_text",
            "path_labels": path_labels,
        }
        if is_retract:
            write["remove"] = True
        else:
            content_path = f"payloads/{index}.json"
            write["content_path"] = content_path
            payloads[content_path] = _payload_bytes(row["payload"], index)
        writes.append(write)
    return {"version": 1, "writes": writes}, payloads


def _atomic_write(path: Path, value: bytes) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, temporary_name = tempfile.mkstemp(prefix=".envelope-write-set-", dir=path.parent)
    try:
        with os.fdopen(fd, "wb") as handle:
            handle.write(value)
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(temporary_name, path)
    except BaseException:
        try:
            os.unlink(temporary_name)
        except FileNotFoundError:
            pass
        raise


def write_envelope_write_set(rows: Any, manifest_path: str) -> dict[str, Any]:
    """Write payload files and a version-1 relative-path manifest atomically."""
    manifest, payloads = manifest_and_payloads(rows)
    destination = Path(manifest_path)
    for relative_path, payload in payloads.items():
        _atomic_write(destination.parent / relative_path, payload)
    _atomic_write(
        destination,
        json.dumps(manifest, ensure_ascii=False, separators=(",", ":")).encode("utf-8"),
    )
    return manifest
