#!/usr/bin/env python3
# Generic outside-activity acquisition leaf.
#
# Input: one plan entry whose descriptor SELF-DESCRIBES the observed thing as a
# `content` object (any shape) — a watched video, a read article, a browser-visit
# event, a desktop-activity span, a service-feed item, anything. Output: one
# observed-content batch. This handler is BLIND: it copies the descriptor's
# `content` through verbatim, derives identity (native_ref) + cursor + multihash,
# and never branches on the source TYPE (L090 self-describing data, generic
# handler / L069 generative primitive — a new source = a new descriptor DATA shape,
# ZERO code change here). The "manual" adapter (top-level url/text) is just ONE
# configuration, kept working for backward compatibility, never privileged.
import datetime
import hashlib
import json
import pathlib
import sys
from urllib.parse import urlparse


def host_of(url_text):
    """A readable source label for an observation (e.g. 'paulgraham.com'). Empty on failure."""
    try:
        host = (urlparse(url_text).hostname or "").strip()
    except (ValueError, TypeError):
        host = ""
    return host[4:] if host.startswith("www.") else host


def read_json(path_text):
    return json.loads(pathlib.Path(path_text).read_text(encoding="utf-8"))


def write_json(path_text, value):
    pathlib.Path(path_text).write_text(json.dumps(value, separators=(",", ":")), encoding="utf-8")


def stable_multihash(value):
    encoded = json.dumps(value, sort_keys=True, separators=(",", ":")).encode("utf-8")
    return "sha2-256:" + hashlib.sha256(encoded).hexdigest()


def utc_now():
    return datetime.datetime.now(datetime.timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z")


def value_from_plan(plan_entry, key):
    """Find `key` anywhere a source descriptor could carry it — top-level, the
    `activity` payload, the `descriptor`, the descriptor's self-describing
    `content` object, or the legacy manual_input. Source-type-agnostic."""
    descriptor = plan_entry.get("descriptor") if isinstance(plan_entry.get("descriptor"), dict) else None
    location = descriptor.get("location") if descriptor and isinstance(descriptor.get("location"), dict) else None
    for container in (
        plan_entry,
        plan_entry.get("activity"),
        descriptor,
        descriptor.get("content") if descriptor else None,
        location.get("manual_input") if location else None,
    ):
        if isinstance(container, dict) and key in container:
            return container.get(key)
    return None


def collect_content(plan_entry):
    """The observation payload — copied through verbatim, no source-type branch.
    Prefer an explicit self-describing `content` object (any source); else
    assemble from whichever individually-named fields are present (manual/legacy)."""
    content = value_from_plan(plan_entry, "content")
    if isinstance(content, dict) and content:
        return dict(content)
    payload = {}
    for key in ("url", "text", "title", "body", "app", "window", "item_id", "event", "summary"):
        value = value_from_plan(plan_entry, key)
        if value is not None:
            payload[key] = value
    return payload


def main():
    if len(sys.argv) != 3:
        raise SystemExit("usage: acquire-activity-source.py <plan-entry.json> <batch.json>")

    plan_entry = read_json(sys.argv[1])
    descriptor = plan_entry.get("descriptor") if isinstance(plan_entry.get("descriptor"), dict) else plan_entry
    source_ref = plan_entry.get("source_ref") or descriptor.get("source_ref")
    if not source_ref:
        raise SystemExit("plan entry missing source_ref")

    payload = collect_content(plan_entry)
    is_no_action = not payload and value_from_plan(plan_entry, "no_action") is True
    if not payload and not is_no_action:
        raise SystemExit("activity input requires a non-empty content payload or explicit no_action=true")

    observed_at = value_from_plan(plan_entry, "observed_at") or utc_now()
    if is_no_action:
        prior = plan_entry.get("cursor")
        write_json(sys.argv[2], {
            "batch_ref": None,
            "source_ref": source_ref,
            "authorization_scope_ref": None,
            "observed_at": observed_at,
            "observations": [],
            "next_cursor": prior,
            "no_action": {"meaningful": True, "reason": value_from_plan(plan_entry, "reason") or "source reported no new item"},
        })
        print("observations=0 no_action=true")
        return
    # Optional enrichment when the content carries a url — never required.
    url = payload.get("url")
    if url:
        payload.setdefault("host", host_of(url))
        payload.setdefault("title", url)
    # Carry the channel identity + time into the payload for downstream readability.
    payload.setdefault("source_ref", source_ref)
    payload.setdefault("observed_at", observed_at)
    metadata = value_from_plan(plan_entry, "metadata")
    if metadata is not None:
        payload.setdefault("metadata", metadata)

    # Identity of THIS observation within the source: explicit native_ref, else a
    # url, else the content hash — always derivable for ANY source type.
    # observed_at is provenance, never event identity. Replay of the same native
    # item + revision must derive the same cursor/batch even on another run.
    native_ref = value_from_plan(plan_entry, "native_ref") or url or stable_multihash(payload)
    revision_payload = dict(payload)
    revision_payload.pop("observed_at", None)
    revision_ref = stable_multihash(revision_payload)
    cursor = stable_multihash({"source_ref": source_ref, "native_ref": native_ref, "revision_ref": revision_ref})
    batch_ref = "batch:" + cursor
    provenance = descriptor.get("provenance") if isinstance(descriptor.get("provenance"), dict) else {}
    authorization = descriptor.get("authorization") if isinstance(descriptor.get("authorization"), dict) else {}
    connection_ref = descriptor.get("access_connection_ref")
    scope_material = {
        "connection_ref": connection_ref,
        "tenant_ref": authorization.get("tenant_ref"),
        "user_ref": authorization.get("user_ref"),
        "source_ref": source_ref,
    }
    authorization_scope_ref = authorization.get("authorization_scope_ref") or (
        "source-authorization:" + stable_multihash(scope_material)
    )

    batch = {
        "batch_ref": batch_ref,
        "source_ref": source_ref,
        "authorization_scope_ref": authorization_scope_ref,
        "observed_at": observed_at,
        "observations": [
            {
                "source_ref": source_ref,
                "native_ref": native_ref,
                "cursor": cursor,
                "observed_at": observed_at,
                "content_multihash": revision_ref,
                "source_identity_ref": "source-identity:" + stable_multihash({
                    "source_ref": source_ref,
                    "native_ref": native_ref,
                }),
                "source_revision_ref": revision_ref,
                "correlation_ref": batch_ref,
                "source_authorization": {
                    **authorization,
                    "connection_ref": connection_ref,
                    "access_mode": authorization.get("access_mode") or provenance.get("access_mode") or "read-only",
                    "status": authorization.get("status") or ("declared" if connection_ref else "permission-needed"),
                    "tenant_ref": authorization.get("tenant_ref"),
                    "user_ref": authorization.get("user_ref"),
                    "authorization_scope_ref": authorization_scope_ref,
                },
                "source_provenance": {
                    **provenance,
                    "source_ref": source_ref,
                    "native_ref": native_ref,
                    "observer_capability_ref": descriptor.get("observer_capability_ref"),
                    "observed_at": observed_at,
                    "cursor": cursor,
                },
                "payload": payload,
            }
        ],
        "next_cursor": {
            "kind": "content_multihash",
            "value": cursor,
            "advanced_at": observed_at,
        },
    }
    write_json(sys.argv[2], batch)
    print("observations=1")


if __name__ == "__main__":
    main()
