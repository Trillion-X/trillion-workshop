"""The answers to a checklist and the gate over them.

Answers are rows in an append-only file in the piece (`{ check_id, option_id, answer, evidence, by, at, file_pins, check_pin }`); the newest row for a
check and item stands. A row pins the BLAKE3 of the files it judged, so a row on other bytes is stale. Checks that a checker answers (a measuring
tool, a gate) count only on that checker's own rows, and only when the row carries the reviewed pin of the checker that produced it. The gate says which
routed required checks of the chosen stages still lack a current passing row.
"""
from __future__ import annotations

import json
import math
import subprocess
import sys
from datetime import datetime
from pathlib import Path

from gate_library import Library, blake3_of, now, phase_check_id, read_json
from gate_pieces import config_value, file_pins, header_tags, item_files, parse_header, route_applies, routing



# --------------------------------------------------------------------------- who answers what

def machine_names(lib: Library) -> set[str]:
    """The answerer names that only a checker or gate may use: the report checker, the sweep and every gate."""
    checkers = lib.section('checkers')
    return {checkers['answerer'], checkers['sweep']['by'], *(g['by'] for g in lib.section('gates').values())}


def machine_checks(lib: Library) -> set[str]:
    """Check ids a checker answers (the rules named in the checker's report mapping and unmapped rules, the sweep rule and the gates). Only that checker's rows count for them."""
    checkers = lib.section('checkers')
    rules = {e if isinstance(e, str) else e['rule'] for entries in checkers['report_checks'].values() for e in entries}
    rules |= set(checkers.get('report_unmapped_rule', {}).values())
    rules.add(checkers['sweep']['rule'])
    rules |= set(lib.section('gates'))
    return {c['id'] for c in lib.checks().values() if c.get('rule_id') in rules}


def rule_to_report_check(lib: Library) -> dict[str, str]:
    """{rule id: the checker's check that answers it}."""
    checkers = lib.section('checkers')
    out = {(e if isinstance(e, str) else e['rule']): name for name, entries in checkers['report_checks'].items() for e in entries}
    out.update({rule: name for name, rule in checkers.get('report_unmapped_rule', {}).items()})
    return out


def gate_pin(lib: Library, piece: Path, key: str) -> str:
    """BLAKE3 of a gate's own code and rows (the files the schema names for it): a row counts only while the gate that produced it is unchanged."""
    files = []
    for entry in lib.section('gates')[key]['pin_files']:
        if isinstance(entry, dict):
            entry = config_value(lib, piece, entry['piece_config']) or entry['default']
        files.append(lib.path_of(entry))
    return blake3_of(b'\0'.join(p.read_bytes() for p in files if p.is_file()))


def required_pin(lib: Library, piece: Path, check_id: str) -> str | None:
    """The reviewed pin a machine answer to this check must carry: its checker check's own pin, the sweep's, or its gate's."""
    checkers = lib.section('checkers')
    rule = lib.checks()[check_id].get('rule_id')
    if rule == checkers['sweep']['rule']:
        return checkers['sweep']['pin']
    if rule in lib.section('gates'):
        return gate_pin(lib, piece, rule)
    return checkers['report_pins'].get(rule_to_report_check(lib).get(rule))


# --------------------------------------------------------------------------- the answers file

def answers_file(lib: Library, piece: Path) -> Path:
    return piece.expanduser().resolve() / lib.section('piece')['answers_file']


def read_answers(lib: Library, piece: Path, machine: bool | None = None) -> dict[tuple[str, str | None], dict]:
    """The newest row for each (check_id, option_id). The file is append-only; a later row replaces an earlier one.
    machine=True keeps only the checkers' own rows, machine=False only the others, None all."""
    path = answers_file(lib, piece)
    names = machine_names(lib)
    rows: dict[tuple[str, str | None], dict] = {}
    if path.is_file():
        for line in path.read_text(encoding='utf-8').splitlines():
            if line.strip():
                row = json.loads(line)
                if machine is None or (row['by'] in names) == machine:
                    rows[(row['check_id'], row.get('option_id'))] = row
    return rows


def record_answer(lib: Library, piece: Path, check_id: str, answer: str, evidence: str, by: str,
                  option: str | None = None, machine: bool = False, check_pin: str | None = None) -> dict:
    cfg = lib.section('answers')
    if by.strip() in machine_names(lib) and not machine:
        raise ValueError(f'--by {by.strip()} is reserved for results recorded by a checker or a gate; use your own name')
    check = lib.checks().get(check_id)
    if not check:
        raise ValueError(f'{check_id} is not a check in the checklist')
    if answer not in cfg['words'] and not (machine and answer == 'advisory'):
        raise ValueError(f'answer must be one of {", ".join(cfg["words"])}')
    if answer == 'advisory' and not check.get('advisory_passes_at'):       # only a gate's own row, on a check that names where advice passes
        raise ValueError(f'{check_id} names no delivery stage where an advisory answer passes')
    if check.get('per_option') and not option:
        raise ValueError(f'{check_id} is answered per option: add --option <option id>')
    if option and not check.get('per_option'):
        raise ValueError(f'{check_id} is answered once per piece: drop --option')
    if len(evidence.strip()) < cfg['min_evidence_chars']:
        raise ValueError(f'evidence is required (at least {cfg["min_evidence_chars"]} characters): the file, number or list that shows it')
    if not by.strip():
        raise ValueError('--by is required: who or what answered')
    if answer == 'n/a' and check['must']:
        raise ValueError(f'{check_id} is a MUST check and is never n/a: answer pass with the evidence that the set is empty, or fix the piece header')
    covered = [option] if option else routing(lib, piece, all_items_of(lib, piece))[2](check)
    row = {'check_id': check_id, 'option_id': option, 'answer': answer, 'evidence': evidence.strip(), 'by': by.strip(), 'at': now(),
           'file_pins': file_pins(lib, piece, item_files(lib, piece, covered))}
    if machine:
        row['check_pin'] = check_pin
    with answers_file(lib, piece).open('a', encoding='utf-8') as f:
        f.write(json.dumps(row, ensure_ascii=False) + '\n')
    return row


def all_items_of(lib: Library, piece: Path) -> list[str]:
    return sorted(item_files(lib, piece, None))


def answer_command(lib: Library, piece: Path, check: dict, option: str | None) -> str:
    opt = f' --option {option}' if option else ''
    return (f'python3 -I {Path(sys.argv[0]).resolve()} --library {lib.root} --schema {lib.schema_path} answer {piece} --check {check["id"]}{opt} '
            f'--answer pass|fail|n/a --evidence "<file, number or list>" --by <name>')


# --------------------------------------------------------------------------- staleness

def stale_reason(row: dict, covered: list[str], files: dict[str, list[Path]], pins: dict[str, str]) -> str | None:
    """Why a row no longer answers for the files it covers (a per-item row its item, a piece-level row every item it routes to), or None.
    A row carries the BLAKE3 pins of the files it judged: a covered file whose bytes differ, or that it never judged, makes it stale. A row written
    before rows carried pins is judged by time: recorded before a covered file last changed."""
    judged = row.get('file_pins')
    if judged is not None:
        other = [o for o in covered if o in pins and judged.get(o) != pins[o]]
        return f'answered {row.get("at")} on other bytes of {", ".join(other)}: re-check the current file' if other else None
    newest = max((f.stat().st_mtime for o in covered for f in files.get(o, [])), default=None)
    return f'answered {row.get("at")}, before the file last changed: re-check the current file' if recorded_before(row, newest) else None


def recorded_before(row: dict, changed: float | None) -> bool:
    """True when the row was recorded before the file it answers for last changed (or its time cannot be read): it judged other bytes."""
    if changed is None:
        return False
    try:
        return datetime.fromisoformat(row['at']).timestamp() < math.floor(changed)      # rows carry whole seconds (now())
    except (KeyError, TypeError, ValueError):
        return True


# --------------------------------------------------------------------------- rebuilds of a picked item

_PICKED_CACHE: dict = {}


def picked_items(lib: Library, piece: Path) -> set[str]:
    """The items the person has picked: rows of the piece's verdict file whose verdict is one of the picked verdicts."""
    verdicts = piece / (config_value(lib, piece, 'verdict_file') or '')
    if not verdicts.is_file():
        return set()
    picked = config_value(lib, piece, 'picked_verdicts', [])
    return {r['option_id'] for r in (json.loads(x) for x in verdicts.read_text(encoding='utf-8').splitlines() if x.strip()) if r.get('verdict') in picked}


def picked_rebuild_of(lib: Library, piece: Path, option: str) -> str | None:
    """The picked item an item rebuilds: its spec's rebuild key, accepted only when that id is a picked item of the piece. An item that changes only what the
    person asked for in a design they picked is a rebuild; a judgment of the design itself is theirs, not the builder's."""
    verdicts = piece / (config_value(lib, piece, 'verdict_file') or '')
    if not verdicts.is_file():
        return None
    key = (str(verdicts), verdicts.stat().st_mtime_ns)
    if key not in _PICKED_CACHE:
        _PICKED_CACHE.clear()
        _PICKED_CACHE[key] = picked_items(lib, piece)
    rebuild = lib.section('items')['rebuild']
    for spec in sorted(piece.glob(rebuild['spec_glob'].format(option=option))):
        base = read_json(spec).get(rebuild['key'])
        if base and base in _PICKED_CACHE[key]:
            return base
    return None


# --------------------------------------------------------------------------- the gate

def delivery_stage(lib: Library, at: str | None) -> str:
    doc = lib.checklist
    at = at or doc.get('default_delivery_stage', 'final')
    if at not in doc.get('delivery_stages', {'final': ''}):
        raise ValueError(f'unknown delivery stage {at}; stages are {", ".join(sorted(doc.get("delivery_stages", {"final": ""})))}')
    return at


def gate(lib: Library, piece: Path, stages: list[str], options: list[str], at: str | None = None) -> dict:
    """Every routed MUST check of the stages must hold a `pass` row (per item for per-item checks), asked at one delivery stage (the checklist's
    delivery_stages; none named is its default). An `advisory` row passes only at a stage its check lists in advisory_passes_at, and is then returned in
    `advisory` with the line to show beside the item; at any other stage it fails. A row that no longer answers for the files it covers (stale_reason)
    counts as unanswered, for per-item and piece-level rows alike. Runs the schema's on_first_gate command when the piece has no record yet."""
    piece = piece.expanduser().resolve()
    if not piece.is_dir():
        raise ValueError(f'Piece directory does not exist: {piece}')
    doc = lib.checklist
    at = delivery_stage(lib, at)
    known = {s['id'] for s in doc['stages']}
    unknown = [s for s in stages if s not in known]
    if unknown:
        raise ValueError(f'unknown stage {", ".join(unknown)}; stages are {", ".join(sorted(known))}')
    started = start_record(lib, piece)
    header = parse_header(piece / lib.piece_header['file'], lib.piece_header['heading'])
    tags, option_tags, routed_by, flags_unknown = routing(lib, piece, options)
    files = item_files(lib, piece, options)
    pins = file_pins(lib, piece, files)
    every_id = {c['id'] for s in doc['stages'] for c in s['checks']}
    later = {phase_check_id(x, every_id) for x in doc['publish_phase'] + doc['after_phase']}
    answers = read_answers(lib, piece)
    machine_rows = read_answers(lib, piece, True)
    machine = machine_checks(lib)
    unanswered, failed, unanswered_optional, per_option_skipped, waits_for_person, advisory = [], [], [], [], [], []
    judgment = set(lib.section('items').get('judgment_rules', []))
    rule_checks_routed = 0
    for stage in doc['stages']:
        if stage['id'] not in stages:
            continue
        for c in stage['checks']:
            routed = routed_by(c)      # a piece-level row holds only the files it routes to
            if c['id'] in later or not (route_applies(c['routes'], tags) or routed):
                continue
            if c.get('per_option'):
                rule_checks_routed += 1
            if c.get('per_option') and not options:
                per_option_skipped.append(c['id'])
                continue
            for opt in (routed if c.get('per_option') else [None]):
                key = (c['id'], opt)
                if c['id'] in machine:
                    row = machine_rows.get(key)         # only the checker's own result, carrying the reviewed pin of the check that measured it, counts
                    row = row if row and row.get('check_pin') == required_pin(lib, piece, c['id']) else None
                else:
                    row = answers.get(key)
                item = {'id': c['id'], 'option': opt, 'must': c['must'], 'check': c.get('rule') or c['check'],
                        'verify': c['verify'], 'answer_with': answer_command(lib, piece, c, opt)}
                if opt is None and options:
                    item['for_options'] = routed
                why_stale = stale_reason(row, [opt] if opt else routed, files, pins) if row is not None else None
                if why_stale:
                    item['stale'] = why_stale
                    row = None
                if row is None:
                    (unanswered if c['must'] else unanswered_optional).append(item)
                elif row['answer'] == 'advisory':
                    if at in c.get('advisory_passes_at', []):
                        advisory.append({**item, 'evidence': row['evidence'], 'by': row['by'], 'pick_line': f'{opt}: {c["id"]} advisory, not a pass: {row["evidence"]}'})
                    elif c['must']:
                        failed.append({**item, 'evidence': f'advisory passes only at {", ".join(c.get("advisory_passes_at", [])) or "no stage"}; this gate is at {at}: {row["evidence"]}', 'by': row['by']})
                elif row['answer'] == 'fail' and c['must']:
                    base = picked_rebuild_of(lib, piece, opt) if opt and c.get('rule_id') in judgment else None
                    if base:      # a judgment of the design the person picked (this item rebuilds it): theirs to rule on, listed, not blocking; machine rows still block
                        waits_for_person.append({**item, 'evidence': row['evidence'], 'by': row['by'], 'rebuild_of': base})
                    else:
                        failed.append({**item, 'evidence': row['evidence'], 'by': row['by']})
    problems = []
    if not header:
        problems.append(f'routes undeclared: {lib.piece_header["file"]} has no "{lib.piece_header["heading"]}" block, so routes cannot be decided. Write it in the piece folder.')
    elif not header_tags({'medium': header.get('medium', '')}, lib.piece_header):
        problems.append(f'routes undeclared: the "{lib.piece_header["heading"]}" block in {lib.piece_header["file"]} names no medium, so the checks routed by medium '
                        'would be skipped. Add its medium line.')
    if any(s['id'] in stages for s in doc['stages'] if any(c.get('per_option') for c in s['checks'])) and rule_checks_routed == 0:
        problems.append('WARNING: 0 per-option rule checks are routed for this piece header, so none of the per-option rule checks would be asked. '
                        f'Header tags are {sorted(tags)}; fix the header (medium/source/flags) or the rule routes in the checklist.')
    return {'all_passed': not (problems or unanswered or failed), 'per_option_rule_checks_routed': rule_checks_routed, 'piece': str(piece), 'stages': stages, 'options': options,
            'at': at, 'tags': sorted(tags), 'flags_unknown': flags_unknown, 'investigation_started': started, 'problems': problems,
            'unanswered_must': unanswered, 'failed_must': failed, 'waits_for_person_picked_design': waits_for_person, 'advisory': advisory,
            'unanswered_optional_count': len(unanswered_optional),
            'per_option_checks_not_evaluated': per_option_skipped}


def start_record(lib: Library, piece: Path) -> str | None:
    """Run the schema's on_first_gate command when the piece has no record file, so nobody has to remember to; its `written` is returned."""
    spec = lib.section('piece').get('on_first_gate')
    if not spec or (piece / lib.section('piece')['record_file']).is_file():
        return None
    argv = [part.format(library=lib.root, piece=piece, python=sys.executable) for part in spec['command']]
    run = subprocess.run(argv, capture_output=True, text=True)
    if run.returncode != 0:
        raise ValueError(f'on_first_gate {" ".join(argv)} exited {run.returncode}: {(run.stderr or run.stdout).strip()[-300:]}')
    return json.loads(run.stdout)[spec['written_key']]
