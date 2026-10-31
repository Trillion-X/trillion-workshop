"""Running the person's gates over items and recording what they say.

A gate here is a command the person's schema names (`runs.<mode>.command`). It reads one item and prints, as its last line, JSON: `{ "rows": [{ "gate",
"answer", "evidence" }] }`, or `{ "problem": "..." }` (nothing could be judged: no row is recorded) or `{ "not_measured": "..." }` (the gate would have run
on less than the item holds: no row is recorded). This tool records each row with the gate's own answerer name and the gate's pin, so no agent can claim
a gate's row and a row written by a gate that has since changed does not count.
"""
from __future__ import annotations

import json
import os
import subprocess
import sys
from pathlib import Path

from gate_answers import delivery_stage, record_answer, required_pin
from gate_library import Library, locked
from gate_pieces import item_globs, item_id, piece_files


def run_command(lib: Library, piece: Path, mode: dict, **tokens) -> dict:
    argv = [part.format(library=lib.root, piece=piece, python=sys.executable, **tokens) for part in mode['command']]
    run = subprocess.run(argv, capture_output=True, text=True, timeout=mode.get('timeout_s', 900))
    lines = run.stdout.strip().splitlines()
    try:
        return json.loads(lines[-1])
    except (IndexError, ValueError) as exc:
        raise ValueError(f'{" ".join(argv)} exited {run.returncode} and printed no JSON last line: {(run.stderr or run.stdout).strip()[-300:]}') from exc


def record_rows(lib: Library, piece: Path, mode: dict, option: str, result: dict, rows: list[dict]) -> None:
    gates = lib.section('gates')
    by_key = {c['rule_id']: c for c in lib.checks().values() if c.get('rule_id') in gates}
    for row in result['rows']:
        key = row['gate']
        if key not in mode['gates']:
            raise ValueError(f'the command for this run answered for gate {key}, which the schema does not list for it ({", ".join(mode["gates"])})')
        with locked(lib):
            r = record_answer(lib, piece, by_key[key]['id'], row['answer'], row['evidence'], gates[key]['by'], option, machine=True,
                              check_pin=required_pin(lib, piece, by_key[key]['id']))
        rows.append({'option': option, 'check': key, 'answer': r['answer'], 'evidence': row['evidence'][:mode['evidence_chars']]})


def passes(lib: Library, mode: dict, rows: list[dict], at: str) -> bool:
    gates = lib.section('gates')
    by_key = {c['rule_id']: c for c in lib.checks().values() if c.get('rule_id') in gates}
    if not mode.get('advisory_passes'):
        return all(r.get('answer') == 'pass' for r in rows)
    return all(r.get('answer') == 'pass' or (r.get('answer') == 'advisory' and at in by_key[r['check']].get('advisory_passes_at', [])) for r in rows)


def run_lane(lib: Library, piece: Path, lane: Path, options: list[str] | None, at: str | None = None, mode_name: str = 'lane') -> dict:
    """Record the gate rows of each item of a lane folder from the gates' own output, run at delivery stage `at`. An item the command cannot judge is listed, not recorded."""
    piece, lane = piece.expanduser().resolve(), lane.expanduser().resolve()
    at = delivery_stage(lib, at)
    mode = lib.section('runs')[mode_name]
    ids = options or sorted({p.stem for p in lane.glob(mode['item_glob'])})
    rows: list[dict] = []
    for opt in ids:
        result = run_command(lib, piece, mode, lane=lane, item=Path(opt).name, item_id=opt, stage=at)      # a path item id finds its files by file name in the lane
        if 'problem' in result:
            rows.append({'option': opt, 'problem': result['problem']})
        elif 'not_measured' in result:
            rows.append({'option': opt, 'not_measured': result['not_measured']})
        else:
            record_rows(lib, piece, mode, opt, result, rows)
    return {'rows': rows, 'all_passed': passes(lib, mode, rows, at)}


def run_files(lib: Library, piece: Path, files: list[Path], at: str | None = None, mode_name: str = 'files') -> dict:
    """The same for single files the person offers (an audio take): each file must be one the piece offers, and its row is for the file's item id."""
    piece = piece.expanduser().resolve()
    at = delivery_stage(lib, at)
    mode = lib.section('runs')[mode_name]
    offered = {os.path.realpath(p): item_id(lib, piece, p) for p in piece_files(lib, piece)}
    rows: list[dict] = []
    for f in files:
        opt = offered.get(os.path.realpath(f))
        if not opt:
            rows.append({'file': str(f), 'problem': f'not a file {piece.name} offers (offered files match {", ".join(item_globs(lib, piece)) or "nothing"})'})
            continue
        result = run_command(lib, piece, mode, file=Path(f), item=opt, item_id=opt, stage=at)
        if 'problem' in result:
            rows.append({'option': opt, 'problem': result['problem']})
        else:
            record_rows(lib, piece, mode, opt, result, rows)
    return {'rows': rows, 'all_passed': passes(lib, mode, rows, at)}
