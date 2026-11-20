"""Canonical multihash names: BLAKE3-256 written `1f:<64 hex>`, from the one owner of that identity.

The identity is tools/conversations/read-data/content_identity.py (content_hash). It is loaded from that file, never copied.
"""
from __future__ import annotations
import importlib.util
import pathlib
import re
import sys
from typing import Any

_OWNER = pathlib.Path(__file__).resolve().parents[4] / "conversations" / "read-data" / "content_identity.py"
_spec = importlib.util.spec_from_file_location("content_identity", _OWNER)
_content_identity = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(_content_identity)
content_hash = _content_identity.content_hash

_CANONICAL = re.compile(r"1f:[0-9a-f]{64}")

def normalize_multihash(value: Any) -> str:
    if not isinstance(value, str) or not _CANONICAL.fullmatch(value):
        raise ValueError("a canonical multihash is 1f: and 64 lowercase hex characters")
    return value

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
