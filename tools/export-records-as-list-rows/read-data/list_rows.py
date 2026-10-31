"""Records on disk to list rows, by a mapping file the person gives. Nothing about any record kind is known here.

A mapping is { "new_lists": [{ "list": {...}, "why": "..." }], "sources": [source] }. A source says where records are, which to drop,
what to work out from each, and how a row is made from it:

  name, list_id            the source's name and the list its rows go to
  type                     json | tsv | markdown-table
    json                   { "file", "path": "dotted.keys", "where": { field: value } }: the list at that path in a JSON file
    tsv                    { "glob" }: one record per row of each tab-separated file, keyed by its header row
    markdown-table         { "file", "section": "<heading line>" }: one record per row of the table under that heading
  blank_when               [{ "field", "starts_with", "blank": [fields] }]: empty those fields when the field starts with that text
  compute                  { new field: transform }, in order; a later one may read an earlier one
  skip_when                [{ "field", "empty": true } | { "field", "starts_with" }]: drop the record
  exclude                  [{ "field", "in": [values] }]: drop records whose field holds one of these
  first_per                keep only the first record for each value of this field
  id                       a template over the record's fields: the row's stable id
  on_duplicate             first | last | fill: what to do when two records make the same row id (without it a duplicate is refused,
                           because silently choosing one drops a record)
  map                      { list field: transform }: the row's values; a transform that gives nothing leaves the field out

A transform is a one-key object:
  from                     the record's field
  const                    a fixed value
  template                 "{field}" placeholders filled from the record; no value when every placeholder is empty
  number                   the field as a number
  date8                    YYYYMMDD as YYYY-MM-DD
  choice                   { "choice": field, "table": { value: label } }: unmapped values give nothing, never a guess
  join                     a list field joined with "; "
  lines                    { "from": list of objects, "template", "details": { "from", "template", "join", "wrap" } }: one line per object
  words_of_file            the number of words in the file the field names (a leading [time] on a line is not a word)
  path_of_file             the field's value when it names a file that exists
  first_nonempty           [fields]: the first that is not empty
  up                       N: the name of the folder N levels above the record's file
  file                     true: the record's file, relative to the root
  file_beside              { "dirs", "exts", "name_from": field }: the first <folder of the file>/<dir>/<field><ext> that exists
  capture                  { "from", "pattern", "group" }: a group of the first match, or ""
  capture_template         { "from", "pattern", "template" }: the template filled from the match's named groups, or "" with no match
  last_part                { "from", "sep" }: what follows the last separator
  strip                    { "from", "chars" }: the field without those characters at its ends
Row ids are stable, so loading the same rows twice updates them.
"""
from __future__ import annotations

import csv
import json
import re
from pathlib import Path

DUPLICATE_POLICIES = ('first', 'last', 'fill')


class Safe(dict):
    def __missing__(self, k):
        return ''


def fill(tpl: str, rec: dict) -> str:
    return tpl.format_map(Safe({k: ('' if v is None else v) for k, v in rec.items()})).strip()


def words(path: str) -> int | None:
    p = Path(path)
    if not path or not p.is_file():
        return None
    return len(re.sub(r'^\[[\d:.]+\]\s*', '', p.read_text(errors='replace'), flags=re.M).split())


def to_num(v):
    try:
        return float(str(v).replace(',', '')) if '.' in str(v) else int(str(v).replace(',', ''))
    except ValueError:
        return None


def lines_of(spec: dict, rec: dict) -> str:
    out = []
    for item in rec.get(spec['from']) or []:
        line = fill(spec['template'], item)
        details = spec.get('details')
        if details:
            inner = [fill(details['template'], d) for d in item.get(details['from'], [])]
            if inner:
                line += details.get('wrap', '{}').format(details.get('join', '; ').join(inner))
        out.append(line)
    return '\n'.join(out)


def file_beside(spec: dict, rec: dict, where: Path) -> str:
    for sub in spec['dirs']:
        for ext in spec['exts']:
            candidate = where.parent / sub / f'{rec.get(spec["name_from"]) or ""}{ext}'
            if candidate.is_file():
                return str(candidate)
    return ''


def transform(t: dict, rec: dict, where: Path | None, root: Path):
    """One transform's value for a record, or None for no value."""
    if 'from' in t and len(t) == 1:
        return rec.get(t['from'])
    if 'const' in t:
        return t['const']
    if 'template' in t:
        names = re.findall(r'\{([^}]+)\}', t['template'])
        # a template whose placeholders are all empty carries no information
        return fill(t['template'], rec) if any(rec.get(n) for n in names) else None
    if 'number' in t:
        return to_num(rec.get(t['number'], ''))
    if 'date8' in t:
        d = str(rec.get(t['date8'], ''))
        return f'{d[:4]}-{d[4:6]}-{d[6:]}' if len(d) == 8 and d.isdigit() else None
    if 'choice' in t:
        return t['table'].get(str(rec.get(t['choice']) or '').strip())
    if 'join' in t:
        return '; '.join(rec.get(t['join']) or [])
    if 'lines' in t:
        return lines_of(t['lines'], rec)
    if 'words_of_file' in t:
        return words(rec.get(t['words_of_file'], ''))
    if 'path_of_file' in t:
        p = rec.get(t['path_of_file'], '')
        return p if p and Path(p).is_file() else None
    if 'first_nonempty' in t:
        return next((rec[f] for f in t['first_nonempty'] if rec.get(f)), '')
    if 'up' in t:
        return where.parents[t['up'] - 1].name
    if 'file' in t:
        return str(where.relative_to(root))
    if 'file_beside' in t:
        return file_beside(t['file_beside'], rec, where)
    if 'capture' in t:
        spec = t['capture']
        m = re.search(spec['pattern'], rec.get(spec['from']) or '')
        return m.group(spec.get('group', 1)) if m else ''
    if 'capture_template' in t:
        spec = t['capture_template']
        m = re.search(spec['pattern'], rec.get(spec['from']) or '')
        return spec['template'].format_map(Safe(m.groupdict())) if m else ''
    if 'last_part' in t:
        spec = t['last_part']
        return str(rec.get(spec['from']) or '').split(spec.get('sep', '/'))[-1]
    if 'strip' in t:
        spec = t['strip']
        return str(rec.get(spec['from']) or '').strip(spec['chars'])
    raise ValueError(f'transform {json.dumps(t)} is not one of the transforms in the mapping description')


def build_values(spec: dict, rec: dict) -> dict:
    out = {}
    for field, t in spec.items():
        v = transform(t, rec, None, Path())
        if v not in (None, '', []):
            out[field] = v
    return out


def records_json(root: Path, src: dict):
    data = json.loads((root / src['file']).read_text())
    for part in src.get('path', '').split('.'):
        if part:
            data = data[part]
    for rec in data:
        if all(rec.get(k) == v for k, v in src.get('where', {}).items()):
            yield rec, root / src['file']


def records_tsv(root: Path, src: dict):
    for path in sorted(root.glob(src['glob'])):
        with path.open() as f:
            for rec in csv.DictReader(f, delimiter='\t'):
                yield rec, path


def records_markdown_table(root: Path, src: dict):
    path = root / src['file']
    lines = path.read_text().split('\n')
    start = lines.index(src['section'])
    header = None
    for ln in lines[start + 1:]:
        if ln.startswith('## '):
            break
        if not ln.startswith('|'):
            continue
        cells = [c.strip() for c in ln.strip().strip('|').split('|')]
        if header is None:
            header = cells
            continue
        if set(ln) <= set('|-: '):
            continue
        yield dict(zip(header, cells)), path


READERS = {'json': records_json, 'tsv': records_tsv, 'markdown-table': records_markdown_table}


def skipped(rec: dict, rules: list[dict]) -> bool:
    for rule in rules:
        value = str(rec.get(rule['field']) or '')
        if (rule.get('empty') and not value) or ('starts_with' in rule and value.startswith(rule['starts_with'])):
            return True
    return False


def records_of(root: Path, src: dict):
    if src['type'] not in READERS:
        raise ValueError(f'source {src["name"]}: type {src["type"]} is not one of {", ".join(READERS)}')
    first_seen: set = set()
    for rec, where in READERS[src['type']](root, src):
        for rule in src.get('blank_when', []):
            if str(rec.get(rule['field']) or '').startswith(rule['starts_with']):
                rec = {**rec, **{f: '' for f in rule['blank']}}
        rec = dict(rec)
        for field, t in src.get('compute', {}).items():
            rec[field] = transform(t, rec, where, root)
        if skipped(rec, src.get('skip_when', [])):
            continue
        if any(rec.get(e['field']) in e['in'] for e in src.get('exclude', [])):
            continue
        if 'first_per' in src:
            key = rec.get(src['first_per'])
            if key in first_seen:
                continue
            first_seen.add(key)
        yield rec


def build(root: Path, src: dict) -> list[dict]:
    policy = src.get('on_duplicate')
    if policy is not None and policy not in DUPLICATE_POLICIES:
        raise ValueError(f'source {src["name"]}: on_duplicate must be one of {", ".join(DUPLICATE_POLICIES)}')
    rows: dict[str, dict] = {}
    for rec in records_of(root, src):
        rid = fill(src['id'], rec)
        vals = build_values(src['map'], rec)
        if not vals:
            continue
        if rid in rows:
            if policy is None:
                raise ValueError(f'source {src["name"]}: two records make row id {rid}; add "on_duplicate": "first", "last" or "fill" to say which one the row keeps')
            if policy == 'first':
                continue
            if policy == 'fill':
                # same row listed twice: keep the first, fill only the fields it lacks
                for k, v in vals.items():
                    rows[rid]['values'].setdefault(k, v)
                continue
        rows[rid] = {'id': rid, 'values': vals}
    return list(rows.values())


def export(mapping: dict, root: Path, out: Path, batch: int = 100, only: str | None = None, skip: dict | None = None) -> dict:
    """Write make_lists.json, the row batches and manifest.json into out; returns the manifest. Only files an earlier export listed are replaced."""
    skip = skip or {}
    out.mkdir(parents=True, exist_ok=True)
    earlier = out / 'manifest.json'
    if earlier.is_file():
        for name in ['manifest.json', 'make_lists.json'] + [b['file'] for b in json.loads(earlier.read_text())['batches']]:
            (out / name).unlink(missing_ok=True)
    manifest: dict = {'make_lists': 'make_lists.json', 'batches': [], 'counts': {}}
    (out / 'make_lists.json').write_text(json.dumps({'lists': [{k: v for k, v in n.items() if k != 'why'} for n in mapping['new_lists']]}, indent=1))
    for src in mapping['sources']:
        if only and src['name'] != only:
            continue
        skipped_ids = set(skip.get(src['list_id'], []))
        rows = [r for r in build(root, src) if r['id'] not in skipped_ids]
        manifest['counts'][src['name']] = {'list_id': src['list_id'], 'rows': len(rows)}
        for i in range(0, len(rows), batch):
            name = f"{src['name']}-{i // batch:03d}.json"
            (out / name).write_text(json.dumps({'list_id': src['list_id'], 'rows': rows[i:i + batch]}, ensure_ascii=False))
            manifest['batches'].append({'file': name, 'list_id': src['list_id'], 'rows': len(rows[i:i + batch])})
    earlier.write_text(json.dumps(manifest, indent=1))
    return manifest
