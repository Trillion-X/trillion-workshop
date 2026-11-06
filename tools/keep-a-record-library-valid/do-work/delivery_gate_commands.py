"""The delivery gate's commands of keep_a_record_library.py: their arguments and how each runs (read-data/delivery_gate.py).

Moved from trillion-launch-video tools/content-investigation/cis.py main() (its gate, answer, sweep, scope-options, audit-watch,
content-gates, audition-gates and answer-from-filmqa parsers and their dispatch), one to one; answer-from-filmqa is answer-from-render-check.
"""
from __future__ import annotations

import argparse
from pathlib import Path

import delivery_gate
from delivery_gate import comma_list, gate_cfg

COMMANDS = ('gate', 'answer', 'answer-from-render-check', 'sweep', 'content-gates', 'audition-gates', 'audit-watch', 'scope-options')
LOCKED = ('gate', 'answer', 'answer-from-render-check', 'audit-watch', 'scope-options')      # a sweep and the content gates lock only while they record


def add_options(ap: argparse.ArgumentParser) -> None:
    """The run's own inputs: the person's records door (the copy check reads their branch through it), the render check's limits and more copy check arguments."""
    ap.add_argument('--door-records', help='the delivery gate: a stand-in records file the copy check reads the person\'s branch from')
    ap.add_argument('--door-mcp', help='the delivery gate: the MCP client argv (JSON) of the person\'s records door')
    ap.add_argument('--render-check-limits', type=Path, help='the delivery gate: the render check\'s limits file (default delivery_gate.render_check.limits)')
    ap.add_argument('--copy-check-arg', action='append', default=[], metavar='ARG', help='the delivery gate: one more copy check argument, such as --no-model or --decider-python=P (repeatable)')


def run_options(a: argparse.Namespace) -> dict:
    if a.door_records and a.door_mcp:
        raise ValueError('give one of --door-records or --door-mcp')
    return {'door': ['--door-records', a.door_records] if a.door_records else ['--door-mcp', a.door_mcp] if a.door_mcp else None,
            'limits': a.render_check_limits, 'checker_args': [x for arg in a.copy_check_arg for x in arg.split('=', 1)]}


def add_commands(sub) -> None:
    g = sub.add_parser('gate', help='Exit 1 listing every routed MUST check of the stages that is unanswered or failed; starts investigation.json when missing')
    g.add_argument('piece', type=Path)
    g.add_argument('--stage', action='append', required=True, help='S5 or S5,S6 (repeatable)')
    g.add_argument('--option', action='append', default=[], help='option id or ids (repeatable, comma list); per-option checks are asked for each')
    g.add_argument('--at', help='delivery stage (the checklist delivery_stages): review for a watch folder or PICK file, final for apply, release or publish; default its default_delivery_stage')
    an = sub.add_parser('answer', help='Record one checklist answer in the piece\'s answers file')
    an.add_argument('piece', type=Path)
    an.add_argument('--check', required=True)
    an.add_argument('--option')
    an.add_argument('--answer', required=True, choices=['pass', 'fail', 'n/a'])
    an.add_argument('--evidence', required=True)
    an.add_argument('--by', required=True)
    sw = sub.add_parser('sweep', help='Run every render-check rule class over every option of the given preview folders (current round plus picks), record the results, list faults by rule; run before anything goes to a watch folder')
    sw.add_argument('piece', type=Path)
    sw.add_argument('--previews', action='append', required=True, help='a folder of previews, relative to the piece (repeatable)')
    sw.add_argument('--only', help='comma list of option ids to sweep (for example the picks in an older round); default every option in the folders')
    so = sub.add_parser('scope-options', help='Option ids a whole-lane gate covers: each lane\'s latest round plus live picks (used by the publish guard)')
    so.add_argument('piece', type=Path)
    so.add_argument('--lane')
    aw = sub.add_parser('audit-watch', help='List every file linked into a watch folder whose option has an open or failed MUST row; --hold moves those links to the lane\'s held-back folder')
    aw.add_argument('piece', type=Path)
    aw.add_argument('--hold', action='store_true')
    aw.add_argument('--file', type=Path, action='append', help='audit exactly this file (repeatable): one about to be opened, played or linked for the person, instead of the watch folders')
    cg = sub.add_parser('content-gates', help='Run the copy check, the person\'s verdict rows and the fact gate on each option of a lane folder and record their rows (by the gates\' own names)')
    cg.add_argument('piece', type=Path)
    cg.add_argument('--lane-dir', type=Path, required=True, help='the lane folder (its specs, previews and fact folders)')
    cg.add_argument('--option', help='comma list of option ids; default every preview of the lane')
    cg.add_argument('--at', help='delivery stage (the checklist delivery_stages) the gates run at; default its default_delivery_stage')
    ag = sub.add_parser('audition-gates', help='Measure each audio-only audition file against the audition marks and run the person\'s verdict rows on its take; record both rows')
    ag.add_argument('piece', type=Path)
    ag.add_argument('--file', type=Path, action='append', required=True, help='an audition file under the film (repeatable)')
    ag.add_argument('--at', help='delivery stage (the checklist delivery_stages); default its default_delivery_stage')
    fq = sub.add_parser('answer-from-render-check', help='Record the answers a check-a-rendered-video --json report settles')
    fq.add_argument('piece', type=Path)
    fq.add_argument('--json', dest='report', required=True, type=Path)
    fq.add_argument('--option', help='option id (default: each preview file name without extension)')
    fq.add_argument('--by', default=None, help=argparse.SUPPRESS)


def run(store, a: argparse.Namespace):
    store.gate_run = run_options(a)
    if a.cmd == 'gate':
        out = delivery_gate.gate(store, a.piece, comma_list(a.stage), comma_list(a.option), a.at)
    elif a.cmd == 'answer':
        out = delivery_gate.record_answer(store, a.piece, a.check, a.answer, a.evidence, a.by, a.option)
    elif a.cmd == 'sweep':
        out = delivery_gate.sweep(store, a.piece, a.previews, comma_list([a.only]) if a.only else None)
    elif a.cmd == 'scope-options':
        out = delivery_gate.scope_options(store, a.piece, a.lane)
    elif a.cmd == 'audit-watch':
        out = delivery_gate.audit_watch(store, a.piece, a.hold, a.file)
    elif a.cmd == 'content-gates':
        out = delivery_gate.content_gates(store, a.piece, a.lane_dir, comma_list([a.option]) if a.option else None, a.at)
    elif a.cmd == 'audition-gates':
        out = delivery_gate.audition_gates(store, a.piece, a.file, a.at)
    else:
        out = delivery_gate.answers_from_render_check(store, a.piece, a.report, a.option, a.by or gate_cfg(store)['machine_by'])
    return out
