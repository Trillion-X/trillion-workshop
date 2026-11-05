"""Synthetic DOCX readback regressions for source content before headings.

Moved from source-repo-a tools/private-book-reader/test_private_book_reader.py; the writing settings are the
settings object of a made-up book's row instead of a .writing-policy.json beside the fixture.
"""

import sys
import tempfile
import unittest
from pathlib import Path

from docx import Document
from docx.oxml.ns import qn

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "do-work"))
import export_markdown_book_to_word as builder  # noqa: E402
from writing_gate import _hash as source_hash  # noqa: E402


class BodyReadbackTests(unittest.TestCase):
    def setUp(self):
        self.tempdir = tempfile.TemporaryDirectory()
        self.root = Path(self.tempdir.name)
        self.template = self.root / "template.docx"
        Document().save(self.template)

    def tearDown(self):
        self.tempdir.cleanup()

    def render(self, source: str, name: str = "book.docx") -> tuple:
        source_path = self.root / "fixture.md"
        source_bytes = source.encode("utf-8")
        source_path.write_bytes(source_bytes)
        settings = {"role": "comparison", "source_blake3": source_hash(source_path)}
        parsed = builder.parse_markdown(source)
        output = self.root / name
        builder.render_document(parsed, self.template, output,
                                source_path=source_path, source_bytes=source_bytes, settings=settings)
        return parsed, output

    def remove_body_bookmark(self, output: Path) -> None:
        doc = Document(output)
        starts = [
            el for el in doc.element.iter(qn("w:bookmarkStart"))
            if el.get(qn("w:name")) == "BookBody"
        ]
        self.assertEqual(len(starts), 1)
        bookmark_id = starts[0].get(qn("w:id"))
        starts[0].getparent().remove(starts[0])
        for end in list(doc.element.iter(qn("w:bookmarkEnd"))):
            if end.get(qn("w:id")) == bookmark_id:
                end.getparent().remove(end)
        doc.save(output)

    def test_intro_before_first_heading_is_read_back(self):
        parsed, output = self.render(
            "# Fixture\n\nIntro paragraph before any heading.\n\n"
            "## First section\n\nBody paragraph follows.\n"
        )
        builder.verify_output(parsed, output)

    def test_body_without_headings_is_read_back(self):
        parsed, output = self.render(
            "# Fixture\n\nFirst paragraph without a heading.\n\n"
            "Second paragraph remains in the body.\n"
        )
        self.assertEqual(parsed.headings, [])
        builder.verify_output(parsed, output)

    def test_standalone_emphasis_labels_stay_with_their_passage(self):
        parsed, output = self.render(
            "# Fixture\n\n**Current passage**\n\nText that follows.\n\n"
            "__Previous passage__\n\nAnother passage.\n\n"
            "An **inline reference** stays in prose.\n"
        )
        doc = Document(output)
        labels = [p for p in doc.paragraphs if p.text in ("Current passage", "Previous passage")]
        self.assertEqual(len(labels), 2)
        self.assertTrue(all(p.paragraph_format.keep_with_next for p in labels))
        inline = next(p for p in doc.paragraphs if p.text == "An inline reference stays in prose.")
        self.assertIsNone(inline.paragraph_format.keep_with_next)
        builder.verify_output(parsed, output)

    def test_legacy_without_body_bookmark_reads_intro_after_contents_break(self):
        parsed, output = self.render(
            "# Fixture\n\nIntro before the first heading.\n\n"
            "## First section\n\nBody paragraph.\n",
            "legacy.docx",
        )
        self.remove_body_bookmark(output)
        builder.verify_output(parsed, output)

    def test_deleted_intro_is_rejected(self):
        parsed, output = self.render(
            "# Fixture\n\nUnique intro that must survive.\n\n"
            "## First section\n\nBody paragraph.\n",
            "deleted.docx",
        )
        self.remove_body_bookmark(output)
        doc = Document(output)
        intro = next(p for p in doc.paragraphs if p.text == "Unique intro that must survive.")
        intro._p.getparent().remove(intro._p)
        doc.save(output)
        with self.assertRaisesRegex(ValueError, "Saved DOCX body differs"):
            builder.verify_output(parsed, output)

    def test_altered_intro_is_rejected(self):
        parsed, output = self.render(
            "# Fixture\n\nUnique intro that must survive.\n\n"
            "## First section\n\nBody paragraph.\n",
            "altered.docx",
        )
        self.remove_body_bookmark(output)
        doc = Document(output)
        intro = next(p for p in doc.paragraphs if p.text == "Unique intro that must survive.")
        intro.text = "Unique intro that was changed."
        doc.save(output)
        with self.assertRaisesRegex(ValueError, "Saved DOCX body differs"):
            builder.verify_output(parsed, output)


class MathSignRenderingTests(unittest.TestCase):
    def test_separate_numbered_lists_explicitly_restart(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            template, output = root / "template.docx", root / "lists.docx"
            Document().save(template)
            source_path = root / "fixture.md"
            source_bytes = b"# Lists\n\n1. Alpha\n2. Beta\n\nBetween.\n\n1. Gamma\n2. Delta\n"
            source_path.write_bytes(source_bytes)
            settings = {"role": "comparison", "source_blake3": source_hash(source_path)}
            parsed = builder.parse_markdown(source_bytes.decode("utf-8"))
            builder.render_document(parsed, template, output,
                                    source_path=source_path, source_bytes=source_bytes, settings=settings)
            doc = Document(output)
            ids = []
            for text in ("Alpha", "Gamma"):
                paragraph = next(p for p in doc.paragraphs if p.text == text)
                ids.append(paragraph._p.find(qn("w:pPr")).find(qn("w:numPr")).find(qn("w:numId")).get(qn("w:val")))
            self.assertNotEqual(ids[0], ids[1])
            instances = doc.part.numbering_part.element.findall(qn("w:num"))
            for identifier in ids:
                num = next(n for n in instances if n.get(qn("w:numId")) == identifier)
                overrides = num.findall(qn("w:lvlOverride"))
                self.assertEqual(len(overrides), 9)
                self.assertTrue(all(o.find(qn("w:startOverride")).get(qn("w:val")) == "1" for o in overrides))
            builder.verify_output(parsed, output)

    def test_plus_uses_math_shape_font_without_changing_text_or_emphasis(self):
        doc = Document()
        paragraph = doc.add_paragraph()
        builder._inline(paragraph, "**Goals + Values** and x + y.")
        self.assertEqual(paragraph.text, "Goals + Values and x + y.")
        signs = [run for run in paragraph.runs if run.text == "+"]
        self.assertEqual(len(signs), 2)
        self.assertEqual([run.font.name for run in signs], ["Arial", "Arial"])
        self.assertTrue(signs[0].bold)
        self.assertIsNone(signs[1].bold)
        self.assertTrue(all(run.font.name is None for run in paragraph.runs if run.text != "+"))


class InlineLiteralTests(BodyReadbackTests):
    def test_plain_projection_preserves_literal_delimiters(self):
        examples = {
            "Welcome, {data.full_name}!": "Welcome, {data.full_name}!",
            "Use first_name and last_name.": "Use first_name and last_name.",
            "Use `field_name` and `_raw_*`.": "Use field_name and _raw_*.",
            r"Keep \_literal\_ and \*stars\*; **bold** and _emphasis_.":
                "Keep _literal_ and *stars*; bold and emphasis.",
            "Multiply a*b, then **compare**.": "Multiply a*b, then compare.",
            "**Bold with *nested emphasis* and `field_name`**":
                "Bold with nested emphasis and field_name",
        }
        for source, expected in examples.items():
            with self.subTest(source=source):
                self.assertEqual(builder._plain_inline(source), expected)

    def test_saved_docx_preserves_identifier_text_and_table_cells(self):
        parsed, output = self.render(
            "# Identifier fixture\n\n## Literal field_names\n\n"
            "Welcome, {data.full_name}! Use first_name and last_name.\n\n"
            "Use **bold** and `field_name` with `_raw_*`.\n\n"
            "| Field | Value |\n|---|---|\n| first_name | last_name |\n"
        )
        doc = Document(output)
        self.assertIn("Welcome, {data.full_name}! Use first_name and last_name.",
                      [p.text for p in doc.paragraphs])
        self.assertIn("Use bold and field_name with _raw_*.",
                      [p.text for p in doc.paragraphs])
        self.assertEqual([[cell.text for cell in row.cells] for row in doc.tables[0].rows],
                         [["Field", "Value"], ["first_name", "last_name"]])
        builder.verify_output(parsed, output)

    def test_deleted_literal_underscore_is_rejected(self):
        parsed, output = self.render(
            "# Identifier fixture\n\nThe field_name must survive.\n"
        )
        doc = Document(output)
        paragraph = next(p for p in doc.paragraphs if p.text == "The field_name must survive.")
        paragraph.text = "The fieldname must survive."
        doc.save(output)
        with self.assertRaisesRegex(ValueError, "Saved DOCX body differs"):
            builder.verify_output(parsed, output)


if __name__ == "__main__":
    unittest.main()
