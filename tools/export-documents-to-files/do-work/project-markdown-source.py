#!/usr/bin/env python3
"""Adapt the maintained book parser to the structured-file tree, in memory.

This creates projection DATA only. It does not admit a source, render a file,
qualify a voice, or assert that a manuscript is finished.
"""
import argparse
import json
import os
import runpy
import stat
from dataclasses import asdict, is_dataclass
from pathlib import Path


HERE = Path(__file__).resolve().parent
MAX_SOURCE_BYTES = 16 * 1024 * 1024


def project_source_snapshot(source_bytes, expected_identity, *, parsed=None):
    if not isinstance(source_bytes, bytes) or len(source_bytes) > MAX_SOURCE_BYTES:
        raise ValueError("A bounded exact source byte snapshot is required")
    gate = runpy.run_path(str(HERE / "writing_gate.py"))
    identity = "1f:" + gate["_snapshot_hash"](source_bytes)
    if identity != expected_identity:
        raise ValueError("Source snapshot identity does not match its binding")
    source = source_bytes.decode("utf-8")
    owner = runpy.run_path(str(HERE / "export_markdown_book_to_word.py"))
    current = owner["parse_markdown"](source)
    if parsed is not None:
        if not is_dataclass(parsed) or asdict(parsed) != asdict(current):
            raise ValueError("Parsed content does not match the source snapshot")
    owner["_check"](current, source, report=False)
    plain = owner["_plain_inline"]
    children, ordered, bindings = [], [], []

    def emit(block, props, source_index, item_index=None, rows=None):
        if owner["_keep_with_following"](current.blocks, source_index, item_index):
            block["keep_with_next"] = True
            props["keep_with_next"] = True
        index = len(ordered)
        binding = {"request_block_index": index, "source_identity": identity,
                   "source_block_index": source_index}
        if item_index is not None:
            binding["source_item_index"] = item_index
        node = {"props": props, "children": [], "request_block_index": index,
                "source_bindings": binding}
        if rows is not None:
            node["children"] = [{"props": {}, "children": [
                {"props": {"text": cell}, "children": []} for cell in row]} for row in rows]
        children.append(node)
        ordered.append(block)
        bindings.append(binding)

    for source_index, block in enumerate(current.blocks):
        if block.kind == "heading":
            text = plain(block.text)
            emit({"kind": "heading", "text": text, "level": block.level},
                 {"text": text, "heading_level": block.level}, source_index)
        elif block.kind == "code":
            emit({"kind": "literal", "text": block.text, "indent_level": block.indent_level},
                 {"text": block.text, "text_mode": "literal", "indent_level": block.indent_level}, source_index)
        elif block.kind == "list":
            if len(block.list_markers) != len(block.items):
                raise ValueError("Exact list marker provenance is required")
            for item_index, ((depth, value, _ordered), marker) in enumerate(zip(block.items, block.list_markers)):
                text = marker + " " + plain(value)
                emit({"kind": "list_item", "text": text, "indent_level": depth},
                     {"text": text, "indent_level": depth}, source_index, item_index)
        elif block.kind == "table":
            rows = [[plain(cell) for cell in row] for row in block.rows]
            if len(rows) < 2 or any(len(row) < 2 for row in rows) or len({len(row) for row in rows}) != 1:
                raise ValueError("Structured target requires a rectangular table with at least two rows and cells")
            emit({"kind": "table", "rows": rows}, {}, source_index, rows=rows)
        elif block.kind in {"paragraph", "quote"}:
            text = plain(block.text)
            emit({"kind": "paragraph", "text": text, "indent_level": block.indent_level},
                 {"text": text, "indent_level": block.indent_level}, source_index)
        else:
            raise ValueError(f"Structured target cannot preserve source kind {block.kind}")
    return {"schema": "documents-structured-file-projection-v1", "source_identity": identity,
            "title": plain(current.title), "tree": {"props": {}, "children": children},
            "ordered_blocks": ordered, "ordered_bindings": bindings,
            "source_group_count": len(current.blocks),
            "scope": "Exact source-bound parser projection; literal whitespace, heading levels, list markers and depth, introductory keep-with-next relationships, and table cell boundaries. No render, voice or final approval claim."}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--source", type=Path, required=True)
    parser.add_argument("--source-identity", required=True)
    parser.add_argument("--output", type=Path, required=True,
                        help="New JSON file in an existing private, caller-owned directory")
    args = parser.parse_args()
    try:
        with args.source.open("rb") as stream:
            before = os.fstat(stream.fileno())
            if not stat.S_ISREG(before.st_mode) or before.st_size > MAX_SOURCE_BYTES:
                raise ValueError("Source must be a bounded regular file")
            snapshot = stream.read(MAX_SOURCE_BYTES + 1)
            after = os.fstat(stream.fileno())
        stamp = lambda value: (value.st_dev, value.st_ino, value.st_size,
                               value.st_mtime_ns, value.st_ctime_ns)
        if stamp(before) != stamp(after) or stamp(after) != stamp(args.source.stat()):
            raise ValueError("Source changed while reading its exact snapshot")
        projection = project_source_snapshot(snapshot, args.source_identity)
        encoded = (json.dumps(projection, ensure_ascii=False, indent=2) + "\n").encode("utf-8")
        # Anchor creation in the checked directory, never overwrite another
        # proof, and make manuscript-derived DATA private from its first byte.
        directory = os.open(args.output.parent, os.O_RDONLY | os.O_DIRECTORY)
        try:
            info = os.fstat(directory)
            if info.st_uid != os.getuid() or stat.S_IMODE(info.st_mode) & 0o077:
                raise ValueError("Projection output parent must be private and caller-owned")
            descriptor = os.open(args.output.name, os.O_WRONLY | os.O_CREAT | os.O_EXCL,
                                 0o600, dir_fd=directory)
            try:
                with os.fdopen(descriptor, "wb") as stream:
                    os.fchmod(stream.fileno(), 0o600)
                    stream.write(encoded)
                    stream.flush()
                    os.fsync(stream.fileno())
            except BaseException:
                os.unlink(args.output.name, dir_fd=directory)
                raise
        finally:
            os.close(directory)
    except (OSError, ValueError, UnicodeError) as error:
        parser.exit(2, f"Projection refused: {error}\n")
    print(json.dumps({"path": str(args.output.resolve()), "source_identity": projection["source_identity"],
                      "ordered_block_count": len(projection["ordered_blocks"])}))


if __name__ == "__main__":
    main()
