#!/usr/bin/env python3
"""A checklist gate: every routed required check of a person's checklist must hold a current passing answer for each item before the item is shown.

  gate PIECE --stage S1[,S2] [--option ID] [--at STAGE]   exit 1 listing every routed required check that is unanswered, stale or failed
  answer PIECE --check ID [--option ID] --answer pass|fail|n/a --evidence TEXT --by NAME
                                                         append one row (a gate's or checker's own name is refused here)
  answers-from-report PIECE --json REPORT [--option ID]   record the rows a checker's --json report settles, check by check
  sweep PIECE --previews DIR [--previews DIR] [--only ID[,ID]]   run the checker over every item of the folders, record, list faults by rule
  run-gates PIECE --lane-dir DIR [--option ID[,ID]] [--at STAGE]  run the schema's gates over a folder's items and record their rows
  run-files PIECE --file PATH [--file PATH] [--at STAGE]          the same for single offered files
  scope PIECE [--lane NAME]                              the items a whole-lane gate must cover: latest round plus live picks
  audit PIECE [--hold] [--file PATH]                      list each linked file whose item has an open or failed required row
  checklist [--check | --write | --problems]              generate the checklist document from the person's text; compare it with the file;
                                                         or check the file on disk for what a typo breaks

Every command takes --library DIR (the library root) and --schema FILE (the JSON file that names the checklist, pieces, checkers and gates; see the
README). Run with: python3 -I do-work/checklist_gate.py --library DIR --schema FILE COMMAND ...
"""
from __future__ import annotations

import argparse
import contextlib
import json
import subprocess
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'read-data'))

import checklist_rows  # noqa: E402
import gate_answers  # noqa: E402
import gate_audit  # noqa: E402
import gate_reports  # noqa: E402
import gate_runs  # noqa: E402
from gate_library import PROGRAM, Library, comma_list  # noqa: E402

UNLOCKED = ('sweep', 'run-gates', 'run-files', 'checklist')      # a sweep runs a checker for minutes: it locks only while it records, so the gate stays answerable


def build_parser() -> argparse.ArgumentParser:
    ap = argparse.ArgumentParser(prog=PROGRAM, description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('--library', required=True, type=Path)
    ap.add_argument('--schema', required=True, type=Path)
    sub = ap.add_subparsers(dest='cmd', required=True)
    g = sub.add_parser('gate')
    g.add_argument('piece', type=Path)
    g.add_argument('--stage', action='append', required=True, help='a stage id, or a comma list of them (repeatable)')
    g.add_argument('--option', action='append', default=[], help='item id or ids (repeatable, comma list); per-item checks are asked for each')
    g.add_argument('--at', help='delivery stage (the checklist\'s delivery_stages); default: the checklist\'s default')
    an = sub.add_parser('answer')
    an.add_argument('piece', type=Path)
    an.add_argument('--check', required=True)
    an.add_argument('--option')
    an.add_argument('--answer', required=True, choices=['pass', 'fail', 'n/a'])
    an.add_argument('--evidence', required=True)
    an.add_argument('--by', required=True)
    fr = sub.add_parser('answers-from-report')
    fr.add_argument('piece', type=Path)
    fr.add_argument('--json', dest='report', required=True, type=Path)
    fr.add_argument('--option')
    fr.add_argument('--by', default=None, help=argparse.SUPPRESS)
    sw = sub.add_parser('sweep')
    sw.add_argument('piece', type=Path)
    sw.add_argument('--previews', action='append', required=True, help='a folder of items, relative to the piece (repeatable)')
    sw.add_argument('--only', help='comma list of item ids to sweep; default every item in the folders')
    rg = sub.add_parser('run-gates')
    rg.add_argument('piece', type=Path)
    rg.add_argument('--lane-dir', type=Path, required=True)
    rg.add_argument('--option', help='comma list of item ids; default every item of the lane')
    rg.add_argument('--at')
    rf = sub.add_parser('run-files')
    rf.add_argument('piece', type=Path)
    rf.add_argument('--file', type=Path, action='append', required=True)
    rf.add_argument('--at')
    sc = sub.add_parser('scope')
    sc.add_argument('piece', type=Path)
    sc.add_argument('--lane')
    au = sub.add_parser('audit')
    au.add_argument('piece', type=Path)
    au.add_argument('--hold', action='store_true')
    au.add_argument('--file', type=Path, action='append')
    ck = sub.add_parser('checklist')
    mode = ck.add_mutually_exclusive_group()
    mode.add_argument('--check', action='store_true', help='write nothing; exit 1, naming the differing checks, when the file is not what the text generates')
    mode.add_argument('--write', action='store_true', help='write the generated document to the checklist file')
    mode.add_argument('--problems', action='store_true', help='check the checklist file on disk for what a typo breaks; exit 1 when it finds any')
    return ap


def run(lib: Library, a: argparse.Namespace):
    if a.cmd == 'gate':
        return gate_answers.gate(lib, a.piece, comma_list(a.stage), comma_list(a.option), a.at)
    if a.cmd == 'answer':
        return gate_answers.record_answer(lib, a.piece, a.check, a.answer, a.evidence, a.by, a.option)
    if a.cmd == 'answers-from-report':
        return gate_reports.answers_from_report(lib, a.piece, a.report, a.option, a.by or lib.section('checkers')['answerer'])
    if a.cmd == 'sweep':
        return gate_reports.sweep(lib, a.piece, a.previews, comma_list([a.only]) if a.only else None)
    if a.cmd == 'run-gates':
        return gate_runs.run_lane(lib, a.piece, a.lane_dir, comma_list([a.option]) if a.option else None, a.at)
    if a.cmd == 'run-files':
        return gate_runs.run_files(lib, a.piece, a.file, a.at)
    if a.cmd == 'scope':
        return gate_audit.scope_options(lib, a.piece, a.lane)
    if a.cmd == 'audit':
        return gate_audit.audit(lib, a.piece, a.hold, a.file)
    path = lib.path_of(lib.schema['checklist'])
    if a.problems:
        problems = checklist_rows.checklist_problems(lib, json.loads(path.read_text(encoding='utf-8')))
        return {'all_passed': not problems, 'problems': problems}
    generated = checklist_rows.generate(lib)
    if a.check:
        difference = checklist_rows.compare(lib, generated, path)
        return {'all_passed': difference is None, **({'difference': difference} if difference else {})}
    if a.write:
        path.write_text(json.dumps(generated, indent=1, ensure_ascii=False), encoding='utf-8')
        return {'written': str(path), 'checks': generated['check_count'], 'must': generated['must_count']}
    return generated


def main(argv: list[str] | None = None) -> int:
    a = build_parser().parse_args(argv)
    with contextlib.ExitStack() as stack:
        try:
            lib = Library(a.library, a.schema)
            if a.cmd not in UNLOCKED:
                stack.enter_context(contextlib.closing(lib.lock()))
            out = run(lib, a)
            print(json.dumps(out, ensure_ascii=False, indent=1))
            return 1 if isinstance(out, dict) and out.get('all_passed') is False else 0
        except (ValueError, KeyError, OSError, json.JSONDecodeError, subprocess.CalledProcessError) as exc:
            print(f'Error: {exc}', file=sys.stderr)
            return 2


if __name__ == '__main__':
    raise SystemExit(main())
