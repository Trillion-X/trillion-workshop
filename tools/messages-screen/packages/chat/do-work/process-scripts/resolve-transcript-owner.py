#!/usr/bin/env python3
# packages/chat/do-work/process-scripts/resolve-transcript-owner.py
#
# =============================================================================
# PURPOSE
# =============================================================================
#
# Pick the ONE decoder that owns a transcript page's `file_path`, and emit the
# byte-delivery pair the page def needs to mount exactly that decoder — nothing
# else. This is the enum-dissolution seam for the transcript PAGE read (#28):
# the page def used to statically read + mount FIVE per-channel decoder scripts
# (jsonl / imessage / instagram / whatsapp / discord) and hand all five to
# materialize-transcript.py, which then imported only the one owning `file_path`.
# That static five-way fan is an enumeration — a sixth channel meant editing the
# def. This script replaces it: the def resolves the owner as DATA, dynamically
# reads that ONE decoder's bytes, and mounts it at its ONE path. A new channel
# is a transcript-source ROW (self-describing decoder_process_module), ZERO def
# edits (L069 / L090 / enum-dissolution).
#
# =============================================================================
# SSOT — the owner it picks is byte-identical to the one materialize picks
# =============================================================================
#
# The page's compute.process still runs materialize-transcript.py, which
# INTERNALLY re-derives the owner via descriptor_for_file(file_path, sources)
# and imports capability_module(owner["decoder_capability_ref"]). If this script
# picked the owner by any DIFFERENT rule, the def could mount decoder A while
# materialize imported decoder B -> ImportError / silent misdecode. So this
# script does NOT reimplement owner-resolution: it path-loads materialize's OWN
# `_normalize_sources` + `descriptor_for_file` and build-conversation-descriptors'
# OWN `_mountable` / DEFAULT_DECODER / resolve_decoder_script_address /
# _module_name_of / MOUNT_DIR. The pick, the mount path, and the module name can
# never diverge from what the driver imports, for any channel, present or future.
#
# =============================================================================
# NON-NEGOTIABLE INVARIANTS
# =============================================================================
#
# 1. Pure transform: two/three positional file/string args in, one file out. No
#    network, no channel name, no format branch. Blind + generic.
# 2. Fail-OPEN to the always-mountable jsonl builtin (never fail-closed to null):
#    if `file_path` matches no source base (owner None) or the owner is not
#    mountable, emit the chat-bundled jsonl decoder. materialize() will still
#    re-derive descriptor {} for that file_path and return an EMPTY page, so the
#    mounted-but-unused jsonl decoder changes nothing — it only guarantees the
#    compute.process always has ONE real .py to mount (a null mount_path/hash
#    would fail the whole page). Byte-identical to the old def, which likewise
#    mounted jsonl unconditionally.
# 3. Output is FLAT (top-level string keys only) so the def extracts each field
#    with a single-key op:core.lookup — {decoder_script_address, decoder_mount_path}.
#
# =============================================================================
# CLI (compute.process):
#   resolve-transcript-owner.py <transcript-sources.json> <out-owner.json> <file_path>
#     transcript-sources.json = the raw `transcript-sources` read output (the fold
#       rows / current-read reply) — the SAME bytes materialize-transcript is
#       handed; _normalize_sources peels + expands it to full descriptors.
#     out-owner.json = {"decoder_script_address": "...", "decoder_mount_path": "..."}
# =============================================================================
import importlib.util
import json
import os
import pathlib
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))


def _load_sibling(file_name, module_name):
    """Load a hyphenated sibling script by path (not importable by module name).
    Path-loading runs the sibling's module body but NOT its main() (its __name__
    is module_name, not "__main__"), so this is a pure function import."""
    path = pathlib.Path(__file__).parent / file_name
    spec = importlib.util.spec_from_file_location(module_name, path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def _fallback(build_conv):
    """The always-mountable chat-bundled jsonl decoder, derived from the SAME
    DEFAULT_DECODER / address / module-name rules the expander uses — no literal
    address or filename is restated here (SSOT)."""
    decoder_ref = build_conv.DEFAULT_DECODER
    script_address = build_conv.resolve_decoder_script_address({}, decoder_ref)
    module_name = build_conv._module_name_of(decoder_ref)
    return {
        "decoder_script_address": script_address,
        "decoder_mount_path": f"{build_conv.MOUNT_DIR}/{module_name}.py",
        "acquire_action_ref": "action:acquire-selected-file-whole",
    }


def resolve(raw, file_path):
    mt = _load_sibling("materialize-transcript.py", "materialize_transcript")
    build_conv = _load_sibling("build-conversation-descriptors.py", "build_conversation_descriptors")

    # Same expansion + same owner-pick materialize() runs internally (SSOT).
    descriptors = mt._normalize_sources(raw)
    owner = mt.descriptor_for_file(file_path, descriptors)

    if owner and build_conv._mountable(owner):
        base_dir = mt.resolve_base_dir(owner)
        relative = os.path.relpath(os.path.normpath(file_path), os.path.normpath(base_dir))
        relative_parts = pathlib.Path(relative).parts
        if not relative_parts or relative_parts[0] == "..":
            raise ValueError("selected transcript is outside its declared source directory")
        return {
            "decoder_script_address": owner["decoder_process_module"]["script_address"],
            "decoder_mount_path": owner["decoder_mount_path"],
            "acquire_action_ref": (
                "action:acquire-selected-jsonl-range"
                if owner.get("acquisition_mode") == "bounded-jsonl-range"
                else "action:acquire-selected-file-whole"
            ),
            "acquisition": {
                "base": ((owner.get("location") or {}).get("data") or {}).get("base"),
                "sub_path": list(relative_parts[:-1]),
                "glob": relative_parts[-1],
                "include_bytes": True,
                "limit": 1,
                "max_total_bytes": 2097152,
                "max_entries": 4096,
            },
        }
    # No owning source for this file_path (or owner not mountable): mount the
    # harmless jsonl builtin so the compute.process always has one real decoder;
    # materialize re-derives {} for this file_path and returns an empty page.
    return _fallback(build_conv)


def main():
    args = sys.argv[1:]
    if len(args) < 3:
        raise SystemExit(
            "usage: resolve-transcript-owner.py <transcript-sources.json> <out-owner.json> <file_path>"
        )
    sources_file, out_path, file_path = args[0], args[1], args[2]
    try:
        raw = json.loads(pathlib.Path(sources_file).read_text(encoding="utf-8"))
    except (OSError, ValueError):
        raw = []
    owner = resolve(raw, file_path)
    pathlib.Path(out_path).write_text(json.dumps(owner, separators=(",", ":")), encoding="utf-8")
    print(
        f"owner_decoder={owner['decoder_script_address']} mount={owner['decoder_mount_path']}"
    )


if __name__ == "__main__":
    main()
