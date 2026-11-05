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

Over lists and the rows other sources made (`item` and `index` name the item being worked on; `row` the other row, its record
with its values over it):
  {"map": {"of": T, "do": T}}            `do` for each item of the list, dropping empty results
  {"filter": {"of": T, "where": C}}      the items for which C holds
  {"where": {"list": L, "if": C, "get": "field"}}
                                         the ids (or `get` fields) of the rows of list L made so far for which C holds
  {"flat": T}                            a list of lists as one list
  {"first": T} {"last": T} {"sorted": T} {"length": T}
Over text and numbers:
  {"plain": T}                           lower case, curly quotes made straight, runs of white space one space, trimmed
  {"squash": T}                          runs of white space one space, trimmed
  {"resplit": {"of": T, "pattern": re}}  the parts of a text between matches of the regular expression
  {"regex_all": {"of": T, "pattern": re, "group": 1}}
                                         that group of every match
  {"regex_table": {"of": T, "pattern": re, "key": 1, "value": 2}}
                                         an object of every match's key group and (trimmed) value group
  {"fit": {"of": T, "max": N, "note": T ("... {whole} ... {max}"), "whole": T, "step": 250}}
                                         the text, or, when its JSON text is longer than N UTF-16 units (as a JavaScript service
                                         counts it), its start cut on steps of `step` with the note after it
  {"to_number": T} {"plus": [T, T]} {"minus": [T, T]} {"round": {"of": T, "digits": 1}} (half up) {"thousands": T} (1,234.5)
  {"replace": {"of": T, "pattern": re, "with": "text", "count": N}}  every match (or the first N) replaced
  {"let": {"names": {"name": T, ...}, "in": T}}  `in` with those values added to the record, each reading the ones before it
  {"day": T}                             the UTC day (YYYY-MM-DD) of an ISO 8601 or mail-style (Wed Sep 02 14:30:00 +0000 2026) time
  {"uri": T}                             the text escaped as a URI component
  {"number_text": T}                     a number as a JavaScript service writes it (0.0 is "0", 8.38 is "8.38"); other values as text
Over files (`ref` is a file reference):
  {"read_json": {"file": T, "at": "dotted"}}
                                         the JSON file the reference names, or the value at `at` in it
  {"first_existing": {"root": R, "paths": T}}
                                         a reference to the first of the paths under root R that is a file
  {"strings_at": {"of": T, "at": "a.*.b"}}
                                         every text at that path, `*` standing for each item of a list
  {"line_of": {"file": T, "line": T}}    the text of that line (from 1); empty past the end
  {"text_between": {"file": T, "after": re, "start": T, "end": T, "with_start": true}}
                                         { text, from_line, to_line }: the trimmed lines after (or from) the first line matching `start`
                                         below the first matching `after`, up to
                                         the next line matching `end` or the end of the file
  {"path_text": T}                       the reference as a path on this computer
Conditions also take {"less": [T, T]} (numbers), {"starts_with": [T, T]}, {"contains": [T, T]} (text or list), {"in": [T, T]}
(the first in the second) and {"exists": T} (a file reference that is there).

A file reference is { "root": name, "path": "relative path" }; `root` is one of the folders the run was given by name.
"""
from __future__ import annotations

import json
import math
import os
import re
import subprocess
from datetime import datetime, timezone
from pathlib import Path
from typing import Any
from urllib.parse import quote

import list_rows

EMPTY = (None, '', [])


class Context:
    """What expressions can reach beyond the record: the named folders, the rows made so far, and files read once."""

    def __init__(self, roots: dict[str, Path], documents: dict[str, Any] | None = None):
        self.roots = roots
        self.documents = documents or {}
        self.rows: dict[str, list[dict]] = {}
        self.recs: dict[str, list[dict]] = {}
        self._json: dict[Path, Any] = {}

    def path_of(self, ref: dict) -> Path:
        if ref['root'] not in self.roots:
            raise ValueError(f'No folder was given for root {ref["root"]}: give --root {ref["root"]}=DIR.')
        return self.roots[ref['root']] / ref['path']

    def json(self, ref: dict) -> Any:
        """A JSON file, or, when the root names a document the run holds (such as `mapping`), the value at the dotted `path` in it."""
        if ref['root'] in self.documents:
            return dig(self.documents[ref['root']], ref['path']) if ref['path'] else self.documents[ref['root']]
        path = self.path_of(ref)
        if path not in self._json:
            self._json[path] = json.loads(path.read_text(encoding='utf-8'))
        return self._json[path]

    def row(self, list_id: str, row_id: str) -> dict | None:
        """The record a row of the list is made from: one read from a file, or one a source has already made a row of."""
        found = next((r for r in self.recs.get(list_id, []) if r['id'] == row_id), None)
        if found is None:
            made = next((r for r in self.rows.get(list_id, []) if r['id'] == row_id), None)
            found = None if made is None else made['rec']
        return found

    def made_rows(self, list_id: str) -> list[dict]:
        """Each row a source has made so far for the list, as its record with its values over it (`where` reads either)."""
        return [{**r['rec'], **r['values'], 'id': r['id']} for r in self.rows.get(list_id, [])]


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
    if kind in ('less', 'starts_with', 'contains', 'in'):
        a, b = evaluate(arg[0], rec, ctx), evaluate(arg[1], rec, ctx)
        if kind == 'less':
            return isinstance(a, (int, float)) and isinstance(b, (int, float)) and a < b
        if kind == 'starts_with':
            return isinstance(a, str) and isinstance(b, str) and a.startswith(b)
        if kind == 'contains':
            return isinstance(a, (str, list)) and b is not None and b in a
        return isinstance(b, (list, str)) and a is not None and a in b
    if kind == 'exists':
        ref = evaluate(arg, rec, ctx)
        return isinstance(ref, dict) and ctx.path_of(ref).exists()
    raise ValueError(f'condition {json.dumps(c)} is not one of set, empty, not, all, any, equals, matches, less, starts_with, '
                     'contains, in, exists')


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
        result = subprocess.run([os.environ.get('TRILLION_NODE', 'node'), str(bridge)],
                                input=value.encode('utf-8'), capture_output=True, check=False)
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
    for name, work in WORKS.items():
        if name in t:
            return work(t[name], rec, ctx)
    return list_rows.transform(t, rec, None, Path())


# ---- Expressions over lists, other rows, other files and text ------------------------------------------------------------

def each_item(spec: dict, rec: dict, ctx: Context):
    """(record with `item` and `index`, item) for each item of the list `of` gives."""
    value = evaluate(spec['of'], rec, ctx)
    for index, item in enumerate(value if isinstance(value, list) else []):
        yield {**rec, 'item': item, 'index': index}, item


def work_map(spec, rec, ctx):
    return [v for inner, _ in each_item(spec, rec, ctx) if present(v := evaluate(spec['do'], inner, ctx))]


def work_filter(spec, rec, ctx):
    return [item for inner, item in each_item(spec, rec, ctx) if holds(spec['where'], inner, ctx)]


def work_where(spec, rec, ctx):
    """The ids (or `get` fields) of the rows of `list` already made for which `if` holds; `row` is the row there."""
    found = [row.get(spec.get('get', 'id')) for row in ctx.made_rows(spec['list']) if holds(spec['if'], {**rec, 'row': row}, ctx)]
    return [v for v in found if present(v)]


def work_flat(t, rec, ctx):
    value = evaluate(t, rec, ctx)
    if not isinstance(value, list):
        return value
    return [x for v in value for x in (v if isinstance(v, list) else [v])]


PLAIN_QUOTES = str.maketrans({'‘': "'", '’': "'", '“': '"', '”': '"'})


def work_plain(t, rec, ctx):
    value = evaluate(t, rec, ctx)
    return re.sub(r'\s+', ' ', value.lower().translate(PLAIN_QUOTES)).strip() if isinstance(value, str) else None


def work_squash(t, rec, ctx):
    value = evaluate(t, rec, ctx)
    return re.sub(r'\s+', ' ', value).strip() if isinstance(value, str) else None


def work_read_json(spec, rec, ctx):
    ref = evaluate(spec['file'], rec, ctx)
    if not isinstance(ref, dict):
        return None
    return dig(ctx.json(ref), spec['at']) if spec.get('at') else ctx.json(ref)


def work_first_existing(spec, rec, ctx):
    paths = evaluate(spec['paths'], rec, ctx)
    for path in (paths if isinstance(paths, list) else [paths]):
        ref = {'root': spec['root'], 'path': path}
        if isinstance(path, str) and ctx.path_of(ref).is_file():
            return ref
    return None


def strings_at(value, parts: list[str]) -> list[str]:
    if not parts:
        return [value] if isinstance(value, str) else []
    head, rest = parts[0], parts[1:]
    if head == '*':
        return [s for v in (value if isinstance(value, list) else []) for s in strings_at(v, rest)]
    return strings_at(value.get(head), rest) if isinstance(value, dict) else []


def work_strings_at(spec, rec, ctx):
    return strings_at(evaluate(spec['of'], rec, ctx), spec['at'].split('.'))


def file_lines(ref: dict, ctx: Context) -> list[str]:
    return ctx.path_of(ref).read_text(encoding='utf-8').split('\n')


def work_line_of(spec, rec, ctx):
    ref, line = evaluate(spec['file'], rec, ctx), evaluate(spec['line'], rec, ctx)
    if not isinstance(ref, dict) or not isinstance(line, int):
        return None
    lines = file_lines(ref, ctx)
    return lines[line - 1] if 0 < line <= len(lines) else ''


def work_text_between(spec, rec, ctx):
    """{ text, from_line, to_line }: the lines after the first line matching `start` (with it when `with_start`), up to the next
    line matching `end` (or the end of the file), trimmed; the line numbers count from 1. With `after`, `start` is looked for only
    below the first line matching it. `start` and `end` may be expressions. Nothing when no line matches `start`."""
    ref = evaluate(spec['file'], rec, ctx)
    if not isinstance(ref, dict):
        return None
    lines = file_lines(ref, ctx)
    first = 0
    if 'after' in spec:
        found = next((n for n, line in enumerate(lines) if re.search(spec['after'], line)), None)
        if found is None:
            return None
        first = found + 1
    start_at, end_at = evaluate(spec['start'], rec, ctx), evaluate(spec['end'], rec, ctx)
    start = next((n for n, line in enumerate(lines) if n >= first and re.search(start_at, line)), None)
    if start is None:
        return None
    end = next((n for n, line in enumerate(lines) if n > start and re.search(end_at, line)), None)
    begin = start if spec.get('with_start') else start + 1
    return {'text': '\n'.join(lines[begin:end]).strip(), 'from_line': begin + 1, 'to_line': len(lines) if end is None else end}


def work_let(spec, rec, ctx):
    """`in` worked out with the values `names` gives added to the record, each able to read the ones before it."""
    inner = dict(rec)
    for name, expr in spec['names'].items():
        inner[name] = evaluate(expr, inner, ctx)
    return evaluate(spec['in'], inner, ctx)


def work_replace(spec, rec, ctx):
    value = evaluate(spec['of'], rec, ctx)
    return re.sub(spec['pattern'], spec.get('with', ''), value, count=spec.get('count', 0)) if isinstance(value, str) else None


def work_plus(args, rec, ctx):
    a, b = (number_of(evaluate(x, rec, ctx)) for x in args)
    return None if a is None or b is None else whole(a + b)


def work_regex_table(spec, rec, ctx):
    value = evaluate(spec['of'], rec, ctx)
    if not isinstance(value, str):
        return None
    return {m.group(spec.get('key', 1)): m.group(spec.get('value', 2)).strip() for m in re.finditer(spec['pattern'], value)}


def work_regex_all(spec, rec, ctx):
    value = evaluate(spec['of'], rec, ctx)
    return [m.group(spec.get('group', 1)) for m in re.finditer(spec['pattern'], value)] if isinstance(value, str) else []


def work_resplit(spec, rec, ctx):
    value = evaluate(spec['of'], rec, ctx)
    return re.split(spec['pattern'], value) if isinstance(value, str) else None


def utf16_length(text: str) -> int:
    return len(text.encode('utf-16-le')) // 2


def json_length(value) -> int:
    """How a JavaScript service counts a value: the length of its JSON text, in UTF-16 units."""
    return utf16_length(json.dumps(value, ensure_ascii=False))


def work_fit(spec, rec, ctx):
    """The text, or when its JSON text is longer than `max` its start cut on a step of `step` characters, with the note after it."""
    words = evaluate(spec['of'], rec, ctx)
    if not isinstance(words, str) or json_length(words) <= spec['max']:
        return words
    note = str(evaluate(spec['note'], rec, ctx) or '').format_map(list_rows.Safe({'whole': evaluate(spec.get('whole'), rec, ctx) or '', 'max': thousands(spec['max'])}))
    keep = spec['max']
    while json_length(words[:keep] + note) > spec['max']:
        keep -= spec.get('step', 250)
    return words[:keep] + note


def number_of(value):
    if isinstance(value, bool):
        return None
    if isinstance(value, (int, float)):
        return value
    return list_rows.to_num(value) if isinstance(value, str) and value.strip() else None


def work_to_number(t, rec, ctx):
    return number_of(evaluate(t, rec, ctx))


def whole(value):
    return int(value) if isinstance(value, float) and value.is_integer() else value


def work_minus(args, rec, ctx):
    a, b = (number_of(evaluate(x, rec, ctx)) for x in args)
    return None if a is None or b is None else whole(a - b)


def work_round(spec, rec, ctx):
    """Rounded half up to `digits` places, as JavaScript's Math.round does."""
    value = number_of(evaluate(spec['of'], rec, ctx))
    if value is None:
        return None
    scale = 10 ** spec.get('digits', 0)
    return whole(math.floor(value * scale + 0.5) / scale)


def thousands(value) -> str:
    """A number as en-US text: thousands commas and at most three decimals."""
    text = f'{value:,.3f}'.rstrip('0').rstrip('.') if isinstance(value, float) else f'{value:,}'
    return text


def work_thousands(t, rec, ctx):
    value = number_of(evaluate(t, rec, ctx))
    return None if value is None else thousands(whole(value))


def work_day(t, rec, ctx):
    """The UTC calendar day (YYYY-MM-DD) of a time given as ISO 8601 or as a mail-style date (Wed Sep 02 14:30:00 +0000 2026)."""
    value = evaluate(t, rec, ctx)
    if not isinstance(value, str) or not value.strip():
        return None
    for read in (lambda v: datetime.fromisoformat(v.replace('Z', '+00:00')),
                 lambda v: datetime.strptime(v, '%a %b %d %H:%M:%S %z %Y')):
        try:
            moment = read(value.strip())
        except ValueError:
            continue
        return (moment.astimezone(timezone.utc) if moment.tzinfo else moment).date().isoformat()
    return None


def work_length(t, rec, ctx):
    value = evaluate(t, rec, ctx)
    return len(value) if isinstance(value, (list, str, dict)) else None


def work_first(t, rec, ctx):
    value = evaluate(t, rec, ctx)
    return value[0] if isinstance(value, list) and value else None


def work_last(t, rec, ctx):
    value = evaluate(t, rec, ctx)
    return value[-1] if isinstance(value, list) and value else None


def work_sorted(t, rec, ctx):
    value = evaluate(t, rec, ctx)
    return sorted(value) if isinstance(value, list) else None


def work_uri(t, rec, ctx):
    value = evaluate(t, rec, ctx)
    return quote(str(value), safe="-_.!~*'()") if present(value) else None


def work_number_text(t, rec, ctx):
    value = evaluate(t, rec, ctx)
    if isinstance(value, bool) or value is None:
        return None if value is None else ('true' if value else 'false')
    if isinstance(value, float):
        return str(int(value)) if value.is_integer() else repr(value)
    return str(value)


def work_path_text(t, rec, ctx):
    ref = evaluate(t, rec, ctx)
    return str(ctx.path_of(ref)) if isinstance(ref, dict) else None


WORKS = {
    'map': work_map, 'filter': work_filter, 'where': work_where, 'flat': work_flat, 'plain': work_plain, 'squash': work_squash,
    'read_json': work_read_json, 'first_existing': work_first_existing, 'strings_at': work_strings_at, 'line_of': work_line_of,
    'text_between': work_text_between, 'regex_table': work_regex_table, 'regex_all': work_regex_all, 'resplit': work_resplit,
    'fit': work_fit, 'to_number': work_to_number, 'minus': work_minus, 'round': work_round, 'thousands': work_thousands,
    'day': work_day, 'length': work_length, 'first': work_first, 'last': work_last, 'sorted': work_sorted, 'uri': work_uri,
    'path_text': work_path_text, 'let': work_let, 'replace': work_replace, 'plus': work_plus, 'number_text': work_number_text,
}


def list_rows_path(document: Any, path: str):
    for part in filter(None, path.split('.')):
        document = document[part]
    return document
