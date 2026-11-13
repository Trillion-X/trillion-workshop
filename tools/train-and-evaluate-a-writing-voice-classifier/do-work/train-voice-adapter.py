#!/usr/bin/env python3
"""Train an isolated LoRA adapter from caller-owned v3 state-first training rows.

The input is JSONL. Every row must be labelled `split: train`; the script refuses
evaluation rows. Gold/provenance stay in the DATA row and never enter `state`.
This trainer performs no classifier-service calls and writes only the adapter
and a metadata receipt under the caller-selected output directory.
"""
from __future__ import annotations

import argparse
import base64
import gc
import importlib.util
import json
import math
import os
import random
import re
import shutil
import stat
import subprocess
import sys
import time
from pathlib import Path


HERE = Path(__file__).resolve().parent
# The generic helper is shared with tools/fine-tune-a-small-model-on-a-persons-rules. Model folder, frame, device and
# LoRA targets are configured from the model DATA after CLI parsing; no model-specific common.py is loaded.
def common_dir(argv):
    for index, word in enumerate(argv):
        if word == "--common-dir" and index + 1 < len(argv):
            return Path(argv[index + 1]).resolve()
        if word.startswith("--common-dir="):
            return Path(word.split("=", 1)[1]).resolve()
    return None


COMMON_DIR = common_dir(sys.argv)
if COMMON_DIR is not None:
    sys.path.insert(0, str(COMMON_DIR))
# Tests install a deterministic stand-in in sys.modules. In a real invocation the
# required --common-dir is added and imported by main after argument validation.
common = sys.modules.get("common")
Example = Q = None
_render_question_impl = _render_state_impl = None


def load_renderers():
    """Load the pinned request renderer when DATA is projected or model work begins."""
    global Example, Q, _render_question_impl, _render_state_impl
    if Example is None or Q is None or _render_question_impl is None or _render_state_impl is None:
        from decider.infer import Example as ExampleType, Q as QuestionType
        from decider.systemone import render_question as question_renderer, render_state as state_renderer
        Example, Q = ExampleType, QuestionType
        _render_question_impl, _render_state_impl = question_renderer, state_renderer


def render_question(spec):
    if _render_question_impl is None:
        load_renderers()
    return _render_question_impl(spec)


def render_state(value):
    if _render_state_impl is None:
        load_renderers()
    return _render_state_impl(value)

ROW_SCHEMA = "book-voice-adapter-training-row-v1"
MULTI_CRITERION_ROW_SCHEMA = "book-voice-adapter-training-row-v2"
MULTI_CRITERION_PROVENANCE_SCHEMA = "book-voice-training-provenance-v3"
STRICT_REQUEST_PROJECTION_POLICY = "typed-target-and-pinned-reference-v1"
MULTI_CRITERION_REQUEST_PROJECTION_POLICY = "maintained-requestPlan-multi-criterion-per-row-v1"
BLOCK_KINDS = {"paragraph", "heading", "table", "list", "quote", "mixed"}
STATE_KEYS = {"reference_text", "reader_context", "target_kind", "target_text"}


def digest_bytes(content: bytes) -> str:
    """Hash captured DATA bytes with the declared BLAKE3 owner."""
    b3sum = shutil.which("b3sum")
    if not b3sum:
        raise ValueError("Training receipt requires the declared BLAKE3 owner")
    result = subprocess.run([b3sum, "--no-names"], input=content, capture_output=True, check=False)
    output = result.stdout.decode("ascii", errors="strict").strip().split() if result.returncode == 0 else []
    value = output[0] if output else ""
    if len(value) != 64 or any(char not in "0123456789abcdef" for char in value):
        raise ValueError("Could not verify training DATA identity")
    return value


def digest(path: Path) -> str:
    return digest_bytes(path.read_bytes())


def resolve_verified_model(model_config_path: Path, owner_dir: Path, *, require_dataset_bindings: bool = True) -> tuple[dict, Path]:
    """Resolve the exact model row with the classifier-ready identity owner, without fetching weights."""
    try:
        model_config = json.loads(model_config_path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as error:
        raise ValueError("The model row projection is not valid JSON") from error
    required = {"model", "ready", "frame", "device", "lora_targets", "model_record", "ready_record"}
    dataset_fields = {"dataset_record", "training_data_identity", "provenance_identity", "source_data_identity"}
    expected_fields = required | (dataset_fields if require_dataset_bindings else set())
    if not isinstance(model_config, dict) or not expected_fields.issubset(model_config) \
            or set(model_config) - required - dataset_fields:
        raise ValueError("The model row projection needs exact model and classifier-ready identities")
    if require_dataset_bindings and not dataset_fields.issubset(model_config):
        raise ValueError("The training model projection needs exact dataset record and file identities")
    model = model_config["model"]
    ready = model_config["ready"]
    if not isinstance(model, dict) or model.get("classifier") != "questions-first-decider":
        raise ValueError("The model row must name the questions-first-decider family")
    if not isinstance(ready, dict) or not isinstance(ready.get("identity"), str) \
            or re.fullmatch(r"1f:[0-9a-f]{64}", ready["identity"]) is None \
            or not isinstance(ready.get("files"), list):
        raise ValueError("The model row needs its exact classifier-ready identity and file manifest")
    for field in ("model_record", "ready_record", *(('dataset_record',) if require_dataset_bindings else ())):
        address = model_config[field]
        if not isinstance(address, dict) or set(address) != {"type", "id"} \
                or any(not isinstance(value, str) or not value.strip() for value in address.values()):
            raise ValueError(f"The model projection needs an exact {field} address")
    if require_dataset_bindings:
        for field in ("training_data_identity", "provenance_identity", "source_data_identity"):
            if not isinstance(model_config[field], str) or re.fullmatch(r"1f:[0-9a-f]{64}", model_config[field]) is None:
                raise ValueError(f"The dataset projection needs its exact {field}")
    if not isinstance(model_config["frame"], str) or "{text}" not in model_config["frame"]:
        raise ValueError("The model frame must contain {text}")
    if model_config["device"] not in ("mps", "cuda", "cpu"):
        raise ValueError("The model device must be mps, cuda or cpu")
    targets = model_config["lora_targets"]
    if not isinstance(targets, list) or not targets or any(not isinstance(name, str) or not name.strip() for name in targets) \
            or len(targets) != len(set(targets)):
        raise ValueError("The model row needs unique LoRA target module names")
    files = ready["files"]
    names = []
    for item in files:
        if not isinstance(item, dict) or set(item) != {"name", "bytes", "blake3"}:
            raise ValueError("The ready-file manifest has an unsupported entry")
        name = item["name"]
        if not isinstance(name, str) or not name or name in (".", "..") or "/" in name or "\\" in name \
                or "\x00" in name or name in names:
            raise ValueError("The ready-file manifest has a duplicate or unsafe filename")
        if type(item["bytes"]) is not int or item["bytes"] < 0 \
                or not isinstance(item["blake3"], str) or len(item["blake3"]) != 64 \
                or any(char not in "0123456789abcdef" for char in item["blake3"]):
            raise ValueError("The ready-file manifest needs exact byte counts and BLAKE3 hashes")
        names.append(name)
    if len(names) < 5 or not {"config.json", "decider_config.json", "tokenizer.json", "tokenizer_config.json"}.issubset(names) \
            or not any(name.endswith(".safetensors") for name in names):
        raise ValueError("The ready-file manifest is missing classifier configuration or weights")
    owner_path = owner_dir / "answer_many_states.py"
    spec = importlib.util.spec_from_file_location("voice_classifier_model_owner", owner_path)
    if spec is None or spec.loader is None:
        raise ValueError("The declared classifier model identity owner is unavailable")
    owner = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(owner)
    try:
        folder = Path(owner.model_folder(model, fetch=False)).resolve(strict=True)
        actual_identity, actual_files = owner.identity_of_files(str(folder), names)
    except Exception as error:
        raise ValueError("The exact model row does not resolve to its ready local snapshot") from error
    expected_files = [[item["name"], item["bytes"], item["blake3"]] for item in sorted(files, key=lambda x: x["name"])]
    if actual_identity != ready["identity"] or actual_files != expected_files:
        raise ValueError("The local model files do not match the model row's classifier-ready identity")
    model_config["resolved_base_model"] = str(folder)
    return model_config, folder


def read_stable_source_bytes(path: Path, max_bytes: int = 8 * 1024 * 1024) -> bytes:
    """Read one stable regular source descriptor without following a final symlink or blocking on a FIFO."""
    nofollow = getattr(os, "O_NOFOLLOW", None)
    nonblock = getattr(os, "O_NONBLOCK", None)
    if nofollow is None or nonblock is None:
        raise ValueError("Safe multi-criterion source open is unavailable")
    try:
        before = os.lstat(path)
        if not stat.S_ISREG(before.st_mode) or before.st_size > max_bytes:
            raise ValueError("Multi-criterion source DATA must be a regular file within the 8 MiB read budget")
        descriptor = os.open(path, os.O_RDONLY | nofollow | nonblock)
    except OSError as error:
        raise ValueError("Multi-criterion source DATA could not be opened safely") from error

    def identity(info):
        return (info.st_dev, info.st_ino, info.st_mode, info.st_size, info.st_mtime_ns, info.st_ctime_ns)

    try:
        opened = os.fstat(descriptor)
        if not stat.S_ISREG(opened.st_mode) or identity(opened) != identity(before):
            raise ValueError("Multi-criterion source DATA changed before reading")
        chunks = []
        total = 0
        while True:
            chunk = os.read(descriptor, min(65536, max_bytes + 1 - total))
            if not chunk:
                break
            chunks.append(chunk)
            total += len(chunk)
            if total > max_bytes:
                raise ValueError("Multi-criterion source DATA exceeds the 8 MiB read budget")
        content = b"".join(chunks)
        after_descriptor = os.fstat(descriptor)
        after_path = os.lstat(path)
        if (identity(opened) != identity(after_descriptor) or identity(opened) != identity(after_path)
                or total != opened.st_size):
            raise ValueError("Multi-criterion source DATA changed while reading")
        return content
    except OSError as error:
        raise ValueError("Multi-criterion source DATA could not be read safely") from error
    finally:
        os.close(descriptor)


def load_rows(path: Path, *, raw_bytes: bytes | None = None):
    rows = []
    try:
        text = path.read_text(encoding="utf-8") if raw_bytes is None else raw_bytes.decode("utf-8")
    except UnicodeDecodeError as error:
        raise ValueError("Training DATA is not valid UTF-8") from error
    for line_number, line in enumerate(text.splitlines(), 1):
        if not line.strip():
            continue
        try:
            row = json.loads(line)
        except json.JSONDecodeError as error:
            raise ValueError(f"Invalid JSON on DATA line {line_number}: {error.msg}") from None
        if not isinstance(row, dict):
            raise ValueError(f"DATA line {line_number} has unsupported fields")
        row_schema = row.get("schema")
        expected_fields = {"schema", "split", "state", "question", "options", "gold"}
        if row_schema == MULTI_CRITERION_ROW_SCHEMA:
            expected_fields.add("training_row_id")
            training_row_id = row.get("training_row_id")
            if not isinstance(training_row_id, str) or not training_row_id.strip():
                raise ValueError(f"DATA line {line_number} needs a nonempty training_row_id")
        elif row_schema == ROW_SCHEMA:
            training_row_id = None
        else:
            raise ValueError(f"DATA line {line_number} is not a supported trainer row schema")
        if set(row) != expected_fields:
            raise ValueError(f"DATA line {line_number} has unsupported fields")
        if row["split"] != "train":
            raise ValueError(f"DATA line {line_number} is not a development training row")
        state = row["state"]
        if not isinstance(state, dict) or set(state) != STATE_KEYS:
            raise ValueError(f"DATA line {line_number} state must contain only the exact v3 target fields")
        reference = state["reference_text"]
        if isinstance(reference, str):
            if not reference.strip():
                raise ValueError(f"DATA line {line_number} has empty reference_text")
        elif isinstance(reference, dict):
            if not reference or any(not isinstance(key, str) or not key or not isinstance(value, str) or not value.strip()
                                    for key, value in reference.items()):
                raise ValueError(f"DATA line {line_number} has invalid keyed reference_text")
        else:
            raise ValueError(f"DATA line {line_number} reference_text must be text or a key/value map")
        if not isinstance(state["reader_context"], str):
            raise ValueError(f"DATA line {line_number} reader_context must be text")
        if state["target_kind"] not in BLOCK_KINDS:
            raise ValueError(f"DATA line {line_number} has an unsupported target_kind")
        if not isinstance(state["target_text"], str) or not state["target_text"].strip():
            raise ValueError(f"DATA line {line_number} target_text must be nonempty")
        if not isinstance(row["question"], str) or not row["question"].strip() or "\n" in row["question"] or len(row["question"]) > 240:
            raise ValueError(f"DATA line {line_number} question must be a short, single-line instruction")
        criteria = row["options"]
        if not isinstance(criteria, dict) or not 2 <= len(criteria) <= 10:
            raise ValueError(f"DATA line {line_number} needs 2 to 10 described choice options")
        if any(not isinstance(name, str) or not name or not isinstance(description, str) or not description.strip()
               for name, description in criteria.items()):
            raise ValueError(f"DATA line {line_number} needs nonempty described choice options")
        if not isinstance(row["gold"], str) or row["gold"] not in criteria:
            raise ValueError(f"DATA line {line_number} gold must name one option")
        question = render_question({"type": "choice", "instructions": row["question"], "criteria": criteria})
        if training_row_id is not None:
            # Keep the unique training-row identity alongside the parsed request.
            # It is provenance metadata and is never passed into the model prompt.
            question["_training_row_id"] = training_row_id
        gold = question["names"].index(row["gold"])
        # The v3 evaluator serializes the keyed state with JavaScript
        # JSON.stringify and sends that JSON text as the state string. Keep its
        # compact byte-level layout; rendering a Python dict as a service-side
        # object would add spaces and train on a different prompt.
        state_text = json.dumps(state, ensure_ascii=False, separators=(",", ":"))
        if render_state(state_text) != state_text:
            raise ValueError(f"DATA line {line_number} does not preserve the v3 wire state")
        rows.append((state_text, question, gold))
    if not rows:
        raise ValueError("Training DATA has no rows")
    return rows


def validate_provenance(rows, provenance):
    """Bind each training label to an explicit, source-aligned provenance row."""
    if isinstance(provenance, dict) and provenance.get("schema") == MULTI_CRITERION_PROVENANCE_SCHEMA:
        return validate_multi_criterion_provenance(rows, provenance)
    provenance_rows = provenance.get("rows") if isinstance(provenance, dict) else None
    if not isinstance(provenance_rows, list) or len(provenance_rows) != len(rows):
        raise ValueError("Training provenance must contain one row per DATA row in matching order")
    if any(question.get("_training_row_id") is not None for _state, question, _gold in rows):
        raise ValueError("Multi-criterion training rows require book-voice-training-provenance-v3")
    for index, ((state_text, question, gold), source) in enumerate(zip(rows, provenance_rows)):
        if not isinstance(source, dict):
            raise ValueError(f"Training provenance row {index} must be an object")
        source_id, family, source_text = source.get("id"), source.get("family"), source.get("text")
        if not isinstance(source_id, str) or not source_id.strip():
            raise ValueError(f"Training provenance row {index} needs a nonempty source id")
        if not isinstance(family, str) or not family.strip():
            raise ValueError(f"Training provenance row {index} needs a nonempty source family")
        if not isinstance(source_text, str) or not source_text.strip():
            raise ValueError(f"Training provenance row {index} needs nonempty source text")
        explicit_labels = [source[key] for key in ("label", "gold") if key in source]
        if not explicit_labels or any(not isinstance(label, str) or not label.strip() for label in explicit_labels):
            raise ValueError(f"Training provenance row {index} needs an explicit nonempty label or gold field")
        if len(set(explicit_labels)) != 1:
            raise ValueError(f"Training provenance row {index} has conflicting label and gold fields")
        state = json.loads(state_text)
        expected_label = question["names"][gold]
        if state.get("target_text") != source_text or explicit_labels[0] != expected_label:
            raise ValueError(f"Training provenance row {index} does not match its target and explicit gold label")
    return provenance_rows


def validate_multi_criterion_provenance(rows, provenance):
    """Bind each explicit training row to one exact item/criterion request."""
    required_root = {
        "schema", "source_dataset", "source_dataset_blake3",
        "request_projection_policy", "rows",
    }
    if set(provenance) != required_root:
        raise ValueError("Multi-criterion provenance has unsupported or missing fields")
    if provenance.get("request_projection_policy") != MULTI_CRITERION_REQUEST_PROJECTION_POLICY:
        raise ValueError("Unsupported multi-criterion request_projection_policy")
    provenance_rows = provenance.get("rows")
    if not isinstance(provenance_rows, list) or len(provenance_rows) != len(rows):
        raise ValueError("Multi-criterion provenance must bind every DATA row in matching order")

    required_row = {
        "training_row_id", "source_item_id", "criterion_id", "family", "text",
        "state", "question", "options", "gold_check",
    }
    training_row_ids = set()
    bindings = set()
    for index, ((state_text, question, gold), source) in enumerate(zip(rows, provenance_rows)):
        if not isinstance(source, dict) or set(source) != required_row:
            raise ValueError(f"Multi-criterion provenance row {index} has unsupported or missing binding fields")
        training_row_id = source.get("training_row_id")
        source_item_id = source.get("source_item_id")
        criterion_id = source.get("criterion_id")
        family = source.get("family")
        source_text = source.get("text")
        for label, value in (("training_row_id", training_row_id), ("source item id", source_item_id),
                             ("criterion id", criterion_id), ("source family", family), ("source text", source_text)):
            if not isinstance(value, str) or not value.strip():
                raise ValueError(f"Multi-criterion provenance row {index} needs a nonempty {label}")
        if training_row_id in training_row_ids:
            raise ValueError(f"Duplicate training_row_id: {training_row_id}")
        training_row_ids.add(training_row_id)
        binding = (source_item_id, criterion_id)
        if binding in bindings:
            raise ValueError(f"Duplicate source item/criterion binding: {source_item_id}/{criterion_id}")
        bindings.add(binding)
        if question.get("_training_row_id") != training_row_id:
            raise ValueError(f"Training DATA row {index} training_row_id does not match its provenance binding")

        state = source.get("state")
        if not isinstance(state, dict) or set(state) != STATE_KEYS:
            raise ValueError(f"Multi-criterion provenance row {index} needs the exact v3 target state")
        state_text_from_manifest = json.dumps(state, ensure_ascii=False, separators=(",", ":"))
        if state_text != state_text_from_manifest or json.loads(state_text) != state:
            raise ValueError(f"Multi-criterion provenance row {index} state does not match its training request")
        if state.get("target_text") != source_text:
            raise ValueError(f"Multi-criterion provenance row {index} text does not match its target state")

        if source.get("question") != question.get("question"):
            raise ValueError(f"Multi-criterion provenance row {index} question does not match its training request")
        ordered_options = source.get("options")
        if not isinstance(ordered_options, list) or len(ordered_options) != len(question["names"]):
            raise ValueError(f"Multi-criterion provenance row {index} needs the exact ordered options")
        if any(not isinstance(option, dict) or set(option) != {"name", "description"}
               or not isinstance(option.get("name"), str) or not option["name"]
               or not isinstance(option.get("description"), str) or not option["description"].strip()
               for option in ordered_options):
            raise ValueError(f"Multi-criterion provenance row {index} has malformed ordered options")
        rendered_options = [f"{option['name']}: {option['description']}" for option in ordered_options]
        if ([option["name"] for option in ordered_options] != question["names"]
                or rendered_options != question["options"]):
            raise ValueError(f"Multi-criterion provenance row {index} ordered options do not match its training request")
        expected_gold = question["names"][gold]
        if source.get("gold_check") != expected_gold:
            raise ValueError(f"Multi-criterion provenance row {index} gold_check does not match its explicit source check")
    return provenance_rows


def project_multi_criterion_requests(source_data, provenance_rows, *, mode="training"):
    """Validate and project the same immutable source snapshot through requestPlan for an explicit split mode."""
    if mode not in ("training", "scoring-evaluation"):
        raise ValueError("Source request projection mode must be training or scoring-evaluation")
    node = shutil.which("node")
    validator = HERE.parent / "read-data" / "evaluation-integrity.mjs"
    if not node or not validator.is_file():
        raise ValueError("Multi-criterion provenance requires the maintained requestPlan consumer")
    script = r'''import fs from 'node:fs';
import {pathToFileURL} from 'node:url';
const [modulePath] = process.argv.slice(1);
const {validateInput, requestPlan} = await import(pathToFileURL(modulePath).href);
const payload = JSON.parse(fs.readFileSync(0, 'utf8'));
const inputBytes = Buffer.from(payload.source_dataset_bytes_base64, 'base64');
const input = JSON.parse(inputBytes.toString('utf8'));
const {trainItems, evalItems} = validateInput(input, {mode: MODE});
const selectedItems = MODE === 'training' ? trainItems : evalItems;
const byId = new Map(selectedItems.map(item => [item.id, item]));
const rows = payload.bindings.map(binding => {
  const item = byId.get(binding.source_item_id);
  if (!item) throw new Error(`missing source item ${binding.source_item_id}`);
  const plan = requestPlan(input, item);
  return {item, content: plan.content, request: plan.asking[binding.criterion_id] ?? null};
});
process.stdout.write(JSON.stringify(rows));
'''.replace("MODE", json.dumps(mode))
    bindings = [{"source_item_id": row["source_item_id"], "criterion_id": row["criterion_id"]}
                for row in provenance_rows]
    source_bytes = json.dumps(source_data, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
    payload = {
        "source_dataset_bytes_base64": base64.b64encode(source_bytes).decode("ascii"),
        "bindings": bindings,
    }
    try:
        result = subprocess.run(
            [node, "--input-type=module", "-e", script, str(validator)],
            input=json.dumps(payload, ensure_ascii=False), capture_output=True, text=True,
            timeout=20, check=False,
        )
    except (OSError, subprocess.TimeoutExpired) as error:
        raise ValueError("Maintained multi-criterion requestPlan projection is unavailable") from error
    if result.returncode:
        raise ValueError("Maintained validateInput/requestPlan rejected multi-criterion source projection")
    try:
        projections = json.loads(result.stdout)
    except json.JSONDecodeError as error:
        raise ValueError("Maintained requestPlan returned invalid multi-criterion projection") from error
    if not isinstance(projections, list) or len(projections) != len(provenance_rows):
        raise ValueError("Maintained requestPlan returned incomplete multi-criterion projection")
    return projections


def validate_training_source_splits(source_data, *, mode="training"):
    """Check every source item and family before any split-bound v2 or v3 binding is accepted."""
    if mode not in ("training", "scoring-evaluation"):
        raise ValueError("Source validation mode must be training or scoring-evaluation")
    if not isinstance(source_data, dict) or source_data.get("schema") != "book-voice-decider-challenge-v3":
        raise ValueError("Training source DATA must use maintained challenge schema v3")
    role = source_data.get("dataset_role")
    if mode == "training" and (not isinstance(role, str) or not role.strip()):
        raise ValueError("Training source DATA must declare nonempty dataset_role metadata")
    items = source_data.get("items")
    if not isinstance(items, list) or not items:
        raise ValueError("Training source DATA needs a nonempty item list")
    ids = set()
    family_splits = {}
    selected_count = 0
    for item in items:
        if not isinstance(item, dict):
            raise ValueError("Training source DATA items must be objects")
        item_id, family, split = item.get("id"), item.get("family"), item.get("split")
        if not isinstance(item_id, str) or not item_id.strip() or item_id in ids:
            raise ValueError("Training source DATA item ids must be unique and nonempty")
        if not isinstance(family, str) or not family.strip() or split not in ("train", "eval", "unlabeled"):
            raise ValueError(f"Training source item {item_id} needs a family and explicit split")
        previous = family_splits.get(family)
        if previous is not None and previous != split:
            raise ValueError(f"Source family {family} crosses split boundaries")
        ids.add(item_id)
        family_splits[family] = split
        selected_count += split == ("train" if mode == "training" else "eval")
    if not selected_count:
        raise ValueError(f"Source DATA has no explicitly designated {'train' if mode == 'training' else 'eval'} items")
    return {item["id"]: item for item in items}


def validate_multi_criterion_source_dataset(provenance, provenance_rows, training_rows, *, mode="training"):
    """Verify every row against the maintained per-item, per-criterion requestPlan in the named split."""
    if provenance.get("schema") != MULTI_CRITERION_PROVENANCE_SCHEMA:
        raise ValueError("Multi-criterion provenance must use book-voice-training-provenance-v3")
    if provenance.get("request_projection_policy") != MULTI_CRITERION_REQUEST_PROJECTION_POLICY:
        raise ValueError("Unsupported multi-criterion request_projection_policy")
    source_path = provenance.get("source_dataset")
    source_hash = provenance.get("source_dataset_blake3")
    if (not isinstance(source_path, str) or not source_path.strip()
            or not isinstance(source_hash, str) or len(source_hash) != 64
            or any(char not in "0123456789abcdef" for char in source_hash)):
        raise ValueError("Multi-criterion provenance must identify source DATA by path and BLAKE3")
    source_file = Path(source_path).absolute()
    source_bytes = read_stable_source_bytes(source_file)
    if digest_bytes(source_bytes) != source_hash:
        raise ValueError("Multi-criterion provenance source DATA hash does not match its recorded BLAKE3")
    source_data = json.loads(source_bytes)
    if not isinstance(source_data, dict) or source_data.get("schema") != "book-voice-decider-challenge-v3":
        raise ValueError("Multi-criterion provenance source is not maintained schema-v3 DATA")
    validate_training_source_splits(source_data, mode=mode)
    criteria = source_data.get("criteria")
    source_items = source_data.get("items")
    if not isinstance(criteria, list) or not criteria or not isinstance(source_items, list):
        raise ValueError("Multi-criterion source DATA needs criteria and items lists")

    criteria_by_id = {}
    for criterion in criteria:
        criterion_id = criterion.get("id") if isinstance(criterion, dict) else None
        if (not isinstance(criterion_id, str) or not criterion_id.strip()
                or criterion_id in {"__proto__", "prototype", "constructor"}
                or criterion_id in criteria_by_id):
            raise ValueError("Multi-criterion source DATA needs unique safe criterion ids")
        if criterion.get("primitive", "one-of") != "one-of" or criterion.get("deterministic"):
            raise ValueError(f"Multi-criterion training supports only model-scored one-of criteria: {criterion_id}")
        if not isinstance(criterion.get("question"), str) or not criterion["question"].strip():
            raise ValueError(f"Multi-criterion source criterion needs a question: {criterion_id}")
        if not isinstance(criterion.get("reference_context"), str) or not criterion["reference_context"].strip():
            raise ValueError(f"Multi-criterion source criterion needs pinned reference_context: {criterion_id}")
        applicable = criterion.get("applies_to")
        if (not isinstance(applicable, list) or not applicable
                or any(not isinstance(kind, str) or kind not in BLOCK_KINDS for kind in applicable)
                or len(set(applicable)) != len(applicable)):
            raise ValueError(f"Multi-criterion source criterion needs valid applies_to block kinds: {criterion_id}")
        options = criterion.get("options")
        if not isinstance(options, list) or len(options) < 2:
            raise ValueError(f"Multi-criterion source criterion needs at least two ordered options: {criterion_id}")
        names = []
        for option in options:
            if (not isinstance(option, dict) or set(option) != {"name", "description"}
                    or not isinstance(option.get("name"), str) or not option["name"]
                    or not isinstance(option.get("description"), str) or not option["description"].strip()):
                raise ValueError(f"Multi-criterion source options need ordered names and descriptions: {criterion_id}")
            names.append(option["name"])
        if len(set(names)) != len(names):
            raise ValueError(f"Multi-criterion source option names must be unique: {criterion_id}")
        criteria_by_id[criterion_id] = criterion

    items_by_id = {}
    for item in source_items:
        item_id = item.get("id") if isinstance(item, dict) else None
        if not isinstance(item_id, str) or not item_id.strip() or item_id in items_by_id:
            raise ValueError("Multi-criterion source DATA item ids must be unique and nonempty")
        origin = item.get("origin")
        origin_kind = origin.get("kind") if isinstance(origin, dict) else item.get("source_kind")
        if (not isinstance(item.get("family"), str) or not item["family"].strip()
                or item.get("split") not in ("train", "eval", "unlabeled")
                or not isinstance(item.get("text"), str) or not item["text"].strip()
                or not isinstance(item.get("block_kind"), str) or item["block_kind"] not in BLOCK_KINDS
                or not isinstance(origin_kind, str) or not origin_kind.strip()):
            raise ValueError(f"Multi-criterion source item is incomplete: {item_id}")
        checks = item.get("checks", {})
        if not isinstance(checks, dict):
            raise ValueError(f"Multi-criterion source item checks must be an object: {item_id}")
        for criterion_id, label in checks.items():
            if not isinstance(criterion_id, str) or not isinstance(label, str):
                raise ValueError(f"Multi-criterion source item checks must use string criterion ids and labels: {item_id}")
            criterion = criteria_by_id.get(criterion_id)
            if (criterion is None or item["block_kind"] not in criterion["applies_to"]
                    or label not in [option["name"] for option in criterion["options"]]):
                raise ValueError(f"Multi-criterion source item has a missing, nonapplicable, or invalid check: {item_id}/{criterion_id}")
        items_by_id[item_id] = item

    if not isinstance(training_rows, list) or len(training_rows) != len(provenance_rows):
        raise ValueError("Multi-criterion training DATA and provenance must contain the same number of rows")
    projections = project_multi_criterion_requests(source_data, provenance_rows, mode=mode)
    for index, (source, training_row, projection) in enumerate(zip(provenance_rows, training_rows, projections)):
        item = items_by_id.get(source["source_item_id"])
        criterion = criteria_by_id.get(source["criterion_id"])
        if item is None or criterion is None:
            raise ValueError(f"Multi-criterion binding {index} names a missing source item or criterion")
        if item["block_kind"] not in criterion["applies_to"]:
            raise ValueError(f"Multi-criterion binding {index} selects a nonapplicable criterion")
        checks = item.get("checks", {})
        if source["criterion_id"] not in checks:
            raise ValueError(f"Multi-criterion binding {index} has no source gold check")
        source_gold = checks[source["criterion_id"]]
        if (source.get("family") != item["family"] or source.get("text") != item["text"]
                or source.get("gold_check") != source_gold
                or item.get("split") != ("train" if mode == "training" else "eval")):
            raise ValueError(f"Multi-criterion binding {index} does not match its selected source split, item and gold check")
        request = projection.get("request")
        if (not isinstance(request, dict) or not isinstance(request.get("question"), str)
                or request.get("shape", {}).get("kind") != "one-of"):
            raise ValueError(f"Maintained requestPlan has no choice request for binding {index}")
        expected_options = request["shape"].get("options")
        if (not isinstance(expected_options, list)
                or any(not isinstance(option, dict) or set(option) != {"name", "description"}
                       for option in expected_options)):
            raise ValueError(f"Maintained requestPlan returned unsupported options for binding {index}")
        if (projection.get("content") != training_row[0]
                or projection.get("content") != json.dumps(source["state"], ensure_ascii=False, separators=(",", ":"))
                or request["question"] != training_row[1].get("question")
                or expected_options != source["options"]
                or source_gold not in [option["name"] for option in expected_options]
                or training_row[1]["names"] != [option["name"] for option in expected_options]
                or training_row[1]["options"] != [f"{option['name']}: {option['description']}" for option in expected_options]
                or training_row[1]["names"][training_row[2]] != source_gold):
            raise ValueError(f"Multi-criterion training row {index} does not match maintained requestPlan projection")
    return {
        "path": str(source_file), "blake3": source_hash,
        "schema": MULTI_CRITERION_PROVENANCE_SCHEMA,
        "criterion_ids": sorted({row["criterion_id"] for row in provenance_rows}),
        "training_row_ids": [row["training_row_id"] for row in provenance_rows],
    }


def validate_source_dataset(provenance, provenance_rows, training_rows, *, mode="training"):
    """Verify provenance labels, source identities and the selected split against frozen v3 DATA."""
    if isinstance(provenance, dict) and provenance.get("schema") == MULTI_CRITERION_PROVENANCE_SCHEMA:
        return validate_multi_criterion_source_dataset(provenance, provenance_rows, training_rows, mode=mode)
    if not isinstance(provenance, dict) or provenance.get("schema") != "book-voice-training-provenance-v2":
        raise ValueError("Training provenance must use book-voice-training-provenance-v2")
    has_projection_policy = "request_projection_policy" in provenance
    projection_policy = provenance.get("request_projection_policy")
    if has_projection_policy and projection_policy != STRICT_REQUEST_PROJECTION_POLICY:
        raise ValueError(f"Unsupported training request_projection_policy: {projection_policy!r}")
    strict_request_projection = has_projection_policy
    source_path = provenance.get("source_dataset")
    source_hash = provenance.get("source_dataset_blake3")
    criterion_id = provenance.get("criterion_id")
    if not isinstance(source_path, str) or not source_path.strip() or not isinstance(source_hash, str) or len(source_hash) != 64:
        raise ValueError("Training provenance must identify its source DATA path and BLAKE3 hash")
    if not isinstance(criterion_id, str) or not criterion_id.strip():
        raise ValueError("Training provenance must identify its source criterion")
    source_file = Path(source_path).resolve(strict=True)
    source_bytes = read_stable_source_bytes(source_file)
    if digest_bytes(source_bytes) != source_hash:
        raise ValueError("Training provenance source DATA hash does not match its recorded BLAKE3")
    source_data = json.loads(source_bytes.decode("utf-8"))
    if not isinstance(source_data, dict) or source_data.get("schema") != "book-voice-decider-challenge-v3":
        raise ValueError("Training provenance source is not maintained schema-v3 DATA")
    by_id = validate_training_source_splits(source_data, mode=mode)
    criteria = [item for item in source_data.get("criteria", []) if isinstance(item, dict) and item.get("id") == criterion_id]
    if len(criteria) != 1:
        raise ValueError("Training provenance criterion id must resolve exactly once in source DATA")
    criterion = criteria[0]
    if criterion.get("primitive", "one-of") != "one-of":
        raise ValueError("Training provenance criterion must use a one-of choice projection")
    source_items = source_data.get("items")
    if not isinstance(source_items, list):
        raise ValueError("Training provenance source DATA needs an item list")
    if len(by_id) != len(source_items):
        raise ValueError("Training provenance source DATA item ids must be unique")
    if not isinstance(training_rows, list) or len(training_rows) != len(provenance_rows):
        raise ValueError("Training DATA and provenance must contain the same number of rows")
    criterion_question = criterion.get("question")
    reference = criterion.get("reference_context")
    if not isinstance(criterion_question, str) or not criterion_question.strip():
        raise ValueError("Training provenance criterion needs a nonempty source question")
    if reference is not None and (not isinstance(reference, str) or not reference.strip()):
        raise ValueError("Training provenance criterion has invalid reference_context")
    projected_questions = {criterion_question}
    if reference and not strict_request_projection:
        # Both maintained trainer DATA generations are source-derived: earlier
        # rows retain the criterion wording verbatim, while requestPlan rows
        # append its explicit reference_text routing hint. This compatibility
        # remains limited to provenance that omits request_projection_policy.
        projected_questions.add(criterion_question + " Use reference_text.")
    options = criterion.get("options")
    if not isinstance(options, list) or not options:
        raise ValueError("Training provenance criterion needs an ordered option list")
    option_map = {}
    for option in options:
        if not isinstance(option, dict) or not isinstance(option.get("name"), str) or not option["name"]:
            raise ValueError("Training provenance criterion has malformed ordered options")
        if option["name"] in option_map:
            raise ValueError("Training provenance criterion option names must be unique")
        description = option.get("description")
        if not isinstance(description, str) or not description.strip():
            raise ValueError("Training provenance criterion options need nonempty descriptions")
        option_map[option["name"]] = description
    projected = render_question({"type": "choice", "instructions": criterion_question, "criteria": option_map})
    applicable = criterion.get("applies_to")
    if not isinstance(applicable, list) or not applicable:
        raise ValueError("Training provenance criterion needs explicit v3 block applicability")

    all_criteria = source_data.get("criteria")
    if not isinstance(all_criteria, list):
        raise ValueError("Training provenance source DATA needs a criterion list")
    for index, (source, training_row) in enumerate(zip(provenance_rows, training_rows)):
        item = by_id.get(source["id"])
        if (item is None or item.get("split") != ("train" if mode == "training" else "eval")
                or item.get("family") != source["family"] or item.get("text") != source["text"]
                or (item.get("checks") or {}).get(criterion_id) != source.get("label", source.get("gold"))):
            raise ValueError(f"Training provenance row {index} does not bind to the selected source split and its frozen identity/label")
        state_text, question, gold = training_row
        expected_reference = reference or ""
        expected_question = criterion_question
        if strict_request_projection:
            # Mirror the maintained requestPlan's typed-target projection:
            # gather references for every criterion that applies to this item,
            # then use a keyed reference map only when their texts differ.
            applicable_criteria = [one for one in all_criteria
                                   if isinstance(one, dict) and item.get("block_kind") in one.get("applies_to", [])]
            references = {
                one["id"]: one["reference_context"]
                for one in applicable_criteria
                if isinstance(one.get("id"), str) and isinstance(one.get("reference_context"), str)
                and one["reference_context"].strip()
            }
            unique_references = list(dict.fromkeys(references.values()))
            expected_reference = unique_references[0] if len(unique_references) <= 1 and unique_references else ""
            if len(unique_references) > 1:
                expected_reference = references
            if reference:
                expected_question += " Use reference_text"
                if isinstance(expected_reference, dict):
                    expected_question += f".{criterion_id}"
                expected_question += "."
            projected_questions = {expected_question}
        expected_state = {
            "reference_text": expected_reference,
            "reader_context": item.get("reader_context", ""),
            "target_kind": item.get("block_kind"),
            "target_text": item.get("text"),
        }
        try:
            state = json.loads(state_text)
        except (TypeError, json.JSONDecodeError):
            raise ValueError(f"Training DATA row {index} has an invalid rendered v3 state") from None
        if item.get("block_kind") not in applicable or state != expected_state:
            raise ValueError(f"Training DATA row {index} state does not match its frozen v3 source projection")
        if (question.get("question") not in projected_questions
                or question.get("names") != projected["names"]
                or question.get("options") != projected["options"]):
            raise ValueError(f"Training DATA row {index} question or ordered options do not match its frozen v3 criterion projection")
        expected_gold = projected["names"].index(source.get("label", source.get("gold")))
        if gold != expected_gold:
            raise ValueError(f"Training DATA row {index} gold index does not match its frozen v3 criterion projection")
    return {"path": str(source_file), "blake3": source_hash, "criterion_id": criterion_id}


def summarize_fit_diagnostics(row_specs, logits_by_row):
    """Summarize deterministic logits on the exact supplied rows and option order."""
    if not isinstance(row_specs, list) or not row_specs or len(row_specs) != len(logits_by_row):
        raise ValueError("Fit diagnostics need one logit vector for every training row")
    labels = []
    for spec in row_specs:
        options = spec.get("option_names") if isinstance(spec, dict) else None
        if not isinstance(options, list) or len(options) < 2 or any(not isinstance(name, str) or not name for name in options):
            raise ValueError("Fit diagnostic rows need ordered nonempty option names")
        if len(set(options)) != len(options):
            raise ValueError("Fit diagnostic option names must be unique")
        if spec.get("gold") not in options:
            raise ValueError("Fit diagnostic gold label must name one ordered option")
        labels.extend(name for name in options if name not in labels)

    confusion = {gold: {predicted: 0 for predicted in labels} for gold in labels}
    per_class = {label: {"count": 0, "correct": 0, "accuracy": 0.0} for label in labels}
    entries = []
    cross_entropies = []
    correct = 0
    for spec, values in zip(row_specs, logits_by_row):
        options = spec["option_names"]
        if not isinstance(values, (list, tuple)) or len(values) != len(options):
            raise ValueError("Fit diagnostic logits must match the ordered options")
        logits = [float(value) for value in values]
        if any(not math.isfinite(value) for value in logits):
            raise ValueError("Fit diagnostic valid-option logits must be finite")
        peak = max(logits)
        log_partition = peak + math.log(sum(math.exp(value - peak) for value in logits))
        gold = spec["gold"]
        loss = log_partition - logits[options.index(gold)]
        exp_values = [math.exp(value - peak) for value in logits]
        denominator = sum(exp_values)
        probabilities = [value / denominator for value in exp_values]
        predicted_index = max(range(len(logits)), key=logits.__getitem__)
        predicted = options[predicted_index]
        is_correct = predicted == gold
        correct += int(is_correct)
        cross_entropies.append(loss)
        per_class[gold]["count"] += 1
        per_class[gold]["correct"] += int(is_correct)
        confusion[gold][predicted] += 1
        entry = {
            "id": spec["id"],
            "family": spec.get("family"),
            "gold": gold,
            "predicted": predicted,
            "correct": is_correct,
            "mean_cross_entropy": loss,
            "logits": dict(zip(options, logits)),
            "probabilities": dict(zip(options, probabilities)),
        }
        for field in ("training_row_id", "source_item_id", "criterion_id"):
            if spec.get(field) is not None:
                entry[field] = spec[field]
        entries.append(entry)
    for label, stats in per_class.items():
        stats["accuracy"] = stats["correct"] / stats["count"] if stats["count"] else None
    return {
        "rows": len(entries),
        "correct": correct,
        "accuracy": correct / len(entries),
        "mean_cross_entropy": sum(cross_entropies) / len(cross_entropies),
        "per_class": per_class,
        "confusion": confusion,
        "items": entries,
    }


def provenance_receipt(args, provenance, provenance_rows, source_dataset_identity, model_config):
    if provenance is None:
        return None
    receipt = {
        "identity": model_config["provenance_identity"],
        "dataset_record": model_config["dataset_record"],
        "source_dataset": {
            "identity": model_config["source_data_identity"],
            "blake3": source_dataset_identity["blake3"],
            "schema": provenance.get("schema"),
        },
    }
    if provenance.get("schema") == MULTI_CRITERION_PROVENANCE_SCHEMA:
        receipt.update({
            "schema": MULTI_CRITERION_PROVENANCE_SCHEMA,
            "request_projection_policy": provenance["request_projection_policy"],
            "training_row_ids": [row["training_row_id"] for row in provenance_rows],
            "source_item_ids": [row["source_item_id"] for row in provenance_rows],
            "criterion_ids": [row["criterion_id"] for row in provenance_rows],
            "families": sorted({row["family"] for row in provenance_rows}),
        })
        return receipt
    receipt.update({
        "schema": provenance.get("schema"),
        "criterion_id": source_dataset_identity.get("criterion_id"),
        "row_ids": [row["id"] for row in provenance_rows],
        "families": sorted({row["family"] for row in provenance_rows if isinstance(row, dict)
                             and isinstance(row.get("family"), str)}),
    })
    return receipt


def collect_fit_logits(model, built, batch_size, torch):
    """Evaluate every already-built prompt with dropout disabled and no truncation."""
    if not built or batch_size <= 0:
        raise ValueError("Fit diagnostics need built prompts and a positive batch size")
    model.eval()
    output = []
    with torch.no_grad():
        for offset in range(0, len(built), batch_size):
            chunk = built[offset:offset + batch_size]
            batch = common.collate(chunk, model.tok.pad_token_id)
            tensors = {key: value.to(common.DEVICE) if torch.is_tensor(value) else value for key, value in batch.items()}
            logits = model.slot_logits(*[tensors[key] for key in ("input_ids", "attention_mask", "slot_idx", "slot_batch", "nopts")]).detach().float().cpu()
            if logits.ndim != 2 or logits.shape[1] != common.MAX_OPTIONS:
                raise RuntimeError("Fit diagnostic model returned an invalid slot-logit shape")
            for local_index, item in enumerate(chunk):
                option_count = int(item["nopts"][0])
                valid = logits[local_index, :option_count]
                if (not torch.isfinite(valid).all().item()
                        or not torch.isneginf(logits[local_index, option_count:]).all().item()):
                    raise RuntimeError("Fit diagnostic produced non-finite valid logits or unmasked padding")
                output.append(valid.tolist())
            del batch, tensors, logits
    if len(output) != len(built):
        raise RuntimeError("Fit diagnostic did not return logits for every training prompt")
    return output


def build_argument_parser():
    parser = argparse.ArgumentParser()
    parser.add_argument("--data", required=True, type=Path, help="private JSONL of v3-shaped training rows")
    parser.add_argument("--common-dir", type=Path,
                        help="folder holding the shared generic common.py helper")
    parser.add_argument("--model-config", type=Path, help="private JSON projection of the exact model and ready records")
    parser.add_argument("--model-owner-dir", type=Path, help="folder holding answer_many_states.py, the model identity owner")
    parser.add_argument("--provenance", type=Path, help="optional private row-aligned source provenance JSON")
    parser.add_argument("--source-data", type=Path, help="exact private source DATA file named by the dataset record")
    parser.add_argument("--out", required=True, type=Path, help="new, isolated adapter directory")
    parser.add_argument("--rank", type=int, default=8)
    parser.add_argument("--epochs", type=float, default=1.0)
    parser.add_argument("--lr", type=float, default=1e-4)
    parser.add_argument("--batch", type=int, default=1)
    parser.add_argument("--max-steps", type=int, default=0, help="optional bounded step cap for a local smoke run")
    parser.add_argument("--seed", type=int, default=20261026)
    parser.add_argument("--lora-dropout", type=float, default=0.05,
                        help="LoRA dropout probability (default: 0.05)")
    return parser


def opaque_training_row_id(row_index: int) -> str:
    """Return a log-safe identifier derived only from the JSONL row ordinal."""
    if not isinstance(row_index, int) or isinstance(row_index, bool) or row_index < 0:
        raise ValueError("Training row index must be a nonnegative integer")
    return f"row-{row_index + 1:04d}"


def validate_training_parameters(args):
    if args.rank <= 0 or args.epochs <= 0 or args.lr <= 0 or args.batch <= 0 or args.max_steps < 0:
        raise ValueError("rank, epochs, learning rate, and batch must be positive; max-steps must be nonnegative")
    if not math.isfinite(args.lora_dropout) or not 0.0 <= args.lora_dropout < 1.0:
        raise ValueError("lora-dropout must be finite and in the range [0, 1)")


def validate_training_input_identities(model_config, data_bytes, provenance_bytes, source_data_blake3=None):
    """Bind the exact byte snapshots used by validation to the selected dataset row."""
    if "1f:" + digest_bytes(data_bytes) != model_config["training_data_identity"]:
        raise ValueError("Training DATA does not match the exact dataset record identity")
    if "1f:" + digest_bytes(provenance_bytes) != model_config["provenance_identity"]:
        raise ValueError("Training provenance does not match the exact dataset record identity")
    if source_data_blake3 is not None and "1f:" + source_data_blake3 != model_config["source_data_identity"]:
        raise ValueError("Source DATA does not match the exact dataset record identity")


def main():
    os.umask(0o077)
    parser = build_argument_parser()
    args = parser.parse_args()
    if args.common_dir is None or args.model_config is None or args.model_owner_dir is None or args.provenance is None or args.source_data is None:
        parser.error("--common-dir, --model-config, --model-owner-dir, --provenance and --source-data are required")
    args.common_dir = args.common_dir.resolve(strict=True)
    args.model_config = args.model_config.resolve(strict=True)
    args.model_owner_dir = args.model_owner_dir.resolve(strict=True)
    if common is None:
        sys.path.insert(0, str(args.common_dir))
        import importlib
        globals()["common"] = importlib.import_module("common")
    args.data = args.data.resolve(strict=True)
    args.provenance = args.provenance.resolve(strict=True)
    args.source_data = args.source_data.resolve(strict=True)
    args.out = args.out.resolve()
    if args.out.exists():
        raise ValueError("Output path already exists; choose a new adapter destination")
    validate_training_parameters(args)

    global Example, Q
    model_config, model_folder = resolve_verified_model(args.model_config, args.model_owner_dir)
    # Resolve the pinned renderer before configuring a device or loading weights. The model's package lives in its
    # verified snapshot, which common.configure only adds later, after the DATA and provenance have been checked.
    sys.path.insert(0, str(model_folder))
    load_renderers()
    data_bytes = read_stable_source_bytes(args.data)
    provenance_bytes = read_stable_source_bytes(args.provenance)
    validate_training_input_identities(model_config, data_bytes, provenance_bytes)
    rows = load_rows(args.data, raw_bytes=data_bytes)
    try:
        provenance = json.loads(provenance_bytes.decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError) as error:
        raise ValueError("Training provenance is not valid UTF-8 JSON") from error
    if not isinstance(provenance, dict):
        raise ValueError("Training provenance must be an object")
    # The uploaded provenance bytes stay unchanged and identity-bound. Source DATA is supplied by its own file path.
    provenance_for_source = dict(provenance)
    provenance_for_source["source_dataset"] = str(args.source_data)
    provenance_rows = validate_provenance(rows, provenance)
    source_dataset_identity = validate_source_dataset(provenance_for_source, provenance_rows, rows)
    validate_training_input_identities(model_config, data_bytes, provenance_bytes,
                                       source_dataset_identity["blake3"])

    common.configure(str(model_folder), model_config["frame"], model_config["device"])
    common.LORA_TARGETS = model_config["lora_targets"]
    import torch
    import torch.nn.functional as F
    from peft import LoraConfig, get_peft_model
    if common.DEVICE == "mps" and not torch.backends.mps.is_available():
        raise RuntimeError("The model row selected MPS but this computer does not offer it")
    if common.DEVICE == "cuda" and not torch.cuda.is_available():
        raise RuntimeError("The model row selected CUDA but this computer does not offer it")
    if not common.MODEL.is_dir() or not any(path.is_file() for path in common.MODEL.glob("*.safetensors")):
        raise RuntimeError("The supplied classifier-ready model snapshot has no safetensors weights")
    common.quiet()
    torch.manual_seed(args.seed)
    rng = random.Random(args.seed)
    args.out.mkdir(parents=True, exist_ok=False)

    # Match the live request: JSON state is rendered by Mapika's systemone
    # renderer, and choice criteria become the same described option strings.
    # Load once after validating DATA; build each row against this tokenizer.
    model = common.DecisionModel(str(common.MODEL), dtype=torch.bfloat16, grad_ckpt=False).to(common.DEVICE)
    max_context_tokens = 4097  # match the tokenizer preflight; reject complete composed rows above 4096
    built = []
    state_token_counts = []
    row_token_counts = []
    for state, question, gold in rows:
        context_ids = model.tok.encode("Context:\n" + state, add_special_tokens=False)
        context_token_count = len(context_ids)
        if context_token_count > max_context_tokens:
            raise ValueError(f"A complete v3 state needs {context_token_count} tokens, above the no-truncation limit {max_context_tokens}")
        item = common.build(Example(state, [Q(question["question"], question["options"], gold)]), model.tok,
                            rng=common._Keep(), max_options=common.MAX_OPTIONS, max_ctx_tokens=max_context_tokens)
        if item["ids"][:context_token_count] != context_ids:
            raise RuntimeError("Prompt builder did not preserve the complete state tokens")
        if len(item["ids"]) > 4096:
            raise ValueError(f"Complete v3 request uses {len(item['ids'])} tokens; the shared service limit is 4096")
        if item["perms"] != [list(range(len(question["options"])))] or item["nopts"] != [len(question["options"])]:
            raise RuntimeError("Prompt builder changed the served option order or count")
        built.append(item)
        state_token_counts.append(context_token_count)
        row_token_counts.append(len(item["ids"]))
    peft_model = get_peft_model(model.lm, LoraConfig(
        r=args.rank, lora_alpha=2 * args.rank, lora_dropout=args.lora_dropout,
        target_modules=common.LORA_TARGETS,
    ))
    peft_model.print_trainable_parameters()
    initial_adapter_parameters = {
        name: parameter.detach().cpu().clone()
        for name, parameter in peft_model.named_parameters()
        if parameter.requires_grad
    }
    fit_row_specs = []
    for index, (_state, question, gold_index) in enumerate(rows):
        source = provenance_rows[index] if provenance_rows else {}
        training_row_id = source.get("training_row_id")
        fit_row_specs.append({
            "id": training_row_id or source.get("id", f"row-{index + 1}"),
            "family": source.get("family"),
            "gold": question["names"][gold_index],
            "option_names": list(question["names"]),
            "training_row_id": training_row_id,
            "source_item_id": source.get("source_item_id"),
            "criterion_id": source.get("criterion_id"),
        })
    pre_training_logits = collect_fit_logits(model, built, args.batch, torch)
    pre_training_fit = summarize_fit_diagnostics(fit_row_specs, pre_training_logits)
    del pre_training_logits
    model.train()
    parameters = [parameter for parameter in model.parameters() if parameter.requires_grad]
    if not parameters:
        raise RuntimeError("No LoRA parameters were made trainable")
    optimizer = torch.optim.AdamW(parameters, lr=args.lr, weight_decay=0.0)
    steps_per_epoch = math.ceil(len(built) / args.batch)
    total_steps = max(1, math.ceil(steps_per_epoch * args.epochs))
    if args.max_steps:
        total_steps = min(total_steps, args.max_steps)
    step, losses = 0, []
    elapsed_per_step = []
    per_epoch_losses = []
    started = time.perf_counter()
    for epoch in range(max(1, math.ceil(args.epochs))):
        order = list(range(len(built)))
        rng.shuffle(order)
        epoch_losses = []
        for offset in range(0, len(order), args.batch):
            if step >= total_steps:
                break
            chunk = order[offset:offset + args.batch]
            batch = common.collate([built[index] for index in chunk], model.tok.pad_token_id)
            tensors = {key: value.to(common.DEVICE) if torch.is_tensor(value) else value for key, value in batch.items()}
            tick = time.perf_counter()
            logits = model.slot_logits(*[tensors[key] for key in ("input_ids", "attention_mask", "slot_idx", "slot_batch", "nopts")])
            loss = F.cross_entropy(logits, tensors["golds"])
            optimizer.zero_grad(set_to_none=True)
            loss.backward()
            torch.nn.utils.clip_grad_norm_(parameters, 1.0)
            optimizer.step()
            if common.DEVICE == "mps":
                torch.mps.synchronize()
            duration = time.perf_counter() - tick
            step += 1
            losses.append(float(loss.detach().cpu()))
            epoch_losses.append(losses[-1])
            elapsed_per_step.append(duration)
            row_ids = [opaque_training_row_id(index) for index in chunk]
            print(f"step {step}/{total_steps} row_ids={json.dumps(row_ids)} "
                  f"loss={losses[-1]:.6f} step_seconds={duration:.3f}", flush=True)
        if epoch_losses:
            per_epoch_losses.append({
                "epoch": epoch + 1,
                "steps": len(epoch_losses),
                "mean_loss": sum(epoch_losses) / len(epoch_losses),
            })
        if step >= total_steps:
            break

    changed_parameter_count = 0
    adapter_delta_squared = 0.0
    for name, parameter in peft_model.named_parameters():
        if not parameter.requires_grad:
            continue
        delta = parameter.detach().cpu().float() - initial_adapter_parameters[name].float()
        if torch.count_nonzero(delta).item():
            changed_parameter_count += 1
        adapter_delta_squared += float(torch.sum(delta * delta).item())
    adapter_delta_l2 = math.sqrt(adapter_delta_squared)
    if changed_parameter_count == 0 or adapter_delta_l2 == 0.0:
        raise RuntimeError("Training did not change any LoRA adapter parameters")

    post_training_logits = collect_fit_logits(model, built, args.batch, torch)
    post_training_fit = summarize_fit_diagnostics(fit_row_specs, post_training_logits)
    del post_training_logits

    # Capture the active adapter's deterministic, eval-mode logits before
    # serialization so reload checks verify weight fidelity, not mere loading.
    model.eval()
    pre_save_batch = common.collate([built[0]], model.tok.pad_token_id)
    pre_save_tensors = {key: value.to(common.DEVICE) if torch.is_tensor(value) else value for key, value in pre_save_batch.items()}
    with torch.no_grad():
        pre_save_logits = model.slot_logits(*[pre_save_tensors[key] for key in ("input_ids", "attention_mask", "slot_idx", "slot_batch", "nopts")]).detach().float().cpu()
    pre_save_option_count = int(pre_save_tensors["nopts"][0].item())
    del pre_save_batch, pre_save_tensors

    peft_model.save_pretrained(str(args.out))
    adapter_hash = digest(args.out / "adapter_model.safetensors")
    del optimizer, peft_model, model
    gc.collect()
    if common.DEVICE == "mps":
        torch.mps.empty_cache()
    reloaded = common.load(adapter=str(args.out), train=False)
    reloaded.eval()
    smoke_batch = common.collate([built[0]], reloaded.tok.pad_token_id)
    smoke_tensors = {key: value.to(common.DEVICE) if torch.is_tensor(value) else value for key, value in smoke_batch.items()}
    with torch.no_grad():
        smoke_logits = reloaded.slot_logits(*[smoke_tensors[key] for key in ("input_ids", "attention_mask", "slot_idx", "slot_batch", "nopts")])
    option_count = int(smoke_tensors["nopts"][0].item())
    if (smoke_logits.shape != (1, common.MAX_OPTIONS)
            or not torch.isfinite(smoke_logits[0, :option_count]).all().item()
            or not torch.isneginf(smoke_logits[0, option_count:]).all().item()):
        raise RuntimeError("Reloaded adapter failed the training-row shape/finite-logit smoke check")
    reloaded_logits = smoke_logits.detach().float().cpu()
    reload_logit_max_abs_diff = float((pre_save_logits[:, :option_count] - reloaded_logits[:, :option_count]).abs().max().item())
    if (pre_save_option_count != option_count
            or not torch.allclose(pre_save_logits[:, :option_count], reloaded_logits[:, :option_count], rtol=1e-4, atol=1e-5)):
        raise RuntimeError(f"Reloaded adapter logits differ from pre-save active logits (max abs diff {reload_logit_max_abs_diff})")
    del reloaded, smoke_batch, smoke_tensors, smoke_logits
    del reloaded_logits, pre_save_logits, initial_adapter_parameters
    gc.collect()
    if common.DEVICE == "mps":
        torch.mps.empty_cache()
    receipt = {
        "schema": "book-voice-adapter-training-receipt-v2",
        "model_record": model_config["model_record"],
        "ready_record": model_config["ready_record"],
        "ready_identity": model_config["ready"]["identity"],
        "ready_files": model_config["ready"]["files"],
        "frame": model_config["frame"],
        "data_blake3": digest(args.data),
        "rows": len(rows), "split_policy": "train-only input; no evaluation rows accepted",
        "provenance": provenance_receipt(args, provenance, provenance_rows, source_dataset_identity, model_config),
        "state_renderer": "compact JSON text matching v3 JSON.stringify state",
        "question_renderer": "decider.systemone.render_question",
        "prompt_layout": "decider.prompt.build state_first; compared against the same systemone renderers used by the server",
        "context_policy": "complete state and composed row are checked against the shared 4096-token request limit; no truncation",
        "option_order_policy": "preserve served request order",
        "state_tokens_min": min(state_token_counts), "state_tokens_max": max(state_token_counts),
        "composed_row_tokens_max": max(row_token_counts),
        "device": common.DEVICE, "dtype": "bfloat16", "rank": args.rank,
        "alpha": 2 * args.rank, "dropout": args.lora_dropout,
        "lora_dropout": args.lora_dropout,
        "step_row_id_policy": "opaque-jsonl-ordinal-v1",
        "target_modules": common.LORA_TARGETS,
        "epochs_requested": args.epochs, "learning_rate": args.lr, "batch_size": args.batch,
        "max_steps": args.max_steps or None, "steps_completed": step,
        "loss_initial": losses[0], "loss_final": losses[-1],
        "per_epoch_mean_loss": per_epoch_losses,
        "loss_endpoint_note": "loss_initial and loss_final are individual shuffled minibatch losses, not a monotonic trajectory; compare per_epoch_mean_loss for epoch aggregates.",
        "mean_optimizer_step_seconds": sum(elapsed_per_step) / len(elapsed_per_step),
        "training_seconds": time.perf_counter() - started, "seed": args.seed,
        "adapter_model_blake3": adapter_hash,
        "trainer_source_blake3": digest(Path(__file__).resolve()),
        "adapter_parameter_change": {
            "changed_trainable_parameter_tensors": changed_parameter_count,
            "total_trainable_parameter_tensors": len(parameters),
            "delta_l2_from_initialization": adapter_delta_l2,
        },
        "adapter_reload_check": {
            "row_scope": "first training row only",
            "pre_save_and_reloaded_eval_logits_close": True,
            "max_absolute_logit_difference": reload_logit_max_abs_diff,
            "rtol": 1e-4,
            "atol": 1e-5,
        },
        "in_sample_fit_diagnostic": {
            "scope": "the complete training input, evaluated before and after optimization on the exact built request rows",
            "dropout": "disabled via model.eval() for both snapshots",
            "not_heldout": True,
            "before_training": pre_training_fit,
            "after_training": post_training_fit,
        },
        "assurance": "local optimization, serialization, and load smoke only; no evaluation or qualification",
    }
    (args.out / "train-info.json").write_text(json.dumps(receipt, indent=2) + "\n", encoding="utf-8")
    print(json.dumps(receipt, indent=2), flush=True)


if __name__ == "__main__":
    main()
