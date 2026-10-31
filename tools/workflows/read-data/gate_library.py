"""Where a person's checklist, pieces and answers are, read through a schema file the person gives.

Nothing about any person's pieces, checks, checkers or folder names is known here. The schema (JSON, see the README) names them. Any value
in the schema may be `{ "$ref": { "file": <path from the library root>, "path": "dotted.keys" } }`: it is replaced by the value at that
path in that file, so a setting that already has an owner (a reviewed pin, a list of rules) is read from its owner, not copied.
"""
from __future__ import annotations

import contextlib
import fcntl
import json
import os
import re
import subprocess
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

PROGRAM = 'checklist_gate.py'


def now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec='seconds')


def read_json(path: Path) -> Any:
    return json.loads(Path(path).read_text(encoding='utf-8'))


def write_json(path: Path, value: Any) -> None:
    path = Path(path)
    tmp = path.with_name(path.name + '.tmp')
    tmp.write_text(json.dumps(value, ensure_ascii=False, indent=1) + '\n', encoding='utf-8')
    os.replace(tmp, path)


def blake3_of(data: bytes) -> str:
    """BLAKE3 hex of bytes: the blake3 module when installed, else the b3sum command. Refuses when neither exists."""
    try:
        import blake3  # type: ignore
        return blake3.blake3(data).hexdigest()
    except ImportError:
        try:
            return subprocess.run(['b3sum', '--no-names'], input=data, capture_output=True, check=True).stdout.decode().strip()
        except FileNotFoundError as exc:
            raise ValueError('A file identity is BLAKE3: install the python module (pip install blake3) or the b3sum command') from exc


def file_blake3(path: Path) -> str:
    try:
        import blake3  # type: ignore
        h = blake3.blake3()
        with Path(path).open('rb') as f:
            for block in iter(lambda: f.read(1 << 20), b''):
                h.update(block)
        return h.hexdigest()
    except ImportError:
        try:
            return subprocess.run(['b3sum', '--no-names', str(path)], check=True, capture_output=True, text=True).stdout.strip()
        except FileNotFoundError as exc:
            raise ValueError('A file identity is BLAKE3: install the python module (pip install blake3) or the b3sum command') from exc


def dotted_value(document: Any, path: str) -> Any:
    """The value at a dotted path of dict keys; an empty path is the document."""
    for part in filter(None, path.split('.')):
        document = document[part]
    return document


def dotted_get(document: Any, path: str, default: Any = None) -> Any:
    for part in filter(None, path.split('.')):
        if not isinstance(document, dict) or part not in document:
            return default
        document = document[part]
    return document


def values_at(document: Any, path: str) -> list:
    """Values at a dotted path; 'rows.text' walks a list and yields every item's text."""
    cur = [document]
    for part in path.split('.'):
        nxt = []
        for c in cur:
            if isinstance(c, list):
                nxt += [x.get(part) for x in c if isinstance(x, dict) and part in x]
            elif isinstance(c, dict) and part in c:
                nxt.append(c[part])
        cur = nxt
    return [x for x in cur if x is not None]


class Library:
    """One library: its root folder and its schema. Tests point it at a temporary library."""

    def __init__(self, root: Path, schema_path: Path, read_only: bool = False):
        self.root = Path(root)
        self.schema_path = Path(schema_path)
        self.read_only = read_only
        self._files: dict[str, Any] = {}
        self.schema = self._resolve(read_json(self.schema_path))

    # -- references ---------------------------------------------------------------------------------------------------
    def file(self, relative: str) -> Any:
        if relative not in self._files:
            self._files[relative] = read_json(self.root / relative)
        return self._files[relative]

    def _resolve(self, value: Any) -> Any:
        if isinstance(value, dict):
            if set(value) == {'$ref'}:
                ref = value['$ref']
                try:
                    return dotted_value(self.file(ref['file']), ref.get('path', ''))
                except KeyError as exc:
                    raise ValueError(f'the schema refers to {ref["path"]} in {ref["file"]}, which has no {exc.args[0]}') from exc
            return {k: self._resolve(v) for k, v in value.items()}
        if isinstance(value, list):
            return [self._resolve(v) for v in value]
        return value

    def path_of(self, relative: str) -> Path:
        """A path the schema names: absolute as given, else from the library root."""
        p = Path(relative)
        return p if p.is_absolute() else self.root / p

    # -- the checklist ------------------------------------------------------------------------------------------------
    @property
    def checklist(self) -> dict:
        return self.file(self.schema['checklist'])

    def checks(self) -> dict[str, dict]:
        return {c['id']: c for s in self.checklist['stages'] for c in s['checks']}

    # -- schema sections (a missing required section is a refusal that names it) ----------------------------------------
    def section(self, name: str) -> dict:
        if name not in self.schema:
            raise ValueError(f'the schema has no "{name}" section')
        return self.schema[name]

    @property
    def piece_header(self) -> dict:
        return self.section('piece')['header']

    def lock(self):
        """Lock the existing library directory without creating or changing a file in it.

        A gate only reads the library. Its lock must therefore work when the caller has a read-only folder grant and
        the library itself is not writable. Every current gate command locks the same directory inode, so readers and
        writers still serialize with one another.
        """
        fd = os.open(self.root, os.O_RDONLY)
        try:
            fcntl.flock(fd, fcntl.LOCK_EX)
        except BaseException:
            os.close(fd)
            raise
        return _DirectoryLock(fd)


class _DirectoryLock:
    """The closeable handle ``contextlib.closing`` expects for a directory flock."""

    def __init__(self, fd: int):
        self.fd = fd

    def close(self) -> None:
        try:
            fcntl.flock(self.fd, fcntl.LOCK_UN)
        finally:
            os.close(self.fd)


@contextlib.contextmanager
def locked(lib: Library):
    """Hold the library lock while rows are recorded."""
    handle = lib.lock()
    try:
        yield
    finally:
        handle.close()


def comma_list(values: list[str]) -> list[str]:
    return [x.strip() for v in values for x in v.split(',') if x.strip()]


def natural_key(path: Path) -> list:
    """Sort key where round 10 follows round 9."""
    return [int(t) if t.isdigit() else t for t in re.split(r'(\d+)', str(path))]


def phase_check_id(entry: str, ids) -> str | None:
    """The check a publish/after phase entry names: the entry is a check id, optionally followed by a space and a note."""
    return next((i for i in sorted(ids, key=len, reverse=True) if entry == i or entry.startswith(i + ' ')), None)
