"""The canonical multihash names on a machine with no bitfield_crypto: BLAKE3 from the owner, never SHA-256."""
import pathlib
import sys
import unittest

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent))
import canonical_multihash as cm  # noqa: E402

BLAKE3_OF_EMPTY = "1f:af1349b9f5f9a1a6a0404dea36dcc9499bcb25c9adc112b7cc9a93cae41f3262"


class CanonicalMultihash(unittest.TestCase):
    def test_bytes_and_text_mint_the_blake3_identity(self):
        self.assertEqual(cm.mint_canonical_multihash_of_bytes(b""), BLAKE3_OF_EMPTY)
        self.assertEqual(cm.mint_canonical_multihash_of_text(""), BLAKE3_OF_EMPTY)

    def test_the_owners_standard_library_fallback_gives_the_same_identity(self):
        # The owner computes BLAKE3 in pure Python where the blake3 module is missing; this checks that path directly.
        self.assertEqual(cm._content_identity.CODE + ":" + cm._content_identity.pure_digest(b""), BLAKE3_OF_EMPTY)

    def test_only_1f_and_64_lowercase_hex_is_canonical(self):
        self.assertTrue(cm.is_canonical_multihash(BLAKE3_OF_EMPTY))
        self.assertFalse(cm.is_canonical_multihash(BLAKE3_OF_EMPTY.upper()))
        self.assertFalse(cm.is_canonical_multihash(BLAKE3_OF_EMPTY[:-1]))
        self.assertFalse(cm.is_canonical_multihash("2f:" + BLAKE3_OF_EMPTY[3:]))
        self.assertFalse(cm.is_canonical_multihash(None))

    def test_normalize_names_a_bad_value_in_words(self):
        self.assertEqual(cm.normalize_multihash(BLAKE3_OF_EMPTY), BLAKE3_OF_EMPTY)
        with self.assertRaisesRegex(ValueError, "1f:"):
            cm.normalize_multihash("sha256:" + "0" * 64)

    def test_require_names_the_label(self):
        with self.assertRaisesRegex(ValueError, "payload hash must be canonical multihash text"):
            cm.require_canonical_multihash("nope", "payload hash")


if __name__ == "__main__":
    unittest.main()
