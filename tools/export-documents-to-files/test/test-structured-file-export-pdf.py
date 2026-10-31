#!/usr/bin/env python3
"""Exercise Unicode embedding, extracted order, pagination, and fail-closed coverage."""

import json
import os
import runpy
import subprocess
import sys
import tempfile
from pathlib import Path

try:
    from pypdf import PdfReader
except ImportError:
    print(json.dumps({"skipped": "needs pypdf"}))
    sys.exit(0)

ROOT = Path(__file__).resolve().parents[1]
RENDERER = ROOT / "do-work" / "render-structured-file-export.py"


def node(text=None, children=None, heading_level=None):
    props = {"text": text} if text is not None else {}
    if heading_level is not None:
        props["heading_level"] = heading_level
    return {"props": props, "children": children or []}


def table_node(rows):
    return node(children=[node(children=[node(cell) for cell in row]) for row in rows])


def run(directory, font_file="Arial.ttf", extra_paragraphs=0, unsupported_char="", second_table_columns=12,
        include_heading_level_path=True, title="Synthetic Unicode PDF export"):
    paragraphs = [
        node(f"Café: “Unicode” × 65–80%; arrows ← →; math ± ÷. {unsupported_char}"),
        node("Second paragraph remains between the tables."),
        node("Paragraph after both tables."),
    ] + [node(f"Pagination paragraph {index:03d}: résumé, arrows ← →, ± ÷.") for index in range(extra_paragraphs)]
    first_table = table_node([
        ["First table header", "Column A"],
        ["First table value", "Café × 65–80%"],
    ])
    second_table = table_node([
        ["Second table header"] + [f"Column {index}" for index in range(1, second_table_columns)],
        ["Long Unicode cell: " + "é" * 320] + [f"value-{index}" for index in range(1, second_table_columns)],
    ])
    job = {
        "title": title,
        "descriptor": {"format_id": "pdf", "destination_dir": directory, "file_stem": "synthetic"},
        "tree": node(title, [node("Unicode section heading", [
            paragraphs[0], first_table, paragraphs[1], second_table,
            node("Subsection heading", [node("Subsection body.")], heading_level=3),
            *paragraphs[2:],
        ], heading_level=1)]),
    }
    rules = {
        "kind": "structured-file-projection-rules",
        "id": "synthetic",
        "text_properties": ["text"],
        "table": {"min_cells": 2, "min_rows": 2},
        "skip_root_text_matching_title": True,
        "heading_level_path": ["props", "heading_level"],
        "formats": {"pdf": {
            "extension": "pdf", "renderer": "pdf", "font_family": "SyntheticUnicode",
            "font_file": font_file, "default_heading_level": 2,
            "heading_styles": {
                "1": {"font_size": 18, "leading": 22, "space_before": 16, "space_after": 8},
                "2": {"font_size": 15, "leading": 19, "space_before": 14, "space_after": 7},
                "3": {"font_size": 12, "leading": 16, "space_before": 11, "space_after": 5},
            },
        }},
    }
    if not include_heading_level_path:
        rules.pop("heading_level_path")
    result_path = Path(directory) / "result.json"
    return subprocess.run([
        sys.executable, str(RENDERER),
        "--job-json", json.dumps(job),
        "--rules-rows-json", json.dumps([{"payload": rules}]),
        "--result-path", str(result_path),
    ], cwd=ROOT, capture_output=True, text=True), result_path


def main():
    try:
        runpy.run_path(str(RENDERER))["resolve_pdf_font"]("Arial.ttf")
    except (RuntimeError, FileNotFoundError):
        print(json.dumps({"skipped": "needs reportlab and the Arial.ttf font"}))
        return
    with tempfile.TemporaryDirectory(prefix="structured-output-pdf-") as directory:
        result, result_path = run(directory, extra_paragraphs=130)
        if result.returncode != 0:
            raise SystemExit(result.stderr or result.stdout)
        metadata = json.loads(result_path.read_text())
        pdf_path = Path(metadata["path"])
        reader = PdfReader(pdf_path)
        if "Synthetic Unicode PDF export" not in (reader.pages[0].extract_text() or ""):
            raise SystemExit("PDF title was not rendered on the first page")
        text = "\n".join(page.extract_text() or "" for page in reader.pages)
        # ReportLab wraps table text at column boundaries. Some PDF extractors
        # expose those visual line breaks as spaces inside a word, so compare
        # the recovered character stream without layout whitespace.
        compact_text = "".join(text.split())
        for snippet in (
            "Café: “Unicode” × 65–80%; arrows ← →; math ± ÷.",
            "Café × 65–80%",
            "First table header",
            "Second table header",
            "Subsection heading",
            "Subsection body.",
            "Paragraph after both tables.",
            "Pagination paragraph 129: résumé, arrows ← →, ± ÷.",
        ):
            if "".join(snippet.split()) not in compact_text:
                raise SystemExit(f"PDF text extraction lost or changed {snippet!r}")
        ordered = [
            "Synthetic Unicode PDF export", "Unicode section heading",
            "Café: “Unicode” × 65–80%; arrows ← →; math ± ÷.",
            "First table header", "Café × 65–80%", "Second paragraph remains between the tables.",
            "Second table header", "Long Unicode cell:", "Subsection heading", "Subsection body.",
            "Paragraph after both tables.",
            "Pagination paragraph 129:",
        ]
        positions = [compact_text.index("".join(snippet.split())) for snippet in ordered]
        if positions != sorted(positions):
            raise SystemExit("PDF paragraph/table order changed")
        def assert_cells_in_order(cells, description):
            cell_positions = [compact_text.index("".join(cell.split())) for cell in cells]
            if cell_positions != sorted(cell_positions):
                raise SystemExit(f"PDF {description} cells were reordered")

        assert_cells_in_order(
            ["Second table header"] + [f"Column {index}" for index in range(1, 12)],
            "second table header",
        )
        assert_cells_in_order(
            ["Long Unicode cell:"] + [f"value-{index}" for index in range(1, 12)],
            "second table body row",
        )
        extracted_lines = ["".join(line.split()) for line in text.splitlines() if line.strip()]
        for paragraph in (
            "Café: “Unicode” × 65–80%; arrows ← →; math ± ÷.",
            "Second paragraph remains between the tables.",
            "Paragraph after both tables.",
            "Pagination paragraph 129: résumé, arrows ← →, ± ÷.",
        ):
            if "".join(paragraph.split()) not in extracted_lines:
                raise SystemExit(f"PDF paragraph boundary or text changed: {paragraph!r}")
        if "".join(("é" * 320).split()) not in compact_text:
            raise SystemExit("PDF wrapped or clipped the long Unicode table cell")
        if len(reader.pages) < 3:
            raise SystemExit("PDF renderer did not paginate long synthetic output")

        heading_sizes = {}
        for page in reader.pages:
            def collect_heading_size(text, _cm, _tm, _font, font_size):
                for heading in ("Unicode section heading", "Subsection heading"):
                    if heading in text:
                        heading_sizes[heading] = font_size
            page.extract_text(visitor_text=collect_heading_size)
        if heading_sizes.get("Unicode section heading") != 18 or heading_sizes.get("Subsection heading") != 12:
            raise SystemExit(f"PDF heading levels did not select DATA typography: {heading_sizes!r}")
        embedded = False
        for page in reader.pages:
            for font in (page.get("/Resources", {}).get("/Font", {}) or {}).values():
                descriptor = font.get_object().get("/FontDescriptor")
                if descriptor and descriptor.get_object().get("/FontFile2"):
                    embedded = True
        if not embedded:
            raise SystemExit("PDF did not embed its configured TrueType font")

        empty_title_dir = Path(directory) / "empty-title"
        empty_title_dir.mkdir()
        empty_title_result, empty_title_result_path = run(str(empty_title_dir), title="")
        if empty_title_result.returncode != 0:
            raise SystemExit(empty_title_result.stderr or empty_title_result.stdout)
        empty_title_metadata = json.loads(empty_title_result_path.read_text())
        empty_title_pdf = PdfReader(empty_title_metadata["path"])
        empty_title_text = (empty_title_pdf.pages[0].extract_text() or "").strip()
        if not empty_title_text.startswith("Unicode section heading"):
            raise SystemExit("PDF empty title inserted blank space or displaced the source H1")
        if "Synthetic Unicode PDF export" in empty_title_text:
            raise SystemExit("PDF empty title unexpectedly emitted the default title")
        empty_heading_sizes = {}
        for page in empty_title_pdf.pages:
            def collect_empty_heading_size(text, _cm, _tm, _font, font_size):
                if "Unicode section heading" in text:
                    empty_heading_sizes["Unicode section heading"] = font_size
            page.extract_text(visitor_text=collect_empty_heading_size)
        if empty_heading_sizes.get("Unicode section heading") != 18:
            raise SystemExit(f"PDF empty title changed the source H1 style: {empty_heading_sizes!r}")

        missing_dir = Path(directory) / "missing-font"
        missing_dir.mkdir()
        unsupported, unsupported_result = run(str(missing_dir), font_file="missing-font.ttf")
        if unsupported.returncode == 0 or "not found" not in unsupported.stderr:
            raise SystemExit("PDF renderer did not fail closed for a missing configured font")
        if unsupported_result.exists():
            raise SystemExit("PDF renderer reported a result after missing-font failure")

        coverage_dir = Path(directory) / "missing-glyph"
        coverage_dir.mkdir()
        unsupported_glyph, coverage_result = run(str(coverage_dir), unsupported_char="☃")
        if unsupported_glyph.returncode == 0 or "lacks glyph coverage" not in unsupported_glyph.stderr:
            raise SystemExit("PDF renderer silently substituted a character missing from the configured font")
        if coverage_result.exists():
            raise SystemExit("PDF renderer reported a result after a font coverage failure")

        wide_dir = Path(directory) / "too-many-columns"
        wide_dir.mkdir()
        too_wide, too_wide_result = run(str(wide_dir), second_table_columns=43)
        if too_wide.returncode == 0 or "cannot fit the printable width" not in too_wide.stderr:
            raise SystemExit("PDF renderer did not fail explicitly for an impossible column count")
        if too_wide_result.exists():
            raise SystemExit("PDF renderer reported a result after impossible table width")

        print(json.dumps({"pages": len(reader.pages), "unicode_round_trip": True,
                          "ordered_interleaving": True, "long_unicode_table_cell": True,
                          "empty_title_preserves_root_h1": True,
                          "many_columns_fit": True, "impossible_column_count_fails_closed": True,
                          "embedded_font": True, "missing_font_fails_closed": True,
                          "missing_glyph_fails_closed": True}))


if __name__ == "__main__":
    main()
