"""A checker's report as answers, and the sweep that runs the checker over a whole folder of items.

A checker report is JSON: `{ <schema report_meta_key>: { check_pins, config_overridden }, <file path>: { <check name>: [finding] } }` where a finding is
`{ status, message, t?, t_end?, data? }` and status `FAIL` is a fault. The schema maps each of the checker's checks to the checklist rules it answers.
A report counts check by check, and only when the check's own pin in the report equals the pin the checker computes now and the reviewed pin the
schema holds: a checker that changed since it was reviewed answers nothing, so the gate lists its rows as unanswered.
"""
from __future__ import annotations

import json
import os
import re
import subprocess
from datetime import datetime
from pathlib import Path

from gate_answers import gate, machine_checks, record_answer
from gate_library import Library, locked, now, read_json, write_json
from gate_pieces import item_globs, item_id, lane_of, lane_spec, offered_paths


def usable_check_pins(lib: Library, meta: dict | None, report: Path) -> tuple[dict[str, str], dict[str, str]]:
    """Returns ({check: pin} usable, {check: why not}). A report made with a config override is refused whole: thresholds live in the canonical config."""
    checkers = lib.section('checkers')
    label, key = checkers['label'], checkers['report_meta_key']
    if not meta or 'check_pins' not in meta:
        raise ValueError(f'{report} has no {key} check_pins record; re-run {label} with the current tool and no --config')
    if meta.get('config_overridden'):
        raise ValueError(f'{report} was produced with a --config override; gating accepts only results from the canonical config of {label}. '
                         f'Put thresholds and field lists in the canonical config and re-run {label} without --config')
    if 'current_pins_command' not in checkers:
        raise ValueError(f'the schema names no checkers.current_pins_command, the command that prints {label}\'s current check pins as one JSON line; a report cannot be accepted without it')
    argv = [part.format(library=lib.root) for part in checkers['current_pins_command']]
    run = subprocess.run(argv, capture_output=True, text=True)
    if run.returncode != 0:
        raise ValueError(f'{" ".join(argv)} exited {run.returncode}: {(run.stderr or run.stdout).strip()[-300:]}')
    current = json.loads(run.stdout.strip().splitlines()[-1])
    reviewed = checkers['report_pins']
    usable, refused = {}, {}
    for name, pin in current.items():
        if reviewed.get(name) != pin:
            refused[name] = (f'{name} (pin {pin[:12]}) is not the reviewed version ({str(reviewed.get(name))[:12]}) in the reviewed pins ({checkers["reviewed_pins_where"]}): '
                             'read the change to this check, then record its new pin with who reviewed it and why. The builder whose work it judges must not make that entry')
        elif meta['check_pins'].get(name) != pin:
            refused[name] = f'{name} in the report was measured by another version of the check; re-run {label}'
        else:
            usable[name] = pin
    return usable, refused


def answers_from_report(lib: Library, piece: Path, report: Path, option: str | None, by: str) -> dict:
    """A checker's `--json` output -> one answer per mapped rule. A FAIL finding gives fail; a check that ran without one gives pass."""
    checkers = lib.section('checkers')
    label = checkers['label']
    mapping = checkers['report_checks']
    results_by_item = read_json(report)
    meta = results_by_item.pop(checkers['report_meta_key'], None)
    usable, refused = usable_check_pins(lib, meta, report)
    by_rule = {c['rule_id']: c for c in lib.checks().values() if c.get('rule_id')}
    unmapped_rule = checkers.get('report_unmapped_rule', {})
    recorded = []
    offered = offered_paths(lib, piece)
    for preview in results_by_item:
        if offered is not None and os.path.realpath(preview) not in offered:
            raise ValueError(f'{preview} is not a file {piece.name} offers (offered files match {", ".join(item_globs(lib, piece))}); '
                             f'{label} must measure the file the person will see, not a work or pending copy')
        if os.path.isfile(preview) and os.stat(preview).st_mtime > report.stat().st_mtime + 1:
            raise ValueError(f'{preview} was changed after {report} was written; re-run {label} on the current file before recording its answers')
    for preview, results in results_by_item.items():
        opt = option or item_id(lib, piece, Path(preview))
        for name, findings in results.items():
            if name not in usable:
                continue        # this check is not the reviewed version: no row, so the gate lists it as unanswered
            blip = checkers['not_measured_blip_s']
            unmeasured = [f for f in findings if (f.get('data') or {}).get('not_measured')
                          and (f.get('t') is None or f.get('t_end') is None or f['t_end'] - f['t'] >= blip)]
            if unmeasured and not any(f.get('status') == 'FAIL' for f in findings):
                continue        # the checker could not measure something that could hold content: no row, so the gate lists it as unanswered (a FAIL is still recorded)
            for entry in mapping.get(name, []):
                rule, pattern = (entry, None) if isinstance(entry, str) else (entry['rule'], entry.get('finding_match'))
                fails = [f for f in findings if f.get('status') == 'FAIL' and (not pattern or re.search(pattern, f['message']))]
                if fails:
                    ev = f'{label} {name} FAIL on {Path(preview).name}: ' + '; '.join(f['message'] for f in fails[:3])
                elif any((f.get('data') or {}).get('empty_set') for f in findings):
                    ev = f'{label} {name} on {Path(preview).name}: {findings[0]["message"]} (empty set)'
                else:
                    ev = f'{label} {name} PASS on {Path(preview).name} ({len(findings)} notes, report {report})'
                recorded.append(record_answer(lib, piece, by_rule[rule]['id'], 'fail' if fails else 'pass', ev, by, opt, machine=True, check_pin=usable[name]))
        for name, findings in results.items():
            if name not in usable:
                continue
            if name in unmapped_rule and not any(f.get('status') == 'FAIL' for f in findings):
                counted = checkers.get('report_unmapped_count')      # { pattern: regex with one group on a finding's message, what: the noun counted }
                linted = next((m.group(1) for f in findings for m in [re.match(counted['pattern'], f.get('message', ''))] if m), '0') if counted else None
                what = f'{linted} {counted["what"]} linted, ' if counted else ''
                recorded.append(record_answer(lib, piece, by_rule[unmapped_rule[name]]['id'], 'pass',
                                              f'{label} {name} lint on {Path(preview).name}: {what}no finding left unmapped',
                                              by, opt, machine=True, check_pin=usable[name]))
            patterns = [e['finding_match'] for e in mapping.get(name, []) if isinstance(e, dict) and e.get('finding_match')]
            stray = [f for f in findings if f.get('status') == 'FAIL' and patterns and not any(re.search(x, f['message']) for x in patterns)]
            if stray and name in unmapped_rule:
                ev = f'{label} {name} FAIL matches no mapped rule (unmapped finding): ' + '; '.join(f['message'] for f in stray[:3])
                recorded.append(record_answer(lib, piece, by_rule[unmapped_rule[name]]['id'], 'fail', ev, by, option or item_id(lib, piece, Path(preview)), machine=True, check_pin=usable[name]))
    return {'recorded': len(recorded), 'checks_not_recorded': refused, 'rows': [{k: r[k] for k in ('check_id', 'option_id', 'answer')} for r in recorded]}


def sweep(lib: Library, piece: Path, preview_dirs: list[str], only: list[str] | None = None) -> dict:
    """The fresh sweep before anything goes to the person: every check of the checker runs over every item in the given folders, through the canonical
    checker, and the results are recorded; faults are listed by rule across all items, so what the person did not point at is found too. Records the sweep's
    own row for each item measured with no unanswered machine rule left. It also runs the schema's review command per folder when it names one (a pack for a
    fresh-viewer review: that review makes findings, never a pass or fail)."""
    checkers = lib.section('checkers')
    cfg = checkers['sweep']
    piece = piece.expanduser().resolve()
    ids, ran, missing, packs, unspecced = [], [], [], [], []
    compilation = re.compile(lib.section('items')['compilation_pattern'])
    ts = datetime.now().astimezone().strftime('%Y%m%d-%H%M%S')
    home = None      # the sweep's files go beside the items (the items' own folder), never to the piece root
    for d in preview_dirs:
        folder = (piece / d).resolve() if not Path(d).is_absolute() else Path(d)
        if not folder.is_dir():
            raise ValueError(f'{folder} is not a folder of previews')
        home = home or folder.parent
        chosen = [p for p in sorted(folder.glob(cfg['item_glob'])) if not compilation.search(p.stem) and (not only or item_id(lib, piece, p) in only)]
        by_specs: dict[Path, list[str]] = {}
        for p in chosen:
            spec = lane_spec(lib, piece, lane_of(lib, p), p.stem)
            if spec is None:
                unspecced.append(str(p))      # no spec: the checker would pass "nothing in the spec" for what is on screen, so it is not measured
            else:
                by_specs.setdefault(spec.parent, []).append(p.stem)
        for k, (specs, stems) in enumerate(sorted(by_specs.items())):
            out = home / f'{cfg["file_prefix"]}-{ts}-{folder.name}{f"-{k + 1}" if k else ""}.json'
            argv = [part.format(library=lib.root, folder=folder, specs=specs, out=out, ids=','.join(stems)) for part in cfg['batch_command']]
            subprocess.run(argv, check=False, capture_output=True, text=True)
            if not out.is_file():
                missing.append(f'{folder} with {specs}')
                continue
            with locked(lib):
                answers_from_report(lib, piece, out, None, checkers['answerer'])
            ids += [item_id(lib, piece, folder / f'{s}{Path(cfg["item_glob"]).suffix}') for s in stems]
            ran.append(str(out))
        if chosen and cfg.get('review_command'):
            pack_dir = home / f'{cfg["review_prefix"]}-{ts}' / folder.name
            argv = [part.format(library=lib.root, folder=folder, pack_dir=pack_dir, ids=','.join(p.stem for p in chosen)) for part in cfg['review_command']]
            subprocess.run(argv, check=True, capture_output=True, text=True)
            packs += [str(p) for p in sorted(pack_dir.iterdir())]
    with locked(lib):
        result = gate(lib, piece, cfg['stages'], ids)
    sweep_rule = cfg['rule']
    gate_rules = (sweep_rule, *lib.section('gates'))
    machine = machine_checks(lib) - {c['id'] for c in lib.checks().values() if c.get('rule_id') in gate_rules}      # the sweep answers the checker's rows; the gates have their own command
    by_rule: dict[str, list] = {}
    for kind in ('failed_must', 'unanswered_must'):
        for item in result[kind]:
            if item['id'] in machine:
                by_rule.setdefault(item['id'], []).append({'option': item['option'], 'state': 'failed' if kind == 'failed_must' else 'not measured', 'why': item.get('evidence', item['verify'])[:160]})
    sweep_check = next(c for c in lib.checks().values() if c.get('rule_id') == sweep_rule)
    incomplete = {i['option'] for i in result['unanswered_must'] if i['id'] in machine}
    recorded = []
    with locked(lib):
        for opt in ids:
            if opt in incomplete:
                continue
            recorded.append(record_answer(lib, piece, sweep_check['id'], 'pass',
                                          f'sweep {ts}: every {checkers["label"]} rule class ran on every item of the folders ({len(ids)} items in {", ".join(Path(d).name for d in preview_dirs)}); faults by rule in {home.name}/{cfg["file_prefix"]}-{ts}-report.json',
                                          cfg['by'], opt, machine=True, check_pin=cfg['pin'])['option_id'])
    report = {'at': now(), 'folders': preview_dirs, 'options': ids, 'faults_by_rule': by_rule, 'options_not_fully_measured': sorted(incomplete), 'folders_without_a_report': missing,
              'previews_without_a_spec': unspecced, 'sweep_rows_recorded_for': recorded, 'review_packs': packs, 'review_prompt': cfg.get('review_prompt')}
    write_json(home / f'{cfg["file_prefix"]}-{ts}-report.json', report)
    return {'all_passed': not (by_rule or missing or unspecced), **{k: v for k, v in report.items() if k != 'at'}, 'report': str(home / f'{cfg["file_prefix"]}-{ts}-report.json')}


