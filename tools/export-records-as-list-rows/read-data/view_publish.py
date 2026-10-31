"""Publish what one saved view of a person's list shows into a file a site renders. The view is read by tools/read-a-list-view (the
person's rule-filter tool keeps the rows its rules keep, in the view's order); its answer { list, fields, rows: [{ id, values }], next,
complete, of } is what is published here, so this file never reads the person's door. The file's key is the BLAKE3 of what it holds, so a
publish that would write the same rows writes nothing. A read that holds only part of the view (a next page, or complete false)
publishes nothing.

Nothing about any list, view or field is known here. The person's config names:

  view              the saved view's record id, kept in the file as where its rows came from
  media             optional { fields, from: [{ prefix, folder }], into, served_at, public_field?, not_public? }: the pictures and
                    recordings a published row names are carried into the site's own static files, so a page never points at a
                    place that may go away. In each named field (an address, an object with `src`, or that object as JSON text)
                    an address starting with a `from` prefix is read from that entry's folder on this computer (the rest of the
                    address is the file's path there), copied into `into` as <BLAKE3 of its bytes>.<its extension> and named in
                    the row as `served_at` plus that name. A file already there under its name holds the same bytes, so it is
                    never copied again. An address no prefix matches is left as it is; one whose file is missing publishes
                    nothing. `public_field` names the row's own field that says whether its media may be public, and
                    `not_public` the values of it that say no (a row without a value is public): such a row's media is not
                    copied and its named fields are published empty (null), while the rest of the row is published as it is.

The file: { schema, source: { view, list, blake3 }, fields, rows: [{ id, values }] }. `fields` are the list's, `rows` are the rows the
view keeps in the view's order, each with its whole value (media addresses rewritten as above).
"""
from __future__ import annotations

import json
from pathlib import Path

from record_write_send import blake3_hex, canonical

SCHEMA = 'list-view-file/v1'


def checked(config: dict) -> dict:
    if not isinstance(config.get('view'), str) or not config['view']:
        raise ValueError('The publish config needs view: the saved view\'s record id.')
    media = config.get('media')
    if media is not None and not (
            isinstance(media.get('fields'), list) and isinstance(media.get('into'), str) and isinstance(media.get('served_at'), str)
            and isinstance(media.get('from'), list) and isinstance(media.get('public_field', ''), str)
            and isinstance(media.get('not_public', []), list)
            and all(isinstance(entry.get('prefix'), str) and entry['prefix'] and isinstance(entry.get('folder'), str) for entry in media['from'])):
        raise ValueError('media is { fields, from: [{ prefix, folder }], into, served_at, public_field?, not_public? }.')
    return config


def carried(address: str, row_id: str, media: dict, base: Path, counts: dict) -> str:
    """The site's own address for a media address a `from` prefix matches (its file copied in when not there yet), else the address."""
    source = next((entry for entry in media['from'] if address.startswith(entry['prefix'])), None)
    if source is None:
        return address
    path = base / source['folder'] / address[len(source['prefix']):]
    if not path.is_file():
        raise ValueError(f'{row_id} names {address}, but {path} is not there, so nothing is published.')
    data = path.read_bytes()
    name = f'{blake3_hex(data)}{path.suffix.lower()}'
    target = base / media['into'] / name
    if target.is_file():
        counts['kept'] += 1
    else:
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_bytes(data)
        counts['copied'] += 1
    return f'{media["served_at"]}{name}'


def with_media(value, row_id: str, media: dict, base: Path, counts: dict):
    """One field's value with its media addresses carried: an address, an object with `src`, or that object as JSON text."""
    if isinstance(value, str) and value.lstrip().startswith('{'):
        try:
            parsed = json.loads(value)
        except ValueError:
            return value
        return json.dumps(with_media(parsed, row_id, media, base, counts), ensure_ascii=False) if isinstance(parsed, dict) else value
    if isinstance(value, dict) and isinstance(value.get('src'), str):
        return {**value, 'src': carried(value['src'], row_id, media, base, counts)}
    if isinstance(value, str):
        return carried(value, row_id, media, base, counts)
    return value


def publish(read: dict, config: dict, out: Path, base: Path | None = None) -> dict:
    """`read` is tools/read-a-list-view's answer for the config's view; `base` is the folder the config's media folders are relative to
    (the config file's own folder)."""
    config = checked(config)
    base = base or Path.cwd()
    if not isinstance(read, dict) or not isinstance(read.get('list'), str) or not isinstance(read.get('fields'), list) \
            or not isinstance(read.get('rows'), list):
        raise ValueError('The read is { list, fields, rows: [{ id, values }], next, complete }: read-a-list-view\'s answer.')
    if read.get('next') is not None or read.get('complete') is not True:
        raise ValueError('The read holds only part of the view (a next page, or complete false), so nothing is published.')
    list_id = read['list']
    shown = [{'id': row['id'], 'values': row['values']} for row in read['rows']]
    counts = {'copied': 0, 'kept': 0, 'not_public': 0}
    media = config.get('media')
    if media:
        for row in shown:
            if media.get('public_field') and row['values'].get(media['public_field']) in media.get('not_public', ()):
                counts['not_public'] += 1
                row['values'] = {name: None if name in media['fields'] else value for name, value in row['values'].items()}
                continue
            row['values'] = {name: with_media(value, row['id'], media, base, counts) if name in media['fields'] else value
                             for name, value in row['values'].items()}
    body = {'fields': read['fields'], 'rows': shown}
    key = blake3_hex(canonical(body))
    result = {'file': str(out), 'rows': len(shown), 'of': read.get('of'), 'blake3': key, 'media': counts}
    if out.is_file():
        try:
            if json.loads(out.read_text()).get('source', {}).get('blake3') == key:
                return {**result, 'written': False}
        except ValueError:
            pass
    document = {'schema': SCHEMA, 'source': {'view': config['view'], 'list': list_id, 'blake3': key}, **body}
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(json.dumps(document, ensure_ascii=False, indent=1) + '\n')
    return {**result, 'written': True}
