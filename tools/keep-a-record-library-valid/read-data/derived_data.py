"""Files derived from a library's sources, rebuilt by builders the library's schema declares.

A derived file is one that can always be regenerated from other files (a parsed table, a cross product of two lists, a folder
census, a database read, a spreadsheet form of a list). When it differs from what its sources generate, it is stale. Nothing here
names a record kind, a file or a column: each builder row in the schema's `builders` says where its source is, how a row is read
and how the output is written, and `rebuild` and `validate` do the same sums.

A builder row is `{ name, kind, output, format?, ... }` and its kind is one of:

  markdown-rows   Every row of a markdown table whose line starts with `row_prefix`, read by `row_regex` (named groups), under
                  the headings that start with `group_heading`. { source, group_heading, row_prefix, row_regex, id?, fields,
                  unreadable, document }
  cross-cards     One card for each name in a markdown table times each template row. { source, names, items_from, item_key,
                  templates, card, document }
  folder-table    One tab-separated row for each folder two levels below a root. { root, outputs, header, family_file, ... }
  sqlite-rows     The rows of one table of a database file the caller names, read-only. { input, table, fields, document }
  json-to-tsv     A list in a JSON file as tab-separated text. { source, path, columns }

`format` is `{ json: { indent, ensure_ascii, trailing_newline } }` for JSON outputs (default indent 1, ASCII escapes, no final
newline) or `{ tsv: { newline } }` for tabular ones (default CRLF). A document is an ordered object whose value is a literal or one
of `{ "from": "source_path" | "count" | "rows" | "names" | "lenses" | "database" | "missing" }` (text may hold `{count}`-style
placeholders from the same set).
"""
from __future__ import annotations

import csv
import io
import json
import os
import re
import subprocess
from pathlib import Path
from typing import Any

from library import Store, at_path, read_json


def tilde(path: Path) -> str:
    """The path with the home folder written as `~`, so a document names where a file was read without naming whose computer."""
    text, home = str(path), str(Path.home())
    return '~' + text[len(home):] if text.startswith(home) else text


def dumps(value: Any, fmt: dict) -> str:
    spec = {'indent': 1, 'ensure_ascii': True, 'trailing_newline': False, **fmt.get('json', {})}
    text = json.dumps(value, ensure_ascii=spec['ensure_ascii'], indent=spec['indent'])
    return text + '\n' if spec['trailing_newline'] else text


def tsv(header: list, rows: list[list], fmt: dict) -> str:
    out = io.StringIO()
    writer = csv.writer(out, delimiter='\t', lineterminator=fmt.get('tsv', {}).get('newline', '\r\n'))
    writer.writerow(header)
    writer.writerows(rows)
    return out.getvalue()


def document_of(template: dict, values: dict) -> dict:
    """An ordered document: `{ "from": name }` values come from `values`, text is filled from them, anything else is literal."""
    def fill(value: Any) -> Any:
        if isinstance(value, dict) and set(value) == {'from'}:
            return values[value['from']]
        if isinstance(value, str):
            return value.format_map({k: v for k, v in values.items() if isinstance(v, (str, int))})
        return value
    return {key: fill(value) for key, value in template.items()}


def sequential_id(spec: dict, number: int) -> str:
    return f'{spec["prefix"]}{number:0{spec["width"]}d}'


# ---------------------------------------------------------------------------- markdown rows

def read_field(spec: dict, match: re.Match, group: str | None) -> Any:
    """One output field of a row: a named group (cut by `split`, tidied by `replace`, read by `as`), the group heading, or a constant."""
    if spec.get('heading'):
        return group
    if 'const' in spec:
        return spec['const']
    value = match[spec['from']]
    if 'split' in spec:
        if not value:
            return []
        return [part.strip() for part in value.split(spec['split'])]
    for old, new in spec.get('replace', []):
        value = value.replace(old, new)
    if spec.get('as') == 'int':
        return int(value)
    return value


def markdown_rows(store: Store, builder: dict) -> tuple[list[dict], dict]:
    path = store.root / builder['source']
    text = path.read_text(encoding='utf-8')
    pattern = re.compile(builder['row_regex'])
    rows, bad, group = [], [], None
    for number, line in enumerate(text.splitlines(), 1):
        if line.startswith(builder['group_heading']):
            group = line[len(builder['group_heading']):].strip()
            continue
        if not line.startswith(builder['row_prefix']):
            continue
        match = pattern.match(line)
        if not match:
            bad.append(number)
            continue
        row = {}
        if 'id' in builder:
            row[builder['id']['field']] = sequential_id(builder['id'], len(rows) + 1)
        for field, spec in builder['fields'].items():
            row[field] = read_field(spec, match, group)
        rows.append(row)
    if bad:
        raise ValueError(f'{builder["unreadable"].format(lines=bad)}')
    return rows, {'source_path': str(path), 'count': len(rows), 'rows': rows}


def section_rows(text: str, section: str, pattern: str, group: int) -> list[str]:
    """The cell `group` of every row of a table in the section whose heading starts with `section`, in table order."""
    body = text.split(section, 1)[1].split('\n## ', 1)[0]
    found = []
    for line in body.splitlines():
        match = re.match(pattern, line)
        if match:
            found.append(match[group])
    return found


def cross_cards(store: Store, builder: dict, built: dict[str, list[dict]]) -> dict:
    text = (store.root / builder['source']).read_text(encoding='utf-8')
    names = section_rows(text, builder['names']['section'], builder['names']['row_regex'], builder['names']['group'])
    items = built[builder['items_from']]
    by_name = {item[builder['item_key']]: item for item in items}
    missing = [n for n in names if n not in by_name]
    lenses = at_path(store.file(builder['templates']['file']), builder['templates']['path'])
    cards = []
    for name in names:
        item = by_name.get(name)
        if not item:
            continue
        for lens in lenses:
            card = {}
            for field, spec in builder['card'].items():
                if 'id' in spec:
                    card[field] = sequential_id(spec['id'], len(cards) + 1)
                elif 'const' in spec:
                    card[field] = spec['const']
                elif 'item' in spec:
                    value = item[spec['item']]
                    card[field] = value[:spec['cut']] if 'cut' in spec else value
                else:
                    value = lens[spec['lens']]
                    if spec.get('fill'):
                        value = value.replace(spec['fill'], item[builder['item_key']])
                    card[field] = value
            cards.append(card)
    return {'names': len(names), 'lenses': len(lenses), 'count': len(cards), 'missing': missing, 'rows': cards}


# ---------------------------------------------------------------------------- folders, databases, lists

def folder_table(store: Store, builder: dict) -> tuple[list, list[list]]:
    root = store.root / builder['root']
    rows = []
    for owner in sorted(p for p in root.iterdir() if p.is_dir()):
        family = (owner / builder['family_file']).is_file()
        for item in sorted(p for p in owner.iterdir() if p.is_dir()):
            have = [(item / out['name']).is_dir() if out.get('dir') else (item / out['name']).is_file() for out in builder['outputs']]
            rows.append([f'{owner.name}/{item.name}', owner.name] + [str(h) for h in have] + [str(family), sum(have)])
    header = list(builder['header_start']) + [out['column'] for out in builder['outputs']] + list(builder['header_end'])
    return header, rows


def sqlite_rows(builder: dict, database: Path) -> dict:
    if not database.is_file():
        raise ValueError(f'Learnings database not found: {database}')
    fields = builder['fields']
    sql = f'SELECT {", ".join(fields)} FROM {builder["table"]} ORDER BY rowid'
    run = subprocess.run(['sqlite3', '-readonly', '-json', str(database), sql], capture_output=True, text=True, check=True)
    rows = [{k: r.get(k) for k in fields} for r in json.loads(run.stdout or '[]')]
    return {'database': tilde(database), 'count': len(rows), 'rows': rows}


def json_to_tsv(store: Store, builder: dict, fmt: dict) -> str:
    records = at_path(store.file(builder['source']), builder['path'])
    columns = [c if isinstance(c, dict) else {'name': c} for c in builder['columns']]
    return tsv([c['name'] for c in columns],
               [[r[c['name']] if 'default' not in c else r.get(c['name'], c['default']) for c in columns] for r in records], fmt)


# ---------------------------------------------------------------------------- build all

def build_all(store: Store, inputs: dict[str, Path]) -> tuple[dict[str, str], list[str]]:
    """Relative output path -> new content for every builder, and the builders left out because an input they read was not given."""
    built_rows: dict[str, list[dict]] = {}
    out: dict[str, str] = {}
    not_checked: list[str] = []
    for builder in store.schema.get('builders', []):
        fmt, kind = builder.get('format', {}), builder['kind']
        if kind == 'markdown-rows':
            rows, values = markdown_rows(store, builder)
            built_rows[builder['name']] = rows
            out[builder['output']] = dumps(document_of(builder['document'], values), fmt)
        elif kind == 'cross-cards':
            values = cross_cards(store, builder, built_rows)
            out[builder['output']] = dumps(document_of(builder['document'], values), fmt)
        elif kind == 'folder-table':
            header, rows = folder_table(store, builder)
            out[builder['output']] = tsv(header, rows, fmt)
        elif kind == 'sqlite-rows':
            if builder['input'] not in inputs:
                not_checked.append(builder['output'])
                continue
            out[builder['output']] = dumps(document_of(builder['document'], sqlite_rows(builder, inputs[builder['input']])), fmt)
        elif kind == 'json-to-tsv':
            out[builder['output']] = json_to_tsv(store, builder, fmt)
        else:
            raise ValueError(f'builder {builder["name"]}: kind {kind} is not one of markdown-rows, cross-cards, folder-table, sqlite-rows, json-to-tsv')
    return out, not_checked


def stale(store: Store, built: dict[str, str]) -> list[str]:
    """Output paths whose bytes differ from a fresh build (empty list = current)."""
    return [name for name, text in built.items()
            if not (store.root / name).is_file() or (store.root / name).read_bytes() != text.encode('utf-8')]


def write_all(base: Path, built: dict[str, str]) -> None:
    """Write each output under `base`, by its own relative path, replacing any earlier file atomically."""
    for name, text in built.items():
        target = base / name
        target.parent.mkdir(parents=True, exist_ok=True)
        tmp = target.with_name(target.name + '.tmp')
        tmp.write_bytes(text.encode('utf-8'))
        os.replace(tmp, target)
