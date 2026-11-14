#!/usr/bin/env python3
#
# File: packages/ai-records-producer/do-work/process-scripts/make-ai-records-from-command-output.py
#
# =============================================================================
# PURPOSE
# =============================================================================
#
# Parse the stdout of the AI CLI (a compute.process ProcessResult) into
# structured records. The output shape is controlled by the DATA field
# `output_kind` from the request:
#
#   output_kind='note'  →  [{kind:'note', text: <step string>}, ...]
#
# New output kinds are added as branches keyed by output_kind — zero changes
# to the workflow or the command-request script (L069/L090).
#
# =============================================================================
# NON-NEGOTIABLE INVARIANTS
# =============================================================================
#
# 1. Never executes an AI CLI or any OS process.
# 2. No fabricated items — ever. Empty / unparseable → honest error record.
# 3. output_kind controls item shape; no hardcoded 'note' assumption.
# 4. Error records carry a machine-readable `code` field.
# 5. Pure stdlib — no third-party dependencies.

from __future__ import annotations

import argparse
import base64
import datetime
import json
import pathlib
import re
from typing import Any


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def as_string(value: Any) -> str | None:
    return value if isinstance(value, str) and value else None


def now() -> str:
    return datetime.datetime.now(datetime.timezone.utc).isoformat().replace("+00:00", "Z")


def address_token(value: Any, fallback: str) -> str:
    raw = str(value) if value not in (None, "") else fallback
    return "".join(ch if ch.isalnum() or ch in "._:-" else "_" for ch in raw)


def read_json(path: str, fallback: Any) -> Any:
    try:
        return json.loads(pathlib.Path(path).read_text(encoding="utf-8"))
    except Exception:
        return fallback


def decode_base64(value: str) -> str:
    try:
        return base64.b64decode(value).decode("utf-8", errors="replace")
    except Exception:
        return ""


def captured_fd_text(process_result: dict[str, Any], fd: int) -> str:
    captures = process_result.get("captured_fds")
    if not isinstance(captures, list):
        return ""
    for capture in captures:
        if isinstance(capture, dict) and capture.get("fd") == fd:
            value = capture.get("bytes")
            return decode_base64(value) if isinstance(value, str) else ""
    return ""


def process_exit_code(process_result: dict[str, Any]) -> int | None:
    termination = process_result.get("termination")
    if not isinstance(termination, dict) or termination.get("kind") != "exited":
        return None
    code = termination.get("code")
    return code if isinstance(code, int) else None


# ---------------------------------------------------------------------------
# Cloud (http) transport reply extraction (L090 generic: response_path is DATA).
#
# For a cloud model, step_7's output is an http-client response
# ({status_code, headers, body}) — NOT a ProcessResult. The completion text
# lives in the response body at the DATA `response_path`, so extraction names no
# provider (OpenAI 'choices.0.message.content', Gemini
# 'candidates.0.content.parts.0.text', anything else — all just DATA paths).
# ---------------------------------------------------------------------------

def navigate_path(obj: Any, path: str) -> Any:
    """Walk a dotted path over dict keys and list indices; None if any hop misses."""
    cur = obj
    for part in path.split("."):
        if isinstance(cur, list):
            try:
                cur = cur[int(part)]
            except (ValueError, IndexError):
                return None
        elif isinstance(cur, dict):
            cur = cur.get(part)
        else:
            return None
        if cur is None:
            return None
    return cur


def http_body_text(transport_output: dict[str, Any]) -> str:
    """Decode an http-client response body (Vec<u8> list, or base64/raw string)."""
    body = transport_output.get("body")
    if isinstance(body, list):
        try:
            return bytes(int(b) & 0xFF for b in body).decode("utf-8", errors="replace")
        except Exception:
            return ""
    if isinstance(body, str):
        decoded = decode_base64(body)
        return decoded if decoded else body
    return ""


def response_extract_matches(value: Any, conditions: Any) -> bool:
    if not isinstance(conditions, list):
        return True
    for condition in conditions:
        if not isinstance(condition, dict) or not isinstance(condition.get("path"), list):
            return False
        if navigate_path_list(value, condition["path"]) != condition.get("equals"):
            return False
    return True


def extract_response_spec(value: Any, spec: Any) -> Any:
    """Evaluate the canonical DATA response_extract shape without provider branches."""
    if not isinstance(spec, dict):
        return None
    source = value.get(spec.get("from")) if isinstance(value, dict) and isinstance(spec.get("from"), str) else value
    candidates = source if isinstance(source, list) else [source]
    conditions = spec.get("where", spec.get("when"))
    for candidate in candidates:
        if candidate is None or not response_extract_matches(candidate, conditions):
            continue
        nested = spec.get("then")
        selected = extract_response_spec(candidate, nested) if isinstance(nested, dict) else navigate_path_list(candidate, spec.get("select_path", []))
        if selected is not None:
            return selected
    return None


def extract_http_completion(
    transport_output: dict[str, Any],
    response_path: str,
    response_extract: dict[str, Any] | None = None,
) -> tuple[str | None, str | None]:
    """Return (completion_text, service_error_message) from a cloud response body."""
    text = http_body_text(transport_output)
    if not text:
        return None, None
    try:
        obj = json.loads(text)
    except Exception:
        return text, None  # non-JSON body: treat the whole body as the reply
    value = navigate_path(obj, response_path) if response_path else extract_response_spec(obj, response_extract)
    if isinstance(value, str) and value.strip():
        return value, None
    # No completion at response_path — surface the service's own error message.
    if isinstance(obj, dict):
        err = obj.get("error")
        if isinstance(err, dict):
            return None, as_string(err.get("message"))
        if isinstance(err, str):
            return None, err
    return None, None


# ---------------------------------------------------------------------------
# Streaming transcript reconstruction (stream_parse_spec) — mirrors the
# process-session live extractor byte-for-byte so a completed run's items[]
# read the SAME assistant text a live subscriber saw token-by-token. Pure
# DATA-driven (L090): the spec names no CLI, no provider, no output_kind — it
# is forwarded verbatim off the chat_launch adapter row and only walked here,
# never branched on by identity.
# ---------------------------------------------------------------------------

def navigate_path_list(obj: Any, path: list[Any]) -> Any:
    """Walk a list-of-keys path over dict keys and list indices; None if any hop misses."""
    cur = obj
    for part in path:
        if isinstance(cur, list):
            try:
                cur = cur[int(part)]
            except (ValueError, IndexError, TypeError):
                return None
        elif isinstance(cur, dict):
            cur = cur.get(part)
        else:
            return None
        if cur is None:
            return None
    return cur


def _stream_event_matches(event_obj: Any, when: Any) -> bool:
    """True when every {path, equals} condition in `when` holds against event_obj."""
    if not isinstance(when, list) or not when:
        return False
    for condition in when:
        if not isinstance(condition, dict):
            return False
        path = condition.get("path")
        if not isinstance(path, list):
            return False
        if navigate_path_list(event_obj, path) != condition.get("equals"):
            return False
    return True


def extract_stream_parse_spec_text(stdout: str, spec: Any) -> str | None:
    """Replay a stream-json CLI's captured JSONL stdout through the SAME
    `stream_parse_spec` a live subscriber reads (process-session's stream-text
    extractor), concatenating every matched textPaths value in emission order.
    Returns None when the spec is absent/malformed or nothing matched — the
    caller falls back to raw stdout (byte-identical to a plain-prose CLI)."""
    if not isinstance(spec, dict) or spec.get("lineFormat") != "jsonl":
        return None
    events = spec.get("events")
    if not isinstance(events, list) or not events:
        return None
    chunks: list[str] = []
    for raw_line in stdout.splitlines():
        line = raw_line.strip()
        if not line:
            continue
        try:
            event_obj = json.loads(line)
        except Exception:
            continue
        for event_spec in events:
            if not isinstance(event_spec, dict):
                continue
            if not _stream_event_matches(event_obj, event_spec.get("when")):
                continue
            for text_path in event_spec.get("textPaths") or []:
                if not isinstance(text_path, list):
                    continue
                value = navigate_path_list(event_obj, text_path)
                if isinstance(value, str):
                    chunks.append(value)
    return "".join(chunks) if chunks else None


# ---------------------------------------------------------------------------
# stdout → raw items extraction
# ---------------------------------------------------------------------------

def repair_llm_json(text: str) -> str:
    """Escape stray control chars and unescaped inner double-quotes inside JSON
    string values so a model's imperfectly-escaped JSON parses.

    WHY (L055 root): the producer is a GENERIC handler (L090) that asks ANY
    free-text CLI (claude, codex, ...) to emit JSON. Models embed long prose
    (markdown bodies, quotes, newlines) inside string values and NON-
    DETERMINISTICALLY forget to escape an inner `"` or a literal newline —
    producing JSON that json.loads rejects (e.g. `... only "catches up" and ...`).
    This is the universal LLM→JSON malformation category; a tolerant reader kills
    the whole category (L063) rather than instance-patching one article.

    Algorithm: single left-to-right pass, string-aware. A `"` inside a string
    TERMINATES it only when the next non-ws char is a token that can legally
    follow a JSON string value/key — ':' (it was a key), '}' ']' or end, or ','
    THEN a '"' (next key / next string). Any other quote is literal prose and is
    escaped. Control chars (<0x20) inside strings are escaped. Text OUTSIDE
    strings is copied verbatim, so already-valid JSON round-trips byte-identically
    (the repaired string is only ever handed to json.loads AFTER a strict parse
    already failed — valid input never reaches this path)."""
    out: list[str] = []
    i = 0
    n = len(text)
    in_str = False
    while i < n:
        c = text[i]
        if not in_str:
            out.append(c)
            if c == '"':
                in_str = True
            i += 1
            continue
        if c == "\\":  # keep existing escape sequences intact (two chars)
            out.append(c)
            if i + 1 < n:
                out.append(text[i + 1])
                i += 2
            else:
                i += 1
            continue
        if c == '"':
            j = i + 1
            while j < n and text[j] in " \t\r\n":
                j += 1
            nxt = text[j] if j < n else ""
            term = False
            if nxt in (":", "}", "]", ""):
                term = True
            elif nxt == ",":
                k = j + 1
                while k < n and text[k] in " \t\r\n":
                    k += 1
                if k >= n or text[k] == '"':
                    term = True
            if term:
                out.append('"')
                in_str = False
            else:
                out.append('\\"')
            i += 1
            continue
        o = ord(c)
        if o < 0x20:
            out.append({10: "\\n", 13: "\\r", 9: "\\t", 8: "\\b", 12: "\\f"}.get(o, "\\u%04x" % o))
            i += 1
            continue
        out.append(c)
        i += 1
    return "".join(out)


def loads_tolerant(text: str) -> Any:
    """json.loads, but on failure retry once through repair_llm_json. Valid JSON
    takes the fast path untouched; only malformed model output is repaired. Raises
    like json.loads when even the repaired text is unparseable (callers catch)."""
    try:
        return json.loads(text)
    except Exception:
        return json.loads(repair_llm_json(text))


def _extract_balanced_json(text: str, open_ch: str, close_ch: str) -> list[Any]:
    """
    Find top-level balanced open_ch..close_ch spans inside noisy CLI output and
    return every span that parses as JSON. Required for CLIs (e.g. `codex exec`)
    that wrap a BARE JSON object/array in preamble ("sandbox:", "session id:",
    "codex") + a "tokens used" footer + a repeat of the JSON — none of which is a
    markdown fence, so the fence/whole-text parses miss it. String-aware: braces
    inside JSON string literals never break the balance count.
    """
    results: list[Any] = []
    depth = 0
    start = -1
    in_str = False
    esc = False
    for i, ch in enumerate(text):
        if in_str:
            if esc:
                esc = False
            elif ch == "\\":
                esc = True
            elif ch == '"':
                in_str = False
            continue
        if ch == '"':
            in_str = True
        elif ch == open_ch:
            if depth == 0:
                start = i
            depth += 1
        elif ch == close_ch and depth > 0:
            depth -= 1
            if depth == 0 and start >= 0:
                try:
                    results.append(json.loads(text[start : i + 1]))
                except Exception:
                    pass
                start = -1
    return results


def extract_json_array(text: str) -> list[Any]:
    """
    Best-effort extraction of a JSON array from raw AI stdout.
    Tolerates: bare JSON array, markdown fences, numbered/bulleted list.
    """
    text = text.strip()
    if not text:
        return []
    try:
        parsed = json.loads(text)
        if isinstance(parsed, list):
            return parsed
    except Exception:
        pass
    # Markdown code fence
    match = re.search(r"```(?:json)?\s*([\s\S]*?)\s*```", text)
    if match:
        try:
            parsed = json.loads(match.group(1))
            if isinstance(parsed, list):
                return parsed
        except Exception:
            pass
    # Bare JSON array embedded in noisy CLI output (codex preamble/footer). Must
    # run BEFORE line-splitting, else the noise lines become bogus items.
    arrays = [c for c in _extract_balanced_json(text, "[", "]") if isinstance(c, list)]
    if arrays:
        return max(arrays, key=len)
    # Numbered / bulleted list → treat each non-empty line as an item
    lines = []
    for line in text.splitlines():
        stripped = line.strip()
        if not stripped:
            continue
        cleaned = re.sub(r"^[\-\*•]\s+", "", stripped)
        cleaned = re.sub(r"^\d+\.\s+", "", cleaned)
        if cleaned:
            lines.append(cleaned)
    return lines if lines else []


def parse_json_object(text: str) -> dict[str, Any] | None:
    """
    If the AI stdout is a single JSON OBJECT (bare or in a ```json fence), return
    it; otherwise None. Some output kinds are naturally ONE structured object
    (e.g. a summary carrying its own notes), not an array of items. The producer
    preserves codex's own fields verbatim as one item — it names NO domain field
    (L090): the consumer reads the natural field names it asked the model for.
    """
    text = text.strip()
    if not text:
        return None
    try:
        parsed = loads_tolerant(text)
        if isinstance(parsed, dict):
            return parsed
    except Exception:
        pass
    match = re.search(r"```(?:json)?\s*([\s\S]*?)\s*```", text)
    if match:
        try:
            parsed = loads_tolerant(match.group(1))
            if isinstance(parsed, dict):
                return parsed
        except Exception:
            pass
    # Bare JSON object embedded in noisy CLI output (codex prints the object,
    # then a "tokens used" footer, then repeats it). Scan for balanced {...}
    # spans and return the LARGEST dict (the real payload, not a stray metadata
    # object in the preamble).
    objects = [c for c in _extract_balanced_json(text, "{", "}") if isinstance(c, dict)]
    if objects:
        return max(objects, key=lambda d: len(json.dumps(d)))
    return None


def top_level_json_array(text: str) -> list[Any] | None:
    """A GENUINE top-level JSON array from stdout (bare, ```-fenced, or a balanced
    [...] span in noisy CLI output) — but NOT the line-splitting fallback. Used to give
    a real array PRECEDENCE over the single-object path, so an array of objects (the
    reconcile [{memberId,text}, ...] shape) is not collapsed to one item by
    parse_json_object's brace-scan. Returns None when there is no real array (a single
    object, or a bulleted/numbered list) so the existing paths handle those unchanged."""
    text = text.strip()
    if not text:
        return None
    try:
        parsed = loads_tolerant(text)
        if isinstance(parsed, list):
            return parsed
    except Exception:
        pass
    match = re.search(r"```(?:json)?\s*([\s\S]*?)\s*```", text)
    if match:
        try:
            parsed = loads_tolerant(match.group(1))
            if isinstance(parsed, list):
                return parsed
        except Exception:
            pass
    arrays = [c for c in _extract_balanced_json(text, "[", "]") if isinstance(c, list)]
    return max(arrays, key=len) if arrays else None


def parse_text_items(extracted: list[Any]) -> list[str]:
    """Flatten extracted items into strings."""
    texts: list[str] = []
    for item in extracted:
        if isinstance(item, str) and item.strip():
            texts.append(item.strip())
        elif isinstance(item, dict):
            for field in ("text", "title", "description", "step", "content"):
                val = item.get(field)
                if isinstance(val, str) and val.strip():
                    texts.append(val.strip())
                    break
    return texts


# ---------------------------------------------------------------------------
# output_kind → record items
# ---------------------------------------------------------------------------

def build_items_for_kind(output_kind: str, texts: list[str]) -> list[dict[str, Any]]:
    """
    Convert text strings into item dicts keyed by output_kind.
    New kinds are added as branches here — never in the workflow (L090).
    """
    if output_kind == "note":
        return [{"kind": "note", "text": text} for text in texts]
    if output_kind == "message":
        return [{"kind": "message", "text": text, "role": "assistant"} for text in texts]
    # Generic fallback: emit kind as DATA, text as text
    return [{"kind": output_kind, "text": text} for text in texts]


def item_text_of(elem: Any) -> str | None:
    """The display text of one extracted element (a string, or a dict's first text-like field)."""
    if isinstance(elem, str):
        return elem.strip() or None
    if isinstance(elem, dict):
        for field in ("text", "title", "description", "step", "content"):
            val = elem.get(field)
            if isinstance(val, str) and val.strip():
                return val.strip()
    return None


def build_items_from_extracted(output_kind: str, extracted: list[Any]) -> list[dict[str, Any]]:
    """
    Build result items from the extracted array while preserving every structured
    field returned by the configured producer. `text` is derived for consumers
    that need a display string, while identity/scoring/domain fields remain opaque
    DATA. The producer stamps only `kind`; it does not enumerate downstream fields.
    """
    items: list[dict[str, Any]] = []
    for elem in extracted:
        if isinstance(elem, dict) and elem:
            # L090 structural passthrough: preserve the model's OWN fields verbatim
            # (consistent with the single-object path `{kind, **structured_obj}`), so a
            # structured output_kind (e.g. tribe-match's {members,score,rationale}) is
            # NOT discarded by flatten-to-text. `text` is still derived (item_text_of)
            # for back-compat consumers that read it; a dict with no text-like field
            # keeps text="" and its structured fields survive. `kind` is always stamped.
            item = {"kind": output_kind, "text": item_text_of(elem) or "", **elem}
            item["kind"] = output_kind  # elem must not override the record kind
            items.append(item)
            continue
        text = item_text_of(elem)
        if text is None:
            continue
        built = build_items_for_kind(output_kind, [text])
        if built:
            items.append(built[0])
    return items


def stamp_item_provenance(items: list[dict[str, Any]], resolved_agent: Any) -> list[dict[str, Any]]:
    """
    Stamp fail-closed provenance onto every result item (contract::result item_contract):
    - model_provenance_ref: derived from the resolved agent the producer ALREADY
      knows for this run — surfacing existing knowledge, never new logic.
    - confidence: pass-through ONLY. If the model emitted a numeric confidence on
      the item, it is normalized to float; it is NEVER fabricated here. Consumers
      that require confidence (content-gate thresholds) fail closed on absence.
    - evidence_refs: pass-through list; defaults to [] so consumers can always read it.
    """
    agent_ref = None
    if isinstance(resolved_agent, dict):
        agent_ref = resolved_agent.get("ref") or resolved_agent.get("id") or resolved_agent.get("agent_ref")
    elif isinstance(resolved_agent, str) and resolved_agent:
        agent_ref = resolved_agent
    stamped: list[dict[str, Any]] = []
    for item in items:
        row = dict(item)
        if agent_ref and "model_provenance_ref" not in row:
            row["model_provenance_ref"] = agent_ref
        if "confidence" in row:
            try:
                row["confidence"] = float(row["confidence"])
            except (TypeError, ValueError):
                # Non-numeric confidence is meaningless for gating — drop it so
                # consumers fail closed instead of comparing against junk.
                row.pop("confidence")
        if not isinstance(row.get("evidence_refs"), list):
            row["evidence_refs"] = []
        stamped.append(row)
    return stamped


# ---------------------------------------------------------------------------
# Record builders
# ---------------------------------------------------------------------------

def build_result_record(
    request_id: str,
    target_group_ref: Any,
    output_kind: str,
    items: list[dict[str, Any]],
    instruction_observability: dict[str, Any] | None = None,
    prompt_hash: str | None = None,
    addressed_input_snapshot: dict[str, Any] | None = None,
) -> dict[str, Any]:
    return {
        "address": f"package::ai-records-producer::result::{address_token(request_id, 'request')}",
        # L126 exhaust-off: ai-records-producer.result is operational exhaust no user
        # tab renders (content-pool feeds EXCLUDE it via not_equals; readers are
        # address-based read-current OR the both-paths ethos-content-worker findKind).
        # Keep it OFF the shared ~34.7MB published-record aggregate — mirrors the
        # sibling .error/run kinds already on their own indexes in this file.
        "path": ["current-item", "ai-records-producer-result-index"],
        "payload": {
            "kind": "ai-records-producer.result",
            "request_id": request_id,
            "status": "completed",
            "target_group_ref": target_group_ref,
            "output_kind": output_kind,
            "instruction_observability": instruction_observability,
            "prompt_hash": prompt_hash,
            "addressed_input_snapshot": addressed_input_snapshot,
            "items": items,
            "error_code": None,
            "completed_at": now(),
        },
    }


def build_error_record(
    request_id: str,
    target_group_ref: Any,
    code: str,
    message: str,
    observed_at: str,
    *,
    retryable: bool = False,
    model_id: str | None = None,
    cli_id: str | None = None,
    provider_model_id: str | None = None,
) -> dict[str, Any]:
    return {
        "address": f"package::ai-records-producer::error::{address_token(request_id, 'request')}",
        "path": ["current-item", "ai-records-producer-error-index"],
        "payload": {
            "kind": "ai-records-producer.error",
            "request_id": request_id,
            "target_group_ref": target_group_ref,
            "code": code,
            "message": message,
            "retryable": retryable,
            "model_id": model_id,
            "cli_id": cli_id,
            "provider_model_id": provider_model_id,
            "observed_at": observed_at,
        },
    }


def build_audit_record(
    request_id: str,
    resolved_agent: Any,
    output_kind: str,
    instruction_observability: dict[str, Any] | None = None,
    prompt_hash: str | None = None,
) -> dict[str, Any]:
    """
    Write one ai-execution-run audit record (required field: id).
    Per §8.5: address = package::ai-records-producer::run::{request_id}.
    """
    return {
        "address": f"package::ai-records-producer::run::{address_token(request_id, 'request')}",
        "path": ["current-item", "ai-execution-run-index"],
        "payload": {
            "kind": "ai-execution-run",
            "id": request_id,
            "agent_ref": resolved_agent,
            "output_kind": output_kind,
            "instruction_observability": instruction_observability,
            "prompt_hash": prompt_hash,
            "started_at": now(),
        },
    }


def build_streaming_started_record(
    request_id: str,
    target_group_ref: Any,
    output_kind: str,
    session_id: str,
    event_stream_address: str,
    stream_parse_spec: Any = None,
    instruction_observability: dict[str, Any] | None = None,
    prompt_hash: str | None = None,
) -> dict[str, Any]:
    """
    LIVE STREAMING transport (compute.process_session): the run has only just
    STARTED — there is no stdout/exit_code to parse yet, and there will be none
    until the caller has finished subscribing to the live feed. This writes to
    the SAME address as build_result_record (one result pointer per request_id,
    regardless of transport — L090: the shape self-describes via `status`), so
    a caller does not need to know in advance which transport mode ran.
    `items` is honestly empty — no items exist yet; fabricating a partial item
    here would violate invariant #2 (no fabricated items). The eventual finished
    text lives entirely in the live feed at event_stream_address, which the
    caller subscribes to directly; this producer's job for a streaming run ends
    here.

    NOTE on event_stream_address vs event_feed_address (both fields exist on
    the Rust ProcessSessionSnapshot — architect/crates/execution-types/src/
    process_session_types.rs lines 189-211): event_feed_address is the bounded
    HEAD (a snapshot pointer); event_stream_address is the per-event delta
    append lane that live subscribers TAIL for output events (per that struct's
    own doc comment). A live token-by-token subscriber MUST use
    event_stream_address — event_feed_address does not carry incremental
    tokens.

    NOTE on `final` (the generic poll-continuation boolean): the composition
    poll rail (run-action-affordance) decides keep-polling-vs-done purely off
    this ONE physics boolean — never off `status`, which is cosmetic/human-only
    (a closed-enum leak the gauntlet caught and removed from the rail's read
    path). `final: False` here is the ONLY thing that keeps a streaming interim
    from being mistaken for the terminal result. build_result_record and
    build_error_record carry no `final` key at all — absence means terminal,
    so the one-shot (non-streaming) path stays byte-identical.

    NOTE on `stream_parse_spec` and WHICH payload actually lands at the shared
    result address (verified against the workflow definition, not assumed):
    the top-level workflow step chain in things-to-store-and-run.json writes
    to `package::ai-records-producer::result::{request_id}` from `result_payload`
    (the dict main() returns as `out["result_payload"]`), via a `write` step
    that runs AFTER the `records[]` loop step. This record's own `address`
    happens to be that SAME shared result address (by design, one result
    pointer per request_id — see the docstring paragraph above), so the loop's
    per-record write of THIS payload (through the `action:write-ai-records-
    producer-record` sub-definition) is superseded moments later by the
    top-level write's `result_payload`-derived payload — confirmed by this
    script's own comment on `test_non_streaming_completed_run_carries_
    completed_status()`: "loop/sub-definition writes do NOT persist to
    queryable state — only top-level workflow writes do; verified live
    2026-06-27." So for THIS record, `result_payload` (already correctly
    carrying `stream_parse_spec` before this field was added here — see
    `streaming_result_payload` in main()) is the payload
    readProcessSessionStreamHandle() actually reads at the queryable address,
    not this function's returned payload.
    `stream_parse_spec` is still forwarded here — as every other field on this
    payload already is — for SSOT: `records[]` is a generic multi-record write
    mechanism shared with `build_error_record`/`build_audit_record`, whose
    addresses (`::error::`/`::run::`) do NOT collide with the top-level write
    and so DO persist their `records[]` payload verbatim. Keeping this
    function's payload a complete, field-for-field match of the same
    streaming-result shape (rather than a partial one that happens to work
    only because this particular address gets overwritten) avoids a payload
    that is silently wrong the moment its address strategy changes.
    """
    payload: dict[str, Any] = {
        "kind": "ai-records-producer.result",
        "request_id": request_id,
        "target_group_ref": target_group_ref,
        "output_kind": output_kind,
        "status": "streaming",
        "final": False,
        "session_id": session_id,
        "event_stream_address": event_stream_address,
        "stream_parse_spec": stream_parse_spec,
        "instruction_observability": instruction_observability,
        "prompt_hash": prompt_hash,
        "items": [],
        "completed_at": now(),
    }
    return {
        "address": f"package::ai-records-producer::result::{address_token(request_id, 'request')}",
        # L126 exhaust-off: ai-records-producer.result is operational exhaust no user
        # tab renders (content-pool feeds EXCLUDE it via not_equals; readers are
        # address-based read-current OR the both-paths ethos-content-worker findKind).
        # Keep it OFF the shared ~34.7MB published-record aggregate — mirrors the
        # sibling .error/run kinds already on their own indexes in this file.
        "path": ["current-item", "ai-records-producer-result-index"],
        "payload": payload,
    }


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------

def main() -> int:
    parser = argparse.ArgumentParser(
        description="Parse AI CLI stdout into ai-records-producer result/error records."
    )
    parser.add_argument("--request-json", required=True,
                        help="Path to the request JSON written by make-ai-records-command-request.py")
    parser.add_argument("--command-output-json", default="",
                        help="(legacy) Path to JSON file holding the base64-encoded ProcessResult")
    parser.add_argument("--stdout-text", default="",
                        help="The CLI stdout TEXT (engine derefs output.captured_fds[fd=1] to decoded text). "
                             "Preferred over --command-output-json: a ProcessResult's stdout is a "
                             "bytes-REF, not content, so stringifying the whole result yields no text.")
    parser.add_argument("--stderr-text", default="")
    parser.add_argument("--exit-code", default="")
    parser.add_argument("--http-status", default="",
                        help="(cloud http transport) step_7 http-client response status_code. "
                             "Bound directly (output.status_code) — the WHOLE http reply cannot be "
                             "stringified (its body is opaque bytes -> a bytes-ref), so status and body "
                             "are passed as separate direct-field bindings.")
    parser.add_argument("--http-body-json", default="",
                        help="(cloud http transport) step_7 http-client response body as a JSON array "
                             "of bytes (output.body). The reply lives at request.transport.response_path.")
    parser.add_argument("--session-id", default="",
                        help="(process_session transport) step_7 compute.process_session "
                             "SessionStarted.session_id. Presence of this OR --event-stream-address means "
                             "the run is LIVE STREAMING: the session has only just started, there is no "
                             "stdout/exit_code to parse yet, and this script publishes a status:'streaming' "
                             "pointer record immediately so the caller can subscribe to the live feed "
                             "instead of waiting for exit.")
    parser.add_argument("--event-stream-address", default="",
                        help="(process_session transport) step_7 compute.process_session "
                             "SessionStarted.snapshot.event_stream_address — the per-event delta append "
                             "lane a live subscriber TAILS for output events (NOT "
                             "snapshot.event_feed_address, which is only the bounded HEAD pointer — see "
                             "ProcessSessionSnapshot's own doc comment in process_session_types.rs). "
                             "This is the address the caller subscribes to for live tokens.")
    parser.add_argument("--output-json", required=True,
                        help="Path for the output records JSON")
    args = parser.parse_args()

    request: dict[str, Any] = read_json(args.request_json, {})
    if not isinstance(request, dict):
        request = {}

    # Pull request context
    request_id = as_string(request.get("request_id")) or "ai-records-producer"
    target_group_ref = request.get("target_group_ref")
    output_kind = as_string(request.get("output_kind")) or "note"
    resolved_agent = request.get("resolved_agent")
    instruction_observability = (
        request.get("instruction_observability")
        if isinstance(request.get("instruction_observability"), dict)
        else None
    )
    prompt_hash = as_string(request.get("prompt_hash"))
    addressed_input_snapshot = (
        request.get("addressed_input_snapshot")
        if isinstance(request.get("addressed_input_snapshot"), dict)
        else None
    )
    observed_at = now()

    # LIVE STREAMING short-circuit (process_session transport, L090 self-describing
    # dispatch on the SAME result address every transport writes to): presence of
    # session_id/event_stream_address means compute.process_session already returned
    # SessionStarted — the session is still running and streaming independently, so
    # there is no stdout/exit_code/http reply to parse. Publish a status:'streaming'
    # pointer record IMMEDIATELY (session_id + event_stream_address) so the caller can
    # subscribe to live tokens now instead of blocking until exit. This producer's
    # job for a streaming run ends here — turning the eventual token stream into
    # finished artifacts is the CALLER's job (composition/chat via insertResultArtifacts),
    # never re-owned by this generic invocation primitive (No-God-Package).
    #
    # event_stream_address (NOT event_feed_address) is deliberate: the Rust
    # ProcessSessionSnapshot carries both fields (process_session_types.rs
    # lines 189-211) — event_feed_address is the bounded HEAD snapshot
    # pointer, event_stream_address is the per-event delta append lane a live
    # subscriber tails for output events. Using the HEAD pointer here would
    # silently break live token delivery (no incremental tokens on that lane).
    session_id = as_string(args.session_id)
    event_stream_address = as_string(args.event_stream_address)
    if session_id or event_stream_address:
        streaming_record = build_streaming_started_record(
            request_id, target_group_ref, output_kind, session_id, event_stream_address,
            stream_parse_spec=request.get("stream_parse_spec"),
            instruction_observability=instruction_observability,
            prompt_hash=prompt_hash,
        )
        streaming_result_payload = {
            "kind": "ai-records-producer.result",
            "request_id": request_id,
            "target_group_ref": target_group_ref,
            "output_kind": output_kind,
            "model_id": as_string(request.get("model_id")),
            "cli_id": as_string(request.get("cli_id")),
            "status": "streaming",
            # The generic poll-continuation boolean the composition rail
            # (run-action-affordance) actually reads to decide keep-polling-
            # vs-done — NOT `status` (a closed enum the gauntlet removed
            # from the rail's read path). Absent on the completed/error
            # result_payload below == terminal, so the one-shot path stays
            # byte-identical to before streaming existed.
            "final": False,
            "session_id": session_id,
            "event_stream_address": event_stream_address,
            # Forwarded from the request (which read it off the CLI's chat_launch):
            # a stream-json CLI carries a parse-spec so the live subscriber can pull
            # text out of raw JSONL; a plain-prose CLI omits it -> None -> raw stdout
            # is the text. Pure DATA pass-through, never interpreted here (L090).
            "stream_parse_spec": request.get("stream_parse_spec"),
            "instruction_observability": instruction_observability,
            "prompt_hash": prompt_hash,
            "addressed_input_snapshot": addressed_input_snapshot,
            "items": [],
            "error_code": None,
            "error_message": None,
            "completed_at": observed_at,
        }
        streaming_output = {
            "kind": "ai-records-producer.records-from-command-run",
            "request_id": request_id,
            "target_group_ref": target_group_ref,
            "output_kind": output_kind,
            "items": [],
            "error_code": None,
            "error_message": None,
            "result_payload": streaming_result_payload,
            "records": [streaming_record],
        }
        print(f"[ai-records-producer] streaming session started session_id={session_id}")
        pathlib.Path(args.output_json).parent.mkdir(parents=True, exist_ok=True)
        pathlib.Path(args.output_json).write_text(
            json.dumps(streaming_output, ensure_ascii=False), encoding="utf-8"
        )
        return 0

    # The model transport is DATA-selected (compute.process CLI | http-client cloud).
    # A cloud transport carries request.transport.response_path — the reply lives in
    # the http response body there, so we normalize it into `stdout` and reuse the
    # SAME output_kind item-building below (one generic downstream, L090).
    transport = request.get("transport") if isinstance(request.get("transport"), dict) else {}
    response_path = as_string(transport.get("response_path")) or ""
    response_extract = transport.get("response_extract") if isinstance(transport.get("response_extract"), dict) else None

    # Decode ProcessResult. Prefer the explicit content args (root argv bindings
    # that deref the bytes refs); fall back to the legacy command-output file.
    retryable = False
    transport_error_code: str | None = None
    provider_model_id: str | None = None
    if response_path or response_extract is not None:
        # Reassemble the http reply from the two direct-field bindings (status +
        # body). The body arrives as a JSON array of bytes; http_body_text already
        # decodes a Vec<u8> list. status/body default to "" for the process
        # transport (the lookup+if_null bindings resolve missing keys to defaults).
        try:
            body_val = json.loads(args.http_body_json) if args.http_body_json else None
        except Exception:
            body_val = None
        transport_output = {"status_code": args.http_status, "body": body_val}
        try:
            body_object = json.loads(http_body_text(transport_output))
        except Exception:
            body_object = None
        if isinstance(body_object, dict):
            provider_model_id = as_string(body_object.get("model"))
        status = transport_output.get("status_code")
        try:
            status_int = int(status) if status is not None else 0
        except Exception:
            status_int = 0
        completion, service_error = extract_http_completion(transport_output, response_path, response_extract)
        if status_int and not (200 <= status_int < 300):
            provider_error_type = None
            if isinstance(body_object, dict):
                error_value = body_object.get("error")
                if isinstance(error_value, dict):
                    provider_error_type = error_value.get("type")
                if provider_error_type is None:
                    provider_error_type = body_object.get("type")
            retryable = status_int == 429 and provider_error_type == "rate_limit_error"
            transport_error_code = "rate_limited" if retryable else "command_failed"
            exit_code = 1
            stdout = ""
            stderr = service_error or f"The model service answered {status_int}."
        elif completion is None:
            exit_code = 1
            stdout = ""
            stderr = service_error or "The model service returned no reply."
        else:
            exit_code = 0
            stdout = completion
            stderr = ""
    elif args.stdout_text or args.stderr_text or args.exit_code:
        exit_code = int(args.exit_code) if str(args.exit_code).strip().lstrip("-").isdigit() else 0
        stdout = args.stdout_text or ""
        stderr = args.stderr_text or ""
    else:
        command_output = read_json(args.command_output_json, {})
        if not isinstance(command_output, dict):
            command_output = {}
        exit_code = process_exit_code(command_output)
        stdout = captured_fd_text(command_output, 1)
        stderr = captured_fd_text(command_output, 2)

    # A stream-json CLI's captured stdout is raw JSONL transport frames, not
    # assistant text — replay it through the SAME stream_parse_spec a live
    # subscriber read (process-session's extractor) so a completed run's
    # items[] carry the identical text a viewer already saw token-by-token.
    # No-op (byte-identical passthrough) for any CLI whose request carries no
    # spec — a plain-prose CLI's stdout is untouched (L090 self-describing).
    reconstructed_stdout = extract_stream_parse_spec_text(stdout, request.get("stream_parse_spec"))
    if reconstructed_stdout is not None:
        stdout = reconstructed_stdout

    records: list[dict[str, Any]] = []
    # Hoisted to the top level of the output so a TOP-LEVEL workflow write step can
    # bind them directly (loop/sub-definition writes do NOT persist to queryable
    # state — only top-level workflow writes do; verified live 2026-06-27).
    result_items: list[dict[str, Any]] = []
    error_code: str | None = None
    error_message: str | None = None

    if exit_code is not None and exit_code != 0:
        error_code = transport_error_code or "command_failed"
        error_message = stderr.strip() or stdout.strip() or f"Command exited with code {exit_code}"
        records.append(build_error_record(
            request_id, target_group_ref, error_code, error_message, observed_at,
            retryable=retryable,
            model_id=as_string(request.get("model_id")),
            cli_id=as_string(request.get("cli_id")),
            provider_model_id=provider_model_id,
        ))
    else:
        if output_kind == "message":
            # A conversational reply is raw assistant text, not a JSON array of
            # items. The whole stdout is the one message. (note/variation expect
            # the CLI to emit a JSON array; message does not.)
            stripped = stdout.strip()
            result_items = build_items_for_kind(output_kind, [stripped]) if stripped else []
        else:
            real_array = top_level_json_array(stdout)
            structured_obj = parse_json_object(stdout)
            # A top-level JSON ARRAY of 2+ items takes PRECEDENCE over the single-object
            # path: parse_json_object's brace-scan fallback would otherwise steal the first
            # object out of an array, collapsing [{memberId,text}, {memberId,text}, ...] into
            # ONE item — silently breaking reconcile (and any multi-object array). A genuine
            # single object (or a 1-item array) still preserves all fields verbatim below.
            # An inner array (e.g. an article object's blocks[]) must not steal
            # precedence from the object that CONTAINS it: prefer the array only
            # when it is the larger structure — a genuine top-level array always
            # is; a nested member never is (T2 incident: codex's article object
            # was shredded into per-block prose items for 6 runs).
            if (
                real_array is not None
                and len(real_array) > 1
                and (
                    structured_obj is None
                    or len(json.dumps(real_array)) >= len(json.dumps(structured_obj))
                )
            ):
                # Preserve an echoed memberId per item (board reconcile edit-in-place);
                # identical to the old flatten when no memberId is present (back-compat).
                result_items = build_items_from_extracted(output_kind, real_array)
            elif structured_obj is not None:
                # ONE structured object (e.g. a summary with its own notes). Emit
                # a single item preserving codex's fields verbatim — the producer
                # names no domain field; the consumer reads what it asked for (L090).
                result_items = [{"kind": output_kind, **structured_obj}]
            else:
                result_items = build_items_from_extracted(output_kind, extract_json_array(stdout))
        if not result_items:
            error_code = "parse_empty"
            error_message = "No items parsed from command output. Try again."
            records.append(build_error_record(request_id, target_group_ref, error_code, error_message, observed_at))
        else:
            result_items = stamp_item_provenance(result_items, resolved_agent)
            records.append(build_result_record(
                request_id,
                target_group_ref,
                output_kind,
                result_items,
                instruction_observability,
                prompt_hash,
                addressed_input_snapshot,
            ))
            # Audit record for every successful run (ai-execution-history contract)
            records.append(build_audit_record(
                request_id,
                resolved_agent,
                output_kind,
                instruction_observability,
                prompt_hash,
            ))

    print(f"[ai-records-producer] parsed items={len(result_items)} kind={output_kind}")

    # A ready-to-write result payload so the top-level workflow write can bind it
    # as a SINGLE root transform-binding (decode→json_parse→lookup 'result_payload').
    # A transform-binding nested inside a write-payload OBJECT does not resolve
    # (verified live); a root-level transform-binding does (same as a loop source).
    result_payload = {
        "kind": "ai-records-producer.result",
        "request_id": request_id,
        "target_group_ref": target_group_ref,
        "output_kind": output_kind,
        # Routing provenance (fail-closed contract): WHICH model/pipe actually ran
        # is a readback fact on the result record, never a caller's guess. Both
        # values come from the request the command-request script resolved.
        "model_id": as_string(request.get("model_id")),
        "cli_id": as_string(request.get("cli_id")),
        "provider_model_id": provider_model_id,
        "instruction_observability": instruction_observability,
        "prompt_hash": prompt_hash,
        "addressed_input_snapshot": addressed_input_snapshot,
        # Machine-readable discriminant (L090): every result_payload on this address
        # carries `status`, regardless of which transport ran, so a caller never has
        # to infer mode from field presence. "error" | "completed" here; the
        # streaming short-circuit above is the only writer of "streaming".
        "status": "error" if error_code else "completed",
        "items": result_items,
        "error_code": error_code,
        "error_message": error_message,
        "retryable": retryable,
        "completed_at": observed_at,
    }

    output = {
        "kind": "ai-records-producer.records-from-command-run",
        "request_id": request_id,
        "target_group_ref": target_group_ref,
        "output_kind": output_kind,
        "items": result_items,
        "error_code": error_code,
        "error_message": error_message,
        "result_payload": result_payload,
        "records": records,
    }

    pathlib.Path(args.output_json).parent.mkdir(parents=True, exist_ok=True)
    pathlib.Path(args.output_json).write_text(json.dumps(output, ensure_ascii=False), encoding="utf-8")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
