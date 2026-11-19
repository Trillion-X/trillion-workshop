"""Work out which prepared records a person's account lacks, and check the account against them after they are written.

Nothing here reaches an account. The caller reads the target records its own store holds, in that store's own language, and hands
them in as `held`. The plan says what to write, in commands bounded by count and bytes, each keyed by the BLAKE3 of its records; the
caller writes each command into its store itself, then hands the target records back for a readback.

Input (one JSON object; do-work/plan_record_write.py reads it on standard input):
  payload        the builder's result: { commands: [{ input: { records: [{ id, type, value }] } }] }
  target_type    the one record type this plan covers; a record of another type or prefix is out of scope, counted, never written
  target_prefix  the record id prefix this plan covers
  held           [{ id, type, value }]: the target records the store holds now; any other type or prefix is refused
  config         { per_command, command_bytes, request_key_prefix, keep_held? }
                   per_command, command_bytes   at most this many records, and this many UTF-8 JSON bytes of records, in one command
                   request_key_prefix           the start of every command's request key
                   keep_held (optional, true)   a record the store already holds is never written again, whatever its value (a row
                                                someone edited after it was first written keeps their edits)
  baseline       optional: the previous imported payload. A source field changes only where the live value still equals the baseline;
                 live edits and deletions are kept, and each conflict is named by id and field path, never by value.
  mode           read by the command line only: "plan" (what to write) or "readback" (what the store holds after the writes)

A command's request key is `<request_key_prefix>-<first 32 hex of the BLAKE3 of its records>`: the same records make the same key, so a
write that is replayed under its key is the same write. A record of a baseline refresh carries `expected`: { type, value } is the value
the store must still hold (null when it holds none). The store's write checks it atomically and refuses any other value, so a concurrent
edit is never overwritten.
"""
from __future__ import annotations

import json
import shutil
import subprocess
from copy import deepcopy

import records_write

_MISSING = object()


def canonical(value) -> bytes:
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(',', ':')).encode('utf-8')


def blake3_hex(data: bytes) -> str:
    """BLAKE3-256 of the bytes: the blake3 module when installed, else the b3sum command. Refuses when neither exists."""
    try:
        import blake3  # type: ignore
        return blake3.blake3(data).hexdigest()
    except ImportError:
        program = shutil.which('b3sum')
        if not program:
            raise ValueError('A request key is BLAKE3: install the python module (pip install blake3) or the b3sum command.')
        return subprocess.run([program, '--no-names', '-'], input=data, capture_output=True, check=True).stdout.decode().strip()


def checked(config) -> dict:
    if not isinstance(config, dict):
        raise ValueError('config is an object: per_command, command_bytes and request_key_prefix.')
    missing = [key for key in ('per_command', 'command_bytes', 'request_key_prefix') if key not in config]
    if missing:
        raise ValueError(f'The config needs {", ".join(missing)}.')
    for key in ('per_command', 'command_bytes'):
        if not isinstance(config[key], int) or isinstance(config[key], bool) or config[key] < 1:
            raise ValueError(f'{key} is a whole number of at least 1.')
    if not isinstance(config['request_key_prefix'], str) or not config['request_key_prefix']:
        raise ValueError('request_key_prefix is text.')
    if 'keep_held' in config and not isinstance(config['keep_held'], bool):
        raise ValueError('keep_held is true or false.')
    return config


def records_of(payload) -> list[dict]:
    if not isinstance(payload, dict) or not isinstance(payload.get('commands'), list):
        raise ValueError('A payload is { commands: [...] } as the builder gives it.')
    return [record for command in payload['commands'] for record in command['input']['records']]


def scoped(payload, target_type: str, target_prefix: str) -> tuple[list[dict], int]:
    """The payload's records of the target type and prefix, in order, and how many records are out of scope."""
    if not isinstance(target_type, str) or not target_type or not isinstance(target_prefix, str) or not target_prefix:
        raise ValueError('Give the exact target_type and target_prefix this plan covers.')
    ids: set[str] = set()
    inside: list[dict] = []
    outside = 0
    for record in records_of(payload):
        if (not isinstance(record, dict) or not isinstance(record.get('id'), str) or not record['id']
                or not isinstance(record.get('type'), str) or not record['type'] or 'value' not in record):
            raise ValueError('Every record needs id, type and value.')
        if record['id'] in ids:
            raise ValueError('The payload has duplicate record ids.')
        ids.add(record['id'])
        if record['type'] == target_type and record['id'].startswith(target_prefix):
            inside.append(record)
        else:
            outside += 1
    return inside, outside


def held_values(held, target_type: str, target_prefix: str) -> dict[str, object]:
    """{id: value} of the target records the store holds. A record outside the target type and prefix is refused, never ignored."""
    if not isinstance(held, list):
        raise ValueError('held is a list of { id, type, value } records: the target records the store holds now.')
    values: dict[str, object] = {}
    for record in held:
        if (not isinstance(record, dict) or not isinstance(record.get('id'), str) or 'value' not in record
                or record.get('type') != target_type or not record['id'].startswith(target_prefix)):
            raise ValueError('A held record is malformed or outside the target type and prefix; only the target records are read.')
        if record['id'] in values:
            raise ValueError('held holds a duplicate record id.')
        values[record['id']] = record['value']
    return values


def same(left, right) -> bool:
    return left is right or (left is not _MISSING and right is not _MISSING and canonical(left) == canonical(right))


def refresh_records(records: list[dict], baseline: dict, held: dict) -> tuple[list[dict], list[dict]]:
    """Three-way source refresh. Live edits/deletions win, with conflicts reported by id/path (never private values).

    A source field can change or disappear only while the live field still equals the previous import. Nested maps are
    merged independently, including basis maps. A field whose live edit is retained also retains its own live basis.
    """
    previous = {record['id']: record for record in records_of(baseline)}
    if len(previous) != len(records_of(baseline)):
        raise ValueError('The baseline has duplicate record ids.')
    if len({record['id'] for record in records}) != len(records):
        raise ValueError('The refresh payload has duplicate record ids.')
    if any('expected' in record for record in records):
        raise ValueError('A source refresh takes fresh unconditioned records; retain original conditioned commands unchanged.')
    conflicts, refreshed = [], []

    def merge(old, new, live, record_id, path=()):
        if same(new, old) or same(new, live):
            return live
        if same(live, old):
            return new
        if isinstance(new, dict) and isinstance(live, dict) and (isinstance(old, dict) or old is _MISSING):
            old = {} if old is _MISSING else old
            result = dict(live)
            for key in sorted(set(old) | set(new)):
                value = merge(old.get(key, _MISSING), new.get(key, _MISSING), live.get(key, _MISSING), record_id, (*path, key))
                if value is _MISSING:
                    result.pop(key, None)
                else:
                    result[key] = value
            return result
        conflicts.append({'id': record_id, 'path': list(path), 'reason': 'live_changed'})
        return live

    for record in records:
        rid = record['id']
        base = previous.get(rid)
        if base and base.get('type') != record.get('type'):
            raise ValueError(f'{rid} changes type from its baseline; refusing a refresh across types.')
        old = base['value'] if base and base['value'] is not None else _MISSING
        live = held.get(rid, _MISSING)
        desired = record['value']
        if live is _MISSING and old is not _MISSING and old is not None and desired is not None:
            conflicts.append({'id': rid, 'path': [], 'reason': 'live_deleted'})
            continue
        # A whole-record removal is safe only when an actual baseline matches the live record.
        if desired is None:
            if live is _MISSING:
                continue
            if old is not _MISSING and same(live, old):
                refreshed.append(record)
            else:
                conflicts.append({'id': rid, 'path': [], 'reason': 'unsafe_removal'})
            continue
        result = merge(old, desired, live, rid)
        if result is _MISSING:
            continue
        # A retained value must never acquire the source's attribution for a rejected source edit.
        if isinstance(result, dict) and isinstance(live, dict) and isinstance(desired, dict):
            basis = dict(result.get('_basis') or {})
            retained = set()
            for field in set(desired) | (set(old) if isinstance(old, dict) else set()):
                if field == '_basis' or same(result.get(field, _MISSING), desired.get(field, _MISSING)):
                    continue
                retained.add(field)
                live_basis = (live.get('_basis') or {}).get(field, _MISSING)
                if live_basis is _MISSING:
                    basis.pop(field, None)
                else:
                    basis[field] = live_basis
            if basis or '_basis' in result:
                result['_basis'] = basis
            conflicts[:] = [c for c in conflicts if c['id'] != rid or len(c['path']) < 2 or
                            c['path'][0] != '_basis' or c['path'][1] not in retained]
        refreshed.append({**record, 'value': result})
    return refreshed, conflicts


def prepared(request: dict) -> tuple[list[dict], dict, list[dict], int, int]:
    """(records to compare, held values, conflicts, out-of-scope count, in-scope count) for one request."""
    config = checked(request.get('config'))
    baseline = request.get('baseline')
    if baseline is not None and config.get('keep_held', False):
        raise ValueError('baseline and keep_held cannot be combined: choose a source refresh or an add-only import.')
    records, outside = scoped(request.get('payload'), request.get('target_type'), request.get('target_prefix'))
    held = held_values(request.get('held', []), request['target_type'], request['target_prefix'])
    count = len(records)
    if baseline is None:
        return records, held, [], outside, count
    refreshed, conflicts = refresh_records(records, baseline, held)
    # The value each record must still hold when the store writes it: the held value now, or none.
    records = [{**record, 'expected': {'type': request['target_type'], 'value': deepcopy(held[record['id']])}
                if record['id'] in held else None} for record in refreshed]
    return records, held, conflicts, outside, count


def to_write(records: list[dict], held: dict, keep_held: bool = False) -> list[dict]:
    """The records whose value differs from the one held (a removal only when the record is held). With keep_held, a record the
    store already holds is left as it is, whatever its value: someone may have edited it since it was first written."""
    out = []
    for record in records:
        if keep_held and record['id'] in held:
            continue
        if record['value'] is None:
            if record['id'] in held:
                out.append(record)
        elif record['id'] not in held or canonical(held[record['id']]) != canonical(record['value']):
            out.append(record)
    return out


def command_key(config: dict, records: list[dict]) -> str:
    """The request key of a write: the prefix and the first 32 hex of the BLAKE3 of its records."""
    return f'{config["request_key_prefix"]}-{blake3_hex(canonical(records))[:32]}'


def write_commands(config: dict, records: list[dict]) -> list[dict]:
    """Byte- and count-bounded commands, each with its content-keyed request key."""
    commands = records_write.commands_of(records, {'per_command': config['per_command'], 'command_bytes': config['command_bytes']})
    for command in commands:
        command['request_key'] = command_key(config, command['input']['records'])
    return commands


def plan(request: dict) -> dict:
    """What the store must write: the commands, in order, and the counts. Writes nothing."""
    config = checked(request.get('config'))
    records, held, conflicts, outside, count = prepared(request)
    pending = to_write(records, held, config.get('keep_held', False))
    commands = write_commands(config, pending) if pending else []
    answer = {'state': 'to_write' if commands else 'nothing_to_write', 'records': count, 'to_write': len(pending),
              'commands': commands, 'out_of_scope': outside}
    if request.get('baseline') is not None:
        answer['conflicts'] = conflicts
    return answer


def readback(request: dict) -> dict:
    """The target records the store holds after the writes, compared with the payload: the counts, and each record that is missing
    or holds another value. A conflict from a baseline refresh keeps the state from being all_equal."""
    checked(request.get('config'))
    records, held, conflicts, outside, count = prepared(request)
    entry = {'payload': 0, 'held': 0, 'equal': 0, 'missing': [], 'differing': []}
    for record in records:
        entry['payload'] += 1
        if record['value'] is None:
            entry['equal'] += record['id'] not in held
            continue
        if record['id'] not in held:
            entry['missing'].append(record['id'])
            continue
        entry['held'] += 1
        if canonical(held[record['id']]) == canonical(record['value']):
            entry['equal'] += 1
        else:
            entry['differing'].append(record['id'])
    equal = entry['equal'] == entry['payload'] and not conflicts
    return {'state': 'all_equal' if equal else 'readback_differs', 'records': count, 'readback': {request['target_type']: entry},
            'out_of_scope': outside, 'conflicts': conflicts}
