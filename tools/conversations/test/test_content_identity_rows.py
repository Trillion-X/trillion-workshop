"""The conversations package's rows mount the one content identity owner, never a missing blob (run with python3 directly)."""
import json
import pathlib
import re
import unittest

TOOL = pathlib.Path(__file__).resolve().parents[1]
PACKAGE = TOOL / 'packages' / 'ai-cli-conversations'
BLAKE3_OF_EMPTY = '1f:af1349b9f5f9a1a6a0404dea36dcc9499bcb25c9adc112b7cc9a93cae41f3262'


class ContentIdentityRows(unittest.TestCase):
    def setUp(self):
        self.rows = json.loads((PACKAGE / 'things-to-store-and-run.json').read_text(encoding='utf-8'))

    def test_the_stored_bytes_row_names_the_owner_file_and_it_exists(self):
        stored = [t for t in self.rows['things'] if t.get('type') == 'stored_bytes' and t.get('name') == 'content-identity-python-module']
        self.assertEqual(len(stored), 1)
        resolved = (PACKAGE / stored[0]['source_path']).resolve()
        self.assertEqual(resolved, (TOOL / 'read-data' / 'content_identity.py').resolve())
        self.assertTrue(resolved.is_file())

    def test_both_templates_mount_that_module_under_the_name_the_decoder_imports(self):
        text = (PACKAGE / 'things-to-store-and-run.json').read_text(encoding='utf-8')
        self.assertNotIn('bitfield', text)
        self.assertEqual(text.count('"module_name": "content_identity"'), 2)
        self.assertEqual(text.count('"mount_path": "content_identity.py"'), 2)
        decoder = (TOOL / 'read-data' / 'decode_source.py').read_text(encoding='utf-8')
        self.assertIsNotNone(re.search(r'^from content_identity import content_hash', decoder, re.M))

    def test_the_owner_names_the_empty_input_by_blake3(self):
        import importlib.util
        spec = importlib.util.spec_from_file_location('content_identity', TOOL / 'read-data' / 'content_identity.py')
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
        self.assertEqual(module.content_hash(b''), BLAKE3_OF_EMPTY)


if __name__ == '__main__':
    unittest.main()
