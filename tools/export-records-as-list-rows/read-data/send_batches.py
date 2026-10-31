"""Send the batches an export wrote, one at a time, through a command the person names, keeping a status file so a re-run skips what was sent.

Nothing about any list service is known here. The person's config says what to run and how to read its answers:

  batches_dir      the folder the export wrote (its manifest.json names the batch files, each { list_id, rows })
  order            batch families (the part of a file name before -NNN) in the order to send; default: the manifest's order
  send             { argv: [...], input: {...}, kept_count: "dotted.path" }: the command that puts rows into a list. Its standard input
                   is `input` as JSON with the text "$list_id" and "$rows" replaced by the batch's; its standard output is JSON, and
                   the number kept is the length of the list at `kept_count`
  warm             optional { argv, input }: run before every send (for a list that must be woken before it takes a write)
  retry_if         texts of an error that mean "try the same batch again after a wait"
  halve_if         texts of an error that mean "the batch is too big": send its halves
  waits            seconds to wait before the first send and before each retry (default [3, 3, 5, 5, 10]); after the last, the batch is refused
  status_file      where progress is kept: { state, batches_done: {file: kept}, last_refusal }

A batch is done only when the command kept every row. A refusal stops the run with the status file saying which batch and why.
"""
from __future__ import annotations

import json
import subprocess
import time
from pathlib import Path

DEFAULT_WAITS = [3, 3, 5, 5, 10]


def filled(template, list_id: str, rows: list):
    if template == '$list_id':
        return list_id
    if template == '$rows':
        return rows
    if isinstance(template, dict):
        return {k: filled(v, list_id, rows) for k, v in template.items()}
    return template


def run_command(spec: dict, list_id: str, rows: list) -> subprocess.CompletedProcess:
    return subprocess.run(spec['argv'], input=json.dumps(filled(spec.get('input', {}), list_id, rows)), capture_output=True, text=True)


def kept_in(output: str, path: str) -> int:
    value = json.loads(output)
    for part in path.split('.'):
        value = value[part]
    return len(value)


def send(config: dict, list_id: str, rows: list, wait=time.sleep) -> tuple[int, str]:
    """(rows kept, error text): the batch sent whole, retried after waits, or sent as halves; -1 kept when it was refused."""
    waits = config.get('waits', DEFAULT_WAITS)
    error = ''
    for pause in [0, *waits]:
        wait(pause)
        if 'warm' in config:
            run_command(config['warm'], list_id, rows[:1])
        run = run_command(config['send'], list_id, rows)
        error = (run.stderr + run.stdout[:200]) if run.returncode else ''
        if not error:
            try:
                return kept_in(run.stdout, config['send']['kept_count']), ''
            except (ValueError, KeyError, TypeError):
                return -1, run.stdout[:200]
        if any(text in error for text in config.get('halve_if', [])) and len(rows) > 1:
            half = len(rows) // 2
            first, first_error = send(config, list_id, rows[:half], wait)
            second, second_error = send(config, list_id, rows[half:], wait) if not first_error else (0, first_error)
            return first + second, first_error or second_error
        if not any(text in error for text in config.get('retry_if', [])):
            return -1, error
    return -1, error


def families(config: dict, batches_dir: Path) -> list[str]:
    if 'order' in config:
        return config['order']
    seen: list[str] = []
    for batch in json.loads((batches_dir / 'manifest.json').read_text())['batches']:
        family = batch['file'].rsplit('-', 1)[0]
        if family not in seen:
            seen.append(family)
    return seen


def run(config: dict, batches_dir: Path, status_file: Path, only: list[str] | None = None, wait=time.sleep) -> dict:
    """Send every batch not yet done; returns the status. Stops at the first batch the command does not keep whole."""
    status = json.loads(status_file.read_text()) if status_file.is_file() else {}
    done = status.setdefault('batches_done', {})

    def save():
        status_file.write_text(json.dumps(status, indent=1))

    for family in [f for f in families(config, batches_dir) if not only or f in only]:
        for path in sorted(batches_dir.glob(f'{family}-[0-9][0-9][0-9].json')):
            if path.name in done:
                continue
            batch = json.loads(path.read_text())
            kept, error = send(config, batch['list_id'], batch['rows'], wait)
            if kept != len(batch['rows']):
                status['state'] = 'stopped_on_refusal'
                status['last_refusal'] = {'batch': path.name, 'sent': len(batch['rows']), 'kept': kept, 'error': error[-300:]}
                save()
                return status
            done[path.name] = kept
            save()
    status['state'] = 'all_batches_sent'
    status.pop('last_refusal', None)
    save()
    return status
