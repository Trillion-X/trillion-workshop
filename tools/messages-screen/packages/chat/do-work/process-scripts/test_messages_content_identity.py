"""The two message scripts' content identity on a machine with no bitfield_crypto: BLAKE3 from the owner, loaded by path."""
import importlib.util
import pathlib
import sys
import unittest

HERE = pathlib.Path(__file__).resolve().parent
BLAKE3_OF_EMPTY = "1f:af1349b9f5f9a1a6a0404dea36dcc9499bcb25c9adc112b7cc9a93cae41f3262"


def load(name):
    spec = importlib.util.spec_from_file_location(name.replace("-", "_"), HERE / name)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


class MessagesContentIdentity(unittest.TestCase):
    def test_decode_addressed_exchange_names_its_content_by_blake3(self):
        self.assertEqual(load("decode-addressed-exchange.py").multihash_hex(b""), BLAKE3_OF_EMPTY)

    def test_materialize_conversations_names_its_content_by_blake3(self):
        self.assertEqual(load("materialize-conversations.py").multihash_hex(b""), BLAKE3_OF_EMPTY)

    def test_no_bitfield_crypto_is_imported(self):
        self.assertNotIn("bitfield_crypto", sys.modules)


if __name__ == "__main__":
    unittest.main()
