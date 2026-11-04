"""Adopted source TTS engine registry.

Only modules next to this file are executable. Ambient engine paths and installed
Showtime plugins are migration inputs and are never searched or loaded here.
Built-in local engines retain their original names for voice-profile compatibility.
"""
from __future__ import annotations

import os
import re
from pathlib import Path
from typing import Dict, List, Optional

BUILTIN = ("kokoro", "supertonic", "piper")
ALIASES = {"st": "supertonic"}
NAME_RE = re.compile(r"^[a-z][a-z0-9_]{0,31}$")
PACKAGE_DIR = Path(__file__).resolve().parent / "engines"
_NOT_ENGINES = {"base"}


def valid_name(name: str) -> bool:
    return bool(NAME_RE.match(name or ""))


def search_dirs() -> List[Path]:
    """Only adopted engine modules in this declared source owner are executable."""
    return [PACKAGE_DIR]


def discover() -> Dict[str, Path]:
    """Extra (non-built-in) engines found on disk: {name: module path}."""
    found: Dict[str, Path] = {}
    for d in search_dirs():
        try:
            files = sorted(d.glob("*.py")) if d.is_dir() else []
        except OSError:
            continue
        for f in files:
            name = f.stem
            if name in BUILTIN or name in _NOT_ENGINES or name in found or not valid_name(name):
                continue
            found[name] = f
    return found


def find(name: str) -> Optional[Path]:
    """The module file for extra engine `name`, or None."""
    return discover().get(name) if valid_name(name) and name not in BUILTIN else None


def engine_of(voice: str) -> str:
    """The engine a voice id names: `<engine>:<voice>` -> engine; Kokoro ids and blends -> kokoro.
    Does not check that the engine exists."""
    v = (voice or "").strip()
    head, sep, tail = v.partition(":")
    head = head.lower()
    if not sep or "+" in v:
        return "kokoro"
    head = ALIASES.get(head, head)
    if head in BUILTIN:
        return head
    from .voices import KOKORO_IDS
    if valid_name(head) and head not in KOKORO_IDS and not re.match(r"^\d+(?:\.\d+)?$", tail):
        return head
    return "kokoro"
