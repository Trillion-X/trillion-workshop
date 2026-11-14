#!/usr/bin/env python3
"""Bind a saved provider read profile to one exact published post."""

import json
import sys


def text(value):
    return value.strip() if isinstance(value, str) and value.strip() else None


def prepare(status, status_ref, source, note):
    if not isinstance(status, dict) or status.get("state") != "published":
        raise ValueError("The referenced post is not published.")
    remote = status.get("remote") or status.get("external_result") or {}
    if not isinstance(remote, dict):
        raise ValueError("The published post has no provider identity.")
    remote_id = text(remote.get("remote_content_id")) or text(remote.get("remote_object_id"))
    connection_ref = text(remote.get("service_connection_ref"))
    if not remote_id or not connection_ref:
        raise ValueError("The published post has no exact post and connection identity.")
    profile = source.get("collection_profile") if isinstance(source, dict) else None
    if not isinstance(profile, dict):
        raise ValueError("The provider read profile is unavailable.")
    if not isinstance(source, dict) or source.get("kind") != "content-analytics.source":
        raise ValueError("The selected analytics source is unavailable.")
    if source.get("connection_enabled") is not True:
        raise ValueError("The selected analytics source is not connected.")
    if text(source.get("source_id")) is None or text(source.get("source_fingerprint")) is None:
        raise ValueError("The selected analytics source is incomplete.")
    if text(source.get("service_connection_ref")) != connection_ref:
        raise ValueError("The published post does not match the selected analytics source.")
    note_name = text(profile.get("note_name"))
    operation = text(profile.get("operation"))
    if not note_name or not operation:
        raise ValueError("The provider read profile does not name a saved read operation.")
    if not isinstance(note, dict) or note.get("kind") != "how-to-ask-something-else-to-do-things":
        raise ValueError("The provider read operation note is unavailable.")
    if note.get("how_to_reach_it") != "http-request":
        raise ValueError("The provider read operation has no supported read transport.")
    if text(note.get("connection_ref")) != connection_ref:
        raise ValueError("The read operation does not belong to the published post's connection.")
    instrument_requests = note.get("instrument_requests")
    operation_request = instrument_requests.get(operation) if isinstance(instrument_requests, dict) else None
    if not isinstance(operation_request, dict) or str(operation_request.get("method", "GET")).upper() not in {"GET", "HEAD"}:
        raise ValueError("The saved provider operation is not an available read.")
    metric_paths = profile.get("metric_paths") or {}
    comment_fields = profile.get("comment_fields") or {}
    comments_path = profile.get("comments_path")
    if not isinstance(metric_paths, dict) or any(
        not isinstance(name, str) or not isinstance(path, str) or (path and not path.startswith("/"))
        for name, path in metric_paths.items()
    ):
        raise ValueError("The provider read profile has invalid metric paths.")
    if not isinstance(comments_path, str) or (comments_path and not comments_path.startswith("/")):
        raise ValueError("The provider read profile must declare a comments path.")
    if not isinstance(comment_fields, dict) or not comment_fields or any(
        not isinstance(name, str) or not isinstance(path, str) or (path and not path.startswith("/"))
        for name, path in comment_fields.items()
    ):
        raise ValueError("The provider read profile must select comment fields.")
    facts = profile.get("request_facts") or {}
    if not isinstance(facts, dict):
        raise ValueError("Provider request details must be an object.")
    # Identity comes from the published status and always wins over profile facts.
    facts = dict(facts)
    facts.update({
        "remote_content_id": remote_id,
        "service_connection_ref": connection_ref,
        "publish_status_ref": text(status_ref),
    })
    if not facts["publish_status_ref"]:
        raise ValueError("The published post reference is required.")
    return {"note_name": note_name, "operation": operation, "facts": facts,
            "remote_content_id": remote_id, "service_connection_ref": connection_ref,
            "source_id": source["source_id"], "source_fingerprint": source["source_fingerprint"],
            "collection_profile": profile}


if __name__ == "__main__":
    if len(sys.argv) != 5:
        raise SystemExit("Published post, analytics source and provider read note are required.")
    print(json.dumps(prepare(json.loads(sys.argv[1]), sys.argv[2], json.loads(sys.argv[3]), json.loads(sys.argv[4])), separators=(",", ":")))
