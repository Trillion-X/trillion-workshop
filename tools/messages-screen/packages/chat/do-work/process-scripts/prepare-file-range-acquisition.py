#!/usr/bin/env python3
"""Plan and verify bounded Local Files range reads for file-backed sources."""

import base64
import json
import pathlib
import sys

RANGE_BYTES = 1_048_576
MAX_FILES = 8
MAX_FILE_BYTES = 10 * 1024 * 1024 * 1024


def _files(scan):
    if not isinstance(scan, dict) or scan.get("success") is not True:
        raise ValueError("file scan did not succeed")
    files = scan.get("files", [])
    if not isinstance(files, list) or len(files) > MAX_FILES:
        raise ValueError("file scan result is malformed or unbounded")
    return files


def plan(scan, before_offset=None):
    ranges = []
    for item in _files(scan):
        if not isinstance(item, dict):
            raise ValueError("file scan item is malformed")
        path = item.get("path")
        total = item.get("byte_length")
        state = item.get("file_state")
        if (
            not isinstance(path, str) or not path
            or isinstance(total, bool) or not isinstance(total, int)
            or total < 0 or total > MAX_FILE_BYTES
            or not isinstance(state, str) or not state
        ):
            raise ValueError("file scan identity is malformed")
        expected_revision = None
        if before_offset is None:
            end = total
        elif isinstance(before_offset, dict):
            if (
                set(before_offset) != {"version", "path", "revision", "total_length", "before_offset"}
                or before_offset.get("version") != 1
                or before_offset.get("path") != path
                or before_offset.get("total_length") != total
                or not isinstance(before_offset.get("revision"), str)
                or not before_offset.get("revision")
            ):
                raise ValueError("range cursor identity does not match the selected file")
            end = before_offset.get("before_offset")
            expected_revision = before_offset["revision"]
        else:
            end = before_offset
        if isinstance(end, bool) or not isinstance(end, int) or end < 0 or end > total:
            raise ValueError("range cursor is outside the selected file")
        # Include one byte before the nominal window whenever possible. The
        # decoder can then distinguish an exact line boundary (that byte is
        # ``\n``) from a range beginning inside UTF-8/JSONL content without
        # guessing from a coincidentally valid suffix.
        nominal = max(0, end - (RANGE_BYTES - 1))
        start = nominal - 1 if nominal > 0 else 0
        ranges.append({
            "path": path,
            "offset": start,
            "length": max(1, end - start),
            "expected_total_length": total,
            "scan_file_state": state,
            "modified_unix_nanos": item.get("modified_unix_nanos"),
            "relative_path": item.get("relative_path"),
            "account_dir": item.get("account_dir"),
            **({"expected_revision": expected_revision} if expected_revision else {}),
        })
    return {"ranges": ranges}


def _responses(value):
    found = []
    seen = set()

    def visit(node):
        if isinstance(node, list):
            for child in node:
                visit(child)
        elif isinstance(node, dict):
            if node.get("operation") == "read_file_range":
                # Workflow can carry the same child return through more than
                # one authoritative compatibility branch.  That is one native
                # read, not two replies.  Collapse only byte-identical response
                # objects; the path/revision/boundary checks below still refuse
                # two distinct replies for one planned path.
                identity = json.dumps(node, sort_keys=True, separators=(",", ":"))
                if identity not in seen:
                    seen.add(identity)
                    found.append(node)
                return
            # The saved Workflow envelope carries included steps in an object
            # keyed by declared step IDs. Those IDs are not wrapper names, so a
            # fixed key list cannot reach the native response. Walk container
            # values and recognize only the exact read_file_range operation;
            # scalar fields (including transcript bytes) are never parsed.
            for child in node.values():
                if isinstance(child, (dict, list)):
                    visit(child)
    visit(value)
    return found


def combine(scan, plan_value, range_value):
    planned = plan_value.get("ranges") if isinstance(plan_value, dict) else None
    if not isinstance(planned, list) or len(planned) > MAX_FILES:
        raise ValueError("range plan is malformed or unbounded")
    replies = _responses(range_value)
    if len(replies) != len(planned):
        raise ValueError("range replies do not match the range plan")
    by_path = {}
    for reply in replies:
        files = reply.get("files")
        before = reply.get("revision_before")
        after = reply.get("revision_after")
        total = reply.get("byte_length")
        if (
            reply.get("success") is not True
            or not isinstance(files, list) or len(files) != 1
            or not isinstance(before, str) or not before or before != after
            or isinstance(total, bool) or not isinstance(total, int)
        ):
            raise ValueError("range reply lacks stable revision proof")
        item = files[0]
        path = item.get("path") if isinstance(item, dict) else None
        if not isinstance(path, str) or path in by_path:
            raise ValueError("range reply path is malformed or repeated")
        by_path[path] = (reply, item)
    hydrated = []
    for request in planned:
        path = request.get("path") if isinstance(request, dict) else None
        pair = by_path.get(path)
        if pair is None:
            raise ValueError("planned range has no matching reply")
        reply, item = pair
        region = item.get("range")
        encoded = item.get("bytes_base64")
        if not isinstance(region, dict) or not isinstance(encoded, str):
            raise ValueError("range bytes are missing")
        try:
            raw = base64.b64decode(encoded, validate=True)
        except (TypeError, ValueError) as error:
            raise ValueError("range bytes are malformed") from error
        expected_total = request.get("expected_total_length")
        if (
            reply.get("byte_length") != expected_total
            or item.get("byte_length") != expected_total
            or region.get("total_length") != expected_total
            or region.get("offset") != request.get("offset")
            or region.get("length") != len(raw)
            or len(raw) != min(request.get("length"), expected_total - request.get("offset"))
        ):
            raise ValueError("range reply changed length or boundary")
        if request.get("expected_revision") is not None and reply["revision_before"] != request["expected_revision"]:
            raise ValueError("range reply revision changed between pages")
        hydrated.append({
            "path": path,
            "file_state": request.get("scan_file_state"),
            "byte_length": expected_total,
            "bytes_base64": encoded,
            "range": region,
            "revision_before": reply["revision_before"],
            "revision_after": reply["revision_after"],
            "modified_unix_nanos": request.get("modified_unix_nanos"),
            "relative_path": request.get("relative_path"),
            "account_dir": request.get("account_dir"),
        })
    states = scan.get("file_states")
    if "file_states" in scan and not isinstance(states, dict):
        raise ValueError("file scan states are malformed")
    result = {
        "success": True,
        "operation": "read_file_ranges",
        "complete": scan.get("complete") is True,
        "window_complete": True,
    }
    if hydrated or "files" in scan:
        result["files"] = hydrated
    if states is not None:
        result["file_states"] = states
    return result


def main():
    mode, scan_path, output_path = sys.argv[1:4]
    scan = json.loads(pathlib.Path(scan_path).read_text(encoding="utf-8"))
    if mode == "plan":
        before = None if len(sys.argv) < 5 or sys.argv[4] in ("", "null") else json.loads(sys.argv[4])
        result = plan(scan, before)
    elif mode == "combine":
        planned = json.loads(pathlib.Path(sys.argv[4]).read_text(encoding="utf-8"))
        replies = json.loads(pathlib.Path(sys.argv[5]).read_text(encoding="utf-8"))
        result = combine(scan, planned, replies)
    else:
        raise SystemExit("unknown range acquisition mode")
    pathlib.Path(output_path).write_text(json.dumps(result, separators=(",", ":")), encoding="utf-8")


if __name__ == "__main__":
    main()
