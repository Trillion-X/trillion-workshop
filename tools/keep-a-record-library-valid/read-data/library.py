"""A library of record files, read through its schema.

Nothing about a library's record kinds is known here. The schema (a JSON file the person gives, with `--schema`) names every file, the
set of ids each kind of record holds (a pool), the relations that must hold between them (checks), the settings an investigation
reads and the commands that report derived files stale. See the README for each key.

A pool is { "file": <path from the library root>, "path": <where the records are in the file>, "id": <the field holding a record's id> }.
A path is dotted keys; a key ending in [] means "every item of this list"; an empty path means the file is the list itself.
"""
from __future__ import annotations

import fcntl
import json
import os
import subprocess
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

PROGRAM = 'keep_a_record_library.py'
SCHEMA_VERSION = '0.1.0'


def now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec='seconds')


def read_json(path: Path) -> Any:
    return json.loads(path.read_text(encoding='utf-8'))


def write_json(path: Path, value: Any) -> None:
    tmp = path.with_name(path.name + '.tmp')
    tmp.write_text(json.dumps(value, ensure_ascii=False, indent=1) + '\n', encoding='utf-8')
    os.replace(tmp, path)


def content_identity(path: Path) -> dict:
    """BLAKE3 identity of a file: the blake3 module when installed, else the b3sum command. Refuses when neither exists."""
    try:
        import blake3  # type: ignore
        h = blake3.blake3()
        with path.open('rb') as f:
            for block in iter(lambda: f.read(1 << 20), b''):
                h.update(block)
        value = h.hexdigest()
    except ImportError:
        try:
            value = subprocess.run(['b3sum', '--no-names', str(path)], check=True, capture_output=True, text=True).stdout.strip()
        except FileNotFoundError as exc:
            raise ValueError('A file identity is BLAKE3: install the python module (pip install blake3) or the b3sum command') from exc
    return {'algorithm': 'blake3', 'value': value, 'bytes': path.stat().st_size}


def piece_rel(piece: Path, p: Path) -> str:
    try:
        return str(p.relative_to(piece))
    except ValueError:
        return str(p)


def at_path(document: Any, path: str) -> list:
    """The records a path names in a loaded document, in order: lists found at the path are spread into one list."""
    nodes = [document]
    for part in filter(None, path.split('.')):
        nodes = [n[part.removesuffix('[]')] for n in nodes]
        if part.endswith('[]'):
            nodes = [item for n in nodes for item in n]
    return [item for n in nodes for item in (n if isinstance(n, list) else [n])]


class Store:
    """The records of one library, read through its schema. Tests point it at a temporary library."""

    def __init__(self, root: Path, schema_path: Path):
        self.root = Path(root).resolve()
        self.schema_path = Path(schema_path)
        self.schema = read_json(self.schema_path)
        self._files: dict[str, Any] = {}

    def file(self, relative: str) -> Any:
        if relative not in self._files:
            self._files[relative] = read_json(self.root / relative)
        return self._files[relative]

    def spec(self, name: str) -> dict:
        if name not in self.schema['pools']:
            raise KeyError(f'the schema has no pool named {name}')
        return self.schema['pools'][name]

    def pool(self, name: str) -> list[dict]:
        spec = self.spec(name)
        return at_path(self.file(spec['file']), spec.get('path', ''))

    def id_field(self, name: str) -> str:
        return self.spec(name)['id']

    def ids(self, name: str) -> list[str]:
        field = self.id_field(name)
        return [r[field] for r in self.pool(name)]

    def by_id(self, name: str) -> dict[str, dict]:
        field = self.id_field(name)
        return {r[field]: r for r in self.pool(name)}

    @property
    def investigation(self) -> dict:
        return self.schema['investigation']

    def pool_of(self, role: str) -> str:
        return self.investigation['pools'][role]

    def findings_path(self) -> Path:
        return self.root / self.spec(self.pool_of('findings'))['file']

    def load_findings(self) -> list[dict]:
        p = self.findings_path()
        return read_json(p) if p.is_file() else []

    def lock(self):
        path = self.root / self.schema['lock']
        path.parent.mkdir(parents=True, exist_ok=True)
        f = open(path, 'a')
        fcntl.flock(f, fcntl.LOCK_EX)
        return f
