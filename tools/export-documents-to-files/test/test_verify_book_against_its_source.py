"""Content-loss probes for the scoped PDF comparison (no private corpus).

Moved from source-repo-a tools/private-book-reader/test_pdf_source.py.
"""
import sys
import unittest
import tempfile
from pathlib import Path

from docx import Document
from pypdf import PdfReader, PdfWriter
from pypdf.generic import DecodedStreamObject, DictionaryObject, NameObject
from io import BytesIO
from types import SimpleNamespace
import json
import subprocess
import shutil

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "do-work"))
import verify_book_against_its_source as verifier  # noqa: E402


class ContentLossTests(unittest.TestCase):
    def setUp(self):
        self.builder = verifier._load_builder()
        self.source = self.builder.parse_markdown(
            "# Fixture\n\n## Start\n\nAlpha word → beta.\n\n"
            "| Name | Value |\n|---|---|\n| Some name | Two words |\n\n"
            "After table.\n\n## End\n\nGamma ← delta.\n")
        self.valid = ("Start Alpha word beta. → Name Value Some name Two words "
                      "After table. End Gamma delta. ←")

    def compare(self, text):
        return verifier._compare_pdf_body(self.source, self.builder, text)

    def test_layout_displaced_arrow_preserves_content(self):
        self.assertTrue(self.compare(self.valid)["passed"])

    def test_merged_or_split_prose_words(self):
        for before, after in [("Alpha word", "Alphaword"), ("Alpha", "Al pha")]:
            with self.subTest(after=after):
                result = self.compare(self.valid.replace(before, after))
                self.assertTrue(result["prose_ordered_match"])
                self.assertFalse(result["prose_word_boundaries_match"])
                self.assertFalse(result["passed"])


    def test_arrow_swap_across_blocks(self):
        swapped = self.valid.replace("→", "TEMP").replace("←", "→").replace("TEMP", "←")
        result = self.compare(swapped)
        self.assertTrue(result["arrows_match"])
        self.assertFalse(result["local_arrow_regions_match"])
        self.assertFalse(result["passed"])

    def test_merged_or_split_table_words(self):
        for before, after in [("Two words", "Twowords"), ("Some name", "So me name")]:
            with self.subTest(after=after):
                result = self.compare(self.valid.replace(before, after))
                self.assertTrue(result["tables"][0]["character_multiset_match"])
                self.assertFalse(result["tables"][0]["word_boundary_inventory_match"])
                self.assertFalse(result["passed"])

    def test_literal_code_is_compared_without_inline_markup_projection(self):
        source = self.builder.parse_markdown(
            "# Fixture\n\nBefore.\n\n```diagram\n  **raw_name**\n    child → leaf\n```\n\nAfter.\n")
        literal = "Before.\n  **raw_name**\n    child → leaf\nAfter."
        self.assertTrue(verifier._compare_pdf_body(source, self.builder, literal)["passed"])
        for bad in (literal.replace("**", ""), literal.replace("child", ""),
                    literal.replace("→", ""), literal.replace("raw_name", "rawname")):
            with self.subTest(bad=bad):
                self.assertFalse(verifier._compare_pdf_body(source, self.builder, bad)["passed"])

    def test_old_code_omission_cannot_pass_pdf_consumer(self):
        source = self.builder.parse_markdown("# Fixture\n\nBefore.\n\n```\nkeep_me\n```\n\nAfter.\n")
        result = verifier._compare_pdf_body(source, self.builder, "Before. After.")
        self.assertFalse(result["passed"])
        self.assertFalse(result["prose_ordered_match"])


class PrebodyPageTests(unittest.TestCase):
    @staticmethod
    def reader(*texts):
        return SimpleNamespace(pages=[SimpleNamespace(extract_text=lambda text=t: text) for t in texts])

    def test_footer_only_spill_page_is_rejected(self):
        result = verifier._prebody_blank_pages(self.reader("Contents 1 2", "Page 29\n", "Body"), 3)
        self.assertFalse(result["passed"])
        self.assertEqual(result["footer_only_or_empty_pages"], [2])

    def test_legitimate_contents_text_and_footer_are_retained(self):
        result = verifier._prebody_blank_pages(self.reader("Contents\nPage 29\nA section 30", "Body"), 2)
        self.assertTrue(result["passed"])

    def test_empty_prebody_page_rejected_with_body_outside_scope(self):
        result = verifier._prebody_blank_pages(self.reader("Contents", " \n", "Body", "Page 4"), 3)
        self.assertEqual(result["footer_only_or_empty_pages"], [2])


class CMapRepairTests(unittest.TestCase):
    def test_source_confirmed_flo_mapping_keeps_other_glyphs(self):
        raw = b"<62> <0066006C006F>\n<63> <006F>\n"
        repaired, changes = verifier._repair_cmap_data(raw, "/FixtureFont")
        self.assertEqual(repaired, b"<62> <0066006C>\n<63> <006F>\n")
        self.assertEqual([(x["from"], x["to"]) for x in changes], [("flo", "fl")])

    def test_source_confirmed_ffli_mapping_removes_extra_i(self):
        raw = (b"<59> <00660066006C0069>\n"  # ffli -> ffl
               b"<5A> <00660069>\n")          # valid fi stays unchanged
        repaired, changes = verifier._repair_cmap_data(raw, "/FixtureFont")
        self.assertIn(b"<59> <00660066006C>", repaired)
        self.assertIn(b"<5A> <00660069>", repaired)
        self.assertEqual(changes, [{
            "font": "/FixtureFont",
            "glyph_code": "59",
            "from": "ffli",
            "to": "ffl",
        }])


class NumericActualTextTests(unittest.TestCase):
    def fixture(self, actual="13", glyphs="113", marked=True):
        writer = PdfWriter()
        page = writer.add_blank_page(width=200, height=200)
        font = DictionaryObject({
            NameObject("/Type"): NameObject("/Font"),
            NameObject("/Subtype"): NameObject("/Type1"),
            NameObject("/BaseFont"): NameObject("/Helvetica"),
            NameObject("/Encoding"): NameObject("/WinAnsiEncoding"),
        })
        page[NameObject("/Resources")] = DictionaryObject({
            NameObject("/Font"): DictionaryObject({NameObject("/F1"): font})
        })
        start = f"/Span << /ActualText ({actual}) >> BDC " if marked else ""
        end = " EMC" if marked else ""
        data = f"BT /F1 12 Tf 10 100 Td (Count ) Tj {start}({glyphs}) Tj{end} ( items.) Tj ET"
        stream = DecodedStreamObject()
        stream.set_data(data.encode("ascii"))
        page[NameObject("/Contents")] = stream
        buffer = BytesIO()
        writer.write(buffer)
        return PdfReader(BytesIO(buffer.getvalue()))

    def test_numeric_actualtext_comes_from_pdf_and_preserves_saved_stream(self):
        reader = self.fixture()
        page = reader.pages[0]
        original = page.get_contents().get_data()
        self.assertIn("113", page.extract_text())
        self.assertEqual(verifier._pdf_text(reader, 1), "Count 13 items.")
        self.assertEqual(page.get_contents().get_data(), original)
        self.assertIn("113", page.extract_text())

    def test_wrong_actualtext_still_fails_source_comparison(self):
        reader = self.fixture(actual="19")
        builder = verifier._load_builder()
        source = builder.parse_markdown("# Fixture\n\nCount 13 items.\n")
        result = verifier._compare_pdf_body(source, builder, verifier._pdf_text(reader, 1))
        self.assertFalse(result["passed"])

    def test_unmarked_digits_and_nonnumeric_spans_are_not_rewritten(self):
        self.assertEqual(verifier._pdf_text(self.fixture(marked=False), 1), "Count 113 items.")
        self.assertEqual(verifier._pdf_text(self.fixture(actual="thirteen"), 1), "Count 113 items.")


class OutlineHierarchyTests(unittest.TestCase):
    def setUp(self):
        self.builder = verifier._load_builder()
        self.parsed = self.builder.parse_markdown(
            "# Fixture\n\n## Parent\n\nText.\n\n#### Deep\n\nText.\n\n## Next\n\nText.\n"
        )

    def node(self, title, page):
        return {"/Title": title, "/Page": page}

    def reader(self, outline):
        return SimpleNamespace(outline=outline, get_page_number=lambda page: page - 1)

    def test_level_gap_uses_existing_parent(self):
        outline = [self.node("Contents", 1), self.node("Parent", 2),
                   [self.node("Deep", 3)], self.node("Next", 4)]
        mapping, _ = verifier._outline_page_map(self.reader(outline), self.parsed, self.builder)
        self.assertEqual(mapping, {"BookHeading1": 2, "BookHeading2": 3, "BookHeading3": 4})

    def test_same_titles_with_wrong_parent_are_rejected(self):
        for outline in [
            [self.node("Contents", 1), self.node("Parent", 2), self.node("Deep", 3), self.node("Next", 4)],
            [self.node("Contents", 1), self.node("Parent", 2), [[self.node("Deep", 3)]], self.node("Next", 4)],
        ]:
            with self.subTest(outline=outline), self.assertRaises(ValueError):
                verifier._outline_page_map(self.reader(outline), self.parsed, self.builder)


class ScopedCMapTests(unittest.TestCase):
    def test_missing_glyph_addition_preserves_real_letter(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            raw, fixed, declaration = root / "raw.pdf", root / "fixed.pdf", root / "repair.json"
            writer = PdfWriter()
            page = writer.add_blank_page(width=200, height=200)
            cmap = DecodedStreamObject()
            cmap.set_data(b"1 beginbfchar\n<2A> <0043>\nendbfchar\nendcmap\n")
            font = DictionaryObject({NameObject("/Type"): NameObject("/Font"),
                                     NameObject("/Subtype"): NameObject("/Type1"),
                                     NameObject("/BaseFont"): NameObject("/Fixture"),
                                     NameObject("/ToUnicode"): cmap})
            page[NameObject("/Resources")] = DictionaryObject({NameObject("/Font"): DictionaryObject({NameObject("/F1"): font})})
            writer.write(str(raw))
            from writing_gate import _hash
            digest = _hash(raw)
            data = {"raw_pdf_blake3": digest, "repairs": [{"font": "/Fixture", "glyph_code": "43", "from": None, "to": "ft"}]}
            declaration.write_text(json.dumps(data))
            scoped = verifier._load_scoped_cmap_repairs(declaration, raw)
            verifier._repair_cmaps(raw, fixed, scoped)
            entries = verifier._cmap_entries(fixed)
            self.assertEqual(entries[("/Fixture", "43")], "ft")
            self.assertEqual(entries[("/Fixture", "2A")], "C")
            self.assertTrue(verifier._audit_cmap_delta(raw, fixed, scoped)["passed"])
            data["repairs"][0]["glyph_code"] = "2A"
            declaration.write_text(json.dumps(data))
            with self.assertRaisesRegex(ValueError, "mismatched glyph"):
                verifier._load_scoped_cmap_repairs(declaration, raw)

    def test_bound_glyph_repair_and_wrong_file_or_mapping_refusal(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            raw, fixed, declaration = root / "raw.pdf", root / "fixed.pdf", root / "repair.json"
            writer = PdfWriter()
            page = writer.add_blank_page(width=200, height=200)
            cmap = DecodedStreamObject()
            cmap.set_data(b"1 beginbfchar\n<2A> <0043>\nendbfchar\n")
            font = DictionaryObject({NameObject("/Type"): NameObject("/Font"),
                                     NameObject("/Subtype"): NameObject("/Type1"),
                                     NameObject("/BaseFont"): NameObject("/Fixture"),
                                     NameObject("/ToUnicode"): cmap})
            page[NameObject("/Resources")] = DictionaryObject({NameObject("/Font"): DictionaryObject({NameObject("/F1"): font})})
            writer.write(str(raw))
            from writing_gate import _hash
            digest = _hash(raw)
            data = {"raw_pdf_blake3": digest, "repairs": [{"font": "/Fixture", "glyph_code": "2A", "from": "C", "to": "ft"}]}
            declaration.write_text(json.dumps(data))
            scoped = verifier._load_scoped_cmap_repairs(declaration, raw)
            verifier._repair_cmaps(raw, fixed, scoped)
            self.assertEqual(verifier._cmap_entries(fixed)[("/Fixture", "2A")], "ft")
            self.assertFalse(verifier._audit_cmap_delta(raw, fixed)["passed"])
            self.assertTrue(verifier._audit_cmap_delta(raw, fixed, scoped)["passed"])
            data["raw_pdf_blake3"] = "0" * 64
            declaration.write_text(json.dumps(data))
            with self.assertRaisesRegex(ValueError, "different raw PDF"):
                verifier._load_scoped_cmap_repairs(declaration, raw)
            data["raw_pdf_blake3"] = digest
            data["repairs"][0]["from"] = "X"
            declaration.write_text(json.dumps(data))
            with self.assertRaisesRegex(ValueError, "mismatched glyph"):
                verifier._load_scoped_cmap_repairs(declaration, raw)


class CachedPageFieldTests(unittest.TestCase):
    def test_native_docx_consumer_reads_literal_code_and_rejects_indent_loss(self):
        builder = verifier._load_builder()
        source_bytes = b"# Fixture\n\nBefore.\n\n```\n  **raw_name**\n\tchild\n```\n\nAfter.\n"
        parsed = builder.parse_markdown(source_bytes.decode())
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            template, output, source = root / "template.docx", root / "book.docx", root / "fixture.md"
            Document().save(template)
            source.write_bytes(source_bytes)
            from writing_gate import _hash
            builder.render_document(parsed, template, output, source_path=source, source_bytes=source_bytes,
                                    settings={"role": "comparison", "source_blake3": _hash(source)})
            result = verifier._check_docx(output, parsed, builder)
            self.assertEqual(result["literal_code_blocks"], 1)
            self.assertTrue(result["literal_code_text_and_indentation_match"])
            doc = Document(output)
            code = next(p for p in doc.paragraphs if p.text.startswith("  **raw_name**"))
            code.text = code.text.lstrip()
            doc.save(output)
            with self.assertRaisesRegex(ValueError, "literal code"):
                verifier._check_docx(output, parsed, builder)

    def test_numeric_heading_label_does_not_change_cached_page(self):
        builder = verifier._load_builder()
        parsed = builder.parse_markdown(
            "# Fixture\n\nIntro before a heading.\n\n## R09-03\n\nBody.\n"
        )
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            template = root / "template.docx"
            output = root / "book.docx"
            Document().save(template)
            # The renderer needs the source snapshot it parsed (stale in the launch-video copy, which errored here).
            source = root / "fixture.md"
            source_bytes = b"# Fixture\n\nIntro before a heading.\n\n## R09-03\n\nBody.\n"
            source.write_bytes(source_bytes)
            from writing_gate import _hash
            builder.render_document(parsed, template, output, {"BookHeading1": 3}, source_path=source,
                                    source_bytes=source_bytes,
                                    settings={"role": "comparison", "source_blake3": _hash(source)})
            result = verifier._check_docx(output, parsed, builder, {"BookHeading1": 3})
        self.assertEqual(result["contents_page_fields"], 1)
        self.assertEqual(result["cached_page_mismatches"], [])


if __name__ == "__main__":
    unittest.main()
