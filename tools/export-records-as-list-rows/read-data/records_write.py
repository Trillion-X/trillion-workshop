"""Records on disk to the { id, type, value } records a Trillion `records:write` takes, by a mapping the person gives.

Nothing about any record kind is known here: the lists, their fields and saved views are the person's list-definition rows
(`lists_file`), and where each row comes from and how its values and their bases are worked out is the mapping's. The output is
a payload of commands, at most `limits.per_command` records and `limits.command_bytes` bytes each, to send in order. Nothing is sent.

A mapping:

  lists_file        REF of a JSON file { "lists": [{ id, value }], "views": [{ list, order, view }] }; `value.row_type` names a
                    list's rows' type, `value.fields` its columns
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
  breakdown         { list, field, staged_sources }: the payload counts, for each value of a link field, the rows made from the
                    named sources and all rows
  checks            [{ "links_resolve": { list, field, into, error } }]: every id in a row's field is the id of a row of `into`
  sources           [source], worked through in order (`kind` rows first read, then `staged` made, then `rows` built)

A source makes the rows of one list (`list`). Its `kind` is:
  rows              records already in a JSON file: { file: REF, path: "dotted.path" }; each is a record with an `id`
  staged            rows read from files, one `inputs` entry per file or glob; `defaults` is merged under each entry

Per source: `id` (an expression), `keys`, `compute` (then `compute_after`, which every input shares), `values` (`keep_empty`: fields
kept when their text is empty), `basis`, `fits`, `on_duplicate`. Without `on_duplicate`, a row whose id another row of the list already
has is refused (choosing silently would drop one). `fill`: the row already made keeps its values and takes only the fields (and bases) it
lacks from this one; `over`: this row's values win and the row already made fills the fields it lacks. Either way the two are one row,
and the payload's `merged` names each one with the fields filled and the fields whose two values differed (the value not kept). Per `staged` input (a source may also give `inputs_from`: { file, path, rename } to read the entries from a file, with those keys
renamed to the ones below; `link`: { field, into } names the field an optional input's rows link by; `file_label` is the expression
that names an input for `pending`):
  root, path | paths    the file REF (paths are globs inside root); JSON ({ rows } or the rows themselves) or JSON lines
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
object), and `basis[field]` = { reasoning, sources } makes `_basis[field]` (no reasoning, no basis).
"""
from __future__ import annotations

import glob
import json
from datetime import datetime, timezone
from pathlib import Path

import expressions
from expressions import Context, evaluate, holds, present

ID_DEFAULTS = {'list': 'list:{id}', 'view': 'list-view:{list}:{view_id}', 'view_type': 'list-view',
               'row': 'record:{row_type}:{id}', 'row_type': 'record:{row_type}'}
LIMIT_DEFAULTS = {'text_chars': 20000, 'basis_sources': 10, 'per_command': 64}


def read_staged(ctx: Context, entry: dict) -> list[dict]:
    """Every row of the entry's files with where it was read from."""
    root = ctx.roots[entry['root']]
    paths = ([entry['path']] if 'path' in entry else
             [str(Path(p).relative_to(root)) for pattern in entry['paths'] for p in sorted(glob.glob(str(root / pattern)))])
    items = []
    for path in paths:
        ref = {'root': entry['root'], 'path': path}
        text = ctx.path_of(ref).read_text(encoding='utf-8')
        if path.endswith('.jsonl'):
            kept, rows = None, [json.loads(line) for line in text.split('\n') if line.strip()]
        else:
            kept = json.loads(text)
            rows = kept if isinstance(kept, list) else kept.get(entry.get('rows_at', 'rows'))
        if not isinstance(rows, list):
            raise ValueError(f'{ref_text(ref)} holds no rows.')
        meta = kept if isinstance(kept, dict) else {}
        about = meta.get('source') if meta else None
        generated = meta.get('generated') or (meta.get('meta') or {}).get('generated') or entry.get('generated_default')
        items += [{'raw': row, 'ref': ref, 'about': about, 'generated': generated} for row in rows]
    return items


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
        elif present(value) or (value == '' and field in source.get('keep_empty', [])):
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
        basis[field] = {'confidence': state['confidence'], 'reasoning': reasoning, 'sources': sources, 'by': state['by'], 'at': at}
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
    """The records in order, in commands of at most per_command records and command_bytes bytes (UTF-8 JSON of the records)."""
    most = limits.get('command_bytes')
    commands: list[list[dict]] = []
    size = 0
    for record in records:
        bytes_of = len(json.dumps(record, ensure_ascii=False, separators=(',', ':')).encode('utf-8')) + 1
        if most is not None and bytes_of > most:
            raise ValueError(f'{record["id"]} is {bytes_of} bytes, more than a command takes ({most}).')
        if not commands or len(commands[-1]) >= limits['per_command'] or (most is not None and size + bytes_of > most):
            commands.append([])
            size = 0
        commands[-1].append(record)
        size += bytes_of
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
            row = add_row(source, rows, make_row(source, entry.get('compute', source.get('compute', {})), rec, ctx, state), state)
            if entry.get('staged', True):
                state['staged_counts'].setdefault(source['name'], []).append(row)


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


def build(mapping: dict, roots: dict[str, Path], at: str | None = None) -> dict:
    """The payload for a mapping: counts, what is pending or diverted, and the commands of records to send in order."""
    at = at or datetime.now(timezone.utc).isoformat(timespec='milliseconds').replace('+00:00', 'Z')
    ctx = Context(roots)
    limits = {**LIMIT_DEFAULTS, **mapping.get('limits', {})}
    ids = {**ID_DEFAULTS, **mapping.get('ids', {})}
    definition = ctx.json(mapping['lists_file'])
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
    first_of_list: set = set()
    for source, own in read:
        made = [] if source['list'] in first_of_list else [r for r in ctx.recs.get(source['list'], []) if id(r) not in file_recs]
        first_of_list.add(source['list'])
        make_rows_kind(source, own + made, ctx, state)
    check_rows(state)
    records = [{'id': ids['list'].format(id=entry['id']), 'type': 'list', 'value': entry['value']} for entry in definition['lists']]
    records += [{'id': ids['view'].format(list=v['list'], view_id=v['view']['id']), 'type': ids['view_type'], 'value': {'list_id': v['list'], 'view': v['view'], 'order': v['order']}}
                for v in definition['views']]
    for list_id in mapping.get('emit', [entry['id'] for entry in definition['lists']]):
        row_type = list_value[list_id]['row_type']
        for row in state['rows'].get(list_id, []):
            value = {**row['values'], **({'_basis': row['basis']} if row['basis'] else {})}
            records.append({'id': ids['row'].format(row_type=row_type, id=row['id']), 'type': ids['row_type'].format(row_type=row_type), 'value': value})
    commands = commands_of(records, limits)
    counts = {'records': len(records), 'commands': len(commands), 'lists': len(definition['lists']), 'views': len(definition['views']),
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
