#!/usr/bin/env python3
# tools/match/finite_json.py
#
# PURPOSE: The SERIALIZATION WAIST — the single structural property that makes the entire
# "a NaN/Inf DATA value reaches a comparison gate and defeats it (nan<x is False) or
# fabricates a score" category STRUCTURALLY IMPOSSIBLE in persisted artifacts.
#
# THE ROOT (Task #198, Claude+Codex convergence, L055 bedrock): this pipeline is MULTI-PROCESS.
# `describe_clip` shells out and writes `.desc.json`/`.kp.json`; `select_partner` reads them back.
# Python's stdlib `json` is the leak:
#     json.dumps({"x": float("nan")})        -> '{"x": NaN}'      (INVALID JSON, but emitted by default)
#     json.dumps({"x": float("inf")})        -> '{"x": Infinity}'
#     json.loads('{"x": NaN}')               -> {"x": nan}        (reads the poison straight back)
# So EVERY capstone NaN value physically travels through a json.dumps -> disk -> json.loads boundary.
# Close that boundary once and a non-finite value can NEVER exist in persisted DATA — only transiently
# inside one process's computation (the small, enumerable math-site set guarded at the math site).
#
# THE TWO HALVES (asymmetric by design — Codex #8):
#   * WRITE = producer fails LOUD: `allow_nan=False` raises at the exact site that tried to persist a
#     NaN/Inf, and `sanitize_nonfinite()` first maps non-finite LEAF floats -> None (absent) so a
#     legitimate degenerate upload degrades to "evidence absent" (which every downstream gate already
#     fails CLOSED on) instead of crashing the clip — while logging WHAT it replaced (loud in logs).
#   * READ = cached/legacy/hand-poisoned file fails CLOSED: `parse_constant=` rejects the `NaN`,
#     `Infinity`, `-Infinity` tokens, raising NonFiniteJSON the caller maps to no_match / skip.
#
# DOMAIN-FREE (Physics, not Society): no clip/sport/joint/field name appears here. It is a pure
# numeric-JSON IO primitive. Adding a new artifact = route its read/write through here, zero new code.
#
# USAGE:
#   from finite_json import dump_text, load_text, dumps, loads, NonFiniteJSON, sanitize_nonfinite
#   dump_text(path, obj)            # producer: sanitize -> write with allow_nan=False (loud backstop)
#   obj = load_text(path)           # consumer: read, reject non-finite tokens (raises NonFiniteJSON)

from __future__ import annotations
import json, math, sys
from pathlib import Path

__all__ = ["NonFiniteJSON", "dumps", "dump_text", "loads", "load_text", "sanitize_nonfinite"]


class NonFiniteJSON(ValueError):
    """Raised when a JSON artifact contains a non-finite numeric token (NaN/Infinity/-Infinity).
    Producer side raises it on WRITE (allow_nan=False) — a real upstream bug tried to persist poison.
    Consumer side raises it on READ (parse_constant) — a cached/legacy/poisoned file is rejected.
    Callers map it to fail-closed (no_match / skip-candidate), never silently continue."""


def _reject_constant(token: str):
    raise NonFiniteJSON(f"non-finite JSON numeric token in artifact: {token!r}")


def _finite_float(token: str) -> float:
    """parse_float hook: #198.4 (capstone-12 #1 SAFETY-CRITICAL). `parse_constant` only intercepts the literal
    `NaN`/`Infinity`/`-Infinity` TOKENS — but a VALID JSON overflow literal like `1e999` parses to Python `inf`
    and would sail straight through, re-opening the exact gate-defeat the waist exists to close. Every float
    literal is parsed here and asserted finite, so an overflow value fails CLOSED on read just like a NaN token."""
    v = float(token)
    if not math.isfinite(v):
        raise NonFiniteJSON(f"non-finite JSON float literal in artifact: {token!r} -> {v}")
    return v


def finite_float(x, default=None):
    """Gate helper (capstone-15, L063): coerce `x` to a FINITE float at the COMPARISON site, else return
    `default`. The disk-json waist (loads/load_text) closes NaN/Inf that arrive as JSON numeric TOKENS — but a
    non-finite value ALSO reaches a refuse/admit/score gate via paths the json waist never sees:
      (a) a JSON *string* "NaN"/"Infinity" that `float()` turns into nan/inf (load_text accepts strings),
      (b) a numpy/torch leaf decoded from a .npy/.pt cache (not json at all),
      (c) a runtime 0/0 / acos(>1) / nanmean([]) computed in-process.
    A gate that does `float(x) < bar` then fails OPEN, because `nan < bar` is False (and `x <= inf` is True).
    This coerces defensively: non-numeric, non-coercible, or non-finite -> `default`. The CALLER picks a
    FAIL-CLOSED default for its gate: `float('-inf')` for a 'must EXCEED' bar (a non-finite value becomes the
    WORST, so it is refused), or `None` for 'no usable evidence'. Booleans are rejected (a bool is not a metric)."""
    if isinstance(x, bool):
        return default
    try:
        v = float(x)
    except (TypeError, ValueError):
        return default
    return v if math.isfinite(v) else default


def sanitize_nonfinite(obj, _path: str = ""):
    """Recursively replace every non-finite LEAF float (NaN/Inf/-Inf) with None (the 'absent'
    representation every descriptor gate already fails-closed on), returning (clean_obj, replaced)
    where `replaced` is the list of dotted paths that were replaced. Booleans and ints are left
    untouched (a JSON int cannot be non-finite). This is the 'assert finite-or-None before write'
    contract (Codex #4): a legitimate degenerate clip degrades to 'evidence absent', never persists
    a NaN, and never crashes — while `replaced` makes the event observable (logged loud by dump_text)."""
    replaced: list[str] = []

    def walk(o, p):
        if isinstance(o, float):
            if not math.isfinite(o):
                replaced.append(p or "<root>")
                return None
            return o
        if isinstance(o, dict):
            return {k: walk(v, f"{p}.{k}" if p else str(k)) for k, v in o.items()}
        if isinstance(o, (list, tuple)):
            return [walk(v, f"{p}[{i}]") for i, v in enumerate(o)]
        return o

    return walk(obj, _path), replaced


def dumps(obj, **kw) -> str:
    """json.dumps with allow_nan=False ENFORCED (producer fails loud on any non-finite). Does NOT
    sanitize — use when the object is already known-finite, or you want the raise. Extra kwargs pass
    through (e.g. sort_keys, indent, separators)."""
    kw["allow_nan"] = False
    try:
        return json.dumps(obj, **kw)
    except ValueError as e:
        raise NonFiniteJSON(f"refused to serialize non-finite numeric DATA: {e}") from e


def dump_text(path, obj, *, log_replacements: bool = True, **kw) -> list[str]:
    """Producer write: sanitize non-finite leaves -> None (logging what was replaced, loud), then write
    with allow_nan=False as the backstop assert. Returns the list of replaced dotted paths (empty on
    clean data). The directory is created if absent. This is the ONLY sanctioned way to persist a
    pipeline artifact."""
    clean, replaced = sanitize_nonfinite(obj)
    if replaced and log_replacements:
        print(f"[finite_json] WARNING: replaced {len(replaced)} non-finite value(s) with null before "
              f"writing {Path(path).name}: {replaced[:8]}{' …' if len(replaced) > 8 else ''}",
              file=sys.stderr, flush=True)
    p = Path(path)
    p.parent.mkdir(parents=True, exist_ok=True)
    p.write_text(dumps(clean, **kw))
    return replaced


def loads(s: str):
    """json.loads that REJECTS non-finite tokens (NaN/Infinity/-Infinity) — a poisoned/legacy artifact
    fails CLOSED with NonFiniteJSON instead of returning a float('nan') that defeats a downstream gate."""
    return json.loads(s, parse_constant=_reject_constant, parse_float=_finite_float)  # #198.4: also reject overflow float literals (1e999 -> inf)


def load_text(path):
    """Consumer read of a pipeline artifact: reject non-finite tokens (raises NonFiniteJSON). Callers
    wrap this and map the exception to their fail-closed outcome (query -> no_match, candidate -> skip)."""
    return loads(Path(path).read_text())
