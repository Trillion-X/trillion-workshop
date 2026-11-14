#!/usr/bin/env python3
# packages/observed-content/do-work/process-scripts/decode-json-items.py
#
# Purpose: ONE generic decoder for any JSON corpus whose items live at a
# descriptor-named path (X bookmarks, X likes, YouTube json3 captions, a saved
# Reddit export, a CSV-turned-JSON, anything). The descriptor's `items` DATA
# block says where the array is and which fields carry text / author / time /
# reference. This file never names a source, a platform, or a field.
#
# Non-Negotiable Invariants:
# - Zero source vocabulary. Every key name comes from descriptor.items.
# - Uniform decoder contract (see fetch-source-items-dispatcher.py):
#     python3 decoder.py <request.json> <out.json>
#     request = {observation, descriptor} | {batch:{accepted:[observation,...]}, descriptor}
#     out     = {threads, atoms, rejections, next_cursor}
# - The co-mounted transcript_mapper owns atom identity / speaker_ref /
#   presentation. This file only builds thread_specs.
# - Unreadable or malformed input -> structured rejection, never a crash.
# - No network, no credentials, pure stdlib.
#
# descriptor.items DATA (all keys optional except `path`):
#   path        : list of keys from the document root to the item array
#   text        : key of the item's text (default "text")
#   text_join   : spec "<arrayKey>[].<subArrayKey>[].<textKey>" (any depth) joining nested segments into one text
#   chunk_chars : split one long item text into consecutive messages of at most N chars (each becomes an atom)
#   author      : key of the item's author/speaker label
#   time        : key of an ISO-8601 or RFC-2822 timestamp
#   time_ms     : key of an integer millisecond timestamp
#   ref         : key of the item's durable reference (url / id); falls back to index
#   thread      : "per-item" (default; one thread per item) | "per-file" (one thread, items are messages)
#   title       : key used as the thread title (default: ref or file name)
#
# request extras (all optional): cursor = integer item offset as text, limit = max items,
#   emit = "observation-batch" -> out.json is an observed-content batch {batch_ref, source_ref,
#   observations[{source_ref,native_ref,cursor,observed_at,content_multihash,payload}], next_cursor}
#   whose payload carries the atom text, so the ledger entry itself is summarizable.
import datetime
import email.utils
import json
import pathlib
import sys

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent))
import transcript_mapper as tm  # noqa: E402


def _walk(doc, path):
    cur = doc
    for key in path or []:
        if isinstance(cur, dict):
            cur = cur.get(key)
        elif isinstance(cur, list) and isinstance(key, int):
            cur = cur[key] if 0 <= key < len(cur) else None
        else:
            return None
    return cur


def _iso(value):
    if value is None:
        return None
    if isinstance(value, (int, float)):
        try:
            return datetime.datetime.fromtimestamp(value / 1000.0, datetime.timezone.utc).isoformat().replace("+00:00", "Z")
        except (OverflowError, OSError, ValueError):
            return None
    if not isinstance(value, str) or not value.strip():
        return None
    text = value.strip()
    try:
        return datetime.datetime.fromisoformat(text.replace("Z", "+00:00")).astimezone(datetime.timezone.utc).isoformat().replace("+00:00", "Z")
    except ValueError:
        pass
    try:
        parsed = email.utils.parsedate_to_datetime(text)
        return parsed.astimezone(datetime.timezone.utc).isoformat().replace("+00:00", "Z")
    except (TypeError, ValueError, IndexError):
        return None


def _joined_text(item, spec):
    # "events[].segs[].utf8" -> join every leaf string reached through the nested arrays
    if not isinstance(spec, str) or "[]." not in spec:
        return None
    keys = spec.split("[].")
    nodes = [item]
    for key in keys[:-1]:
        next_nodes = []
        for node in nodes:
            parts = node.get(key) if isinstance(node, dict) else None
            if isinstance(parts, list):
                next_nodes.extend(p for p in parts if isinstance(p, dict))
        nodes = next_nodes
    joined = "".join(str(n.get(keys[-1], "")) for n in nodes)
    return joined if joined.strip() else None


def _text_of(item, items_spec):
    if not isinstance(item, dict):
        return None
    if items_spec.get("text_join"):
        return _joined_text(item, items_spec["text_join"])
    value = item.get(items_spec.get("text", "text"))
    return value if isinstance(value, str) and value.strip() else None


def _time_of(item, items_spec):
    if items_spec.get("time_ms") and items_spec["time_ms"] in item:
        return _iso(item.get(items_spec["time_ms"]))
    if items_spec.get("time"):
        return _iso(item.get(items_spec["time"]))
    return None


def _rejection(source_ref, path, expected, got):
    return {"source_ref": source_ref, "violation_path": path, "expected": expected, "got": got}


def decode(observation, descriptor, request_extras=None):
    request_extras = request_extras or {}
    descriptor = descriptor or {}
    source_ref = observation["source_ref"]
    items_spec = descriptor.get("items") if isinstance(descriptor.get("items"), dict) else {}
    native_ref = observation.get("native_ref")
    try:
        doc = json.loads(pathlib.Path(native_ref).read_text(encoding="utf-8"))
    except (OSError, ValueError, TypeError) as error:
        return {"threads": [], "atoms": [], "next_cursor": None,
                "rejections": [_rejection(source_ref, "native_ref", "readable JSON document", str(error))]}
    items = _walk(doc, items_spec.get("path"))
    if not isinstance(items, list):
        return {"threads": [], "atoms": [], "next_cursor": None,
                "rejections": [_rejection(source_ref, "items.path", "array at descriptor items.path", type(items).__name__)]}

    offset = 0
    try:
        offset = max(0, int(str(request_extras.get("cursor") or "0")))
    except ValueError:
        offset = 0
    limit = request_extras.get("limit")
    total = len(items)
    window = items[offset:] if not isinstance(limit, int) or limit <= 0 else items[offset:offset + limit]
    next_cursor = str(offset + len(window)) if offset + len(window) < total else None
    items = window
    chunk_chars = items_spec.get("chunk_chars") if isinstance(items_spec.get("chunk_chars"), int) else None
    mode = items_spec.get("thread", "per-item")
    author_key = items_spec.get("author")
    ref_key = items_spec.get("ref")
    title_key = items_spec.get("title")
    file_label = pathlib.Path(native_ref).name

    def message_for(index, item):
        text = _text_of(item, items_spec)
        if text is None:
            return None
        speaker = None
        if author_key and isinstance(item.get(author_key), str) and item[author_key].strip():
            speaker = item[author_key].strip()
        ref = item.get(ref_key) if ref_key else None
        return {
            "index": index,
            "speaker": speaker or "them",
            "text": text,
            "at": _time_of(item, items_spec),
            "kind": "utterance",
            "native_ref": str(ref) if ref not in (None, "") else None,
        }

    thread_specs = []
    if mode == "per-file":
        messages = [m for m in (message_for(i, it) for i, it in enumerate(items) if isinstance(it, dict)) if m]
        if messages:
            thread_specs.append({
                "session_id": file_label,
                "title": (doc.get(title_key) if isinstance(doc, dict) and title_key else None) or file_label,
                "native_ref": native_ref,
                "messages": messages,
            })
    else:
        for index, item in enumerate(items):
            if not isinstance(item, dict):
                continue
            message = message_for(offset + index, item)
            if message is None:
                continue
            session_id = message["native_ref"] or f"{file_label}:{offset + index}"
            messages = [message]
            if chunk_chars and len(message["text"]) > chunk_chars:
                text = message["text"]
                messages = []
                for chunk_index, start in enumerate(range(0, len(text), chunk_chars)):
                    part = dict(message)
                    part["text"] = text[start:start + chunk_chars]
                    part["native_ref"] = f"{message['native_ref'] or session_id}#chunk-{chunk_index}"
                    messages.append(part)
            for position, part in enumerate(messages):
                part["index"] = position
            thread_specs.append({
                "session_id": session_id,
                "title": (item.get(title_key) if title_key else None) or session_id,
                "native_ref": message["native_ref"] or native_ref,
                "messages": messages,
            })

    result = tm.map_transcript(observation, descriptor, thread_specs)
    result["next_cursor"] = next_cursor
    return result


def observation_batch(source_observation, atoms, next_cursor):
    """Fold canonical atoms into an observed-content batch whose payload carries the text."""
    import hashlib
    source_ref = source_observation.get("source_ref")
    observed_at = source_observation.get("observed_at")
    authorization = source_observation.get("source_authorization") or {}
    provenance = source_observation.get("source_provenance") or {}
    observations = []
    for atom in atoms:
        content = atom.get("content") or {}
        text = content.get("text") or ""
        digest = "1f:" + hashlib.sha256(text.encode("utf-8")).hexdigest()
        native_ref = atom.get("native_ref") or atom.get("atom_ref")
        observations.append({
            "source_ref": source_ref,
            "native_ref": native_ref,
            "cursor": {"kind": "atom", "value": atom.get("atom_ref")},
            "observed_at": observed_at,
            "content_multihash": digest,
            "source_identity_ref": "source-identity:1f:" + hashlib.sha256(
                f"{source_ref}\0{native_ref}".encode("utf-8")
            ).hexdigest(),
            "source_revision_ref": digest,
            "source_authorization": authorization,
            "source_provenance": {**provenance, "source_ref": source_ref, "native_ref": native_ref},
            "payload": {
                "atom_ref": atom.get("atom_ref"), "thread_ref": atom.get("thread_ref"),
                "speaker_ref": atom.get("speaker_ref"), "at": atom.get("at"),
                "text": text, "native_ref": atom.get("native_ref"),
            },
        })
    batch_ref = "observation-batch:1f:" + hashlib.sha256(
        json.dumps([o["content_multihash"] for o in observations]).encode("utf-8")).hexdigest()
    for o in observations:
        o["batch_ref"] = batch_ref
        o["correlation_ref"] = batch_ref
    return {"batch_ref": batch_ref, "source_ref": source_ref, "observed_at": observed_at,
            "authorization_scope_ref": authorization.get("authorization_scope_ref"),
            "observations": observations,
            "next_cursor": {"kind": "item_offset", "value": next_cursor} if next_cursor is not None else None}


def atom_writes(atoms):
    """Canonical content-atom records, same shape materialize-decoded-content.py emits."""
    writes = []
    for atom in atoms:
        payload = dict(atom)
        payload["atom_kind"] = payload.pop("kind", "utterance")
        payload["kind"] = "observed-content.content-atom"
        writes.append({"address": atom["atom_ref"], "address_mode": "identity_text",
                       "path": ["current-item", "published-record"], "payload": payload})
    return writes


def main():
    request = json.loads(pathlib.Path(sys.argv[1]).read_text(encoding="utf-8"))
    out_path = sys.argv[2]
    descriptor = request.get("descriptor") or {}
    if "observation" in request:
        observations = [request["observation"]]
    else:
        batch = request.get("batch") or {}
        observations = batch.get("accepted") or batch.get("observations") or []
    extras = {"cursor": request.get("cursor"), "limit": request.get("limit")}
    threads, atoms, rejections = [], [], []
    next_cursor = None
    for obs in observations:
        if not isinstance(obs, dict):
            continue
        result = decode(obs, descriptor, extras)
        threads.extend(result["threads"])
        atoms.extend(result["atoms"])
        rejections.extend(result["rejections"])
        next_cursor = result.get("next_cursor") or next_cursor
    if request.get("emit") == "observation-batch":
        first = observations[0] if observations and isinstance(observations[0], dict) else {}
        out = observation_batch(first, atoms, next_cursor)
        out["atom_writes"] = atom_writes(atoms)
        out["thread_count"] = len(threads)
        out["rejections"] = rejections
    else:
        out = {"threads": threads, "atoms": atoms, "rejections": rejections, "next_cursor": next_cursor}
    pathlib.Path(out_path).write_text(json.dumps(out, separators=(",", ":")), encoding="utf-8")
    print(json.dumps({"threads": len(threads), "atoms": len(atoms), "rejections": len(rejections), "next_cursor": next_cursor}))


if __name__ == "__main__":
    main()
