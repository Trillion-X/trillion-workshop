#!/usr/bin/env python3
# packages/chat/do-work/process-scripts/decode-one-source.py
#
# Purpose: Decode ONE conversation source descriptor into its sidebar rows. This
# is the per-iteration leaf of the dissolved per-source decode loop (#28). The
# workflow loop iterates over the EXPANDED source descriptors (each already
# carries its own observer_capability_ref, decoder_capability_ref, and
# decoder_process_module/decoder_mount_path attached by build-conversation-
# descriptors.py). For each iteration the def reads THAT descriptor's decoder
# bytes from its own process_module.script_address and mounts them at
# decoder_mount_path (= module_name + ".py"), then runs this script.
#
# It owns ZERO channel/format/account knowledge: it delegates the entire decode
# to materialize_one_source_outcome() in the sibling materialize-conversations.py
# (the SSOT per-source body the single-process path also calls), so a new channel is
# ONE transcript_sources DATA row + its decoder package — zero edits here, zero
# def edits. Adding a channel never touches this file (L069/L063/L090).
#
# Non-Negotiable Invariants:
# - Blind: no `if channel ==`, no decoder name, no mount filename literal. The
#   decoder module is imported by the descriptor-derived name inside
#   materialize_one_source_outcome (capability_module, L090).
# - Fail-closed per source: a descriptor whose decoder is not mounted yields no
#   rows and says why, never crashes the whole sidebar.
# - Output NAMES ITS SOURCE AND SAYS WHAT HAPPENED:
#   {"decoded_source_ref": ..., "decode_status": ..., "rows": [...]}. It used to
#   be a bare {"rows":[...]}, and that made a source with nothing in it identical
#   to a source that could not be read, so the reduce step marked both done and a
#   broken source was never retried. The reduce step
#   (reduce-conversations.py) concatenates + dedupes + sorts + windows the rows,
#   and keeps a source's done-mark only when it finds that source's own success.
#
# CLI (compute.process):
#   decode-one-source.py <source-descriptor.json> <out-rows.json>
#     [per_source_limit] [acquisition.json] [scan-cursor.json]
#     [decoder-cursor-prior.json] [decoder-cursor.json]
#     source-descriptor.json = one FULL descriptor (as emitted by
#       build-conversation-descriptors.to_descriptor), NOT a compact spec.
#   Sibling materialize-conversations.py + the descriptor's own decoder/observer
#   modules are mounted in the same directory.
import importlib.util
import json
import os
import pathlib
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

DEFAULT_PER_SOURCE = 25
# Hard per-source total-byte ceiling for this leaf's compact-JSON output — the
# last line of defense (L083-safe default) after the row-count cap and the blind
# string cap. Generous vs the observed capped iMessage leaf (~18 KiB for 25 rows)
# so it never drops a legitimate row, but bounds a pathological decoder that fills
# many/enormous STRUCTURAL fields under the row-count cap, before this leaf output
# accumulates in the workflow-wasm ExecutionContext + is re-stringified for reduce.
DEFAULT_SOURCE_BYTE_BUDGET = 131072


def _cap_all_strings(value, limit: int):
    """Blind, recursive string cap — names NO field (L090). Truncates every string
    anywhere in a row structure to `limit` chars so a distributable decoder emitting
    a large value in ANY field (not only the SSOT reduce's title/prompt/preview) can
    never blow the leaf's byte budget. Depth is bounded by the row shape the decoder
    emits; ints/bools/None pass through untouched."""
    if isinstance(value, str):
        return value[:limit] if len(value) > limit else value
    if isinstance(value, list):
        return [_cap_all_strings(v, limit) for v in value]
    if isinstance(value, dict):
        return {k: _cap_all_strings(v, limit) for k, v in value.items()}
    return value


def _byte_bound_rows(rows: list, byte_budget: int) -> list:
    """Refuse a leaf result that exceeds its byte budget.

    Dropping tail rows here is not a harmless presentation window: the same leaf
    also publishes the Local Files continuation state. Accepting bytes after
    deleting their rows would make those conversations permanently ineligible on
    the next pass. Field and row caps keep normal results far below this guard;
    an over-budget result must retry without advancing either cursor.
    """
    encoded = json.dumps({"rows": rows}, separators=(",", ":")).encode("utf-8")
    if len(encoded) > byte_budget:
        raise ValueError("decoded rows exceed the source byte budget")
    return rows


def _load_shared():
    """Load the sibling materialize-conversations.py by path (its file name has
    hyphens, so it is not importable by module name). It holds the SSOT
    materialize_one_source_outcome(), the exact per-source body the
    single-process materialize() also calls through its rows view, so this leaf
    and the legacy path can never diverge."""
    shared_path = pathlib.Path(__file__).parent / "materialize-conversations.py"
    spec = importlib.util.spec_from_file_location("materialize_conversations", shared_path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def decode_one(descriptor, per_source_limit: int, acquisition=None,
               byte_budget: int = DEFAULT_SOURCE_BYTE_BUDGET,
               require_acquisition: bool = False, decoder_cursor=None) -> dict:
    shared = _load_shared()
    outcome = shared.materialize_one_source_outcome(
        descriptor, per_source_limit, acquisition, require_acquisition, decoder_cursor
    )
    rows = outcome["rows"]
    # Bound THIS leaf's output on THREE orthogonal axes before it enters the
    # workflow ExecutionContext. The final reduce (reduce_rows) already orders
    # newest-first and field-caps, but only AFTER every source's leaf output has
    # accumulated in the workflow-wasm ExecutionContext AND been json-stringified
    # there (the reduce step binds steps.decode_loop.output and runs op:core.stringify
    # + base64 encode INSIDE the workflow wasm to hand reduce its joined-rows mount).
    # An unbounded leaf output — a source yielding many threads (iMessage: one 200MB
    # chat.db decodes to 729 threads), or a distributable decoder emitting a large
    # value in ANY field — makes that in-wasm stringify allocation-trap the linear
    # memory, so the whole materialize traps and the sidebar window freezes.
    #
    # 1) ROW COUNT: newest-first, then truncate to per_source_limit.
    # 2) PER-ROW BYTES, EVERY FIELD: the SSOT reduce's OWN UX-field cap (keeps the
    #    previewTruncated marker) THEN a blind recursive string cap over all other
    #    structural fields the SSOT only bounds by convention (L090 — names none).
    # 3) HARD TOTAL BYTES: a per-source ceiling that drops tail rows if a truly
    #    pathological source slips past 1+2, so the leaf can never trap the wasm.
    # All three reuse the SSOT ordering/cap so this leaf can never diverge from
    # reduce, and a new channel/account still adds zero code (L063 category
    # elimination, P5 bound-at-boundary).
    rows.sort(key=shared._row_sort_key, reverse=True)
    rows = rows[:per_source_limit]
    for row in rows:
        shared._cap_row_fields(row, shared.DEFAULT_FIELD_CHAR_LIMIT)
    rows = [_cap_all_strings(row, shared.DEFAULT_FIELD_CHAR_LIMIT) for row in rows]
    rows = _byte_bound_rows(rows, byte_budget)
    return {**outcome, "rows": rows}


def main():
    if len(sys.argv) < 3:
        raise SystemExit("usage: decode-one-source.py <source-descriptor.json> <out-rows.json> [per_source_limit]")
    descriptor = json.loads(pathlib.Path(sys.argv[1]).read_text(encoding="utf-8"))
    # Tolerate a single-element wrapper ({"source": <descriptor>} or a 1-list) so
    # the loop can hand the item through verbatim regardless of binding shape.
    if isinstance(descriptor, dict) and "source_ref" not in descriptor and isinstance(descriptor.get("source"), dict):
        descriptor = descriptor["source"]
    if isinstance(descriptor, list):
        descriptor = descriptor[0] if descriptor else {}
    per_source_limit = int(sys.argv[3]) if len(sys.argv) > 3 and sys.argv[3] else DEFAULT_PER_SOURCE
    acquisition = None
    require_acquisition = len(sys.argv) > 4 and bool(sys.argv[4])
    if require_acquisition:
        try:
            acquisition = json.loads(pathlib.Path(sys.argv[4]).read_text(encoding="utf-8"))
        except (OSError, ValueError):
            acquisition = None
    decoder_cursor = None
    if len(sys.argv) > 6 and sys.argv[6]:
        try:
            with pathlib.Path(sys.argv[6]).open("rb") as cursor_file:
                raw_cursor = cursor_file.read(65537)
            if len(raw_cursor) > 65536:
                raise ValueError("decoder cursor exceeds its byte cap")
            decoder_cursor = json.loads(raw_cursor.decode("utf-8"))
        except (OSError, UnicodeDecodeError, ValueError) as problem:
            raise SystemExit(f"decoder cursor cannot be read: {problem}") from problem
    outcome = decode_one(
        descriptor, per_source_limit, acquisition,
        require_acquisition=require_acquisition,
        decoder_cursor=decoder_cursor,
    )
    rows = outcome["rows"]
    cursor = outcome.get("source_cursor")
    cursor_files = cursor.get("files") if isinstance(cursor, dict) else None
    cursor_available = isinstance(cursor_files, dict)
    if len(sys.argv) > 5 and sys.argv[5]:
        pathlib.Path(sys.argv[5]).write_text(
            json.dumps(cursor_files if cursor_available else {}, separators=(",", ":")),
            encoding="utf-8",
        )
    decoder_cursor_out = outcome.get("decoder_cursor")
    decoder_entries = (
        decoder_cursor_out.get("entries")
        if isinstance(decoder_cursor_out, dict)
        else None
    )
    decoder_cursor_available = isinstance(decoder_entries, list) and bool(decoder_entries)
    if len(sys.argv) > 7 and sys.argv[7]:
        pathlib.Path(sys.argv[7]).write_text(
            json.dumps(
                decoder_cursor_out if isinstance(decoder_cursor_out, dict) else {"version": 1, "entries": []},
                separators=(",", ":"),
            ),
            encoding="utf-8",
        )
    # The envelope NAMES ITS SOURCE and SAYS WHAT HAPPENED, so a source that was
    # handled is positively identifiable in the joined output. The reduce step
    # marks a source done only when it finds that source's own success here, and
    # therefore cannot be fooled by an empty file, unparseable bytes, an
    # unrecognised wrapper, or a failure reported in a shape it does not know:
    # none of those produce a success, so none of them produce a mark. Marking
    # from what positively succeeded is safe in a way that subtracting the
    # failures you happen to recognise never is.
    pathlib.Path(sys.argv[2]).write_text(
        json.dumps(
            {
                "decoded_source_ref": outcome.get("source_ref"),
                "decode_status": outcome.get("status"),
                "rows": rows,
                "source_cursor_available": cursor_available,
                "decoder_cursor_available": decoder_cursor_available,
                "decoder_reset_native_refs": outcome.get("decoder_reset_native_refs", []),
            },
            separators=(",", ":"),
        ),
        encoding="utf-8",
    )
    print(f"source={outcome.get('source_ref')} status={outcome.get('status')} rows={len(rows)}")


if __name__ == "__main__":
    main()
