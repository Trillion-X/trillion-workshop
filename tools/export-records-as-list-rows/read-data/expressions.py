"""Expressions a record-write mapping uses to work values out of a record. Nothing about any record kind is known here.

An expression is a one-key JSON object (or a plain string, number or list, which stand for themselves). Every transform of
list_rows.py works here too. These are added; `T` is any expression:

  {"path": "a.b"}                        the value at that dotted path in the record (a number indexes a list), or nothing
  {"text": "{a} and {b}"}                the template filled from the record (an empty placeholder is empty text)
  {"if": C, "then": T, "else": T}        one of two expressions; C is {"set": T} {"empty": T} {"not": C} {"all": [C]} {"any": [C]}
                                         {"equals": [T, T]} {"matches": {"of": T, "pattern": "regular expression"}}
  {"first_set": [T, ...]}                the first that gives a value; later ones are not worked out when an earlier one does
  {"split": {"of": T, "sep": ","}}       a list of trimmed, non-empty parts of a text (a list stays as it is)
  {"list": [T, ...], "flatten": true, "unique": true, "limit": N}
                                         the values, dropping empty ones; flatten spreads lists; unique keeps the first of each
  {"lookup": {"file": REF, "path": "dotted", "table": T, "key": T, "get": "field"}}
                                         the entry for the key in a table (the object at `path` in a JSON file, or `table`),
                                         or its `get` field
  {"row_of": {"list": L, "id": T, "get": "field"}}
                                         a field of the record a row of list L was made from (or the record)
  {"count_links": {"list": L, "field": "f"}}
                                         how many rows of list L hold this record's id in their `f` value
  {"object": {"name": T, ...}}      an object of those values, leaving out the empty ones
  {"pairs": {"of": T, "template": "{key}: {value}"}}
                                         one text per key and value of an object
  {"cut": {"of": T, "max": 300}}      a text cut to at most that many characters
  {"joined": {"of": T, "sep": ", "}}   a list joined into one text
  {"json": T}                            the value as compact JSON text, keys in the order they come (a row value holds no nested
                                         object, so a nested one is kept as text and read back by parsing it); nothing for nothing
  {"slug": {"of": T, "max": 80}}         lower-case letters and digits joined by single hyphens, at most `max` characters
  {"file_text": {"file": T, "note": T}}  the words of a file ({root, path}), under a quoted note when there is one
  {"ref_label": {"of": T, "templates": {root: "text with {path}"}, "default": "{root} {path}"}}
                                         how a file reference reads in a basis
  {"require": {"of": T, "texts": true, "error": "text"}}
                                         the value, refused with the error unless it is a non-empty list of non-empty texts
  {"fail": "text"}                       refuse with this text (a template over the record)

A file reference is { "root": name, "path": "relative path" }; `root` is one of the folders the run was given by name.
"""
from __future__ import annotations

import json
import re
import subprocess
from pathlib import Path
from typing import Any

import list_rows

EMPTY = (None, '', [])


class Context:
    """What expressions can reach beyond the record: the named folders, the rows made so far, and files read once."""

    def __init__(self, roots: dict[str, Path]):
        self.roots = roots
        self.rows: dict[str, list[dict]] = {}
        self.recs: dict[str, list[dict]] = {}
        self._json: dict[Path, Any] = {}

    def path_of(self, ref: dict) -> Path:
        if ref['root'] not in self.roots:
            raise ValueError(f'No folder was given for root {ref["root"]}: give --root {ref["root"]}=DIR.')
        return self.roots[ref['root']] / ref['path']

    def json(self, ref: dict) -> Any:
        path = self.path_of(ref)
        if path not in self._json:
            self._json[path] = json.loads(path.read_text(encoding='utf-8'))
        return self._json[path]

    def row(self, list_id: str, row_id: str) -> dict | None:
        """The record a row of the list is made from."""
        return next((r for r in self.recs.get(list_id, []) if r['id'] == row_id), None)


def dig(value: Any, path: str):
    for part in path.split('.'):
        if isinstance(value, list) and part.isdigit() and int(part) < len(value):
            value = value[int(part)]
        elif isinstance(value, dict) and part in value:
            value = value[part]
        else:
            return None
    return value


def present(value: Any) -> bool:
    return value not in EMPTY


def holds(c: dict, rec: dict, ctx: Context) -> bool:
    ((kind, arg),) = c.items()
    if kind == 'set':
        return present(evaluate(arg, rec, ctx))
    if kind == 'empty':
        return not present(evaluate(arg, rec, ctx))
    if kind == 'not':
        return not holds(arg, rec, ctx)
    if kind == 'all':
        return all(holds(x, rec, ctx) for x in arg)
    if kind == 'any':
        return any(holds(x, rec, ctx) for x in arg)
    if kind == 'equals':
        return evaluate(arg[0], rec, ctx) == evaluate(arg[1], rec, ctx)
    if kind == 'matches':
        return re.search(arg['pattern'], str(evaluate(arg['of'], rec, ctx) or '')) is not None
    raise ValueError(f'condition {json.dumps(c)} is not one of set, empty, not, all, any, equals, matches')


def slug(text: str, most: int) -> str:
    return re.sub(r'-$', '', re.sub(r'^-|-$', '', re.sub(r'[^a-z0-9]+', '-', text.lower()))[:most])


def evaluate(t: Any, rec: dict, ctx: Context):
    """An expression's value for a record, or None for no value."""
    if not isinstance(t, dict):
        return t
    if 'path' in t:
        return dig(rec, t['path'])
    if 'identity' in t:
        value = evaluate(t['identity'], rec, ctx)
        if not isinstance(value, str):
            raise ValueError('A content identity needs text or bytes.')
        bridge = Path(__file__).resolve().parents[2] / 'content-identity' / 'do-work' / 'identity-from-stdin.mjs'
        result = subprocess.run(['node', str(bridge)], input=value.encode('utf-8'), capture_output=True, check=False)
        if result.returncode != 0:
            raise ValueError(f'Content identity failed: {result.stderr.decode("utf-8", errors="replace").strip()}')
        return result.stdout.decode('utf-8').strip()
    if 'text' in t:
        return t['text'].format_map(list_rows.Safe({k: ('' if v is None else v) for k, v in rec.items() if not isinstance(v, (dict, list))}))
    if 'if' in t:
        return evaluate(t['then'] if holds(t['if'], rec, ctx) else t.get('else'), rec, ctx)
    if 'first_set' in t:
        for option in t['first_set']:
            value = evaluate(option, rec, ctx)
            if present(value):
                return value
        return None
    if 'split' in t:
        value = evaluate(t['split']['of'], rec, ctx)
        if isinstance(value, str):
            return [p for p in (x.strip() for x in value.split(t['split'].get('sep', ','))) if p]
        return value
    if 'list' in t:
        out: list = []
        for item in t['list']:
            value = evaluate(item, rec, ctx)
            if t.get('flatten') and isinstance(value, list):
                out.extend(v for v in value if present(v))
            elif present(value):
                out.append(value)
        if t.get('unique'):
            out = list(dict.fromkeys(out))
        return out[:t['limit']] if 'limit' in t else out
    if 'lookup' in t:
        spec = t['lookup']
        table = evaluate(spec['table'], rec, ctx) if 'table' in spec else list_rows_path(ctx.json(spec['file']), spec.get('path', ''))
        entry = table.get(evaluate(spec['key'], rec, ctx)) if isinstance(table, dict) else None
        return entry.get(spec['get']) if entry is not None and 'get' in spec else entry
    if 'row_of' in t:
        spec = t['row_of']
        row = ctx.row(spec['list'], evaluate(spec['id'], rec, ctx))
        return None if row is None else row.get(spec['get']) if 'get' in spec else row
    if 'count_links' in t:
        spec = t['count_links']
        return sum(1 for r in ctx.rows.get(spec['list'], []) if rec['id'] in (r['values'].get(spec['field']) or []))
    if 'object' in t:
        made = {k: evaluate(v, rec, ctx) for k, v in t['object'].items()}
        return {k: v for k, v in made.items() if present(v)}
    if 'cut' in t:
        value = evaluate(t['cut']['of'], rec, ctx)
        return value[:t['cut']['max']] if isinstance(value, str) else None
    if 'joined' in t:
        value = evaluate(t['joined']['of'], rec, ctx)
        return t['joined'].get('sep', ', ').join(str(v) for v in value) if isinstance(value, list) else None
    if 'json' in t:
        value = evaluate(t['json'], rec, ctx)
        return None if value in EMPTY else json.dumps(value, ensure_ascii=False, separators=(',', ':'))
    if 'pairs' in t:
        spec = t['pairs']
        return [list_rows.fill(spec['template'], {'key': k, 'value': v}) for k, v in (evaluate(spec['of'], rec, ctx) or {}).items()]
    if 'slug' in t:
        return slug(str(evaluate(t['slug']['of'], rec, ctx) or ''), t['slug'].get('max', 80))
    if 'file_text' in t:
        spec = t['file_text']
        ref = evaluate(spec['file'], rec, ctx)
        if not present(ref):
            return None
        words = ctx.path_of(ref).read_text(encoding='utf-8')
        note = evaluate(spec.get('note'), rec, ctx)
        return f'> {note}\n\n{words}' if present(note) else words
    if 'ref_label' in t:
        spec = t['ref_label']
        ref = evaluate(spec['of'], rec, ctx)
        return spec['templates'].get(ref['root'], spec['default']).format_map(list_rows.Safe(ref))
    if 'require' in t:
        spec = t['require']
        value = evaluate(spec['of'], rec, ctx)
        if spec.get('texts') and (not isinstance(value, list) or not value or any(not isinstance(v, str) or not v for v in value)):
            raise ValueError(list_rows.fill(spec['error'], {k: v for k, v in rec.items() if not isinstance(v, (dict, list))}))
        return value
    if 'fail' in t:
        raise ValueError(list_rows.fill(t['fail'], {k: v for k, v in rec.items() if not isinstance(v, (dict, list))}))
    return list_rows.transform(t, rec, None, Path())


def list_rows_path(document: Any, path: str):
    for part in filter(None, path.split('.')):
        document = document[part]
    return document
