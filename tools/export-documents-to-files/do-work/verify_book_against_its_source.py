#!/usr/bin/env python3
"""Cross-check a book DOCX/PDF against its Markdown source.

The optional CMap repair path changes only the listed, source-confirmed
ToUnicode mappings. It requires full body text parity and pixel-identical
pages before it records a successful repaired PDF.
"""

from __future__ import annotations

import argparse
import collections
import difflib
import importlib.util
import json
import os
import re
import subprocess
import sys
import shutil
from copy import copy
from pathlib import Path
from typing import Any

from docx import Document
from docx.oxml.ns import qn
from pypdf import PdfReader, PdfWriter
from pypdf._cmap import get_encoding
from pypdf.generic import ByteStringObject, ContentStream, NameObject


PYTHON = Path(sys.executable)
BUILDER = Path(__file__).with_name("private_book_reader.py")
RUNTIME_PYTHON = Path(os.environ.get("BOOK_READER_PYTHON") or sys.executable)      # the Python this place reports for the builder, else this one

# These source-text errors were observed in this manuscript's embedded
# ToUnicode maps. Values are old rendered strings -> intended Unicode text.
CMAP_REPAIRS = {
    "The": "Th",
    "ffe": "ff",
    "ffic": "ffi",
    "tte": "tt",
    "Que": "Qu",
    "fil": "fi",
    "fle": "fl",
    "fte": "ft",
    "tti": "tt",
    "ftw": "ft",
    "fli": "fl",
    "fie": "fi",
    "fin": "fi",
    # The embedded Linux Libertine CMap maps the glyph used in “offline” to
    # “ffli” and then emits the following i again. The source and PDFium both
    # read “offline”; shorten this source-confirmed mapping to “ffl”.
    "ffli": "ffl",
    # The compact reader's subset maps the fl glyph in “flight” to “flo”.
    # PDFium and the unchanged DOCX/source independently confirm “flight”.
    "flo": "fl",
}


def _load_builder():
    spec = importlib.util.spec_from_file_location("private_book_reader", BUILDER)
    if spec is None or spec.loader is None:
        raise RuntimeError(f"Cannot load Markdown parser at {BUILDER}")
    module = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    return module


def _block_text(block, builder) -> str:
    if block.kind in ("heading", "paragraph", "quote"):
        return builder._plain_inline(block.text)
    if block.kind == "list":
        return " ".join(builder._plain_inline(value) for _, value, _ in block.items)
    return ""


def _nearest_token_boundary(matches, source_pos: int, token_spans, *, before: bool, text_length: int) -> int:
    candidates = []
    for match in matches:
        end = match.a + match.size
        if before and end <= source_pos:
            candidates.append((end, token_spans[match.b + match.size - 1][1]))
        elif not before and match.a >= source_pos:
            candidates.append((match.a, token_spans[match.b][0]))
    if not candidates:
        return 0 if before else text_length
    return max(candidates)[1] if before else min(candidates)[1]


def _visible_char_counts(text: str) -> collections.Counter[str]:
    # Whitespace is layout-dependent in a PDF. Keep every other character
    # exact; report arrows separately because they are easy to lose in CMaps.
    return collections.Counter(char for char in text if not char.isspace() and char != "→")


def _compare_pdf_body(parsed, builder, actual: str) -> dict[str, Any]:
    """Require every prose block in order, accounting only for adjacent tables.

    Whitespace and extraction-displaced arrow positions are excluded from the
    sequence. Every arrow count is checked globally. Table cells retain exact
    order in the independent DOCX readback; the PDF check proves the character
    inventory within each table's prose-bounded interval, including full header
    repetitions. It does not infer PDF table cell reading order.
    """
    def normalize(value):
        return re.sub(r"\s+", "", value).replace("→", "").replace("←", "")

    text = normalize(actual)
    raw_positions = [i for i, c in enumerate(actual) if not c.isspace() and c not in ("→", "←")]
    block_regions = []
    token_boundary_errors = []
    cursor = 0
    pending = None
    tables = []
    errors = []
    blocks_checked = 0
    list_markers = []
    expected_all = []

    def check_table(value, block, raw_value):
        expected = normalize(" ".join(builder._plain_inline(c) for row in block.rows for c in row))
        header = normalize(" ".join(builder._plain_inline(c) for c in block.rows[0]))
        expected_counts = collections.Counter(expected)
        actual_counts = collections.Counter(value)
        missing = expected_counts - actual_counts
        extra = actual_counts - expected_counts
        header_counts = collections.Counter(header)
        repetitions = 0
        if extra and header_counts:
            candidates = {extra.get(c, 0) // n for c, n in header_counts.items()}
            if len(candidates) == 1:
                n = next(iter(candidates))
                if n > 0 and extra == collections.Counter({c: v * n for c, v in header_counts.items()}):
                    repetitions = n
                    extra.clear()
        expected_words = collections.Counter(re.findall(r"\w+", " ".join(
            builder._plain_inline(c) for row in block.rows for c in row)))
        header_words = collections.Counter(re.findall(r"\w+", " ".join(
            builder._plain_inline(c) for c in block.rows[0])))
        expected_words.update({word: count * repetitions for word, count in header_words.items()})
        actual_words = collections.Counter(re.findall(r"\w+", raw_value))
        tables.append({
            "table": len(tables) + 1,
            "character_multiset_match": not missing and not extra,
            "additional_whole_header_repetitions": repetitions,
            "missing_characters": missing.most_common(12),
            "extra_characters": extra.most_common(12),
            "source_rows": len(block.rows),
            "word_boundary_inventory_match": expected_words == actual_words,
            "missing_words": (expected_words - actual_words).most_common(12),
            "extra_words": (actual_words - expected_words).most_common(12),
        })

    for block_index, block in enumerate(parsed.blocks):
        if block.kind == "table":
            expected_all.append(" ".join(builder._plain_inline(c) for row in block.rows for c in row))
            if pending is not None:
                errors.append({"kind": "adjacent_tables_require_explicit_boundary", "source_block": block_index})
                break
            pending = block
            if block_regions:
                block_regions[-1]["following_table"] = block
            continue
        if block.kind == "list":
            values = [(builder._plain_inline(value), f"{i}." if ordered else "•")
                      for i, (_, value, ordered) in enumerate(block.items, 1)]
        else:
            values = [(_block_text(block, builder), None)]
        for value, marker in values:
            if not value:
                continue
            expected_all.append(value)
            wanted = normalize(value)
            pos = text.find(wanted, cursor)
            if pos < 0:
                errors.append({"kind": "missing_or_changed_prose_block", "source_block": block_index + 1,
                               "expected": value, "actual_next_characters": text[cursor:cursor + len(wanted) + 100]})
                break
            gap = text[cursor:pos]
            if marker and gap.endswith(marker):
                gap = gap[:-len(marker)]
                list_markers.append({"source_block": block_index + 1, "marker": marker})
            if pending is not None:
                raw_gap = actual[raw_positions[cursor - 1] + 1 if cursor else 0:raw_positions[pos]]
                if marker:
                    raw_gap = re.sub(re.escape(marker) + r"\s*$", "", raw_gap)
                check_table(gap, pending, raw_gap)
                pending = None
            elif gap:
                errors.append({"kind": "unexplained_text_before_prose", "source_block": block_index + 1,
                               "actual": gap[:300]})
            raw_start = raw_positions[pos]
            raw_end = raw_positions[pos + len(wanted) - 1] + 1
            actual_block = actual[raw_start:raw_end]
            if re.findall(r"\w+", value) != re.findall(r"\w+", actual_block):
                token_boundary_errors.append({"source_block": block_index + 1,
                                              "expected": value, "actual": actual_block})
            block_regions.append({"source_block": block_index + 1, "expected": value,
                                  "raw_start": raw_start})
            cursor = pos + len(wanted)
            blocks_checked += 1
        if errors:
            break
    if not errors:
        remainder = text[cursor:]
        if pending is not None:
            check_table(remainder, pending, actual[raw_positions[cursor - 1] + 1 if cursor else 0:])
        elif remainder:
            errors.append({"kind": "unexplained_trailing_text", "actual": remainder[:300]})
    local_arrow_errors = []
    table_index = 0
    for i, region in enumerate(block_regions):
        end = block_regions[i + 1]["raw_start"] if i + 1 < len(block_regions) else len(actual)
        expected_region = region["expected"]
        table = region.get("following_table")
        if table is not None:
            expected_region += " ".join(builder._plain_inline(c) for row in table.rows for c in row)
            repetitions = tables[table_index]["additional_whole_header_repetitions"] if table_index < len(tables) else 0
            expected_region += " ".join(builder._plain_inline(c) for c in table.rows[0]) * repetitions
            table_index += 1
        counts = {c: {"expected": expected_region.count(c),
                      "actual": actual[region["raw_start"]:end].count(c)} for c in ("→", "←")}
        if any(x["expected"] != x["actual"] for x in counts.values()):
            local_arrow_errors.append({"source_block": region["source_block"], "counts": counts})
    expected_text = " ".join(expected_all)
    arrow_counts = {c: {"expected": expected_text.count(c), "actual": actual.count(c)} for c in ("→", "←")}
    arrows_match = all(x["expected"] == x["actual"] for x in arrow_counts.values())
    return {
        "passed": not errors and not token_boundary_errors and not local_arrow_errors and arrows_match and all(t["character_multiset_match"] and t["word_boundary_inventory_match"] for t in tables),
        "comparison_scope": "Exact non-whitespace non-arrow prose characters in complete block order; each table interval's character inventory plus whole header repetitions. Prose word boundaries checked separately. Arrow counts checked globally and in each prose-block/following-table region; PDF table cell order not inferred. Independent DOCX checks cell text/order.",
        "non_table_blocks_checked": blocks_checked,
        "prose_ordered_match": not errors,
        "prose_mismatch_count": len(errors),
        "prose_mismatch_examples": errors,
        "arrow_counts": arrow_counts,
        "arrows_match": arrows_match,
        "prose_word_boundaries_match": not token_boundary_errors,
        "prose_word_boundary_errors": token_boundary_errors,
        "local_arrow_regions_match": not local_arrow_errors,
        "local_arrow_region_errors": local_arrow_errors,
        "native_list_markers_accounted": list_markers,
        "tables": tables,
    }


def _collapse(text: str) -> str:
    return re.sub(r"\s+", " ", text).strip()


def _flatten_outline(nodes, reader, depth=0):
    for node in nodes:
        if isinstance(node, list):
            yield from _flatten_outline(node, reader, depth + 1)
        else:
            page_obj = node.get("/Page")
            if page_obj is None:
                raise ValueError(f"Outline entry has no page destination: {node.get('/Title')!r}")
            yield {
                "title": str(node.get("/Title", "")),
                "depth": depth,
                "page": reader.get_page_number(page_obj) + 1,
                "top": _destination_top(node),
                "object_id": getattr(page_obj, "idnum", None),
            }


def _destination_top(destination) -> float | None:
    value = destination.get("/Top")
    return round(float(value), 2) if value is not None else None


def _outline_page_map(reader, parsed, builder) -> tuple[dict[str, int], list[dict[str, Any]]]:
    outline = list(_flatten_outline(reader.outline or [], reader))
    expected = parsed.headings
    if not outline or outline[0]["title"] != "Contents":
        raise ValueError("PDF outline does not begin with the Contents entry")
    entries = outline[1:]
    if len(entries) != len(expected):
        raise ValueError(f"Outline has {len(entries)} book headings; Markdown has {len(expected)}")
    ancestor_levels = []
    for i, (actual, source) in enumerate(zip(entries, expected), start=1):
        wanted = builder._plain_inline(source.text)
        if actual["title"] != wanted:
            raise ValueError(f"Outline heading {i} differs: PDF {actual['title']!r}; source {wanted!r}")
        # PDF outline depth counts existing ancestors. Markdown may jump from
        # level 1 to level 3 without defining an intermediate parent; that is
        # one parent-child edge, not two edges through an invented blank node.
        while ancestor_levels and ancestor_levels[-1] >= source.level:
            ancestor_levels.pop()
        wanted_depth = len(ancestor_levels)
        ancestor_levels.append(source.level)
        if actual["depth"] != wanted_depth:
            raise ValueError(f"Outline heading {i} has depth {actual['depth']}; source expects {wanted_depth}")
    return {f"BookHeading{i}": entry["page"] for i, entry in enumerate(entries, start=1)}, outline


def _check_docx(path: Path, parsed, builder, page_map: dict[str, int] | None = None) -> dict[str, Any]:
    builder.verify_output(parsed, path)
    doc = Document(str(path))
    bookmarks = {
        el.get(qn("w:name"))
        for el in doc.element.iter(qn("w:bookmarkStart"))
        if (el.get(qn("w:name")) or "").startswith("BookHeading")
    }
    expected = {f"BookHeading{i}" for i in range(1, len(parsed.headings) + 1)}
    if bookmarks != expected:
        raise ValueError(f"DOCX heading bookmarks mismatch: found {len(bookmarks)}, expected {len(expected)}")
    cached: dict[str, int] = {}
    for paragraph in doc.element.body.iter(qn("w:p")):
        anchors = [el.get(qn("w:anchor")) for el in paragraph.iter(qn("w:hyperlink"))]
        instructions = [el.text or "" for el in paragraph.iter(qn("w:instrText"))]
        for anchor in anchors:
            if anchor and anchor.startswith("BookHeading"):
                match = re.search(r"PAGEREF\s+(BookHeading\d+)\b", " ".join(instructions))
                if match:
                    result_text: list[str] = []
                    in_field_result = False
                    for element in paragraph.iter():
                        if element.tag == qn("w:fldChar"):
                            field_type = element.get(qn("w:fldCharType"))
                            if field_type == "separate":
                                in_field_result = True
                            elif field_type == "end" and in_field_result:
                                break
                        elif in_field_result and element.tag == qn("w:t"):
                            result_text.append(element.text or "")
                    page_match = re.fullmatch(r"\s*(\d+)\s*", "".join(result_text))
                    if page_match:
                        cached[anchor] = int(page_match.group(1))
    cache_mismatches = []
    if page_map is not None:
        for name, page in page_map.items():
            if cached.get(name) != page:
                cache_mismatches.append({"bookmark": name, "cached": cached.get(name), "actual": page})
    fields = [el.text or "" for el in doc.element.iter(qn("w:instrText"))]
    footer_fields = []
    for section in doc.sections:
        footer_fields.extend(el.text or "" for el in section.footer._element.iter(qn("w:instrText")))
    if not any("PAGE" in value for value in footer_fields):
        raise ValueError("DOCX footer has no PAGE field")
    table_cell_count = sum(len(row) for table in parsed.tables for row in table.rows)
    return {
        "heading_bookmarks": len(bookmarks),
        "native_tables": len(doc.tables),
        "table_rows": sum(len(table.rows) for table in doc.tables),
        "table_cells": table_cell_count,
        "table_cell_order_match": True,
        "contents_page_fields": len(cached),
        "cached_page_mismatches": cache_mismatches,
        "page_field_present": True,
    }


def _numeric_actualtext_page(page, reader):
    """Honor numeric PDF ActualText in an extraction-only page copy.

    LibreOffice's Graphite digit runs can include extra glyphs whose intended
    text is declared by marked-content ActualText. Pypdf currently reads those
    glyphs literally. Use the PDF's own numeric declaration, never manuscript
    text or a guessed replacement. Other text keeps the existing glyph/CMap
    path. The saved PDF is unchanged; independent PDFium parity remains required.
    """
    stream = ContentStream(page.get_contents(), reader, forced_encoding="bytes")
    stack = []
    font_name = None
    changed = False
    reverse_fonts = {}
    for index, (args, op) in enumerate(stream.operations):
        if op == b"Tf":
            font_name = args[0]
        elif op == b"BDC":
            props = args[1]
            if not isinstance(props, dict):
                props = page.get("/Resources", {}).get("/Properties", {}).get(props, {})
                if hasattr(props, "get_object"):
                    props = props.get_object()
            actual = props.get("/ActualText") if isinstance(props, dict) else None
            # With forced_encoding=bytes, UTF-16 PDF strings need their BOM.
            if isinstance(actual, bytes):
                actual = actual.decode("utf-16") if actual.startswith((b"\xfe\xff", b"\xff\xfe")) else actual.decode("latin1")
            numeric = isinstance(actual, str) and re.fullmatch(r"[0-9]+", actual)
            stack.append({"text": actual, "emitted": False} if numeric else None)
        elif op == b"BMC":
            stack.append(None)
        elif op == b"EMC":
            if not stack:
                raise ValueError("Unbalanced marked-content end in PDF")
            stack.pop()
        elif op in (b"Tj", b"TJ", b"'", b'"'):
            active = [scope for scope in stack if scope is not None]
            if not active:
                continue
            if len(active) != 1 or op not in (b"Tj", b"TJ"):
                raise ValueError("Unsupported nested or positioned numeric ActualText")
            if font_name not in reverse_fonts:
                font = page["/Resources"]["/Font"][font_name].get_object()
                encoding, cmap = get_encoding(font)
                if cmap.get(-1, 1) != 1:
                    raise ValueError("Numeric ActualText requires a supported single-byte font")
                reverse = {}
                for code in range(256):
                    try:
                        char = bytes([code]).decode(encoding) if isinstance(encoding, str) else encoding[code]
                    except (UnicodeError, LookupError, KeyError):
                        continue
                    value = cmap.get(char, char)
                    if isinstance(value, str) and re.fullmatch(r"[0-9]", value):
                        reverse.setdefault(value, bytes([code]))
                reverse_fonts[font_name] = reverse
            scope = active[0]
            value = "" if scope["emitted"] else scope["text"]
            try:
                encoded = b"".join(reverse_fonts[font_name][char] for char in value)
            except KeyError as error:
                raise ValueError("Numeric ActualText cannot be encoded by its PDF font") from error
            stream.operations[index] = ([ByteStringObject(encoded)], b"Tj")
            scope["emitted"] = True
            changed = True
    if stack:
        raise ValueError("Unbalanced marked-content start in PDF")
    if not changed:
        return page
    extraction_page = copy(page)
    extraction_page[NameObject("/Contents")] = stream
    return extraction_page


def _pdf_text(reader, first_body_page: int) -> str:
    parts: list[str] = []
    for page_number in range(first_body_page, len(reader.pages) + 1):
        page = _numeric_actualtext_page(reader.pages[page_number - 1], reader)
        text = page.extract_text() or ""
        text = re.sub(rf"^\s*Page\s+{page_number}\s*", "", text, count=1)
        parts.append(text)
    return _collapse(" ".join(parts))


def _pdfium_text(path: Path, first_body_page: int) -> tuple[str, list[dict[str, int]]]:
    """Independent word spacing readback, without source-driven text repairs.

    PDFium exposes a line-ending hyphen as U+FFFE in these rendered PDFs.
    Interpret that sentinel as a hyphen; the separate pypdf character check
    still has to confirm every hyphen against the unmodified source.
    """
    import pypdfium2 as pdfium

    document = pdfium.PdfDocument(str(path))
    parts = []
    sentinels = []
    for page_number in range(first_body_page, len(document) + 1):
        text = document[page_number - 1].get_textpage().get_text_range()
        count = text.count("\ufffe")
        if count:
            sentinels.append({"page": page_number, "line_hyphen_sentinels": count})
        text = text.replace("\ufffe", "-")
        text = re.sub(rf"^\s*Page\s+{page_number}\s*", "", text, count=1)
        parts.append(text)
    return _collapse(" ".join(parts)), sentinels


def _dual_pdf_body(parsed, builder, reader, path: Path, first_body_page: int) -> dict[str, Any]:
    pypdf_result = _compare_pdf_body(parsed, builder, _pdf_text(reader, first_body_page))
    pdfium_text, sentinels = _pdfium_text(path, first_body_page)
    pdfium_result = _compare_pdf_body(parsed, builder, pdfium_text)
    # pypdf inserts a false space after some multi-character glyph mappings
    # (e.g. Qu + estion). Keep that diagnostic; do not source-repair its text.
    # PDFium must independently pass ALL checks, including word boundaries,
    # while pypdf must pass every non-word-boundary check.
    pypdf_required = (pypdf_result["prose_ordered_match"]
                     and pypdf_result["arrows_match"]
                     and pypdf_result["local_arrow_regions_match"]
                     and all(t["character_multiset_match"] for t in pypdf_result["tables"]))
    return {
        **pdfium_result,
        "passed": pypdf_required and pdfium_result["passed"],
        "required_extractors": "pypdf ordered characters/tables/arrows AND PDFium all checks including word boundaries",
        "pypdf_required_checks_passed": pypdf_required,
        "pypdf_diagnostic": pypdf_result,
        "pdfium_line_hyphen_sentinels": sentinels,
    }


def _load_scoped_cmap_repairs(path: Path | None, raw_pdf: Path) -> list[dict[str, str]]:
    if path is None:
        return []
    data = json.loads(path.read_text(encoding="utf-8"))
    executable = shutil.which("b3sum")
    if executable is None:
        raise ValueError("BLAKE3 owner b3sum is required for scoped CMap repairs")
    actual_hash = subprocess.check_output([executable, str(raw_pdf)], text=True).split()[0]
    if actual_hash != data.get("raw_pdf_blake3"):
        raise ValueError("Scoped CMap repairs are bound to a different raw PDF")
    before = _cmap_entries(raw_pdf)
    repairs = data.get("repairs")
    if not isinstance(repairs, list) or not repairs:
        raise ValueError("Scoped CMap repair list must be nonempty")
    seen = set()
    for repair in repairs:
        key = (repair.get("font"), repair.get("glyph_code", "").upper())
        if key in seen or not re.fullmatch(r"[0-9A-F]+", key[1]) or before.get(key) != repair.get("from"):
            raise ValueError("Scoped CMap repair has a duplicate or mismatched glyph")
        if repair.get("from") is None and not any(font == key[0] for font, _ in before):
            raise ValueError("Scoped CMap addition requires an existing bound font")
        if not isinstance(repair.get("to"), str) or not repair["to"] or repair["to"] == repair["from"]:
            raise ValueError("Scoped CMap repair requires a distinct nonempty Unicode value")
        seen.add(key)
        repair["glyph_code"] = key[1]
    return repairs


def _repair_cmaps(raw_pdf: Path, final_pdf: Path, scoped_repairs=None) -> list[dict[str, str]]:
    if final_pdf.exists():
        raise FileExistsError(f"Refusing to overwrite existing PDF: {final_pdf}")
    writer = PdfWriter(clone_from=str(raw_pdf))
    repairs: list[dict[str, str]] = []
    seen_streams: set[tuple[int | None, int | None]] = set()
    for page in writer.pages:
        resources = page.get("/Resources")
        if not resources:
            continue
        fonts = resources.get_object().get("/Font", {})
        for font_name, font_ref in fonts.items():
            font = font_ref.get_object()
            cmap_ref = font.get("/ToUnicode")
            if cmap_ref is None:
                continue
            cmap = cmap_ref.get_object()
            marker = (getattr(cmap_ref, "idnum", None), getattr(cmap_ref, "generation", None))
            if marker in seen_streams:
                continue
            seen_streams.add(marker)
            original = cmap.get_data()
            updated, cmap_repairs = _repair_cmap_data(original, str(font.get("/BaseFont", font_name)))
            repairs.extend(cmap_repairs)
            for repair in scoped_repairs or []:
                if repair["font"] != str(font.get("/BaseFont", font_name)):
                    continue
                glyph = repair["glyph_code"].encode("ascii")
                after = repair["to"].encode("utf-16-be").hex().upper().encode("ascii")
                if repair["from"] is None:
                    # LibreOffice can omit a used ligature entirely. Add its
                    # mapping without changing a real letter with the same
                    # fallback extraction (e.g. unmapped 43 versus mapped 2A).
                    entry = b"1 beginbfchar\n<" + glyph + b"> <" + after + b">\nendbfchar\n"
                    updated, count = re.subn(rb"(?m)^endcmap\s*$", lambda match: entry + match.group(0), updated)
                else:
                    before = repair["from"].encode("utf-16-be").hex().encode("ascii")
                    pattern = re.compile(rb"(<" + glyph + rb">\s*)<" + before + rb">", re.I)
                    updated, count = pattern.subn(lambda match: match.group(1) + b"<" + after + b">", updated)
                if count != 1:
                    raise ValueError("Scoped CMap repair must match exactly one bound glyph mapping")
                repairs.append({key: repair[key] for key in ("font", "glyph_code", "from", "to")})
            if updated != original:
                cmap.set_data(updated)
    if not repairs:
        raise ValueError("No observed source-confirmed ToUnicode mappings matched the repair table")
    final_pdf.parent.mkdir(parents=True, exist_ok=True)
    with final_pdf.open("wb") as stream:
        writer.write(stream)
    return repairs


def _repair_cmap_data(original: bytes, font_name: str) -> tuple[bytes, list[dict[str, str]]]:
    """Apply only source-confirmed source-text repairs to a ToUnicode CMap."""
    updated = original
    repairs: list[dict[str, str]] = []
    for before, after in CMAP_REPAIRS.items():
        old_hex = before.encode("utf-16-be").hex().upper().encode("ascii")
        new_hex = after.encode("utf-16-be").hex().upper().encode("ascii")
        pattern = re.compile(rb"(<[0-9A-Fa-f]+>\s*)<" + old_hex + rb">")
        for match in list(pattern.finditer(updated)):
            updated = updated[:match.start()] + match.group(1) + b"<" + new_hex + b">" + updated[match.end():]
            repairs.append({
                "font": font_name,
                "glyph_code": re.search(rb"<([0-9A-Fa-f]+)>", match.group(1)).group(1).decode("ascii"),
                "from": before,
                "to": after,
            })
    return updated, repairs


def _cmap_entries(pdf_path: Path) -> dict[tuple[str, str], str]:
    reader = PdfReader(str(pdf_path))
    entries: dict[tuple[str, str], str] = {}
    visited: set[tuple[int | None, int | None]] = set()
    for page in reader.pages:
        resources = page.get("/Resources")
        if not resources:
            continue
        for name, ref in resources.get_object().get("/Font", {}).items():
            font = ref.get_object()
            cmap_ref = font.get("/ToUnicode")
            if cmap_ref is None:
                continue
            marker = (getattr(cmap_ref, "idnum", None), getattr(cmap_ref, "generation", None))
            if marker in visited:
                continue
            visited.add(marker)
            content = cmap_ref.get_object().get_data()
            base_font = str(font.get("/BaseFont", name))
            for match in re.finditer(rb"<([0-9A-Fa-f]+)>\s*<([0-9A-Fa-f]+)>", content):
                source_code, target_code = match.groups()
                if len(target_code) % 4:
                    continue
                try:
                    target = bytes.fromhex(target_code.decode("ascii")).decode("utf-16-be")
                except (ValueError, UnicodeDecodeError):
                    continue
                entries[(base_font, source_code.decode("ascii").upper())] = target
    return entries


def _audit_cmap_delta(raw_pdf: Path, final_pdf: Path, scoped_repairs=None) -> dict[str, Any]:
    before = _cmap_entries(raw_pdf)
    after = _cmap_entries(final_pdf)
    changes = []
    unexpected = []
    allowed = set(CMAP_REPAIRS.items())
    scoped = {(r["font"], r["glyph_code"], r["from"], r["to"]) for r in scoped_repairs or []}
    for key in sorted(before.keys() | after.keys()):
        old = before.get(key)
        new = after.get(key)
        if old == new:
            continue
        change = {"font": key[0], "glyph_code": key[1], "from": old, "to": new}
        changes.append(change)
        if (old, new) not in allowed and (key[0], key[1], old, new) not in scoped:
            unexpected.append(change)
    preserved: dict[str, bool] = {}
    for ligature in ("fi", "fl"):
        before_keys = {key for key, value in before.items() if value == ligature}
        after_keys = {key for key, value in after.items() if value == ligature}
        preserved[ligature] = before_keys <= after_keys
    return {
        "passed": bool(changes) and not unexpected and all(preserved.values()),
        "changed_entries": changes,
        "unexpected_changes": unexpected,
        "valid_ligatures_unchanged": preserved,
        "valid_ligature_mapping_counts": {
            value: {
                "raw": sum(1 for entry in before.values() if entry == value),
                "final": sum(1 for entry in after.values() if entry == value),
            } for value in ("fi", "fl")
        },
    }


def _pixel_parity(raw_pdf: Path, final_pdf: Path) -> dict[str, Any]:
    import pypdfium2 as pdfium

    before = pdfium.PdfDocument(str(raw_pdf))
    after = pdfium.PdfDocument(str(final_pdf))
    if len(before) != len(after):
        return {"passed": False, "raw_pages": len(before), "final_pages": len(after), "first_difference": "page_count"}
    for page_index in range(len(before)):
        raw_bitmap = before[page_index].render(scale=1).to_pil().convert("RGBA")
        final_bitmap = after[page_index].render(scale=1).to_pil().convert("RGBA")
        if raw_bitmap.size != final_bitmap.size or raw_bitmap.tobytes() != final_bitmap.tobytes():
            return {
                "passed": False,
                "raw_pages": len(before),
                "final_pages": len(after),
                "first_difference": {"page": page_index + 1, "raw_size": raw_bitmap.size, "final_size": final_bitmap.size},
            }
    return {"passed": True, "raw_pages": len(before), "final_pages": len(after), "first_difference": None}


def _prebody_blank_pages(reader, first_body_page: int) -> dict[str, Any]:
    """Reject unintended empty generated pages between Contents and body."""
    blank = []
    for page_number, page in enumerate(reader.pages[:first_body_page - 1], 1):
        compact = re.sub(r"\s+", "", page.extract_text() or "")
        if not compact or re.fullmatch(r"Page[0-9]+", compact):
            blank.append(page_number)
    return {"passed": not blank, "pages_checked": first_body_page - 1,
            "footer_only_or_empty_pages": blank}


def _link_destinations(reader, first_body_page: int, outline_entries: list[dict[str, Any]], heading_count: int) -> dict[str, Any]:
    actual: collections.Counter[tuple[int, float | None]] = collections.Counter()
    for page_index in range(first_body_page - 1):
        page = reader.pages[page_index]
        for ref in page.get("/Annots", []):
            annotation = ref.get_object()
            if annotation.get("/Subtype") != "/Link":
                continue
            destination = annotation.get("/Dest")
            if not isinstance(destination, list) or len(destination) < 2:
                continue
            target_page = reader.get_page_number(destination[0]) + 1
            top = round(float(destination[3]), 2) if len(destination) > 3 and destination[1] == "/XYZ" and destination[3] is not None else None
            actual[(target_page, top)] += 1
    expected: collections.Counter[tuple[int, float | None]] = collections.Counter(
        (entry["page"], entry["top"]) for entry in outline_entries[1:]
    )
    expected = collections.Counter({key: count * 2 for key, count in expected.items()})
    return {
        "observed_toc_link_annotations": sum(actual.values()),
        "expected_toc_link_annotations": 2 * heading_count,
        "destinations_match_outline": actual == expected,
        "unexpected_destinations": [
            {"page": key[0], "top": key[1], "count": count, "expected_count": expected.get(key, 0)}
            for key, count in actual.items() if count != expected.get(key, 0)
        ],
        "missing_destinations": [
            {"page": key[0], "top": key[1], "count": count, "actual_count": actual.get(key, 0)}
            for key, count in expected.items() if count != actual.get(key, 0)
        ],
    }


def _write_report(path: Path, data: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(data, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")


def main(argv=None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--source", required=True, type=Path)
    parser.add_argument("--docx", required=True, type=Path)
    parser.add_argument("--raw-pdf", required=True, type=Path)
    parser.add_argument("--final-pdf", type=Path, help="Final cmap-repaired PDF to verify")
    parser.add_argument("--repair-cmap", action="store_true", help="Repair confirmed cmap mappings from raw PDF into --final-pdf")
    parser.add_argument("--scoped-cmap-repairs", type=Path, help="Additional exact font/glyph repairs bound to this raw PDF BLAKE3")
    parser.add_argument("--report", required=True, type=Path, help="JSON report output")
    parser.add_argument("--page-map-out", type=Path, help="Write BookHeadingN to 1-based page JSON")
    args = parser.parse_args(argv)
    if args.repair_cmap and args.final_pdf is None:
        parser.error("--repair-cmap requires --final-pdf")

    report: dict[str, Any] = {
        "status": "failed",
        "source": str(args.source),
        "docx": str(args.docx),
        "raw_pdf": str(args.raw_pdf),
        "final_pdf": str(args.final_pdf) if args.final_pdf else None,
        "checks": {},
        "unresolved_discrepancies": [],
    }
    try:
        if not all(p.is_file() for p in (args.source, args.docx, args.raw_pdf)):
            raise FileNotFoundError("Source Markdown, DOCX, and raw PDF must all exist")
        scoped_repairs = _load_scoped_cmap_repairs(args.scoped_cmap_repairs, args.raw_pdf)
        if args.scoped_cmap_repairs:
            report["scoped_cmap_repairs"] = {"path": str(args.scoped_cmap_repairs), "repairs": scoped_repairs}
        check = subprocess.run(
            [str(RUNTIME_PYTHON), str(BUILDER), str(args.source), "--check"],
            check=True, capture_output=True, text=True,
        )
        builder = _load_builder()
        parsed = builder.parse_markdown(args.source.read_text(encoding="utf-8"))
        report["checks"]["markdown_parser"] = {"passed": True, "readback": check.stdout.strip()}
        raw_reader = PdfReader(str(args.raw_pdf))
        page_map, outline = _outline_page_map(raw_reader, parsed, builder)
        first_body_page = page_map["BookHeading1"]
        report["page_map"] = page_map
        report["checks"]["outline"] = {"passed": True, "entries": len(outline), "first_body_page": first_body_page}
        docx_result = _check_docx(args.docx, parsed, builder, page_map)
        report["checks"]["docx_readback"] = {"passed": True, **docx_result}
        if docx_result["cached_page_mismatches"]:
            report["unresolved_discrepancies"].append({
                "kind": "docx_cached_pageref_mismatch",
                "count": len(docx_result["cached_page_mismatches"]),
                "examples": docx_result["cached_page_mismatches"][:10],
            })
        links = _link_destinations(raw_reader, first_body_page, outline, len(parsed.headings))
        report["checks"]["contents_links"] = {"passed": links["destinations_match_outline"], **links}
        if not links["destinations_match_outline"]:
            report["unresolved_discrepancies"].append({"kind": "contents_link_destinations", **links})
        blank_pages = _prebody_blank_pages(raw_reader, first_body_page)
        report["checks"]["prebody_pages"] = blank_pages
        if not blank_pages["passed"]:
            report["unresolved_discrepancies"].append({"kind": "unintended_blank_prebody_page", **blank_pages})
        if args.page_map_out:
            _write_report(args.page_map_out, page_map)

        target_pdf = args.final_pdf if args.final_pdf else args.raw_pdf
        if args.repair_cmap:
            report["cmap_repairs"] = _repair_cmaps(args.raw_pdf, target_pdf, scoped_repairs)
            cmap_audit = _audit_cmap_delta(args.raw_pdf, target_pdf, scoped_repairs)
            report["checks"]["cmap_delta"] = cmap_audit
            if not cmap_audit["passed"]:
                report["unresolved_discrepancies"].append({"kind": "unexpected_cmap_delta", **cmap_audit})
            pixel = _pixel_parity(args.raw_pdf, target_pdf)
            report["checks"]["page_pixels"] = pixel
            if not pixel["passed"]:
                report["unresolved_discrepancies"].append({"kind": "page_pixel_change", **pixel})
        target_reader = PdfReader(str(target_pdf))
        body_comparison = _dual_pdf_body(parsed, builder, target_reader, target_pdf, first_body_page)
        report["checks"]["pdf_body_text"] = body_comparison
        text_equal = body_comparison["passed"]
        if not text_equal:
            report["unresolved_discrepancies"].append({
                "kind": "pdf_scoped_body_mismatch",
                "prose_mismatch_count": body_comparison["prose_mismatch_count"],
                "prose_mismatch_examples": body_comparison["prose_mismatch_examples"],
                "arrow_counts": body_comparison["arrow_counts"],
                "table_mismatches": [
                    item for item in body_comparison["tables"]
                    if not item["character_multiset_match"]
                ],
            })
        if args.final_pdf and not args.repair_cmap:
            cmap_audit = _audit_cmap_delta(args.raw_pdf, args.final_pdf, scoped_repairs)
            report["checks"]["cmap_delta"] = cmap_audit
            if not cmap_audit["passed"]:
                report["unresolved_discrepancies"].append({"kind": "unexpected_cmap_delta", **cmap_audit})
            report["checks"]["page_pixels"] = _pixel_parity(args.raw_pdf, args.final_pdf)
            if not report["checks"]["page_pixels"]["passed"]:
                report["unresolved_discrepancies"].append({"kind": "page_pixel_change", **report["checks"]["page_pixels"]})
        report["status"] = "passed" if not report["unresolved_discrepancies"] and text_equal else "failed"
    except Exception as exc:
        report["error"] = f"{type(exc).__name__}: {exc}"
        report["unresolved_discrepancies"].append({"kind": "verification_error", "detail": report["error"]})
    _write_report(args.report, report)
    summary = {
        "status": report["status"],
        "report": str(args.report),
        "page_map": str(args.page_map_out) if args.page_map_out else None,
        "checks": {name: item.get("passed") for name, item in report.get("checks", {}).items()},
        "cmap_repairs": len(report.get("cmap_repairs", [])),
        "unresolved": [
            {
                "kind": item["kind"],
                "count": item.get("count", item.get("prose_mismatch_count")),
                "examples": item.get("examples", item.get("prose_mismatch_examples", []))[:2],
            }
            for item in report.get("unresolved_discrepancies", [])
        ],
        "error": report.get("error"),
    }
    print(json.dumps(summary, indent=2, ensure_ascii=False))
    return 0 if report["status"] == "passed" else 1


if __name__ == "__main__":
    raise SystemExit(main())
