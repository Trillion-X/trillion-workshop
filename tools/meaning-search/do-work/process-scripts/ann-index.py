"""packages/meaning-search/do-work/process-scripts/ann-index.py

Purpose: pure-stdlib (zero external deps) approximate-nearest-neighbor (ANN)
index over embedding vectors, keyed per semantic-index-descriptor (`index_id`).
Makes `action:find-similar` O(candidates) instead of O(corpus) by narrowing
the candidate set with locality-sensitive hashing (LSH, random-hyperplane /
SimHash-style) BEFORE the existing exact cosine ranker
(`nearest-embedding-facts.py`) reranks the small candidate set.

Non-Negotiable Invariants:
- Zero external dependencies (stdlib only: json/math/random/argparse). The
  compute.process sandbox does not guarantee hnswlib/numpy are installed;
  stdlib-only guarantees this runs everywhere the existing scripts already run.
- ALL tunable parameters (hyperplane_count, table_count, seed, candidate_limit,
  dims) are DATA passed in via --params-json, sourced from the
  semantic-index-descriptor record. NEVER hardcoded (L090 / Physics-vs-Society).
- Deterministic: hyperplanes are derived from a seed stored IN the persisted
  state, so query-time hashing reproduces upsert-time bucket assignment even
  across separate process invocations (no shared memory).
- Incremental: `--mode upsert` adds ONE vector to the persisted state without
  touching or rescanning any other vector. O(hyperplane_count), not O(corpus).
- Fail-closed: `--mode query` against an empty/absent state returns an empty
  candidate array, never a full corpus fallback and never a crash.
- Output is a BARE top-level JSON array in both modes' fact/candidate outputs
  (no wrapper object), matching the existing `records.json` convention used by
  make-embedding-facts-from-command-output.py, so downstream workflow steps
  never need nested-path extraction after decode+json_parse.

Security Considerations: no network, no filesystem access outside the
explicit --*-json mount paths, no eval/exec of untrusted input.

CLI:
  ann-index.py --mode upsert \
    --state-json state.json --vector-json vector.json --params-json params.json \
    --index-id <id> --subject-id <id> \
    --output-state-json state.out.json --output-facts-json facts.out.json

  ann-index.py --mode query \
    --state-json state.json --vector-json vector.json --params-json params.json \
    --output-candidates-json candidates.json
"""
from __future__ import annotations

import argparse
import copy
import json
import math
import os
import tempfile
import sys
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from canonical_multihash import require_canonical_multihash


def _load_json(path: str, default):
    try:
        with open(path, "r", encoding="utf-8") as f:
            text = f.read().strip()
    except FileNotFoundError:
        return default
    if not text:
        return default
    return json.loads(text)


def _write_json(path: str, value) -> None:
    """Publish a complete state snapshot or leave the prior snapshot intact.

    Index state is an input to the next operation, so a partially-written JSON
    file would turn an interrupted update into silent loss of discoverability.
    `os.replace` is atomic on the mounted filesystem and the temporary file is
    placed beside the destination so it is on the same filesystem.
    """
    directory = os.path.dirname(os.path.abspath(path)) or "."
    fd, temporary_path = tempfile.mkstemp(prefix=".semantic-index-", dir=directory)
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as f:
            json.dump(value, f, ensure_ascii=False, separators=(",", ":"))
            f.flush()
            os.fsync(f.fileno())
        os.replace(temporary_path, path)
    except BaseException:
        try:
            os.unlink(temporary_path)
        except FileNotFoundError:
            pass
        raise


def _lcg_stream(seed: int):
    """Deterministic pure-stdlib PRNG stream (no `random` module state
    dependency across processes) — a 64-bit LCG, reproducible from an integer
    seed stored in DATA. Yields floats in [-1.0, 1.0)."""
    state = seed & 0xFFFFFFFFFFFFFFFF
    a = 6364136223846793005
    c = 1442695040888963407
    m = 1 << 64
    while True:
        state = (a * state + c) % m
        yield (state / m) * 2.0 - 1.0


def _make_hyperplanes(seed: int, table_count: int, hyperplane_count: int, dims: int):
    stream = _lcg_stream(seed)
    tables = []
    for _ in range(table_count):
        table = []
        for _ in range(hyperplane_count):
            table.append([next(stream) for _ in range(dims)])
        tables.append(table)
    return tables


def _dot(a, b) -> float:
    return sum(x * y for x, y in zip(a, b))


def _bucket_key(vector, hyperplanes) -> str:
    bits = []
    for plane in hyperplanes:
        bits.append("1" if _dot(vector, plane) >= 0.0 else "0")
    return "".join(bits)


def _resolve_params(params_in: dict, dims: int) -> dict:
    required = ("hyperplane_count", "table_count", "seed", "candidate_limit")
    if not isinstance(params_in, dict) or any(key not in params_in for key in required):
        raise SystemExit("ann-index: descriptor ann_params must contain hyperplane_count, table_count, seed, candidate_limit")
    if any(isinstance(params_in[key], bool) for key in required):
        raise SystemExit("ann-index: descriptor ann_params values must be integers")
    try:
        resolved = {key: int(params_in[key]) for key in required}
    except (TypeError, ValueError) as exc:
        raise SystemExit("ann-index: descriptor ann_params values must be integers") from exc
    if resolved["hyperplane_count"] < 1 or resolved["table_count"] < 1 or resolved["candidate_limit"] < 1:
        raise SystemExit("ann-index: descriptor ann_params counts must be positive")
    return {**resolved, "dims": dims}


def _required_revision(value: str, name: str) -> str:
    if not isinstance(value, str) or not value:
        raise SystemExit(f"ann-index: {name} must be a non-empty string")
    return value


def _subject_metadata(args) -> dict:
    try:
        return {
            "canonical_address": _required_revision(args.canonical_address or args.subject_id, "canonical_address"),
            "revision": require_canonical_multihash(args.revision, "revision"),
            "payload_hash": require_canonical_multihash(args.payload_hash, "payload_hash"),
            "source_snapshot_ref": require_canonical_multihash(args.source_snapshot_ref, "source_snapshot_ref"),
        }
    except ValueError as exc:
        raise SystemExit(f"ann-index: {exc}") from exc


def _is_rejected(existing: dict | None, incoming: dict, removed: bool) -> bool:
    """Reject contradictory operations from the same exact source snapshot.

    Snapshot references are cryptographic set identities, not clocks, so code
    must never invent ordering between them. Cross-snapshot freshness is
    proven by canonical owner hydration and the convergence receipt.
    """
    if not existing:
        return False
    if existing.get("source_snapshot_ref") != incoming["source_snapshot_ref"]:
        return False
    same_representation = (
        existing.get("canonical_address") == incoming["canonical_address"]
        and existing.get("revision") == incoming["revision"]
        and existing.get("payload_hash") == incoming["payload_hash"]
    )
    # A retract names the representation it removes.  That exact active→removed
    # transition (and a repeated identical retract) is monotonic and therefore
    # valid; a same-snapshot retract for any other representation is stale and
    # must never erase a newer active vector.
    if removed:
        return not same_representation
    return not same_representation or bool(existing.get("removed"))


def _remove_subject_from_buckets(buckets: list[dict], subject_id: str) -> None:
    for table in buckets:
        for key in list(table):
            members = [member for member in table[key] if member != subject_id]
            if members:
                table[key] = members
            else:
                del table[key]


def _facts_for_state(index_id: str, state: dict) -> list[dict]:
    """Encode the sole ANN state record using the existing generic fact form."""
    published_path = ["current-item", "published-record"]
    type_id = "type:semantic-ann-index"
    property_id = f"prop:semantic-ann-index:{index_id}"
    value_json = json.dumps(state, ensure_ascii=False, separators=(",", ":"))
    return [
        {"address": f"entity|{index_id}", "path": published_path,
         "payload": {"table": "entity", "id": index_id}},
        {"address": f"entity_types|{index_id}|{type_id}", "path": published_path,
         "payload": {"table": "entity_types", "entity_id": index_id, "type_id": type_id}},
        {"address": f"type_properties|{type_id}|{property_id}", "path": published_path,
         "payload": {"table": "type_properties", "type_id": type_id, "property_id": property_id}},
        {"address": f"attribute_fact|{index_id}|{property_id}|{type_id}", "path": published_path,
         "payload": {"table": "attribute_fact", "subject_id": index_id,
                     "property_id": property_id, "type_id": type_id, "value_json": value_json}},
    ]


def _facts_for_retraction(index_id: str, subject_id: str, state: dict) -> list[dict]:
    """Persist the ANN tombstone and retract the subject's current representations.

    The ANN state is the membership authority and retains the subject tombstone
    for idempotence/race protection.  Embedding and model-provenance facts are
    projections of an active membership, so they must stop being current in the
    same atomic Workflow write set.
    """
    published_path = ["current-item", "published-record"]
    type_id = "type:semantic-indexed"
    return [
        *_facts_for_state(index_id, state),
        {
            "address": f"attribute_fact|{subject_id}|prop:semantic-embedding:{index_id}|{type_id}",
            "path": published_path,
            "remove": True,
        },
        {
            "address": f"attribute_fact|{subject_id}|prop:semantic-provenance:{index_id}|{type_id}",
            "path": published_path,
            "remove": True,
        },
    ]


def cmd_upsert(args) -> None:
    state = _load_json(args.state_json, {}) or {}
    vector = _load_json(args.vector_json, None)
    params_in = _load_json(args.params_json, {}) or {}

    if not isinstance(vector, list) or not vector:
        raise SystemExit("ann-index upsert: vector.json must be a non-empty numeric array")
    vector = [float(x) for x in vector]
    dims = len(vector)

    metadata = _subject_metadata(args)
    subjects = state.get("subjects") or {}
    existing = subjects.get(args.subject_id)
    if _is_rejected(existing, metadata, False):
        _write_json(args.output_state_json, state)
        _write_json(args.output_facts_json, _facts_for_state(args.index_id, state))
        if args.output_event_json:
            _write_json(args.output_event_json, {
                "event": "semantic_index.stale_rejected", "subject_ref": args.subject_id,
                "indexed_snapshot_ref": existing.get("source_snapshot_ref"),
                "source_snapshot_ref": metadata["source_snapshot_ref"],
            })
        return

    params = _resolve_params(params_in, dims)
    if state.get("params") and state["params"] != params:
        raise SystemExit("ann-index: descriptor ann_params differ from persisted index parameters")
    seed = int(params["seed"])
    table_count = int(params["table_count"])
    hyperplane_count = int(params["hyperplane_count"])

    hyperplanes = state.get("hyperplanes")
    if not hyperplanes or state.get("dims") != dims or state.get("seed") != seed \
            or state.get("table_count") != table_count or state.get("hyperplane_count") != hyperplane_count:
        hyperplanes = _make_hyperplanes(seed, table_count, hyperplane_count, dims)

    # Snapshot presence BEFORE mutating buckets below. `buckets` aliases the
    # SAME dict/list objects as `state["buckets"]` (no deep copy) — mutating
    # `buckets` in place mutates `state` too, so presence must be checked
    # first or every upsert after the first would see its own subject_id as
    # already-present (that was the original bug: vector_count stuck at 1).
    was_already_present = bool(existing and not existing.get("removed"))

    buckets = state.get("buckets") or [dict() for _ in range(table_count)]
    while len(buckets) < table_count:
        buckets.append({})

    # An update may hash to a different bucket.  Delete its old representation
    # before adding the current one; identity remains stable across revisions.
    _remove_subject_from_buckets(buckets, args.subject_id)
    for t in range(table_count):
        key = _bucket_key(vector, hyperplanes[t])
        bucket = buckets[t].setdefault(key, [])
        if args.subject_id not in bucket:
            bucket.append(args.subject_id)

    new_state = {
        "index_id": args.index_id,
        "dims": dims,
        "seed": seed,
        "table_count": table_count,
        "hyperplane_count": hyperplane_count,
        "params": params,
        "hyperplanes": hyperplanes,
        "buckets": buckets,
        "subjects": {**subjects, args.subject_id: {**metadata, "removed": False}},
        "vector_count": int(state.get("vector_count", 0)) + (0 if was_already_present else 1),
    }

    _write_json(args.output_state_json, new_state)
    _write_json(args.output_facts_json, _facts_for_state(args.index_id, new_state))
    if args.output_event_json:
        _write_json(args.output_event_json, {
            "event": "semantic_index.mutated", "operation": "update" if was_already_present else "add",
            "subject_ref": args.subject_id, "revision": metadata["revision"],
            "source_snapshot_ref": metadata["source_snapshot_ref"],
        })


def cmd_delete(args) -> None:
    state = _load_json(args.state_json, {}) or {}
    metadata = _subject_metadata(args)
    subjects = dict(state.get("subjects") or {})
    existing = subjects.get(args.subject_id)
    if existing and _is_rejected(existing, metadata, True):
        _write_json(args.output_state_json, state)
        _write_json(args.output_facts_json, _facts_for_state(args.index_id, state))
        if args.output_event_json:
            _write_json(args.output_event_json, {
                "event": "semantic_index.stale_rejected", "subject_ref": args.subject_id,
                "indexed_snapshot_ref": existing.get("source_snapshot_ref") if existing else None,
                "source_snapshot_ref": metadata["source_snapshot_ref"],
            })
        return
    buckets = state.get("buckets") or []
    _remove_subject_from_buckets(buckets, args.subject_id)
    subjects[args.subject_id] = {**metadata, "removed": True}
    new_state = {**state, "buckets": buckets, "subjects": subjects,
                 "vector_count": max(0, int(state.get("vector_count", 0)) - 1)}
    _write_json(args.output_state_json, new_state)
    _write_json(
        args.output_facts_json,
        _facts_for_retraction(args.index_id, args.subject_id, new_state),
    )
    if args.output_event_json:
        _write_json(args.output_event_json, {
            "event": "semantic_index.mutated", "operation": "delete",
            "subject_ref": args.subject_id, "revision": metadata["revision"],
            "source_snapshot_ref": metadata["source_snapshot_ref"],
        })


def _apply_upsert_to_state(state: dict, *, index_id: str, subject_id: str,
                           metadata: dict, vector: list[float], params_in: dict) -> dict:
    """The in-memory half of the canonical single-subject upsert.

    `apply-plan` uses this same primitive to apply a bounded delta batch.  It
    does not synthesize an index projection: the returned state is precisely
    the state encoded by `_facts_for_state`, and each mutation retains the
    owner address/revision/snapshot identity used by normal `upsert`.
    """
    subjects = state.get("subjects") or {}
    existing = subjects.get(subject_id)
    if _is_rejected(existing, metadata, False):
        return state
    dims = len(vector)
    params = _resolve_params(params_in, dims)
    if state.get("params") and state["params"] != params:
        raise SystemExit("ann-index: descriptor ann_params differ from persisted index parameters")
    seed = int(params["seed"])
    table_count = int(params["table_count"])
    hyperplane_count = int(params["hyperplane_count"])
    hyperplanes = state.get("hyperplanes")
    if not hyperplanes or state.get("dims") != dims or state.get("seed") != seed \
            or state.get("table_count") != table_count or state.get("hyperplane_count") != hyperplane_count:
        hyperplanes = _make_hyperplanes(seed, table_count, hyperplane_count, dims)
    was_already_present = bool(existing and not existing.get("removed"))
    buckets = state.get("buckets") or [dict() for _ in range(table_count)]
    while len(buckets) < table_count:
        buckets.append({})
    # A first insert has no prior bucket membership.  Avoiding the removal scan
    # is the structural batch-convergence boundary: N independent adds remain
    # O(N × table_count), while revisions/retractions still remove their exact
    # prior representation before publishing the new one.
    if existing:
        _remove_subject_from_buckets(buckets, subject_id)
    for table_index in range(table_count):
        key = _bucket_key(vector, hyperplanes[table_index])
        bucket = buckets[table_index].setdefault(key, [])
        if subject_id not in bucket:
            bucket.append(subject_id)
    # Batch convergence applies many deltas against one owner state. Mutating
    # that in-memory state avoids an O(N²) copy of the flat subject side-map;
    # the durable boundary remains the single atomic state/fact publication.
    state.update({
        "index_id": index_id, "dims": dims, "seed": seed,
        "table_count": table_count, "hyperplane_count": hyperplane_count,
        "params": params, "hyperplanes": hyperplanes, "buckets": buckets,
        "subjects": subjects,
        "vector_count": int(state.get("vector_count", 0)) + (0 if was_already_present else 1),
    })
    subjects[subject_id] = {**metadata, "removed": False}
    return state


def _apply_delete_to_state(state: dict, *, subject_id: str, metadata: dict) -> dict:
    subjects = dict(state.get("subjects") or {})
    existing = subjects.get(subject_id)
    if existing and _is_rejected(existing, metadata, True):
        return state
    buckets = state.get("buckets") or []
    _remove_subject_from_buckets(buckets, subject_id)
    subjects[subject_id] = {**metadata, "removed": True}
    state.update({"buckets": buckets, "subjects": subjects,
                  "vector_count": max(0, int(state.get("vector_count", 0)) - 1)})
    return state


def _apply_plan_with_outcomes(
    state: dict,
    plan: dict,
    vectors: dict,
    params: dict,
    index_id: str,
) -> tuple[dict, int, list[str]]:
    """Pure batch application shared by the CLI and process composition.

    The input state is never mutated.  The returned retraction identities are
    only those whose tombstone transition was accepted, so a stale retract can
    never erase a newer embedding projection at the composition boundary.
    """
    if not isinstance(plan, dict) or not isinstance(vectors, dict):
        raise SystemExit("ann-index apply-plan requires object plan and vectors")
    if not isinstance(state, dict):
        raise SystemExit("ann-index apply-plan requires object state")
    if not isinstance(params, dict):
        raise SystemExit("ann-index apply-plan requires object params")
    state = copy.deepcopy(state)
    mutations = [*(plan.get("upserts") or []), *(plan.get("retracts") or [])]
    if not all(isinstance(item, dict) for item in mutations):
        raise SystemExit("ann-index apply-plan mutations must be objects")
    applied = 0
    accepted_retractions: list[str] = []
    for mutation in mutations:
        mutation_index_id = _required_revision(mutation.get("index_id"), "index_id")
        if mutation_index_id != index_id:
            raise SystemExit("ann-index apply-plan mutation index_id does not match target")
        subject_id = _required_revision(mutation.get("content_address"), "content_address")
        metadata = {
            "canonical_address": _required_revision(mutation.get("canonical_address"), "canonical_address"),
            "revision": require_canonical_multihash(mutation.get("canonical_revision"), "canonical_revision"),
            "payload_hash": require_canonical_multihash(mutation.get("canonical_payload_hash"), "canonical_payload_hash"),
            "source_snapshot_ref": require_canonical_multihash(mutation.get("source_snapshot_ref"), "source_snapshot_ref"),
        }
        if "content_text" in mutation:
            vector = vectors.get(subject_id)
            if not isinstance(vector, list) or not vector:
                raise SystemExit("ann-index apply-plan needs a non-empty numeric vector for every upsert")
            state = _apply_upsert_to_state(state, index_id=index_id, subject_id=subject_id,
                                           metadata=metadata, vector=[float(value) for value in vector], params_in=params)
        else:
            existing = (state.get("subjects") or {}).get(subject_id)
            accepted = not (existing and _is_rejected(existing, metadata, True))
            state = _apply_delete_to_state(state, subject_id=subject_id, metadata=metadata)
            if accepted:
                accepted_retractions.append(subject_id)
        applied += 1
    return state, applied, accepted_retractions


def apply_plan(
    state: dict,
    plan: dict,
    vectors: dict,
    params: dict,
    index_id: str,
) -> tuple[dict, int]:
    """Apply one generic semantic-index delta without filesystem effects.

    This is the package's public computation leaf.  It accepts ordinary JSON
    values and returns the next canonical ANN state plus the submitted mutation
    count; callers retain no representation-specific write logic.
    """
    next_state, mutation_count, _ = _apply_plan_with_outcomes(
        state, plan, vectors, params, index_id
    )
    return next_state, mutation_count


def cmd_apply_plan(args) -> None:
    """Apply generic add/update/retract deltas and publish canonical facts.

    This is the owner-level convergence seam: a planner supplies mutations and
    upstream embedding work supplies vectors by canonical address.  No caller
    constructs `prop:semantic-ann-index:*` state by hand.
    """
    state = _load_json(args.state_json, {}) or {}
    plan = _load_json(args.plan_json, {})
    vectors = _load_json(args.vectors_json, {})
    params = _load_json(args.params_json, {}) or {}
    state, applied = apply_plan(state, plan, vectors, params, args.index_id)
    _write_json(args.output_state_json, state)
    _write_json(args.output_facts_json, _facts_for_state(args.index_id, state))
    if args.output_event_json:
        _write_json(args.output_event_json, {"event": "semantic_index.plan_applied", "index_id": args.index_id,
                                              "mutation_count": applied, "vector_count": int(state.get("vector_count", 0))})


def _already_present(state: dict, subject_id: str) -> bool:
    for table in state.get("buckets") or []:
        for members in table.values():
            if subject_id in members:
                return True
    return False


def cmd_query(args) -> None:
    state = _load_json(args.state_json, {}) or {}
    vector = _load_json(args.vector_json, None)
    params_in = _load_json(args.params_json, {}) or {}
    # Descriptor tuning is mandatory even when an index has no representation
    # yet.  An invalid descriptor must not masquerade as a valid empty result.
    query_dims = len(vector) if isinstance(vector, list) and vector else int(state.get("dims") or 1)
    params = _resolve_params(params_in, query_dims)

    hyperplanes = state.get("hyperplanes")
    buckets = state.get("buckets")
    if not hyperplanes or not buckets or not isinstance(vector, list) or not vector:
        # Fail-closed: absent/empty index -> honest empty candidate set,
        # NEVER a full-corpus fallback.
        _write_json(args.output_candidates_json, [])
        return

    vector = [float(x) for x in vector]
    if len(vector) != state.get("dims"):
        _write_json(args.output_candidates_json, [])
        return

    params = _resolve_params(params_in, len(vector))
    if state.get("params") != params:
        raise SystemExit("ann-index: descriptor ann_params differ from persisted index parameters")
    candidate_limit = int(params["candidate_limit"])

    seen = []
    seen_set = set()
    for t, table in enumerate(buckets):
        key = _bucket_key(vector, hyperplanes[t])
        for subject_id in table.get(key, []):
            if subject_id not in seen_set:
                seen_set.add(subject_id)
                seen.append(subject_id)
            if len(seen) >= candidate_limit:
                break
        if len(seen) >= candidate_limit:
            break

    candidates = []
    for subject_id in seen[:candidate_limit]:
        metadata = (state.get("subjects") or {}).get(subject_id)
        # Legacy unproven entries must not become executable after the T3
        # revision gate is introduced.
        if not isinstance(metadata, dict) or metadata.get("removed"):
            continue
        try:
            require_canonical_multihash(metadata.get("revision"), "indexed revision")
            require_canonical_multihash(metadata.get("payload_hash"), "indexed payload hash")
            require_canonical_multihash(metadata.get("source_snapshot_ref"), "indexed source snapshot")
        except ValueError:
            continue
        candidates.append({"subject_ref": subject_id, **metadata})
    _write_json(args.output_candidates_json, candidates)
    if args.output_event_json:
        _write_json(args.output_event_json, {
            "event": "semantic_index.queried", "descriptor_ref": args.index_id,
            "candidate_count": len(seen), "qualified_count": len(candidates),
            "model_provenance_ref": args.model_provenance_ref or None,
        })


def build_arg_parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument("--mode", required=True, choices=["upsert", "delete", "query", "apply-plan"])
    p.add_argument("--state-json", required=True)
    p.add_argument("--vector-json", default="")
    p.add_argument("--params-json", default="")
    p.add_argument("--index-id", default="")
    p.add_argument("--subject-id", default="")
    p.add_argument("--canonical-address", default="")
    p.add_argument("--revision", default="")
    p.add_argument("--payload-hash", default="")
    p.add_argument("--source-snapshot-ref", default="")
    p.add_argument("--model-provenance-ref", default="")
    p.add_argument("--at", default="")
    p.add_argument("--output-state-json", default="")
    p.add_argument("--output-facts-json", default="")
    p.add_argument("--output-candidates-json", default="")
    p.add_argument("--output-event-json", default="")
    p.add_argument("--plan-json", default="")
    p.add_argument("--vectors-json", default="")
    return p


def main(argv=None) -> int:
    args = build_arg_parser().parse_args(argv)
    if args.mode == "apply-plan":
        if not args.index_id or not args.plan_json or not args.vectors_json or not args.params_json \
                or not args.output_state_json or not args.output_facts_json:
            raise SystemExit("ann-index apply-plan requires --index-id --plan-json --vectors-json --params-json --output-state-json --output-facts-json")
        cmd_apply_plan(args)
    elif args.mode in ("upsert", "delete"):
        if not args.index_id or not args.subject_id or not args.output_state_json or not args.output_facts_json:
            raise SystemExit(f"ann-index {args.mode} requires --index-id --subject-id --output-state-json --output-facts-json")
        if args.mode == "upsert":
            if not args.vector_json or not args.params_json:
                raise SystemExit("ann-index upsert requires --vector-json --params-json")
            cmd_upsert(args)
        else:
            cmd_delete(args)
    else:
        if not args.output_candidates_json or not args.vector_json or not args.params_json:
            raise SystemExit("ann-index query requires --vector-json --params-json --output-candidates-json")
        cmd_query(args)
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except SystemExit:
        raise
    except Exception as exc:  # noqa: BLE001 - top-level CLI boundary, must fail closed with a clear message
        print(f"[meaning-search] error: {exc}", file=sys.stderr)
        raise SystemExit(1)
