#!/usr/bin/env python3
# packages/chat/do-work/process-scripts/build-conversation-descriptors.py
#
# =============================================================================
# PURPOSE
# =============================================================================
#
# Expand the COMPACT transcript-source specs (the cli-registry
# `prop:cli_registry:transcript_sources` fold rows) into the FULL, self-describing
# source descriptors that the generic materialize-conversations.py driver
# consumes. The driver reads `source_ref` + `observer_capability_ref` +
# `decoder_capability_ref` + `location` per descriptor and skips anything missing
# those fields — so the raw fold rows (attribute_fact rows whose value_json holds
# the compact specs) materialize to ZERO conversations without this expansion.
#
# This is the DATA-shape translation layer (L098): the cli-registry stores a
# compact, human-authored spec; the driver wants a uniform descriptor. This
# script is the ONLY place that knows how to turn one into the other, and it is
# generic over store shape — a spec may NAME its own observer/decoder (so a
# sqlite/chat.db source like iMessage is a spec that names
# `capability:decode-imessage-chatdb`), and only DEFAULTS to the CLI-JSONL
# capabilities when a spec omits them. Adding a new store shape = a new spec row
# that names its decoder, ZERO edits here.
#
# =============================================================================
# NON-NEGOTIABLE INVARIANTS
# =============================================================================
#
# 1. Pure transform: stdin/file in -> file out. No I/O beyond the two files.
# 2. Accepts BOTH raw attribute_fact rows (with value_json holding an array of
#    specs) AND already-unwrapped spec objects AND already-full descriptors —
#    idempotent, so it can sit in front of the driver regardless of upstream shape.
# 3. A spec may override observer_capability_ref / decoder_capability_ref /
#    location; otherwise CLI-JSONL defaults apply. No store/format names are
#    hardcoded as branches — the decoder is DATA (default OR spec-named).
# 4. source_ref is derived from the spec's own id field (cli_id / source_ref),
#    never a guessed substring; a spec with no id is skipped (cannot be addressed).
#
# =============================================================================
# CLI: build-conversation-descriptors.py <fold-or-specs.json> <out-descriptors.json>
#   out = {"sources": [<full descriptor>, ...]}
# =============================================================================

import json
import pathlib
import sys

# CLI-JSONL defaults — applied only when a spec does not name its own capability.
# These are the SAME capability ids the materialize def mounts; a spec naming a
# different decoder (e.g. capability:decode-imessage-chatdb) overrides them.
DEFAULT_OBSERVER = "capability:observe-file-glob"
DEFAULT_DECODER = "capability:decode-jsonl-session-events"
DEFAULT_GLOB = "**/*.jsonl"

# Where the materialize/decode defs mount decoder module bytes so the driver's
# importlib finds them on sys.path.
MOUNT_DIR = "packages/chat/do-work/process-scripts"

# The chat package BUNDLES its generic CLI-JSONL decoder. Its stored-bytes address
# stems do NOT match their import module names (jsonl's bytes live at
# ...decode-jsonl-session-script yet the driver imports module
# decode_jsonl_session_events), so their {script_address} is stated explicitly
# here. EVERY channel decoder (imessage/instagram/whatsapp/discord/telegram/...)
# is an EXTERNAL package whose transcript-source ROW carries its own
# decoder_process_module — a new channel/account is one self-describing DATA row,
# ZERO edits here (L069/L090). This map is chat's own two leaves, not a channel
# registry. Retired Chat-ledger history is migrated through the Conversations
# owner; it is not smuggled back into this production source expander.
BUILTIN_DECODER_SCRIPTS = {
    "capability:decode-jsonl-session-events": "package::jsonl-session-decoder::stored-bytes::decode-jsonl-session-script",
}


def _module_name_of(decoder_ref):
    """L090 module-name derivation — the SAME rule the driver's importlib uses
    (capability_module): capability:decode-x -> module decode_x. Kept in ONE place
    so the filename a def mounts and the module the driver imports can NEVER diverge
    for any channel, present or future."""
    return str(decoder_ref).split(":", 1)[-1].replace("-", "_")


def resolve_decoder_script_address(spec, decoder_ref):
    """The stored-bytes address that delivers THIS source's decoder .py to disk.
    Precedence: the source row's own decoder_process_module.script_address (the
    self-describing, distributable path) > a chat-bundled builtin keyed on the
    decoder ref. An external decoder ref with neither = None: the descriptor gets
    no script address, and the per-source decode loop fail-closes (skips it) rather
    than mounting the wrong bytes — never a silent misdecode."""
    row_pm = spec.get("decoder_process_module")
    if isinstance(row_pm, dict) and row_pm.get("script_address"):
        return row_pm["script_address"]
    return BUILTIN_DECODER_SCRIPTS.get(decoder_ref)

def _as_list(value):
    return value if isinstance(value, list) else [value]


# Envelope keys that wrap the actual row list. A `read` step output is the live
# current-read reply `{found, payload:[...rows...], payload_base64}`; other
# producers wrap their rows under records/rows/sources/etc. We peel ONE such
# envelope at the top so the driver receives the same expansion regardless of who
# fed it. Idempotent: the expander's own `{sources:[...]}` output re-peels cleanly.
_ENVELOPE_LIST_KEYS = ("payload", "sources", "records", "rows", "items", "results")


def _peel(raw):
    """Return the top-level list of entries from any accepted container shape:
    a bare list passes through; a single envelope object is peeled to its first
    list-valued envelope key; a lone object becomes a one-element list."""
    if isinstance(raw, list):
        return raw
    if isinstance(raw, dict):
        for key in _ENVELOPE_LIST_KEYS:
            if isinstance(raw.get(key), list):
                return raw[key]
    return [raw]


def unwrap(raw):
    """Yield compact spec objects from any accepted upstream shape.

    - current-read reply: {payload: [<attribute_fact row>, ...]} -> the row specs
    - raw attribute_fact row: {value_json: "<json array of specs>"} -> the specs
    - bare spec/descriptor object -> itself
    """
    for entry in _peel(raw):
        if not isinstance(entry, dict):
            continue
        if "value_json" in entry:
            try:
                inner = json.loads(entry["value_json"]) if isinstance(entry["value_json"], str) else entry["value_json"]
            except (ValueError, TypeError):
                continue
            for spec in _as_list(inner):
                if isinstance(spec, dict):
                    yield spec
        else:
            yield entry


def iter_source_specs(raw):
    """Yield only the upstream source specs.

    Live conversations now enter through the canonical Conversations owner feeds;
    this materializer owns only externally persisted transcript sources. Keeping
    the default list empty makes a missing source row fail visibly in its owner
    instead of resurrecting a private Chat ledger here."""
    specs = list(unwrap(raw))
    # Connection-backed templates are expanded by the same pure generic owner
    # used by the producer fan-out. Workflows mount the current canonical
    # service-connections feed at this conventional input name. If that input is
    # absent, plain descriptors still work and templates truthfully yield no
    # source rather than falling back to a singleton account.
    if any(isinstance(item.get("connection_instance_template"), dict) for item in specs):
        connection_path = pathlib.Path("service-connections.json")
        expander_path = pathlib.Path(__file__).parent / "expand-connected-source-descriptors.py"
        if not connection_path.exists() or not expander_path.exists():
            yield from (item for item in specs if "connection_instance_template" not in item)
            return
        try:
            import importlib.util as _ilu
            module_spec = _ilu.spec_from_file_location("connected_source_descriptors", expander_path)
            module = _ilu.module_from_spec(module_spec)
            module_spec.loader.exec_module(module)
            connections = json.loads(connection_path.read_text(encoding="utf-8"))
            specs = module.expand(specs, connections)["sources"]
        except (OSError, ValueError, TypeError):
            yield from (item for item in specs if "connection_instance_template" not in item)
            return
    yield from specs


def build_location(spec):
    """A spec may carry a ready `location`; otherwise compose a file-glob location
    from the compact CLI fields (account_prefix + root_path + glob), resolving
    {home} at the observer (Pattern 82 — segments, not a joined string)."""
    if isinstance(spec.get("location"), dict):
        return spec["location"]
    base = ["{home}"]
    account_prefix = spec.get("account_prefix")
    if account_prefix:
        base.append(account_prefix)
    base.extend(spec.get("root_path") or [])
    return {"kind": "file-glob", "data": {"base": base, "glob": spec.get("glob", DEFAULT_GLOB)}}


def to_descriptor(spec):
    """Compact spec -> full descriptor, or pass through an already-full descriptor."""
    source_id = spec.get("source_ref") or spec.get("cli_id") or spec.get("id")
    if not source_id:
        return None
    source_ref = source_id if str(source_id).startswith("source:") else f"source:cli-transcript:{source_id}"
    descriptor = dict(spec)  # preserve any extra fields the decoder/lens may read
    descriptor["source_ref"] = source_ref
    descriptor.setdefault("executor_route_ref", spec.get("cli_id") or source_id)
    location = build_location(spec)
    location_kind = location.get("kind")
    default_observer = "capability:observe-inline" if location_kind == "envelope-record" else DEFAULT_OBSERVER
    descriptor["observer_capability_ref"] = spec.get("observer_capability_ref", default_observer)
    decoder_ref = spec.get("decoder_capability_ref", DEFAULT_DECODER)
    descriptor["decoder_capability_ref"] = decoder_ref
    descriptor["location"] = location
    # Acquisition is selected by the descriptor's declared storage shape, never
    # by provider/account name. File-glob sources must pass through the native
    # local.files owner before their contained decoder runs. Other declared
    # shapes retain their existing observer path.
    file_action = (
        "action:decode-one-ranged-file-source"
        if spec.get("acquisition_mode") == "bounded-jsonl-range"
        else "action:decode-one-acquired-file-source"
    )
    descriptor["decode_action_ref"] = {
        "file-glob": file_action,
        "envelope-record": "action:decode-one-record-source",
    }.get(location_kind, "action:decode-one-source")
    # Byte-delivery for the per-source decode loop: script_address = WHERE the
    # decoder .py bytes live; mount_path = the on-disk filename, derived from the
    # decoder ref by the SAME L090 rule the driver imports by, so a def mount and a
    # driver import agree for any channel without either naming the channel.
    script_address = resolve_decoder_script_address(spec, decoder_ref)
    if script_address:
        module_name = _module_name_of(decoder_ref)
        descriptor["decoder_process_module"] = {"script_address": script_address, "module_name": module_name}
        descriptor["decoder_mount_path"] = f"{MOUNT_DIR}/{module_name}.py"
    return descriptor


def _mountable(descriptor):
    """A descriptor is loadable by the per-source decode loop ONLY if it carries the
    byte-delivery pair the loop mounts by: decoder_process_module.script_address
    (WHERE the decoder .py bytes live) and decoder_mount_path (the on-disk filename
    to mount them at). A descriptor lacking either names a decoder with no resolvable
    bytes (unknown ref, no row-provided script_address, not a chat builtin) and can
    NEVER be decoded in the fan-out path. Dropping it here is the same fail-closed
    skip the in-process path did via ImportError -> [], moved AHEAD of the loop so no
    iteration is ever handed a source whose decoder read/mount would resolve to null
    (L090, fail-closed per source — a bad source is silently skipped, never a crash)."""
    pm = descriptor.get("decoder_process_module")
    return bool(isinstance(pm, dict) and pm.get("script_address") and descriptor.get("decoder_mount_path"))


def _dirty_token(location):
    """Cheap change-signature for a source's NATIVE store, computed WITHOUT decoding
    it, so the periodic materialize can SKIP (leave carried) any source whose bytes
    are unchanged since the last window (O(changed), not O(all-sources)).

    Only a file-backed store (location.kind == "file-glob") has a cheap on-disk
    cursor: the token is "count:max_mtime_ns:total_size" over the glob matches — a
    new / modified / deleted file flips at least one term. Any non-file store
    (inline-observations, or a location.kind added later) has no such cursor and
    returns None = "always re-decode this tick" (its own freshness contract), never
    a false-clean. Generic over location.kind (DATA); zero source-name enumeration
    and zero channel branch (L090/enum-dissolution)."""
    if not isinstance(location, dict) or location.get("kind") != "file-glob":
        return None
    data = location.get("data") or {}
    base_segments = data.get("base") or []
    glob = data.get("glob") or DEFAULT_GLOB
    parts = [str(pathlib.Path.home()) if seg == "{home}" else str(seg) for seg in base_segments]
    if not parts:
        return None
    base_dir = pathlib.Path(*parts)
    count = 0
    max_mtime_ns = 0
    total_size = 0
    try:
        for match in base_dir.glob(glob):
            try:
                st = match.stat()
            except OSError:
                continue
            count += 1
            if st.st_mtime_ns > max_mtime_ns:
                max_mtime_ns = st.st_mtime_ns
            total_size += st.st_size
    except OSError:
        return None
    return f"{count}:{max_mtime_ns}:{total_size}"


def _valid_file_states(value):
    """A scanner cursor is an opaque path -> revision map.

    Chat never parses either string. It only carries the map back to the Local
    Files owner, which decides whether a file is unchanged. A wrong-shaped
    cursor is ignored here so it can never become scanner input; the source
    remains dirty and retryable instead of being declared complete.
    """
    if not isinstance(value, dict):
        return None
    if not all(isinstance(path, str) and path and isinstance(state, str)
               for path, state in value.items()):
        return None
    return value


def _valid_cursor_ref(value):
    if not isinstance(value, dict) or set(value) != {"content_hash"}:
        return None
    content_hash = value.get("content_hash")
    if (
        not isinstance(content_hash, str)
        or len(content_hash) != 67
        or not content_hash.startswith("1f:")
        or any(char not in "0123456789abcdef" for char in content_hash[3:])
    ):
        return None
    return value


def _valid_persisted_cursor(value):
    """Keep reference-shaped state out of the legacy path-map grammar."""
    if isinstance(value, dict) and "content_hash" in value:
        return _valid_cursor_ref(value)
    return _valid_file_states(value)


def _valid_conversation_page_cursor(value):
    if not isinstance(value, dict) or set(value) != {"content_hash", "offset"}:
        return None
    if _valid_cursor_ref({"content_hash": value.get("content_hash")}) is None:
        return None
    offset = value.get("offset")
    if isinstance(offset, bool) or not isinstance(offset, int) or offset != 0:
        return None
    return {"content_hash": value["content_hash"], "offset": 0}


def _load_prior(argv):
    """Read the PRIOR chat-session-window the materialize def hands in as an optional
    3rd arg (absent on the first-ever run -> {}). Returns the per-source change
    tokens, shown rows, decoded refs, opaque Local Files scan states, and prior
    unavailable refs. These let unchanged sources stay clean and bounded partial
    scans carry visible rows while continuing beyond their previous batch.

    prior_decoded is the UNION of the explicit `decoded_keys` list AND every source_ref
    that already has rows in the prior window (a shown row PROVES its source was decoded).
    The union is what makes the rollout safe: a window written before this field existed
    has no `decoded_keys`, so without the rows-fallback EVERY source would count as
    never-decoded and go dirty in a single tick — re-decoding even the huge/expensive
    stores (e.g. a 199MB iMessage chat.db) all at once and overflowing the command lane.
    Deriving "decoded" from existing rows keeps already-materialized sources clean across
    the upgrade; only genuinely 0-row sources decode on the first post-upgrade tick."""
    if len(argv) < 4:
        return {}, [], set(), {}, {}, set(), None
    try:
        prior = json.loads(pathlib.Path(argv[3]).read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return {}, [], set(), {}, {}, set(), None
    if not isinstance(prior, dict):
        return {}, [], set(), {}, {}, set(), None
    tokens = prior.get("source_tokens")
    rows = prior.get("rows")
    rows = rows if isinstance(rows, list) else []
    decoded = prior.get("decoded_keys")
    decoded_set = set(decoded) if isinstance(decoded, list) else set()
    decoded_set |= {r.get("sourceKey") for r in rows if isinstance(r, dict) and r.get("sourceKey")}
    raw_scan_states = prior.get("source_scan_states")
    scan_states = {}
    if isinstance(raw_scan_states, dict):
        for source_ref, state in raw_scan_states.items():
            valid = _valid_persisted_cursor(state)
            if isinstance(source_ref, str) and source_ref and valid is not None:
                scan_states[source_ref] = valid
    raw_decode_cursors = prior.get("source_decode_cursors")
    decode_cursors = {}
    if raw_decode_cursors is not None:
        if not isinstance(raw_decode_cursors, dict):
            raise SystemExit("prior chat window has malformed source decoder cursors")
        for source_ref, cursor_ref in raw_decode_cursors.items():
            if not isinstance(source_ref, str) or not source_ref or _valid_cursor_ref(cursor_ref) is None:
                raise SystemExit("prior chat window has a malformed source decoder cursor")
            decode_cursors[source_ref] = cursor_ref
    unavailable = prior.get("unavailable_sources")
    unavailable_set = {
        source_ref for source_ref in unavailable
        if isinstance(source_ref, str) and source_ref
    } if isinstance(unavailable, list) else set()
    page_cursor = None
    if "conversation_page_cursor" in prior and prior["conversation_page_cursor"] is not None:
        page_cursor = _valid_conversation_page_cursor(prior["conversation_page_cursor"])
        if page_cursor is None:
            raise SystemExit(
                "prior chat window has a malformed conversation page cursor; refusing "
                "to sever the retained page chain"
            )
    return (tokens if isinstance(tokens, dict) else {}, rows, decoded_set,
            scan_states, decode_cursors, unavailable_set, page_cursor)


def main():
    if len(sys.argv) < 3:
        raise SystemExit("usage: build-conversation-descriptors.py <fold-or-specs.json> <out-descriptors.json> [<prior-window.json>]")
    raw = json.loads(pathlib.Path(sys.argv[1]).read_text(encoding="utf-8"))
    descriptors = [d for spec in iter_source_specs(raw) if (d := to_descriptor(spec)) is not None]
    descriptors = [d for d in descriptors if _mountable(d)]

    # --- O(changed) activity gate --------------------------------------------
    # The single serial workflow-wasm instance runs each source's decoder as one
    # python subprocess (~6-9s). Decoding ALL ~11 sources every 45s clock tick took
    # ~98s > the tick, so the instance never drained and every interactive transcript
    # read starved. Instead: compute each source's cheap change-token, compare to the
    # prior window's tokens, and emit ONLY the sources whose store actually changed;
    # the unchanged sources' already-shown rows are carried forward untouched. An idle
    # tick then stats ~11 files (~tens of ms), decodes 0 sources, and releases the
    # instance immediately; a real new message decodes only that 1 source.
    (prior_tokens, prior_rows, prior_decoded, prior_scan_states,
     prior_decode_cursors, prior_unavailable, prior_page_cursor) = _load_prior(sys.argv)
    descriptor_refs = {
        descriptor.get("source_ref") for descriptor in descriptors
        if isinstance(descriptor.get("source_ref"), str)
    }
    prior_scan_states = {
        source_ref: state for source_ref, state in prior_scan_states.items()
        if source_ref in descriptor_refs
    }
    prior_decode_cursors = {
        source_ref: cursor_ref for source_ref, cursor_ref in prior_decode_cursors.items()
        if source_ref in descriptor_refs
    }
    for descriptor in descriptors:
        source_ref = descriptor.get("source_ref")
        state = prior_scan_states.get(source_ref)
        location = descriptor.get("location")
        if state is not None and isinstance(location, dict) and location.get("kind") == "file-glob":
            # Provider-neutral acquisition state. The workflow passes these
            # opaque values back to local.files as `known_files`; neither Chat
            # nor a provider decoder interprets paths or revisions.
            descriptor["acquisition_cursor"] = (
                state if _valid_cursor_ref(state) is not None else {"files": state}
            )
        decoder_cursor_ref = prior_decode_cursors.get(source_ref)
        if decoder_cursor_ref is not None:
            descriptor["decoder_cursor_source"] = {
                "kind": "blob_ref",
                "hash": decoder_cursor_ref["content_hash"],
            }
    source_tokens = {d.get("source_ref"): _dirty_token(d.get("location")) for d in descriptors}
    # A source is only "clean" (skip re-decode, carry its shown rows) if BOTH its store is
    # unchanged (token matches) AND it has been decoded at least once before (in
    # prior_decoded). The change-token is a stat cursor written for EVERY descriptor each
    # run, decoupled from whether decode ever ran for it — so gating clean on the token
    # ALONE let a source that was tokenized but never actually decoded (a run that died
    # after tokens were written, or a source whose first decode never completed) match its
    # token forever and freeze invisible: clean-with-nothing, never re-decoded. Gating on
    # "ever decoded" makes that stuck category structurally impossible — a never-decoded
    # source is ALWAYS dirty until it has gone through the decode loop once — while keeping
    # true O(changed): a source decoded once (even if it yielded 0 rows) then stays clean
    # until its store actually changes, so genuinely-empty sources do NOT re-decode every
    # tick. decoded_keys accumulates across windows (prior ∪ this run's dirty set) and is
    # persisted into the window by reduce-conversations.py. Generic field test — no branch.
    def _is_dirty(key):
        token = source_tokens.get(key)
        # None token = no cheap cursor -> always re-decode (its own freshness contract).
        return (
            token is None
            or key not in prior_tokens
            or prior_tokens.get(key) != token
            or key not in prior_decoded
            or key in prior_decode_cursors
        )

    dirty_descriptors = [d for d in descriptors if _is_dirty(d.get("source_ref"))]
    clean_keys = {d.get("source_ref") for d in descriptors if not _is_dirty(d.get("source_ref"))}
    # Carry rows whose source is still present and either unchanged or in a
    # cursor-backed/incomplete acquisition. A row's sourceKey is the decoder's
    # own source_ref, so this remains a pure generic-field test with no provider
    # branch. Removed sources are never carried.
    # A cursor-backed source is decoded in bounded batches. Keep its already
    # shown rows while the next batch arrives, including after a completed scan
    # notices a changed file. The reduce deduplicates a changed conversation by
    # identity/revision, so current rows replace their carried predecessor.
    cursor_keys = set(prior_scan_states) | set(prior_decode_cursors)
    carry_keys = clean_keys | cursor_keys | (prior_unavailable & descriptor_refs)
    carry_rows = [
        row for row in prior_rows
        if isinstance(row, dict) and row.get("sourceKey") in carry_keys
    ]
    # A source is marked "decoded" once it has been handed to the decode loop (is dirty
    # this run), accumulated with everything decoded in prior windows. Persisted forward
    # so the next run can tell never-decoded (always dirty) from decoded-and-empty (clean).
    #
    # HANDED IS NOT DECODED, and this step cannot know the difference, because the loop
    # has not run yet. reduce-conversations.py, which does see outcomes, keeps a mark
    # ONLY for a source whose own success envelope is present in the joined output,
    # checked against the `sources` list below as the attempt manifest. Everything else
    # attempted this run loses both marks.
    #
    # It briefly worked the other way round, subtracting the failures it recognised, and
    # that could only withdraw a mark for a failure shaped the way it expected. An
    # unreadable file, a missing file, an unrecognised wrapper or an older error shape all
    # left the premature mark standing, so a source that fails every time was recorded as
    # decoded-and-empty, went clean, and was never retried.
    decoded_keys = sorted(prior_decoded | {d.get("source_ref") for d in dirty_descriptors})

    out = {
        "sources": dirty_descriptors,
        "source_tokens": source_tokens,
        "carry_rows": carry_rows,
        "decoded_keys": decoded_keys,
        "source_scan_states": prior_scan_states,
        "source_decode_cursors": prior_decode_cursors,
    }
    if prior_page_cursor is not None:
        out["conversation_page_cursor"] = prior_page_cursor
    pathlib.Path(sys.argv[2]).write_text(json.dumps(out, separators=(",", ":")), encoding="utf-8")
    print(f"descriptors_total={len(descriptors)} dirty={len(dirty_descriptors)} "
          f"clean={len(clean_keys)} carry_rows={len(carry_rows)}")


if __name__ == "__main__":
    main()
