"""Synthetic DOCX readback regressions for source content before headings.

Moved from trillion-launch-video tools/private-book-reader/test_private_book_reader.py; the writing settings are the
settings object of a made-up book's row instead of a .writing-policy.json beside the fixture.
"""

import sys
import contextlib
import copy
import io
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

    def test_list_parents_keep_their_children_but_not_siblings(self):
        parsed, output = self.render(
            "# Fixture\n\n- Parent\n  - Child\n  - Child sibling\n"
            "- Blank parent\n\n  - Blank child\n\n"
            "- Prose parent\n\n  Child passage.\n\n"
            "- Sibling\n- Last sibling\n"
        )
        doc = Document(output)
        kept = {"Parent", "Blank parent", "Prose parent"}
        for text in kept | {"Child", "Child sibling", "Blank child", "Sibling", "Last sibling"}:
            paragraph = next(p for p in doc.paragraphs if p.text == text)
            self.assertEqual(bool(paragraph.paragraph_format.keep_with_next), text in kept)
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


class ParserFidelityTests(unittest.TestCase):
    def check(self, source, parsed=None):
        parsed = parsed or builder.parse_markdown(source)
        with contextlib.redirect_stdout(io.StringIO()):
            builder._check(parsed, source)
        return parsed

    def test_blank_list_containers_have_relative_fences_and_paragraphs(self):
        source = ("# Fixture\n\n- **Outer**\n\n  A **paragraph**.\n\n"
                  "  + **Middle**\n\n    ```text\n      **literal**\n"
                  "    - literal marker\n    ```\n\n    Middle continuation.\n\n"
                  "    7) **Inner**\n\n       Deep **paragraph**.\n\n"
                  "  - **Other**\n\nAfter.\n\n"
                  "    ```text\n    - **genuine code**\n    ```\n")
        # These blocks are an independently specified semantic oracle. In
        # particular, the final four-space fence is literal indented code.
        golden = builder.ParsedBook("Fixture", [
            builder.Block("list", items=[(0, "**Outer**", False)], list_markers=["-"]),
            builder.Block("paragraph", "A **paragraph**.", indent_level=1),
            builder.Block("list", items=[(1, "**Middle**", False)], list_markers=["+"]),
            builder.Block("code", "  **literal**\n- literal marker", indent_level=2),
            builder.Block("paragraph", "Middle continuation.", indent_level=2),
            builder.Block("list", items=[(2, "**Inner**", True)], list_markers=["7)"]),
            builder.Block("paragraph", "Deep **paragraph**.", indent_level=3),
            builder.Block("list", items=[(1, "**Other**", False)], list_markers=["-"]),
            builder.Block("paragraph", "After."),
            builder.Block("code", "```text\n- **genuine code**\n```"),
        ])
        self.assertEqual(builder.parse_markdown(source), golden)
        self.check(source, golden)
        for mutation in ("fence_leak", "paragraph_as_code", "container_indent", "list_depth"):
            broken = copy.deepcopy(golden)
            if mutation == "fence_leak":
                broken.blocks[3].text = "```text\n" + broken.blocks[3].text + "\n```"
            elif mutation == "paragraph_as_code":
                broken.blocks[6].kind = "code"
            elif mutation == "container_indent":
                broken.blocks[3].indent_level = 0
            else:
                broken.blocks[5].items[0] = (0, "**Inner**", True)
            with self.subTest(mutation=mutation), self.assertRaises(ValueError):
                self.check(source, broken)

    def test_list_relative_indented_code_preserves_literal_markdown(self):
        source = ("# Fixture\n\n- Parent\n\n      - **literal**\n"
                  "        child_name\n\n  Normal **continuation**.\n")
        golden = builder.ParsedBook("Fixture", [
            builder.Block("list", items=[(0, "Parent", False)], list_markers=["-"]),
            builder.Block("code", "- **literal**\n  child_name", indent_level=1),
            builder.Block("paragraph", "Normal **continuation**.", indent_level=1),
        ])
        self.assertEqual(builder.parse_markdown(source), golden)
        self.check(source, golden)

    def test_tab_crossing_container_boundary_keeps_literal_remainder(self):
        source = "# Fixture\n\n- Parent\n\n\t\t**literal**  \n\nOutside.\n\n  \t_raw_\n"
        golden = builder.ParsedBook("Fixture", [
            builder.Block("list", items=[(0, "Parent", False)], list_markers=["-"]),
            builder.Block("code", "  **literal**  ", indent_level=1),
            builder.Block("paragraph", "Outside."),
            builder.Block("code", "_raw_"),
        ])
        self.assertEqual(builder.parse_markdown(source), golden)
        self.check(source, golden)

    def test_fence_is_a_literal_block_and_does_not_consume_adjacent_prose(self):
        source = ("# Fixture\n\nBefore.\n```text\n  root_name\n    |-- **literal**\n"
                  "\t+-- `tick` _raw_\n\n# code heading\n- code item\n"
                  "| code | row |\n|---|---|\n```\nAfter.\n")
        parsed = self.check(source)
        self.assertEqual([b.kind for b in parsed.blocks], ["paragraph", "code", "paragraph"])
        self.assertEqual(parsed.blocks[1].text,
                         "  root_name\n    |-- **literal**\n\t+-- `tick` _raw_\n\n"
                         "# code heading\n- code item\n| code | row |\n|---|---|")
        self.assertEqual(parsed.blocks[-1].text, "After.")

    def test_matching_fence_character_length_and_indentation(self):
        source = "# Fixture\n\n  ~~~~diagram\n    left\n  ~~~\n  ```\n  right  \n  ~~~~~\n"
        parsed = self.check(source)
        self.assertEqual(parsed.blocks[0].text, "  left\n~~~\n```\nright  ")

    def test_unclosed_fence_keeps_literal_text_to_end(self):
        parsed = self.check("# Fixture\n\n```\n **raw**\n  end")
        self.assertEqual(parsed.blocks[0].text, " **raw**\n  end")

    def test_indented_code_retains_internal_indentation_and_blank_lines(self):
        parsed = self.check("# Fixture\n\n    alpha_name\n        beta\n      \n\t\tend\n      \nAfter.\n")
        self.assertEqual(parsed.blocks[0].text, "alpha_name\n    beta\n  \n\tend")
        self.assertEqual(parsed.blocks[1].text, "After.")

    def test_three_level_list_between_literal_blocks_retains_list_structure(self):
        parsed = self.check("# Fixture\n\n```\n  before\n```\n\n"
                            "- Outer\n  - Middle\n    - Inner\n\n~~~\n  after\n~~~\n")
        self.assertEqual([block.kind for block in parsed.blocks], ["code", "list", "code"])
        self.assertEqual(parsed.blocks[1].items,
                         [(0, "Outer", False), (1, "Middle", False), (2, "Inner", False)])
        self.assertEqual([parsed.blocks[0].text, parsed.blocks[2].text], ["  before", "  after"])

    def test_four_space_list_marker_at_block_boundary_is_literal_code(self):
        parsed = self.check("# Fixture\n\n    - **literal marker**\n        child_name\n\n"
                            "- Outer\n  - Middle\n    - Inner\n")
        self.assertEqual([block.kind for block in parsed.blocks], ["code", "list"])
        self.assertEqual(parsed.blocks[0].text, "- **literal marker**\n    child_name")
        self.assertEqual(parsed.blocks[1].items,
                         [(0, "Outer", False), (1, "Middle", False), (2, "Inner", False)])

    def test_original_list_markers_survive_and_are_independently_checked(self):
        source = "# Fixture\n\n3) Outer\n  + Middle\n    7. Inner\n"
        parsed = self.check(source)
        self.assertEqual(parsed.blocks[0].list_markers, ["3)", "+", "7."])
        self.assertEqual(parsed.blocks[0].items,
                         [(0, "Outer", True), (1, "Middle", False), (2, "Inner", True)])
        parsed.blocks[0].list_markers[2] = "1."
        with self.assertRaisesRegex(ValueError, "List markers"):
            self.check(source, parsed)

    def test_soft_line_wrap_does_not_break_inline_emphasis(self):
        parsed = self.check("# Fixture\n\nA **wrapped\nlabel** with field_name.\n")
        self.assertEqual(builder._plain_inline(parsed.blocks[0].text), "A wrapped label with field_name.")

    def test_literal_trailing_heading_hash_is_not_a_closing_marker(self):
        parsed = self.check("# Fixture\n\n## Use C#\n\n### Closing marker ###\n")
        self.assertEqual([h.text for h in parsed.headings], ["Use C#", "Closing marker"])

    def test_pipe_line_without_separator_is_ordinary_text(self):
        parsed = self.check("# Fixture\n\n| literal | line |\nNext line.\n")
        self.assertEqual(parsed.tables, [])

    def test_ragged_table_is_refused_without_merging_or_padding_cells(self):
        for row in ("| only one |", "| one | two | three |"):
            with self.subTest(row=row), self.assertRaisesRegex(ValueError, "Table row"):
                builder.parse_markdown("# Fixture\n\n| A | B |\n|---|---|\n" + row + "\n")
        with self.assertRaisesRegex(ValueError, "Table separator"):
            builder.parse_markdown("# Fixture\n\n| A | B |\n|---|\n")

    def test_source_check_independently_rejects_code_loss_and_indent_change(self):
        source = "# Fixture\n\n```text\n  **raw**\n    child_name\n```\n"
        original = self.check(source)
        for change in ("drop", "indent", "markup", "kind"):
            parsed = copy.deepcopy(original)
            if change == "drop":
                parsed.blocks.clear()
            elif change == "indent":
                parsed.blocks[0].text = parsed.blocks[0].text.replace("    child", "  child")
            elif change == "markup":
                parsed.blocks[0].text = parsed.blocks[0].text.replace("**", "")
            else:
                parsed.blocks[0].kind = "paragraph"
            with self.subTest(change=change), self.assertRaisesRegex(ValueError, "Literal code"):
                self.check(source, parsed)

    def test_source_check_rejects_table_boundary_and_prose_loss(self):
        source = "# Fixture\n\nExact prose.\n\n| A | B |\n|---|---|\n| one | two |\n"
        original = self.check(source)
        merged = copy.deepcopy(original)
        merged.tables[0].rows[1] = ["one two", ""]
        with self.assertRaisesRegex(ValueError, "cell boundaries"):
            self.check(source, merged)
        changed = copy.deepcopy(original)
        changed.blocks[0].text = "Exactprose."
        with self.assertRaisesRegex(ValueError, "visible text"):
            self.check(source, changed)


class LiteralCodeReadbackTests(BodyReadbackTests):
    def test_three_level_list_keeps_native_depth_between_literal_blocks(self):
        parsed, output = self.render("# Fixture\n\n```\n  before\n```\n\n"
                                     "- Outer\n  - Middle\n    - Inner\n\n~~~\n  after\n~~~\n")
        doc = Document(output)
        items = [p for p in doc.paragraphs if p.text in ("Outer", "Middle", "Inner")]
        self.assertEqual([p.text for p in items], ["Outer", "Middle", "Inner"])
        self.assertEqual([p._p.xpath("./w:pPr/w:numPr/w:ilvl/@w:val")[0] for p in items],
                         ["0", "1", "2"])
        self.assertEqual([p.text for p in doc.paragraphs if p.text in ("  before", "  after")],
                         ["  before", "  after"])
        builder.verify_output(parsed, output)

    def test_saved_docx_retains_exact_literal_text(self):
        source = ("# Fixture\n\n```text\n  **raw** _name_ `tick`\n\t+-- child\n\n  end  \n```\n\n"
                  "~~~\n  **raw** _name_ `tick`\n\t+-- child\n\n  end  \n~~~\n")
        parsed, output = self.render(source)
        paragraphs = [p for p in Document(output).paragraphs if "**raw**" in p.text]
        self.assertEqual(len(paragraphs), 2)
        self.assertEqual([p.text for p in paragraphs], [b.text for b in parsed.blocks])
        self.assertTrue(all(r.font.name == "Menlo" for p in paragraphs for r in p.runs))
        builder.verify_output(parsed, output)

    def test_code_whitespace_loss_is_rejected_after_save(self):
        for mutation in ("indent", "newline", "tab", "trailing"):
            parsed, output = self.render("# Fixture\n\n```\n  root\n\tchild  \n```\n", mutation + ".docx")
            doc = Document(output)
            paragraph = next(p for p in doc.paragraphs if p.text.startswith("  root"))
            replacements = {"indent": ("  root", "root"), "newline": ("\n", " "),
                            "tab": ("\t", " "), "trailing": ("child  ", "child")}
            paragraph.text = paragraph.text.replace(*replacements[mutation])
            doc.save(output)
            with self.subTest(mutation=mutation), self.assertRaisesRegex(ValueError, "literal code"):
                builder.verify_output(parsed, output)


if __name__ == "__main__":
    unittest.main()
