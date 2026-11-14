#!/usr/bin/env python3
# packages/chat/do-work/process-scripts/decode_viewer_reactions.py
#
# =============================================================================
# PURPOSE
# =============================================================================
#
# Decoder/ADAPTER that turns this package's OWN viewer-reaction ledger (the
# durable annotations a user AUTHORED on a message — records written by
# `action:submit-viewer-annotation` / do-work/submit-message-intent-from-chat.ts)
# into optimistic reaction ATOMS, so a reaction the user just placed interleaves
# onto its target message in the transcript immediately and PERSISTS across
# reloads — folded by the SAME materializer + rendered by the SAME renderer that
# already display source-of-record tapbacks. Zero materializer/engine change.
#
# This is a thin ADAPTER, exactly like decode_egress_ledger.py: it knows ONLY the
# viewer-reaction record shape (its own package's data), normalizes into
# source-neutral reaction `thread_specs`, and calls the shared transcript-mapper.
# It owns NO atom identity / speaker_ref / convergence logic — that is the mapper
# SSOT (co-mounted in the process-job dir). A reaction is one CONFIGURATION of the
# generic viewer-intent path (pin/star/bookmark are other configs on the same
# ledger); this decoder never enumerates the symbol set (L090 / enum-dissolution).
#
# =============================================================================
# FAIL-CLOSED REALITY (why a viewer reaction is a LOCAL annotation)
# =============================================================================
#
# The iMessage transport (imessage-messages-sender) sends TEXT ONLY — macOS
# supported automation exposes no tapback/reaction egress. So a reaction the user
# authors CANNOT be delivered to the recipient today. The honest 1000x design:
# an authored reaction is the user's OWN durable annotation on the message subject
# atom, stamped provenance=PROVISIONAL (NOT AUTHORITATIVE) — the renderer draws it
# faint ("yours"), and it NEVER claims it reached the other person. Real egress
# turns on the day a source declares a `reactCapability` (DATA, mirroring
# `sendCapability`): the same authored record would then also drive a transport
# send — ZERO code change here (L069/L090).
#
# =============================================================================
# PROJECTION-KEYED CONVERGENCE (the non-obvious invariant)
# =============================================================================
#
# For the reaction overlay atom to attach to its target message, BOTH must land
# on the SAME conversation identity — the same `thread_ref`
# (`thread:{source_ref}:{session_id}`) that the target message's native atoms use,
# AND the reaction's `reaction_target` relation must carry the target message's
# exact `target_atom_ref`. The composer (the chat surface that fired the react) is
# the only party that knows the open thread + which message was tapped, so it
# carries BOTH opaquely into the ledger record: `target_thread_ref` (= the native
# `thread_ref` it was viewing) and `target_atom_ref` (= the tapped message's
# atomRef). This adapter reads them verbatim and NEVER hardcodes a source name —
# records for different targets are grouped by their own `target_thread_ref`, so
# one batch can weave reactions into iMessage, WhatsApp, ... threads at once.
#
# The reaction's OWN identity + speaker_ref are the mapper's job. We pass the
# target_atom_ref pre-resolved on the relation; `_build_atoms`'s in-batch
# native->atom resolution only OVERWRITES a relation's `target_atom_ref` when it
# resolves a `target_native_ref` in the SAME batch, so a pre-set `target_atom_ref`
# with no `target_native_ref` survives untouched — exactly what we need for an
# off-page target that the target's OWN native page already renders.
#
# =============================================================================
# NON-NEGOTIABLE INVARIANTS
# =============================================================================
#
# 1. Every emitted reaction atom is stamped provenance=PROVISIONAL — a viewer
#    annotation, never the source of record. It is NEVER shown as AUTHORITATIVE
#    (delivered/confirmed by the other party). If a real source-of-record tapback
#    with the SAME (speaker, symbol) later lands AUTHORITATIVE, the mapper's
#    provenance-ranked convergence collapses the pair to the AUTHORITATIVE one.
# 2. FAIL-CLOSED: a record with no resolvable target (`target_atom_ref` +
#    `target_thread_ref`) or no `symbol` emits NOTHING (it is rejected) — a
#    dangling reaction that cannot attach is never rendered.
# 3. `reaction_kind` is carried verbatim (`added` default / `removed`); the
#    materializer's `_fold_reactions` reduces add-then-remove by (speaker, symbol)
#    so an un-react cancels. This decoder never folds — it only emits events.
# 4. ZERO transport/consent/credential logic here — this adapter READS the ledger
#    the surface already wrote; it never sends anything.
# 5. `decode(observation, descriptor) -> {threads, atoms, rejections}` — the same
#    uniform decoder contract every conversation source honours.
#
# Usage: decode_viewer_reactions.py <request.json> <out-atoms.json>
#   request.json = {observation:{source_ref?, batch_ref?, observed_at?, records:[...]}, descriptor}
#   reaction record = {intent_id, target_atom_ref, target_thread_ref, symbol,
#                      reaction_kind?, actor?, at?}
#
# The extensive documentation in this codebase is a critical design feature.
# You are forbidden from simplifying or removing it.
# =============================================================================
import json
import pathlib
import sys

# The canonical mapper (co-mounted alongside this adapter in the process-job dir)
# owns atom identity / speaker_ref / presentation / convergence. This adapter is
# a pure ADAPTER: it knows ONLY the viewer-reaction record shape.
sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent))
import transcript_mapper as tm  # noqa: E402

REACTION_TARGET_ROLE = "reaction_target"


def _parse_json_cell(cell):
    """A cell that carries a record as a JSON object -> that record dict.
    Accepts an already-parsed dict or a JSON-text string; anything else -> None."""
    if isinstance(cell, dict):
        return cell
    if isinstance(cell, str):
        try:
            parsed = json.loads(cell)
        except (ValueError, TypeError):
            return None
        return parsed if isinstance(parsed, dict) else None
    return None


def _row_to_record(item):
    """Coerce ONE fed item into a viewer-reaction record dict.

    The feed may arrive as plain record dicts (tests / a raw live-read payload) OR
    as rows of a cell_table projection whose column 1 is each record's
    `payload_json_text` (mirroring the egress-ledger + published-records
    projections). Knowing that column layout is this package's OWN concern (L098):
    the chat surface passes the feed value opaquely and never learns this shape."""
    if isinstance(item, dict):
        if isinstance(item.get("cells"), list):
            return _row_to_record(item["cells"])
        for key in ("payload", "payload_json_text", "1", 1):
            if key in item:
                record = _parse_json_cell(item[key])
                if record is not None:
                    return record
        return item  # already a plain record dict
    if isinstance(item, list):
        for cell in item:
            record = _parse_json_cell(cell)
            if record is not None:
                return record
        return None
    return None


def _records_of(observation):
    """The viewer-reaction rows the surface/def handed us as data.

    Accept every shape the def author might bind so chat stays blind: a `records`
    or `payload` list, a `batch.accepted`, or a cell_table projection delivered
    whole (`{columns, rows}` / `{cells}`). Each item is coerced through
    `_row_to_record`."""
    raw = observation.get("records")
    if raw is None:
        raw = observation.get("payload")
    if raw is None:
        batch = observation.get("batch") or {}
        raw = batch.get("accepted") or batch.get("records")
    if isinstance(raw, dict):
        raw = raw.get("rows") or raw.get("cells") or raw.get("records") or []
    if not isinstance(raw, list):
        return []
    records = []
    for item in raw:
        record = _row_to_record(item)
        if isinstance(record, dict):
            records.append(record)
    return records


def _split_thread_ref(thread_ref):
    """Recover (source_ref, session_id) from a native thread_ref
    `thread:{source_ref}:{session_id}`. Splitting the remainder at its LAST colon
    yields (src, session) that ALWAYS rebuild to the identical `thread_ref` — the
    only equality the reaction<->message co-location requires — regardless of
    colons inside source_ref/session_id."""
    if not isinstance(thread_ref, str):
        return None, None
    prefix = "thread:"
    if not thread_ref.startswith(prefix):
        return None, None
    remainder = thread_ref[len(prefix):]
    if ":" not in remainder:
        return None, None
    src, session_id = remainder.rsplit(":", 1)
    if not src or not session_id:
        return None, None
    return src, session_id


def decode(observation, descriptor):
    """One viewer-reaction observation -> PROVISIONAL reaction atoms projected onto
    the target message's native thread. Records are grouped by their target thread
    (source namespace + session) so each group maps under the target source's
    namespace and shares thread_ref with that source's native atoms; the target
    message is bound by the pre-resolved `target_atom_ref` on the relation."""
    records = _records_of(observation)
    batch_ref = observation.get("batch_ref")
    observed_at = observation.get("observed_at")

    groups = {}          # (src, session_id) -> reaction message specs
    rejections = []
    for record in records:
        if not isinstance(record, dict):
            continue
        target_atom_ref = record.get("target_atom_ref")
        src, session_id = _split_thread_ref(record.get("target_thread_ref"))
        symbol = record.get("symbol")
        if not target_atom_ref or not src or not session_id or not symbol:
            rejections.append({
                "source_ref": src or observation.get("source_ref"),
                "violation_path": "reaction_record.target_atom_ref|target_thread_ref|symbol",
                "expected": "a resolvable target atom + thread and a reaction symbol",
                "got": json.dumps({k: record.get(k) for k in
                                   ("intent_id", "target_atom_ref",
                                    "target_thread_ref", "symbol", "reaction_kind")}),
            })
            continue
        by_group = groups.setdefault((str(src), str(session_id)), [])
        by_group.append({
            # a reaction carries NO text; identity comes from thread+index+speaker.
            "index": len(by_group),
            "speaker": record.get("actor") or "me",
            "kind": "reaction",
            "reaction_symbol": symbol,
            "reaction_kind": record.get("reaction_kind") or "added",
            "at": record.get("at") or record.get("observed_at") or observed_at,
            "provenance": tm.PROVISIONAL,
            # pre-resolved target: the target message's OWN native page renders it;
            # its atomRef is opaque to us, carried verbatim from the composer.
            "relations": [{
                "role": REACTION_TARGET_ROLE,
                "target_atom_ref": target_atom_ref,
            }],
        })

    threads, atoms = [], []
    for (src, session_id), messages in groups.items():
        sub_obs = {
            "source_ref": src,
            "session_id": session_id,
            "batch_ref": batch_ref,
            "observed_at": observed_at,
            "provenance": tm.PROVISIONAL,
        }
        spec = {"session_id": session_id, "title": session_id, "messages": messages}
        result = tm.map_transcript(sub_obs, descriptor, [spec])
        threads.extend(result["threads"])
        atoms.extend(result["atoms"])
        rejections.extend(result["rejections"])
    return {"threads": threads, "atoms": atoms, "rejections": rejections}


def main():
    request = json.loads(pathlib.Path(sys.argv[1]).read_text(encoding="utf-8"))
    out_path = sys.argv[2]
    descriptor = request.get("descriptor") or {}
    if "observation" in request:
        observations = [request["observation"]]
    else:
        batch = request.get("batch") or {}
        observations = batch.get("accepted") or batch.get("observations") or []
    threads, atoms, rejections = [], [], []
    for obs in observations:
        if not isinstance(obs, dict):
            continue
        result = decode(obs, descriptor)
        threads.extend(result["threads"])
        atoms.extend(result["atoms"])
        rejections.extend(result["rejections"])
    pathlib.Path(out_path).write_text(json.dumps({
        "threads": threads, "atoms": atoms, "rejections": rejections,
    }, separators=(",", ":")), encoding="utf-8")
    print(f"threads={len(threads)} atoms={len(atoms)} rejections={len(rejections)}")


if __name__ == "__main__":
    main()
