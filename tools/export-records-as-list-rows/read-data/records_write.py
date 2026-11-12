"""Records on disk to the { id, type, value } records a Trillion `records:write` takes, by a mapping the person gives.

Nothing about any record kind is known here: the lists, their fields and saved views are the person's list-definition rows
(`lists_file`), and where each row comes from and how its values and their bases are worked out is the mapping's. The output is
a payload of commands, at most `limits.per_command` records and `limits.command_bytes` bytes each, to send in order. Nothing is sent.

A mapping:

  lists_file        REF of a JSON file { "lists": [{ id, value }], "views": [{ list, order, view }] }; `value.row_type` names a
                    list's rows' type, `value.fields` its columns
  lists_read        instead of lists_file: { config: REF, ids: [list ids] }: the person's own list records, read through the door
                    with the sender config; then only a list `lists_add` changes is written, and the saved views are `views`
  lists_add         { list id: { fields: [field], choices: { field: [choices] }, set: { key: value } } }: a field a list lacks is
                    added, a field it holds takes the keys given, a choice field gains the choices it lacks, `set` gives top-level keys
  views             with lists_read: [{ list, order, view }], the saved views written
  ids               how record ids read; defaults: list "list:{id}", view "list-view:{list}:{view_id}", view_type "list-view",
                    row "record:{row_type}:{id}", row_type "record:{row_type}"
  limits            { text_chars, basis_sources, per_command, command_bytes }: a field named in a source's `fits` may not be
                    longer than text_chars; a basis names at most basis_sources sources; a command holds at most per_command
                    records and at most command_bytes bytes of records (UTF-8 JSON; a service may take only so many bytes in
                    one request); one record bigger than command_bytes is refused by its id
  by, confidence    what a basis says made it and how sure it is
  at                an expression over a row's record: the time its basis says it was made (for example the staged file's
                    `_generated`), so building the same files again gives the same records; without it, the time of the build
  payload_note      the `_what` of the payload
  emit              list ids in the order their rows are written (default: the order of the definitions)
  emit_definitions  boolean (default true): false uses lists_file as a schema snapshot without writing list/view definitions
  breakdown         { list, field, staged_sources }: the payload counts, for each value of a link field, the rows made from the
                    named sources and all rows
  checks            [{ "links_resolve": { list, field, into, error } }]: every id in a row's field is the id of a row of `into`
  sources           [source], worked through in order (`kind` rows first read, then `staged` made, then `rows` built)

A source makes the rows of one list (`list`). Its `kind` is:
  rows              records already in a JSON file: { file: REF, path: "dotted.path" }; each is a record with an `id`
  records           records read from a person's Trillion door: { type, prefix?, config: REF }; the builder verifies every
                    returned record is of that declared type and id prefix before mapping it; `config` names the sender config
                    (its credential is a keychain handle, never a secret value); optional `each` is a dotted path to an array
                    in the record, with one mapped row per element (`record` and `item` are available to expressions)
  staged            rows read from files, one `inputs` entry per file or glob; `defaults` is merged under each entry
  again             { again: { list } }: each row another source already made of that list, its record with its values over it,
                    worked out again (for example its links to rows made after it) and merged by `on_duplicate` (fill or over)
A staged or again source's `skip_if` (a condition over a row's record and values) leaves that row out.

Per source: `id` (an expression), `keys`, `compute` (then `compute_after`, which every input shares), `values` (`keep_empty`: fields
kept when their text or list/object value is empty), `basis`, `fits`, `on_duplicate`. Without `on_duplicate`, a row whose id another row of the list already
has is refused (choosing silently would drop one). `fill`: the row already made keeps its values and takes only the fields (and bases) it
lacks from this one; `over`: this row's values win and the row already made fills the fields it lacks. Either way the two are one row,
and the payload's `merged` names each one with the fields filled and the fields whose two values differed (the value not kept). Per `staged` input (a source may also give `inputs_from`: { file, path, rename } to read the entries from a file, with those keys
renamed to the ones below; `link`: { field, into } names the field an optional input's rows link by; `file_label` is the expression
that names an input for `pending`):
  root, path | paths    the file REF (paths are globs inside root); JSON ({ rows } or the rows themselves) or JSON lines; the
                        root `mapping` is the mapping itself, and `path` the dotted path of its rows there
  format                by the file's ending (json, jsonl, tsv) or given: `tree` (a JSON document whose nodes and scopes are kept
                        as alternating [id, object, id, object] lists; `tree` says which, see tree_rows: one row per node
                        reached from a scope's roots and holding `keep_when_present`, with `_scope`, `_space`, `_root` and
                        `_folder` (the titles of its ancestors); each node is reached once; the file's mtime is its `_generated`),
                        `tsv` (a header line; a line with another number of
                        cells is not a row; a quote mark is part of its cell), `text` (the file is one row { text }), `lines`
                        ({ pattern, start, end, carry, needs_carry, cells }: one row per line matching `pattern`, its named groups
                        and `line`, `text`, after the first line matching `start` and before the next matching `end`; the named
                        groups of a line matching one of `carry` go on every later row, and `needs_carry` waits for them all;
                        `cells` adds the line's markdown table cells)
  one_row               a JSON file is one row
  each                  a dotted path: one row per item of that list in each row, with `_parent` (the row) and `_index`
  optional              reported under `pending` while the file is missing or names a link target with no row
  rows_at               key holding the rows in a JSON object (default "rows"); `flatten`: spread a row's object of that name
  keep                  { field: value }: only rows whose fields equal these
  fields                { list field: staged field }: the staged rows are in another shape; `carry` names staged fields kept as they are
  id_from               { prefix, slug_of }: an id made as prefix:file name:slug of a field, for rows with none; `kind`: every row's kind
  alias                 { field: staged field }: a field copied from another (when no `fields` is given)
  divert_when           {field: value}: rows that are not rows of this list but notes about one; the source's `divert` = { report_as, fields:
                        {name: expression}, exists_in: {list, id, as} } says how each is reported
  compute               this input's own `compute`, replacing the source's; `staged: false` keeps its rows out of the breakdown
  anything else         left for expressions to read as input.<name>
A row's record holds its fields, `raw` (the staged row), `input`, `_file`, `_generated` and `_about` (the file's `source` block).
`keys` are worked out first from that record; where a link field's target has no row yet and the file names one, `parent_rows`
makes it: { list, field, from: "_about", when: condition, id: expression, rec: {...expression values} }. `compute` then adds fields
in order, `values` makes the row's values (a map of expressions; an empty result leaves the field out; the key "..." merges an
object), and `basis[field]` = { reasoning, sources, confidence? } makes `_basis[field]` (no reasoning, no basis; `confidence`, when given, says how sure this one is instead of the mapping's).
"""
from __future__ import annotations

import glob
import re
import json
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

import expressions
from expressions import Context, evaluate, holds, present

ID_DEFAULTS = {'list': 'list:{id}', 'view': 'list-view:{list}:{view_id}', 'view_type': 'list-view',
               'row': 'record:{row_type}:{id}', 'row_type': 'record:{row_type}'}
LIMIT_DEFAULTS = {'text_chars': 20000, 'basis_sources': 10, 'per_command': 64}


def read_staged(ctx: Context, entry: dict) -> list[dict]:
    """Every row of the entry's files with where it was read from."""
    if 'path' in entry:
        paths = [entry['path']]
    else:
        root = ctx.path_of({'root': entry['root'], 'path': ''})
        paths = [str(Path(p).relative_to(root)) for pattern in entry['paths'] for p in sorted(glob.glob(str(root / pattern)))]
    items = []
    for path in paths:
        ref = {'root': entry['root'], 'path': path}
        held = entry['root'] in ctx.documents
        text = '' if held else ctx.path_of(ref).read_text(encoding='utf-8')
        kind = entry.get('format') or ('jsonl' if path.endswith('.jsonl') else 'tsv' if path.endswith('.tsv') else 'json')
        kept = None
        if held:
            rows = ctx.json(ref)
        elif kind == 'jsonl':
            rows = [json.loads(line) for line in text.split('\n') if line.strip()]
        elif kind == 'tsv':
            rows = tsv_rows(text)
        elif kind == 'lines':
            rows = line_rows(text, entry)
        elif kind == 'text':
            rows = [{'text': text}]
        elif kind == 'tree':
            rows = tree_rows(json.loads(text), entry['tree'])
        elif kind == 'json':
            kept = json.loads(text)
            rows = [kept] if entry.get('one_row') else kept if isinstance(kept, list) else kept.get(entry.get('rows_at', 'rows'))
        else:
            raise ValueError(f'{ref_text(ref)}: format {kind} is not one of json, jsonl, tsv, lines, text, tree.')
        if not isinstance(rows, list):
            raise ValueError(f'{ref_text(ref)} holds no rows.')
        if 'each' in entry:
            rows = [{**(item if isinstance(item, dict) else {'value': item}), '_parent': row, '_index': index}
                    for row in rows for index, item in enumerate(expressions.dig(row, entry['each']) or [])]
        meta = kept if isinstance(kept, dict) else {}
        about = meta.get('source') if meta else None
        generated = meta.get('generated') or (meta.get('meta') or {}).get('generated') or entry.get('generated_default')
        if kind == 'tree':
            generated = datetime.fromtimestamp(ctx.path_of(ref).stat().st_mtime, tz=timezone.utc).isoformat(timespec='milliseconds')
        items += [{'raw': row, 'ref': ref, 'about': about, 'generated': generated} for row in rows]
    return items


def tsv_rows(text: str) -> list[dict]:
    """One row per line of a tab-separated text with a header line; a line with another number of cells is not a row, and a quote
    mark is part of a cell, never the start of a quoted one."""
    header, *lines = text.split('\n')
    columns = header.split('\t')
    return [dict(zip(columns, cells)) for cells in (line.split('\t') for line in lines) if len(cells) == len(columns)]


def table_cells(line: str) -> list[str]:
    """The cells of a markdown table line; an escaped bar (\\|) stays in its cell."""
    return [cell.strip().replace('\0', '|') for cell in line.replace('\\|', '\0').split('|')[1:-1]]


def line_rows(text: str, entry: dict) -> list[dict]:
    """One row per line matching `pattern` (its named groups are the fields, `line` its number from 1, `text` the line), after the
    first line matching `start` and before the next matching `end`. A line matching one of `carry` gives its named groups to every
    later row; with `needs_carry` a row comes only once every carry group has a value. `cells` adds the line's table cells."""
    started = 'start' not in entry
    carried: dict = {}
    carry_names = {name for pattern in entry.get('carry', []) for name in re.compile(pattern).groupindex}
    rows = []
    for number, line in enumerate(text.split('\n'), 1):
        if not started:
            started = re.search(entry['start'], line) is not None
            continue
        if 'end' in entry and re.search(entry['end'], line):
            break
        for pattern in entry.get('carry', []):
            match = re.search(pattern, line)
            if match:
                carried.update(match.groupdict())
        match = re.search(entry['pattern'], line)
        if not match or (entry.get('needs_carry') and any(carried.get(name) is None for name in carry_names)):
            continue
        row = {**carried, **match.groupdict(), 'line': number, 'text': line}
        if entry.get('cells'):
            row['cells'] = table_cells(line)
        rows.append(row)
    return rows


def pairs_of(value: list) -> list[tuple]:
    """An alternating [key, value, key, value] list as its (key, value) pairs, in order."""
    return [(value[i], value[i + 1]) for i in range(0, len(value) - 1, 2)]


def tree_rows(document: Any, spec: dict) -> list[dict]:
    """The nodes a tree reaches from its scopes' roots, read from a document that keeps its nodes and scopes as alternating
    [id, object] lists. The spec names: `containers` (dotted path of the list of containers), `nodes_key` and `scopes_key` (the key
    in each container of its nodes and of its scopes), `scope_where` ({ dotted path: value } every scope must hold), `scope_present`
    (dotted paths every scope must give), `roots` { select: the key of a scope's id list, markers: the entries of that list that
    say the root id after them }, `children` (the key of a node's child ids) and `keep_when_present` (the dotted path a node must
    give to be a row). A node is reached once, by the first root that reaches it."""
    markers = set(spec['roots']['markers'])
    rows: list[dict] = []
    for container in expressions.dig(document, spec['containers']) or []:
        nodes = dict(pairs_of(container.get(spec['nodes_key']) or []))
        for scope_id, scope in pairs_of(container.get(spec['scopes_key']) or []):
            if not all(expressions.dig(scope, path) == value for path, value in spec.get('scope_where', {}).items()):
                continue
            if not all(expressions.present(expressions.dig(scope, path)) for path in spec.get('scope_present', [])):
                continue
            listed = scope.get(spec['roots']['select']) or []
            roots = [(listed[i], listed[i + 1]) for i in range(0, len(listed) - 1, 2) if listed[i] in markers]
            stack = [(root_id, marker, []) for marker, root_id in reversed(roots)]
            seen: set = set()
            while stack:
                node_id, marker, ancestors = stack.pop()
                node = nodes.get(node_id)
                if node_id in seen or not isinstance(node, dict):
                    continue
                seen.add(node_id)
                if expressions.present(expressions.dig(node, spec['keep_when_present'])):
                    rows.append({**node, '_scope': scope_id, '_space': scope.get('title'), '_root': marker, '_folder': ancestors})
                below = ancestors + ([node['title']] if expressions.present(node.get('title')) else [])
                stack.extend((child, marker, below) for child in reversed(node.get(spec['children']) or []))
    return rows


def ref_text(ref: dict) -> str:
    return f'{ref["root"]} {ref["path"]}'


def shape(entry: dict, item: dict) -> dict:
    """The staged row in the list's own field names."""
    raw = item['raw']
    if 'fields' not in entry:
        flat = {**raw, **(raw.get(entry['flatten']) or {})} if entry.get('flatten') else dict(raw)
        return {**flat, **{field: flat.get(from_field) for field, from_field in entry.get('alias', {}).items()}}
    shaped = {field: ', '.join(raw[from_field]) if isinstance(raw.get(from_field), list) else raw.get(from_field)
              for field, from_field in entry['fields'].items()}
    for field in entry.get('carry', []):
        shaped[field] = raw.get(field)
    if 'id_from' in entry:
        stem = Path(item['ref']['path']).name
        stem = stem[:stem.rfind('.')] if '.' in stem else stem
        made = f'{entry["id_from"]["prefix"]}:{stem}:{expressions.slug(str(raw.get(entry["id_from"]["slug_of"]) or ""), 80)}'
        shaped['id'] = raw.get('id') or raw.get('row_id') or made
    shaped['kind'] = entry.get('kind') or raw.get('kind')
    return shaped


def matches(row: dict, wanted: dict) -> bool:
    return all(row.get(k) == v for k, v in wanted.items())


def build_values(source: dict, rec: dict, ctx: Context, limits: dict) -> dict:
    values: dict = {}
    for field, expr in source['values'].items():
        value = evaluate(expr, rec, ctx)
        if field == '...':
            values.update(value or {})
        elif present(value) or (field in source.get('keep_empty', []) and value in ('', [], {})):
            values[field] = value
    for field in source.get('fits', []):
        if field in values and len(json.dumps(values[field], ensure_ascii=False)) > limits['text_chars']:
            raise ValueError(f'{rec.get("id")} {field} is longer than {limits["text_chars"]} characters.')
    return values


def build_basis(source: dict, rec: dict, ctx: Context, state: dict) -> dict:
    limits = state['limits']
    at = (evaluate(state['at_of'], rec, ctx) if state['at_of'] is not None else None) or state['at']
    basis = {}
    for field, spec in source.get('basis', {}).items():
        reasoning = evaluate(spec['reasoning'], rec, ctx)
        if not present(reasoning):
            continue
        sources = evaluate(spec['sources'], rec, ctx) or []
        if len(sources) > limits['basis_sources']:
            raise ValueError(f'A basis names at most {limits["basis_sources"]} sources.')
        confidence = evaluate(spec['confidence'], rec, ctx) if 'confidence' in spec else state['confidence']
        basis[field] = {'confidence': confidence, 'reasoning': reasoning, 'sources': sources, 'by': state['by'], 'at': at}
    return basis


def make_row(source: dict, compute: dict, rec: dict, ctx: Context, state: dict) -> dict:
    for field, expr in {**compute, **source.get('compute_after', {})}.items():
        rec[field] = evaluate(expr, rec, ctx)
    values = build_values(source, rec, ctx, state['limits'])
    return {'id': rec['id'], 'rec': rec, 'values': values, 'basis': build_basis(source, rec, ctx, state)}


DUPLICATE_POLICIES = ('fill', 'over')


def add_row(source: dict, rows: list[dict], row: dict, state: dict) -> dict:
    """Put a made row into its list. A row whose id the list already holds is merged by the source's `on_duplicate` (`fill`: the
    row already there keeps its values and takes the fields it lacks; `over`: this row's values win and the one there fills the
    gaps), and the merge is reported; without a policy both are kept, and check_rows refuses the pair by id."""
    policy = source.get('on_duplicate')
    if policy is not None and policy not in DUPLICATE_POLICIES:
        raise ValueError(f'on_duplicate is one of {", ".join(DUPLICATE_POLICIES)}, not {policy!r}.')
    there = next((r for r in rows if r['id'] == row['id']), None) if policy else None
    if there is None:
        rows.append(row)
        return row
    first, second = (there, row) if policy == 'fill' else (row, there)
    filled = sorted(f for f in second['values'] if f not in first['values'])
    differing = {f: v for f, v in sorted(second['values'].items()) if f in first['values'] and first['values'][f] != v}
    there['values'] = {**second['values'], **first['values']}
    there['basis'] = {**second['basis'], **first['basis']}
    there['rec'] = {**second['rec'], **first['rec']}
    state['merged'].append({'list': source['list'], 'id': row['id'], 'source': source.get('name', source['list']), 'kept': policy,
                            'filled': filled, 'differing': differing})
    return there


def commands_of(records: list[dict], limits: dict) -> list[dict]:
    """The records in order, in commands whose compact UTF-8 ``{"records":[...]}`` envelope fits command_bytes."""
    most = limits.get('command_bytes')
    commands: list[list[dict]] = []

    def envelope_size(items: list[dict]) -> int:
        return len(json.dumps({'records': items}, ensure_ascii=False, separators=(',', ':')).encode('utf-8'))

    for record in records:
        single_size = envelope_size([record])
        if most is not None and single_size > most:
            raise ValueError(f'{record["id"]} needs {single_size} bytes, more than a command takes ({most}).')
        if (not commands or len(commands[-1]) >= limits['per_command'] or
                (most is not None and envelope_size([*commands[-1], record]) > most)):
            commands.append([])
        commands[-1].append(record)
    return [{'input': {'records': chunk}} for chunk in commands]


def inputs_of(source: dict, ctx: Context) -> list[dict]:
    """The source's input entries: those in a file (with their keys renamed to the ones read here), then its own."""
    entries = []
    if 'inputs_from' in source:
        spec = source['inputs_from']
        for entry in expressions.list_rows_path(ctx.json(spec['file']), spec.get('path', '')):
            entries.append({spec.get('rename', {}).get(k, k): v for k, v in entry.items()})
    return entries + source.get('inputs', [])


def make_staged(source: dict, ctx: Context, state: dict) -> None:
    rows = state['rows'].setdefault(source['list'], [])
    ctx.rows[source['list']] = rows
    for entry in inputs_of(source, ctx):
        entry = {**source.get('defaults', {}), **entry}
        shown = (entry['paths'] if 'paths' in entry else [entry['path']])
        label = {'root': entry['root'], 'path': ', '.join(shown)}
        if entry.get('optional') and 'path' in entry and not ctx.path_of({'root': entry['root'], 'path': entry['path']}).exists():
            state['pending'].append({'file': evaluate(source['file_label'], {'_file': label}, ctx), 'reason': 'not there yet'})
            continue
        recs = []
        for item in read_staged(ctx, entry):
            base = {**item['raw'], 'raw': item['raw'], 'input': entry, '_file': item['ref'], '_generated': item['generated'], '_about': item['about']}
            for field, expr in source.get('keys', {}).items():
                base[field] = evaluate(expr, base, ctx)
            parent = source.get('parent_rows')
            if parent and item['about'] is not None and not ctx.row(parent['list'], base.get(parent['field'])) and holds(parent['when'], item['about'], ctx):
                meta = {**item['about'], parent['field']: base.get(parent['field'])}
                made = {k: evaluate(expr, meta, ctx) for k, expr in parent['rec'].items()}
                made['id'] = evaluate(parent['id'], meta, ctx)
                ctx.recs.setdefault(parent['list'], []).append(made)
            recs.append((item, base))
        link = source.get('link')
        if entry.get('optional') and link:
            unknown = next((b.get(link['field']) for _, b in recs if not ctx.row(link['into'], b.get(link['field']))), None)
            if unknown is not None:
                state['pending'].append({'file': evaluate(source['file_label'], {'_file': label}, ctx),
                                         'reason': link.get('reason', 'its rows name {field} {value}, which needs a row in {into}').format(
                                             field=link['field'], value=unknown, into=link['into'])})
                continue
        for item, base in recs:
            if entry.get('divert_when') and matches(item['raw'], entry['divert_when']):
                spec = source['divert']
                state['diverted'].append({'report_as': spec['report_as'], 'rec': base, 'exists_in': spec.get('exists_in'),
                                          'report': {name: v for name, expr in spec['fields'].items() if present(v := evaluate(expr, base, ctx))}})
                continue
            if entry.get('keep') and not matches(item['raw'], entry['keep']):
                continue
            rec = {**shape(entry, item), 'raw': base['raw'], 'input': entry, '_file': item['ref'], '_generated': item['generated'], '_about': item['about']}
            for field in source.get('keys', {}):
                rec[field] = base[field]
            made = make_row(source, entry.get('compute', source.get('compute', {})), rec, ctx, state)
            if 'skip_if' in source and holds(source['skip_if'], {**made['rec'], **made['values']}, ctx):
                continue
            row = add_row(source, rows, made, state)
            if entry.get('staged', True):
                state['staged_counts'].setdefault(source['name'], []).append(row)


def make_again(source: dict, ctx: Context, state: dict) -> None:
    """Work more fields out for the rows another source already made of `again.list` (for example the links that need rows made
    after them); each is merged into its row by the source's `on_duplicate`, which must say how."""
    if source.get('on_duplicate') not in DUPLICATE_POLICIES:
        raise ValueError(f'{source.get("name", source["list"])} works rows out again: give on_duplicate fill or over.')
    rows = state['rows'].setdefault(source['list'], [])
    ctx.rows[source['list']] = rows
    for rec in ctx.made_rows(source['again']['list']):
        made = make_row(source, source.get('compute', {}), rec, ctx, state)
        if 'skip_if' in source and holds(source['skip_if'], {**made['rec'], **made['values']}, ctx):
            continue
        add_row(source, rows, made, state)


def make_rows_kind(source: dict, recs: list[dict], ctx: Context, state: dict) -> None:
    rows = state['rows'].setdefault(source['list'], [])
    ctx.rows[source['list']] = rows
    for rec in recs:
        add_row(source, rows, make_row(source, source.get('compute', {}), dict(rec), ctx, state), state)


def check_rows(state: dict) -> None:
    for list_id, rows in state['rows'].items():
        seen: set = set()
        for row in rows:
            if row['id'] in seen:
                raise ValueError(f'Two {list_id} rows share the id {row["id"]}.')
            if '/' in row['id']:
                raise ValueError(f'{row["id"]} holds a slash.')
            seen.add(row['id'])
    for check in state['checks']:
        spec = check['links_resolve']
        known = {r['id'] for r in state['rows'].get(spec['into'], [])}
        for row in state['rows'].get(spec['list'], []):
            value = row['values'].get(spec['field']) or []
            for target in (value if isinstance(value, list) else [value]):
                if target not in known:
                    raise ValueError(spec['error'].format(id=row['id'], value=target, into=spec['into'], field=spec['field']))


def make_records(source: dict, ctx: Context, state: dict, record_reader) -> None:
    """Read only the declared record type/prefix, then map each returned record through the source's ordinary row rules."""
    spec = source['records']
    record_type, prefix = spec.get('type'), spec.get('prefix')
    if not isinstance(record_type, str) or not record_type:
        raise ValueError(f'{source.get("name", source["list"])} records source needs a non-empty type.')
    if prefix is not None and (not isinstance(prefix, str) or not prefix):
        raise ValueError(f'{source.get("name", source["list"])} records prefix, when given, is non-empty text.')
    if record_reader is None:
        raise ValueError(f'{source.get("name", source["list"])} needs a records reader for type {record_type}.')
    records = record_reader(source)
    if not isinstance(records, list):
        raise ValueError(f'{source.get("name", source["list"])} records reader returned no record list.')
    rows = state['rows'].setdefault(source['list'], [])
    ctx.rows[source['list']] = rows
    for record in records:
        if not isinstance(record, dict) or record.get('type') != record_type or not isinstance(record.get('id'), str):
            raise ValueError(f'{source.get("name", source["list"])} reader returned a record outside declared type {record_type}.')
        if prefix and not record['id'].startswith(prefix):
            raise ValueError(f'{source.get("name", source["list"])} reader returned {record["id"]} outside declared prefix {prefix}.')
        items = [None]
        if 'each' in source:
            items = evaluate({'path': source['each']}, record, ctx)
            if items is None:
                items = []
            if not isinstance(items, list):
                raise ValueError(f'{source.get("name", source["list"])} each path {source["each"]} is not an array on {record["id"]}.')
        for item in items:
            rec = {**record, 'record': record, 'item': item, 'raw': record, 'input': spec,
                   '_file': None, '_generated': None, '_about': None}
            for field, expr in source.get('keys', {}).items():
                rec[field] = evaluate(expr, rec, ctx)
            rec['id'] = evaluate(source.get('id', {'path': 'id'}), rec, ctx)
            if not isinstance(rec['id'], str) or not rec['id']:
                raise ValueError(f'{source.get("name", source["list"])} produced a row with no id from record {record["id"]}.')
            add_row(source, rows, make_row(source, source.get('compute', {}), rec, ctx, state), state)


def add_to_list(value: dict, add: dict) -> dict:
    """A list definition with the fields a mapping needs: a field it lacks is added at the end, a field it holds takes the keys the
    mapping gives (every other key, and every field the mapping does not name, stays as it is), a choice field gains the choices it
    lacks, and `set` gives top-level keys."""
    fields = [dict(field) for field in value.get('fields', [])]
    for wanted in add.get('fields', []):
        kept = next((field for field in fields if field['id'] == wanted['id']), None)
        if kept is None:
            fields.append(dict(wanted))
        else:
            kept.update(wanted)
    for field_id, choices in add.get('choices', {}).items():
        kept = next((field for field in fields if field['id'] == field_id), None)
        if kept is None:
            raise ValueError(f'lists_add names choices for {field_id}, a field the list does not have.')
        kept['choices'] = [*kept.get('choices', []), *(c for c in choices if c not in kept.get('choices', []))]
    return {**value, **add.get('set', {}), 'fields': fields}


def lists_of(mapping: dict, ctx: Context, ids: dict, record_reader) -> tuple[dict, list[str] | None]:
    """The list definitions and saved views, and which lists changed: a file (`lists_file`; every list is written), or the person's
    own list records read through the door (`lists_read`: { config, ids }) with the fields and choices `lists_add` needs, where only a
    list whose definition that changes is written, with the saved views the mapping's `views` names."""
    if 'lists_file' in mapping:
        return ctx.json(mapping['lists_file']), None
    spec = mapping['lists_read']
    if record_reader is None:
        raise ValueError('lists_read reads the lists through the door: give the run a records reader (the sender config).')
    reader_source = {'name': 'lists', 'list': 'lists', 'records': {'type': 'list', 'prefix': ids['list'].format(id=''), 'config': spec['config']}}
    held = {record['id']: record['value'] for record in record_reader(reader_source)}
    lists, changed = [], []
    for list_id in spec['ids']:
        value = held.get(ids['list'].format(id=list_id))
        if value is None:
            raise ValueError(f'The account holds no list {list_id}: lists_read names only lists the account has.')
        wanted = add_to_list(value, mapping.get('lists_add', {}).get(list_id, {}))
        lists.append({'id': list_id, 'value': wanted})
        if wanted != value:
            changed.append(list_id)
    unknown = sorted(set(mapping.get('lists_add', {})) - set(spec['ids']))
    if unknown:
        raise ValueError(f'lists_add names {", ".join(unknown)}, which lists_read does not read.')
    return {'lists': lists, 'views': mapping.get('views', [])}, changed


def build(mapping: dict, roots: dict[str, Path], at: str | None = None, record_reader=None) -> dict:
    """The payload for a mapping: counts, what is pending or diverted, and the commands of records to send in order."""
    emit_definitions = mapping.get('emit_definitions', True)
    if not isinstance(emit_definitions, bool):
        raise ValueError('emit_definitions must be a boolean.')
    at = at or datetime.now(timezone.utc).isoformat(timespec='milliseconds').replace('+00:00', 'Z')
    ctx = Context(roots, {'mapping': mapping})
    limits = {**LIMIT_DEFAULTS, **mapping.get('limits', {})}
    ids = {**ID_DEFAULTS, **mapping.get('ids', {})}
    definition, changed = lists_of(mapping, ctx, ids, record_reader)
    list_value = {entry['id']: entry['value'] for entry in definition['lists']}
    state = {'limits': limits, 'by': mapping['by'], 'confidence': mapping.get('confidence', 'medium'), 'at': at, 'at_of': mapping.get('at'),
             'rows': {}, 'pending': [], 'diverted': [], 'staged_counts': {}, 'merged': [], 'checks': mapping.get('checks', [])}
    # Each `rows` source builds the records its own file holds; the records `parent_rows` makes for a list are built by the first
    # `rows` source of that list. Every record read is reachable by row_of before any row is made.
    read: list[tuple[dict, list[dict]]] = []
    for source in mapping['sources']:
        if source['kind'] == 'rows':
            own = list(expressions.list_rows_path(ctx.json(source['rows']['file']), source['rows'].get('path', '')))
            ctx.recs.setdefault(source['list'], []).extend(own)
            read.append((source, own))
    file_recs = {id(rec) for _, own in read for rec in own}
    for source in mapping['sources']:
        if source['kind'] == 'staged':
            make_staged(source, ctx, state)
        elif source['kind'] == 'records':
            make_records(source, ctx, state, record_reader)
        elif source['kind'] == 'again':
            make_again(source, ctx, state)
    first_of_list: set = set()
    for source, own in read:
        made = [] if source['list'] in first_of_list else [r for r in ctx.recs.get(source['list'], []) if id(r) not in file_recs]
        first_of_list.add(source['list'])
        make_rows_kind(source, own + made, ctx, state)
    check_rows(state)
    records = []
    if emit_definitions:
        records = [{'id': ids['list'].format(id=entry['id']), 'type': 'list', 'value': entry['value']} for entry in definition['lists']
                   if changed is None or entry['id'] in changed]
        records += [{'id': ids['view'].format(list=v['list'], view_id=v['view']['id']), 'type': ids['view_type'], 'value': {'list_id': v['list'], 'view': v['view'], 'order': v['order']}}
                    for v in definition['views']]
    for list_id in mapping.get('emit', [entry['id'] for entry in definition['lists']]):
        row_type = list_value[list_id]['row_type']
        for row in state['rows'].get(list_id, []):
            value = {**row['values'], **({'_basis': row['basis']} if row['basis'] else {})}
            records.append({'id': ids['row'].format(row_type=row_type, id=row['id']), 'type': ids['row_type'].format(row_type=row_type), 'value': value})
    commands = commands_of(records, limits)
    counts = {'records': len(records), 'commands': len(commands), 'lists': sum(1 for r in records if r['type'] == 'list'),
              'views': len(definition['views']) if emit_definitions else 0,
              'rows': {list_id: len(rows) for list_id, rows in state['rows'].items()}}
    if 'breakdown' in mapping:
        spec = mapping['breakdown']
        staged = [r for name in spec['staged_sources'] for r in state['staged_counts'].get(name, [])]
        total: dict = {}
        for row in state['rows'].get(spec['list'], []):
            for target in row['values'].get(spec['field']) or []:
                total[target] = total.get(target, 0) + 1
        counts['breakdown'] = {k: {'staged': sum(1 for r in staged if k in (r['values'].get(spec['field']) or [])), 'total': total[k]} for k in sorted(total)}
    payload = {'_what': mapping.get('payload_note', ''), 'built_at': at, 'counts': counts, 'pending': state['pending']}
    if state['merged']:
        payload['merged'] = state['merged']
    for item in state['diverted']:
        report = dict(item['report'])
        spec = item['exists_in']
        if spec:
            report[spec['as']] = any(r['id'] == evaluate(spec['id'], item['rec'], ctx) for r in state['rows'].get(spec['list'], []))
        payload.setdefault(item['report_as'], []).append(report)
    payload['commands'] = commands
    return payload
