#!/usr/bin/env python3
"""Synthetic source-to-consumer checks: no manuscript fixtures or skip paths."""
import copy
from io import BytesIO
import json
from pathlib import Path
import runpy
import subprocess
import sys
import tempfile
import unittest
from zipfile import ZipFile
import xml.etree.ElementTree as ET

from docx import Document
from pypdf import PdfReader
import pypdfium2 as pdfium

ROOT = Path(__file__).resolve().parents[1]
RENDER = runpy.run_path(str(ROOT / "do-work/render-structured-file-export.py"))
PROJECT = runpy.run_path(str(ROOT / "do-work/project-markdown-source.py"))["project_source_snapshot"]
GATE = runpy.run_path(str(ROOT / "do-work/writing_gate.py"))
BOOK = runpy.run_path(str(ROOT / "do-work/export_markdown_book_to_word.py"))
SOURCE = ("# Synthetic source\n\n## Ordered section\n\n"
          "3) First item\n  + Second item\n    7. Third item\n\n"
          "```text\n\n  A → B\n\tC  D  \n\n  End\n\n```\n\n"
          "After the literal.\n\n| Header | Other |\n| --- | --- |\n| A | B |\n| C |  |\n").encode()


def identity(source):
    return "1f:" + GATE["_snapshot_hash"](source)


def rules():
    value = json.loads((ROOT / "read-data/starter-projection-rules.json").read_text())[0]
    value["literal_text"] = {"path": ["props", "text_mode"], "equals": "literal"}
    value["indent_level_path"] = ["props", "indent_level"]
    value["formats"]["pdf"]["font_file"] = "Arial.ttf"
    value["formats"]["pdf"]["literal_font_file"] = "Courier New.ttf"
    return value


class SourceProjectionTests(unittest.TestCase):
    def setUp(self):
        self.projection = PROJECT(SOURCE, identity(SOURCE))
        self.rules = rules()
        self.sections = RENDER["project"](self.projection["tree"], self.rules)
        self.literal = "\n  A → B\n\tC  D  \n\n  End\n"

    def test_order_identity_markers_and_boundaries(self):
        self.assertEqual(self.projection["source_identity"], identity(SOURCE))
        self.assertEqual([b["kind"] for b in self.projection["ordered_blocks"]],
                         ["heading", "list_item", "list_item", "list_item", "literal", "paragraph", "table"])
        self.assertEqual([b["text"] for b in self.projection["ordered_blocks"][1:4]],
                         ["3) First item", "+ Second item", "7. Third item"])
        self.assertEqual([b["indent_level"] for b in self.projection["ordered_blocks"][1:4]], [0, 1, 2])
        self.assertEqual(self.projection["ordered_blocks"][4]["text"], self.literal)
        self.assertEqual(self.projection["ordered_blocks"][-1]["rows"], [["Header", "Other"], ["A", "B"], ["C", ""]])
        self.assertEqual([b["source_block_index"] for b in self.projection["ordered_bindings"]], [0, 1, 1, 1, 2, 3, 4])
        with self.assertRaisesRegex(ValueError, "identity"):
            PROJECT(SOURCE + b"changed", identity(SOURCE))
        parsed = BOOK["parse_markdown"](SOURCE.decode())
        self.assertEqual(PROJECT(SOURCE, identity(SOURCE), parsed=parsed), self.projection)
        parsed.blocks[2].text = "altered"
        with self.assertRaisesRegex(ValueError, "snapshot"):
            PROJECT(SOURCE, identity(SOURCE), parsed=parsed)

    def test_rule_selected_vocabulary_and_unsupported_target(self):
        tree = copy.deepcopy(self.projection["tree"])
        def rename(node):
            props = node["props"]
            for before, after in (("text", "value"), ("text_mode", "spacing"), ("indent_level", "depth")):
                if before in props:
                    props[after] = props.pop(before)
            for child in node["children"]:
                rename(child)
        rename(tree)
        selected = copy.deepcopy(self.rules)
        selected["text_properties"] = ["value"]
        selected["literal_text"]["path"] = ["props", "spacing"]
        selected["indent_level_path"] = ["props", "depth"]
        self.assertEqual(RENDER["project"](tree, selected), self.sections)
        with self.assertRaisesRegex(ValueError, "native DOCX or PDF"):
            RENDER["render"]("Synthetic", self.sections, self.rules["formats"]["markdown"])

    def test_ragged_source_and_tree_refused(self):
        source = b"# Synthetic\n\n| A | B |\n| --- | --- |\n| C |\n"
        with self.assertRaisesRegex(ValueError, "cells"):
            PROJECT(source, identity(source))
        tree = copy.deepcopy(self.projection["tree"])
        tree["children"][-1]["children"][-1]["children"].pop()
        with self.assertRaisesRegex(ValueError, "equal cell counts"):
            RENDER["project"](tree, self.rules)

    def test_docx_native_breaks_tabs_exact_literal_and_indent(self):
        data = RENDER["render_docx"]("UNFINISHED synthetic", self.sections, self.rules["formats"]["docx"])
        document = Document(BytesIO(data))
        self.assertIn(self.literal, [p.text for p in document.paragraphs])
        self.assertEqual([p.paragraph_format.left_indent.pt for p in document.paragraphs
                          if p.text in ["+ Second item", "7. Third item"]], [18, 36])
        self.assertEqual([[c.text for c in row.cells] for row in document.tables[0].rows],
                         self.projection["ordered_blocks"][-1]["rows"])
        with ZipFile(BytesIO(data)) as archive:
            xml = ET.fromstring(archive.read("word/document.xml"))
        ns = {"w": "http://schemas.openxmlformats.org/wordprocessingml/2006/main"}
        self.assertEqual(len(xml.findall(".//w:tab", ns)), 1)
        self.assertEqual(len(xml.findall(".//w:br", ns)), self.literal.count("\n"))

    def test_pdf_literal_spacing_geometry_and_long_line_refusal(self):
        data = RENDER["render_pdf"]("UNFINISHED synthetic", self.sections, self.rules["formats"]["pdf"])
        reader = PdfReader(BytesIO(data))
        text = "\n".join(page.extract_text() for page in reader.pages)
        self.assertIn("  A → B\n    C  D  ", text)
        positions = [text.index(token) for token in ["First item", "Second item", "Third item", "A → B", "After the literal.", "Header"]]
        self.assertEqual(positions, sorted(positions))
        observed = {}
        for page in reader.pages:
            def visitor(text, cm, tm, font, size):
                for label in ("A → B", "C  D", "End", "+ Second item", "7. Third item"):
                    if label in text:
                        observed[label] = (cm[4] + tm[4], cm[5] + tm[5], size)
            page.extract_text(visitor_text=visitor)
        self.assertEqual(observed["A → B"][2], 9)
        self.assertGreater(observed["7. Third item"][0], observed["+ Second item"][0])
        # PDFium checks actual glyph geometry; pypdf's visitor miscalculates
        # positions for ReportLab's preformatted TL/T* text operators.
        with pdfium.PdfDocument(data) as pdf:
            page = pdf[0]
            text_page = page.get_textpage()
            def box(label):
                search = text_page.search(label)
                match = search.get_next()
                search.close()
                self.assertIsNotNone(match)
                return text_page.get_charbox(match[0])
            a, c, end = box("A → B"), box("C  D"), box("End")
            self.assertAlmostEqual(a[1] - end[1], 36, places=2)
            self.assertAlmostEqual(c[0] - a[0], 11.286, places=2)
            for index in range(text_page.count_chars()):
                left, bottom, right, top = text_page.get_charbox(index)
                self.assertGreaterEqual(left, 0)
                self.assertLessEqual(right, page.get_width())
            text_page.close()
            page.close()
        sections = copy.deepcopy(self.sections)
        literal = next(b for section in sections for b in section["blocks"] if b.get("text_mode") == "literal")
        literal["text"] = "X" * 1000
        with self.assertRaisesRegex(ValueError, "exceeds printable width"):
            RENDER["render_pdf"]("Synthetic", sections, self.rules["formats"]["pdf"])
        literal.pop("text_mode")
        # Ordinary unbroken flow text wraps; it is not clipped or deleted.
        wrapped = RENDER["render_pdf"]("Synthetic", sections, self.rules["formats"]["pdf"])
        extracted = "".join(page.extract_text() for page in PdfReader(BytesIO(wrapped)).pages)
        self.assertIn("X" * 1000, "".join(extracted.split()))
        literal["text_mode"] = "literal"
        literal["text"] = "\n".join(f"  literal-{index:03d}  " for index in range(160))
        paginated = PdfReader(BytesIO(RENDER["render_pdf"]("Synthetic", sections, self.rules["formats"]["pdf"])))
        self.assertGreater(len(paginated.pages), 2)
        lines = [line for page in paginated.pages for line in page.extract_text().splitlines()
                 if "literal-" in line]
        self.assertEqual(lines, [f"  literal-{index:03d}  " for index in range(160)])

    def test_cli_original_payload_identity(self):
        with tempfile.TemporaryDirectory(prefix="synthetic-projection-") as directory:
            for fmt in ("docx", "pdf"):
                job = {"title": "UNFINISHED synthetic", "tree": self.projection["tree"],
                       "source": {"candidate_content_identity": identity(SOURCE)},
                       "descriptor": {"format_id": fmt, "destination_dir": directory, "file_stem": "proof"}}
                result = subprocess.run([sys.executable, str(ROOT / "do-work/render-structured-file-export.py"),
                                         "--job-json", json.dumps(job), "--rules-rows-json", json.dumps([self.rules]),
                                         "--content-identity"], capture_output=True, text=True)
                self.assertEqual(result.returncode, 0, result.stderr)
                receipt = json.loads(result.stdout)
                actual = Path(receipt["path"]).read_bytes()
                self.assertEqual(receipt["payload_hash"], identity(actual))
                if fmt == "pdf":
                    self.assertEqual(receipt["literal_layout_source_identity"], identity(SOURCE))
                    self.assertEqual(receipt["literal_layout"][0]["source_hard_line_count"], len(self.literal.split("\n")))

    def test_opt_in_softwrap_retains_original_hardline_provenance(self):
        value = "\n  Input → " + "alpha beta gamma → " * 40 + "\tomega  \n\n  End\n"
        fmt = copy.deepcopy(self.rules["formats"]["pdf"])
        fmt["literal_wrap"] = {"mode": "soft", "break_after": [" ", "→"],
                               "continuation_indent": 2, "fallback": "refuse"}
        from reportlab.pdfbase import pdfmetrics
        from reportlab.pdfbase.ttfonts import TTFont
        font = TTFont("SyntheticWrapMono", RENDER["resolve_pdf_font"]("Courier New.ttf"))
        pdfmetrics.registerFont(font)
        layout = RENDER["layout_literal_text"](value, 492,
                   lambda line: pdfmetrics.stringWidth(line, font.fontName, 9), 4, fmt["literal_wrap"])
        originals = value.split("\n")
        reconstructed = [""] * len(originals)
        for display, span in zip(layout["lines"], layout["mapping"]):
            i = span["source_line_index"]
            self.assertEqual(span["start_char"], len(reconstructed[i]))
            reconstructed[i] += originals[i][span["start_char"]:span["end_char"]]
            self.assertTrue(display.startswith(span["continuation_prefix"]))
            self.assertLessEqual(pdfmetrics.stringWidth(display, font.fontName, 9), 492)
        self.assertEqual("\n".join(reconstructed), value)
        self.assertGreater(len(layout["lines"]), len(originals))
        sections = copy.deepcopy(self.sections)
        literal = next(b for s in sections for b in s["blocks"] if b.get("text_mode") == "literal")
        literal["text"] = value
        receipt = []
        pdf_data = RENDER["render_pdf"]("Synthetic", sections, fmt, layout_receipt=receipt)
        self.assertEqual(receipt[0]["display_lines"], layout["mapping"])
        extracted = "\n".join(page.extract_text() for page in PdfReader(BytesIO(pdf_data)).pages).splitlines()
        for display in layout["lines"]:
            if display.strip():
                self.assertIn(display, extracted)
        with pdfium.PdfDocument(pdf_data) as pdf:
            for page in pdf:
                text_page = page.get_textpage()
                for i in range(text_page.count_chars()):
                    left, bottom, right, top = text_page.get_charbox(i)
                    self.assertGreaterEqual(left, 54)
                    self.assertLessEqual(right, 558)
                text_page.close()
                page.close()
        word = Document(BytesIO(RENDER["render_docx"]("Synthetic", sections, self.rules["formats"]["docx"])))
        self.assertIn(value, [p.text for p in word.paragraphs])
        with self.assertRaisesRegex(ValueError, "selected boundaries"):
            RENDER["layout_literal_text"]("X" * 1000, 492,
                lambda line: pdfmetrics.stringWidth(line, font.fontName, 9), 4, fmt["literal_wrap"])


if __name__ == "__main__":
    unittest.main()
