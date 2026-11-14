#!/usr/bin/env python3
"""
ingest-session-artifacts-to-runs.py

Fold session-artifact JSONL files into ai-execution-run write dispatches.

Blind by contract: this script names NO launcher. Every artifact shape is
described by the caller's source DATA row (root, glob, id_namespace,
launcher_ref, extract rules). A new launcher is a new DATA row, zero code.

Input (stdin or --config): {
  "partition_label": "<log partition>",
  "sources": [ {
      "source_ref": "<open id>",
      "root": "<dir>", "glob": "<pattern>",
      "id_namespace": "<string>",            # run identity namespace
      "launcher_ref": "<address-shaped>",    # provenance, open string
      "decoder_capability_ref": "<capability ref>",
      "agent_ref": { <extract rule> } | "literal string",
      "extract": {                            # generic field rules
        "native_id": {"from": "filename_stem"} | {<rule>},
        "started_at": {<rule>}, "ended_at": {<rule>},
        "objective": {<rule>}, "status": {<rule>} | "literal",
        "total_units": {"from": "count"}
      }
  } ],
  "since": "ISO-8601"?, "limit": N?
}

Extract rule: {"from": "first"|"last"|"first_where"|"last_where"|"count"|"filename_stem",
               "where": {"path": [..], "equals": <v>}?, "path": [..]?, "max_chars": N?}

Output (stdout JSON): {"writes": [...], "rejections": [...], "artifact_count": N}
Each write: {partition_label, address_label, path_labels, payload, expected_current}.
Identity: address = package::ai-execution-history::run::<token(namespace:native_id)>
so re-ingestion updates the SAME record (idempotent, duplicate-free).
"""
import argparse, base64, glob, hashlib, json, os, re, sys
from datetime import datetime, timezone


def now() -> str:
    return datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")


def get_path(obj, path):
    cur = obj
    for key in path or []:
        if isinstance(cur, dict):
            cur = cur.get(key)
        elif isinstance(cur, list) and isinstance(key, int) and -len(cur) <= key < len(cur):
            cur = cur[key]
        else:
            return None
    return cur


def coerce_text(value):
    if isinstance(value, str):
        return value
    if isinstance(value, list):
        parts = []
        for item in value:
            if isinstance(item, str):
                parts.append(item)
            elif isinstance(item, dict) and isinstance(item.get("text"), str):
                parts.append(item["text"])
        return "\n".join(parts) if parts else None
    if isinstance(value, dict) and isinstance(value.get("text"), str):
        return value["text"]
    return value


def matches(event, where):
    if where is None:
        return True
    if not isinstance(where, dict):
        return False
    if isinstance(where.get("all"), list):
        return all(matches(event, condition) for condition in where["all"])
    if isinstance(where.get("any"), list):
        return any(matches(event, condition) for condition in where["any"])
    value = get_path(event, where.get("path"))
    if "equals" in where:
        return value == where["equals"]
    if "not_equals" in where:
        return value != where["not_equals"]
    if where.get("is_not_null") is True:
        return value is not None
    return False


def count_matching(rule, ctx):
    return sum(1 for event in ctx["events"] if matches(event, rule.get("where")))


def count_text_matches(rule, ctx):
    flags = re.IGNORECASE if "i" in str(rule.get("flags", "")) else 0
    pattern = re.compile(rule["pattern"], flags)
    count = 0
    for event in ctx["events"]:
        if not matches(event, rule.get("where")):
            continue
        value = get_path(event, rule.get("path")) if rule.get("path") else event
        value = coerce_text(value)
        if not isinstance(value, str) and rule.get("stringify"):
            value = json.dumps(value, sort_keys=True, separators=(",", ":"))
        if isinstance(value, str) and pattern.search(value):
            count += 1
    return count


def scan_events(rule, ctx):
    """One generic scanner: direction/filter are rule DATA, not extractor variants."""
    events = ctx["events"]
    ordered = list(reversed(events)) if rule.get("direction") == "last" else events
    where = rule.get("where")
    for event in ordered:
        if not matches(event, where):
            continue
        value = coerce_text(get_path(event, rule.get("path"))) if rule.get("path") else event
        if value is None:
            continue
        if isinstance(value, str) and rule.get("strip_markup"):
            value = re.sub(r"<[^>]*>", " ", value)
            value = re.sub(r"\s+", " ", value).strip()
            if not value:
                continue
        max_chars = rule.get("max_chars")
        if isinstance(value, str) and isinstance(max_chars, int):
            value = value[:max_chars]
        return value
    return None


# Extractor registry: the dispatcher never enumerates kinds â it looks the
# discriminant up here. Built-ins are leaf bindings over scan_events; callers
# add extractors via config "extractor_modules" (data-selected capability
# packs), never by editing this dispatch. Legacy first/last/*_where names are
# data aliases onto the one scanner.
EXTRACTORS = {
    "scan": scan_events,
    "first": lambda rule, ctx: scan_events({**rule, "direction": "first"}, ctx),
    "last": lambda rule, ctx: scan_events({**rule, "direction": "last"}, ctx),
    "first_where": lambda rule, ctx: scan_events({**rule, "direction": "first"}, ctx),
    "last_where": lambda rule, ctx: scan_events({**rule, "direction": "last"}, ctx),
    "count": lambda rule, ctx: len(ctx["events"]),
    "count_matching": count_matching,
    "count_text_matches": count_text_matches,
    "filename_stem": lambda rule, ctx: os.path.splitext(os.path.basename(ctx["artifact_path"]))[0],
}


def load_extractor_modules(paths):
    """Merge EXTRACTORS dicts from caller-named module files (capability packs)."""
    import importlib.util
    for path in paths or []:
        spec = importlib.util.spec_from_file_location("extractor_pack", os.path.expanduser(path))
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
        EXTRACTORS.update(getattr(module, "EXTRACTORS", {}))


def run_rule(rule, events, artifact_path):
    if isinstance(rule, str):
        return rule
    if not isinstance(rule, dict):
        return None
    extractor = EXTRACTORS.get(rule.get("from"))
    if extractor is None:
        raise ValueError(f"unknown extractor {rule.get('from')!r} â register it via extractor_modules")
    return extractor(rule, {"events": events, "artifact_path": artifact_path})


def address_token(text):
    return re.sub(r"[^A-Za-z0-9._-]+", "-", text).strip("-")


def parse_events(raw_text):
    events, bad = [], 0
    for line in raw_text.splitlines():
        line = line.strip()
        if not line:
            continue
        try:
            events.append(json.loads(line))
        except json.JSONDecodeError:
            bad += 1
    return events, bad


def iter_events(path):
    with open(path, "r", encoding="utf-8", errors="replace") as handle:
        return parse_events(handle.read())


def acquired_events(file_info):
    encoded = file_info.get("bytes_base64")
    if not isinstance(encoded, str):
        raise ValueError("native local.files acquisition omitted bytes_base64")
    try:
        raw = base64.b64decode(encoded, validate=True).decode("utf-8", errors="replace")
    except (ValueError, UnicodeError) as error:
        raise ValueError(f"invalid native local.files bytes: {error}") from error
    return parse_events(raw)


def acquired_artifact_revision(file_info):
    """Return a path-free revision derived from the exact acquired bytes."""
    encoded = file_info.get("bytes_base64")
    modified = file_info.get("modified_unix_nanos")
    byte_length = file_info.get("byte_length")
    if not isinstance(encoded, str) or not isinstance(modified, int) or modified < 0:
        raise ValueError("native local.files acquisition omitted its immutable revision")
    try:
        raw = base64.b64decode(encoded, validate=True)
    except ValueError as error:
        raise ValueError(f"invalid native local.files bytes: {error}") from error
    if not isinstance(byte_length, int) or byte_length != len(raw):
        raise ValueError("native local.files acquisition byte length changed")
    return {
        "modified_unix_nanos": str(modified),
        "byte_length": byte_length,
        "content_sha256": hashlib.sha256(raw).hexdigest(),
    }


def source_revision(artifact_revisions):
    if not artifact_revisions:
        raise ValueError("source revision has no acquired artifacts")
    ordered = sorted(
        artifact_revisions,
        key=lambda item: (int(item["modified_unix_nanos"]), item["content_sha256"]),
    )
    material = json.dumps(ordered, sort_keys=True, separators=(",", ":")).encode("utf-8")
    return {
        "scheme": "acquired-session-artifacts-v1",
        "observed_modified_unix_nanos": str(max(int(item["modified_unix_nanos"]) for item in ordered)),
        "artifact_set_sha256": hashlib.sha256(material).hexdigest(),
    }


def event_sort_key(event, source_position):
    """Preserve source order while using an explicit event coordinate when present."""
    for path in (["timestamp"], ["created_at"], ["payload", "timestamp"], ["sequence"]):
        value = get_path(event, path)
        if isinstance(value, (str, int, float)):
            return (0, str(value), source_position)
    return (1, "", source_position)


def normalize_events(event_groups):
    """Merge rotated/duplicate fragments once without retaining their host paths."""
    ordered, seen = [], set()
    source_position = 0
    for events in event_groups:
        for event in events:
            canonical = json.dumps(event, sort_keys=True, separators=(",", ":"), ensure_ascii=False)
            if canonical in seen:
                continue
            seen.add(canonical)
            ordered.append((event_sort_key(event, source_position), event))
            source_position += 1
    ordered.sort(key=lambda item: item[0])
    return [event for _, event in ordered]


def permission_state(source):
    permission = source.get("permission")
    if not isinstance(permission, dict):
        return "legacy-local-only"
    state = permission.get("state")
    scopes = permission.get("scopes") or []
    if state != "active" or "analyze-local-session" not in scopes:
        return "revoked-or-out-of-scope"
    return "active"


def build_run(
    source,
    artifact_path,
    events,
    partition_label,
    artifact_info=None,
    artifact_count=1,
    artifact_revisions=None,
    acquisition_revision=None,
):
    rules = source.get("extract") or {}
    native_id = run_rule(rules.get("native_id", {"from": "filename_stem"}), events, artifact_path)
    if not native_id:
        raise ValueError("native_id resolved empty")
    stable_id = f"{source['id_namespace']}:{native_id}"
    fields = {}
    for name in ("started_at", "ended_at", "objective", "status", "label"):
        value = run_rule(rules.get(name), events, artifact_path)
        if value is not None:
            fields[name] = value
    total_units = run_rule(rules.get("total_units"), events, artifact_path)
    metrics = {}
    for name, rule in (rules.get("metrics") or {}).items():
        value = run_rule(rule, events, artifact_path)
        if value is not None:
            metrics[name] = value
    agent_ref = run_rule(source.get("agent_ref"), events, artifact_path)
    label = fields.get("label") or (
        f"{agent_ref or source['id_namespace']} â {fields['objective'][:80]}" if "objective" in fields
        else f"{agent_ref or source['id_namespace']} â {native_id}"
    )
    source_ref = source.get("source_ref") or "unidentified-source"
    installation_ref = source.get("installation_ref")
    user_ref = source.get("user_ref")
    source_trust = source.get("trust") if isinstance(source.get("trust"), dict) else {}
    trust_state = source_trust.get("state")
    trust_score = source_trust.get("score")
    trust = (
        {"state": "trusted", "score": trust_score}
        if trust_state == "trusted" and isinstance(trust_score, (int, float))
        and 0 <= trust_score <= 1
        else {"state": "unassessed"}
    )
    revisions = artifact_revisions
    if revisions is None and isinstance(artifact_info, dict):
        revisions = [acquired_artifact_revision(artifact_info)]
    revision = source_revision(revisions or []) if revisions else None
    observed_modified_unix_nanos = (
        int(revision["observed_modified_unix_nanos"])
        if revision
        else artifact_info.get("modified_unix_nanos") if isinstance(artifact_info, dict) else None
    )
    payload = {
        "kind": "ai-execution-run",
        "id": f"ai-execution-run:{stable_id}",
        "label": label,
        **({"agent_ref": agent_ref} if agent_ref else {}),
        **({"started_at": fields["started_at"]} if "started_at" in fields else {}),
        **({"ended_at": fields["ended_at"]} if "ended_at" in fields else {}),
        **({"status": fields["status"]} if "status" in fields else {}),
        **({"objective": {"snapshot_text": fields["objective"]}} if "objective" in fields else {}),
        "launch": {
            "launcher_ref": source.get("launcher_ref"),
            "native_session_ref": str(native_id),
        },
        **({"cost": {"total_units": total_units}} if isinstance(total_units, int) else {}),
        **({"metrics": metrics} if metrics else {}),
        "trust": trust,
        **({"correlation_refs": source["correlation_refs"]} if source.get("correlation_refs") else {}),
        "provenance": {
            "producer_ref": "capability:ingest-session-artifacts",
            "decoder_capability_ref": source.get("decoder_capability_ref"),
            **({"source_evidence_policy_ref": source["evidence_policy_ref"]}
               if source.get("evidence_policy_ref") else {}),
            **({"source_evidence_policy_revision": source["evidence_policy_revision"]}
               if source.get("evidence_policy_revision") else {}),
            # Raw paths and transcript bytes are installation-private.  The durable
            # ledger retains only an opaque source identity and normalization facts.
            "source_ref": source_ref,
            "source_artifact_count": artifact_count,
            **({"source_revision": revision} if revision else {}),
            "source_permission_state": permission_state(source),
            **({"installation_ref": installation_ref} if installation_ref else {}),
            **({"user_ref": user_ref} if user_ref else {}),
            "ingested_at": (
                datetime.fromtimestamp(
                    observed_modified_unix_nanos / 1_000_000_000,
                    timezone.utc,
                ).isoformat().replace("+00:00", "Z")
                if isinstance(observed_modified_unix_nanos, int)
                else now()
            ),
        },
    }
    return {
        "partition_label": partition_label,
        "address_label": f"package::ai-execution-history::run::{address_token(stable_id)}",
        # L126 exhaust-off: ai-execution-run is operational exhaust no user tab renders;
        # keep it OFF the shared published-record aggregate. Its 2 readers (this package's
        # exec-history-feed + agents-hub-registry-feed) are both-paths robust (read the index
        # path AND published-record), so re-folding existing runs onto the index supersedes
        # their published-record versions and shrinks the ~34.7MB aggregate. Paired producer:
        # workflow-action write-execution-run-record (already on ai-execution-run-index).
        "path_labels": ["current-item", "ai-execution-run-index"],
        "payload": payload,
        "expected_current": "read-current",
        **({"acquisition_revision": acquisition_revision} if acquisition_revision else {}),
    }


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[2])
    parser.add_argument("--config", help="config JSON path (default: stdin)")
    parser.add_argument("--out", help="result JSON path (default: stdout)")
    parser.add_argument("--acquisition", help="native local.files scan response JSON path")
    args = parser.parse_args()
    raw = open(args.config).read() if args.config else sys.stdin.read()
    config = json.loads(raw)
    if "sources" not in config and isinstance(config.get("source"), dict):
        config["sources"] = [config["source"]]
    if args.acquisition:
        with open(args.acquisition, "r", encoding="utf-8") as handle:
            acquisition = json.load(handle)
        config["acquired_files"] = acquisition.get("files", [])
    load_extractor_modules(config.get("extractor_modules"))
    partition_label = config["partition_label"]
    since = config.get("since")
    limit = config.get("limit")
    writes, rejections, artifact_count = [], [], 0
    grouped = {}
    acquisition_revision = config.get("acquisition_revision")
    if acquisition_revision is not None and (
        not isinstance(acquisition_revision, str)
        or not re.fullmatch(r"1f:[0-9a-f]{64}", acquisition_revision)
    ):
        raise ValueError("acquisition revision is invalid")
    acquired_files = config.get("acquired_files")
    for source in config.get("sources", []):
        if permission_state(source) == "revoked-or-out-of-scope":
            rejections.append({
                "kind": "ai-execution-run-ingest-rejection",
                "source_ref": source.get("source_ref"),
                "error": "source permission is revoked or lacks analyze-local-session scope",
                "at": now(),
            })
            continue
        if isinstance(acquired_files, list):
            artifacts = [
                (item.get("path"), item)
                for item in acquired_files
                if isinstance(item, dict) and isinstance(item.get("path"), str)
            ]
        else:
            paths = sorted(glob.glob(
                os.path.join(os.path.expanduser(source["root"]), source["glob"]),
                recursive=True,
            ))
            artifacts = [(path, None) for path in paths if os.path.isfile(path)]
        for artifact_index, (path, artifact_info) in enumerate(artifacts):
            if limit is not None and artifact_count >= limit:
                break
            if since:
                if isinstance(artifact_info, dict) and isinstance(
                    artifact_info.get("modified_unix_nanos"), int
                ):
                    modified = datetime.fromtimestamp(
                        artifact_info["modified_unix_nanos"] / 1_000_000_000,
                        timezone.utc,
                    ).isoformat()
                else:
                    modified = datetime.fromtimestamp(
                        os.path.getmtime(path), timezone.utc
                    ).isoformat()
                if modified < since:
                    continue
            artifact_count += 1
            try:
                events, bad_lines = (
                    acquired_events(artifact_info)
                    if artifact_info is not None
                    else iter_events(path)
                )
                if not events:
                    raise ValueError(f"no parseable events (bad_lines={bad_lines})")
                rules = source.get("extract") or {}
                native_id = run_rule(
                    rules.get("native_id", {"from": "filename_stem"}), events, path
                )
                if not native_id:
                    raise ValueError("native_id resolved empty")
                group_key = (source.get("id_namespace"), str(native_id))
                entry = grouped.setdefault(group_key, {
                    "source": source,
                    "artifact_path": path,
                    "artifact_info": artifact_info,
                    "event_groups": [],
                    "artifact_count": 0,
                    "artifact_revisions": [],
                })
                entry["event_groups"].append(events)
                entry["artifact_count"] += 1
                if isinstance(artifact_info, dict):
                    entry["artifact_revisions"].append(acquired_artifact_revision(artifact_info))
            except (OSError, ValueError, KeyError) as error:
                rejections.append({
                    "kind": "ai-execution-run-ingest-rejection",
                    "source_ref": source.get("source_ref"),
                    "artifact_ref": f"{source.get('source_ref') or 'source'}:{artifact_index}",
                    "error": str(error),
                    "at": now(),
                })
    for entry in grouped.values():
        try:
            writes.append(build_run(
                entry["source"],
                entry["artifact_path"],
                normalize_events(entry["event_groups"]),
                partition_label,
                entry["artifact_info"],
                entry["artifact_count"],
                entry["artifact_revisions"],
                acquisition_revision,
            ))
        except (ValueError, KeyError) as error:
            rejections.append({
                "kind": "ai-execution-run-ingest-rejection",
                "source_ref": entry["source"].get("source_ref"),
                "error": str(error),
                "at": now(),
            })
    result = {"writes": writes, "rejections": rejections, "artifact_count": artifact_count}
    if args.out:
        with open(args.out, "w", encoding="utf-8") as handle:
            json.dump(result, handle)
    else:
        json.dump(result, sys.stdout)
    return 0


if __name__ == "__main__":
    sys.exit(main())
