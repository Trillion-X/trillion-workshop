"""Enforce a caller-owned writing policy before the managed DOCX CLI exports.

This is coverage/regression enforcement, not semantic or author approval. The
policy contains no executable paths; the adjacent maintained checker is used.
"""
from __future__ import annotations
import json
import os
import re
import shutil
import subprocess
import sys
import uuid
from pathlib import Path
from urllib.parse import urlparse


def _hash(path: Path) -> str:
    executable = shutil.which("b3sum")
    if not executable:
        raise ValueError("Writing policy requires the declared BLAKE3 owner")
    value = subprocess.check_output([executable, "--no-names", str(path)], text=True).strip()
    if len(value) != 64 or any(c not in "0123456789abcdef" for c in value):
        raise ValueError("Writing policy could not verify source identity")
    return value


def _snapshot_hash(data: bytes) -> str:
    executable = shutil.which("b3sum")
    if not executable:
        raise ValueError("Writing policy requires the declared BLAKE3 owner")
    return subprocess.check_output([executable, "--no-names"], input=data).decode("ascii").strip()


def _writing_blocks(text: str) -> list[str]:
    # Match the Workshop's pin-files-by-content/do-work/verify-writing-profile.mjs paragraph coverage boundaries.
    import re
    return [match.group(0).strip() for match in re.finditer(r"\S[\s\S]*?(?=\r?\n[^\S\r\n]*\r?\n|(?![\s\S]))", text)]


def _policy_evidence_path(policy_root: Path, spec: dict, key: str) -> Path:
    value = spec.get(key)
    if not isinstance(value, str) or not value:
        raise ValueError("Invalid Decider2B evidence paths; export remains blocked")
    path = (policy_root / value).resolve(strict=True)
    if not path.is_relative_to(policy_root) or not path.is_file():
        raise ValueError("Decider2B evidence must remain within its policy directory")
    return path


def _load_challenge(path: Path) -> tuple[bytes, dict]:
    data_bytes = path.read_bytes()
    try:
        data = json.loads(data_bytes)
    except json.JSONDecodeError:
        rows = [json.loads(line) for line in data_bytes.decode("utf-8").splitlines() if line.strip()]
        if not rows:
            raise ValueError("empty Decider2B DATA")
        data = rows[0] if len(rows) == 1 and isinstance(rows[0], dict) and isinstance(rows[0].get("items"), list) else {
            **rows[0], "items": rows[1:]
        }
    if not isinstance(data, dict):
        raise ValueError("Decider2B DATA is not an object")
    return data_bytes, data


def _reader_contexts(policy_root: Path, requirements: dict, source_hash: str,
                     blocks: list[str]) -> list[str]:
    """Return exact policy-bound literal context for each manuscript block."""
    binding = requirements.get("reader_context_binding")
    if binding is None:
        return ["\n\n".join(blocks[max(0, index - 2):index])
                for index in range(len(blocks))]
    if (not isinstance(binding, dict) or set(binding) != {"data", "data_blake3"}
            or not isinstance(binding.get("data_blake3"), str)):
        raise ValueError("Invalid policy-pinned reader-context binding; export remains blocked")
    binding_path = _policy_evidence_path(policy_root, binding, "data")
    try:
        raw = binding_path.read_bytes()
        data = json.loads(raw)
    except (OSError, UnicodeError, json.JSONDecodeError):
        raise ValueError("Policy-pinned reader-context binding is missing or invalid; export remains blocked") from None
    if (_snapshot_hash(raw) != binding["data_blake3"]
            or not isinstance(data, dict)
            or data.get("schema") not in {
                "book-reader-context-bindings-v1", "book-reader-context-bindings-v2"}
            or data.get("document_blake3") != source_hash):
        raise ValueError("Reader-context binding hash or current-document identity is invalid; export remains blocked")
    version = data["schema"]
    if version == "book-reader-context-bindings-v2" and set(data) != {"schema", "document_blake3", "items"}:
        raise ValueError("Reader-context v2 binding has unsupported fields; export remains blocked")
    if not isinstance(data.get("items"), list) or len(data["items"]) != len(blocks):
        raise ValueError("Reader-context binding does not cover every current block; export remains blocked")

    by_index: dict[int, list[int]] = {}
    following_by_index: dict[int, list[int]] = {}
    previous_index = -1
    for row in data["items"]:
        if (not isinstance(row, dict) or not {"block_index", "earlier_block_indices"}.issubset(row)
                or isinstance(row.get("block_index"), bool)
                or not isinstance(row.get("block_index"), int)
                or not isinstance(row.get("earlier_block_indices"), list)):
            raise ValueError("Reader-context binding rows are malformed; export remains blocked")
        index = row["block_index"]
        earlier = row["earlier_block_indices"]
        heading_match = re.fullmatch(r"(#{1,6})\s+\S.*", blocks[index].strip()) if 0 <= index < len(blocks) else None
        is_heading = heading_match is not None
        if version == "book-reader-context-bindings-v1":
            if set(row) != {"block_index", "earlier_block_indices"}:
                raise ValueError("Reader-context v1 rows are malformed; export remains blocked")
            following = []
        else:
            expected_keys = {"block_index", "earlier_block_indices"}
            if is_heading:
                expected_keys.add("following_section_block_indices")
            if set(row) != expected_keys:
                raise ValueError("Reader-context v2 following indices are only allowed on heading rows; export remains blocked")
            following = row.get("following_section_block_indices", [])
            if (not isinstance(following, list)
                    or any(isinstance(value, bool) or not isinstance(value, int) for value in following)
                    or following != sorted(set(following))
                    or any(value <= index or value >= len(blocks) for value in following)):
                raise ValueError("Reader-context v2 following indices must be sorted, unique, and strictly after the heading; export remains blocked")
            if is_heading:
                level = len(heading_match.group(1))
                section_end = len(blocks)
                for candidate_index in range(index + 1, len(blocks)):
                    candidate_match = re.fullmatch(r"(#{1,6})\s+\S.*", blocks[candidate_index].strip())
                    if candidate_match and len(candidate_match.group(1)) <= level:
                        section_end = candidate_index
                        break
                if any(value >= section_end for value in following):
                    raise ValueError("Reader-context v2 following indices cross the target heading section; export remains blocked")
        if (index <= previous_index or index < 0 or index >= len(blocks)
                or any(isinstance(value, bool) or not isinstance(value, int) for value in earlier)
                or earlier != sorted(set(earlier))
                or any(value < 0 or value >= max(0, index - 2) for value in earlier)):
            raise ValueError("Reader-context binding chronology, uniqueness, or coverage is invalid; export remains blocked")
        by_index[index] = earlier
        if version == "book-reader-context-bindings-v2" and is_heading:
            following_by_index[index] = following
        previous_index = index
    if set(by_index) != set(range(len(blocks))):
        raise ValueError("Reader-context binding does not cover every current block; export remains blocked")

    contexts = []
    for index in range(len(blocks)):
        if version == "book-reader-context-bindings-v1":
            # Preserve the v1 context contract: selected earlier blocks and
            # the immediate two-block prefix are both passed to the reader.
            immediate = blocks[max(0, index - 2):index]
            earlier = [blocks[value] for value in by_index[index]]
            earlier_text = "\n\n".join(earlier) if earlier else "(none)"
            immediate_text = "\n\n".join(immediate) if immediate else "(none)"
            contexts.append(
                "EARLIER LITERAL READER CONTEXT (oldest first):\n" + earlier_text
                + "\n\nIMMEDIATE PRECEDING TWO LITERAL BLOCKS:\n" + immediate_text
            )
            continue
        immediate = blocks[max(0, index - 2):index]
        earlier = [blocks[value] for value in by_index[index]]
        earlier_text = "\n\n".join(earlier) if earlier else "(none)"
        immediate_text = "\n\n".join(immediate) if immediate else "(none)"
        context = (
            "EARLIER LITERAL READER CONTEXT (oldest first):\n" + earlier_text
            + "\n\nIMMEDIATE PRECEDING TWO LITERAL BLOCKS:\n" + immediate_text
        )
        if index in following_by_index:
            following = [blocks[value] for value in following_by_index[index]]
            following_text = "\n\n".join(following) if following else "(none selected)"
            context += (
                "\n\nSELECTED FOLLOWING SECTION TEXT FOR HEADING REVIEW "
                "(not already-read reader knowledge):\n" + following_text
            )
        contexts.append(context)
    return contexts


def _project_criterion(value: object) -> dict | None:
    if not isinstance(value, dict):
        return None
    projected = {
        "id": value.get("id"),
        "question": value.get("question"),
        "options": value.get("options"),
        "primitive": value.get("primitive", "one-of"),
        "deterministic": bool(value.get("deterministic", False)),
        "diagnostic_min_probability": value.get("diagnostic_min_probability", 0.5),
    }
    # New request inputs are part of the policy, not row-specific hints that
    # may differ between the qualification examples and the actual manuscript.
    for key in ("reference_context", "applies_to", "section_chunk_request"):
        if key in value:
            projected[key] = value[key]
    return projected


def _applicable_ids(criteria: list[dict], item: dict, typed: bool) -> set[str]:
    return {criterion["id"] for criterion in criteria
            if not typed or criterion.get("applies_to") is None
            or item.get("block_kind") in criterion["applies_to"]}


def _validate_section_chunk_qualification(decision: dict, manifest: dict,
                                          options: list[str], threshold: float) -> None:
    chunks = manifest.get("chunks")
    aggregate = decision.get("section_chunk_aggregate")
    results = aggregate.get("chunk_results") if isinstance(aggregate, dict) else None
    if not isinstance(chunks, list) or not isinstance(results, list) or len(results) != len(chunks):
        raise ValueError("Decider2B section qualification omitted a source-bound chunk result; export remains blocked")
    for index, (chunk, result) in enumerate(zip(chunks, results)):
        label = chunk.get("gold") if isinstance(chunk, dict) else None
        if (label not in options or not isinstance(result, dict) or result.get("chunk_index") != index
                or result.get("gold") != label or result.get("predicted") != label
                or result.get("decision") != label):
            raise ValueError("Decider2B missed a policy-labelled section chunk; export remains blocked")
        if label == "uncertain":
            probabilities = result.get("probabilities")
            if not isinstance(probabilities, dict) or probabilities.get("uncertain", -1) <= threshold:
                raise ValueError("Decider2B uncertain section chunk lacks captured probability above its criterion threshold; export remains blocked")


def _validate_decider_capture(node: str, data_path: Path, report_path: Path,
                              data_bytes: bytes, data: dict, report: dict) -> None:
    """Use the maintained evaluator validator for the exact captured DATA/report pair."""
    endpoint = report.get("endpoint")
    parsed_endpoint = urlparse(endpoint) if isinstance(endpoint, str) else None
    expected_request_policy = ("typed-source-bound-section-chunks-v1"
                               if data.get("schema") == "book-voice-decider-challenge-v3"
                               and any(isinstance(value, dict) and value.get("id") == "section-heading-fit"
                                       and value.get("section_chunk_request") for value in data.get("criteria", []))
                               else "typed-target-and-pinned-reference-v1"
                               if data.get("schema") == "book-voice-decider-challenge-v3"
                               else "neutral-passage-and-criterion-context-v1")
    if (report.get("schema") != "book-voice-decider-evaluation-v2"
            or not isinstance(report.get("model"), str) or not report["model"].strip()
            or report.get("route") != "shared local classifier adapter -> /v1/systemone"
            or report.get("request_policy") != expected_request_policy
            or report.get("request_evidence_version") != 1
            or report.get("serving_identity_policy") != "observed-health-and-response-v1"
            or not isinstance(report.get("serving"), str) or not report["serving"].strip()
            or parsed_endpoint is None or parsed_endpoint.scheme != "http"
            or parsed_endpoint.hostname not in ("127.0.0.1", "::1", "localhost")
            or not parsed_endpoint.path.endswith("/v1/systemone")):
        raise ValueError("Decider2B model or serving evidence is unsupported; export remains blocked")
    if report.get("complete") is not True or report.get("errors") != []:
        raise ValueError("Decider2B evidence is incomplete or failed; export remains blocked")

    rubric_path = data_path.parent / "rubric.json"
    rubric_hash = _hash(rubric_path) if data.get("criteria") and rubric_path.is_file() else data.get("rubric_blake3")
    integrity_module = Path(__file__).resolve().parent.parent / "copy-gate" / "evaluate-book-voice-integrity.mjs"
    if not integrity_module.is_file():
        raise ValueError("The maintained Decider2B report validator is unavailable; export remains blocked")
    validator = '''
import { pathToFileURL } from 'node:url';
const [modulePath, dataPath, reportPath, dataBlake3, rubricBlake3] = process.argv.slice(1);
const { validateInput, validateReport } = await import(pathToFileURL(modulePath).href);
const input = JSON.parse(await (await import('node:fs/promises')).readFile(dataPath, 'utf8'));
const report = JSON.parse(await (await import('node:fs/promises')).readFile(reportPath, 'utf8'));
validateInput(input);
validateReport(report, { input, model: report.model, endpoint: report.endpoint, dataPath, dataBlake3, rubricBlake3: rubricBlake3 || null, serving: report.serving, requestPolicy: report.request_policy, requestEvidenceVersion: report.request_evidence_version, servingIdentityPolicy: report.serving_identity_policy }, { requireServing: true });
'''
    command = [node, "--input-type=module", "-e", validator, str(integrity_module), str(data_path),
               str(report_path), _snapshot_hash(data_bytes), rubric_hash or ""]
    result = subprocess.run(command, capture_output=True, text=True)
    if result.returncode != 0:
        raise ValueError("Decider2B report failed the maintained integrity validator; export remains blocked")


def _read_decider_evidence(policy_root: Path, entry: dict, source: Path, source_hash: str, node: str) -> dict:
    """Validate paragraph execution and a separate, policy-pinned qualification benchmark."""
    evidence_spec = entry.get("decider_evidence")
    requirements = entry.get("decider_requirements")
    qualification_spec = entry.get("decider_qualification")
    if not isinstance(evidence_spec, dict) or set(evidence_spec) != {"data", "report"}:
        raise ValueError("Current prose requires declared Decider2B DATA and response evidence; export remains blocked")
    if (not isinstance(requirements, dict) or not isinstance(requirements.get("model"), str)
            or not requirements["model"].strip() or not isinstance(requirements.get("criteria"), list)
            or not requirements["criteria"]):
        raise ValueError("Current prose has no supported Decider2B requirements; export remains blocked")
    qualification_keys = {"data", "report", "data_blake3", "report_blake3", "required_labels"}
    if (not isinstance(qualification_spec, dict)
            or set(qualification_spec) != qualification_keys):
        raise ValueError("Current prose requires policy-pinned Decider2B qualification evidence; export remains blocked")

    current_data_path = _policy_evidence_path(policy_root, evidence_spec, "data")
    current_report_path = _policy_evidence_path(policy_root, evidence_spec, "report")
    qualification_data_path = _policy_evidence_path(policy_root, qualification_spec, "data")
    qualification_report_path = _policy_evidence_path(policy_root, qualification_spec, "report")
    try:
        current_data_bytes, current_data = _load_challenge(current_data_path)
        current_report = json.loads(current_report_path.read_text(encoding="utf-8"))
        qualification_data_bytes, qualification_data = _load_challenge(qualification_data_path)
        qualification_report = json.loads(qualification_report_path.read_text(encoding="utf-8"))
        document_text = source.read_text(encoding="utf-8")
    except (OSError, UnicodeError, json.JSONDecodeError):
        raise ValueError("Decider2B DATA or report is missing or invalid; export remains blocked") from None
    if not isinstance(current_report, dict) or not isinstance(qualification_report, dict):
        raise ValueError("Decider2B report is invalid; export remains blocked")

    expected_criteria = requirements["criteria"]
    if not isinstance(current_data.get("criteria"), list):
        raise ValueError("Decider2B DATA has no supported criteria; export remains blocked")
    expected = []
    for value in expected_criteria:
        if (not isinstance(value, dict) or value.get("primitive", "one-of") != "one-of"
                or value.get("deterministic", False) is not False):
            raise ValueError("Policy declares an unsupported Decider2B criterion; export remains blocked")
        expected.append(_project_criterion(value))
    current_criteria = [_project_criterion(value) for value in current_data["criteria"]]
    qualification_criteria = [_project_criterion(value) for value in qualification_data.get("criteria", [])]
    if (current_criteria != expected or qualification_criteria != expected
            or any(not isinstance(row, dict) for row in current_criteria + qualification_criteria)):
        raise ValueError("Decider2B DATA changed a policy-required question, option, or criterion default; export remains blocked")

    typed = current_data.get("schema") == "book-voice-decider-challenge-v3"
    if typed:
        valid_kinds = {"heading", "paragraph", "quote", "list", "table", "mixed"}
        for criterion in expected_criteria:
            reference = criterion.get("reference_context")
            applies_to = criterion.get("applies_to")
            if (not isinstance(reference, str) or not reference.strip()
                    or not isinstance(applies_to, list) or not applies_to
                    or any(not isinstance(kind, str) or kind not in valid_kinds for kind in applies_to)
                    or len(set(applies_to)) != len(applies_to)):
                raise ValueError("Typed Decider2B policy must pin a nonempty reference and explicit block applicability; export remains blocked")
        if qualification_data.get("schema") != current_data["schema"]:
            raise ValueError("Decider2B qualification changed the typed request schema; export remains blocked")
        if requirements.get("reader_context_blocks") != 2:
            raise ValueError("Typed Decider2B policy must bind the two preceding reader blocks; export remains blocked")
    elif any("reference_context" in value or "applies_to" in value for value in expected_criteria):
        raise ValueError("Decider2B reference or applicability policy requires the typed schema; export remains blocked")
    elif "reader_context_binding" in requirements:
        raise ValueError("Policy-pinned reader context requires the typed Decider2B schema; export remains blocked")

    blocks = _writing_blocks(document_text)
    eval_items = [item for item in current_data.get("items", [])
                  if isinstance(item, dict) and item.get("split") == "eval"]
    if (current_data.get("schema") not in {"book-voice-decider-challenge-v2", "book-voice-decider-challenge-v3"}
            or current_data.get("document_blake3") != source_hash
            or len(current_data.get("items", [])) != len(blocks)
            or [item.get("text") for item in eval_items] != blocks
            or any(item.get("role") != "authored" for item in eval_items)):
        raise ValueError("Decider2B DATA does not bind every exact current paragraph; export remains blocked")
    expected_reader_contexts = _reader_contexts(policy_root, requirements, source_hash, blocks) if typed else []
    if typed and any(item.get("reader_context", "") != expected_reader_contexts[index]
                     for index, item in enumerate(eval_items)):
        raise ValueError("Decider2B reader context does not match the current manuscript prefix; export remains blocked")

    _validate_decider_capture(node, current_data_path, current_report_path,
                              current_data_bytes, current_data, current_report)
    if current_report.get("model") != requirements["model"]:
        raise ValueError("Current Decider2B report does not match its policy-owned model; export remains blocked")
    if not isinstance(current_report.get("items"), list) or len(current_report["items"]) != len(blocks):
        raise ValueError("Decider2B result is incomplete; export remains blocked")
    required_ids = {row["id"] for row in expected_criteria}
    current_rows = {item.get("id"): item for item in current_report["items"] if isinstance(item, dict)}
    if len({item.get("id") for item in eval_items}) != len(blocks) or set(current_rows) != {item.get("id") for item in eval_items}:
        raise ValueError("Decider2B results do not cover every current paragraph; export remains blocked")
    for item in eval_items:
        row = current_rows[item["id"]]
        checks = row.get("checks")
        applicable_ids = _applicable_ids(expected_criteria, item, typed)
        if (not applicable_ids
                or row.get("serving_identity_policy") != "observed-health-and-response-v1"
                or not isinstance(checks, dict) or set(checks) != applicable_ids):
            raise ValueError("Decider2B result is unrun or unsupported; export remains blocked")
        for criterion_id in applicable_ids:
            decision = checks[criterion_id]
            expected_method = ("derived section chunk aggregation" if criterion_id == "section-heading-fit"
                               and any(value.get("id") == criterion_id and value.get("section_chunk_request")
                                       for value in expected_criteria) else "Decider2B shared endpoint")
            if (not isinstance(decision, dict) or decision.get("method") != expected_method
                    or decision.get("decision") != "pass" or decision.get("predicted") != "pass"):
                raise ValueError("Decider2B failed, abstained or returned an unsupported result; export remains blocked")

    options_by_id = {
        criterion["id"]: [option if isinstance(option, str) else option.get("name") if isinstance(option, dict) else None
                           for option in criterion.get("options", [])]
        for criterion in expected_criteria
    }
    required_labels = qualification_spec.get("required_labels")
    if isinstance(required_labels, dict):
        if set(required_labels) != required_ids:
            raise ValueError("Decider2B per-criterion qualification labels must match required criteria; export remains blocked")
        labels_by_id = {}
        for criterion_id, labels in required_labels.items():
            if (not isinstance(labels, list) or len(labels) < 2
                    or any(not isinstance(label, str) or not label for label in labels)
                    or len(set(labels)) != len(labels)
                    or not {"pass", "fail"}.issubset(labels)
                    or set(labels) - {"pass", "fail", "uncertain"}):
                raise ValueError("Each per-criterion qualification label set must uniquely include pass and fail, with only optional uncertain; export remains blocked")
            if any(label not in options_by_id[criterion_id] for label in labels):
                raise ValueError("Per-criterion qualification labels must be answer options for their criterion; export remains blocked")
            labels_by_id[criterion_id] = labels
    else:
        # Preserve the existing list form as the legacy policy contract. Its
        # single set must still apply to every criterion and cannot include an
        # abstention label.
        if (not isinstance(required_labels, list) or len(required_labels) < 2
                or len(set(required_labels)) != len(required_labels)
                or any(not isinstance(label, str) or not label or label == "uncertain" for label in required_labels)):
            raise ValueError("Decider2B qualification must declare unique required labels; export remains blocked")
        if any(label not in options_by_id[criterion_id]
               for criterion_id in required_ids for label in required_labels):
            raise ValueError("Decider2B qualification labels must be answer options for every required criterion; export remains blocked")
        labels_by_id = {criterion_id: required_labels for criterion_id in required_ids}
    qualification_items = [item for item in qualification_data.get("items", [])
                           if isinstance(item, dict) and item.get("split") == "eval"]
    if (qualification_data.get("schema") not in {"book-voice-decider-challenge-v2", "book-voice-decider-challenge-v3"}
            or not qualification_items):
        raise ValueError("Decider2B qualification DATA must contain labelled evaluation items; export remains blocked")
    seen_labels = {criterion_id: set() for criterion_id in required_ids}
    for item in qualification_items:
        checks = item.get("checks")
        applicable_ids = _applicable_ids(expected_criteria, item, typed)
        if not applicable_ids or not isinstance(checks, dict) or set(checks) != applicable_ids:
            raise ValueError("Decider2B qualification omitted required labels; export remains blocked")
        for criterion_id, label in checks.items():
            if label not in labels_by_id[criterion_id]:
                raise ValueError("Decider2B qualification contains an undeclared expected label; export remains blocked")
            seen_labels[criterion_id].add(label)
    if any(not set(labels_by_id[criterion_id]).issubset(seen_labels[criterion_id])
           for criterion_id in required_ids):
        raise ValueError("Decider2B qualification omitted a policy-required expected label; export remains blocked")

    expected_data_hash = qualification_spec.get("data_blake3")
    expected_report_hash = qualification_spec.get("report_blake3")
    if (not isinstance(expected_data_hash, str) or _snapshot_hash(qualification_data_bytes) != expected_data_hash
            or not isinstance(expected_report_hash, str) or _hash(qualification_report_path) != expected_report_hash):
        raise ValueError("Decider2B qualification DATA/report hash does not match policy; export remains blocked")
    _validate_decider_capture(node, qualification_data_path, qualification_report_path,
                              qualification_data_bytes, qualification_data, qualification_report)
    if (qualification_report.get("model") != requirements["model"]
            or qualification_report.get("serving") != current_report.get("serving")
            or qualification_report.get("endpoint") != current_report.get("endpoint")
            or qualification_report.get("request_policy") != current_report.get("request_policy")
            or qualification_report.get("request_evidence_version") != current_report.get("request_evidence_version")
            or qualification_report.get("serving_identity_policy") != current_report.get("serving_identity_policy")):
        raise ValueError("Decider2B qualification must match the current report model, serving identity, and request policy; export remains blocked")
    qualification_rows = {item.get("id"): item for item in qualification_report.get("items", [])
                          if isinstance(item, dict)}
    if set(qualification_rows) != {item.get("id") for item in qualification_items}:
        raise ValueError("Decider2B qualification result is incomplete; export remains blocked")
    criteria_by_id = {criterion["id"]: criterion for criterion in expected_criteria}
    for item in qualification_items:
        checks = qualification_rows[item["id"]].get("checks")
        if not isinstance(checks, dict) or set(checks) != _applicable_ids(expected_criteria, item, typed):
            raise ValueError("Decider2B qualification result omitted required labels; export remains blocked")
        for criterion_id, expected_label in item["checks"].items():
            decision = checks[criterion_id]
            chunked_section_check = (criterion_id == "section-heading-fit"
                                     and isinstance(item.get("section_chunk_manifest"), dict))
            if expected_label == "uncertain" and not chunked_section_check:
                threshold = criteria_by_id[criterion_id].get("diagnostic_min_probability", 0.5)
                probabilities = decision.get("probabilities") if isinstance(decision, dict) else None
                if (not isinstance(probabilities, dict)
                        or probabilities.get("uncertain", -1) <= threshold):
                    raise ValueError("Decider2B uncertain qualification label lacks captured probability above its criterion threshold; export remains blocked")
            if (not isinstance(decision, dict) or decision.get("gold") != expected_label
                    or decision.get("predicted") != expected_label
                    or decision.get("decision") != expected_label):
                raise ValueError("Decider2B missed or abstained on a policy-labelled qualification example; export remains blocked")
            if chunked_section_check:
                _validate_section_chunk_qualification(
                    decision, item["section_chunk_manifest"], options_by_id[criterion_id],
                    criteria_by_id[criterion_id].get("diagnostic_min_probability", 0.5))

    return {"status": "decider_execution_passed", "document_blake3": source_hash,
            "paragraphs": len(blocks), "criteria": sorted(required_ids), "model": current_report["model"],
            "model_qualification": "qualified_on_policy_benchmark",
            "qualification_data_blake3": expected_data_hash,
            "qualification_report_blake3": expected_report_hash,
            "qualification_required_labels": required_labels,
            "voice_certification": "not_established; benchmark qualification is not universal author approval"}

def enforce_writing_policy(source: Path, expected_bytes: bytes | None = None) -> dict | None:
    # Bind policy discovery and document identity to the actual file, so a
    # symlinked source cannot select a policy from its lexical path.
    source = source.resolve(strict=True)
    policy_path = next((p / ".writing-policy.json" for p in source.parents if (p / ".writing-policy.json").is_file()), None)
    if policy_path is None:
        raise ValueError("No writing policy admits this document; DOCX export remains blocked")
    try:
        policy = json.loads(policy_path.read_text(encoding="utf-8"))
        if not isinstance(policy, dict) or not isinstance(policy.get("documents"), dict):
            raise ValueError("Writing policy does not admit this document or has invalid DATA")
        relative = source.relative_to(policy_path.parent).as_posix()
        entry = policy["documents"][relative]
        if not isinstance(entry, dict):
            raise ValueError("Writing policy does not admit this document or has invalid DATA")
        if policy["schema"] != "book-writing-policy-v1" or policy["unknown_documents"] != "deny":
            raise ValueError()
        current_hash = _hash(source)
        if expected_bytes is not None and current_hash != _snapshot_hash(expected_bytes):
            raise ValueError("Source changed after loading; export remains blocked")
        if entry["source_blake3"] != current_hash:
            raise ValueError("Writing policy source changed; its evidence must be updated")
        if entry["role"] in ("comparison", "historical_reference"):
            return {"status": "declared_reference", "assurance": "Bound historical/comparison input; no current-prose approval."}
        if entry["role"] != "current_prose":
            raise ValueError()
        policy_root = policy_path.parent.resolve(strict=True)
        profile_value = entry["profile"]
        reviews_value = entry.get("reviews")
        if not isinstance(profile_value, str) or (reviews_value is not None and not isinstance(reviews_value, str)):
            raise ValueError("Invalid writing policy DATA")
        profile = (policy_root / profile_value).resolve(strict=False)
        reviews = (policy_root / reviews_value).resolve(strict=False) if reviews_value else None
        if not profile.is_relative_to(policy_root) or (reviews is not None and not reviews.is_relative_to(policy_root)):
            raise ValueError("Writing policy evidence must remain within its policy directory")
        if not profile.is_file() or (reviews is not None and not reviews.is_file()):
            raise ValueError("Writing policy evidence is missing")
        bundled_node = Path(sys.executable).absolute().parents[2] / "node" / "bin" / "node"
        node = str(bundled_node) if bundled_node.is_file() else shutil.which("node")
        if not node:
            raise ValueError("The maintained Decider2B validator is unavailable; export remains blocked")
        decider = _read_decider_evidence(policy_root, entry, source, current_hash, node)
    except (KeyError, TypeError, json.JSONDecodeError, OSError):
        raise ValueError("Writing policy does not admit this document or has invalid DATA") from None
    except ValueError as error:
        if str(error):
            raise
        raise ValueError("Invalid writing policy DATA") from None
    # The one copy of the writing checker is the Workshop's (set TRILLION_WORKSHOP to a trillion-workshop checkout).
    checker = Path(os.environ.get("TRILLION_WORKSHOP", "/nonexistent")) / "tools/pin-files-by-content/do-work/verify-writing-profile.mjs"
    if not node or not checker.is_file():
        raise ValueError("The maintained writing checker is unavailable; export remains blocked")
    reports = policy_path.parent / ".writing-gate-reports"
    reports.mkdir(mode=0o700, exist_ok=True)
    os.chmod(reports, 0o700)
    report = reports / (uuid.uuid4().hex + ".json")
    command = [node, str(checker), "--document", str(source), "--profile", str(profile), "--out", str(report)]
    if reviews is not None:
        command.extend(["--reviews", str(reviews)])
    result = subprocess.run(command, capture_output=True, text=True)
    if result.returncode != 0:
        raise ValueError("Writing regression/source-review checks are not satisfied; no DOCX was created")
    try:
        receipt = json.loads(report.read_text())
        if not isinstance(receipt, dict) or receipt["status"] != "checks_satisfied" or receipt["document_blake3"] != _hash(source):
            raise ValueError()
    except (OSError, KeyError, TypeError, json.JSONDecodeError, ValueError):
        raise ValueError("Writing check receipt is missing, stale or invalid") from None
    receipt["decider2b_evidence"] = decider
    receipt["assurance"] = (receipt.get("assurance", "") + " Captured local Decider2B responses passed every required criterion on every exact current paragraph. This is evidence of model execution and its recorded choices, not semantic correctness or author approval.").strip()
    return receipt
