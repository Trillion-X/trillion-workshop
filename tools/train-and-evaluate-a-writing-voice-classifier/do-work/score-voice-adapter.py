#!/usr/bin/env python3
"""Score v3 book-voice rows with an isolated local LoRA adapter.

This never calls or changes the shared classifier service. It accepts either
the trainer's JSONL row format or the maintained book-voice v3 challenge JSON,
captures the complete request-shaped state/question/options and option logits,
and refuses any row whose complete composed prompt exceeds 4096 tokens.
"""
from __future__ import annotations

import argparse
import faulthandler
import importlib.util
import json
import math
import os
import re
import shutil
import subprocess
import sys
import tempfile
import time
from pathlib import Path

faulthandler.enable(file=sys.stderr, all_threads=True)
faulthandler.dump_traceback_later(90, repeat=False, file=sys.stderr)

HERE = Path(__file__).resolve().parent
print("phase: importing scorer dependencies", file=sys.stderr, flush=True)
# The decider model frame (common.py, which loads the decider package from its pinned model snapshot) is the caller's:
# --decider-common-dir names the folder that holds it on the computer that trains (the person's setting). A test puts
# stand-ins for common and decider in sys.modules first.
def decider_common_dir(argv):
    for index, word in enumerate(argv):
        if word == "--decider-common-dir" and index + 1 < len(argv):
            return Path(argv[index + 1]).resolve()
        if word.startswith("--decider-common-dir="):
            return Path(word.split("=", 1)[1]).resolve()
    return None


FINETUNE = decider_common_dir(sys.argv)
if FINETUNE is not None:
    sys.path.insert(0, str(FINETUNE))
sys.path.insert(0, str(HERE))
from exposure_audit import audit_exposure  # noqa: E402
import common  # noqa: E402
from decider.infer import Example, Q  # noqa: E402
from decider.systemone import render_question, render_state  # noqa: E402
print("phase: scorer dependencies imported", file=sys.stderr, flush=True)

ROW_SCHEMA = "book-voice-adapter-training-row-v1"
CHALLENGE_SCHEMA = "book-voice-decider-challenge-v3"
BLOCK_KINDS = {"paragraph", "heading", "table", "list", "quote", "mixed"}
STATE_KEYS = {"reference_text", "reader_context", "target_kind", "target_text"}
MAX_ROW_TOKENS = 4096
DEFAULT_DIAGNOSTIC_MIN_PROBABILITY = 0.5
STRICT_REQUEST_PROJECTION_POLICY = "typed-target-and-pinned-reference-v1"
MULTI_CRITERION_PROVENANCE_SCHEMA = "book-voice-training-provenance-v3"
MULTI_CRITERION_REQUEST_PROJECTION_POLICY = "maintained-requestPlan-multi-criterion-per-row-v1"


def validate_challenge_file(path: Path, dataset_role: str, *, raw_bytes: bytes | None = None) -> dict:
    """Run the maintained validator before loading weights; never rewrite splits."""
    node = shutil.which("node")
    validator = HERE.parent / "read-data" / "evaluation-integrity.mjs"
    if not node or not validator.is_file():
        raise ValueError("Maintained challenge validation requires Node and its integrity consumer")
    mode = "unlabeled" if dataset_role == "unlabeled_manuscript_diagnostic" else "scoring-evaluation"
    script = '''
import fs from 'node:fs';
import {pathToFileURL} from 'node:url';
const [modulePath, dataPath, mode] = process.argv.slice(1);
const {validateInput, requestPlan} = await import(pathToFileURL(modulePath).href);
const input = JSON.parse(fs.readFileSync(dataPath, 'utf8'));
const result = validateInput(input, {mode});
const selected = mode === 'unlabeled' ? input.items : result.evalItems;
let requests = 0;
for (const item of selected) requests += Object.keys(requestPlan(input, item).asking).length;
process.stdout.write(JSON.stringify({consumer: 'validateInput + requestPlan', mode,
  items: selected.length, requests}));
'''
    try:
        snapshot_bytes = path.read_bytes() if raw_bytes is None else raw_bytes
        with tempfile.TemporaryDirectory(prefix="copy-gate-validation-") as folder:
            snapshot = Path(folder) / "input.json"
            snapshot.write_bytes(snapshot_bytes)
            snapshot.chmod(0o600)
            result = subprocess.run(
                [node, "--input-type=module", "-e", script, str(validator), str(snapshot), mode],
                capture_output=True, text=True, timeout=15, check=False,
            )
    except (OSError, subprocess.TimeoutExpired) as error:
        raise ValueError("Maintained challenge validation unavailable before model loading") from error
    if result.returncode:
        raise ValueError("Maintained challenge validation rejected DATA before model loading")
    try:
        readback = json.loads(result.stdout)
    except json.JSONDecodeError as error:
        raise ValueError("Maintained challenge validation returned invalid readback") from error
    if (not isinstance(readback, dict) or readback.get("mode") != mode
            or not isinstance(readback.get("items"), int) or readback["items"] < 1
            or not isinstance(readback.get("requests"), int) or readback["requests"] < 1):
        raise ValueError("Maintained challenge validation returned incomplete coverage")
    return readback


def scoring_limit_metadata(data_object: dict, dataset_role: str) -> tuple[dict, dict]:
    """Read optional typed limit metadata without confusing descriptive notes for counts.

    Labeled development DATA may keep human-readable limits as a string list;
    it has no unassessed manuscript blocks, so report empty counts/indices.
    An unlabeled manuscript diagnostic must supply the structured coverage
    dictionaries; only two explicit empty dictionaries mean none are unassessed.
    """
    if not isinstance(data_object, dict):
        raise ValueError("Scoring DATA must be an object")
    if dataset_role == "unlabeled_manuscript_diagnostic":
        if "limits" not in data_object or not isinstance(data_object["limits"], dict):
            raise ValueError("Unlabeled manuscript diagnostic needs object limits with coverage metadata")
        limits = data_object["limits"]
        required = {"unassessed_block_counts", "unassessed_block_indices"}
        missing = required - limits.keys()
        if missing:
            raise ValueError(
                "Unlabeled manuscript diagnostic needs explicit unassessed_block_counts and "
                "unassessed_block_indices metadata"
            )
        counts = limits["unassessed_block_counts"]
        indices = limits["unassessed_block_indices"]
        if not isinstance(counts, dict) or not isinstance(indices, dict):
            raise ValueError("Unlabeled manuscript coverage counts and indices must be objects")
        if counts.keys() != indices.keys():
            raise ValueError("Unlabeled manuscript coverage counts and indices must have matching kind keys")
        unknown_kinds = counts.keys() - BLOCK_KINDS
        if unknown_kinds:
            raise ValueError(f"Unlabeled manuscript coverage has unsupported block kinds: {sorted(unknown_kinds)!r}")
        seen_indices = set()
        for kind, count in counts.items():
            if type(count) is not int or count < 0:
                raise ValueError(f"Unassessed block count for {kind!r} must be a nonnegative integer")
            block_indices = indices[kind]
            if not isinstance(block_indices, list):
                raise ValueError(f"Unassessed block indices for {kind!r} must be a list")
            if any(type(index) is not int or index < 0 for index in block_indices):
                raise ValueError(f"Unassessed block indices for {kind!r} must be nonnegative integers")
            if block_indices != sorted(block_indices) or len(block_indices) != len(set(block_indices)):
                raise ValueError(f"Unassessed block indices for {kind!r} must be sorted and unique")
            if count != len(block_indices):
                raise ValueError(f"Unassessed block count for {kind!r} must match its index list length")
            if seen_indices.intersection(block_indices):
                raise ValueError("Unassessed block indices must be unique across block kinds")
            seen_indices.update(block_indices)
        return counts, indices
    else:
        limits = data_object.get("limits", {})
        if isinstance(limits, list):
            if any(not isinstance(note, str) for note in limits):
                raise ValueError("Descriptive limits must be a list of strings")
            return {}, {}
        if not isinstance(limits, dict):
            raise ValueError("Scoring limits must be an object or a descriptive string list")
    return limits.get("unassessed_block_counts", {}), limits.get("unassessed_block_indices", {})


def digest(path: Path) -> str:
    b3sum = shutil.which("b3sum")
    if not b3sum:
        raise ValueError("Scoring receipt requires the declared BLAKE3 owner")
    try:
        value = subprocess.check_output([b3sum, "--no-names", str(path)], text=True, timeout=120).strip()
    except subprocess.TimeoutExpired as exc:
        raise ValueError(f"Declared BLAKE3 owner timed out hashing {path.name}") from exc
    if len(value) != 64 or any(char not in "0123456789abcdef" for char in value):
        raise ValueError("Could not verify scoring input identity")
    return value


def digests(paths: list[Path]) -> dict[Path, str]:
    """Hash the fixed input identities together in one bounded owner call."""
    b3sum = shutil.which("b3sum")
    if not b3sum:
        raise ValueError("Scoring receipt requires the declared BLAKE3 owner")
    unique = list(dict.fromkeys(paths))
    try:
        completed = subprocess.run(
            [b3sum, "--no-names", *map(str, unique)],
            check=False, capture_output=True, text=True, timeout=120,
        )
    except subprocess.TimeoutExpired as exc:
        raise ValueError("Declared BLAKE3 owner timed out hashing scoring inputs") from exc
    if completed.returncode != 0:
        raise ValueError(f"Declared BLAKE3 owner failed hashing scoring inputs (exit {completed.returncode})")
    values = completed.stdout.splitlines()
    if len(values) != len(unique) or any(re.fullmatch(r"[0-9a-f]{64}", value) is None for value in values):
        raise ValueError("Declared BLAKE3 owner returned malformed or incomplete scoring input hashes")
    return dict(zip(unique, values))


def snapshot_digest(raw: bytes) -> str:
    with tempfile.TemporaryDirectory(prefix="copy-gate-snapshot-") as folder:
        snapshot = Path(folder) / "input"
        snapshot.write_bytes(raw)
        snapshot.chmod(0o600)
        return digest(snapshot)


def question_from_criterion(criterion: dict) -> tuple[str, dict[str, str | None], dict]:
    primitive = criterion.get("primitive", "one-of")
    if primitive != "one-of":
        raise ValueError(f"Unsupported model criterion primitive {primitive!r}; this isolated scorer supports described choice options")
    raw_options = criterion.get("options")
    if not isinstance(raw_options, list) or not 2 <= len(raw_options) <= 10:
        raise ValueError("Each model criterion needs 2 to 10 choice options")
    criteria: dict[str, str | None] = {}
    for option in raw_options:
        if isinstance(option, str) and option:
            criteria[option] = None
        elif isinstance(option, dict) and isinstance(option.get("name"), str) and option["name"]:
            description = option.get("description")
            if description is not None and not isinstance(description, str):
                raise ValueError("Choice descriptions must be text or null")
            criteria[option["name"]] = description
        else:
            raise ValueError("Malformed one-of option")
    if len(criteria) != len(raw_options):
        raise ValueError("Choice options must have unique names")
    question = criterion.get("question")
    if not isinstance(question, str) or not question.strip():
        raise ValueError("Criterion needs a nonempty question")
    return question, criteria, criterion


def diagnostic_minimum(criterion: dict, *, source: str) -> tuple[float, str]:
    """Resolve and validate the criterion's maintained confidence-abstention threshold."""
    if "diagnostic_min_probability" in criterion:
        value = criterion["diagnostic_min_probability"]
        policy_source = source
    else:
        value = DEFAULT_DIAGNOSTIC_MIN_PROBABILITY
        policy_source = "maintained_default_0.5"
    if (isinstance(value, bool) or not isinstance(value, (int, float))
            or not math.isfinite(value) or not 0 <= value <= 1):
        raise ValueError("diagnostic_min_probability must be a finite number from 0 through 1")
    return float(value), policy_source


def jsonl_diagnostic_policy(provenance: dict | None) -> tuple[float, str]:
    """Use a pinned criterion threshold when provenance supplies its source DATA."""
    if not isinstance(provenance, dict):
        return DEFAULT_DIAGNOSTIC_MIN_PROBABILITY, "maintained_default_0.5_unbound_jsonl"
    source_path = provenance.get("source_dataset")
    source_hash = provenance.get("source_dataset_blake3")
    criterion_id = provenance.get("criterion_id")
    if source_path is not None or source_hash is not None:
        if not (isinstance(source_path, str) and isinstance(source_hash, str)
                and re.fullmatch(r"[0-9a-f]{64}", source_hash)
                and isinstance(criterion_id, str)):
            raise ValueError("Criterion threshold source provenance is incomplete")
        path = Path(source_path)
        try:
            raw = path.read_bytes()
        except OSError as exc:
            raise ValueError("Criterion threshold source DATA is unavailable") from exc
        if snapshot_digest(raw) != source_hash:
            raise ValueError("Criterion threshold source DATA changed from provenance")
        source_data = json.loads(raw)
        criteria = source_data.get("criteria") if isinstance(source_data, dict) else None
        matches = [criterion for criterion in criteria or []
                   if isinstance(criterion, dict) and criterion.get("id") == criterion_id]
        if len(matches) != 1:
            raise ValueError("Criterion threshold source DATA does not identify one criterion")
        bound_policy = diagnostic_minimum(matches[0], source="source_dataset_criterion")
        if "diagnostic_min_probability" in provenance:
            explicit_policy = diagnostic_minimum(
                provenance, source="provenance_diagnostic_min_probability")
            if explicit_policy[0] != bound_policy[0]:
                raise ValueError("Explicit diagnostic threshold conflicts with hash-bound source DATA criterion")
        return bound_policy
    if "diagnostic_min_probability" in provenance:
        return diagnostic_minimum(provenance, source="provenance_diagnostic_min_probability")
    return DEFAULT_DIAGNOSTIC_MIN_PROBABILITY, "maintained_default_0.5"


def adapt_v3(data: dict) -> list[dict]:
    if data.get("schema") != CHALLENGE_SCHEMA or not isinstance(data.get("items"), list) or not isinstance(data.get("criteria"), list):
        raise ValueError("Unsupported challenge JSON; expected the maintained typed-target v3 schema")
    output = []
    criteria = data["criteria"]
    for item in data["items"]:
        if item.get("split") not in {"eval", "unlabeled"}:
            raise ValueError("v3 scoring input must contain only eval or unlabeled rows")
        if not isinstance(item.get("id"), str) or not isinstance(item.get("family"), str):
            raise ValueError("v3 scoring rows need stable ids and source-family labels")
        block_kind = item.get("block_kind")
        if block_kind not in BLOCK_KINDS or not isinstance(item.get("text"), str) or not item["text"]:
            raise ValueError(f"Invalid typed target for {item['id']}")
        applicable = [criterion for criterion in criteria if block_kind in criterion.get("applies_to", [])]
        for criterion in applicable:
            if criterion.get("deterministic"):
                continue
            question, options, _ = question_from_criterion(criterion)
            minimum, minimum_source = diagnostic_minimum(criterion, source="maintained_v3_criterion")
            references = {c["id"]: c.get("reference_context", "") for c in applicable
                          if isinstance(c.get("reference_context"), str) and c["reference_context"].strip()}
            unique_references = list(dict.fromkeys(references.values()))
            reference_text: str | dict[str, str] = unique_references[0] if len(unique_references) <= 1 else references
            state = {
                "reference_text": reference_text,
                "reader_context": item.get("reader_context", ""),
                "target_kind": block_kind,
                "target_text": item["text"],
            }
            # Match requestPlan's v3 suffix byte-for-byte: keyed when more than
            # one distinct applicable reference is present, plain otherwise.
            question += " Use reference_text" + ("" if isinstance(reference_text, str) else f".{criterion['id']}") + "."
            gold_checks = item.get("checks") or {}
            output.append({
                "id": item["id"], "family": item["family"], "split": item["split"],
                "criterion_id": criterion["id"], "gold": gold_checks.get(criterion["id"]),
                "criterion_id_source": "maintained_v3_criterion",
                "criterion_binding": "maintained_v3_challenge",
                "state": state, "question": question, "criteria": options,
                "wire_criterion": {"type": "choice", "instructions": question, "criteria": options},
                "diagnostic_min_probability": minimum,
                "diagnostic_min_probability_source": minimum_source,
                "target_kind": block_kind, "block_index": item.get("block_index"),
                "criterion_context_used": bool(criterion.get("reference_context")),
            })
    if not output:
        raise ValueError("No applicable model-backed criteria to score")
    return output


def exposure_from_receipt(receipt: dict, rows: list[dict], target_identity: dict) -> dict:
    """Audit all trained state fields using the receipt's exact source projection.

    This is detectable textual exposure, not a claim of semantic independence.
    Missing provenance is explicitly unassessed; stale declared bytes refuse.
    """
    provenance = receipt.get("provenance") or {}
    source = provenance.get("source_dataset") if isinstance(provenance, dict) else None
    training_rows = []
    reason = "missing_receipt_source_dataset"
    verified = False
    if (isinstance(source, dict) and isinstance(source.get("path"), str)
            and re.fullmatch(r"[0-9a-f]{64}", source.get("blake3", ""))):
        path = Path(source["path"])
        try:
            raw = path.read_bytes()
        except OSError:
            reason = "receipt_source_unreadable"
        else:
            # Hash the bytes actually parsed, not a potentially replaced path.
            actual = snapshot_digest(raw)
            if actual != source["blake3"]:
                raise ValueError("Training exposure source changed from its receipt")
            projected = adapt_v3(json.loads(raw))
            if provenance.get("schema") == MULTI_CRITERION_PROVENANCE_SCHEMA:
                if provenance.get("request_projection_policy") != MULTI_CRITERION_REQUEST_PROJECTION_POLICY:
                    raise ValueError("Training exposure receipt has an unsupported multi-criterion projection policy")
                provenance_path = provenance.get("path")
                provenance_hash = provenance.get("blake3")
                if (not isinstance(provenance_path, str) or not provenance_path.strip()
                        or not isinstance(provenance_hash, str)
                        or re.fullmatch(r"[0-9a-f]{64}", provenance_hash) is None):
                    raise ValueError("Multi-criterion training exposure receipt lacks hash-bound provenance rows")
                try:
                    provenance_raw = Path(provenance_path).read_bytes()
                except OSError as exc:
                    raise ValueError("Multi-criterion training exposure provenance file is unavailable") from exc
                if snapshot_digest(provenance_raw) != provenance_hash:
                    raise ValueError("Multi-criterion training exposure provenance changed from its receipt")
                source_provenance = json.loads(provenance_raw)
                if (not isinstance(source_provenance, dict)
                        or source_provenance.get("schema") != MULTI_CRITERION_PROVENANCE_SCHEMA
                        or source_provenance.get("request_projection_policy")
                        != MULTI_CRITERION_REQUEST_PROJECTION_POLICY
                        or source_provenance.get("source_dataset") != source.get("path")
                        or source_provenance.get("source_dataset_blake3") != source.get("blake3")):
                    raise ValueError("Hash-bound multi-criterion provenance disagrees with its receipt source DATA")
                source_bindings = source_provenance.get("rows")
                training_ids = provenance.get("training_row_ids")
                source_item_ids = provenance.get("source_item_ids")
                criterion_ids = provenance.get("criterion_ids")
                if (not isinstance(source_bindings, list)
                        or not isinstance(training_ids, list) or not isinstance(source_item_ids, list)
                        or not isinstance(criterion_ids, list)
                        or type(receipt.get("rows")) is not int
                        or not (len(training_ids) == len(source_item_ids) == len(criterion_ids)
                                == len(source_bindings) == receipt.get("rows"))
                        or not training_ids
                        or any(not isinstance(value, str) or not value.strip()
                               for value in training_ids + source_item_ids + criterion_ids)
                        or len(training_ids) != len(set(training_ids))
                        or len(set(zip(source_item_ids, criterion_ids))) != len(source_item_ids)):
                    raise ValueError("Multi-criterion training exposure receipt has missing, duplicate, or miscounted bindings")
                bound_training_ids = [binding.get("training_row_id") if isinstance(binding, dict) else None
                                      for binding in source_bindings]
                bound_source_ids = [binding.get("source_item_id") if isinstance(binding, dict) else None
                                    for binding in source_bindings]
                bound_criterion_ids = [binding.get("criterion_id") if isinstance(binding, dict) else None
                                       for binding in source_bindings]
                if (training_ids != bound_training_ids or source_item_ids != bound_source_ids
                        or criterion_ids != bound_criterion_ids):
                    raise ValueError("Multi-criterion receipt bindings are out of order from hash-bound provenance rows")
                bound_families = [binding.get("family") if isinstance(binding, dict) else None
                                  for binding in source_bindings]
                if (any(not isinstance(family, str) or not family.strip() for family in bound_families)
                        or provenance.get("families") != sorted(set(bound_families))
                        or source.get("schema") != MULTI_CRITERION_PROVENANCE_SCHEMA
                        or source.get("training_row_ids") != training_ids
                        or source.get("criterion_ids") != sorted(set(criterion_ids))):
                    raise ValueError("Multi-criterion receipt summary identities do not match its ordered provenance rows")
                projection_index = {}
                for row in projected:
                    key = (row["id"], row["criterion_id"])
                    if key in projection_index:
                        raise ValueError("Hash-bound source DATA has an ambiguous item/criterion projection")
                    projection_index[key] = row
                try:
                    training_rows = [projection_index[(item_id, criterion_id)]
                                     for item_id, criterion_id in zip(source_item_ids, criterion_ids)]
                except KeyError as exc:
                    raise ValueError("Multi-criterion training exposure binding is absent from hash-bound source DATA") from exc
                verified_scope = "Receipt-bound source DATA projected by exact ordered (source_item_id, criterion_id) bindings; source selects only the receipt-declared training subset. Original training JSONL is not reread. No semantic independence or author approval claim."
                reason = "receipt_bound_multi_criterion_v3_source_projection"
            else:
                criterion_id = source.get("criterion_id")
                training_rows = [row for row in projected if row["criterion_id"] == criterion_id]
                if (not isinstance(criterion_id, str) or not training_rows
                        or len(training_rows) != receipt.get("rows")
                        or [row["id"] for row in training_rows] != provenance.get("row_ids")):
                    raise ValueError("Training exposure projection does not match the receipt's rows")
                verified_scope = "Receipt-bound source DATA projected by adapt_v3; original training JSONL is not reread. No semantic independence or author approval claim."
                reason = "receipt_bound_v3_source_projection"
            verified = True
    else:
        verified_scope = "Receipt-bound source DATA projected by adapt_v3; original training JSONL is not reread. No semantic independence or author approval claim."
    result = audit_exposure(training_rows, rows, training_source=source, target_source=target_identity)
    result["source_projection"] = {"status": reason, "source_bytes_verified": verified,
        "scope": verified_scope}
    return result


def adapt_jsonl(data: Path, provenance_path: Path | None, *, raw_text: str | None = None) -> tuple[list[dict], dict | None]:
    provenance = json.loads(provenance_path.read_text(encoding="utf-8")) if provenance_path else None
    if provenance_path and not isinstance(provenance, dict):
        raise ValueError("Provenance must be an object")
    if provenance_path:
        criterion_id = provenance.get("criterion_id")
        if not isinstance(criterion_id, str) or not criterion_id.strip():
            raise ValueError("Provenance must identify a nonempty criterion_id")
        if ("request_projection_policy" in provenance
                and provenance["request_projection_policy"] != STRICT_REQUEST_PROJECTION_POLICY):
            raise ValueError("Unsupported provenance request_projection_policy")
        criterion_id_source = "frozen_provenance"
        criterion_binding = ("strict_frozen_source_projection" if "request_projection_policy" in provenance
                             else "provenance_criterion_id_only")
    else:
        # Historical JSONL inputs without provenance retain their old wire key,
        # explicitly marked as unbound to current policy.
        criterion_id = "spoken-style"
        criterion_id_source = "legacy_default_without_provenance"
        criterion_binding = "unbound_legacy_default"
    diagnostic_minimum_value, diagnostic_minimum_source = jsonl_diagnostic_policy(provenance)
    rows = []
    content = data.read_text(encoding="utf-8") if raw_text is None else raw_text
    for line_number, line in enumerate(content.splitlines(), 1):
        if not line.strip():
            continue
        row = json.loads(line)
        if not isinstance(row, dict) or set(row) != {"schema", "split", "state", "question", "options", "gold"}:
            raise ValueError(f"DATA line {line_number} has unsupported fields")
        if row["schema"] != ROW_SCHEMA or row["split"] not in {"train", "eval", "unlabeled"}:
            raise ValueError(f"DATA line {line_number} has unsupported schema or split")
        state = row["state"]
        if not isinstance(state, dict) or set(state) != STATE_KEYS:
            raise ValueError(f"DATA line {line_number} state must contain exactly the four v3 target fields")
        if state["target_kind"] not in BLOCK_KINDS or not isinstance(state["target_text"], str) or not state["target_text"].strip():
            raise ValueError(f"DATA line {line_number} has an invalid target")
        if not isinstance(state["reader_context"], str):
            raise ValueError(f"DATA line {line_number} has invalid reader_context")
        reference = state["reference_text"]
        if not ((isinstance(reference, str) and reference.strip()) or
                (isinstance(reference, dict) and reference and all(isinstance(k, str) and isinstance(v, str) and v.strip() for k, v in reference.items()))):
            raise ValueError(f"DATA line {line_number} has invalid reference_text")
        if not isinstance(row["question"], str) or not row["question"].strip():
            raise ValueError(f"DATA line {line_number} has an invalid question")
        descriptions = row["options"]
        if not isinstance(descriptions, dict) or not 2 <= len(descriptions) <= 10:
            raise ValueError(f"DATA line {line_number} needs 2 to 10 described options")
        if any(not isinstance(name, str) or not name or not isinstance(value, str) or not value.strip() for name, value in descriptions.items()):
            raise ValueError(f"DATA line {line_number} needs nonempty described options")
        gold = row["gold"]
        if gold is not None and (not isinstance(gold, str) or gold not in descriptions):
            raise ValueError(f"DATA line {line_number} gold must name one option or be null")
        wire_question = render_question({"type": "choice", "instructions": row["question"], "criteria": descriptions})
        rows.append({
            "id": f"row-{line_number}", "family": None, "split": row["split"],
            "criterion_id": criterion_id, "criterion_id_source": criterion_id_source,
            "criterion_binding": criterion_binding, "gold": gold, "state": state,
            "question": wire_question["question"],
                "criteria": descriptions,
            "wire_criterion": {"type": "choice", "instructions": wire_question["question"], "criteria": descriptions},
            "diagnostic_min_probability": diagnostic_minimum_value,
            "diagnostic_min_probability_source": diagnostic_minimum_source,
            "target_kind": state["target_kind"], "block_index": line_number - 1,
            "criterion_context_used": bool(state["reference_text"]),
        })
    if not rows:
        raise ValueError("DATA has no rows")
    if provenance_path:
        source_rows = provenance.get("rows") if isinstance(provenance, dict) else None
        if not isinstance(source_rows, list) or len(source_rows) != len(rows):
            raise ValueError("Provenance must align one-to-one with the JSONL rows")
        for row, source in zip(rows, source_rows):
            if (not isinstance(source, dict)
                    or row["state"]["target_text"] != source.get("text")):
                raise ValueError("Provenance target does not match the corresponding scoring row")
            row["id"], row["family"] = source.get("id", row["id"]), source.get("family")
        if provenance.get("request_projection_policy") == STRICT_REQUEST_PROJECTION_POLICY:
            validate_strict_jsonl_provenance(rows, provenance)
    return rows, provenance


def validate_strict_jsonl_provenance(rows: list[dict], provenance: dict) -> None:
    """Bind strict rows to the same frozen source projection used by training."""
    trainer_path = HERE / "train-voice-adapter.py"
    spec = importlib.util.spec_from_file_location("book_voice_training_source_validator", trainer_path)
    if spec is None or spec.loader is None:
        raise ValueError("Could not load the maintained strict source-projection validator")
    trainer = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(trainer)

    source_rows = provenance.get("rows")
    if not isinstance(source_rows, list) or len(source_rows) != len(rows):
        raise ValueError("Strict provenance must align one-to-one with JSONL rows")
    validator_rows = []
    for index, (row, source) in enumerate(zip(rows, source_rows)):
        if not isinstance(source, dict):
            raise ValueError(f"Strict provenance row {index} must be an object")
        question = render_question({"type": "choice", "instructions": row["question"],
                                    "criteria": row["criteria"]})
        # Unlabeled request rows may still carry source-bound labels in their
        # off-wire provenance. Use that label only to let the strict validator
        # verify the frozen projection; the scorer's gold remains null.
        label = row["gold"] if row["gold"] is not None else source.get("label", source.get("gold"))
        if not isinstance(label, str) or label not in question["names"]:
            raise ValueError(f"Strict provenance row {index} needs a source label in its ordered options")
        gold_index = question["names"].index(label)
        state_text = json.dumps(row["state"], ensure_ascii=False, separators=(",", ":"))
        validator_rows.append((state_text, question, gold_index))
    aligned = trainer.validate_provenance(validator_rows, provenance)
    trainer.validate_source_dataset(provenance, aligned, validator_rows)


def build_adapter_wire(row: dict, state_text: str, question: str) -> dict:
    """Build the request with the criterion key bound by the JSONL adapter."""
    return {
        "state": state_text,
        "model": "decider-v10",
        "questions": {row["criterion_id"]: {
            "type": "choice", "instructions": question,
            "criteria": row["wire_criterion"]["criteria"],
        }},
    }


def _label_counts(items: list[dict], field: str, labels: list[str]) -> dict:
    return {label: sum(item.get(field) == label for item in items) for label in labels}


def _confusion(items: list[dict], prediction_field: str, labels: list[str]) -> dict:
    return {gold: {pred: sum(item.get("gold") == gold and item.get(prediction_field) == pred for item in items)
                   for pred in labels}
            for gold in labels if any(item.get("gold") == gold for item in items)}


def summarize(items: list[dict]) -> dict:
    """Report raw predictions, abstaining decisions, and accepted answers separately."""
    labeled = [item for item in items if isinstance(item.get("gold"), str)]
    binary_labeled = [item for item in items if item.get("gold") in {"pass", "fail"}]
    labels = sorted({value for item in items for value in (item.get("gold"), item.get("predicted"), item.get("decision"))
                     if isinstance(value, str)})
    raw_correct = sum(item.get("predicted") == item.get("gold") for item in labeled)
    decision_matches = sum(item.get("decision") == item.get("gold") for item in labeled)
    accepted_correct = sum(
        item.get("predicted") == item.get("gold")
        and item.get("decision") == item.get("gold")
        and item.get("confidence_abstained") is False
        and item.get("decision_policy_status") == "known"
        for item in labeled
    )
    abstentions = {
        "abstained": sum(item.get("confidence_abstained") is True for item in items),
        "not_abstained": sum(item.get("confidence_abstained") is False for item in items),
        "unknown": sum(item.get("confidence_abstained") is None for item in items),
    }
    raw_counts = _label_counts(items, "predicted", labels)
    decision_counts = _label_counts(items, "decision", labels)
    return {
        "scored_rows": len(items), "labeled_rows": len(labeled),
        "raw_prediction_correct": raw_correct if labeled else None,
        "raw_prediction_accuracy": raw_correct / len(labeled) if labeled else None,
        "raw_prediction_counts": raw_counts,
        "raw_prediction_confusion": _confusion(items, "predicted", labels),
        "binary_labeled_rows": len(binary_labeled),
        "binary_prediction_confusion": {
            gold: {pred: sum(item.get("gold") == gold and item.get("predicted") == pred for item in items)
                   for pred in labels}
            for gold in ("pass", "fail") if any(item.get("gold") == gold for item in items)
        },
        "binary_decision_confusion": {
            gold: {pred: sum(item.get("gold") == gold and item.get("decision") == pred for item in items)
                   for pred in labels}
            for gold in ("pass", "fail") if any(item.get("gold") == gold for item in items)
        },
        # Compatibility field names now describe raw choices, never post-threshold decisions.
        "predicted_counts": raw_counts,
        "confusion": _confusion(items, "predicted", labels),
        "decision_label_matches": decision_matches if labeled else None,
        "decision_label_match_rate": decision_matches / len(labeled) if labeled else None,
        "decision_counts": decision_counts,
        "decision_confusion": _confusion(items, "decision", labels),
        "accepted_correct": accepted_correct if labeled else None,
        "accepted_accuracy": accepted_correct / len(labeled) if labeled else None,
        # Preserve the v1 report keys as conservative aliases. A threshold
        # abstention cannot be counted as a correct answer through these keys.
        "correct": accepted_correct if labeled else None,
        "diagnostic_accuracy": accepted_correct / len(labeled) if labeled else None,
        "confidence_abstention_counts": abstentions,
    }


def apply_decision_policy(predicted: str, probabilities: dict, threshold: float) -> tuple[str, float, bool]:
    """Apply the cutoff using only the predicted option's probability.

    This checks that the selected probability exists and is finite/in range;
    it does not validate every distribution entry or their sum. The actual
    inference path supplies torch.softmax output.
    """
    if not isinstance(probabilities, dict) or predicted not in probabilities:
        raise ValueError("Scored row is missing the predicted option probability")
    peak = probabilities[predicted]
    if isinstance(peak, bool) or not isinstance(peak, (int, float)) or not math.isfinite(peak) or not 0 <= peak <= 1:
        raise ValueError("Predicted option probability must be a finite number from 0 through 1")
    decision = "uncertain" if peak <= threshold else predicted
    return decision, float(peak), peak <= threshold


def resolve_row_indices(value: str | None, row_count: int) -> list[int]:
    """Resolve caller-selected zero-based adapted-row indices with full validation."""
    if type(row_count) is not int or row_count < 0:
        raise ValueError("Adapted row count must be a nonnegative integer")
    if value is None:
        return list(range(row_count))
    parts = value.split(",")
    if any(not part.strip() for part in parts):
        raise ValueError("Row indices must be a nonempty comma-separated list of zero-based integers")
    indices = []
    for part in parts:
        raw = part.strip()
        if not re.fullmatch(r"(?:0|[1-9][0-9]*)", raw):
            raise ValueError("Row indices must be nonnegative decimal integers")
        indices.append(int(raw))
    if len(indices) != len(set(indices)):
        raise ValueError("Row indices must be unique")
    out_of_range = [index for index in indices if index >= row_count]
    if out_of_range:
        raise ValueError(f"Row index {out_of_range[0]} is outside adapted row coverage 0..{row_count - 1}")
    return indices


def batch_slices(count: int, batch_size: int) -> list[tuple[int, int]]:
    """Return contiguous, complete coverage ranges for a positive batch size."""
    if type(count) is not int or count < 0:
        raise ValueError("Comparison row count must be a nonnegative integer")
    if type(batch_size) is not int or batch_size <= 0:
        raise ValueError("Comparison batch size must be a positive integer")
    return [(start, min(start + batch_size, count)) for start in range(0, count, batch_size)]


def _softmax_values(logits: list[float]) -> list[float]:
    if not logits or any(not math.isfinite(value) for value in logits):
        raise ValueError("Comparison logits must be nonempty and finite")
    peak = max(logits)
    exp_values = [math.exp(value - peak) for value in logits]
    total = sum(exp_values)
    return [value / total for value in exp_values]


def compare_row_outputs(row: dict, rowwise_logits: list[float], batched_logits: list[float]) -> dict:
    """Compare one row's logits, probabilities, top choice, and abstaining decision."""
    names = row["option_names"]
    if len(names) != len(rowwise_logits) or len(names) != len(batched_logits):
        raise ValueError("Rowwise and batched logits must cover every option exactly once")
    rowwise = [float(value) for value in rowwise_logits]
    batched = [float(value) for value in batched_logits]
    rowwise_probabilities = _softmax_values([value / row["temperature"] for value in rowwise])
    batched_probabilities = _softmax_values([value / row["temperature"] for value in batched])
    rowwise_index = max(range(len(names)), key=rowwise_probabilities.__getitem__)
    batched_index = max(range(len(names)), key=batched_probabilities.__getitem__)
    rowwise_predicted, batched_predicted = names[rowwise_index], names[batched_index]
    rowwise_decision = apply_decision_policy(
        rowwise_predicted, dict(zip(names, rowwise_probabilities)), row["threshold"]
    )[0]
    batched_decision = apply_decision_policy(
        batched_predicted, dict(zip(names, batched_probabilities)), row["threshold"]
    )[0]
    logit_deltas = [batch - single for single, batch in zip(rowwise, batched)]
    probability_deltas = [batch - single for single, batch in zip(rowwise_probabilities, batched_probabilities)]
    return {
        "rowwise_raw_option_logits": dict(zip(names, rowwise)),
        "batched_raw_option_logits": dict(zip(names, batched)),
        "raw_option_logit_deltas_batch_minus_rowwise": dict(zip(names, logit_deltas)),
        "max_abs_raw_option_logit_delta": max(abs(value) for value in logit_deltas),
        "rowwise_probabilities": dict(zip(names, rowwise_probabilities)),
        "batched_probabilities": dict(zip(names, batched_probabilities)),
        "probability_deltas_batch_minus_rowwise": dict(zip(names, probability_deltas)),
        "max_abs_probability_delta": max(abs(value) for value in probability_deltas),
        "rowwise_predicted": rowwise_predicted,
        "batched_predicted": batched_predicted,
        "prediction_changed": rowwise_predicted != batched_predicted,
        "threshold": row["threshold"],
        "rowwise_decision": rowwise_decision,
        "batched_decision": batched_decision,
        "decision_changed": rowwise_decision != batched_decision,
    }


def require_complete_comparison(selected_indices: list[int], comparisons: list[dict]) -> None:
    """Refuse to publish a parity report unless each selected row appears once."""
    actual = [item.get("row_index") for item in comparisons]
    if actual != selected_indices or len(actual) != len(set(actual)):
        raise ValueError("Batch comparison is incomplete, duplicated, or out of selected-row order")


def run_batch_comparison(model, torch, prepared: list[dict], batch_size: int) -> list[dict]:
    """Run the same eval-mode model rowwise and in caller-sized batches."""
    slices = batch_slices(len(prepared), batch_size)
    rowwise_logits = {}
    with torch.no_grad():
        for prepared_item in prepared:
            batch = common.collate([prepared_item["built"]], model.tok.pad_token_id)
            tensors = {key: value.to(common.DEVICE) if torch.is_tensor(value) else value for key, value in batch.items()}
            logits = model.slot_logits(*[
                tensors[key] for key in ("input_ids", "attention_mask", "slot_idx", "slot_batch", "nopts")
            ]).float()
            count = len(prepared_item["option_names"])
            rowwise_logits[prepared_item["row_index"]] = [float(value) for value in logits[0, :count].cpu().tolist()]
            del batch, tensors, logits

    comparisons = []
    with torch.no_grad():
        for start, end in slices:
            chunk = prepared[start:end]
            batch = common.collate([item["built"] for item in chunk], model.tok.pad_token_id)
            tensors = {key: value.to(common.DEVICE) if torch.is_tensor(value) else value for key, value in batch.items()}
            logits = model.slot_logits(*[
                tensors[key] for key in ("input_ids", "attention_mask", "slot_idx", "slot_batch", "nopts")
            ]).float()
            for local_index, prepared_item in enumerate(chunk):
                row = prepared_item["row"]
                index = prepared_item["row_index"]
                option_count = len(prepared_item["option_names"])
                compared = compare_row_outputs({
                    "option_names": prepared_item["option_names"],
                    "temperature": prepared_item["temperature"],
                    "threshold": row["diagnostic_min_probability"],
                }, rowwise_logits[index], [float(value) for value in logits[local_index, :option_count].cpu().tolist()])
                comparisons.append({
                    "row_index": index,
                    "id": row["id"],
                    "criterion_id": row["criterion_id"],
                    "gold": row.get("gold"),
                    "input_token_count": prepared_item["token_count"],
                    "input_token_ids_blake3": prepared_item["input_token_ids_blake3"],
                    "request_evidence": capture_request_evidence(prepared_item),
                    **compared,
                })
            del batch, tensors, logits
    return comparisons


def hash_input_ids(prepared: list[dict]) -> None:
    """Hash all exact request token-ID payloads in one bounded owner invocation."""
    b3sum = shutil.which("b3sum")
    if not b3sum:
        raise ValueError("Request evidence requires the declared BLAKE3 owner")
    with tempfile.TemporaryDirectory(prefix="book-voice-request-hashes-") as directory:
        paths = []
        for index, item in enumerate(prepared):
            path = Path(directory) / f"row-{index:06d}.json"
            path.write_bytes(json.dumps(item["built"]["ids"]).encode())
            paths.append(path)
        try:
            completed = subprocess.run(
                [b3sum, "--no-names", *map(str, paths)],
                check=False, capture_output=True, text=True, timeout=120,
            )
        except subprocess.TimeoutExpired as exc:
            raise ValueError("Declared BLAKE3 owner timed out hashing request evidence") from exc
        if completed.returncode != 0:
            raise ValueError(f"Declared BLAKE3 owner failed hashing request evidence (exit {completed.returncode})")
        hashes = completed.stdout.splitlines()
        if len(hashes) != len(prepared) or any(re.fullmatch(r"[0-9a-f]{64}", value) is None for value in hashes):
            raise ValueError("Declared BLAKE3 owner returned malformed or incomplete request hashes")
        for item, value in zip(prepared, hashes):
            item["input_token_ids_blake3"] = value


def capture_request_evidence(prepared_item: dict) -> dict:
    """Capture the exact per-row request and prompt built for that row."""
    built = prepared_item["built"]
    return {
        "adapter_input": prepared_item["wire"],
        "input_token_ids": built["ids"],
        "input_token_count": prepared_item["token_count"],
        "input_token_ids_blake3": prepared_item["input_token_ids_blake3"],
        "context_state_keys": list(prepared_item["row"]["state"]),
        "context_state_truncated": False,
        "route": "isolated local adapter; no shared service request",
    }


def write_progress(path: Path, *, dataset_role: str, data_path: Path,
                   expected: int, items: list[dict]) -> None:
    """Atomically write a clearly non-final checkpoint of completed rows."""
    progress = {
        "schema": "book-voice-isolated-adapter-evaluation-progress-v1",
        "status": "in_progress",
        "qualification": "none; incomplete progress only",
        "dataset_role": dataset_role,
        "data": str(data_path),
        "expected_rows": expected,
        "completed_rows": len(items),
        "updated_unix_time": time.time(),
        "items": items,
    }
    temporary = path.with_name(path.name + ".tmp")
    temporary.write_text(json.dumps(progress, ensure_ascii=False) + "\n", encoding="utf-8")
    temporary.replace(path)


def main() -> None:
    os.umask(0o077)
    parser = argparse.ArgumentParser()
    parser.add_argument("--data", required=True, type=Path)
    parser.add_argument("--decider-common-dir", type=Path,
                        help="folder holding the decider model frame common.py (read before this parser runs)")
    parser.add_argument("--adapter", required=True, type=Path)
    parser.add_argument("--out", required=True, type=Path)
    parser.add_argument("--provenance", type=Path)
    parser.add_argument("--dataset-freeze", type=Path, help="optional freeze receipt whose data_blake3 binds this DATA")
    parser.add_argument("--dataset-role", required=True, help="opaque diagnostic role recorded in the report")
    parser.add_argument("--batch", type=int, default=None, help="ordinary scoring batch size (default: 4)")
    parser.add_argument("--compare-batch", type=int,
                        help="compare one-row inference with this batch size using the same loaded eval-mode adapter")
    parser.add_argument("--row-indices",
                        help="optional comma-separated zero-based indices in adapted DATA row order; only with --compare-batch")
    parser.add_argument("--preflight-only", action="store_true",
                        help="validate DATA and receipt-bound exposure without loading model weights")
    args = parser.parse_args()
    print("phase: resolving and validating inputs", file=sys.stderr, flush=True)
    args.data = args.data.resolve(strict=True)
    args.adapter = args.adapter.resolve(strict=True)
    args.out = args.out.resolve()
    if args.provenance:
        args.provenance = args.provenance.resolve(strict=True)
    if args.dataset_freeze:
        args.dataset_freeze = args.dataset_freeze.resolve(strict=True)
    if args.out.exists():
        raise ValueError("Output already exists; choose a new private report path")
    if args.compare_batch is not None and args.batch is not None:
        raise ValueError("Use --compare-batch without --batch for parity comparisons")
    scoring_batch = 4 if args.batch is None else args.batch
    if scoring_batch <= 0:
        raise ValueError("Batch size must be positive")
    if args.compare_batch is not None and args.compare_batch <= 0:
        raise ValueError("Comparison batch size must be positive")
    if args.row_indices is not None and args.compare_batch is None:
        raise ValueError("--row-indices requires --compare-batch")
    # Progress checkpoints are written during inference, before the final report.
    args.out.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    adapter_model = args.adapter / "adapter_model.safetensors"
    receipt_path = args.adapter / "train-info.json"
    if not adapter_model.is_file() or not receipt_path.is_file():
        raise ValueError("Adapter needs adapter_model.safetensors and its train-info.json receipt")
    identity_paths = [adapter_model, receipt_path, args.data]
    consumer_paths = {"scorer": Path(__file__).resolve(),
                      "integrity_validator": HERE.parent / "read-data" / "evaluation-integrity.mjs",
                      "exposure_audit": HERE / "exposure_audit.py"}
    identity_paths.extend(consumer_paths.values())
    if args.dataset_freeze:
        identity_paths.append(args.dataset_freeze)
    if args.provenance:
        identity_paths.append(args.provenance)
    identity_hashes = digests(identity_paths)
    consumer_identities = {name: identity_hashes[path] for name, path in consumer_paths.items()}
    print("phase: fixed input hashes verified", file=sys.stderr, flush=True)
    training_receipt = json.loads(receipt_path.read_text(encoding="utf-8"))
    adapter_hash = identity_hashes[adapter_model]
    if training_receipt.get("adapter_model_blake3") != adapter_hash or training_receipt.get("base_snapshot") != str(common.MODEL):
        raise ValueError("Adapter weights or base model do not match the training receipt")
    data_snapshot = args.data.read_bytes()
    if snapshot_digest(data_snapshot) != identity_hashes[args.data]:
        raise ValueError("Scoring DATA changed before snapshot validation")
    if args.data.suffix.lower() == ".jsonl":
        rows, provenance = adapt_jsonl(args.data, args.provenance, raw_text=data_snapshot.decode("utf-8"))
        input_validation = {"consumer": "adapt_jsonl with provenance", "mode": "jsonl"}
        source_identity = None
        if args.dataset_role == "in_sample_development_diagnostic" and any(row["split"] != "train" for row in rows):
            raise ValueError("In-sample diagnostic requires training rows only")
        if args.dataset_role != "in_sample_development_diagnostic" and any(row["split"] == "train" for row in rows):
            raise ValueError("Evaluation diagnostics cannot consume training-split rows")
    else:
        data_object = json.loads(data_snapshot.decode("utf-8"))
        input_validation = validate_challenge_file(args.data, args.dataset_role, raw_bytes=data_snapshot)
        rows = adapt_v3(data_object)
        freeze = json.loads(args.dataset_freeze.read_text(encoding="utf-8")) if args.dataset_freeze else None
        if freeze is not None and freeze.get("data_blake3") != identity_hashes[args.data]:
            raise ValueError("Dataset freeze receipt does not match DATA")
        source_identity = data_object.get("source_identity")
        if args.dataset_role == "unlabeled_manuscript_diagnostic":
            if not isinstance(source_identity, dict) or not isinstance(source_identity.get("source_blake3"), str):
                raise ValueError("Unlabeled manuscript diagnostic needs a source identity with its frozen BLAKE3 hash")
        unassessed_block_counts, unassessed_block_indices = scoring_limit_metadata(data_object, args.dataset_role)
        provenance = json.loads(args.provenance.read_text(encoding="utf-8")) if args.provenance else None
        if args.dataset_role == "in_sample_development_diagnostic":
            raise ValueError("In-sample diagnostic requires the trainer's JSONL input")
        if args.dataset_role == "unlabeled_manuscript_diagnostic" and any(row["gold"] is not None for row in rows):
            raise ValueError("Unlabeled manuscript diagnostic may not contain gold labels")
        if args.dataset_role != "unlabeled_manuscript_diagnostic" and any(row["gold"] is None for row in rows):
            raise ValueError("Labeled development diagnostic requires gold checks")
    if args.data.suffix.lower() == ".jsonl":
        unassessed_block_counts = {}
        unassessed_block_indices = {}
    if args.dataset_role == "unlabeled_manuscript_diagnostic" and any(row.get("gold") is not None for row in rows):
        raise ValueError("Unlabeled diagnostic received labels")
    selected_indices = resolve_row_indices(args.row_indices, len(rows)) if args.compare_batch is not None else list(range(len(rows)))
    exposure = exposure_from_receipt(training_receipt, rows,
        {"path": str(args.data), "blake3": identity_hashes[args.data]})
    if args.preflight_only:
        report = {
            "schema": "book-voice-isolated-input-preflight-v1",
            "dataset_role": args.dataset_role,
            "route": "isolated-local-input-preflight",
            "qualification": "none; input integrity and detectable exposure only",
            "model_loaded": False, "inference": False,
            "data_blake3": identity_hashes[args.data],
            "adapter_model_blake3": adapter_hash,
            "training_receipt_blake3": identity_hashes[receipt_path],
            "consumer_source_blake3": consumer_identities,
            "input_validation": input_validation,
            "training_exposure": exposure,
            "request_rows": len(rows),
        }
        args.out.write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
        faulthandler.cancel_dump_traceback_later()
        print(json.dumps({"out": str(args.out), "request_rows": len(rows),
                          "model_loaded": False, "inference": False}))
        return

    import torch
    common.quiet()
    print(f"phase: loading adapter and base model for {len(rows)} rows", file=sys.stderr, flush=True)
    model = common.load(adapter=str(args.adapter), train=False)
    model.eval()
    print("phase: adapter and base model loaded", file=sys.stderr, flush=True)
    temperature = common.temperature()
    max_state_tokens, max_row_tokens = 0, 0
    prepared = []
    scoring_rows = [(index, rows[index]) for index in selected_indices] if args.compare_batch is not None else list(enumerate(rows))
    for row_number, (row_index, row) in enumerate(scoring_rows, 1):
        state_text = json.dumps(row["state"], ensure_ascii=False, separators=(",", ":"))
        if render_state(state_text) != state_text:
            raise ValueError(f"State rendering changed for {row['id']}")
        question_spec = {"type": "choice", "instructions": row["question"], "criteria": row["criteria"]}
        rendered = render_question(question_spec)
        option_names, option_texts = rendered["names"], rendered["options"]
        if len(option_names) != len(option_texts) or len(option_texts) < 2:
            raise ValueError(f"Rendered options are incomplete for {row['id']}")
        option_map = dict(row["wire_criterion"]["criteria"])
        if list(option_map) != option_names:
            raise ValueError(f"Wire option order differs from the rendered prompt for {row['id']}")
        context_ids = model.tok.encode("Context:\n" + state_text, add_special_tokens=False)
        max_state_tokens = max(max_state_tokens, len(context_ids))
        if len(context_ids) > MAX_ROW_TOKENS + 1:
            raise ValueError(f"Complete state for {row['id']} exceeds the 4096-token request bound")
        built = common.build(Example(state_text, [Q(rendered["question"], option_texts, 0)]), model.tok,
                             rng=common._Keep(), max_options=common.MAX_OPTIONS, max_ctx_tokens=MAX_ROW_TOKENS + 1)
        if built["ids"][:len(context_ids)] != context_ids:
            raise ValueError(f"Prompt construction truncated the complete state for {row['id']}")
        if built["perms"] != [list(range(len(option_texts)))]:
            raise ValueError(f"Prompt construction changed option order for {row['id']}")
        token_count = len(built["ids"])
        if token_count > MAX_ROW_TOKENS:
            raise ValueError(f"Complete composed request for {row['id']} is {token_count} tokens; limit is {MAX_ROW_TOKENS}")
        max_row_tokens = max(max_row_tokens, token_count)
        wire = build_adapter_wire(row, state_text, rendered["question"])
        prepared.append({
            "row": row, "built": built, "option_names": option_names,
            "wire": wire, "token_count": token_count,
            "state_text": state_text, "row_index": row_index,
            "temperature": temperature,
        })
        if row_number % 100 == 0 or row_number == len(scoring_rows):
            print(f"phase: prepared {row_number}/{len(scoring_rows)} selected rows", file=sys.stderr, flush=True)

    # This evidence is part of every scored item. Hash once in a bounded,
    # batched owner call before inference so a stuck executable cannot leave
    # the full scoring run apparently idle after all model work has completed.
    hash_input_ids(prepared)
    # All blocking initialization and row preparation completed; per-batch
    # atomic checkpoints now provide observable progress without timer dumps.
    faulthandler.cancel_dump_traceback_later()
    print("phase: request token hashes verified", file=sys.stderr, flush=True)

    if args.compare_batch is not None:
        print(f"phase: comparing {len(prepared)} rows at batch size {args.compare_batch}", file=sys.stderr, flush=True)
        comparisons = run_batch_comparison(model, torch, prepared, args.compare_batch)
        require_complete_comparison(selected_indices, comparisons)
        report = {
            "schema": "book-voice-isolated-adapter-batch-comparison-v1",
            "dataset_role": args.dataset_role,
            "route": "isolated-local-MPS-LoRA",
            "qualification": "none; bounded numerical parity diagnostic only",
            "comparison": {
                "baseline": "one request per model call",
                "batched_size": args.compare_batch,
                "model_instance_count": 1,
                "model_eval_mode": True,
                "complete_coverage": True,
                "selected_row_indices_zero_based": selected_indices,
                "selected_row_count": len(selected_indices),
                "dataset_row_count": len(rows),
                "prediction_changes": sum(item["prediction_changed"] for item in comparisons),
                "decision_changes": sum(item["decision_changed"] for item in comparisons),
                "max_abs_raw_option_logit_delta": max(item["max_abs_raw_option_logit_delta"] for item in comparisons),
                "max_abs_probability_delta": max(item["max_abs_probability_delta"] for item in comparisons),
                "numerical_equality_claimed": False,
            },
            "data": str(args.data), "data_blake3": identity_hashes[args.data],
            "adapter_model_blake3": adapter_hash,
            "training_receipt_blake3": identity_hashes[receipt_path],
            "temperature": temperature,
            "consumer_source_blake3": consumer_identities,
            "input_validation": input_validation,
            "training_exposure": exposure,
            "items": comparisons,
        }
        args.out.write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
        print(json.dumps({"out": str(args.out), "selected_rows": len(comparisons),
                          "prediction_changes": report["comparison"]["prediction_changes"],
                          "decision_changes": report["comparison"]["decision_changes"]}, indent=2))
        return

    results = []
    progress_path = args.out.with_suffix(".progress.json")
    for offset in range(0, len(prepared), scoring_batch):
        chunk = prepared[offset:offset + scoring_batch]
        batch = common.collate([item["built"] for item in chunk], model.tok.pad_token_id)
        tensors = {key: value.to(common.DEVICE) if torch.is_tensor(value) else value for key, value in batch.items()}
        with torch.no_grad():
            batch_logits = model.slot_logits(*[tensors[key] for key in ("input_ids", "attention_mask", "slot_idx", "slot_batch", "nopts")]).float()
        for local_index, prepared_item in enumerate(chunk):
            row = prepared_item["row"]
            option_names = prepared_item["option_names"]
            option_count = len(option_names)
            logits = batch_logits[local_index, :option_count]
            probabilities_tensor = torch.softmax(logits / temperature, dim=-1)
            probabilities = [float(value) for value in probabilities_tensor.cpu().tolist()]
            raw_logits = [float(value) for value in logits.cpu().tolist()]
            predicted_index = max(range(len(probabilities)), key=probabilities.__getitem__)
            predicted = option_names[predicted_index]
            peak = probabilities[predicted_index]
            threshold = row["diagnostic_min_probability"]
            decision, peak, confidence_abstained = apply_decision_policy(predicted, dict(zip(option_names, probabilities)), threshold)
            entropy = -sum(p * math.log(p) for p in probabilities if p > 0)
            certainty = max(0.0, 1.0 - entropy / math.log(len(probabilities)))
            state_object = row["state"]
            results.append({
                "id": row["id"], "family": row.get("family"), "split": row["split"],
                "criterion_id": row["criterion_id"], "gold": row.get("gold"),
                "criterion_id_source": row.get("criterion_id_source"),
                "criterion_binding": row.get("criterion_binding"),
                "block_index": row.get("block_index"), "target_kind": row.get("target_kind"),
                "criterion_context_used": row.get("criterion_context_used"),
                "predicted": predicted, "decision": decision, "confidence": peak,
                "diagnostic_min_probability": threshold,
                "diagnostic_min_probability_source": row["diagnostic_min_probability_source"],
                "decision_policy_status": "known",
                "confidence_abstained": confidence_abstained,
                "certainty": certainty,
                "probabilities": dict(zip(option_names, probabilities)),
                "raw_option_logits": dict(zip(option_names, raw_logits)),
                "request_evidence": capture_request_evidence(prepared_item),
            })
        write_progress(progress_path, dataset_role=args.dataset_role,
                       data_path=args.data, expected=len(prepared), items=results)
        print(f"phase: scored {len(results)}/{len(prepared)} rows", file=sys.stderr, flush=True)
        del batch, tensors, batch_logits
    report = {
        "schema": "book-voice-isolated-adapter-evaluation-v1",
        "dataset_role": args.dataset_role,
        "route": "isolated-local-MPS-LoRA",
        "qualification": "none; development diagnostics only",
        "input_validation": input_validation,
        "training_exposure": exposure,
        "model": "decider-v10",
        "base_snapshot": str(common.MODEL),
        "adapter": str(args.adapter),
        "adapter_model_blake3": adapter_hash,
        "training_receipt_blake3": identity_hashes[receipt_path],
        "consumer_source_blake3": consumer_identities,
        "training_data_blake3": training_receipt.get("data_blake3"),
        "data": str(args.data), "data_blake3": identity_hashes[args.data],
        "source_identity": source_identity,
        "dataset_freeze": None if not args.dataset_freeze else {"path": str(args.dataset_freeze), "blake3": identity_hashes[args.dataset_freeze]},
        "dataset_role_identity": None if args.data.suffix.lower() == ".jsonl" else data_object.get("dataset_role"),
        "provenance": None if not args.provenance else {"path": str(args.provenance), "blake3": identity_hashes[args.provenance]},
        "temperature": temperature,
        "context_policy": {"max_composed_tokens": MAX_ROW_TOKENS, "state_truncated": False,
                           "max_state_tokens": max_state_tokens, "max_composed_row_tokens": max_row_tokens},
        "unassessed_block_counts": unassessed_block_counts,
        "unassessed_block_indices": unassessed_block_indices,
        "batch_size": scoring_batch,
        "request_policy": "exact v3 state + short question + described options; fixed option order; 4096-token composed-row limit",
        "decision_policy": {
            "rule": "decision is uncertain when the predicted option probability is less than or equal to diagnostic_min_probability; otherwise decision equals predicted",
            "default_diagnostic_min_probability": DEFAULT_DIAGNOSTIC_MIN_PROBABILITY,
            "criteria": [
                {"criterion_id": criterion_id,
                 "diagnostic_min_probability": row["diagnostic_min_probability"],
                 "source": row["diagnostic_min_probability_source"]}
                for criterion_id, row in sorted({row["criterion_id"]: row for row in rows}.items())
            ],
        },
        "summary": summarize(results),
        "items": results,
    }
    args.out.parent.mkdir(parents=True, exist_ok=True)
    args.out.write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    progress_path.unlink(missing_ok=True)
    faulthandler.cancel_dump_traceback_later()
    print(json.dumps({"out": str(args.out), "dataset_role": args.dataset_role,
                      "items": len(results), "summary": report["summary"],
                      "max_composed_row_tokens": max_row_tokens}, indent=2))


if __name__ == "__main__":
    main()
