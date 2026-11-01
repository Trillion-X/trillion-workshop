#!/usr/bin/env python3
"""Run the existing checklist gate in the caller's granted library folder.

The computer row sends {input, task} on stdin. This adapter binds the library path to the folder grant, parses the
user's command as arguments (never as shell text), and calls checklist_gate.main in this same process. The default row
allows read-only commands; a second row may pass --allow-writes only when it declares change-a-folder.
"""
from __future__ import annotations

import contextlib
import io
import json
import os
import shlex
import sys
from pathlib import Path

# Isolated Python omits the script directory from sys.path. Load only the
# sibling maintained CLI shipped in this same immutable tool package.
sys.path.insert(0, str(Path(__file__).resolve().parent))
from checklist_gate import main as gate_main


READ_ONLY_COMMANDS = {'gate', 'scope', 'audit', 'checklist', 'library-pending'}
WRITE_COMMANDS = {'answer', 'answers-from-report', 'sweep', 'run-gates', 'run-files', 'library-assess', 'library-remove'}
ALL_COMMANDS = READ_ONLY_COMMANDS | WRITE_COMMANDS


def arguments(payload: dict, allow_writes: bool) -> list[str]:
    """Validate the scoped folder and return the checklist consumer's argv."""
    inputs = payload.get('input')
    task = payload.get('task')
    if not isinstance(inputs, dict) or not isinstance(task, dict):
        raise ValueError('expected input and task objects')

    capability = 'change-a-folder' if allow_writes else 'read-a-folder'
    grant = task.get('grants', {}).get(capability, {})
    granted_folder = grant.get('folder') if isinstance(grant, dict) else None
    if not isinstance(granted_folder, str) or not granted_folder:
        raise ValueError(f'the {capability} folder grant is missing')
    granted_root = Path(granted_folder).expanduser().resolve(strict=True)
    if not granted_root.is_dir():
        raise ValueError('the granted library is not a folder')

    supplied_library = inputs.get('library')
    if supplied_library is None:
        root = granted_root
    else:
        if not isinstance(supplied_library, str):
            raise ValueError('library must be inside the folder granted to this run')
        library_path = Path(supplied_library).expanduser()
        root = (library_path if library_path.is_absolute() else granted_root / library_path).resolve(strict=True)
        try:
            root.relative_to(granted_root)
        except ValueError as exc:
            raise ValueError('library must be inside the folder granted to this run') from exc
    if not root.is_dir():
        raise ValueError('library must be a folder')

    schema = inputs.get('schema')
    if not isinstance(schema, str) or not schema.strip():
        raise ValueError('schema must name a JSON file inside the granted library')
    schema_path = Path(schema).expanduser()
    schema_path = (schema_path if schema_path.is_absolute() else granted_root / schema_path).resolve(strict=True)
    try:
        schema_path.relative_to(granted_root)
    except ValueError as exc:
        raise ValueError('schema must be inside the granted folder') from exc
    if not schema_path.is_file():
        raise ValueError('schema must name a file')

    command = inputs.get('command')
    if not isinstance(command, str) or not command.strip():
        raise ValueError('command must be a checklist-gate command')
    try:
        words = shlex.split(command)
    except ValueError as exc:
        raise ValueError(f'command quoting is invalid: {exc}') from exc
    if not words or words[0] not in ALL_COMMANDS:
        raise ValueError('command must start with a supported checklist-gate command')
    if not allow_writes:
        if words[0] not in READ_ONLY_COMMANDS:
            raise ValueError(f'{words[0]} changes the library; use the write-grant checklist tool')
        if words[0] == 'audit' and '--hold' in words[1:]:
            raise ValueError('audit --hold changes the library; use the write-grant checklist tool')
        if words[0] == 'checklist' and '--write' in words[1:]:
            raise ValueError('checklist --write changes the library; use the write-grant checklist tool')
    elif words[0] not in WRITE_COMMANDS and not (
            words[0] == 'audit' and '--hold' in words[1:] or words[0] == 'checklist' and '--write' in words[1:]):
        raise ValueError('the write-grant tool requires a command that changes the library')

    argv = ['--library', str(root), '--schema', str(schema_path)]
    if not allow_writes:
        argv.append('--read-only')
    return [*argv, *words]


def execute(payload: dict, allow_writes: bool = False) -> dict:
    """Call the shared checklist consumer and return its JSON result plus its status."""
    argv = arguments(payload, allow_writes)
    root = Path(argv[1])
    stdout = io.StringIO()
    stderr = io.StringIO()
    old_cwd = Path.cwd()
    try:
        os.chdir(root)
        with contextlib.redirect_stdout(stdout), contextlib.redirect_stderr(stderr):
            try:
                exit_code = gate_main(argv)
            except SystemExit as exc:
                exit_code = exc.code if isinstance(exc.code, int) else 2
    finally:
        os.chdir(old_cwd)
    try:
        result = json.loads(stdout.getvalue())
    except json.JSONDecodeError:
        if exit_code:
            return {'error': stderr.getvalue().strip() or stdout.getvalue().strip() or 'checklist gate failed', 'exit_code': exit_code}
        raise ValueError('checklist gate did not return JSON')
    if isinstance(result, dict):
        # The CLI's answer_with paths point at sys.argv[0]. A native run's package copy is private and removed when
        # it ends, so do not present those temporary paths as commands a person can run later.
        for key in ('unanswered_must', 'failed_must', 'waits_for_person_picked_design', 'advisory'):
            for row in result.get(key, []):
                if isinstance(row, dict):
                    row.pop('answer_with', None)
    answer = {'result': result, 'exit_code': exit_code}
    if stderr.getvalue().strip():
        answer['stderr'] = stderr.getvalue().strip()
    return answer


def main() -> int:
    args = sys.argv[1:]
    allow_writes = len(args) == 2 and args[1] == '--allow-writes'
    try:
        if not args or (len(args) > 1 and not allow_writes):
            raise ValueError('expected the granted folder path')
        capability = 'change-a-folder' if allow_writes else 'read-a-folder'
        payload = {
            'input': json.load(sys.stdin),
            'task': {'grants': {capability: {'folder': args[0]}}},
        }
        answer = execute(payload, allow_writes)
    except (OSError, TypeError, ValueError, json.JSONDecodeError) as exc:
        answer = {'error': str(exc), 'exit_code': 2}
    print(json.dumps(answer, ensure_ascii=False, separators=(',', ':')))
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
