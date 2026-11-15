import unittest
from io import BytesIO
import json
import os
from pathlib import Path
import sys
import tempfile
from types import ModuleType
from types import SimpleNamespace
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "do-work"))
from inspect_private_document_pdf import geometry_readback, inspect_pdf, text_mapping
import writing_gate
from writing_gate import _PrivateInput


def projection(blocks):
    return {"ordered_blocks": blocks,
            "ordered_bindings": [{"request_block_index": i} for i in range(len(blocks))]}


class TextMappingTests(unittest.TestCase):
    def test_real_pdfium_geometry_keeps_correct_tokens_and_does_not_fill_missing_words(self):
        import pypdfium2 as pdfium
        import pypdfium2.raw as raw
        from reportlab.pdfgen.canvas import Canvas
        data = BytesIO()
        canvas = Canvas(data)
        canvas.setFont("Helvetica", 12)
        canvas.drawString(72, 700, "Alpha")
        canvas.drawString(150, 700, "Beta")
        canvas.setFont("Courier", 12)
        canvas.drawString(120, 700, "X")
        canvas.save()
        with pdfium.PdfDocument(data.getvalue()) as document:
            page = document[0]
            textpage = page.get_textpage()
            actual, _, _ = geometry_readback(
                textpage, textpage.get_text_range(), textpage.get_text_bounded(),
                lambda at: raw.FPDFText_GetCharIndexFromTextIndex(textpage, at))
            self.assertEqual(actual, "Alpha X Beta")
            self.assertFalse(text_mapping(projection([
                {"kind": "paragraph", "text": "Alpha X Beta 20"}
            ]), ["Proof\n" + actual], "Proof")["exact_ordered_text_after_whitespace_normalization"])
            textpage.close()
            page.close()

    def test_geometry_orders_only_actual_same_line_tokens_without_source_text(self):
        text = "Alpha Beta X\nCell one\nCell two\n"
        boxes = {}
        starts = {"Alpha": (0, 700), "Beta": (80, 700), "X": (55, 700),
                  "Cell one": (0, 680), "Cell two": (100, 680)}
        position = 0
        for line in text.splitlines(keepends=True):
            value = line.rstrip("\n")
            if value.startswith("Alpha"):
                for word, (x, y) in list(starts.items())[:3]:
                    offset = value.index(word)
                    for i, _ in enumerate(word):
                        boxes[position + offset + i] = (x + i * 5, y, x + i * 5 + 4, y + 8)
            else:
                x, y = starts[value]
                for i, _ in enumerate(value):
                    boxes[position + i] = (x + i * 5, y, x + i * 5 + 4, y + 8)
            position += len(line)
        page = SimpleNamespace(get_charbox=lambda at: boxes[at])
        actual, changes, _ = geometry_readback(page, text, text, lambda at: at)
        self.assertEqual(actual, "Alpha X Beta\nCell one\nCell two\n")
        self.assertEqual(len(changes), 1)
        self.assertEqual(changes[0]["token_order"], [0, 2, 1])
        source = projection([{"kind": "heading", "text": "Alpha X Beta"},
                             {"kind": "paragraph", "text": "Cell one Cell two"}])
        self.assertTrue(text_mapping(source, ["Proof\n" + actual], "Proof")
                        ["exact_ordered_text_after_whitespace_normalization"])
        missing = projection([{"kind": "heading", "text": "Alpha X Beta 20"}])
        self.assertFalse(text_mapping(missing, ["Proof\n" + actual], "Proof")
                         ["exact_ordered_text_after_whitespace_normalization"])

    def test_geometry_abstains_on_overlap_rtl_and_unaligned_apis(self):
        page = SimpleNamespace(get_charbox=lambda at: (0, 0, 20, 8))
        for text, bounded in [("Beta Alpha", "Beta Alpha"), ("אב Alpha", "אב Alpha"),
                              ("Alpha", "Different")]:
            with self.subTest(text=text):
                actual, changes, unavailable = geometry_readback(page, text, bounded, lambda at: at)
                self.assertEqual(actual, bounded)
                self.assertEqual(changes, [])
                self.assertTrue(unavailable)

    def test_displaced_heading_cannot_match_inside_prose_and_jump_to_repeated_appendix(self):
        source = projection([
            {"kind": "heading", "text": "Action → Skill"},
            {"kind": "paragraph", "text": "Choose a repeatable action."},
            {"kind": "paragraph", "text": "In Action → Skill, observe a result."},
            {"kind": "heading", "text": "Appendix"},
            {"kind": "paragraph", "text": "Choose a repeatable action."},
        ])
        result = text_mapping(source, [
            "Proof\nAction Skill →\nChoose a repeatable action.\nIn Action → Skill, observe a result.",
            "Appendix\nChoose a repeatable action.",
        ], "Proof")
        self.assertFalse(result["exact_ordered_text_after_whitespace_normalization"])
        self.assertFalse(result["blocks"][0]["mapped"])
        self.assertEqual(result["blocks"][1]["first_page"], 1)
        self.assertEqual(result["blocks"][2]["first_page"], 1)
        self.assertEqual(result["blocks"][4]["first_page"], 2)

    def test_complete_wrapped_heading_lines_are_still_mapped(self):
        source = projection([
            {"kind": "heading", "text": "A complete wrapped heading"},
            {"kind": "paragraph", "text": "Its following paragraph."},
        ])
        result = text_mapping(source, [
            "Proof\nA complete wrapped\nheading\nIts following paragraph."
        ], "Proof")
        self.assertTrue(result["exact_ordered_text_after_whitespace_normalization"])
        self.assertTrue(result["blocks"][0]["mapped"])

    def test_whole_text_and_cross_page_source_mapping(self):
        source = projection([{"kind": "paragraph", "text": "Pay at least 10000 and keep three evenings."}])
        result = text_mapping(source, ["Proof\nPay at least 10000", "and keep three evenings."], "Proof")
        self.assertTrue(result["exact_ordered_text_after_whitespace_normalization"])
        self.assertEqual((result["blocks"][0]["first_page"], result["blocks"][0]["last_page"]), (1, 2))

    def test_missing_words_changed_quantity_and_reordered_claim_fail(self):
        source = projection([{"kind": "paragraph", "text": "Keep 65 to 80 percent."}])
        for text in ("Proof Keep 65 percent.", "Proof Keep 30 to 80 percent.", "Proof Keep 80 to 65 percent."):
            with self.subTest(text=text):
                self.assertFalse(text_mapping(source, [text], "Proof")["exact_ordered_text_after_whitespace_normalization"])

    def test_private_snapshot_uses_the_exact_admitted_root_and_current_identity(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary).resolve()
            os.chmod(root, 0o700)
            other_root = root / "other-root"
            other_root.mkdir(mode=0o700)
            source = root / "sample.pdf"
            source.write_bytes(b"synthetic PDF bytes")
            source.chmod(0o600)
            with _PrivateInput(source, root) as held:
                self.assertEqual(held.content, b"synthetic PDF bytes")
                self.assertRegex(held.identity, r"^[0-9a-f]{64}$")
                held.validate()
            with self.assertRaises(ValueError):
                _PrivateInput(source, other_root)

    def test_inspection_uses_admitted_input_root_and_reports_current_b3_identity(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary).resolve()
            os.chmod(root, 0o700)
            source = root / "synthetic.md"
            policy_path = root / "policy.json"
            job_path = root / "job.json"
            projection_path = root / "projection.json"
            gate_path = root / "gate.json"
            rules_path = root / "rules.json"
            rules = json.loads((Path(__file__).resolve().parents[1] / "read-data" / "starter-projection-rules.json").read_text())
            self._write_private(rules_path, json.dumps(rules).encode())
            self._write_private(source, b"# Synthetic\n\nHello world.\n")
            source_hash = writing_gate._hash(source)
            tree = {"props": {"text": "Synthetic"}, "children": [
                {"props": {"text": "Hello world."}, "children": []}]}
            projection = {"schema": "documents-structured-file-projection-v1", "source_identity": "1f:" + source_hash,
                "tree": tree, "ordered_blocks": [{"kind": "paragraph", "text": "Hello world."}],
                "ordered_bindings": [{"request_block_index": 0}]}
            self._write_private(projection_path, json.dumps(projection).encode())
            self._write_private(gate_path, json.dumps({"gate_id": "synthetic-gate", "passed": True}).encode())
            job = {"source": {"candidate_path": str(source), "candidate_content_identity": "1f:" + source_hash},
                "tree": tree, "descriptor": {"format_id": "pdf", "destination_dir": "/unused", "file_stem": "unused"}}
            self._write_private(job_path, json.dumps(job).encode())
            selected = {"file_stem": "unfinished-proof", "projection": str(projection_path),
                "projection_blake3": writing_gate._hash(projection_path), "mechanical_gate_id": "synthetic-gate",
                "mechanical_gate_blake3": writing_gate._hash(gate_path), "rules": str(rules_path),
                "rules_blake3": writing_gate._hash(rules_path)}
            policy = {"schema": "book-writing-policy-v1", "unknown_documents": "deny",
                "documents": {source.name: {"role": "current_prose", "source_blake3": source_hash,
                    "native_gate_result": str(gate_path)}},
                "export_purposes": {"private_layout_proof": {"delivery_eligible": False,
                    "requires_voice_qualification": False, "title": "Private layout proof Unfinished synthetic",
                    "output_root": "internal-layout", "documents": {source.name: selected}}}}
            self._write_private(policy_path, json.dumps(policy).encode())
            settings = {"role": "current_prose", "source_blake3": source_hash,
                "export_purposes": {"private_layout_proof": {"input_root": str(root), "policy": str(policy_path),
                    "policy_blake3": writing_gate._hash(policy_path)}}}
            proof_root = root / "internal-layout"
            proof_root.mkdir(mode=0o700)
            pdf_path = proof_root / "synthetic.pdf"
            self._write_private(pdf_path, b"synthetic PDF input")

            class FakeTextPage:
                def get_text_range(self, errors): return "Private layout proof Unfinished synthetic\nHello world."
                def get_text_bounded(self, errors): return "Private layout proof Unfinished synthetic\nHello world."
                def count_rects(self): return 0
                def close(self): pass
            class FakePage:
                def get_size(self): return (612, 792)
                def get_textpage(self): return FakeTextPage()
                def render(self, scale): return FakeBitmap()
                def close(self): pass
            class FakePixels:
                def save(self, path): Path(path).write_bytes(b"synthetic PNG pixels")
                def close(self): pass
            class FakeBitmap:
                width, height = 1020, 1320
                def to_pil(self): return FakePixels()
                def close(self): pass
            class FakeDocument:
                def __enter__(self): return self
                def __exit__(self, *_): pass
                def __len__(self): return 1
                def __getitem__(self, index): return FakePage()
            fake_pdfium = ModuleType("pypdfium2")
            fake_pdfium.__path__ = []
            fake_pdfium.PdfDocument = lambda data: FakeDocument()
            fake_raw = ModuleType("pypdfium2.raw")
            with patch.dict(sys.modules, {"pypdfium2": fake_pdfium, "pypdfium2.raw": fake_raw}):
                answer = inspect_pdf(source, settings, job_path, pdf_path, 120, text_only=True)
            report = json.loads(Path(answer["inspection"]).read_text())
            self.assertEqual(answer["pdf_identity"], "1f:" + writing_gate._hash(pdf_path))
            self.assertEqual(report["projection_identity"], "1f:" + writing_gate._hash(projection_path))
            self.assertTrue(report["text_readback"]["exact_ordered_text_after_whitespace_normalization"])
            self.assertFalse(report["delivery_eligible"])
            self.assertEqual(report["voice_qualification"], "not_established")
            self.assertEqual(os.stat(answer["inspection"]).st_mode & 0o777, 0o600)
            with patch.dict(sys.modules, {"pypdfium2": fake_pdfium, "pypdfium2.raw": fake_raw}):
                rasterized = inspect_pdf(source, settings, job_path, pdf_path, 120, text_only=False)
            raster_report = json.loads(Path(rasterized["inspection"]).read_text())
            png = Path(raster_report["pages"][0]["image"])
            self.assertEqual(png.read_bytes(), b"synthetic PNG pixels")
            self.assertEqual(os.stat(png).st_mode & 0o777, 0o600)

    @staticmethod
    def _write_private(path, content):
        path.write_bytes(content)
        path.chmod(0o600)

    def test_only_exact_same_table_header_at_page_boundary_is_layout_replication(self):
        source = projection([{"kind": "table", "rows": [["Kind", "Action"], ["One", "Do one"], ["Two", "Do two"]]}])
        result = text_mapping(source, ["Proof Kind Action One Do one", "Kind Action Two Do two"], "Proof")
        self.assertTrue(result["exact_ordered_text_after_whitespace_normalization"])
        self.assertEqual(result["layout_header_repetitions"], [{"page_number": 2,
            "request_block_index": 0, "header_text": "Kind Action", "normalized_original_page_prefix_range": [0, 11]}])
        for page in ("Kind Changed Two Do two", "Kind Action Two Do nothing", "Extra Kind Action Two Do two"):
            with self.subTest(page=page):
                self.assertFalse(text_mapping(source, ["Proof Kind Action One Do one", page], "Proof")["exact_ordered_text_after_whitespace_normalization"])

    def test_repetition_outside_current_table_is_not_removed(self):
        source = projection([{"kind": "table", "rows": [["Kind", "Action"], ["One", "Do one"]]},
                             {"kind": "paragraph", "text": "End paragraph."}])
        result = text_mapping(source, ["Proof Kind Action One Do one", "Kind Action End paragraph."], "Proof")
        self.assertFalse(result["exact_ordered_text_after_whitespace_normalization"])
        self.assertEqual(result["layout_header_repetitions"], [])

    def test_line_wrap_inside_source_compounds_retains_actual_hyphen_and_numbers(self):
        source = projection([{"kind": "paragraph", "text": "Use the 60-second target and 10–15 breaths for a Zero-Person test."}])
        result = text_mapping(source, ["Proof Use the 60-\r\nsecond target and 10–\r\n15 breaths for a Zero-\nPerson test."], "Proof")
        self.assertTrue(result["exact_ordered_text_after_whitespace_normalization"])
        self.assertEqual([row["joined"] for row in result["source_compound_line_wraps"]], ["60-second", "10–15", "Zero-Person"])
        changed = text_mapping(source, ["Proof Use the 60-\nsecond target and 10–\n30 breaths for a Zero-\nPerson test."], "Proof")
        self.assertFalse(changed["exact_ordered_text_after_whitespace_normalization"])

    def test_compound_can_wrap_between_pages_without_losing_its_page_mapping(self):
        source = projection([{"kind": "paragraph", "text": "A Zero-Person business."}])
        result = text_mapping(source, ["Proof A Zero-", "Person business."], "Proof")
        self.assertTrue(result["exact_ordered_text_after_whitespace_normalization"])
        self.assertEqual(result["blocks"][0]["last_page"], 2)

    def test_spaces_are_not_removed_without_a_source_compound(self):
        source = projection([{"kind": "paragraph", "text": "Use a two second pause."}])
        self.assertFalse(text_mapping(source, ["Proof Use a two-\nsecond pause."], "Proof")["exact_ordered_text_after_whitespace_normalization"])

    def test_line_and_page_wrap_before_source_hyphen(self):
        source = projection([{"kind": "paragraph", "text": "Use RPE 7–10 and a Whole-food combination."}])
        for pages in (["Proof Use RPE 7\r\n–10 and a Whole\n-food combination."],
                      ["Proof Use RPE 7", "–10 and a Whole-food combination."]):
            self.assertTrue(text_mapping(source, pages, "Proof")["exact_ordered_text_after_whitespace_normalization"])
        self.assertFalse(text_mapping(source, ["Proof Use RPE 7\n–20 and a Whole-food combination."], "Proof")["exact_ordered_text_after_whitespace_normalization"])

    def test_pdfium_marker_needs_exact_source_compound_and_confirmed_position(self):
        source = projection([{"kind": "paragraph", "text": "Whole-food combinations."}])
        text = "Proof Whole\x02food combinations."
        result = text_mapping(source, [text], "Proof", {1: [11]})
        self.assertTrue(result["exact_ordered_text_after_whitespace_normalization"])
        self.assertEqual(result["source_compound_hyphen_marker_restorations"][0]["source_compound"], "Whole-food")
        for positions in ({}, {1: [10]}, {2: [11]}):
            self.assertFalse(text_mapping(source, [text], "Proof", positions)["exact_ordered_text_after_whitespace_normalization"])

    def test_marker_cannot_repair_changed_words_or_quantities(self):
        source = projection([{"kind": "paragraph", "text": "Use 10–15 breaths and Whole-food combinations."}])
        for text in ("Proof Use 10\x0230 breaths and Whole-food combinations.",
                     "Proof Use 10–15 breaths and Whole\x02wrong combinations."):
            positions = {1: [text.index("\x02")]}
            self.assertFalse(text_mapping(source, [text], "Proof", positions)["exact_ordered_text_after_whitespace_normalization"])

    def test_ambiguous_source_hyphen_is_not_guessed(self):
        source = projection([{"kind": "paragraph", "text": "Use Whole-food and Whole–food."}])
        text = "Proof Use Whole\x02food and Whole–food."
        result = text_mapping(source, [text], "Proof", {1: [text.index("\x02")]})
        self.assertFalse(result["exact_ordered_text_after_whitespace_normalization"])
        self.assertEqual(result["source_compound_hyphen_marker_restorations"], [])

    def test_source_token_line_wrap_preserves_following_table_header_mapping(self):
        source = projection([{"kind": "paragraph", "text": "Wèntí (問題) names a question."},
                             {"kind": "table", "rows": [["Kind", "Action"],
                                 ["One", "Do one"], ["Two", "Do two"]]}])
        result = text_mapping(source, ["Proof Wèntí (問\r\n題) names a question. Kind Action One Do one",
                                       "Kind Action Two Do two"], "Proof")
        self.assertTrue(result["exact_ordered_text_after_whitespace_normalization"])
        self.assertEqual(result["mapped_blocks"], 2)
        self.assertEqual(result["source_token_line_wraps"][0]["joined"], "(問題)")
        self.assertEqual(result["source_token_line_wraps"][0]["original"], "(問\r\n題)")
        self.assertEqual(len(result["layout_header_repetitions"]), 1)

    def test_cjk_wrap_does_not_repair_changed_glyphs_or_an_inserted_space(self):
        source = projection([{"kind": "paragraph", "text": "Use 問題 and keep 15."}])
        for text in ("Proof Use 問\n提 and keep 15.",
                     "Proof Use 問 題 and keep 15.",
                     "Proof Use 問\n題 and keep 30."):
            with self.subTest(text=text):
                self.assertFalse(text_mapping(source, [text], "Proof")["exact_ordered_text_after_whitespace_normalization"])

    def test_separate_source_cjk_tokens_are_not_joined_at_a_line_break(self):
        source = projection([{"kind": "paragraph", "text": "Keep 問 題 separate."}])
        result = text_mapping(source, ["Proof Keep 問\n題 separate."], "Proof")
        self.assertTrue(result["exact_ordered_text_after_whitespace_normalization"])
        self.assertEqual(result["source_token_line_wraps"], [])

    def test_source_token_restoration_is_not_script_specific(self):
        source = projection([{"kind": "paragraph", "text": "A question and an inside view."}])
        result = text_mapping(source, ["Proof A ques\ntion and an in\nside view."], "Proof")
        self.assertTrue(result["exact_ordered_text_after_whitespace_normalization"])
        self.assertEqual([item["joined"] for item in result["source_token_line_wraps"]], ["question", "inside"])
        for text in ("Proof A ques\nton and an inside view.",
                     "Proof A quset\nion and an inside view."):
            self.assertFalse(text_mapping(source, [text], "Proof")["exact_ordered_text_after_whitespace_normalization"])

    def test_intentional_source_token_boundary_wins_even_if_joined_token_exists_elsewhere(self):
        for authored in ("Keep in side and inside.", "Keep in\nside and inside."):
            source = projection([{"kind": "paragraph", "text": authored}])
            result = text_mapping(source, ["Proof Keep in\nside and inside."], "Proof")
            self.assertTrue(result["exact_ordered_text_after_whitespace_normalization"])
            self.assertEqual(result["source_token_line_wraps"], [])


if __name__ == "__main__":
    unittest.main()
