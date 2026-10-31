import support  # noqa: E402,F401  (read-data on the import path)

import content_identity
from content_identity import content_hash, content_hash_chunks, pure_digest


def test_content_hash_matches_the_published_blake3_answers():
    assert content_hash(b"") == "1f:af1349b9f5f9a1a6a0404dea36dcc9499bcb25c9adc112b7cc9a93cae41f3262"
    assert content_hash(b"abc") == "1f:6437b3ac38465133ffb63b75273a8db548c558465d79db03fd359c6cd5bd9d85"
    assert content_hash(b"a") == "1f:17762fddd969a453925d65717ac3eea21320b66b54342fde15128d6caf21215f"


def test_ordered_chunks_give_the_identity_of_the_whole():
    assert content_hash_chunks([b"a", b"b", b"c"]) == content_hash(b"abc")
    assert content_hash_chunks([]) == content_hash(b"")
    data = bytes(index % 251 for index in range(5000))
    for split in (1, 63, 64, 1023, 1024, 1025, 4999):
        assert content_hash_chunks([data[:split], data[split:]]) == content_hash(data)


def test_the_standard_library_blake3_equals_the_module_at_every_shape_of_the_tree():
    # Lengths that change the tree: block edges, chunk edges, one, two, three and many chunks, and a full subtree.
    for length in (0, 1, 2, 63, 64, 65, 127, 128, 129, 1023, 1024, 1025, 2047, 2048, 2049, 3072, 3073, 4096, 4097,
                   7 * 1024, 7 * 1024 + 1, 8 * 1024, 8 * 1024 + 1, 31 * 1024 + 5, 100000):
        data = bytes(index % 251 for index in range(length))
        assert pure_digest(data) == content_hash(data)[3:], length


def test_the_standard_library_blake3_gives_the_reference_answers_for_the_test_vector_input_pattern():
    # The BLAKE3 team's test vectors hash the bytes 0, 1, 2 ... 250, 0, 1 ... ; these are the reference b3sum
    # results for such inputs (one block, the chunk edge, three chunks, many chunks).
    answers = {
        1: "2d3adedff11b61f14c886e35afa036736dcd87a74d27b5c1510225d0f592e213",
        1023: "10108970eeda3eb932baac1428c7a2163b0e924c9a9e25b35bba72b28f70bd11",
        1024: "42214739f095a406f3fc83deb889744ac00df831c10daa55189b5d121c855af7",
        1025: "d00278ae47eb27b34faecf67b4fe263f82d5412916c1ffd97c8cb7fb814b8444",
        3073: "7124b49501012f81cc7f11ca069ec9226cecb8a2c850cfe644e327d22d3e1cd3",
        100000: "d93c23eedaf165a7e0be908ba86f1a7a520d568d2d13cde787c8580c5c72cc54",
    }
    for length, expected in answers.items():
        data = bytes(index % 251 for index in range(length))
        assert pure_digest(data) == expected, length


def test_a_machine_without_the_module_still_names_the_same_identity():
    module = content_identity._blake3_module
    try:
        content_identity._blake3_module = None
        content_identity._verified = False
        assert content_identity.content_hash(b"abc") == "1f:6437b3ac38465133ffb63b75273a8db548c558465d79db03fd359c6cd5bd9d85"
    finally:
        content_identity._blake3_module = module
        content_identity._verified = False


def test_only_bytes_are_hashed():
    for value in ("abc", 7, None):
        try:
            content_hash(value)
        except TypeError:
            continue
        raise AssertionError(f"hashed {value!r}")
