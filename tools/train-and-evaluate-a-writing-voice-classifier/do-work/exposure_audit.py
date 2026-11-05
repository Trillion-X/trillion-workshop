"""Conservative, body-free audit for training/target exposure.

Callers supply already-parsed rows and source identities.  The module deliberately
does not load training frameworks, inspect the filesystem, or infer independence
or authorship from a missing textual match.
"""

from __future__ import annotations

import re
import unicodedata
from collections.abc import Mapping, Sequence
from typing import Any


_TEXT_FIELDS = ("target_text", "reader_context", "reference_text")
_MIN_TARGET_CHARS = 16
_WS = re.compile(r"\s+")


def _normalized(text: str) -> str:
    return _WS.sub(" ", unicodedata.normalize("NFKC", text).casefold()).strip()


def _is_word_char(char: str) -> bool:
    # str.isalnum is Unicode-aware; underscore is conventionally part of a word.
    return char == "_" or char.isalnum()


def _boundary_match(haystack: str, needle: str) -> bool:
    start = 0
    while True:
        start = haystack.find(needle, start)
        if start < 0:
            return False
        end = start + len(needle)
        left_ok = not needle[0].isalnum() or start == 0 or not _is_word_char(haystack[start - 1])
        right_ok = not needle[-1].isalnum() or end == len(haystack) or not _is_word_char(haystack[end])
        if left_ok and right_ok:
            return True
        start += 1


def _validate_row(row: Any, label: str, index: int) -> tuple[Mapping[str, Any], Mapping[str, Any]]:
    if not isinstance(row, Mapping) or not row:
        raise ValueError(f"{label} row {index} must be a nonempty mapping")
    state = row.get("state", row)
    if not isinstance(state, Mapping) or not state:
        raise ValueError(f"{label} row {index} state must be a nonempty mapping")
    target = state.get("target_text")
    if not isinstance(target, str) or not target.strip():
        raise ValueError(f"{label} row {index} target_text must be nonempty text")
    for key in ("reader_context",):
        value = state.get(key, "")
        if not isinstance(value, str):
            raise ValueError(f"{label} row {index} {key} must be text")
    reference = state.get("reference_text", "")
    if isinstance(reference, str):
        pass
    elif isinstance(reference, Mapping) and all(
        isinstance(key, str) and key and isinstance(value, str) for key, value in reference.items()
    ):
        pass
    else:
        raise ValueError(f"{label} row {index} reference_text must be text or a keyed text mapping")
    return row, state


def _text_fields(state: Mapping[str, Any]) -> list[tuple[str, str, int | None]]:
    fields: list[tuple[str, str, int | None]] = []
    for key in _TEXT_FIELDS:
        value = state.get(key, "")
        if isinstance(value, str) and value:
            fields.append((key, value, None))
        elif key == "reference_text" and isinstance(value, Mapping):
            fields.extend((key, body, ref_index) for ref_index, body in enumerate(value.values()) if body)
    return fields


def _identity(identity: Any) -> dict[str, Any]:
    """Keep safe source identity tokens; never echo paths or arbitrary labels."""
    if not isinstance(identity, Mapping):
        return {"status": "unknown", "bytes_verified": False}
    source_dataset = identity.get("source_dataset")
    dataset_path = identity.get("path")
    if isinstance(source_dataset, Mapping):
        dataset_path = source_dataset.get("path", dataset_path)
        digest = source_dataset.get("blake3", identity.get("blake3", identity.get("source_dataset_blake3")))
    else:
        digest = identity.get("blake3", identity.get("source_dataset_blake3"))
    source_id = identity.get("source_id")
    digest_valid = isinstance(digest, str) and re.fullmatch(r"[0-9a-fA-F]{64}", digest) is not None
    path_supplied = isinstance(dataset_path, str) and bool(dataset_path.strip())
    declared = digest_valid and path_supplied
    result: dict[str, Any] = {
        "status": "caller_declared" if declared else "unknown",
        "bytes_verified": False,
    }
    if isinstance(source_id, str) and re.fullmatch(r"[A-Za-z0-9._:-]{1,80}", source_id):
        result["source_id"] = source_id
    if declared:
        result["blake3"] = digest.lower()
    schema = identity.get("schema")
    if isinstance(schema, str) and re.fullmatch(r"[A-Za-z0-9._:-]{1,80}", schema):
        result["schema"] = schema
    return result


def audit_exposure(
    training_rows: Sequence[Mapping[str, Any]],
    target_rows: Sequence[Mapping[str, Any]],
    *,
    training_source: Mapping[str, Any] | None = None,
    target_source: Mapping[str, Any] | None = None,
) -> dict[str, Any]:
    """Compare target text with training fields, families, and full states.

    Text matches are exact or conservative NFKC/case/whitespace-normalized
    substrings, with Unicode-aware word boundaries and a 16-character minimum.
    A no-match result is only absence of these detectable overlaps.
    """
    if not isinstance(training_rows, Sequence) or isinstance(training_rows, (str, bytes)):
        raise ValueError("training_rows must be a sequence")
    if not isinstance(target_rows, Sequence) or isinstance(target_rows, (str, bytes)):
        raise ValueError("target_rows must be a sequence")
    training = [_validate_row(row, "training", i) for i, row in enumerate(training_rows)]
    targets = [_validate_row(row, "target", i) for i, row in enumerate(target_rows)]

    text_matches: list[dict[str, Any]] = []
    family_matches: list[dict[str, int]] = []
    complete_state_matches: list[dict[str, int]] = []
    unassessed_targets: list[dict[str, Any]] = []
    for target_index, (target_row, target_state) in enumerate(targets):
        target_text = target_state["target_text"]
        exact_needle = target_text
        normalized_needle = _normalized(target_text)
        reasons = []
        if not training:
            reasons.append("empty_training_rows")
        if len(normalized_needle) < _MIN_TARGET_CHARS:
            reasons.append("target_below_minimum_length")
        if reasons:
            unassessed_targets.append({"target_row_index": target_index, "reasons": reasons})
        for train_index, (train_row, train_state) in enumerate(training):
            if not reasons:
                for field_key, body, reference_key_index in _text_fields(train_state):
                    modes = []
                    if _boundary_match(body, exact_needle):
                        modes.append("exact_substring")
                    normalized_body = _normalized(body)
                    if not modes and normalized_needle and _boundary_match(normalized_body, normalized_needle):
                        modes.append("normalized_substring")
                    for mode in modes:
                        match = {
                            "target_row_index": target_index,
                            "training_row_index": train_index,
                            "field_key": field_key,
                            "match": mode,
                        }
                        if reference_key_index is not None:
                            match["reference_key_index"] = reference_key_index
                        text_matches.append(match)
            family = target_row.get("family")
            if isinstance(family, str) and family and family == train_row.get("family"):
                family_matches.append({"target_row_index": target_index, "training_row_index": train_index})
            if dict(target_state) == dict(train_state):
                complete_state_matches.append({"target_row_index": target_index, "training_row_index": train_index})

    return {
        "schema": "training-exposure-audit-v1",
        "training_source": _identity(training_source),
        "target_source": _identity(target_source),
        "training_row_count": len(training),
        "target_row_count": len(targets),
        "text_matches": text_matches,
        "text_assessment_status": "incomplete" if unassessed_targets else "complete",
        "unassessed_targets": unassessed_targets,
        "same_family_matches": family_matches,
        "complete_state_matches": complete_state_matches,
        "text_match_rule": {
            "minimum_normalized_target_characters": _MIN_TARGET_CHARS,
            "normalization": "Unicode NFKC, casefold, collapsed whitespace",
            "boundary": "Unicode alphanumeric/underscore word boundaries when target edge is alphanumeric",
        },
        "interpretation": "Matches show detectable overlap. No match does not prove independence, novelty, or authorship; semantic/fuzzy overlap is not measured. Caller-declared source hashes are not byte-verified by this helper.",
    }


def main() -> int:
    """The tool row: one JSON request on standard input ({ training_rows, target_rows, training_source?,
    target_source? }), the audit as { "result": ... } (or { "error": ... }) on the last line."""
    import json
    import sys

    try:
        request = json.loads(sys.stdin.read() or "{}")
        if not isinstance(request, Mapping):
            raise ValueError("the request is one JSON object: { training_rows, target_rows, training_source?, target_source? }")
        result = audit_exposure(
            request.get("training_rows"),
            request.get("target_rows"),
            training_source=request.get("training_source"),
            target_source=request.get("target_source"),
        )
    except (ValueError, json.JSONDecodeError) as error:
        print(json.dumps({"error": f"{error}. Give training_rows and target_rows as lists of rows whose state holds target_text."}))
        return 1
    print(json.dumps({"result": result}))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
