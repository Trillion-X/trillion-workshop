#!/usr/bin/env python3
"""Select actual metric values and comments from a provider read response."""

import json
import math
import sys


def at_path(value, pointer):
    if pointer == "":
        return value
    if not isinstance(pointer, str) or not pointer.startswith("/"):
        return None
    for token in pointer[1:].split("/"):
        token = token.replace("~1", "/").replace("~0", "~")
        if isinstance(value, list):
            try:
                value = value[int(token)]
            except (ValueError, IndexError):
                return None
        elif isinstance(value, dict):
            if token not in value:
                return None
            value = value[token]
        else:
            return None
    return value


def normalize(status_code, body, profile):
    if not isinstance(status_code, int) or not 200 <= status_code < 300:
        raise ValueError("The provider did not return a successful read.")
    if isinstance(body, str):
        try:
            body = json.loads(body)
        except json.JSONDecodeError as error:
            raise ValueError("The provider response was not valid JSON.") from error
    if not isinstance(profile, dict):
        raise ValueError("The provider read profile is unavailable.")

    metric_paths = profile.get("metric_paths") or {}
    if not isinstance(metric_paths, dict):
        raise ValueError("Metric paths must be an object.")
    metrics = {}
    for name, pointer in metric_paths.items():
        value = at_path(body, pointer)
        if isinstance(value, (int, float)) and not isinstance(value, bool) and math.isfinite(value):
            metrics[name] = value

    comments_path = profile.get("comments_path")
    if not isinstance(comments_path, str):
        raise ValueError("The provider read profile must declare a comments path.")
    rows = at_path(body, comments_path)
    if not isinstance(rows, list):
        raise ValueError("The provider response did not contain the declared comments list.")
    fields = profile.get("comment_fields") or {}
    if not isinstance(fields, dict) or not fields:
        raise ValueError("The provider read profile must select comment fields.")
    comments = []
    for row in rows:
        if not isinstance(row, dict):
            continue
        selected = {name: value for name, pointer in fields.items()
                    if (value := at_path(row, pointer)) is not None
                    and isinstance(value, (str, int, float, bool))}
        if selected:
            comments.append(selected)

    return {"metrics": metrics, "comments": comments, "provider_status_code": status_code}


if __name__ == "__main__":
    if len(sys.argv) != 4:
        raise SystemExit("Provider response and collection profile are required.")
    print(json.dumps(normalize(int(sys.argv[1]), sys.argv[2], json.loads(sys.argv[3])), separators=(",", ":")))
