"""Put a records:write payload into a person's account so a re-run writes nothing: read what the account holds, send only what differs,
in commands bounded by count and bytes, each keyed by the BLAKE3 of its records, and stop at the first refusal.

Nothing about any account, list or record kind is known here. The person's config names how to reach their door and the door's
operation names:

  transport         how each operation reaches the door:
                    { "kind": "mcp", "url": "<the door's MCP address>", "credential": { "keychain_item": "<name>" } }: one JSON-RPC
                      `tools/call` of `run_resource_operation` per operation, POSTed to the door, with the key the credential handle
                      names as the Bearer token. The config names the handle, never the key: the key is read from the computer's
                      keychain (the `security` program) when the door is opened, held in memory, sent only in the Authorization
                      header to that address and never written, logged or printed; an answer holding it is refused.
                    { "kind": "call", "argv": [...] }: a program that plays a plan at the door; "{plan}" and "{result}" are replaced
                      by two file paths, and a part starting with ./ or ../ is a path relative to the config file. The plan is
                      { "requests": [{ name, arguments: { address, method, request_key, input } }] }; the program writes one JSON
                      line per step to the result file, { name, is_error, answer }, and may add lines without a name.
  address           the resource the operations are run at (for example "@own-records")
  list_method       the read of one page of records of a type: input { type, limit, after?, prefix? }, answer { records, next }
  write_method      the write: input { records: [{ id, type, value }] } (value null removes the record)
  page_limit        records per page read (a page answer has to fit what the door can return)
  page_shrink_if    optional texts of a refused page read that mean "the page was too big": that page is read again with half the
                    limit, down to one record (a read changes nothing, so reading again is safe); later pages keep the smaller limit
  page_retry_if     optional texts of a refused page read that mean "not now" (the door could not check the key this moment): the
                    same page is read again after page_retry_wait seconds (default 5), at most page_retries times (default 3) a type
  per_command       records per write, at most
  command_bytes     bytes of records (UTF-8 JSON) per write, at most
  request_key_prefix  the start of every request key
  write_halve_if    optional texts of a refused write that mean it took no effect because the command was too big for the door
                    (for example its time ran out): the command is sent as two halves, each with its own key
  write_replay_if   optional texts of a refused write whose effect may have happened: the same command is sent again under the same
                    key (a door answers a repeated key with the first answer), at most write_replays times (default 2), waiting
                    write_replay_wait seconds before each (default 0)
  keep_held         optional, true: a record the account already holds is never written again, whatever its value (a row someone
                    edited after it was first written keeps their edits); only records it lacks are sent

A write's request key is `<prefix>-<first 32 hex of the BLAKE3 of the command's records>`: the same records make the same key, so a door
that answers a repeated key with its first answer never writes them twice. Reads get keys of their own run, so a read is never a replay.
"""
from __future__ import annotations

import json
import os
import shutil
import subprocess
import time
import urllib.error
import urllib.request
from datetime import datetime
from pathlib import Path
from typing import Callable

import records_write
from expressions import slug

CONFIG_KEYS = ('transport', 'address', 'list_method', 'write_method', 'page_limit', 'per_command', 'command_bytes', 'request_key_prefix')
MCP_PROTOCOL = '2025-06-18'
ANSWER_SECONDS = 300


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


def local_time() -> str:
    return datetime.now().astimezone().strftime('%Y-%m-%d %I:%M:%S %p %Z')


def keychain_key(handle: dict) -> str:
    """The key a credential handle names: { keychain_item } is read with the computer's `security` program."""
    item = handle.get('keychain_item') if isinstance(handle, dict) else None
    program = shutil.which('security')
    if not isinstance(item, str) or not item or not program:
        raise ValueError('The credential handle is { "keychain_item": "<name>" } and needs the `security` program.')
    done = subprocess.run([program, 'find-generic-password', '-s', item, '-w'], capture_output=True, text=True)
    key = done.stdout.strip()
    if done.returncode != 0 or not key:
        raise ValueError(f'No key is kept under the keychain item {item}.')
    return key


def checked(config: dict) -> dict:
    missing = [key for key in CONFIG_KEYS if key not in config]
    if missing:
        raise ValueError(f'The config needs {", ".join(missing)}.')
    transport = config['transport']
    kind = transport.get('kind') if isinstance(transport, dict) else None
    if kind == 'mcp':
        if not isinstance(transport.get('url'), str) or not transport['url'].startswith(('http://', 'https://')) or 'credential' not in transport:
            raise ValueError('An mcp transport names the door\'s url (http or https) and a credential handle.')
    elif kind == 'call':
        argv = transport.get('argv')
        if not isinstance(argv, list) or '{plan}' not in argv or '{result}' not in argv:
            raise ValueError('A call transport is an argv list holding "{plan}" and "{result}".')
    else:
        raise ValueError('transport.kind is mcp or call.')
    return config


def answer_of(body: bytes, content_type: str) -> dict:
    """The JSON-RPC reply in a door's answer: the body, or the last `data:` line of a streamed (text/event-stream) answer."""
    text = body.decode('utf-8', 'replace')
    if 'text/event-stream' in content_type:
        text = next((line[len('data:'):].strip() for line in reversed(text.splitlines()) if line.startswith('data:')), '')
    return json.loads(text)


class Door:
    """Operations at the person's door, through the transport the config names; a call program's files are kept in `work`."""

    def __init__(self, config: dict, work: Path, base: Path | None = None, key_of: Callable[[dict], str] = keychain_key):
        self.config = checked(config)
        self.transport = self.config['transport']
        # A part of a call argv starting with ./ or ../ names a file relative to the config file (`base`).
        self.base = base
        self.work = work
        self.work.mkdir(parents=True, exist_ok=True)
        self.key = key_of(self.transport['credential']) if self.transport['kind'] == 'mcp' else None
        self.run = f'{os.getpid()}-{time.time_ns()}'
        self.steps = 0

    def play(self, method: str, request_key: str, input_: dict, address: str | None = None) -> dict:
        """One operation's line, { is_error, answer }, at the config's address unless another is given; a door or program that does not
        answer is refused."""
        self.steps += 1
        arguments = {'address': address or self.config['address'], 'method': method, 'request_key': request_key, 'input': input_}
        return self.post(arguments, method) if self.key is not None else self.call(arguments, method)

    def post(self, arguments: dict, method: str) -> dict:
        # UTF-8 and compact, so the request is the size command_bytes bounded (escaped non-ASCII would be up to six times bigger).
        body = json.dumps({'jsonrpc': '2.0', 'id': self.steps, 'method': 'tools/call', 'params': {'name': 'run_resource_operation', 'arguments': arguments}},
                          ensure_ascii=False, separators=(',', ':')).encode('utf-8')
        request = urllib.request.Request(self.transport['url'], data=body, method='POST', headers={
            'Authorization': f'Bearer {self.key}', 'Content-Type': 'application/json',
            'Accept': 'application/json, text/event-stream', 'MCP-Protocol-Version': MCP_PROTOCOL})
        try:
            with urllib.request.urlopen(request, timeout=ANSWER_SECONDS) as response:
                raw, content_type = response.read(), response.headers.get('Content-Type', '')
        except urllib.error.HTTPError as error:
            # A door that refuses before its answer starts says why in a JSON body under a non-2xx status: that is the answer.
            raw = error.read()
            text = raw.decode('utf-8', 'replace')
            if self.key in text:
                raise ValueError(f'The door\'s answer to {method} held the key; nothing of it is kept.') from None
            try:
                said = json.loads(text)
            except ValueError:
                said = {'body': text[:300]}
            return {'is_error': True, 'answer': {'http_status': error.code, **(said if isinstance(said, dict) else {'body': said})}}
        except (urllib.error.URLError, TimeoutError) as error:
            raise ValueError(f'The door did not answer {method} ({arguments["request_key"]}): {type(error).__name__}') from None
        if self.key in raw.decode('utf-8', 'replace'):
            raise ValueError(f'The door\'s answer to {method} held the key; nothing of it is kept.')
        try:
            reply = answer_of(raw, content_type)
        except ValueError:
            raise ValueError(f'The door\'s answer to {method} ({arguments["request_key"]}) is not JSON-RPC.') from None
        if 'error' in reply:
            return {'is_error': True, 'answer': reply['error']}
        result = reply.get('result') or {}
        return {'is_error': bool(result.get('isError')), 'answer': result.get('structuredContent', result)}

    def call(self, arguments: dict, method: str) -> dict:
        name = f'step-{self.steps}'
        plan, result = self.work / f'{name}.plan.json', self.work / f'{name}.result.jsonl'
        plan.write_text(json.dumps({'requests': [{'name': name, 'arguments': arguments}]}))
        argv = [str((self.base or Path.cwd()) / part) if part.startswith(('./', '../')) else part for part in self.transport['argv']]
        argv = [part.replace('{plan}', str(plan)).replace('{result}', str(result)) for part in argv]
        done = subprocess.run(argv, capture_output=True, text=True)
        lines = [json.loads(line) for line in result.read_text().splitlines() if line.strip()] if result.is_file() else []
        line = next((entry for entry in lines if entry.get('name') == name), None)
        if done.returncode != 0 or line is None:
            raise ValueError(f'The call program did not answer {method} ({arguments["request_key"]}): exit {done.returncode} {done.stderr[-300:]}')
        return line

    def read_type(self, record_type: str, prefix: str | None = None) -> list[dict]:
        """Every record of the type the door lists (only ids starting with prefix, when given), page by page."""
        records, after, page, limit = [], None, 0, self.config['page_limit']
        shrink_if = self.config.get('page_shrink_if', [])
        retry_if, retries, tried = self.config.get('page_retry_if', []), self.config.get('page_retries', 3), 0
        while True:
            page += 1
            input_ = {'type': record_type, 'limit': limit, **({'prefix': prefix} if prefix else {}),
                      **({'after': after} if after is not None else {})}
            key = f'{self.config["request_key_prefix"]}-read-{self.run}-{slug(record_type, 60)}-{page}'
            line = self.play(self.config['list_method'], key, input_)
            answer = line.get('answer') or {}
            if line.get('is_error') or not isinstance(answer.get('records'), list):
                text = json.dumps(answer)
                # A page too big for the door's answer is read again in halves (a read changes nothing).
                if limit > 1 and any(word in text for word in shrink_if):
                    limit //= 2
                    continue
                if tried < retries and any(word in text for word in retry_if):
                    tried += 1
                    time.sleep(self.config.get('page_retry_wait', 5))
                    continue
                raise ValueError(f'Reading {record_type} page {page} was refused: {text[:300]}')
            records += answer['records']
            after = answer.get('next')
            if not after or not answer['records']:
                return records


def records_of(payload: dict) -> list[dict]:
    return [record for command in payload['commands'] for record in command['input']['records']]


def held_by_type(door: Door, records: list[dict]) -> dict[str, dict]:
    """{id: value} the account holds, for every type the records name."""
    held: dict[str, dict] = {}
    for record_type in sorted({record['type'] for record in records if record.get('type')}):
        for record in door.read_type(record_type):
            held[record['id']] = record.get('value')
    return held


def to_write(records: list[dict], held: dict, keep_held: bool = False) -> list[dict]:
    """The records whose value differs from the one held (a removal only when the record is held). With keep_held, a record the
    account already holds is left as it is, whatever its value: someone may have edited it since it was first written."""
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


def plan(door: Door, payload: dict) -> dict:
    """What a send would write, by type, without writing."""
    records = records_of(payload)
    pending = to_write(records, held_by_type(door, records), door.config.get('keep_held', False))
    by_type: dict[str, int] = {}
    for record in pending:
        by_type[record.get('type') or 'removal'] = by_type.get(record.get('type') or 'removal', 0) + 1
    return {'records': len(records), 'to_write': len(pending), 'by_type': by_type,
            'commands': len(write_commands(door.config, pending)) if pending else 0}


def send(door: Door, payload: dict, status_file: Path, log=print) -> dict:
    """Write what differs, command by command, logging each. A command the door answers with a `write_halve_if` text (it took no
    effect, the command was too big for the door's time) is sent as two halves; one answered with a `write_replay_if` text (the
    effect may have happened) is sent again under the same request key, at most `write_replays` times, which recovers its answer.
    Any other refusal stops the run, named in the status file."""
    config = door.config
    halve_if, replay_if, replays = config.get('write_halve_if', []), config.get('write_replay_if', []), config.get('write_replays', 2)
    status = json.loads(status_file.read_text()) if status_file.is_file() else {}
    done = status.setdefault('done', {})
    status.pop('last_refusal', None)
    records = records_of(payload)
    pending = to_write(records, held_by_type(door, records), door.config.get('keep_held', False))
    commands = write_commands(config, pending) if pending else []
    status.update({'state': 'sending', 'to_write': len(pending), 'commands': len(commands), 'written': 0})

    def save():
        status_file.write_text(json.dumps(status, indent=1))

    def put(number: int, batch: list[dict]) -> dict | None:
        """Write one batch (in halves when the door says so); the refusal that stops the run, or None."""
        key = command_key(config, batch)
        for attempt in range(replays + 1):
            line = door.play(config['write_method'], key, {'records': batch})
            text = json.dumps(line.get('answer'))
            if not line.get('is_error'):
                done[key] = {'records': len(batch), 'answer': line.get('answer'), 'at': local_time()}
                status['written'] += len(batch)
                save()
                log(json.dumps({'command': number, 'of': len(commands), 'written': len(batch), 'request_key': key, 'replays': attempt,
                                'total_written': status['written'], 'at': local_time()}))
                return None
            if len(batch) > 1 and any(word in text for word in halve_if):
                log(json.dumps({'command': number, 'halved': len(batch), 'request_key': key, 'at': local_time()}))
                half = len(batch) // 2
                return put(number, batch[:half]) or put(number, batch[half:])
            if not any(word in text for word in replay_if):
                break
            log(json.dumps({'command': number, 'replaying': key, 'at': local_time()}))
            time.sleep(config.get('write_replay_wait', 0))
        return {'command': number, 'request_key': key, 'records': len(batch), 'first_id': batch[0]['id'], 'answer': text[:600]}

    save()
    for number, command in enumerate(commands, 1):
        refusal = put(number, command['input']['records'])
        if refusal:
            status['state'] = 'stopped_on_refusal'
            status['last_refusal'] = refusal
            save()
            log(json.dumps({'command': number, 'of': len(commands), 'refused': True, 'request_key': refusal['request_key'], 'at': local_time()}))
            return status
    status['state'] = 'all_written'
    save()
    return status


def readback(door: Door, payload: dict) -> dict:
    """Per type: the records the payload names, how many the account holds, how many hold the payload's value, and which differ."""
    records = records_of(payload)
    held = held_by_type(door, records)
    out: dict[str, dict] = {}
    for record in records:
        kind = record.get('type') or 'removal'
        entry = out.setdefault(kind, {'payload': 0, 'held': 0, 'equal': 0, 'missing': [], 'differing': []})
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
    return out


def export(door: Door, record_type: str, out_dir: Path, prefix: str | None = None) -> dict:
    """Every record of a type (ids under prefix) into one JSON file: { type, prefix, read_at, count, records }."""
    records = door.read_type(record_type, prefix)
    out_dir.mkdir(parents=True, exist_ok=True)
    name = slug(f'{record_type} {prefix or ""}', 120) + '.json'
    document = {'type': record_type, 'prefix': prefix, 'read_at': local_time(), 'count': len(records), 'records': records}
    (out_dir / name).write_text(json.dumps(document, ensure_ascii=False, indent=1) + '\n')
    return {'file': str(out_dir / name), 'count': len(records)}
