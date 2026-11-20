#!/usr/bin/env python3
# packages/chat/do-work/process-scripts/materialize-conversations.py
#
# Purpose: Reader-keyed materialization for the chat conversation
# sidebar (Pattern 102/104). Given a self-contained set of observed-content
# source descriptors, it COMPOSES the descriptor-named acquisition + decode
# capabilities — local.files returns bounded bytes, the file-glob observer shapes
# those acquired bytes, and the JSONL decoder reads only its contained copy
# (parses content -> threads) — and projects the resulting threads into the
# canonical `chat-session-window` row shape the sidebar reads. It owns NO format
# knowledge and NO file-walking: those live in the composed leaf capabilities.
# This script is the ONLY chat-specific layer here (it speaks the
# sidebar's row vocabulary); everything upstream of it is blind and generic.
#
# Non-Negotiable Invariants:
# - Zero format branches: parsing is delegated to the decoder module named by
#   each descriptor; this driver never opens a transcript file (L090).
# - Self-describing input: the source set is descriptor DATA, not hardcoded
#   sources. Adding a CLI source = one descriptor record, zero edits here.
# - Output is EXACTLY the chat-session-window contract decoded by
#   read-chat-sessions.ts (decodeActiveChatSessionWindowPayload + Feed).
#
# CLI (compute.process):
#   materialize-conversations.py <source-set.json> <out-window.json> [per_source_limit]
#     source-set.json = {"sources": [<full source descriptor>, ...]}
#   Sibling modules glob_observe.py + decode_jsonl_session.py are mounted in the
#   same directory and imported by name (composition, not fusion).
import base64
import importlib
import importlib.util
import json
import os
import pathlib
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
# The BLAKE3 identity is the one owner's (tools/conversations/read-data/content_identity.py), loaded from there, never copied.
_OWNER = pathlib.Path(__file__).resolve().parents[5] / "conversations" / "read-data" / "content_identity.py"
_spec = importlib.util.spec_from_file_location("content_identity", _OWNER)
_content_identity = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(_content_identity)
multihash_hex = _content_identity.content_hash

DEFAULT_PER_SOURCE = 25


# Payload budget (both DATA-overridable via reduce argv; these are the L083
# maximally-safe defaults so the window is bounded even if the def passes
# nothing). The chat-session-window payload crosses the workflow-wasm boundary
# and is rebuilt there as a serde_json Value by the publish step's json_parse;
# an UNBOUNDED payload allocation-traps that wasm linear memory. Two orthogonal
# axes make the payload unbounded — the ROW COUNT (one row per conversation, so
# it grows with a user's history) and the PER-ROW BYTES (title/preview strings a
# distributable decoder could emit at any length). Bounding BOTH here, in the
# SSOT reduce, makes the emitted payload byte-bounded for ANY source/decoder
# (L063 category elimination): max payload ~= WINDOW_LIMIT * (a few capped
# fields). Neither is a channel axis — a new channel/account still adds zero code.
DEFAULT_WINDOW_LIMIT = 240
DEFAULT_FIELD_CHAR_LIMIT = 240
# Per-source representation floor: the minimum most-recent conversations every
# distinct source is GUARANTEED in the window, so one busy source can never bury a
# quiet one (the Discord-invisible defect). DATA-overridable via reduce argv; this
# L083-safe default (8) fully floors up to WINDOW_LIMIT/8 = 30 sources before the
# round-robin overflow branch engages, and never blows the byte budget (the window
# is still capped at WINDOW_LIMIT rows, each field-capped).
DEFAULT_SOURCE_FLOOR = 8
MAX_DECODER_CURSOR_ENTRIES = 64
MAX_DECODER_CURSOR_BYTES = 65536
MAX_DECODER_CURSOR_STRING = 4096

# The row string fields a decoder fills with free-form conversation text; each is
# capped so no single pathological row can blow the payload budget. Structural
# fields (ids, refs, counts, routing objects) are never capped — bounded already.
_CAPPED_ROW_FIELDS = ("title", "prompt", "lastMessagePreview")


def _valid_decoder_position(value):
    if isinstance(value, bool):
        return False
    if isinstance(value, int):
        return 0 <= value <= 9007199254740991
    return isinstance(value, str) and 0 < len(value) <= MAX_DECODER_CURSOR_STRING


def capability_module(capability_ref):
    """Resolve the capability a descriptor NAMES to its mounted module.

    Generic derivation (no enumeration, L090): `capability:observe-file-glob`
    -> module `observe_file_glob`; `capability:decode-session-export` -> module
    `decode_session_export`. The composing def mounts each capability script at this
    derived name. Used for BOTH the acquisition (observer) and decode
    capabilities so NEITHER is hardcoded — adding a new acquisition method (e.g.
    a sqlite or network observer) or a new store shape (a decoder) is a new leaf
    capability + the descriptor naming it, with zero edits to this driver.
    """
    name = str(capability_ref).split(":", 1)[-1].replace("-", "_")
    return importlib.import_module(name)


def session_id_of(thread: dict) -> str:
    # The decoder (the ONLY format-aware layer) emits the canonical session id.
    # The fallback derives it generically from the thread_ref's final segment —
    # NEVER by stripping file extensions, which would re-import the format
    # knowledge the decoder already owns (L098 translation boundary).
    sid = thread.get("session_id")
    if sid:
        return sid
    return str(thread.get("thread_ref", "")).rsplit(":", 1)[-1]


def thread_to_row(thread: dict, route_key: str, send_capability=None, source_descriptor=None) -> dict:
    pres = thread.get("presentation") or {}
    started = thread.get("started_at") or pres.get("at")
    last = thread.get("last_activity_at") or pres.get("at") or started
    row = {
        "recordId": thread.get("thread_ref"),
        "sessionId": session_id_of(thread),
        "executorRef": route_key,
        # Blind per-(channel,account) fairness id: the decoder's OWN source_ref,
        # carried verbatim (no channel literal, never parsed). reduce_rows groups
        # by this so every source gets a representation floor; a new channel or a
        # second account of one channel is simply a new group — zero code (L069).
        "sourceKey": thread.get("source_ref") or route_key,
        "title": pres.get("title"),
        "prompt": pres.get("subtitle"),
        "projectName": None,
        "projectSlug": "",
        "startedAt": started,
        "lastActivityAt": last,
        "messageCount": thread.get("atom_count") or 0,
        "filePath": thread.get("native_ref"),
        "sourcePresent": True,
        "lastMessagePreview": pres.get("subtitle"),
    }
    if thread.get("has_older") is True:
        row["hasOlder"] = True
        row["olderCursor"] = thread.get("older_cursor")
    if thread.get("source_revision"):
        row["sourceRevision"] = thread["source_revision"]
    if isinstance(thread.get("source_total_length"), int):
        row["sourceTotalLength"] = thread["source_total_length"]
    # Outbound reply affordance. Both fields are opaque data the source/decoder
    # declared, carried verbatim so the sidebar/composer stay blind:
    #  - sendCapability (per SOURCE): the source's send_capability_ref routing
    #    object {front_door_action, channel, destination_id}. Absent -> the
    #    thread is read-only (AI/agent + non-sendable sources unchanged).
    #  - sendRef (per THREAD): the single-recipient buddy handle the decoder
    #    resolved (e.g. iMessage phone/email). Absent (groups) -> read-only.
    # A thread is sendable ONLY when BOTH are present; the composer forwards them
    # to the egress front door without ever parsing either value.
    if isinstance(send_capability, dict) and send_capability:
        row["sendCapability"] = send_capability
    if thread.get("send_ref"):
        row["sendRef"] = thread["send_ref"]
    # Current source descriptors carry the decoder's identity/revision and opaque
    # provenance. Preserve it with the sidebar projection without interpreting a
    # vendor, format, path, or evidence body. This makes a row traceable to the
    # declared decoder that created it while leaving Chat blind to every shape.
    if isinstance(source_descriptor, dict):
        for descriptor_key, row_key in (
            ("decoder_capability_ref", "decoderCapabilityRef"),
            ("descriptor_ref", "decoderDescriptorRef"),
            ("revision", "decoderDescriptorRevision"),
        ):
            value = source_descriptor.get(descriptor_key)
            if value is not None:
                row[row_key] = value
        provenance = source_descriptor.get("provenance")
        if isinstance(provenance, dict):
            row["sourceProvenance"] = provenance
    return row


def _dedupe_rows(rows: list) -> list:
    """Collapse rows that describe the SAME conversation reaching the window from
    more than one place. The canonical join is the source-qualified pair
    `(sourceKey, sessionId)` — the SAME source + session seen twice collapses (e.g.
    a live view and its transcript of one conversation), while two DIFFERENT
    accounts of one channel that happen to share a native session id keep distinct
    keys and never collapse (multi-account safety — the blind sourceKey is IN the
    key). Rows lacking a session id fall back to `recordId` (globally
    source-qualified), then object identity, so id-less rows never merge. When two
    rows share identity, keep the richer one (more messages), then the more recently
    active — never invent a merged row, just pick the better-evidenced one."""
    best: dict = {}
    order: list = []
    for row in rows:
        sid = row.get("sessionId")
        if sid:
            key = (row.get("sourceKey") or "source:unknown", sid)
        else:
            key = row.get("recordId") or id(row)
        existing = best.get(key)
        if existing is None:
            best[key] = row
            order.append(key)
            continue
        better = (
            (row.get("messageCount") or 0, row.get("lastActivityAt") or "")
            > (existing.get("messageCount") or 0, existing.get("lastActivityAt") or "")
        )
        if better:
            best[key] = row
    return [best[key] for key in order]


def materialize_one_source(descriptor, per_source_limit: int, acquisition=None) -> list:
    """The rows view of `materialize_one_source_outcome`. Kept because two callers
    only ever wanted rows, and because a source that could not be decoded has
    always contributed nothing to a window either way."""
    return materialize_one_source_outcome(descriptor, per_source_limit, acquisition)["rows"]


def _acquired_observations_for_decode(
    observer, descriptor, acquisition, per_source_limit, require_acquisition=False
):
    """Turn local.files output into decoder-readable files inside this process workspace.

    The native local.files owner is the only code that touches the personal source
    path.  The contained decoder receives only bounded bytes already returned by
    that owner.  Original locators are retained for the row; generated workspace
    paths never escape as source identity.
    """
    location = descriptor.get("location") if isinstance(descriptor, dict) else None
    location_kind = location.get("kind") if isinstance(location, dict) else None
    is_file_acquisition = location_kind == "file-glob"
    is_record_acquisition = location_kind == "envelope-record"
    if not is_file_acquisition and not is_record_acquisition:
        return None, False, None
    if not isinstance(acquisition, dict):
        if require_acquisition:
            return {"observations": []}, True, None
        # Explicit legacy in-process callers retain their historical host-read
        # behavior. The installed contained action always sets require_acquisition,
        # so it can never silently fall back to opening a personal source path.
        return None, False, None
    if is_record_acquisition:
        data = location.get("data")
        record_address = data.get("address") if isinstance(data, dict) else None
        if not isinstance(record_address, str) or not record_address or acquisition.get("found") is False:
            return {"observations": []}, True, None
        if acquisition.get("found") is True:
            if "payload" not in acquisition:
                return {"observations": []}, True, None
            snapshot = acquisition.get("payload")
        else:
            # Workflow mounts the immutable bytes named by the record read's
            # output.content_hash, so acquisition.json is the record itself.
            snapshot = acquisition
        encoded = base64.b64encode(json.dumps(
            snapshot, separators=(",", ":"), ensure_ascii=False
        ).encode("utf-8")).decode("ascii")
        try:
            record_bytes = base64.b64decode(encoded, validate=True)
        except (ValueError, TypeError):
            return {"observations": []}, True, None
        record_state = multihash_hex(record_bytes)
        workspace_root = pathlib.Path(".chat-acquired") / "record"
        workspace_root.mkdir(parents=True, exist_ok=True)
        read_ref = workspace_root / "snapshot.json"
        read_ref.write_bytes(record_bytes)
        return {"observations": [{
            "source_ref": descriptor["source_ref"],
            "native_ref": str(read_ref),
            "source_native_ref": record_address,
            "source_state": record_state,
            "batch_ref": "observation-batch:" + record_state,
            "observed_at": None,
        }]}, False, None

    observe_acquired = getattr(observer, "observe_acquired", None)
    if not callable(observe_acquired):
        if require_acquisition:
            return {"observations": []}, True, None
        return None, False, None

    terminal_empty_omission = (
        acquisition.get("success") is True
        and acquisition.get("complete") is True
        and "files" not in acquisition
        and "file_states" not in acquisition
    )
    acquired_files = acquisition.get("files")
    if acquisition.get("success") is False:
        return {"observations": []}, True, None
    if not isinstance(acquired_files, list):
        # local.files omits an empty vector from a successful terminal reply.
        # Accept that exact native shape only; a partial or malformed reply stays
        # unavailable and retryable.
        if acquisition.get("success") is True and acquisition.get("complete") is True and "files" not in acquisition:
            acquired_files = []
        else:
            return {"observations": []}, True, None
    batch = observe_acquired(descriptor, acquisition, {})
    acquired_by_path = {
        item.get("path"): item
        for item in acquired_files
        if isinstance(item, dict) and isinstance(item.get("path"), str)
    }
    returned_states = acquisition.get("file_states")
    workspace_root = pathlib.Path(".chat-acquired")
    hydrated = []
    for index, observation in enumerate(batch.get("observations", [])[:per_source_limit]):
        if not isinstance(observation, dict):
            continue
        original_ref = observation.get("native_ref")
        acquired = acquired_by_path.get(original_ref)
        encoded = acquired.get("bytes_base64") if isinstance(acquired, dict) else None
        if not isinstance(encoded, str):
            continue
        try:
            raw = base64.b64decode(encoded, validate=True)
        except (ValueError, TypeError):
            continue
        range_region = acquired.get("range") if isinstance(acquired, dict) else None
        range_revision = acquired.get("revision_before") if isinstance(acquired, dict) else None
        if acquisition.get("operation") == "read_file_ranges":
            if (
                not isinstance(range_region, dict)
                or not isinstance(range_revision, str) or not range_revision
                or acquired.get("revision_after") != range_revision
                or range_region.get("length") != len(raw)
                or range_region.get("total_length") != acquired.get("byte_length")
            ):
                continue
        workspace_root.mkdir(exist_ok=True)
        item_root = workspace_root / str(index)
        item_root.mkdir(exist_ok=True)
        read_ref = item_root / (pathlib.Path(original_ref).name or "source")
        read_ref.write_bytes(raw)
        hydrated.append({
            **observation,
            "source_native_ref": original_ref,
            "source_state": (
                range_revision if acquisition.get("operation") == "read_file_ranges"
                else returned_states.get(original_ref) if isinstance(returned_states, dict) else None
            ),
            "native_ref": str(read_ref),
            **({"source_range": range_region} if isinstance(range_region, dict) else {}),
            **({"observed_at": None} if acquisition.get("operation") == "read_file_ranges" else {}),
        })
    supplied = [item for item in acquired_files if isinstance(item, dict)]
    # Count/byte/depth/entry bounds can stop a native scan before `limit` files
    # are returned (including zero when the newest file is over budget). Only the
    # acquisition owner can prove exhaustiveness; absence of that positive flag
    # must stay retryable.
    cursor_valid = isinstance(returned_states, dict) and all(
        isinstance(path, str) and path and isinstance(state, str)
        for path, state in returned_states.items()
    )
    prior_cursor = descriptor.get("acquisition_cursor")
    prior_states = prior_cursor.get("files") if isinstance(prior_cursor, dict) else {}
    if not (
        isinstance(prior_states, dict)
        and all(isinstance(path, str) and path and isinstance(state, str)
                for path, state in prior_states.items())
    ):
        prior_states = {}
    supplied_paths = {
        item.get("path") for item in supplied
        if isinstance(item.get("path"), str) and item.get("path")
    }
    # A referenced Local Files scan resolves the prior cursor inside the native
    # owner and returns one cumulative file_states map. The descriptor correctly
    # carries only that cursor's content hash, so the prior map is not present
    # inline here. Preserve the returned entries that were not candidates in this
    # batch: those are the exact previously accepted states the native owner read
    # from CAS. Current candidates remain excluded until their bytes hydrate below.
    safe_states = {
        path: state for path, state in returned_states.items()
        if cursor_valid and path not in supplied_paths
    } if cursor_valid else dict(prior_states)
    if cursor_valid:
        # Advance only past files whose bytes were actually hydrated. A corrupt
        # or missing inline body must remain eligible on retry; copying the
        # scanner's whole returned map would skip that unread file forever.
        for observation in hydrated:
            original_ref = observation.get("source_native_ref")
            state = returned_states.get(original_ref)
            if isinstance(original_ref, str) and isinstance(state, str):
                safe_states[original_ref] = state
    acquisition_complete = (
        acquisition.get("complete") is True or acquisition.get("window_complete") is True
    ) and (
        cursor_valid or terminal_empty_omission
    )
    return {
        **batch, "observations": hydrated
    }, len(hydrated) != len(supplied) or not acquisition_complete, safe_states if cursor_valid else None


def materialize_one_source_outcome(
    descriptor, per_source_limit: int, acquisition=None, require_acquisition=False,
    decoder_cursor=None,
) -> dict:
    """Decode ONE source descriptor and SAY WHAT HAPPENED. Fully blind: it imports
    the descriptor's OWN observer + decoder capabilities (L090, importlib) and knows
    no channel/account/path.

    Returns `{"source_ref": <ref or None>, "status": <status>, "rows": [...]}`.
    Status is `decoded` when the named capabilities ran, `capability-not-installed`
    when the descriptor names an observer or decoder this machine does not have,
    and `no-source-ref` when the descriptor cannot even be identified.

    WHY THIS EXISTS AT ALL: the answer used to be a bare list, and an empty list
    meant two opposite things. "I decoded this source and it has no conversations"
    and "I could not decode this source" were the SAME VALUE, so nothing
    downstream could tell a quiet source from a broken one. Whatever consumed it
    had to guess, and the guess that costs least to write is the wrong one: treat
    empty as success, mark the source done, and never look at it again. A
    conversation then disappears silently and permanently.

    Both callers of the old contract still get their list; the caller that has to
    decide whether a source was actually handled asks for the outcome instead."""
    if not isinstance(descriptor, dict) or "source_ref" not in descriptor:
        return {"source_ref": None, "status": "no-source-ref", "rows": []}
    source_ref = descriptor["source_ref"]
    # The descriptor declares its own display/route key in its existing
    # executor_route_ref field (machine-readable, not a parsed substring of
    # source_ref). Fallback: the whole source_ref — unique and correct, never
    # a guessed segment.
    route_key = descriptor.get("executor_route_ref") or source_ref
    # Per-source outbound routing object (present only on sendable sources
    # e.g. iMessage). Carried into every thread row verbatim; None otherwise.
    send_capability = descriptor.get("send_capability_ref")
    try:
        observer = capability_module(descriptor.get("observer_capability_ref", ""))
        decoder = capability_module(descriptor.get("decoder_capability_ref", ""))
    except ImportError:
        # A source naming a capability this machine does not have: skip, not
        # crash, and SAY SO, because this is the case that used to be
        # indistinguishable from a source with nothing in it.
        return {
            "source_ref": source_ref,
            "status": "capability-not-installed",
            "rows": [],
        }
    rows = []
    # SIDEBAR acquisition contract (L090, blind, capability probe — never a name
    # check): an observer whose full `observe()` is O(total bytes) (e.g. the
    # file-glob observer, which SHA-256-hashes every changed file to build the
    # durable content_multihash) may expose a BOUNDED `observe_window(descriptor,
    # limit)` that returns only the newest `limit` observation refs via stat, with
    # ZERO byte reads. The sidebar only ever shows the newest `per_source_limit`
    # threads and never reads content_multihash, so the hash is pure waste on this
    # path. Once such a store outgrows the 45s live tick, the whole-store hash
    # exceeds the tick and the single serial workflow slot never drains, starving
    # every source's interactive transcript read. We prefer `observe_window` when
    # present so materialize stays sub-second; observers exposing only `observe`
    # (imessage sqlite, snapshot stores — already cheap) are unaffected, same call.
    # The durable capture path (observe-file-glob-source def) still runs full
    # `observe()` with a cursor, so provenance/admission stay byte-exact.
    acquired_batch, acquisition_incomplete, source_cursor = _acquired_observations_for_decode(
        observer, descriptor, acquisition, per_source_limit, require_acquisition
    )
    observe_window = getattr(observer, "observe_window", None)
    if acquired_batch is not None:
        batch = acquired_batch
    elif callable(observe_window):
        batch = observe_window(descriptor, per_source_limit)
    else:
        batch = observer.observe(descriptor)
    recent = batch["observations"][:per_source_limit]  # newest-first from observer
    # SIDEBAR projection contract (L090, blind): the sidebar needs only per-thread
    # title + last-message preview + count + last-activity — NOT every message
    # body. A decoder whose full `decode()` is O(all-messages) (e.g. the iMessage
    # chat.db decoder, which materialises every message of every conversation) may
    # expose a BOUNDED `decode_summary(observation, descriptor)` that projects the
    # same {threads, atoms} contract in O(threads) — declaring whole-thread totals
    # as data while carrying only the newest tail. We prefer it when present so the
    # 45s live-tick materialize stays sub-second and can never monopolise the
    # serial workflow slot and starve interactive transcript reads. A decoder that
    # exposes only `decode` (every cheap JSON source) is unaffected — same call,
    # same result. The projection choice is a capability probe, never a name check.
    decode_summary = getattr(decoder, "decode_summary", None)
    decode_summary_page = getattr(decoder, "decode_summary_page", None)
    project = decode_summary if callable(decode_summary) else decoder.decode
    cursor_entries = {}
    decoder_reset_native_refs = []
    if decoder_cursor is not None:
        if (
            not isinstance(decoder_cursor, dict)
            or set(decoder_cursor) != {"version", "entries"}
            or isinstance(decoder_cursor.get("version"), bool)
            or decoder_cursor.get("version") != 1
        ):
            raise ValueError("decoder cursor is malformed")
        entries = decoder_cursor.get("entries")
        if not isinstance(entries, list) or len(entries) > MAX_DECODER_CURSOR_ENTRIES:
            raise ValueError("decoder cursor entries are malformed or unbounded")
        for entry in entries:
            if not isinstance(entry, dict) or set(entry) != {
                "source_native_ref", "source_state", "position"
            }:
                raise ValueError("decoder cursor entry is malformed")
            native_ref = entry.get("source_native_ref")
            source_state = entry.get("source_state")
            if (
                not isinstance(native_ref, str) or not native_ref
                or len(native_ref) > MAX_DECODER_CURSOR_STRING
                or not isinstance(source_state, str) or not source_state
                or len(source_state) > MAX_DECODER_CURSOR_STRING
                or not _valid_decoder_position(entry.get("position"))
            ):
                raise ValueError("decoder cursor identity is malformed")
            if native_ref in cursor_entries:
                raise ValueError("decoder cursor repeats a source file")
            cursor_entries[native_ref] = entry
    remaining_rows = per_source_limit
    for observation in recent:
        original_ref = observation.get("source_native_ref")
        source_state = observation.get("source_state")
        # Local Files can hydrate several changed files in one bounded scan, but
        # the leaf has one ROW budget across the whole source. Once earlier files
        # consume it, later bytes have not contributed a published row and cannot
        # be accepted into known_files. Removing their states makes the native
        # owner return those exact revisions on the next pass.
        if remaining_rows <= 0:
            if source_cursor is not None and isinstance(original_ref, str):
                source_cursor.pop(original_ref, None)
            acquisition_incomplete = True
            continue
        prior_entry = cursor_entries.get(original_ref)
        prior_position = (
            prior_entry.get("position")
            if isinstance(prior_entry, dict) and prior_entry.get("source_state") == source_state
            else None
        )
        # An acquired file is returned only while its exact revision is not in
        # Local Files' accepted state. Its first decoder page replaces any rows
        # carried from an older accepted revision; continuation pages for the
        # same revision retain earlier pages. This prevents deleted sessions in a
        # changed file from surviving forever while preserving cumulative pages.
        if (
            isinstance(original_ref, str)
            and isinstance(source_state, str)
            and not (
                isinstance(prior_entry, dict)
                and prior_entry.get("source_state") == source_state
            )
        ):
            decoder_reset_native_refs.append(original_ref)
        if callable(decode_summary_page) and isinstance(original_ref, str) and isinstance(source_state, str):
            result = decode_summary_page(observation, descriptor, prior_position, remaining_rows)
            if not isinstance(result, dict) or not isinstance(result.get("threads"), list):
                raise ValueError("decoder page result is malformed")
            rejections = result.get("rejections", [])
            if not isinstance(rejections, list) or rejections:
                raise ValueError("decoder page did not accept the acquired file")
            has_more = result.get("has_more")
            next_position = result.get("next_cursor")
            if (
                not isinstance(has_more, bool)
                or (has_more and not _valid_decoder_position(next_position))
                or (not has_more and next_position is not None)
            ):
                raise ValueError("decoder page cursor is inconsistent")
            if len(result["threads"]) > remaining_rows:
                raise ValueError("decoder page exceeds its row limit")
            if has_more:
                cursor_entries[original_ref] = {
                    "source_native_ref": original_ref,
                    "source_state": source_state,
                    "position": next_position,
                }
                if source_cursor is not None:
                    source_cursor.pop(original_ref, None)
                acquisition_incomplete = True
            else:
                cursor_entries.pop(original_ref, None)
        else:
            result = project(observation, descriptor)  # uniform decoder contract
            if isinstance(original_ref, str):
                rejections = result.get("rejections", [])
                if not isinstance(rejections, list) or rejections:
                    raise ValueError("decoder did not accept the acquired file")
            if (
                isinstance(original_ref, str)
                and len(result.get("threads", [])) > remaining_rows
            ):
                raise ValueError("decoder emitted more rows than the bound without a page capability")
        rows_before = len(rows)
        for thread in result.get("threads", []):
            # An empty thread (atom_count 0) is not a conversation — surface a
            # row only when the named decoder extracted real content.
            if (thread.get("atom_count") or 0) > 0:
                if observation.get("source_native_ref"):
                    thread = {**thread, "native_ref": observation["source_native_ref"]}
                rows.append(thread_to_row(thread, route_key, send_capability, descriptor))
        remaining_rows -= len(rows) - rows_before
    outcome = {
        "source_ref": source_ref,
        # A retained decoder cursor is positive proof that at least one exact
        # acquired revision has more rows. Even if the current native scan is
        # otherwise complete (or returns no files), the source cannot claim a
        # terminal decode while that cursor exists.
        "status": "partial" if acquisition_incomplete or cursor_entries else "decoded",
        "rows": rows,
    }
    # Preserve only the scanner owner's opaque, validated continuation map. The
    # reducer persists it per source and the next acquisition passes it back as
    # `known_files`, allowing a bounded partial scan to advance without Chat
    # learning provider paths or inventing a second index.
    if source_cursor is not None:
        outcome["source_cursor"] = {"files": source_cursor}
    if decoder_reset_native_refs:
        outcome["decoder_reset_native_refs"] = decoder_reset_native_refs
    if acquired_batch is not None and cursor_entries:
        if len(cursor_entries) > MAX_DECODER_CURSOR_ENTRIES:
            raise ValueError("decoder cursor exceeds its entry cap")
        decoder_cursor_out = {
            "version": 1,
            "entries": [cursor_entries[key] for key in sorted(cursor_entries)],
        }
        if len(json.dumps(decoder_cursor_out, separators=(",", ":")).encode("utf-8")) > MAX_DECODER_CURSOR_BYTES:
            raise ValueError("decoder cursor exceeds its byte cap")
        outcome["decoder_cursor"] = decoder_cursor_out
    return outcome


def _bounded(value, limit: int, default: int) -> int:
    """A positive integer bound, falling back to the L083-safe default when the
    caller passes nothing or a non-positive value. The value arrives as DATA (def
    argv); this only guarantees it can never DISABLE the budget."""
    try:
        n = int(value)
    except (TypeError, ValueError):
        return default
    return n if n > 0 else default


def _cap_row_fields(row: dict, field_char_limit: int) -> None:
    """Truncate the free-form conversation-text fields of ONE row to the byte
    budget, in place. Decoder-independent: whatever length a distributable
    decoder emitted, the row that reaches the payload is bounded. Marks
    `previewTruncated` so the reader could show an ellipsis without re-measuring."""
    for field in _CAPPED_ROW_FIELDS:
        val = row.get(field)
        if isinstance(val, str) and len(val) > field_char_limit:
            row[field] = val[:field_char_limit]
            row["previewTruncated"] = True


def _row_sort_key(row: dict):
    """Deterministic newest-first ordering key. Primary = activity time (missing
    time sorts oldest, ""), secondary = recordId — because the dissolved decode
    loop runs sources in PARALLEL and hands reduce rows in nondeterministic order,
    so ties must break on a stable id or the same inputs could reduce to different
    windows. Used for every sort AND for fairness candidate selection so the whole
    reduce is one total order."""
    return (
        str(row.get("lastActivityAt") or row.get("startedAt") or ""),
        str(row.get("recordId") or row.get("sessionId") or ""),
    )


def reduce_rows_with_overflow(row_lists, overrides=None, window_limit=None,
                              field_char_limit=None, source_floor=None):
    """Blind, format-agnostic reduce: concatenate every source's rows, dedupe, sort
    newest-first (deterministically), apply user title overrides, then BOUND the
    payload as a PER-SOURCE-FAIR window. Knows no channel — the SAME reduce whether
    the rows came from one in-process loop (materialize) or N separate per-source
    decode processes (the dissolved loop). Grouping/sort depend only on generic row
    fields (sourceKey, lastActivityAt, recordId), never a source format.

    Fairness floor (L063 category elimination): a pure recency top-N lets ONE busy
    source (a high-volume CLI / iMessage) consume the whole budget and bury every
    quiet source whose newest conversation falls below the cutoff — that is exactly
    why a Discord whose newest message predates the 240th row was structurally
    invisible in the sidebar. The reduce instead GUARANTEES each `sourceKey` group
    (the blind per-(channel,account) id = the decoder's own source_ref) its
    most-recent `source_floor` conversations, then fills the remaining budget by
    global recency. When there are so many sources that the floors would overflow
    the budget, it round-robins one-per-source by recency so EVERY non-empty source
    keeps at least one slot (a source is omitted only when pigeonhole forces it,
    i.e. non-empty sources > window_limit). Adding a channel or a second account is
    a new group — zero code, DATA-only (L069).

    Windowing is still the payload-budget seam (see module header): the emitted
    window is capped at `window_limit` conversations, each field-capped, so the
    bytes handed to the workflow-wasm publish step stay bounded no matter how much
    history, how many sources, or how large a single decoder's strings grow.
    `window_limit`, `field_char_limit`, and `source_floor` are DATA (def argv) with
    L083-safe module defaults."""
    limit = _bounded(window_limit, window_limit, DEFAULT_WINDOW_LIMIT)
    field_limit = _bounded(field_char_limit, field_char_limit, DEFAULT_FIELD_CHAR_LIMIT)
    floor = _bounded(source_floor, source_floor, DEFAULT_SOURCE_FLOOR)
    rows = []
    for one in row_lists:
        rows.extend(one or [])
    rows = _dedupe_rows(rows)
    rows.sort(key=_row_sort_key, reverse=True)      # global newest-first, deterministic
    overrides = overrides or {}
    for row in rows:
        override = overrides.get(row.get("sessionId")) or overrides.get(row.get("recordId"))
        if override:
            row["title"] = override
    total = len(rows)                               # true deduped conversation count

    # Group by the blind source id, each group already in global newest-first order.
    groups: dict = {}
    group_order: list = []                          # sources ordered by their newest row
    for row in rows:
        key = row.get("sourceKey") or row.get("executorRef") or "source:unknown"
        if key not in groups:
            groups[key] = []
            group_order.append(key)
        groups[key].append(row)

    selected: list = []
    seen: set = set()

    def _take(row) -> bool:
        rid = row.get("recordId") or id(row)
        if rid in seen:
            return False
        seen.add(rid)
        selected.append(row)
        return True

    if sum(min(floor, len(groups[k])) for k in group_order) <= limit:
        # Phase 1 — guarantee each source its most-recent `floor` rows.
        for key in group_order:
            for row in groups[key][:floor]:
                if len(selected) >= limit:
                    break
                _take(row)
        # Phase 2 — fill the remaining budget by pure global recency.
        for row in rows:
            if len(selected) >= limit:
                break
            _take(row)
    else:
        # Overflow — more sources than the budget can floor: round-robin the
        # single most-recent still-unseen row across sources until the window is
        # full, so no source is starved while any slot remains.
        cursors = {k: 0 for k in group_order}
        while len(selected) < limit:
            best_key = None
            best_sort = None
            for key in group_order:
                grp = groups[key]
                idx = cursors[key]
                while idx < len(grp) and (grp[idx].get("recordId") or id(grp[idx])) in seen:
                    idx += 1
                cursors[key] = idx
                if idx >= len(grp):
                    continue
                cand_sort = _row_sort_key(grp[idx])
                if best_key is None or cand_sort > best_sort:
                    best_key = key
                    best_sort = cand_sort
            if best_key is None:
                break                               # every source exhausted
            _take(groups[best_key][cursors[best_key]])
            cursors[best_key] += 1

    windowed = sorted(selected[:limit], key=_row_sort_key, reverse=True)
    selected_ids = {
        row.get("recordId") or row.get("sessionId")
        for row in windowed
    }
    overflow = [
        row for row in rows
        if (row.get("recordId") or row.get("sessionId")) not in selected_ids
    ]
    for row in windowed:
        _cap_row_fields(row, field_limit)
    for row in overflow:
        _cap_row_fields(row, field_limit)
    window = {
        "version": 1,
        "window_key": "latest",
        "limit": limit,                    # the APPLIED bound (not len(rows))
        "total_count": total,              # honest total behind the window
        "total_count_known": True,
        "rows": windowed,
        # With fairness this means "conversations exist beyond the window" (some
        # omitted rows may be NEWER than a guaranteed old source row) rather than a
        # strict older-than-window paging cursor — still the honest overflow signal.
        "has_older": total > len(windowed),
    }
    return window, overflow


def reduce_rows(row_lists, overrides=None, window_limit=None, field_char_limit=None,
                source_floor=None) -> dict:
    """Backward-compatible window-only view of the retained overflow partition."""
    window, _overflow = reduce_rows_with_overflow(
        row_lists, overrides, window_limit, field_char_limit, source_floor
    )
    return window


def materialize(sources: list, per_source_limit: int, overrides=None,
                window_limit=None, field_char_limit=None, source_floor=None) -> dict:
    """Backward-compatible single-process path: decode every source in-process and
    reduce. The dissolved def path calls materialize_one_source (per loop iteration)
    and reduce_rows (final step) directly, to the identical result."""
    return reduce_rows(
        [materialize_one_source(d, per_source_limit) for d in sources],
        overrides, window_limit, field_char_limit, source_floor,
    )


def _normalize_sources(raw):
    """Expand the input into full, self-describing source descriptors.

    The conversation-source-set fed here can arrive in several shapes: the live
    `read`-step output (current-read reply `{found, payload:[attribute_fact rows]}`
    holding COMPACT cli-registry specs), an already-expanded `{sources:[...]}`, or
    a bare descriptor list. The sibling `build-conversation-descriptors.py` is the
    ONE place that knows how to turn any of those into the uniform descriptor the
    materialize loop consumes (source_ref + observer/decoder + location). It is
    mounted alongside this driver; we load it by path because its file name has
    hyphens. When it is not mounted, fall back to whatever list we were handed
    (already-full descriptors still materialize; compact specs simply yield none).
    """
    expander_path = pathlib.Path(__file__).parent / "build-conversation-descriptors.py"
    if expander_path.exists():
        import importlib.util as _ilu
        spec = _ilu.spec_from_file_location("conversation_descriptors", expander_path)
        module = _ilu.module_from_spec(spec)
        spec.loader.exec_module(module)
        # iter_source_specs prepends the always-present built-in sources (e.g.
        # live-chat, #56) ahead of the upstream fold specs; fall back to the pure
        # unwrap for an expander that predates it.
        iter_specs = getattr(module, "iter_source_specs", module.unwrap)
        return [d for s in iter_specs(raw) if (d := module.to_descriptor(s)) is not None]
    if isinstance(raw, dict):
        raw = raw.get("sources")
    return raw if isinstance(raw, list) else []


def _load_title_overrides(path_text):
    """A user rename writes `prop:chat_session:title` on the chat_session owner
    (subject_id = the conversation's sessionId). Those rows arrive as a
    find-current-items result; map subject_id -> title so a renamed conversation
    keeps its user title regardless of which source decoded it. Absent file / shape
    -> no overrides (the decoded title stands)."""
    if not path_text:
        return {}
    try:
        raw = json.loads(pathlib.Path(path_text).read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return {}
    items = raw.get("items") if isinstance(raw, dict) else raw
    overrides = {}
    for item in items if isinstance(items, list) else []:
        if not isinstance(item, dict):
            continue
        subject = item.get("subject_id")
        value = item.get("value_json")
        if isinstance(value, str):
            try:
                value = json.loads(value)
            except ValueError:
                pass
        if isinstance(subject, str) and isinstance(value, str) and value:
            overrides[subject] = value
    return overrides


def main():
    if len(sys.argv) < 3:
        raise SystemExit("usage: materialize-conversations.py <source-set.json> <out-window.json> [per_source_limit] [title-overrides.json]")
    source_set = json.loads(pathlib.Path(sys.argv[1]).read_text(encoding="utf-8"))
    sources = _normalize_sources(source_set)
    per_source_limit = int(sys.argv[3]) if len(sys.argv) > 3 and sys.argv[3] else DEFAULT_PER_SOURCE
    overrides = _load_title_overrides(sys.argv[4] if len(sys.argv) > 4 else None)
    # Override application now lives inside reduce_rows (the SSOT reduce the
    # dissolved loop's final step also calls), so this single-job path and the
    # fan-out path apply titles identically.
    window = materialize(sources, per_source_limit, overrides)
    pathlib.Path(sys.argv[2]).write_text(json.dumps(window, separators=(",", ":")), encoding="utf-8")
    print(f"sources={len(sources)} rows={window['total_count']} overrides={len(overrides)}")


if __name__ == "__main__":
    main()
