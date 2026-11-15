"""Compatibility names backed by the Python runtime's shared Rust crypto binding."""
from __future__ import annotations
import sys
from typing import Any
from bitfield_crypto import content_hash, normalize_multihash

def mint_canonical_multihash_of_bytes(value: bytes | bytearray | memoryview) -> str:
    return content_hash(value)

def mint_canonical_multihash_of_text(value: str) -> str:
    if not isinstance(value, str):
        raise TypeError("canonical multihash text input must be a string")
    return content_hash(value.encode("utf-8"))

def is_canonical_multihash(value: Any) -> bool:
    if not isinstance(value, str) or len(value) != 67 or not value.startswith("1f:"):
        return False
    try:
        return normalize_multihash(value) == value
    except ValueError:
        return False

def require_canonical_multihash(value: Any, label: str) -> str:
    if not is_canonical_multihash(value):
        raise ValueError(f"{label} must be canonical multihash text")
    return value

def _main(argv: list[str]) -> int:
    if len(argv) != 2 or argv[0] != "--text":
        print("usage: canonical_multihash.py --text <value>", file=sys.stderr)
        return 2
    print(mint_canonical_multihash_of_text(argv[1]))
    return 0

if __name__ == "__main__":
    raise SystemExit(_main(sys.argv[1:]))
