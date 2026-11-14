#!/usr/bin/env python3
#
# File: packages/content-generation/do-work/process-scripts/gate-and-build-owner-delivery.py
#
# =============================================================================
# PURPOSE — BLIND GATE + OWNER DELIVERY BUILDER (Physics, zero Society)
# =============================================================================
#
# Take the ONE structured item an ai-records-producer run returned
# (result_payload.items[0]) and, driven entirely by the recipe's `gate_policy`
# and `delivery_target` DATA:
#   1. GATE it fail-closed (grounded / cite-or-reject / min-excerpts). A rejected
#      item exits NON-ZERO so the engine's next `write` step never runs and no
#      owner action is invoked.
#      return-7 rejection.
#   2. Build one validated owner-action handoff. Content Generation never writes
#      another owner's record body.
#
# This script owns NO domain vocabulary, NO output shape, NO destination address.
# The output field mapping and destination owner action are ALL DATA on the
# recipe. Swap the recipe -> a legal brief, a changelog, a menu -- with ZERO
# change to this file.
#
# =============================================================================
# gate_policy DATA
# =============================================================================
#   grounded            : bool   -- require grounding to have been present
#   min_excerpts        : int    -- require >= N provided grounding excerpts
#   cite_or_reject      : bool   -- if grounding provided, the item MUST cite >=1
#   grounding_id_field  : str    -- field on each grounding excerpt that is its id
#                                   (default "source_ref")
#   citation_specs      : [ {array:<item field>, ids_key:<subfield>} ... ]
#   checks              : [ DATA-selected gate capabilities; unknown/malformed
#                           rows fail closed ]
#                                   where to collect cited ids from the item
#
# delivery_target DATA
# =============================================================================
#   definition_id : "action:<destination owner action>"
#   input         : {<owner input key>: <value spec>}
#   value spec    : {from:"item"|"work_item"|"context",field:<key>} |
#                   {from:"derived",field:"summary"|"body"} | {value:<literal>}
#   summary_from     : {array:<k>, text_key:<k>}   first non-empty text
#   body_render      : {blocks:{array,heading_key,text_key},
#                       faq:{array,question_key,answer_key,heading},
#                       jsonld:{array,context}}     -> generic body string
#
# =============================================================================
# NON-NEGOTIABLE INVARIANTS
# =============================================================================
# 1. No domain string, no output shape, no address literal in this file.
# 2. Never executes an AI CLI or any OS process.
# 3. Reject == non-zero exit (fail closed). No fabricated/partial owner handoff.
# 4. Pure stdlib. Deterministic. No network.

from __future__ import annotations

import argparse
import html
import json
import pathlib
import re as _re
import sys
import unicodedata
from typing import Any


def as_string(value: Any) -> str:
    return value if isinstance(value, str) else ""


def read_json_arg(value: str, fallback: Any) -> Any:
    try:
        parsed = json.loads(value) if value else fallback
    except Exception:
        return fallback
    return parsed


# ---------------------------------------------------------------------------
# GATE (fail-closed) -- generic reproduction of cite-or-reject
# ---------------------------------------------------------------------------

def collect_provided_ids(grounding: Any, id_field: str) -> set[str]:
    ids: set[str] = set()
    if isinstance(grounding, list):
        for excerpt in grounding:
            if isinstance(excerpt, dict):
                sid = excerpt.get(id_field)
                if isinstance(sid, str) and sid:
                    ids.add(sid)
    return ids


def collect_cited_ids(item: dict[str, Any], citation_specs: Any) -> set[str]:
    """Collect the source ids the produced item actually cited, per DATA specs.
    Each spec names an item array field and the id sub-key inside each element;
    a sub-key value may be a list of ids OR a single scalar id (both handled)."""
    cited: set[str] = set()
    if not isinstance(citation_specs, list):
        return cited
    for spec in citation_specs:
        if not isinstance(spec, dict):
            continue
        array_key = as_string(spec.get("array"))
        ids_key = as_string(spec.get("ids_key"))
        if not array_key or not ids_key:
            continue
        elements = item.get(array_key)
        if not isinstance(elements, list):
            continue
        for element in elements:
            if not isinstance(element, dict):
                continue
            raw = element.get(ids_key)
            if isinstance(raw, list):
                for rid in raw:
                    if isinstance(rid, str) and rid:
                        cited.add(rid)
            elif isinstance(raw, str) and raw:
                cited.add(raw)
    return cited


# --- Gate check capabilities (L090 / enum-dissolution) ---------------------
# The gate is a LIST of self-describing checks (`gate_policy.checks`), each a
# {"kind": <capability-id>, "params": {...}} DATA row. evaluate_gate iterates the
# list and dispatches each `kind` through GATE_CHECK_CAPABILITIES — it owns NO
# check-specific branch. Adding a new criterion = one DATA row + (only if a
# genuinely new computation) one leaf capability fn; never an `if` in the gate.
# An UNKNOWN kind FAILS CLOSED (a DATA row demanded a capability that is not
# installed) — this is what makes new criteria REAL, not un-enforced "generic-
# but-empty" DATA (L134#2): you cannot author a check that silently passes.
#
# A capability is fn(item, params, ctx) -> (pass: bool, reason: str). `ctx`
# carries derived values (provided_ids, id_field, citation_specs, grounding) so
# checks never re-derive them.

def _cap_min_grounding_excerpts(item: dict[str, Any], params: dict[str, Any], ctx: dict[str, Any]) -> tuple[bool, str]:
    min_n = params.get("min")
    # A malformed threshold is an authoring error on a REJECT gate -> fail closed,
    # never silently pass (else a check that was supposed to enforce grounding
    # becomes a no-op the moment its param is fat-fingered).
    if not isinstance(min_n, int) or isinstance(min_n, bool) or min_n <= 0:
        return (False, "min-grounding-excerpts requires a positive integer 'min' param; refusing to pass an unenforceable check")
    have = len(ctx["provided_ids"])
    if have < min_n:
        return (False, f"required >= {min_n} grounding excerpts but only {have} were provided")
    return (True, "")


def _cap_cite_or_reject(item: dict[str, Any], params: dict[str, Any], ctx: dict[str, Any]) -> tuple[bool, str]:
    provided = ctx["provided_ids"]
    if not provided:
        return (True, "")  # nothing to cite -> vacuously satisfied
    cited = collect_cited_ids(item, ctx["citation_specs"])
    if not (provided & cited):
        return (False, f"grounding was provided ({len(provided)} ids) but the item cited none of the owner's source ids; refusing owner delivery of uncited content")
    return (True, "")


def _cap_required_citation_coverage(item: dict[str, Any], params: dict[str, Any], ctx: dict[str, Any]) -> tuple[bool, str]:
    """Require every element in DATA-selected arrays to cite supplied grounding.

    Unlike cite-or-reject, which proves one valid citation exists somewhere, this
    checks each required element independently. Array names, citation keys and
    cardinalities remain recipe DATA rather than a content-type branch.
    """
    specs = params.get("specs")
    if not isinstance(specs, list) or not specs:
        return (False, "required-citation-coverage requires a non-empty 'specs' DATA list")
    provided = ctx["provided_ids"]
    if not provided:
        return (False, "required-citation-coverage has no supplied grounding ids")
    for spec in specs:
        if not isinstance(spec, dict):
            return (False, "required-citation-coverage rows must be objects")
        array_key = as_string(spec.get("array"))
        ids_key = as_string(spec.get("ids_key"))
        min_elements = spec.get("min_elements", 0)
        if not array_key or not ids_key:
            return (False, "required-citation-coverage rows require array and ids_key")
        if not isinstance(min_elements, int) or isinstance(min_elements, bool) or min_elements < 0:
            return (False, f"required-citation-coverage '{array_key}' min_elements must be a non-negative integer")
        elements = item.get(array_key)
        if not isinstance(elements, list):
            return (False, f"required citation array '{array_key}' is absent or not a list")
        if len(elements) < min_elements:
            return (False, f"required citation array '{array_key}' has {len(elements)} elements but needs at least {min_elements}")
        for index, element in enumerate(elements):
            if not isinstance(element, dict):
                return (False, f"required citation array '{array_key}' element {index} is not an object")
            raw_ids = element.get(ids_key)
            ids = raw_ids if isinstance(raw_ids, list) else [raw_ids]
            if any(not isinstance(value, str) or not value.strip() for value in ids):
                return (False, "A citation is invalid. Every citation must name a supplied source.")
            cited = {value for value in ids if isinstance(value, str) and value}
            if not cited:
                return (False, f"required citation array '{array_key}' element {index} has no '{ids_key}' value")
            unknown = cited - provided
            if unknown:
                return (False, f"required citation array '{array_key}' element {index} cites unsupplied grounding id(s): {', '.join(sorted(unknown))}")
            if not (cited & provided):
                return (False, f"required citation array '{array_key}' element {index} cites no supplied grounding id")
    return (True, "")


# --- Shared text extraction (DATA-driven, zero domain vocabulary) -----------
# `text_specs` is [ {array:<item field>, text_key:<subfield>} ... ] — the SAME
# shape family as citation_specs. Checks that analyze prose read WHICH fields to
# analyze from this DATA, never hardcoding "blocks"/"text". Also collects a bare
# top-level string field when a spec has no `array` (just {field:<k>}).

def collect_texts(item: dict[str, Any], text_specs: Any) -> list[str]:
    texts: list[str] = []
    if not isinstance(text_specs, list):
        return texts
    for spec in text_specs:
        if not isinstance(spec, dict):
            continue
        array_key = as_string(spec.get("array"))
        text_key = as_string(spec.get("text_key"))
        if array_key:
            elements = item.get(array_key)
            if isinstance(elements, list):
                for el in elements:
                    if isinstance(el, dict) and text_key:
                        v = el.get(text_key)
                        if isinstance(v, str) and v.strip():
                            texts.append(v)
                    elif isinstance(el, str) and el.strip():
                        texts.append(el)
            continue
        field_key = as_string(spec.get("field"))
        if field_key:
            v = item.get(field_key)
            if isinstance(v, str) and v.strip():
                texts.append(v)
            continue
        path = spec.get("path")
        v = resolve_path(item, path)
        if isinstance(v, str) and v.strip():
            texts.append(v)
    return texts


def _normalized_policy_text(value: str) -> str:
    """Canonicalize prose for DATA-owned literal safety checks.

    NFKC closes common compatibility-character evasions, Unicode format
    controls are removed, whitespace is collapsed, and casefolding provides a
    deterministic locale-independent comparison. The engine still owns no
    prohibited phrase: every fragment and its trusted label come from recipe
    DATA.
    """
    normalized = unicodedata.normalize("NFKC", value)
    normalized = "".join(ch for ch in normalized if unicodedata.category(ch) != "Cf")
    return " ".join(normalized.casefold().split())


def _cap_forbidden_text_fragments(item: dict[str, Any], params: dict[str, Any], ctx: dict[str, Any]) -> tuple[bool, str]:
    """Reject DATA-labelled unsafe prose before any materialization.

    `text_specs` selects the model-produced fields to inspect. `fragments` is a
    non-empty list of trusted DATA rows `{label, value}`. The label appears in
    the exact fail-closed reason; the untrusted model output never supplies or
    overrides it. Literal normalized matching is bounded, deterministic, and
    avoids a regex execution surface.
    """
    specs = params.get("text_specs")
    if not isinstance(specs, list) or not specs:
        return (False, "forbidden-text-fragments requires a non-empty 'text_specs' DATA list")
    for spec in specs:
        if not isinstance(spec, dict):
            return (False, "forbidden-text-fragments text_specs rows must be objects")
        array_key = as_string(spec.get("array"))
        field_key = as_string(spec.get("field"))
        path = spec.get("path")
        text_key = as_string(spec.get("text_key"))
        selector_count = int(bool(array_key)) + int(bool(field_key)) + int(isinstance(path, list) and bool(path))
        if selector_count != 1:
            return (False, "forbidden-text-fragments text_specs rows require exactly one of array, field, or path")
        if array_key and not text_key:
            return (False, f"forbidden-text-fragments array '{array_key}' requires text_key")
        if path is not None and (not isinstance(path, list) or not path or not all(isinstance(key, str) and key for key in path)):
            return (False, "forbidden-text-fragments path must be a non-empty list of string keys")

    raw_fragments = params.get("fragments")
    if not isinstance(raw_fragments, list) or not raw_fragments:
        return (False, "forbidden-text-fragments requires a non-empty 'fragments' trusted DATA list")
    fragments: list[tuple[str, str]] = []
    seen: set[str] = set()
    for row in raw_fragments:
        if not isinstance(row, dict):
            return (False, "forbidden-text-fragments fragment rows must be objects")
        label = as_string(row.get("label")).strip()
        value = _normalized_policy_text(as_string(row.get("value")))
        if not label or not value:
            return (False, "forbidden-text-fragments fragment rows require non-empty label and value")
        if value in seen:
            return (False, f"forbidden-text-fragments repeats normalized fragment for trusted label '{label}'")
        seen.add(value)
        fragments.append((label, value))

    for text in collect_texts(item, specs):
        normalized = _normalized_policy_text(text)
        for label, fragment in fragments:
            if fragment in normalized:
                return (False, f"trusted DATA content-safety label '{label}' matched generated prose; refusing owner delivery")
    return (True, "")


def resolve_path(item: dict[str, Any], path: Any) -> Any:
    """Walk a DATA list-of-keys path into the item; None if any hop misses."""
    if not isinstance(path, list) or not path:
        return None
    cur: Any = item
    for key in path:
        if isinstance(cur, dict) and isinstance(key, str):
            cur = cur.get(key)
        else:
            return None
    return cur


_WORD_RE = _re.compile(r"[A-Za-z0-9]+")
_FACT_RE = _re.compile(r"\d")  # a token carrying a digit = a fact/measure/date signal


def _tokens(texts: list[str]) -> list[str]:
    joined = " ".join(texts).lower()
    return _WORD_RE.findall(joined)


def _cap_min_unique_ratio(item: dict[str, Any], params: dict[str, Any], ctx: dict[str, Any]) -> tuple[bool, str]:
    """Reject boilerplate/repetitive prose: distinct n-gram shingles / total < min."""
    min_ratio = params.get("min")
    if not isinstance(min_ratio, (int, float)) or isinstance(min_ratio, bool) or not (0.0 < min_ratio <= 1.0):
        return (False, "min-unique-ratio requires a 'min' in (0,1]; refusing to pass an unenforceable check")
    specs = params.get("text_specs")
    if not isinstance(specs, list) or not specs:
        return (False, "min-unique-ratio requires a non-empty 'text_specs' DATA list; refusing to pass an unenforceable check")
    n = params.get("shingle", 3)
    if not isinstance(n, int) or isinstance(n, bool) or n <= 0:
        return (False, "min-unique-ratio 'shingle' must be a positive integer")
    toks = _tokens(collect_texts(item, specs))
    if len(toks) < n:
        return (False, f"content too short to evaluate uniqueness (< {n} words)")
    shingles = [tuple(toks[i:i + n]) for i in range(len(toks) - n + 1)]
    ratio = len(set(shingles)) / len(shingles)
    if ratio < min_ratio:
        return (False, f"unique {n}-gram ratio {ratio:.2f} < required {min_ratio}")
    return (True, "")


def _cap_min_fact_density(item: dict[str, Any], params: dict[str, Any], ctx: dict[str, Any]) -> tuple[bool, str]:
    """Reject fact-thin prose: fact-signal tokens per `per_words` words >= min."""
    min_density = params.get("min")
    if not isinstance(min_density, (int, float)) or isinstance(min_density, bool) or min_density <= 0:
        return (False, "min-fact-density requires a positive 'min'; refusing to pass an unenforceable check")
    per_words = params.get("per_words", 100)
    if not isinstance(per_words, int) or isinstance(per_words, bool) or per_words <= 0:
        return (False, "min-fact-density 'per_words' must be a positive integer")
    specs = params.get("text_specs")
    if not isinstance(specs, list) or not specs:
        return (False, "min-fact-density requires a non-empty 'text_specs' DATA list; refusing to pass an unenforceable check")
    toks = _tokens(collect_texts(item, specs))
    if not toks:
        return (False, "no analyzable text for fact density")
    facts = sum(1 for t in toks if _FACT_RE.search(t))
    density = facts * per_words / len(toks)
    if density < min_density:
        return (False, f"fact density {density:.2f} per {per_words} words < required {min_density}")
    return (True, "")


def _cap_author_entity_present(item: dict[str, Any], params: dict[str, Any], ctx: dict[str, Any]) -> tuple[bool, str]:
    """Reject anonymous content: a non-empty author entity ref at a DATA path."""
    path = params.get("path")
    if not isinstance(path, list) or not path:
        return (False, "author-entity-present requires a non-empty 'path' DATA list; refusing to pass an unenforceable check")
    val = resolve_path(item, path)
    if isinstance(val, str) and val.strip():
        return (True, "")
    if isinstance(val, dict) and val:
        return (True, "")
    return (False, f"no author entity present at path {path}; refusing to publish anonymous content")


def _cap_demand_present(item: dict[str, Any], params: dict[str, Any], ctx: dict[str, Any]) -> tuple[bool, str]:
    """Reject demand-less topics: a demand signal (attached upstream as DATA — e.g.
    SERP volume from a service-connection) at a DATA path >= a min threshold. The
    fetch is a separate upstream step; THIS check enforces the evidence exists."""
    path = params.get("path")
    if not isinstance(path, list) or not path:
        return (False, "demand-present requires a non-empty 'path' DATA list; refusing to pass an unenforceable check")
    min_v = params.get("min", 1)
    if not isinstance(min_v, (int, float)) or isinstance(min_v, bool):
        return (False, "demand-present 'min' must be a number")
    val = resolve_path(item, path)
    if isinstance(val, bool) or not isinstance(val, (int, float)):
        return (False, f"no numeric demand signal at path {path}; refusing to publish a topic with unproven demand")
    if val < min_v:
        return (False, f"demand signal {val} < required {min_v}")
    return (True, "")


# The installed capability set. New leaf capabilities register HERE — a new gate
# criterion is one DATA row + (only for a genuinely new computation) one entry.
GATE_CHECK_CAPABILITIES: dict[str, Any] = {
    "min-grounding-excerpts": _cap_min_grounding_excerpts,
    "cite-or-reject": _cap_cite_or_reject,
    "required-citation-coverage": _cap_required_citation_coverage,
    "forbidden-text-fragments": _cap_forbidden_text_fragments,
    "min-unique-ratio": _cap_min_unique_ratio,
    "min-fact-density": _cap_min_fact_density,
    "author-entity-present": _cap_author_entity_present,
    "serp-demand-present": _cap_demand_present,
}


def normalize_gate_checks(gate_policy: dict[str, Any]) -> list[dict[str, Any]]:
    """The self-describing check list. Prefer an explicit `gate_policy.checks`;
    otherwise translate the legacy flat keys (grounded/min_excerpts/cite_or_reject)
    into the equivalent capability rows so existing recipes stay green (L100:
    the branch logic moved out of evaluate_gate into DATA)."""
    checks = gate_policy.get("checks")
    if isinstance(checks, list) and checks:
        # Return rows VERBATIM (including malformed non-dicts) so evaluate_gate
        # sees them and fails closed. Filtering non-dicts here would silently
        # drop a check the owner authored -> fail-open. A REJECT gate never
        # discards a row it cannot understand; it refuses.
        return list(checks)
    legacy: list[dict[str, Any]] = []
    min_excerpts = gate_policy.get("min_excerpts")
    if gate_policy.get("grounded") is True and isinstance(min_excerpts, int) and min_excerpts > 0:
        legacy.append({"kind": "min-grounding-excerpts", "params": {"min": min_excerpts}})
    if gate_policy.get("cite_or_reject") is True:
        legacy.append({"kind": "cite-or-reject", "params": {}})
    return legacy


def evaluate_gate(
    item: dict[str, Any],
    gate_policy: dict[str, Any],
    grounding: Any,
    materialization: dict[str, Any] | None = None,
) -> tuple[bool, str, str]:
    """Return (passed, reject_code, reject_reason). Fail-closed, DATA-driven: run
    every check in `gate_policy.checks` (or the legacy-key translation) through the
    installed capability map. An unknown check kind rejects (fail-closed)."""
    id_field = as_string(gate_policy.get("grounding_id_field")) or "source_ref"
    ctx: dict[str, Any] = {
        "provided_ids": collect_provided_ids(grounding, id_field),
        "id_field": id_field,
        "citation_specs": gate_policy.get("citation_specs"),
        "grounding": grounding,
        "materialization": materialization if isinstance(materialization, dict) else {},
    }
    for check in normalize_gate_checks(gate_policy):
        # A malformed row (non-dict) is an unenforceable check -> fail closed.
        if not isinstance(check, dict):
            return (
                False,
                "malformed_gate_check",
                f"gate check row is not an object ({type(check).__name__}); refusing to pass an unenforceable check",
            )
        kind = as_string(check.get("kind"))
        capability = GATE_CHECK_CAPABILITIES.get(kind)
        if capability is None:
            return (
                False,
                "unknown_gate_check",
                f"gate check '{kind or '(missing kind)'}' has no installed capability; failing closed rather than passing an unenforced check",
            )
        # `params` may be absent (a check that needs none), but a PRESENT non-dict
        # params is malformed authoring -> fail closed, not coerced-to-empty.
        raw_params = check.get("params")
        if raw_params is not None and not isinstance(raw_params, dict):
            return (
                False,
                "malformed_gate_check",
                f"gate check '{kind}' has non-object params ({type(raw_params).__name__}); refusing to pass an unenforceable check",
            )
        params = raw_params if isinstance(raw_params, dict) else {}
        passed, reason = capability(item, params, ctx)
        if not passed:
            return (False, f"gate_check_failed:{kind}", reason)
    return (True, "", "")


def flatten_summary(item: dict[str, Any], spec: Any) -> str:
    """Select the first non-empty string from a DATA-named output array."""
    if not isinstance(spec, dict):
        return ""
    array_key = as_string(spec.get("array"))
    text_key = as_string(spec.get("text_key")) or "text"
    for element in item.get(array_key) or []:
        if isinstance(element, dict):
            text = element.get(text_key)
            if isinstance(text, str) and text.strip():
                return text.strip()
    return ""


def flatten_body(item: dict[str, Any], render: Any) -> str:
    """Render DATA-named structured output into the destination owner's body input."""
    if not isinstance(render, dict):
        return ""
    parts: list[str] = []
    blocks_spec = render.get("blocks")
    if isinstance(blocks_spec, dict):
        array_key = as_string(blocks_spec.get("array"))
        heading_key = as_string(blocks_spec.get("heading_key")) or "heading"
        text_key = as_string(blocks_spec.get("text_key")) or "text"
        for block in item.get(array_key) or []:
            if not isinstance(block, dict):
                continue
            heading, text = block.get(heading_key), block.get(text_key)
            if heading:
                parts.append(f"<h2>{html.escape(str(heading))}</h2>")
            if text:
                parts.append(f"<p>{html.escape(str(text))}</p>")
    faq_spec = render.get("faq")
    if isinstance(faq_spec, dict):
        array_key = as_string(faq_spec.get("array"))
        question_key = as_string(faq_spec.get("question_key")) or "question"
        answer_key = as_string(faq_spec.get("answer_key")) or "answer"
        heading = as_string(faq_spec.get("heading"))
        pairs = item.get(array_key) or []
        if pairs and heading:
            parts.append(f"<h2>{html.escape(heading)}</h2>")
        for pair in pairs:
            if not isinstance(pair, dict):
                continue
            question, answer = pair.get(question_key), pair.get(answer_key)
            if question:
                parts.append(f"<h3>{html.escape(str(question))}</h3>")
            if answer:
                parts.append(f"<p>{html.escape(str(answer))}</p>")
    jsonld_spec = render.get("jsonld")
    if isinstance(jsonld_spec, dict):
        fragments = item.get(as_string(jsonld_spec.get("array"))) or []
        if fragments:
            context = as_string(jsonld_spec.get("context")) or "https://schema.org"
            graph = {"@context": context, "@graph": fragments}
            encoded = json.dumps(graph, separators=(",", ":")).replace("</script", "<\\/script")
            parts.append(f'<script type="application/ld+json">{encoded}</script>')
    return "\n".join(parts)


def resolve_delivery_value(
    spec: Any,
    item: dict[str, Any],
    work_item: dict[str, Any],
    context: dict[str, Any],
    derived: dict[str, str],
) -> tuple[bool, Any, str]:
    """Resolve one DATA-owned destination input value, failing closed on shape."""
    if not isinstance(spec, dict):
        return (False, None, "delivery input value spec must be an object")
    if "value" in spec:
        return (True, spec["value"], "")
    source_name = as_string(spec.get("from"))
    field = as_string(spec.get("field"))
    sources: dict[str, dict[str, Any]] = {
        "item": item,
        "work_item": work_item,
        "context": context,
        "derived": derived,
    }
    source = sources.get(source_name)
    if source is None or not field:
        return (False, None, "delivery input needs {value} or a known {from,field} source")
    if field not in source:
        return (False, None, f"delivery input source '{source_name}.{field}' is absent")
    return (True, source[field], "")


def build_owner_delivery(
    item: dict[str, Any],
    work_item: dict[str, Any],
    context: dict[str, Any],
    delivery_target: Any,
) -> tuple[bool, dict[str, Any], str]:
    """Build a destination-owner request without knowing its domain or schema."""
    if not isinstance(delivery_target, dict):
        return (False, {}, "delivery_target must be an object")
    definition_id = as_string(delivery_target.get("definition_id"))
    inputs = delivery_target.get("input")
    if not definition_id.startswith("action:") or not isinstance(inputs, dict) or not inputs:
        return (False, {}, "delivery_target requires action: definition_id and a non-empty input mapping")
    derived = {
        "summary": flatten_summary(item, delivery_target.get("summary_from")),
        "body": flatten_body(item, delivery_target.get("body_render")),
    }
    owner_input: dict[str, Any] = {}
    for key, value_spec in inputs.items():
        if not isinstance(key, str) or not key:
            return (False, {}, "delivery_target input keys must be non-empty strings")
        ok, value, reason = resolve_delivery_value(value_spec, item, work_item, context, derived)
        if not ok:
            return (False, {}, reason)
        owner_input[key] = value
    return (True, {"definition_id": definition_id, "input": owner_input}, "")


def main() -> int:
    p = argparse.ArgumentParser(description="Gate and build one owner-delivery request per produced item.")
    p.add_argument("--recipe-json", required=True, help="The content-generation.recipe object (DATA).")
    p.add_argument("--produced-item-json", required=True, help="ai-records-producer result_payload.items[0].")
    p.add_argument("--grounding-json", default="[]", help="The grounding excerpts that were provided to the run.")
    p.add_argument("--work-item-json", default="{}", help="The caller-supplied work item for owner-input mapping.")
    p.add_argument("--context-json", default="{}", help="Run context: author_ref, thread_ref, etc.")
    p.add_argument("--output-json", required=True)
    p.add_argument("--dispatch-request-id", default=None)
    args = p.parse_args()

    recipe = read_json_arg(args.recipe_json, {})
    if not isinstance(recipe, dict):
        recipe = {}
    item = read_json_arg(args.produced_item_json, {})
    if not isinstance(item, dict):
        print("produced item is not a JSON object", file=sys.stderr)
        return 4
    grounding = read_json_arg(args.grounding_json, [])
    work_item = read_json_arg(args.work_item_json, {})
    if not isinstance(work_item, dict):
        work_item = {}
    context = read_json_arg(args.context_json, {})
    if not isinstance(context, dict):
        context = {}

    gate_policy = recipe.get("gate_policy") if isinstance(recipe.get("gate_policy"), dict) else {}
    delivery_target = recipe.get("delivery_target")

    passed, reject_code, reject_reason = evaluate_gate(item, gate_policy, grounding)
    if not passed:
        # Fail closed: emit the honest rejection AND exit non-zero so the engine's
        # subsequent owner action is never invoked.
        result = {"passed": False, "reject_code": reject_code, "reject_reason": reject_reason}
        pathlib.Path(args.output_json).parent.mkdir(parents=True, exist_ok=True)
        pathlib.Path(args.output_json).write_text(json.dumps(result, ensure_ascii=False), encoding="utf-8")
        print(f"REJECTED [{reject_code}]: {reject_reason}", file=sys.stderr)
        return 7

    delivered, delivery, delivery_error = build_owner_delivery(item, work_item, context, delivery_target)
    if not delivered:
        result = {"passed": False, "reject_code": "invalid_delivery_target", "reject_reason": delivery_error}
        pathlib.Path(args.output_json).parent.mkdir(parents=True, exist_ok=True)
        pathlib.Path(args.output_json).write_text(json.dumps(result, ensure_ascii=False), encoding="utf-8")
        print(f"REJECTED [invalid_delivery_target]: {delivery_error}", file=sys.stderr)
        return 7

    result = {"passed": True, "delivery": delivery}
    if args.dispatch_request_id is not None:
        if not args.dispatch_request_id.strip():
            print("A saved request identity is required for delivery.", file=sys.stderr)
            return 7
        request_id = f"owner-delivery::{args.dispatch_request_id}"
        result["dispatch_request"] = {
            "kind": "content-generation.dispatch-request", "id": request_id,
            "request_id": request_id, "definition_id": delivery["definition_id"],
            "input": delivery["input"], "source_request_id": args.dispatch_request_id,
            "lifecycle": {"state": "pending", "attempt": 0, "terminal": False},
            "idempotency_key": request_id,
        }
        result["dispatch_address"] = f"content-generation.dispatch-request::{request_id}"
        if isinstance(recipe.get("verified_continuation"), dict):
            result["dispatch_request"]["verified_continuation"] = recipe["verified_continuation"]
    pathlib.Path(args.output_json).parent.mkdir(parents=True, exist_ok=True)
    pathlib.Path(args.output_json).write_text(json.dumps(result, ensure_ascii=False), encoding="utf-8")
    print(json.dumps(result, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
