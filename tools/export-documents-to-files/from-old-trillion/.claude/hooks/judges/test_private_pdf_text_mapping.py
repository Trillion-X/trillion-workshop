import unittest

from inspect_private_document_pdf import text_mapping


def projection(blocks):
    return {"ordered_blocks": blocks,
            "ordered_bindings": [{"request_block_index": i} for i in range(len(blocks))]}


class TextMappingTests(unittest.TestCase):
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
