"""Whether a library is valid, by the checks its schema declares.

A check row is { "name", "kind", ... }; its kind says how it reads the library. Each kind answers True (holds) or the sorted list of what
breaks it. The schema's `tables` rows check tab-separated files against a vocabulary of columns, and its `derived` rows run a command
that says whether a file derived from a source still equals what the source generates. No record kind is named here.
"""
from __future__ import annotations

import csv
import glob
import json
import re
import subprocess
import sys
from pathlib import Path
from typing import Any, Callable

import derived_data
from investigation import piece_problems
from library import Store, at_path, piece_rel, read_json
from routes import route_tags


def ids_in(store: Store, pools: list[str]) -> set[str]:
    return {i for pool in pools for i in store.ids(pool)}


def values_of(store: Store, source: dict) -> list[tuple[dict, Any]]:
    """(record, value) for each value of the source field; a `many` field holds a list, `only_if_set` skips records without it."""
    out = []
    for record in store.pool(source['pool']):
        value = record.get(source['field'])
        if source.get('only_if_set') and not value:
            continue
        for item in (value if source.get('many') else [value]):
            out.append((record, item))
    return out


def ids_unique(store: Store, row: dict) -> Any:
    ids = store.ids(row['pool'])
    return len(set(ids)) == len(ids)


def count_equals(store: Store, row: dict) -> Any:
    return at_path(store.file(row['count_in']['file']), row['count_in']['path'])[0] == len(store.pool(row['pool']))


def references(store: Store, row: dict) -> Any:
    known = ids_in(store, row['into'])
    unresolved = [(record, item) for record, item in values_of(store, row['from']) if item not in known]
    if row.get('report') == 'owners':
        owner = store.id_field(row['from']['pool'])
        return sorted(record[owner] for record, _ in unresolved)
    return sorted({item for _, item in unresolved})


def list_equals_joined(store: Store, row: dict) -> Any:
    """Records whose list is not exactly the union of the lists of the records they point at, or whose count field is not its length."""
    through = store.by_id(row['through']['pool'])
    owner = store.id_field(row['pool'])
    return sorted(r[owner] for r in store.pool(row['pool'])
                  if sorted(r[row['list']]) != sorted({x for y in r[row['via']] for x in through.get(y, {}).get(row['through']['list'], [])})
                  or r[row['count']] != len(r[row['list']]))


def not_chained(store: Store, row: dict) -> Any:
    """Records whose reference points at a record that itself carries the reference."""
    pool = store.by_id(row['pool'])
    owner = store.id_field(row['pool'])
    return sorted(r[owner] for r in pool.values() if r.get(row['field']) in pool and pool[r[row['field']]].get(row['field']))


def routes_known(store: Store, row: dict) -> Any:
    known = set(row['known'])
    owner = store.id_field(row['pool'])
    return sorted(r[owner] for r in store.pool(row['pool'])
                  if not all(t in known or t.startswith(tuple(row.get('prefixes', []))) for t in route_tags(r.get(row['field'], row.get('default', 'all')))))


def ids_named_in_text(store: Store, row: dict) -> Any:
    known = ids_in(store, row['into'])
    named = []
    for pattern in row['globs']:
        for path in sorted(store.root.glob(pattern)):
            named += [(path.name, m) for m in re.findall(row['pattern'], path.read_text(encoding='utf-8'))]
    return sorted({f'{name}:{i}' for name, i in named if i not in known})


def text_table_matches_field(store: Store, row: dict) -> Any:
    """A table in a text maps a key to the ids of records it answers; the records' own field must say the same. None when the text has no such table."""
    doc = store.root / row['doc']
    if not doc.is_file() or row['heading'] not in doc.read_text(encoding='utf-8'):
        return None
    table = doc.read_text(encoding='utf-8').split(row['heading'], 1)[1].split('\n## ', 1)[0]
    listed = {f'{row["id_prefix"]}{x}': m[1] for m in re.finditer(row['row'], table, re.M) for x in re.findall(row['ids_in_cell'], m[2])}
    keys = ids_in(store, row['keys_in'])
    owner = store.id_field(row['pool'])
    kept = {r[owner]: r[row['field']] for r in store.pool(row['pool']) if r.get(row['field'], '') in keys}
    return [list(pair) for pair in sorted(set(listed.items()) ^ set(kept.items()))]


def investigation_records(store: Store, row: dict) -> Any:
    ids, shape = piece_problems(store)
    return ids if row['report'] == 'ids' else shape


KINDS: dict[str, Callable[[Store, dict], Any]] = {
    'ids-unique': ids_unique, 'count-equals': count_equals, 'references': references, 'list-equals-joined': list_equals_joined,
    'not-chained': not_chained, 'routes-known': routes_known, 'ids-named-in-text': ids_named_in_text,
    'text-table-matches-field': text_table_matches_field, 'investigation-records': investigation_records,
}


def relation_checks(store: Store) -> dict[str, Any]:
    out = {}
    for row in store.schema['checks']:
        if row['kind'] not in KINDS:
            raise ValueError(f'check {row["name"]}: kind {row["kind"]} is not one of {", ".join(KINDS)}')
        result = KINDS[row['kind']](store, row)
        if result is not None:
            out[row['name']] = result
    return out


def check_table(store: Store, spec: dict, max_examples: int = 25) -> dict:
    """Tab-separated files against a vocabulary of columns: { fields: { column: { one_of | list_of | number | free_text } } }."""
    vocab_path = (store.root / spec['vocabulary']).resolve()      # absolute, or relative to the library root
    fields = read_json(vocab_path)['fields']
    extra = spec['extra_columns']
    files = sorted({p for g in spec['globs'] for p in glob.glob(str(store.root / g))})
    bad_values: dict[str, int] = {}
    examples, unknown_columns, files_with_errors = [], {}, set()
    cells = 0

    def is_number(v: str) -> bool:
        try:
            float(v)
            return True
        except ValueError:
            return False

    for f in files:
        with open(f, newline='', encoding='utf-8') as fh:
            rows = list(csv.reader(fh, delimiter='\t'))
        if not rows:
            continue
        head = rows[0]
        for col in head:
            if col not in fields and col not in extra:
                unknown_columns.setdefault(col, []).append(piece_rel(store.root, Path(f)))
                files_with_errors.add(f)
        for r_i, row in enumerate(rows[1:], 2):
            for col, v in zip(head, row):
                v = v.strip()
                column = fields.get(col) or {extra.get(col, 'free_text'): True}
                cells += 1
                problem = None
                if 'one_of' in column:
                    if v not in column['one_of']:
                        problem = v
                elif 'list_of' in column:
                    wrong = [x for x in (y.strip() for y in v.split(',')) if x not in column['list_of']]
                    if wrong:
                        problem = ','.join(wrong)
                elif 'number' in column:
                    if not is_number(v):
                        problem = v
                if problem is not None:
                    key = f'{col}={problem}'
                    bad_values[key] = bad_values.get(key, 0) + 1
                    files_with_errors.add(f)
                    if len(examples) < max_examples:
                        examples.append({'file': piece_rel(store.root, Path(f)), 'line': r_i, 'column': col, 'value': v})
            if len(row) != len(head):
                bad_values['(row has wrong column count)'] = bad_values.get('(row has wrong column count)', 0) + 1
                files_with_errors.add(f)
    top = sorted(bad_values.items(), key=lambda x: -x[1])
    return {'files': len(files), 'cells': cells, 'files_with_errors': len(files_with_errors),
            'bad_cells': sum(bad_values.values()), 'distinct_bad_values': len(bad_values),
            'most_common_bad_values': top[:40], 'unknown_columns': unknown_columns, 'examples': examples,
            'vocabulary': str(vocab_path)}


def run_derived(store: Store, spec: dict) -> list[str] | None:
    """Run the command that says whether a derived file is current: exit 0 current, exit 1 stale (its stdout may be JSON { "stale": [names] }).
    Any other exit is an error. None when the schema says the command does not apply (a file it needs is absent)."""
    needs = spec.get('only_if_exists')
    if needs and not (store.root / needs).is_file():
        return None
    command = [part.replace('{root}', str(store.root)).replace('{python}', sys.executable) for part in spec['command']]
    run = subprocess.run(command, capture_output=True, text=True, cwd=store.root)
    if run.returncode == 0:
        return []
    if run.returncode != 1:
        raise ValueError(f'{spec["name"]}: {" ".join(command)} exited {run.returncode}: {(run.stderr or run.stdout).strip()}')
    try:
        stale = json.loads(run.stdout)['stale']
    except (ValueError, KeyError, TypeError):
        stale = [spec['name']]
    return stale


def validate(store: Store, inputs: dict[str, Path] | None = None) -> dict:
    ids = relation_checks(store)
    passed = {k: (v is True or v == []) for k, v in ids.items()}
    report: dict[str, Any] = {}
    for spec in store.schema.get('tables', []):
        block = check_table(store, spec)
        report[spec['name']] = block
        passed[f'{spec["name"]}_values_in_vocabulary'] = block['bad_cells'] == 0 and not block['unknown_columns']
    stale_reports: dict[str, list[str]] = {}
    not_checked: list[str] = []
    if store.schema.get('builders'):
        built, not_checked = derived_data.build_all(store, inputs or {})
        stale_files = derived_data.stale(store, built)
        passed['derived_data_current'] = not stale_files
        stale_reports['stale_derived_files'] = stale_files
    for spec in store.schema.get('derived', []):
        stale = run_derived(store, spec)
        if stale is None:
            continue
        passed[spec['name']] = not stale
        if 'report_as' in spec:
            stale_reports.setdefault(spec['report_as'], []).extend(stale)
    return {'all_passed': all(passed.values()), 'passed': sum(passed.values()), 'total': len(passed), 'checks': passed,
            'id_problems': {k: v for k, v in ids.items() if not (v is True or v == [])},
            **report, **stale_reports, **({'derived_files_not_checked': not_checked} if not_checked else {}), 'scope': store.schema['scope']}
