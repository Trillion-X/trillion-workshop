#!/usr/bin/env python3
"""Merge one current, addressed conversation-source fact into Chat's source list."""

import json
import pathlib
import sys


PROPERTY = "prop:observed_content:conversation_source_descriptor"


def rows(value):
    if isinstance(value, dict):
        value = value.get("payload", [])
    return value if isinstance(value, list) else []


def merge(current, addressed, source_ref):
    if not isinstance(source_ref, str) or not source_ref.startswith("source:"):
        raise ValueError("a current source identity is required")
    by_source = {}
    for row in rows(current):
        if isinstance(row, dict) and row.get("property_id") == PROPERTY:
            subject = row.get("subject_id")
            if isinstance(subject, str) and subject:
                by_source[subject] = row
    by_source.pop(source_ref, None)
    if isinstance(addressed, dict) and addressed.get("found") is True:
        fact = addressed.get("payload")
    elif isinstance(addressed, dict) and addressed.get("found") is False:
        fact = None
    else:
        fact = addressed
    if fact is not None:
        if not isinstance(fact, dict) or fact.get("subject_id") != source_ref or fact.get("property_id") != PROPERTY:
            raise ValueError("addressed source fact does not match the requested identity")
        specs = json.loads(fact.get("value_json", "null"))
        if not isinstance(specs, list) or not specs:
            raise ValueError("conversation source descriptor must contain at least one spec")
        by_source[source_ref] = fact
    return [by_source[key] for key in sorted(by_source)]


def main():
    if len(sys.argv) != 5:
        raise SystemExit("usage: merge-conversation-source.py <current.json> <addressed.json> <source_ref> <out.json>")
    current = json.loads(pathlib.Path(sys.argv[1]).read_text(encoding="utf-8"))
    addressed = json.loads(pathlib.Path(sys.argv[2]).read_text(encoding="utf-8"))
    result = merge(current, addressed, sys.argv[3])
    pathlib.Path(sys.argv[4]).write_text(json.dumps(result, separators=(",", ":")), encoding="utf-8")


if __name__ == "__main__":
    main()
