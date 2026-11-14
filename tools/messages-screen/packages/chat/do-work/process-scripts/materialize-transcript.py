#!/usr/bin/env python3
# packages/chat/do-work/process-scripts/materialize-transcript.py
#
# Purpose: Reader-keyed materialization for the chat TRANSCRIPT view
# (the messages shown when a conversation is opened). Given ONE thread's source
# descriptor + native reference, it composes the descriptor-named decoder over
# that single file, selects the requested thread's atoms, maps each
# self-describing atom (kind: utterance | tool-call | tool-result | thought) into
# the canonical `TranscriptLine` shape the chat surface decodes, and paginates
# into an `ActiveChatMessageWindowPayload`. This REPLACES the fused
# retired fused scanner for transcript reading — same decoders as the sidebar,
# zero format knowledge here beyond the surface's line vocabulary.
#
# Non-Negotiable Invariants:
# - Zero format branches: decoding is delegated to the decoder module the
#   descriptor NAMES (L090); this script never opens a transcript file itself.
# - Output is EXACTLY the ActiveChatMessageWindowPayload contract read by
#   read-session-transcripts.ts (decodeActiveChatMessageWindowPayload).
# - kind -> TranscriptLine.type is the ONLY mapping here; tool pairing + role
#   resolution stay in the surface's transcriptLinesToAgentMessages.
#
# CLI (compute.process):
#   materialize-transcript.py <request.json> <out-window.json>
#     request.json = {descriptor, observation:{source_ref,native_ref,batch_ref},
#                     thread_ref, start_index?, limit?, window_key?}
#   Decoder modules are mounted in the same directory and imported by name.
import importlib
import base64
import json
import os
import pathlib
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

DEFAULT_LIMIT = 256
MAX_ACQUIRED_BYTES = 1024 * 1024


def _mount_acquired_file(acquisition, original_path):
    """Materialize one Local Files reply inside this contained job.

    The selected decoder receives only this job-owned copy. The original path is
    retained as provenance in the published page, but is never opened here.
    """
    if not isinstance(acquisition, dict) or acquisition.get("success") is not True:
        return None
    files = acquisition.get("files")
    if not isinstance(files, list):
        return None
    selected = [item for item in files if isinstance(item, dict) and item.get("path") == original_path]
    if len(selected) != 1:
        return None
    encoded = selected[0].get("bytes_base64")
    if not isinstance(encoded, str):
        return None
    max_encoded_length = ((MAX_ACQUIRED_BYTES + 2) // 3) * 4
    if len(encoded) > max_encoded_length:
        return None
    try:
        raw = base64.b64decode(encoded, validate=True)
    except (ValueError, TypeError):
        return None
    if len(raw) > MAX_ACQUIRED_BYTES:
        return None
    item = selected[0]
    region = item.get("range")
    revision = item.get("revision_before")
    if region is None and revision is None:
        declared_length = item.get("byte_length")
        if type(declared_length) is not int or declared_length != len(raw):
            return None
        region = {"offset": 0, "length": len(raw), "total_length": len(raw)}
        revision = item.get("file_state") or f"legacy:{len(raw)}"
    elif (
        not isinstance(region, dict)
        or not isinstance(revision, str) or not revision
        or item.get("revision_after") != revision
        or region.get("length") != len(raw)
        or region.get("total_length") != item.get("byte_length")
    ):
        return None
    name = pathlib.Path(original_path).name
    if not name or name in (".", ".."):
        return None
    acquired_dir = pathlib.Path(".chat-selected-source")
    acquired_dir.mkdir(mode=0o700, exist_ok=True)
    mounted = acquired_dir / name
    mounted.write_bytes(raw)
    return {
        "native_ref": str(mounted),
        "source_range": region,
        "source_state": revision,
    }


def capability_module(capability_ref):
    """Resolve the decoder a descriptor NAMES to its mounted module (L090)."""
    name = str(capability_ref).split(":", 1)[-1].replace("-", "_")
    return importlib.import_module(name)


def role_of(atom):
    # speaker_ref = speaker:<source_ref...>:<role>; role is the final segment.
    return str(atom.get("speaker_ref", "")).rsplit(":", 1)[-1]


def apply_overlays(native_atoms, overlays, target_threads):
    """Weave optimistic OVERLAY atoms into a decoded native page and converge.

    An overlay is any DATA-named decoder that emits provenance-ranked atoms for
    the SAME conversation identity (e.g. this package's own outbound egress
    ledger: a message the user just SENT, before the source-of-record echo).
    This seam is source-agnostic (L090): it names NO overlay by string, it runs
    whatever decoders the def mounts, keeps only atoms projected onto the OPEN
    thread(s), and defers ALL dedup to the transcript-mapper's pure
    `converge_atoms`. Convergence collapses each optimistic atom into its
    matching AUTHORITATIVE native echo (never the reverse, never two distinct
    sends), so a just-sent message shows once whether or not its echo has landed.

    Fail-safe: if the mapper or a decoder is unavailable, we return the native
    page UNCHANGED — a missing optimistic row (the echo still supplies it) is
    always safer than crashing the transcript or hiding a real message.
    """
    if not overlays:
        return native_atoms, 0
    try:
        import transcript_mapper as tm  # co-mounted SSOT for convergence
    except ImportError:
        return native_atoms, 0
    overlay_atoms = []
    for overlay in overlays:
        if not isinstance(overlay, dict):
            continue
        descriptor = overlay.get("descriptor") or {}
        cap = descriptor.get("decoder_capability_ref")
        if not cap:
            continue
        try:
            module = capability_module(cap)
        except ImportError:
            continue
        decode = getattr(module, "decode", None)
        if decode is None:
            continue
        try:
            result = decode(overlay.get("observation") or {}, descriptor)
        except Exception:
            continue  # a bad overlay must never break the native transcript
        for atom in result.get("atoms", []):
            if atom.get("thread_ref") in target_threads:
                overlay_atoms.append(atom)
    if not overlay_atoms:
        return native_atoms, 0
    # native FIRST so convergence keeps native page order and appends only the
    # still-un-echoed optimistic survivors at the tail (the newest messages).
    merged = tm.converge_atoms(list(native_atoms) + overlay_atoms)
    added = len(merged) - len(native_atoms)
    return merged, max(0, added)


def resolve_base_dir(descriptor):
    """The directory a descriptor's location resolves to ({home} -> ~)."""
    data = ((descriptor or {}).get("location") or {}).get("data") or {}
    base = data.get("base")
    if not isinstance(base, list):
        return None
    home = os.path.expanduser("~")
    parts = [home if p == "{home}" else str(p) for p in base]
    try:
        return os.path.join(*parts) if parts else None
    except TypeError:
        return None


def descriptor_for_file(file_path, sources):
    """Find the source descriptor that OWNS a native file, by location prefix.

    Generic: a file belongs to the source whose resolved base directory is a
    prefix of it (longest match wins). No source-name knowledge — the descriptor
    that globs this directory is the one whose decoder can read the file (L090).
    """
    best, best_len = None, -1
    norm = os.path.normpath(str(file_path))
    for source in sources or []:
        base = resolve_base_dir(source)
        if not base:
            continue
        base = os.path.normpath(base)
        if (norm == base or norm.startswith(base + os.sep)) and len(base) > best_len:
            best, best_len = source, len(base)
    return best


def atom_to_line(atom):
    """Map ONE self-describing atom to the surface's TranscriptLine shape."""
    kind = atom.get("kind")
    at = atom.get("at")
    text = (atom.get("content") or {}).get("text", "")
    tool = atom.get("tool") or {}
    if kind == "tool-call":
        return {
            "type": "tool_use", "timestamp": at, "role": "assistant",
            "content": text, "toolName": tool.get("name"),
            "toolInput": tool.get("input") if isinstance(tool.get("input"), dict) else None,
            "toolUseId": tool.get("call_ref"),
        }
    if kind == "tool-result":
        return {"type": "tool_result", "timestamp": at, "role": "assistant",
                "content": text, "toolUseId": tool.get("call_ref")}
    if kind == "thought":
        return {"type": "thinking", "timestamp": at, "role": "assistant", "content": text}
    if kind == "status":
        return {"type": "status", "timestamp": at, "role": "assistant", "content": text}
    if kind == "error":
        return {"type": "error", "timestamp": at, "role": "assistant", "content": text}
    # utterance: the local user (user/me) is human; everyone else renders as the
    # other side. The surface owns final role rendering; this is the line type.
    is_user = role_of(atom) in ("user", "me")
    line = {"type": "user" if is_user else "assistant",
            "role": "human" if is_user else "assistant",
            "timestamp": at, "content": text}
    _attach_envelope(line, atom)
    return line


def _attach_envelope(line, atom):
    """Carry the message-state envelope onto a line: durable identity
    (atomRef/nativeRef) + the self-describing lifecycle stream (stateEvents).
    The surface renders status/reactions FROM these — it never re-derives them.
    Absent fields are simply not attached (fail-open: a line with no envelope
    renders exactly as before)."""
    atom_ref = atom.get("atom_ref")
    if atom_ref is not None:
        line["atomRef"] = atom_ref
    native_ref = atom.get("native_ref")
    if native_ref is not None:
        line["nativeRef"] = native_ref
    state_events = atom.get("state_events")
    if state_events:
        line["stateEvents"] = state_events
    return line


def _reaction_event(atom):
    """A reaction atom -> (target_atom_ref, reaction) or None. The reaction's
    SYMBOL is an opaque key the decoder emitted (love/like/emphasis/...); the
    host maps key->glyph from DATA (no closed enum here). A reaction with no
    resolved target is dropped (it cannot attach to anything)."""
    if atom.get("kind") != "reaction":
        return None
    target = None
    for rel in (atom.get("relations") or []):
        if rel.get("role") == "reaction_target" and rel.get("target_atom_ref"):
            target = rel["target_atom_ref"]
            break
    if not target:
        return None
    content = atom.get("content") or {}
    return target, {
        "atomRef": atom.get("atom_ref"),
        "symbol": content.get("symbol"),
        "reactionKind": content.get("reaction_kind"),
        "speaker": role_of(atom),
        "at": atom.get("at"),
    }


def _fold_reactions(events):
    """Reduce a message's raw reaction EVENTS to its CURRENT reaction set. Keyed
    by (speaker, symbol): the latest event by time wins, so an 'added' followed
    by a later 'removed' from the same actor cancels out (tapback un-react)."""
    latest = {}
    for ev in sorted(events, key=lambda e: e.get("at") or ""):
        latest[(ev.get("speaker"), ev.get("symbol"))] = ev
    return [ev for ev in latest.values() if ev.get("reactionKind") != "removed"]


def build_lines(atoms):
    """Atoms -> TranscriptLines, folding reaction atoms onto their target line.

    A reaction is associative state ON a message, not a standalone line, so it
    is woven into the target line's `reactions[]` (reduced to the current set).
    A reaction whose target atom is not on THIS page is dropped from the view —
    the target's own page owns it, so it reappears when that page loads (never
    lost, never orphaned)."""
    lines = []
    by_atom_ref = {}
    for atom in atoms:
        if atom.get("kind") == "reaction":
            continue
        line = atom_to_line(atom)
        ref = atom.get("atom_ref")
        if ref is not None:
            by_atom_ref[ref] = line
        lines.append(line)
    buckets = {}
    for atom in atoms:
        event = _reaction_event(atom)
        if event is None:
            continue
        target_ref, reaction = event
        if target_ref in by_atom_ref:
            buckets.setdefault(target_ref, []).append(reaction)
    for target_ref, events in buckets.items():
        current = _fold_reactions(events)
        if current:
            by_atom_ref[target_ref]["reactions"] = current
    return lines


def materialize(request):
    # The UI (read-chat-transcript-page.ts) sends {session_id, file_path,
    # before_byte_offset, limit}; the def mounts the source descriptors so this
    # resolves which decoder owns the file. Pagination is BOUNDED: the decoder's
    # decode_window reads only one page (reverse byte-tail for huge JSONL
    # rollouts, SQL/slice for bounded sources) — never the whole file. The cursor
    # (before_cursor / older_cursor) is OPAQUE here; each decoder defines it
    # (byte offset, row index, ...). A direct {descriptor, observation} request is
    # also honored (e.g. tests).
    limit = int(request.get("limit") or DEFAULT_LIMIT)
    before_cursor = _parse_cursor(request.get("before_cursor"))
    window_key = request.get("window_key") or "latest"
    session_id = request.get("session_id")

    descriptor = request.get("descriptor")
    observation = request.get("observation")
    file_path = request.get("file_path") or (observation or {}).get("native_ref")
    if descriptor is None:
        descriptor = descriptor_for_file(file_path, request.get("sources")) or {}
    source_ref = descriptor.get("source_ref") or (observation or {}).get("source_ref") or ""
    if observation is None:
        observation = {"source_ref": source_ref, "native_ref": file_path, "batch_ref": None}

    empty = {
        "version": 1, "session_id": session_id, "window_key": window_key,
        "start_index": None, "requested_start_index": request.get("start_index"), "limit": limit,
        "total_count": None, "total_count_known": False, "lines": [],
        "has_older": False, "has_newer": False, "older_cursor": None,
        "file_path": file_path, "project_path": None, "started_at": None, "last_activity_at": None,
    }
    if not file_path or not descriptor.get("decoder_capability_ref"):
        return empty
    acquisition = request.get("acquisition")
    if acquisition is not None:
        mounted = _mount_acquired_file(acquisition, file_path)
        if mounted is None:
            raise SystemExit("This conversation could not be read safely. Try again.")
        observation = {**observation, **mounted}
        if isinstance(before_cursor, dict) and (
            before_cursor.get("path") != file_path
            or before_cursor.get("revision") != mounted.get("source_state")
            or before_cursor.get("total_length") != mounted.get("source_range", {}).get("total_length")
        ):
            raise SystemExit("This conversation changed while earlier messages were loading. Try again.")
    else:
        # The installed workflow must acquire selected personal-source bytes via
        # Local Files before this contained decoder runs. Direct descriptor tests
        # may still use files they created inside their own job workspace.
        if request.get("sources") is not None:
            try:
                job_root = pathlib.Path.cwd().resolve()
                candidate = pathlib.Path(file_path).resolve(strict=True)
                candidate.relative_to(job_root)
            except (OSError, ValueError):
                raise SystemExit("This conversation could not be read safely. Try again.")
    try:
        decoder = capability_module(descriptor["decoder_capability_ref"])
    except ImportError:
        if acquisition is not None:
            raise SystemExit("The reader for this conversation is unavailable. Try again.")
        return empty

    decoder_cursor = before_cursor.get("before_offset") if isinstance(before_cursor, dict) else before_cursor
    win = decoder.decode_window(observation, descriptor,
                                before_cursor=decoder_cursor, limit=limit, session_id=session_id)
    native_atoms = win.get("atoms", [])
    # Weave optimistic outbound (just-sent) atoms into THIS thread and converge
    # with the native echo. Overlays are DATA the def mounts; only the newest
    # (latest) page carries pending sends, so older pages skip the seam.
    target_threads = {a.get("thread_ref") for a in native_atoms if a.get("thread_ref")}
    if not target_threads and source_ref and session_id:
        target_threads = {f"thread:{source_ref}:{session_id}"}
    overlays = request.get("overlays") if before_cursor is None else None
    atoms, added = apply_overlays(native_atoms, overlays, target_threads)
    lines = build_lines(atoms)
    total = win.get("total_count")
    if total is not None:
        total += added
    older_cursor = win.get("older_cursor")
    source_revision = win.get("source_revision")
    source_range = observation.get("source_range") if isinstance(observation, dict) else None
    if (
        bool(win.get("has_older"))
        and isinstance(older_cursor, int)
        and isinstance(source_revision, str) and source_revision
        and isinstance(source_range, dict)
    ):
        older_cursor = {
            "version": 1,
            "path": file_path,
            "revision": source_revision,
            "total_length": source_range.get("total_length"),
            "before_offset": older_cursor,
        }
    return {
        "version": 1,
        "session_id": win.get("session_id") or session_id,
        "window_key": window_key,
        # start_index stays null -> the surface paginates by older_cursor (opaque
        # decoder cursor), exactly as the prior byte-offset scanner did.
        "start_index": None,
        "requested_start_index": request.get("start_index"),
        "limit": limit,
        "total_count": total,
        "total_count_known": total is not None,
        "lines": lines,
        "has_older": bool(win.get("has_older")),
        "has_newer": bool(win.get("has_newer")),
        "older_cursor": older_cursor,
        "file_path": file_path,
        "project_path": None,
        "started_at": win.get("started_at"),
        "last_activity_at": win.get("last_activity_at"),
    }


def _parse_cursor(value):
    """Opaque pagination cursor -> int or None. The UI sends a JSON-stringified
    number or 'null'; decoders define what the integer means."""
    if value is None:
        return None
    if isinstance(value, dict):
        if (
            set(value) == {"version", "path", "revision", "total_length", "before_offset"}
            and value.get("version") == 1
            and isinstance(value.get("path"), str) and value.get("path")
            and isinstance(value.get("revision"), str) and value.get("revision")
            and type(value.get("total_length")) is int and value.get("total_length") >= 0
            and type(value.get("before_offset")) is int
            and 0 <= value.get("before_offset") <= value.get("total_length")
        ):
            return value
        raise ValueError("transcript range cursor is malformed")
    if isinstance(value, str):
        if value in ("", "null", "None"):
            return None
        try:
            parsed = json.loads(value)
            return _parse_cursor(parsed) if isinstance(parsed, dict) else int(parsed)
        except (ValueError, TypeError):
            try:
                return int(value)
            except (ValueError, TypeError):
                return None
    try:
        return int(value)
    except (ValueError, TypeError):
        return None


def _normalize_sources(raw):
    """Expand the input into full source descriptors the matcher consumes.

    `transcript-sources` arrives as the live read reply (compact cli-registry
    specs in `{found, payload:[attribute_fact rows]}`), not the descriptor shape
    `descriptor_for_file` needs (location.data.base + decoder_capability_ref).
    The sibling `build-conversation-descriptors.py` is the ONE place that turns
    any of those shapes into the uniform descriptor (same transform the
    conversation-list materialize uses); it is mounted alongside this driver and
    loaded by path (its file name has hyphens). When absent, fall back to the
    list as-is (already-full descriptors still match; compact specs yield none).
    """
    expander_path = pathlib.Path(__file__).parent / "build-conversation-descriptors.py"
    if expander_path.exists():
        import importlib.util as _ilu
        spec = _ilu.spec_from_file_location("conversation_descriptors", expander_path)
        module = _ilu.module_from_spec(spec)
        spec.loader.exec_module(module)
        iter_specs = getattr(module, "iter_source_specs", module.unwrap)
        return [d for s in iter_specs(raw) if (d := module.to_descriptor(s)) is not None]
    if isinstance(raw, dict):
        raw = raw.get("sources")
    return raw if isinstance(raw, list) else []


def _normalize_overlays(raw):
    """Coerce the mounted overlays bundle into the uniform `[{descriptor, observation}]`
    the overlay weave (`apply_overlays`) consumes.

    An overlay entry pairs a source DESCRIPTOR (Society data: which decoder + where)
    with an OBSERVATION (the rows that decoder should turn into optimistic atoms).
    The observation frequently arrives as a raw live-read reply
    (`{found, payload:[rows]}`) because the def binds the egress-ledger read output
    straight in; we surface those rows under `observation.records` (the uniform key
    every decoder reads) WITHOUT naming any decoder here — the descriptor's
    `decoder_capability_ref` selects it (L090 / enum-dissolution). A missing
    descriptor drops the entry (fail-closed: no descriptor => nothing to run).
    """
    if isinstance(raw, dict):
        raw = raw.get("overlays") if isinstance(raw.get("overlays"), list) else [raw]
    if not isinstance(raw, list):
        return []
    normalized = []
    for entry in raw:
        if not isinstance(entry, dict):
            continue
        descriptor = entry.get("descriptor")
        if not descriptor:
            continue
        observation = dict(entry.get("observation") or {})
        if not isinstance(observation.get("records"), list):
            payload = observation.get("payload")
            if isinstance(payload, list):
                observation["records"] = payload
        normalized.append({"descriptor": descriptor, "observation": observation})
    return normalized


def _load_overlay_bundle(overlay_path):
    """Load the mounted overlay bundle, resolving any `feed_mount` reference.

    An overlay entry is Society DATA the def author wrote: it names a decoder
    capability (`decoder_capability_ref`) and, optionally, the mount path of a
    SEPARATELY-mounted feed file (`feed_mount`) whose rows are that decoder's
    observation. Splitting the fixed descriptor (literal DATA) from the live rows
    (a bound read the def mounts by address) is what lets the workflow grammar
    express the pair: an inline mount's bytes are a SINGLE binding and cannot embed
    a fixed descriptor around a bound value, but a literal descriptor CAN name a
    sibling mount that the binding fills. This keeps the pairing generic (L069): any
    number of overlay sources = N literal descriptor entries + N bound feed mounts,
    ZERO code per added source. Entries already carrying an inline `observation`
    (tests / a pre-joined bundle) pass straight through unchanged."""
    raw = json.loads(overlay_path.read_text(encoding="utf-8"))
    if isinstance(raw, dict) and isinstance(raw.get("overlays"), list):
        entries = raw["overlays"]
    elif isinstance(raw, dict):
        entries = [raw]
    elif isinstance(raw, list):
        entries = raw
    else:
        return []
    resolved = []
    for entry in entries:
        if not isinstance(entry, dict):
            continue
        descriptor = entry.get("descriptor")
        if descriptor is None and entry.get("decoder_capability_ref"):
            descriptor = {"decoder_capability_ref": entry["decoder_capability_ref"]}
        feed_mount = entry.get("feed_mount")
        if feed_mount:
            observation = dict(entry.get("observation") or {})
            # `feed_mount` names a SIBLING file the def mounts next to overlays.json,
            # so resolve it against the overlay file's directory (cwd is not the job
            # dir at runtime); an absolute path is honored verbatim.
            feed_file = pathlib.Path(feed_mount)
            if not feed_file.is_absolute():
                feed_file = overlay_path.parent / feed_mount
            if feed_file.exists():
                feed = json.loads(feed_file.read_text(encoding="utf-8"))
                # a live-read reply arrives as {found,payload:[rows]}; a projected
                # input-descriptor read arrives as a bare [rows]. Surface either as
                # observation.payload — the decoder owns the row->record translation.
                if isinstance(feed, dict) and isinstance(feed.get("payload"), list):
                    observation["payload"] = feed["payload"]
                else:
                    observation["payload"] = feed
            resolved.append({"descriptor": descriptor, "observation": observation})
        else:
            resolved.append({"descriptor": descriptor,
                             "observation": entry.get("observation") or {}})
    return _normalize_overlays(resolved)


def main():
    args = sys.argv[1:]
    if len(args) >= 6:
        # Positional argv (mirrors the proven transcript-page def binding pattern):
        #   <sources.json> <out.json> <session_id> <file_path> <before_cursor> <limit>
        #   [overlays.json] [selected-source-acquisition.json]
        # The optional 7th arg is the optimistic-overlay bundle (this package's own
        # outbound egress ledger, projected onto the open thread). When present on a
        # FIRST-page read it weaves just-sent messages in and converges them with the
        # native echo; `materialize` ignores it for older-page reads (before_cursor
        # set) since optimistic atoms are always the newest.
        sources_file, out_path, session_id, file_path, before_cursor_s, limit_s = args[:6]
        src = json.loads(pathlib.Path(sources_file).read_text(encoding="utf-8"))
        request = {
            "session_id": session_id if session_id not in (None, "", "null") else None,
            "file_path": file_path,
            "before_cursor": before_cursor_s,
            "limit": _parse_cursor(limit_s) or DEFAULT_LIMIT,
            "sources": _normalize_sources(src),
        }
        if len(args) >= 7 and args[6] not in (None, "", "null"):
            overlay_path = pathlib.Path(args[6])
            if overlay_path.exists():
                request["overlays"] = _load_overlay_bundle(overlay_path)
        if len(args) >= 8 and args[7] not in (None, "", "null"):
            acquisition_path = pathlib.Path(args[7])
            if acquisition_path.exists():
                request["acquisition"] = json.loads(acquisition_path.read_text(encoding="utf-8"))
    elif len(args) >= 2:
        request = json.loads(pathlib.Path(args[0]).read_text(encoding="utf-8"))
        out_path = args[1]
        # Honor a direct {descriptor,observation} request (tests); otherwise expand
        # raw/compact sources into matcher-ready descriptors.
        if request.get("descriptor") is None and "sources" in request:
            request["sources"] = _normalize_sources(request.get("sources"))
        if "overlays" in request:
            request["overlays"] = _normalize_overlays(request.get("overlays"))
    else:
        raise SystemExit(
            "usage: materialize-transcript.py <sources.json> <out.json> <session_id> <file_path> <before_cursor> <limit> [overlays.json] [selected-source-acquisition.json]"
            "  OR  <request.json> <out.json>")
    window = materialize(request)
    pathlib.Path(out_path).write_text(json.dumps(window, separators=(",", ":")), encoding="utf-8")
    print(f"lines={len(window['lines'])}/{window['total_count']} has_older={window['has_older']} "
          f"has_newer={window['has_newer']} older_cursor={window['older_cursor']}")


if __name__ == "__main__":
    main()
