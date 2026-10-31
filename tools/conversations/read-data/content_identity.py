"""The content identity a Python tool here gives exact bytes: BLAKE3-256, written `1f:<64 hex>`.

The same identity tools/content-identity gives in JavaScript (makeHashCodeHexFromBytes and
makeHashCodeHexFromChunks): byte input and ordered chunk input give one identity. There is one algorithm. The
`blake3` module computes it where the machine has that module; where it has not (a person's own computer with only
the standard library), the BLAKE3 written out below computes it. Both are checked against published known answers
before either names anything, and the tests hold them equal at every length that changes the tree's shape.
"""
from __future__ import annotations

import struct
from collections.abc import Iterable

try:
    import blake3 as _blake3_module
except ImportError:  # the standard library alone: the BLAKE3 below
    _blake3_module = None

CODE = "1f"

_IV = (0x6A09E667, 0xBB67AE85, 0x3C6EF372, 0xA54FF53A, 0x510E527F, 0x9B05688C, 0x1F83D9AB, 0x5BE0CD19)
_PERMUTATION = (2, 6, 3, 10, 7, 0, 4, 13, 1, 11, 12, 5, 9, 14, 15, 8)
_CHUNK_START, _CHUNK_END, _PARENT, _ROOT = 1, 2, 4, 8
_BLOCK_LEN, _CHUNK_LEN = 64, 1024
_MASK = 0xFFFFFFFF

# Known answers: BLAKE3-256 of the empty input and of the three bytes "abc" (the BLAKE3 team's published results).
_KNOWN = (
    (b"", "af1349b9f5f9a1a6a0404dea36dcc9499bcb25c9adc112b7cc9a93cae41f3262"),
    (b"abc", "6437b3ac38465133ffb63b75273a8db548c558465d79db03fd359c6cd5bd9d85"),
)


def _rotr(value: int, bits: int) -> int:
    return ((value >> bits) | (value << (32 - bits))) & _MASK


def _g(state: list, a: int, b: int, c: int, d: int, mx: int, my: int) -> None:
    state[a] = (state[a] + state[b] + mx) & _MASK
    state[d] = _rotr(state[d] ^ state[a], 16)
    state[c] = (state[c] + state[d]) & _MASK
    state[b] = _rotr(state[b] ^ state[c], 12)
    state[a] = (state[a] + state[b] + my) & _MASK
    state[d] = _rotr(state[d] ^ state[a], 8)
    state[c] = (state[c] + state[d]) & _MASK
    state[b] = _rotr(state[b] ^ state[c], 7)


def _compress(chaining: tuple, words: list, counter: int, block_len: int, flags: int) -> list:
    state = list(chaining) + list(_IV[:4]) + [counter & _MASK, (counter >> 32) & _MASK, block_len, flags]
    block = list(words)
    for round_number in range(7):
        _g(state, 0, 4, 8, 12, block[0], block[1])
        _g(state, 1, 5, 9, 13, block[2], block[3])
        _g(state, 2, 6, 10, 14, block[4], block[5])
        _g(state, 3, 7, 11, 15, block[6], block[7])
        _g(state, 0, 5, 10, 15, block[8], block[9])
        _g(state, 1, 6, 11, 12, block[10], block[11])
        _g(state, 2, 7, 8, 13, block[12], block[13])
        _g(state, 3, 4, 9, 14, block[14], block[15])
        if round_number < 6:
            block = [block[index] for index in _PERMUTATION]
    for index in range(8):
        state[index] ^= state[index + 8]
        state[index + 8] ^= chaining[index]
    return state


def _words(block: bytes) -> list:
    return list(struct.unpack("<16I", block.ljust(_BLOCK_LEN, b"\0")))


class _Output:
    """What a chunk or a parent node hands upward: the compression to run once its place (root or not) is known."""

    def __init__(self, chaining: tuple, words: list, counter: int, block_len: int, flags: int):
        self.chaining, self.words, self.counter, self.block_len, self.flags = chaining, words, counter, block_len, flags

    def chaining_value(self) -> tuple:
        return tuple(_compress(self.chaining, self.words, self.counter, self.block_len, self.flags)[:8])

    def root_digest(self) -> bytes:
        state = _compress(self.chaining, self.words, 0, self.block_len, self.flags | _ROOT)
        return struct.pack("<16I", *state)[:32]


class _Chunk:
    def __init__(self, key: tuple, counter: int):
        self.chaining, self.counter = key, counter
        self.block = bytearray()
        self.blocks_compressed = 0

    def length(self) -> int:
        return _BLOCK_LEN * self.blocks_compressed + len(self.block)

    def _start(self) -> int:
        return _CHUNK_START if self.blocks_compressed == 0 else 0

    def update(self, data: memoryview) -> None:
        position = 0
        while position < len(data):
            if len(self.block) == _BLOCK_LEN:
                self.chaining = tuple(_compress(self.chaining, _words(bytes(self.block)), self.counter, _BLOCK_LEN,
                                                self._start())[:8])
                self.blocks_compressed += 1
                self.block = bytearray()
            take = min(_BLOCK_LEN - len(self.block), len(data) - position)
            self.block += data[position:position + take]
            position += take

    def output(self) -> _Output:
        return _Output(self.chaining, _words(bytes(self.block)), self.counter, len(self.block),
                       self._start() | _CHUNK_END)


def _parent(left: tuple, right: tuple) -> _Output:
    return _Output(_IV, list(left) + list(right), 0, _BLOCK_LEN, _PARENT)


class _Hasher:
    def __init__(self):
        self.chunk = _Chunk(_IV, 0)
        self.stack: list = []

    def _add_chunk_chaining_value(self, value: tuple, total_chunks: int) -> None:
        while total_chunks & 1 == 0:
            value = _parent(self.stack.pop(), value).chaining_value()
            total_chunks >>= 1
        self.stack.append(value)

    def update(self, data: bytes) -> None:
        view = memoryview(data)
        while len(view):
            if self.chunk.length() == _CHUNK_LEN:
                value = self.chunk.output().chaining_value()
                total_chunks = self.chunk.counter + 1
                self._add_chunk_chaining_value(value, total_chunks)
                self.chunk = _Chunk(_IV, total_chunks)
            take = min(_CHUNK_LEN - self.chunk.length(), len(view))
            self.chunk.update(view[:take])
            view = view[take:]

    def hexdigest(self) -> str:
        output = self.chunk.output()
        for value in reversed(self.stack):
            output = _parent(value, output.chaining_value())
        return output.root_digest().hex()


def _digest_chunks(chunks: Iterable[bytes]) -> str:
    hasher = _blake3_module.blake3() if _blake3_module is not None else _Hasher()
    for chunk in chunks:
        if not isinstance(chunk, (bytes, bytearray, memoryview)):
            raise TypeError("content hash chunks must be bytes-like")
        hasher.update(bytes(chunk))
    return hasher.hexdigest()


def pure_digest(value: bytes) -> str:
    """BLAKE3-256 of `value` by the BLAKE3 written out in this file, whatever module the machine has (the tests
    hold it equal to the module's)."""
    hasher = _Hasher()
    hasher.update(bytes(value))
    return hasher.hexdigest()


_verified = False


def _verify_backend() -> None:
    global _verified
    if not _verified:
        for data, expected in _KNOWN:
            if _digest_chunks([data]) != expected:
                raise RuntimeError("BLAKE3 disagrees with its published known answers")
        _verified = True


def content_hash(value: bytes | bytearray | memoryview) -> str:
    if not isinstance(value, (bytes, bytearray, memoryview)):
        raise TypeError("content_hash requires bytes-like input")
    _verify_backend()
    return f"{CODE}:{_digest_chunks([bytes(value)])}"


def content_hash_chunks(chunks: Iterable[bytes]) -> str:
    _verify_backend()
    return f"{CODE}:{_digest_chunks(chunks)}"
