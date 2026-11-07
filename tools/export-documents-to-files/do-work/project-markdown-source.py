#!/usr/bin/env python3
"""Adapt the maintained book parser to the structured-file tree, in memory.

This creates projection DATA only. It does not admit a source, render a file,
qualify a voice, or assert that a manuscript is finished.
"""
import runpy
from dataclasses import asdict, is_dataclass
from pathlib import Path


HERE = Path(__file__).resolve().parent


def project_source_snapshot(source_bytes, expected_identity, *, parsed=None):
    if not isinstance(source_bytes, bytes) or len(source_bytes) > 16 * 1024 * 1024:
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
            emit({"kind": "literal", "text": block.text},
                 {"text": block.text, "text_mode": "literal"}, source_index)
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
            emit({"kind": "paragraph", "text": text}, {"text": text}, source_index)
        else:
            raise ValueError(f"Structured target cannot preserve source kind {block.kind}")
    return {"schema": "documents-structured-file-projection-v1", "source_identity": identity,
            "title": plain(current.title), "tree": {"props": {}, "children": children},
            "ordered_blocks": ordered, "ordered_bindings": bindings,
            "source_group_count": len(current.blocks),
            "scope": "Exact source-bound parser projection; literal whitespace, heading levels, list markers and depth, and table cell boundaries. No render, voice or final approval claim."}
