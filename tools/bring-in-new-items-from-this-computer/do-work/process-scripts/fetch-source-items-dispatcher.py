#!/usr/bin/env python3
"""
packages/observed-content/do-work/process-scripts/fetch-source-items-dispatcher.py

Generic dispatcher for action:fetch-source-items. Receives:
  - source_ref: identifies the connection (e.g., "source:slack", "source:x")
  - category_key: category within the source (e.g., "threads", "bookmarks")
  - cursor: pagination cursor (empty for first page)
  - limit: page size (0 = no cap)
  - DESCRIPTOR_JSON: env var with the conversation_source_descriptor OBJECT as JSON

The workflow mounts three files next to this script:
  dispatcher.py (this file), transcript_mapper.py, decoder.py (the channel's
  decoder, resolved from descriptor.decoder_process_module.script_address).

Decoder contract (uniform across all channel decoders):
  python3 decoder.py <request.json> <out.json>
  request.json = {"observation": {source_ref, native_ref, batch_ref, observed_at},
                  "descriptor": {...}}            (single observation)
               | {"batch": {"accepted": [observation, ...]}, "descriptor": {...}}
  out.json     = {"threads": [...], "atoms": [...], "rejections": [...]}

Observations are built here from descriptor.location — a self-describing
capture locator ({kind:"file-glob", data:{base:[...], glob}}). This dispatcher
never names any channel; the descriptor DATA fully determines behavior.

This dispatcher returns {items: atoms[], next_cursor, rejections} for the UI.
"""
import sys
import json
import os
import glob as globlib
import pathlib
import runpy
import contextlib
import io
import datetime
import tempfile
import shutil


def _fail(message):
    # Contract failure -> structured error on stdout AND a nonzero return code
    # (honest-empty is a DIFFERENT path that returns 0). Callers: `return _fail(...)`.
    print(json.dumps({"items": [], "next_cursor": None, "error": message}))
    return 2


class InvalidLocator(ValueError):
    """A malformed/unsupported descriptor.location — schema drift, NOT honest empty."""


class DecoderDiagnostics(io.TextIOBase):
    """Keep a bounded causal tail without buffering arbitrary decoder output."""
    def __init__(self):
        self.tail = ""

    def write(self, value):
        self.tail = (self.tail + value[-2000:])[-2000:]
        return len(value)


def _resolve_location_files(location):
    """Resolve a self-describing capture locator into concrete file paths.

    Locator kinds are dispatched on DATA (L090); currently 'file-glob':
      {kind:"file-glob", data:{base:["{home}",".bitfield","captures","x"], glob:"*.json"}}
    '{home}' expands to the user's home directory. Returns newest-first paths.

    A VALID file-glob that matches zero files returns [] (honest empty). A malformed
    or unsupported locator raises InvalidLocator (fail closed — it must NOT masquerade
    as honest empty).
    """
    if not isinstance(location, dict):
        raise InvalidLocator("descriptor.location is not an object")
    kind = location.get("kind")
    if kind == "envelope-record":
        mounted = os.environ.get("CAPTURE_RECORD_PATH")
        if not mounted or not pathlib.Path(mounted).is_file():
            raise InvalidLocator("selected source snapshot was not mounted by the record owner")
        return [mounted]
    if kind != "file-glob":
        raise InvalidLocator("unsupported descriptor.location kind: {!r}".format(kind))
    data = location.get("data") or {}
    base_parts = []
    for part in data.get("base") or []:
        base_parts.append(str(pathlib.Path.home()) if part == "{home}" else part)
    if not base_parts:
        raise InvalidLocator("descriptor.location.data.base is empty")
    pattern = str(pathlib.Path(*base_parts) / (data.get("glob") or "*"))
    paths = [p for p in globlib.glob(pattern) if os.path.isfile(p)]
    paths.sort(key=lambda p: os.path.getmtime(p), reverse=True)
    return paths  # may be [] — a valid file-glob with zero matches = honest empty


def select_items(decoder_output, collection_key):
    """Select the decoder-output collection named by the EXPLICIT collection_key
    DATA field (source-offer/descriptor), validating the selected value is a list.

    collection_key is an explicit selector passed through the action input; it is
    NOT the category identity and is NOT inferred by convention. The decoder output
    contract declares its collections, so an ABSENT key is schema drift (raises), NOT
    an honest empty list. Only a PRESENT `[]` is honest empty. A present non-list raises.
    """
    if not isinstance(decoder_output, dict):
        raise ValueError("decoder output is not an object")
    if collection_key not in decoder_output:
        raise ValueError(
            "decoder output missing required collection '{}' (schema drift); "
            "present keys: {}".format(collection_key, sorted(decoder_output.keys()))
        )
    selected = decoder_output[collection_key]
    if not isinstance(selected, list):
        raise ValueError(
            "decoder output collection '{}' is not a list: {}".format(
                collection_key, type(selected).__name__
            )
        )
    return selected  # a PRESENT [] is honest empty


def main():
    if len(sys.argv) < 5:
        return _fail("insufficient arguments")

    source_ref = sys.argv[1]
    category_key = sys.argv[2]
    cursor = sys.argv[3] if sys.argv[3] and sys.argv[3].lower() != "none" else None
    try:
        limit = int(sys.argv[4]) if sys.argv[4] and sys.argv[4] != "0" else None
    except (ValueError, TypeError):
        limit = None
    # Explicit collection selector — a REQUIRED source-offer DATA field wired as argv[5]
    # (distinct from the category identity argv[2]). Fail closed if missing: there is no
    # default (a default would leave the action/offer replacement split and silently pick
    # a collection the offer never chose). Every offer supplies collection_key as DATA.
    if len(sys.argv) < 6 or not sys.argv[5]:
        return _fail("collection_key (argv[5]) is required — no default; each source-offer must supply it as DATA")
    collection_key = sys.argv[5]

    try:
        descriptor = json.loads(os.environ.get("DESCRIPTOR_JSON", "{}"))
    except json.JSONDecodeError as e:
        return _fail(f"descriptor JSON parse failed: {e}")
    if not isinstance(descriptor, dict) or not (
        (descriptor.get("decoder_process_module") or {}).get("script_address")
    ):
        return _fail("decoder_process_module.script_address not found in descriptor")

    try:
        capture_files = _resolve_location_files(descriptor.get("location"))
    except InvalidLocator as exc:
        # Schema drift — a malformed/unsupported locator must NOT masquerade as empty.
        return _fail("invalid descriptor.location: {}".format(exc))
    if not capture_files:
        # Honest empty: a VALID file-glob that matched zero files (not an invalid locator).
        print(json.dumps({"items": [], "next_cursor": None, "rejections": None,
                          "error": None, "empty_reason": "valid file-glob locator, zero files matched"}))
        return 0  # honest empty is success, not a contract failure

    observed_at = datetime.datetime.now(datetime.timezone.utc).isoformat()
    observations = [{
        "source_ref": source_ref,
        "native_ref": path,
        "batch_ref": f"fetch:{source_ref}:{category_key}",
        "observed_at": observed_at,
    } for path in capture_files]

    # Pagination is decoder-owned DATA.  The dispatcher carries the caller's
    # opaque cursor and bounded limit without inspecting either; older decoders
    # ignore these keys, while paged decoders bind them to the mounted snapshot.
    request = {"descriptor": descriptor, "cursor": cursor, "limit": limit,
               "category_key": category_key, "collection_key": collection_key}
    if len(observations) == 1:
        request["observation"] = observations[0]
    else:
        request["batch"] = {"accepted": observations}

    # Per-invocation temp files (concurrency-safe): fixed cwd filenames would collide
    # when two invocations run in the same cwd. Cleaned up in finally.
    tmpdir = tempfile.mkdtemp(prefix="fetch-source-items-")
    try:
        request_path = os.path.join(tmpdir, "request.json")
        out_path = os.path.join(tmpdir, "out.json")
        pathlib.Path(request_path).write_text(
            json.dumps(request, separators=(",", ":")), encoding="utf-8")

        # One contained interpreter owns the mounted decoder's file contract.
        # Timeout and cancellation belong to compute.process; no child process
        # can detach from that owner or select an ambient Python executable.
        prior_argv = sys.argv
        diagnostics = DecoderDiagnostics()
        try:
            sys.argv = ["decoder.py", request_path, out_path]
            with contextlib.redirect_stdout(diagnostics), contextlib.redirect_stderr(diagnostics):
                try:
                    runpy.run_path("decoder.py", run_name="__main__")
                except SystemExit as stopped:
                    if stopped.code not in (None, 0):
                        raise RuntimeError("exit {}: {}".format(stopped.code, diagnostics.tail))
        except Exception as error:
            return _fail("decoder failed: {}: {}".format(type(error).__name__, error))
        finally:
            sys.argv = prior_argv

        try:
            decoder_output = json.loads(pathlib.Path(out_path).read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError) as e:
            return _fail("decoder output unreadable: {}".format(e))
    finally:
        shutil.rmtree(tmpdir, ignore_errors=True)

    rejections = decoder_output.get("rejections", [])
    # Select the output collection by the EXPLICIT collection_key DATA field, validated
    # as a list. No category_key overload, no convention (L090). A new category (pins,
    # reels, ...) supplies its own collection_key DATA row — zero code change here.
    try:
        items = select_items(decoder_output, collection_key)
    except ValueError as exc:
        return _fail(str(exc))
    # Never truncate locally while returning the decoder's later cursor: doing so
    # skips every item between the local cut and that cursor. A paged decoder must
    # honor the requested bound and produce the matching continuation itself.
    if limit and len(items) > limit:
        return _fail("decoder returned {} items, over requested page limit {}; refusing silent truncation".format(
            len(items), limit))

    print(json.dumps({
        "items": items,
        "next_cursor": decoder_output.get("next_cursor"),
        "rejections": rejections if rejections else None,
    }))
    return 0


if __name__ == "__main__":
    sys.exit(main())
