#!/usr/bin/env python3
# packages/chat/do-work/process-scripts/observe-inline.py
#
# =============================================================================
# PURPOSE
# =============================================================================
#
# Generic acquisition capability for sources whose observations are PROVIDED to
# the materialize process — either INLINE on the descriptor (pure-data / tests)
# or in a MOUNTED FILE the descriptor's location names (the live path). It is the
# engine-record analogue of `observe_file_glob` (which discovers transcript
# files): an engine-record source (e.g. the chat conversation-ledger, #56) cannot
# be file-globbed from a sandboxed process, so the WORKFLOW reads the records and
# hands them to the materializer — either folded onto the descriptor, or (the live
# path) written to a mounted JSON file that this observer reads. Reading a single
# mounted path keeps the workflow binding to the SAME simple "read step -> mount"
# shape every other input uses (no object-assembly binding op required).
#
# Uniform observer contract (same as observe_file_glob):
#   observe(descriptor) -> {"observations": [<observation>, ...]}
# The decoder named by the descriptor then decodes each observation. This observer
# is BLIND to the observation shape — it neither parses nor validates the inner
# observation; that is the decoder's job (L098). It only PEELS the batch container
# ({"accepted":[...]} OR a live read-reply {"payload": {...}} OR a bare list) to
# yield the observation list. Adding any future inline/mounted source = a
# descriptor naming `capability:observe-inline` + its own decoder, ZERO edits here.
#
# =============================================================================
# NON-NEGOTIABLE INVARIANTS
# =============================================================================
#
# 1. The ONLY I/O is reading the single mounted observations file the descriptor
#    names (exactly as observe_file_glob reads the files it globs). No network.
# 2. Blind to the inner observation — returns observations verbatim; never
#    inspects their fields. Only the batch CONTAINER is peeled.
# 3. Tolerant — accepts the batch shape {"accepted":[...]}, a live current-read
#    reply {"payload": {"accepted":[...]}} or {"payload":[...]}, a bare list, or a
#    single observation; always returns a list under "observations".
# 4. Missing/empty mounted file -> {"observations": []} (an empty source, never a
#    crash): a chat app with no conversations yet still materializes cleanly.
#
# The extensive documentation in this codebase is a critical design feature.
# You are forbidden from simplifying or removing it.
# =============================================================================

import json
import pathlib

# The same envelope keys build-conversation-descriptors peels, so a live
# current-read reply ({found, payload, payload_base64}) and a bare bundle both
# resolve to the observation list with one shared rule (machine-readable, L090).
_ENVELOPE_LIST_KEYS = ("accepted", "observations", "payload", "records", "rows", "items")


def _peel_observations(raw):
    """Yield the observation list from any accepted container shape.

    - bundle:            {"accepted": [<obs>, ...]}        -> the list
    - live read reply:   {"payload": {"accepted":[...]}}   -> peel payload, then accepted
    - read reply (list): {"payload": [<obs>, ...]}         -> the list
    - bare list:         [<obs>, ...]                      -> itself
    - single observation:{...}                             -> [that]
    """
    if isinstance(raw, list):
        return raw
    if isinstance(raw, dict):
        for key in _ENVELOPE_LIST_KEYS:
            value = raw.get(key)
            if isinstance(value, list):
                return value
            if isinstance(value, dict):
                # One level of nesting (e.g. payload -> {accepted:[...]}).
                nested = _peel_observations(value)
                if nested:
                    return nested
        return [raw] if raw else []
    return []


def _read_mounted(descriptor):
    """Read the observations JSON file the descriptor's location names, if any.

    The live-chat source descriptor carries
      location = {"kind": "inline-observations", "data": {"path": "<file>"}}
    where <file> is the mounted bundle the workflow wrote from the ledger read.
    Absent/unreadable -> None (caller falls back to inline / empty)."""
    location = descriptor.get("location")
    if not isinstance(location, dict):
        return None
    data = location.get("data")
    path = data.get("path") if isinstance(data, dict) else None
    if not isinstance(path, str) or not path:
        return None
    try:
        return json.loads(pathlib.Path(path).read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return None


def observe(descriptor):
    """Return the descriptor's observations (inline or mounted) in the uniform shape."""
    if not isinstance(descriptor, dict):
        return {"observations": []}
    # Inline observations (pure-data / tests) take precedence when present...
    if descriptor.get("observations") is not None:
        return {"observations": _peel_observations(descriptor["observations"])}
    # ...otherwise read the mounted observations file the location names (live path).
    mounted = _read_mounted(descriptor)
    if mounted is not None:
        return {"observations": _peel_observations(mounted)}
    return {"observations": []}
