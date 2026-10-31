"""One piece's investigation record (<piece>/investigation.json): start it, say what is asked next, record answers with the identity of
the files that show them, add findings to the findings library and report progress. A recorded answer establishes structure and file
identity, not that the answer is true."""
from __future__ import annotations

import glob
from pathlib import Path

from library import PROGRAM, SCHEMA_VERSION, Store, content_identity, now, piece_rel, read_json, write_json
from routes import build_nodes, header_tags, parse_header, search_library, select_questions, target_kind

RECORD_FILE = 'investigation.json'


def start(store: Store, piece: Path, profile_id: str, limit: int | None = None, objective: str = '') -> dict:
    piece = piece.expanduser().resolve()
    if not piece.is_dir():
        raise ValueError(f'Piece directory does not exist: {piece}')
    record = piece / RECORD_FILE
    if record.exists():
        raise ValueError(f'Refusing to overwrite {record}. Read it with: {PROGRAM} progress {piece}')
    cfg = store.investigation
    header = parse_header(piece / cfg['piece_header']['file'], cfg['piece_header']['heading'])
    tags = header_tags(header, cfg)
    kind = target_kind(piece, store)
    limit = limit or cfg['selection']['default_limit']
    sel = select_questions(store, profile_id, tags, kind, limit)
    nodes = build_nodes(store, sel['chosen'], sel['groups'])
    inv = {'schema_version': SCHEMA_VERSION, 'piece': piece.name, 'piece_dir': str(piece), 'target_kind': kind,
           'profile': profile_id, 'objective': objective, 'created_at': now(), 'updated_at': now(),
           'header': header, 'tags': sorted(tags),
           'header_missing': not header,
           'selection': {'rule': cfg['selection']['rule'], 'limit': limit, 'candidates': sel['candidates'],
                         'selected': [n['id'] for n in nodes[1:]], 'not_selected': sel['skipped']},
           'prior_findings': search_library(store, [piece.name, profile_id] + sorted(tags)),
           'authority': cfg['authority'],
           'receipt_semantics': 'A recorded answer establishes structure and file identity, not that the answer is true.',
           'nodes': nodes, 'evidence': [], 'findings': []}
    write_json(record, inv)
    return {'written': str(record), 'profile': profile_id, 'target_kind': kind, 'tags': sorted(tags),
            'selected': [{'id': n['id'], 'group': n['group'], 'question': n['question']} for n in nodes[1:]],
            'not_selected_count': len(sel['skipped']), 'over_limit': [q for q, r in sel['skipped'].items() if r.startswith('over the limit')],
            'next': f'{PROGRAM} evidence {piece} --q {nodes[0]["id"]} --status executed --file {piece}/{cfg["piece_header"]["file"]} --note "..."'}


def load_inv(piece: Path) -> tuple[Path, dict]:
    record = piece.expanduser().resolve() / RECORD_FILE
    if not record.is_file():
        raise ValueError(f'No investigation at {record}. Start one with: {PROGRAM} start {piece} --profile <id>')
    inv = read_json(record)
    problems = validate_evidence_records(inv)
    if problems:
        raise ValueError('Invalid evidence record shape:\n' + '\n'.join(problems))
    return record, inv


def evidence_shape_remediation() -> str:
    return ('Preserve the malformed investigation as evidence; restore an authentic valid snapshot first; '
            'then re-record current files through the ordinary evidence owner: '
            f'{PROGRAM} evidence <piece> --q <selected-question> '
            '--status <status> --file <path> --note <note>')


def validate_evidence_records(inv: dict) -> list[str]:
    """Validate fields read by evidence consumers; file currency is checked separately."""
    evidence = inv.get('evidence')
    if not isinstance(evidence, list):
        return [f'investigation evidence must be a list; {evidence_shape_remediation()}']
    problems = []
    for index, row in enumerate(evidence, 1):
        if not isinstance(row, dict):
            problems.append(f'Evidence row {index}: expected an object; {evidence_shape_remediation()}')
            continue
        eid = row.get('id')
        label = eid if isinstance(eid, str) and eid else f'row {index}'
        path = row.get('path')
        location = f' ({path})' if isinstance(path, str) and path else ''
        missing = [key for key in ('id', 'path')
                   if not isinstance(row.get(key), str) or not row[key].strip()]
        identity = row.get('identity')
        if not isinstance(identity, dict):
            missing.append('identity')
        elif not isinstance(identity.get('value'), str) or not identity['value'].strip():
            missing.append('identity.value')
        if missing:
            problems.append(
                f'Evidence {label}{location}: missing or invalid {", ".join(missing)}; '
                f'{evidence_shape_remediation()}'
            )
    return problems


def node_of(inv: dict, qid: str) -> dict:
    n = next((n for n in inv['nodes'] if n['id'] == qid), None)
    if not n:
        raise ValueError(f'{qid} is not selected for {inv["piece"]}. Selected: {", ".join(x["id"] for x in inv["nodes"])}')
    return n


def done_ids(inv: dict, store: Store) -> set[str]:
    return {n['id'] for n in inv['nodes'] if n['status'] in store.investigation['done_statuses']}


def next_open(store: Store, piece: Path, limit: int = 20) -> dict:
    _, inv = load_inv(piece)
    done = done_ids(inv, store)
    ready, waiting = [], []
    for n in inv['nodes']:
        if n['status'] in store.investigation['done_statuses']:
            continue
        missing = [d for d in n['depends_on'] if d not in done]
        row = {'id': n['id'], 'status': n['status'], 'group': n['group'], 'stage': n['stage'], 'question': n['question'],
               'verify_by': n['verify_by'], 'tools': n['tools']}
        (waiting.append({**row, 'waiting_for': missing}) if missing else ready.append(row))
    ready.sort(key=lambda r: r['status'] != 'open')
    return {'piece': inv['piece'], 'ready': ready[:limit], 'ready_count': len(ready), 'waiting_count': len(waiting),
            'waiting_ids': [w['id'] for w in waiting]}


def record_evidence(store: Store, piece: Path, qid: str, status: str, files: list[str], note: str,
                    label: str | None = None, defect: bool = False, caught_by: list[str] | None = None, append: bool = False,
                    preserve_answered_at: bool = False) -> dict:
    cfg = store.investigation
    label = label or cfg['claim_labels'][0]
    record, inv = load_inv(piece)
    piece = Path(inv['piece_dir'])
    allowed = [s for s in cfg['statuses'] if s != 'open']
    if status not in allowed:
        raise ValueError(f'status must be one of {", ".join(allowed)}')
    if label not in cfg['claim_labels']:
        raise ValueError(f'label must be one of {", ".join(cfg["claim_labels"])}')
    n = node_of(inv, qid)
    errors = []
    if status in ('executed', 'adapted') and not files:
        errors.append(f'{status} requires --file')
    if status in ('adapted', 'not-applicable', 'asked') and not note.strip():
        errors.append(f'{status} requires --note saying {"how it was adapted" if status == "adapted" else "why"}')
    paths = []
    for f in files:
        p = Path(f).expanduser()
        p = p if p.is_absolute() else (Path.cwd() / p)
        if not p.is_file():
            errors.append(f'Evidence file does not exist (or is not a file): {f}')
        else:
            paths.append(p.resolve())
    if status in cfg['done_statuses']:
        missing = [d for d in n['depends_on'] if d not in done_ids(inv, store)]
        if missing:
            errors.append(f'{qid} cannot close before its prerequisites: {", ".join(missing)}')
    caught_by = caught_by or []
    known_checks = set(store.ids(store.pool_of('checks')))
    unknown = [c for c in caught_by if c != 'none' and c not in known_checks]
    if unknown:
        errors.append(f'--caught-by names unknown checks: {", ".join(unknown)}')
    if errors:
        raise ValueError('; '.join(errors))
    ev_ids = []
    for p in paths:
        ident = content_identity(p)
        rel = piece_rel(piece, p)
        same = next((e for e in inv['evidence'] if e['path'] == rel and e['identity']['value'] == ident['value']), None)
        if same:
            ev_ids.append(same['id'])
            continue
        eid = f'E{len(inv["evidence"]) + 1}'
        inv['evidence'].append({'id': eid, 'path': rel, 'identity': ident, 'recorded_at': now()})
        ev_ids.append(eid)
    if append:
        # Keep distinct sources active, but use the new revision for a revised path.
        # Every older identity stays in inv['evidence'] as historical evidence.
        known = {e['id']: e for e in inv['evidence']}
        by_path = {}
        for eid in n.get('evidence', []) + ev_ids:
            by_path[known[eid]['path']] = eid
        ev_ids = list(by_path.values())
        previous_note, added_note = n.get('note', '').strip(), note.strip()
        if previous_note and added_note and previous_note != added_note and not previous_note.endswith('\n\n' + added_note):
            note = previous_note + '\n\n' + added_note
        else:
            note = previous_note or added_note
    n.update(status=status, evidence=ev_ids, note=note.strip(), label=label, defect=defect,
             caught_by=caught_by)
    if not preserve_answered_at:
        n['answered_at'] = now()
    inv['updated_at'] = now()
    write_json(record, inv)
    return {'piece': inv['piece'], 'question': qid, 'status': status, 'evidence': ev_ids, 'defect': defect,
            'progress': summarise(inv, store)}


def add_finding(store: Store, piece: Path, kind: str, title: str, fields: dict, qid: str | None, evidence: list[str], label: str | None = None) -> dict:
    """Add a finding of one of the kinds the schema names to the piece and to the findings library."""
    record, inv = load_inv(piece)
    cfg = store.investigation
    label = label or cfg['claim_labels'][0]
    if kind not in cfg['finding_kinds']:
        raise ValueError(f'finding kind must be one of {", ".join(cfg["finding_kinds"])}')
    if label not in cfg['claim_labels']:
        raise ValueError(f'label must be one of {", ".join(cfg["claim_labels"])}')
    ev = list(evidence)
    if qid:
        n = node_of(inv, qid)
        ev = ev or n.get('evidence', [])
    known = {e['id']: e for e in inv['evidence']}
    if not ev:
        raise ValueError('A finding needs evidence: --evidence E<n> or --q <answered question>')
    bad = [e for e in ev if e not in known]
    if bad:
        raise ValueError(f'Evidence not recorded on this piece: {", ".join(bad)}')
    spec = cfg['finding_kinds'][kind]
    required = spec['required']
    missing = [k for k in required if not (fields.get(k) or '').strip()]
    if missing:
        raise ValueError(f'{kind} finding needs: {", ".join("--field " + m + "=..." for m in missing)}')
    lib = store.load_findings()
    next_step = None
    if 'match' in spec:
        rule = spec['match']
        found = next((r for r in store.pool(rule['pool']) if str(r.get(rule['field'], '')).casefold() == title.casefold()), None)
        next_step = rule['found'].format(id=found[store.id_field(rule['pool'])]) if found else rule['missing']
    prefix = cfg['finding_id_prefix']
    fid = f'{prefix}{max([int(f["id"][len(prefix):]) for f in lib], default=0) + 1:04d}'
    seen = {'piece': inv['piece'], 'piece_dir': inv['piece_dir'], 'question': qid,
            'evidence': [{'path': known[e]['path'], 'identity': known[e]['identity']} for e in ev]}
    entry = {'id': fid, 'kind': kind, 'title': title, 'label': label, **{k: fields[k] for k in required},
             **({'next_step': next_step} if next_step else {}), 'seen_in': [seen], 'adopted_in': [], 'added_at': now()}
    lib.append(entry)
    write_json(store.findings_path(), lib)
    tid = f'T{len(inv["findings"]) + 1}'
    inv['findings'].append({'id': tid, 'library_id': fid, 'kind': kind, 'title': title, 'label': label, 'question': qid, 'evidence': ev})
    inv['updated_at'] = now()
    write_json(record, inv)
    return {'piece_finding': tid, 'library_finding': entry}


def evidence_state(piece: Path, e: dict) -> str:
    p = Path(e['path'])
    p = p if p.is_absolute() else piece / p
    if not p.is_file():
        return 'missing'
    return 'matches' if content_identity(p)['value'] == e['identity']['value'] else 'changed'


def summarise(inv: dict, store: Store) -> dict:
    counts = {s: 0 for s in store.investigation['statuses']}
    for n in inv['nodes']:
        counts[n['status']] += 1
    applicable = len(inv['nodes']) - counts['not-applicable']
    touched = counts['asked'] + counts['executed'] + counts['adapted']
    resolved = counts['executed'] + counts['adapted']
    pct = lambda a, b: round(100 * a / b, 1) if b else 0.0
    return {'counts': counts, 'applicable': applicable, 'progress_pct': pct(touched, applicable), 'completion_pct': pct(resolved, applicable)}


def progress(store: Store, piece: Path) -> dict:
    _, inv = load_inv(piece)
    pdir = Path(inv['piece_dir'])
    scope_id = store.investigation['scope_node']['id']
    states = {e['id']: evidence_state(pdir, e) for e in inv['evidence']}
    stale_answers = sorted({n['id'] for n in inv['nodes'] for e in n.get('evidence', []) if states.get(e) != 'matches'})
    defects = [{'id': n['id'], 'note': n['note'], 'caught_by': n.get('caught_by', [])} for n in inv['nodes'] if n.get('defect')]
    net_new = [n['id'] for n in inv['nodes'] if n['id'] != scope_id and n['status'] in ('executed', 'adapted')
               and (not n.get('caught_by') or n.get('caught_by') == ['none'])]
    by_group: dict[str, dict] = {}
    for n in inv['nodes']:
        by_group.setdefault(n['group'], {s: 0 for s in store.investigation['statuses']})[n['status']] += 1
    return {'piece': inv['piece'], 'profile': inv['profile'], **summarise(inv, store), 'by_group': by_group,
            'defects': defects, 'answered_not_caught_by_checklist': net_new,
            'evidence': {'total': len(states), **{s: sum(1 for v in states.values() if v == s) for s in ('matches', 'changed', 'missing')}},
            'answers_with_changed_or_missing_evidence': stale_answers,
            'findings': [{'id': f['id'], 'library_id': f['library_id'], 'title': f['title']} for f in inv['findings']],
            'complete': all(n['status'] in store.investigation['done_statuses'] for n in inv['nodes'])}


def piece_problems(store: Store) -> tuple[list[str], list[str]]:
    """What is wrong in every investigation record the schema's piece_globs find: ids that do not resolve, and evidence of the wrong shape."""
    cfg = store.investigation
    questions = set(store.ids(store.pool_of('questions')))
    checks = set(store.ids(store.pool_of('checks')))
    scope_id = cfg['scope_node']['id']
    ids, shape = [], []
    for pattern in cfg['piece_globs']:
        for path in glob.glob(str(store.root / pattern)):
            inv = read_json(Path(path))
            shape.extend(f'{inv.get("piece", path)}:{problem}' for problem in validate_evidence_records(inv))
            node_ids = {x['id'] for x in inv['nodes']}
            for n in inv['nodes']:
                if n['id'] != scope_id and n['id'] not in questions:
                    ids.append(f'{inv["piece"]}:{n["id"]}')
                if n['status'] not in cfg['statuses']:
                    ids.append(f'{inv["piece"]}:{n["id"]}:status')
                for c in n.get('caught_by', []):
                    if c != 'none' and c not in checks:
                        ids.append(f'{inv["piece"]}:{n["id"]}:caught_by {c}')
                for d in n['depends_on']:
                    if d not in node_ids:
                        ids.append(f'{inv["piece"]}:{n["id"]}:depends_on {d}')
    return sorted(ids), sorted(shape)
