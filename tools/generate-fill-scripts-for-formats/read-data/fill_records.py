"""A fill request put together from the person's list rows. Pure.

Each row is a record { id, type, value } whose value has a `kind` and its object as JSON text in `detail`:
  fill-batch        { settings?, formats: [format row id], capabilities: [capability row id], index? }: one batch to fill
  fill-format       one format: { id, path, name, measured, short, why?, template }
  fill-capability   one capability's words: { key, id, kind, ... }
  catalog-listing   one saved catalog listing: { file, listing }, its id in `catalog_id`
The batch names its formats and capabilities by row id (with or without the row type before it), in the order they are
filled; capabilities name their listing by `id`.
"""
from __future__ import annotations

import json


class RowError(ValueError):
    pass


def detail(row: dict) -> dict:
    try:
        return json.loads(row['value']['detail'])
    except (KeyError, TypeError, json.JSONDecodeError) as e:
        raise RowError(f'Row {row.get("id")} has no readable `detail` (JSON text of its object): {e}.') from e


def request_from_rows(rows: list[dict], batch: str) -> dict:
    by_id = {r['id']: r for r in rows}
    # a row read back from an account carries its type before its id (record:library:fill-format-x); the batch names it bare
    by_id.update({r['id'][len(r['type']) + 1:]: r for r in rows if r.get('type') and r['id'].startswith(r['type'] + ':')})
    found = [r for r in rows if r['value'].get('kind') == 'fill-batch' and (r['id'] == batch or r['id'].endswith(batch))]
    if len(found) != 1:
        names = sorted(r['id'] for r in rows if r['value'].get('kind') == 'fill-batch')
        raise RowError(f'{len(found)} batch rows match {batch!r}; the rows hold these batches: {", ".join(names) or "none"}.')
    spec = detail(found[0])

    def rows_named(ids: list[str], kind: str) -> list[dict]:
        missing = [i for i in ids if i not in by_id]
        if missing:
            raise RowError(f'The batch names {kind} rows that were not given: {", ".join(missing)}. Export them with the batch.')
        return [detail(by_id[i]) for i in ids]

    listings = {r['value']['catalog_id']: detail(r) for r in rows if r['value'].get('kind') == 'catalog-listing'}
    request = {'settings': spec.get('settings', {}), 'formats': rows_named(spec['formats'], 'format'),
               'capabilities': rows_named(spec['capabilities'], 'capability'), 'listings': listings}
    if spec.get('index'):
        request['index'] = spec['index']
    return request


def rows_from_request(request: dict, batch: str, row_id: str = '{kind}-{name}', leave_out: tuple = ()) -> list[dict]:
    """The rows that hold a request, the batch named `batch`: what request_from_rows reads back as the same request.
    Each row's value is { kind, title, detail } (and `catalog_id` for a listing); `row_id` names each row from its kind and name.
    `leave_out` names settings the batch row does not hold because the person's settings row holds them."""
    def row(kind: str, name: str, title: str, obj: dict, **more) -> dict:
        return {'id': row_id.format(kind=kind, name=name), 'value': {'kind': kind, 'title': title,
                                                                    'detail': json.dumps(obj, ensure_ascii=False), **more}}
    formats = [row('fill-format', f['id'], f.get('name', f['id']), f) for f in request['formats']]
    capabilities = [row('fill-capability', c['key'], c['id'], c) for c in request['capabilities']]
    listings = [row('catalog-listing', cid.replace(':', '-'), l['listing'].get('title', cid), l, catalog_id=cid)
                for cid, l in request['listings'].items()]
    spec = {'settings': {k: v for k, v in request['settings'].items() if k not in leave_out}, 'formats': [r['id'] for r in formats],
            'capabilities': [r['id'] for r in capabilities]}
    if request.get('index'):
        spec['index'] = request['index']
    return formats + capabilities + listings + [row('fill-batch', batch, batch, spec)]
