def comma_list(values: list[str]) -> list[str]:
    return [x.strip() for v in values for x in v.split(',') if x.strip()]


def gate_cfg(store: Store) -> dict:
    return store.config['gate']


def answers_file(store: Store, piece: Path) -> Path:
    return piece.expanduser().resolve() / gate_cfg(store)['answers_file']


def read_answers(store: Store, piece: Path, machine: bool | None = None) -> dict[tuple[str, str | None], dict]:
    """The newest row for each (check_id, option_id). The file is append-only; a later row replaces an earlier one.
    machine=True keeps only film-qa's own rows, machine=False only the others, None all."""
    path = answers_file(store, piece)
    machine_names = {gate_cfg(store)['machine_by'], gate_cfg(store)['sweep_by'], *(g['by'] for g in gate_cfg(store)['content_gates'].values())}
    rows: dict[tuple[str, str | None], dict] = {}
    if path.is_file():
        for line in path.read_text(encoding='utf-8').splitlines():
            if line.strip():
                row = json.loads(line)
                if machine is None or (row['by'] in machine_names) == machine:
                    rows[(row['check_id'], row.get('option_id'))] = row
    return rows


def machine_checks(store: Store) -> set[str]:
    """Check ids that film-qa answers (the rules named in gate.film_qa_checks and gate.film_qa_unmapped_rule). Only film-qa's own rows count for them."""
    rules = {e if isinstance(e, str) else e['rule'] for entries in gate_cfg(store)['film_qa_checks'].values() for e in entries}
    rules |= set(gate_cfg(store).get('film_qa_unmapped_rule', {}).values())
    rules.add(gate_cfg(store)['sweep_rule'])
    rules |= set(gate_cfg(store)['content_gates'])
    return {c['id'] for c in store.checks().values() if c.get('rule_id') in rules}


def rule_to_film_qa_check(store: Store) -> dict[str, str]:
    """{rule id: the film-qa check that answers it}, from gate.film_qa_checks and gate.film_qa_unmapped_rule."""
    cfg = gate_cfg(store)
    out = {(e if isinstance(e, str) else e['rule']): name for name, entries in cfg['film_qa_checks'].items() for e in entries}
    out.update({rule: name for name, rule in cfg.get('film_qa_unmapped_rule', {}).items()})
    return out


def content_gate_pin(store: Store, piece: Path, key: str) -> str:
    """BLAKE3 of the gate's own code (for the fact gate, the one this film runs): a row counts only while the gate that produced it is unchanged."""
    film_qa_tool()
    from rendercheck import config as fq_config  # noqa: E402
    files = {'copy-gate': [COPY_CHECK, COPY_CHECK.parent / 'ask-rules.json', VERDICT_RULES.parent / 'copy-rules.json'],
             'verdict-rules': [COPY_CHECK, COPY_CHECK.parent / 'verdict-rules.mjs', VERDICT_RULES], 'fact-gate': [fact_gate_tool(store, piece)],
             'audio-measure': [TOOL_DIR / 'cis.py', DEFAULT_HOME / 'consolidation' / 'data' / 'cis_config.json']}[key]      # the measuring code and its marks
    return fq_config.blake3_hex(b'\0'.join(p.read_bytes() for p in files if p.is_file()))


def required_pin(store: Store, piece: Path, check_id: str) -> str | None:
    """The reviewed pin a machine answer to this check must carry: its film-qa check's own pin (gate.film_qa_check_pins), or 'sweep' for the sweep's row."""
    rule = store.checks()[check_id].get('rule_id')
    if rule == gate_cfg(store)['sweep_rule']:
        return 'sweep'
    if rule in gate_cfg(store)['content_gates']:
        return content_gate_pin(store, piece, rule)
    return gate_cfg(store)['film_qa_check_pins'].get(rule_to_film_qa_check(store).get(rule))


def record_answer(store: Store, piece: Path, check_id: str, answer: str, evidence: str, by: str,
                  option: str | None = None, machine: bool = False, check_pin: str | None = None) -> dict:
    cfg = gate_cfg(store)
    if by.strip() in (cfg['machine_by'], cfg['sweep_by'], *(g['by'] for g in cfg['content_gates'].values())) and not machine:
        raise ValueError(f'--by {by.strip()} is reserved for results recorded by answer-from-filmqa and sweep; use your own name')
    check = store.checks().get(check_id)
    if not check:
        raise ValueError(f'{check_id} is not a check in workflow_checklist.json')
    if answer not in cfg['answer_words'] and not (machine and answer == 'advisory'):
        raise ValueError(f'answer must be one of {", ".join(cfg["answer_words"])}')
    if answer == 'advisory' and not check.get('advisory_passes_at'):       # only a gate's own row, on a check that names where advice passes (WORKFLOW.md Advisory row)
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
    covered = [option] if option else routing(store, piece, all_options(store, piece))[2](check)
    row = {'check_id': check_id, 'option_id': option, 'answer': answer, 'evidence': evidence.strip(), 'by': by.strip(), 'at': now(),
           'file_pins': file_pins(store, piece, option_files(store, piece, covered))}
    if machine:
        row['check_pin'] = check_pin
    with answers_file(store, piece).open('a', encoding='utf-8') as f:
        f.write(json.dumps(row, ensure_ascii=False) + '\n')
    return row


def answer_command(piece: Path, check: dict, option: str | None) -> str:
    opt = f' --option {option}' if option else ''
    return (f'python3 -I {TOOL_DIR / "cis.py"} answer {piece} --check {check["id"]}{opt} '
            f'--answer pass|fail|n/a --evidence "<file, number or list>" --by <name>')


def picked_rebuild_of(store: Store, piece: Path, option: str, _cache: dict = {}) -> str | None:
    """The recorded pick an option rebuilds: its spec's `rebuild_of: <option id>`, accepted only when that id has a picked row in the film's verdict file (pick-gate.json
    verdict_file, picked_verdicts). An option that changes only what he asked for in a design he picked is a rebuild; a judgment of the design itself is his, not the builder's."""
    config = film_config(store, piece)
    verdicts = piece / config.get('verdict_file', '')
    if not verdicts.is_file():
        return None
    key = (str(verdicts), verdicts.stat().st_mtime_ns)
    if key not in _cache:
        _cache.clear()
        _cache[key] = {r['option_id'] for r in (json.loads(x) for x in verdicts.read_text(encoding='utf-8').splitlines() if x.strip()) if r.get('verdict') in config.get('picked_verdicts', [])}
    for spec in sorted(piece.glob(f'filmcraft/options-ch*/specs-round-*/{option}.json')):
        base = read_json(spec).get('rebuild_of')
        if base and base in _cache[key]:
            return base
    return None


def proven_tags(store: Store, piece: Path, files: dict[str, list[Path]]) -> tuple[dict[str, set[str]], dict[str, set[str]]]:
    """({option: the flags its own files prove}, {option: the flags not yet known}), by gate.proven_flags. A spec row holds when any of its paths has a
    value in the option's spec (a placed sound proves sfx, spoken words prove voice). A film-qa row reads that check's findings in the option's newest
    film-qa report not older than the file (gate.film_qa_report_globs): the flag holds when the check ran and no finding has a value at absent_when (a face
    found proves people), on files with one of its suffixes. With no such report the flag is unknown, which routes its rows as open, never as absent. The header can add flags, never
    remove one its files prove, so a missing flag cannot route rows to nothing."""
    film_qa_tool()
    from rendercheck import ctx as fq_ctx  # noqa: E402
    rules, globs = gate_cfg(store)['proven_flags'], gate_cfg(store)['film_qa_report_globs']
    proven: dict[str, set[str]] = {}
    unknown: dict[str, set[str]] = {}
    for option, paths in files.items():
        docs = [read_json(spec) for f in paths for spec in [lane_spec(store, piece, f.parent.parent, f.stem)] if spec]
        proven[option], unknown[option] = set(), set()
        for r in rules:
            if r['source'] == 'spec':
                if any(fq_ctx.dotted(doc, path) for doc in docs for path in r['paths']):
                    proven[option].add(r['flag'])
                continue
            judged = [f for f in paths if f.suffix.lower().lstrip('.') in r['suffixes']]      # files the check can judge; a sound file has no face to find
            if not judged:
                continue
            findings = None
            for f in judged:
                reports = sorted({g for pattern in globs for g in f.parent.parent.glob(pattern.format(folder=f.parent.name, name=f.stem))},
                                 key=lambda g: g.stat().st_mtime, reverse=True)
                for report in reports:
                    if report.stat().st_mtime < f.stat().st_mtime:
                        break      # older than the file: it judged other bytes
                    entry = next((v for k, v in read_json(report).items() if not k.startswith('_') and Path(k).stem == f.stem and isinstance(v, dict)), None)
                    if entry is not None and r['check'] in entry:
                        findings = entry[r['check']]
                        break
            if findings is None:
                unknown[option].add(r['flag'])
            elif findings and not any(fq_ctx.dotted(x, r['absent_when']) for x in findings):
                proven[option].add(r['flag'])
    return proven, unknown


def routing(store: Store, piece: Path, options: list[str]) -> tuple[set[str], dict[str, set[str]], Any, dict[str, list[str]]]:
    """(piece-level tags, {option: its tags}, routed(check) -> the options a check routes to, {option: flags not yet known}): the header's tags, per-file
    media (file_scoped_tags) and the flags each option's files prove or cannot yet rule out (proven_tags), joined. gate and record_answer both route
    through this."""
    piece = piece.expanduser().resolve()
    cfg = store.config
    header = parse_header(piece / cfg['piece_header']['file'], cfg['piece_header']['heading'])
    tags, option_tags = file_scoped_tags(store, piece, header, header_tags(header, cfg), options)
    proven, unknown = proven_tags(store, piece, option_files(store, piece, options))
    option_tags = {o: option_tags[o] | proven.get(o, set()) | unknown.get(o, set()) for o in options}
    tags = tags.union(*proven.values(), *unknown.values())
    return tags, option_tags, lambda check: [o for o in options if route_applies(check['routes'], option_tags[o])], {o: sorted(u) for o, u in unknown.items() if u}


def file_scoped_tags(store: Store, piece: Path, header: dict[str, str], tags: set[str], options: list[str]) -> tuple[set[str], dict[str, set[str]]]:
    """(piece-level tags, {option: its tags}). A medium in gate.file_media applies per file: an option whose file has one of its suffixes takes that
    medium alone (with the header's other tags). When the header also names another medium, the other files and the piece-level rows drop it, so a
    film of cuts and voice auditions routes picture rows to its cuts and sound-file rows to its auditions."""
    scoped = {m: set(s) for m, s in gate_cfg(store).get('file_media', {}).items()}
    media = header_tags({'medium': header.get('medium', '')}, store.config)
    named = {m for m in scoped if m in media}
    if not named:
        return tags, {o: tags for o in options}
    others = media - named
    piece_tags = tags - named if others else tags
    config = film_config(store, piece)
    suffix = {option_id(config, piece, p): p.suffix.lower().lstrip('.') for p in film_previews(store, piece)} if options else {}

    def tags_of(option: str) -> set[str]:
        medium = next((m for m in sorted(named) if suffix.get(option) in scoped[m]), None)
        return (tags - media) | {medium} if medium else piece_tags
    return piece_tags, {o: tags_of(o) for o in options}


def all_options(store: Store, piece: Path) -> list[str]:
    """Every option id of the film's shipped previews, compilations excluded (each stands for its folder's previews)."""
    return sorted(option_files(store, piece, None))


def option_files(store: Store, piece: Path, options: list[str] | None) -> dict[str, list[Path]]:
    """{option: its shipped preview files} for these options (all when None); compilations excluded."""
    piece = piece.expanduser().resolve()
    config = film_config(store, piece)
    compilation = re.compile(gate_cfg(store)['compilation_pattern'])
    wanted = None if options is None else set(options)
    out: dict[str, list[Path]] = {}
    for f in film_previews(store, piece):
        o = option_id(config, piece, f)
        if not compilation.search(f.stem) and (wanted is None or o in wanted):
            out.setdefault(o, []).append(f)
    return out


def file_pins(store: Store, piece: Path, files: dict[str, list[Path]]) -> dict[str, str]:
    """{option: BLAKE3 of its files' bytes} (several files joined by '+'). Hashes are kept in a cache under gate.file_pin_cache (one JSON file per piece, named
    by its absolute path), keyed by path, size and change time, so an unchanged file is read once; the pin itself is always the bytes' BLAKE3."""
    folder = store.home / gate_cfg(store)['file_pin_cache']
    folder.mkdir(parents=True, exist_ok=True)
    cache_path = folder / (str(piece.expanduser().resolve()).strip('/').replace('/', '__') + '.pins')
    cache = read_json(cache_path) if cache_path.is_file() else {}
    pins, dirty = {}, False
    for option, paths in files.items():
        parts = []
        for f in sorted(paths):
            st, key = f.stat(), str(f)
            hit = cache.get(key)
            if not hit or (hit['bytes'], hit['mtime_ns']) != (st.st_size, st.st_mtime_ns):
                hit = cache[key] = {'bytes': st.st_size, 'mtime_ns': st.st_mtime_ns, 'blake3': content_identity(f)['value']}
                dirty = True
            parts.append(hit['blake3'])
        pins[option] = '+'.join(parts)
    if dirty:
        with tempfile.NamedTemporaryFile('w', dir=cache_path.parent, prefix=cache_path.name, suffix='.tmp', delete=False, encoding='utf-8') as tmp:
            json.dump(cache, tmp, indent=1)
        os.replace(tmp.name, cache_path)
    return pins


def stale_reason(row: dict, covered: list[str], files: dict[str, list[Path]], pins: dict[str, str]) -> str | None:
    """Why a row no longer answers for the files it covers (a per-option row its option, a piece-level row every option it routes to), or None.
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


def gate(store: Store, piece: Path, stages: list[str], options: list[str], at: str | None = None) -> dict:
    """Every routed MUST check of the stages must hold a `pass` row (per option for per_option checks), asked at one delivery stage
    (workflow_checklist.json delivery_stages; none named is its default, final). An `advisory` row passes only at a stage its check lists in
    advisory_passes_at, and is then returned in `advisory` with the line to show beside the option; at any other stage it fails.
    A row that no longer answers for the files it covers (stale_reason: other bytes than its file pins, or for a row without pins, recorded before the file
    changed) counts as unanswered, for per-option and piece-level rows alike.
    Starts investigation.json when the piece has none, so nobody has to remember to."""
    piece = piece.expanduser().resolve()
    if not piece.is_dir():
        raise ValueError(f'Piece directory does not exist: {piece}')
    doc = store.load('workflow_checklist.json')
    at = at or doc.get('default_delivery_stage', 'final')
    if at not in doc.get('delivery_stages', {'final': ''}):
        raise ValueError(f'unknown delivery stage {at}; stages are {", ".join(sorted(doc.get("delivery_stages", {"final": ""})))}')
    known = {s['id'] for s in doc['stages']}
    unknown = [s for s in stages if s not in known]
    if unknown:
        raise ValueError(f'unknown stage {", ".join(unknown)}; stages are {", ".join(sorted(known))}')
    cfg = store.config
    started = None
    if not (piece / 'investigation.json').is_file():
        started = start(store, piece, gate_cfg(store)['default_profile'])['written']
    header = parse_header(piece / cfg['piece_header']['file'], cfg['piece_header']['heading'])
    tags, option_tags, routed_by, flags_unknown = routing(store, piece, options)
    files = option_files(store, piece, options)
    pins = file_pins(store, piece, files)
    later = {PHASE_ID.match(x).group(0) for x in doc['publish_phase'] + doc['after_phase']}
    answers = read_answers(store, piece)
    machine_rows = read_answers(store, piece, True)
    machine = machine_checks(store)
    unanswered, failed, unanswered_optional, per_option_skipped, waits_for_@@an, advisory = [], [], [], [], [], []
    judgment = set(gate_cfg(store).get('judgment_rules', []))
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
                    row = machine_rows.get(key)         # only film-qa's own result, carrying the reviewed pin of the check that measured it, counts
                    row = row if row and row.get('check_pin') == required_pin(store, piece, c['id']) else None
                else:
                    row = answers.get(key)
                item = {'id': c['id'], 'option': opt, 'must': c['must'], 'check': c.get('rule') or c['check'],
                        'verify': c['verify'], 'answer_with': answer_command(piece, c, opt)}
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
                    base = picked_rebuild_of(store, piece, opt) if opt and c.get('rule_id') in judgment else None
                    if base:      # a judgment of the design he picked (this option rebuilds it): his to rule on, listed in the PICK, not blocking; machine rows still block
                        waits_for_@@an.append({**item, 'evidence': row['evidence'], 'by': row['by'], 'rebuild_of': base})
                    else:
                        failed.append({**item, 'evidence': row['evidence'], 'by': row['by']})
    problems = []
    if not header:
        problems.append(f'routes undeclared: {cfg["piece_header"]["file"]} has no "{cfg["piece_header"]["heading"]}" block, so routes cannot be decided. '
                        'Write it (WORKFLOW.md "Piece header and routes") in the piece folder.')
    elif not header_tags({'medium': header.get('medium', '')}, cfg):
        problems.append(f'routes undeclared: the "{cfg["piece_header"]["heading"]}" block in {cfg["piece_header"]["file"]} names no medium, so the checks routed by medium '
                        'would be skipped. Add its medium line (WORKFLOW.md "Piece header and routes").')
    if any(s['id'] in stages for s in doc['stages'] if any(c.get('per_option') for c in s['checks'])) and rule_checks_routed == 0:
        problems.append('WARNING: 0 per-option rule checks are routed for this piece header, so none of @@an\'s edit rules would be asked. '
                        f'Header tags are {sorted(tags)}; fix the header (medium/source/flags) or the rule routes in WORKFLOW.md.')
    return {'all_passed': not (problems or unanswered or failed), 'per_option_rule_checks_routed': rule_checks_routed, 'piece': str(piece), 'stages': stages, 'options': options,
            'at': at, 'tags': sorted(tags), 'flags_unknown': flags_unknown, 'investigation_started': started, 'problems': problems,
            'unanswered_must': unanswered, 'failed_must': failed, 'waits_for_@@an_picked_design': waits_for_@@an, 'advisory': advisory,
            'unanswered_optional_count': len(unanswered_optional),
            'per_option_checks_not_evaluated': per_option_skipped}


def usable_check_pins(store: Store, meta: dict | None, report: Path) -> tuple[dict[str, str], dict[str, str]]:
    """A film-qa result counts, check by check, only when it was produced by the reviewed check: the report's own pin for that check equals the pin
    film-qa computes now (the Workshop's check-a-rendered-video: the check's limit sections and code) and the pin reviewed in cis_config.json gate.film_qa_check_pins.
    Returns ({check: pin} usable, {check: why not}). A report run with other limits than this repository's (FILM_QA_LIMITS) refuses the whole report:
    thresholds and field lists live in that one file."""
    film_qa_tool()
    from rendercheck import config as fq_config, pins as fq_pins  # noqa: E402  (the checker's own modules; one pin owner)
    if not meta or 'check_pins' not in meta:
        raise ValueError(f'{report} has no _run check_pins record; re-run check-a-rendered-video with the current tool and --limits {FILM_QA_LIMITS}')
    cfg = fq_config.load(str(FILM_QA_LIMITS))
    if meta.get('limits_blake3') != fq_config.fingerprint(cfg):
        raise ValueError(f'{report} was produced with other limits; gating accepts only results from {FILM_QA_LIMITS}. '
                         'Put thresholds and field lists in that file and re-run check-a-rendered-video with --limits on it')
    current = fq_pins.check_pins(cfg)
    reviewed = gate_cfg(store)['film_qa_check_pins']
    usable, refused = {}, {}
    for name, pin in current.items():
        if reviewed.get(name) != pin:
            refused[name] = f'{name} (pin {pin[:12]}) is not the reviewed version ({str(reviewed.get(name))[:12]}) in cis_config.json gate.film_qa_check_pins: read the change to this check, then record its new pin with who reviewed it and why. The builder whose previews it judges must not make that entry'
        elif meta['check_pins'].get(name) != pin:
            refused[name] = f'{name} in the report was measured by another version of the check; re-run film-qa'
        else:
            usable[name] = pin
    return usable, refused


def film_config(store: Store, piece: Path) -> dict:
    """The film's pick-gate.json; a folder directly under films/ that has none is still a film and gets gate.film_defaults; any other piece gets {}."""
    piece = piece.expanduser().resolve()
    own = piece / 'pick-gate.json'
    if own.is_file():
        return read_json(own)
    if piece.parent == (store.home / 'films').resolve():
        return gate_cfg(store).get('film_defaults', {})
    return {}


def shipped_globs(store: Store, piece: Path) -> list[str]:
    return (film_config(store, piece).get('checklist_gate') or {}).get('option_globs', [])


def option_id(config: dict, piece: Path, preview: Path) -> str:
    """A preview's option id: its file name without extension, or, when the film's config says option_ids "path" (previews that share a name across
    folders, such as one line file per voice), its path under the film without extension."""
    if config.get('option_ids') == 'path':
        return str(Path(os.path.realpath(preview)).relative_to(piece.expanduser().resolve()).with_suffix(''))
    return preview.stem


def film_previews(store: Store, piece: Path) -> list[Path]:
    """Every shipped preview of the film: files its option_globs match, except under gate.not_previews_pattern folders (work, held-back, watch folders)."""
    root = piece.expanduser().resolve()
    skip = re.compile(gate_cfg(store)['not_previews_pattern'])
    found = {Path(f) for g in shipped_globs(store, root) for f in glob.glob(str(root / g))}
    return sorted(f for f in found if f.is_file() and not skip.search(str(f.relative_to(root).parent)))


def shipped_previews(store: Store, piece: Path) -> set[str] | None:
    """Real paths of the film's shipped previews (film_previews); None when the film declares none."""
    if not shipped_globs(store, piece):
        return None
    return {os.path.realpath(f) for f in film_previews(store, piece)}


@contextlib.contextmanager
def locked(store: Store):
    lock = store.lock()
    try:
        yield
    finally:
        lock.close()


def sweep(store: Store, piece: Path, preview_dirs: list[str], only: list[str] | None = None) -> dict:
    """The fresh sweep before anything goes to a watch folder (rule system-catches-before-@@an): every film-qa rule class runs over every
    option in the given preview folders (the current round and @@an's picks: the whole chapter), through the canonical checker, and the
    results are recorded; faults are listed by rule across all options, so what @@an did not point at is found too. Records the sweep's own
    row for each option measured with no unanswered machine rule left. It also writes a fresh-viewer review pack per folder (film-qa review-pack:
    one-a-second sheets, transcript, @@an_rules, no notes) for a Claude subagent to review; that review makes findings, never a pass or fail
    (tried 2026-10-21: local models invent faults and miss the named one, Sonnet found it; see WORKFLOW.md S5.R55)."""
    piece = piece.expanduser().resolve()
    launcher = [sys.executable, str(film_qa_tool() / 'check_a_rendered_video.py')]      # the Workshop's check-a-rendered-video, run with this repository's limits
    ids, ran, missing, packs, unspecced = [], [], [], [], []
    config = film_config(store, piece)
    compilation = re.compile(gate_cfg(store)['compilation_pattern'])
    ts = datetime.now().astimezone().strftime('%Y%m%d-%H%M%S')
    home = None      # the sweep's files go beside the previews (the chapter's own folder), never to the film root
    for d in preview_dirs:
        folder = (piece / d).resolve() if not Path(d).is_absolute() else Path(d)
        if not folder.is_dir():
            raise ValueError(f'{folder} is not a folder of previews')
        home = home or folder.parent
        chosen = [p for p in sorted(folder.glob('*.mp4')) if not compilation.search(p.stem) and (not only or option_id(config, piece, p) in only)]
        by_specs: dict[Path, list[str]] = {}
        for p in chosen:
            spec = lane_spec(store, piece, p.parent.parent, p.stem)
            if spec is None:
                unspecced.append(str(p))      # no spec: film-qa would pass "nothing in the spec" for what is on screen, so it is not measured
            else:
                by_specs.setdefault(spec.parent, []).append(p.stem)
        for k, (specs, stems) in enumerate(sorted(by_specs.items())):
            out = home / f'sweep-{ts}-{folder.name}{f"-{k + 1}" if k else ""}.json'
            subprocess.run([*launcher, 'batch', str(folder), '--specs', str(specs), '--limits', str(FILM_QA_LIMITS), '--json', str(out), '--ids', ','.join(stems)], check=False, capture_output=True, text=True)
            if not out.is_file():
                missing.append(f'{folder} with {specs}')
                continue
            with locked(store):
                answers_from_filmqa(store, piece, out, None, gate_cfg(store)['machine_by'])
            ids += [option_id(config, piece, folder / f'{s}.mp4') for s in stems]
            ran.append(str(out))
        if chosen:
            pack_dir = home / f'review-{ts}' / folder.name
            subprocess.run([*launcher, 'review-pack', str(folder), '--out', str(pack_dir), '--rules', str(VERDICT_RULES), '--limits', str(FILM_QA_LIMITS), '--ids', ','.join(p.stem for p in chosen)], check=True, capture_output=True, text=True)
            packs += [str(p) for p in sorted(pack_dir.iterdir())]
    with locked(store):
        result = gate(store, piece, ['S5', 'S6'], ids)
    machine = machine_checks(store) - {c['id'] for c in store.checks().values() if c.get('rule_id') in (gate_cfg(store)['sweep_rule'], *gate_cfg(store)['content_gates'])}      # the sweep answers film-qa's rows; the content gates have their own command
    by_rule: dict[str, list] = {}
    for kind in ('failed_must', 'unanswered_must'):
        for item in result[kind]:
            if item['id'] in machine:
                by_rule.setdefault(item['id'], []).append({'option': item['option'], 'state': 'failed' if kind == 'failed_must' else 'not measured', 'why': item.get('evidence', item['verify'])[:160]})
    sweep_check = next(c for c in store.checks().values() if c.get('rule_id') == gate_cfg(store)['sweep_rule'])
    incomplete = {i['option'] for i in result['unanswered_must'] if i['id'] in machine}
    recorded = []
    with locked(store):
        for opt in ids:
            if opt in incomplete:
                continue
            recorded.append(record_answer(store, piece, sweep_check['id'], 'pass',
                                          f'sweep {ts}: every film-qa rule class ran on the whole chapter ({len(ids)} options in {", ".join(Path(d).name for d in preview_dirs)}); faults by rule in {home.name}/sweep-{ts}-report.json',
                                          gate_cfg(store)['sweep_by'], opt, machine=True, check_pin='sweep')['option_id'])
    report = {'at': now(), 'folders': preview_dirs, 'options': ids, 'faults_by_rule': by_rule, 'options_not_fully_measured': sorted(incomplete), 'folders_without_a_report': missing,
              'previews_without_a_spec': unspecced, 'sweep_rows_recorded_for': recorded, 'review_packs': packs, 'review_prompt': "the Workshop's tools/check-a-rendered-video review-pack"}      # the prompt is the Workshop's; the packs above were made by it
    write_json(home / f'sweep-{ts}-report.json', report)
    return {'all_passed': not (by_rule or missing or unspecced), **{k: v for k, v in report.items() if k != 'at'}, 'report': str(home / f'sweep-{ts}-report.json')}


def answers_from_filmqa(store: Store, piece: Path, report: Path, option: str | None, by: str) -> dict:
    """film-qa `--json` output -> one answer per mapped rule. A FAIL finding gives fail; a check that ran without one gives pass."""
    mapping = gate_cfg(store)['film_qa_checks']
    results_by_preview = read_json(report)
    meta = results_by_preview.pop('_run', None)
    results_by_preview.pop('_film_qa', None)      # a report of the old film-qa (before it moved to the Workshop): its pins are not the reviewed ones, so it records nothing
    usable, refused = usable_check_pins(store, meta, report)
    by_rule = {c['rule_id']: c for c in store.checks().values() if c.get('rule_id')}
    unmapped_rule = gate_cfg(store).get('film_qa_unmapped_rule', {})
    recorded = []
    shipped = shipped_previews(store, piece)
    config = film_config(store, piece)
    for preview in results_by_preview:
        if shipped is not None and os.path.realpath(preview) not in shipped:
            raise ValueError(f'{preview} is not a shipped preview of {piece.name} (shipped previews match {", ".join(shipped_globs(store, piece))}); '
                             'film-qa must measure the file @@an will watch, not a work or pending copy')
        if os.path.isfile(preview) and os.stat(preview).st_mtime > report.stat().st_mtime + 1:
            raise ValueError(f'{preview} was changed after {report} was written; re-run film-qa on the current preview before recording its answers')
    for preview, results in results_by_preview.items():
        opt = option or option_id(config, piece, Path(preview))
        for name, findings in results.items():
            if name not in usable:
                continue        # this check is not the reviewed version: no row, so the gate lists it as unanswered
            blip = gate_cfg(store)['not_measured_blip_s']
            unmeasured = [f for f in findings if (f.get('data') or {}).get('not_measured')
                          and (f.get('t') is None or f.get('t_end') is None or f['t_end'] - f['t'] >= blip)]
            if unmeasured and not any(f.get('status') == 'FAIL' for f in findings):
                continue        # film-qa could not measure a graphic that could hold content: no row, so the gate lists it as unanswered (a FAIL is still recorded)
            for entry in mapping.get(name, []):
                rule, pattern = (entry, None) if isinstance(entry, str) else (entry['rule'], entry.get('finding_match'))
                fails = [f for f in findings if f.get('status') == 'FAIL' and (not pattern or re.search(pattern, f['message']))]
                if fails:
                    ev = f'film-qa {name} FAIL on {Path(preview).name}: ' + '; '.join(f['message'] for f in fails[:3])
                elif any((f.get('data') or {}).get('empty_set') for f in findings):
                    ev = f'film-qa {name} on {Path(preview).name}: {findings[0]["message"]} (empty set)'
                else:
                    ev = f'film-qa {name} PASS on {Path(preview).name} ({len(findings)} notes, report {report})'
                recorded.append(record_answer(store, piece, by_rule[rule]['id'], 'fail' if fails else 'pass', ev, by, opt, machine=True, check_pin=usable[name]))
        for name, findings in results.items():
            if name not in usable:
                continue
            if name in unmapped_rule and not any(f.get('status') == 'FAIL' for f in findings):
                linted = next((m.group(1) for f in findings for m in [re.match(r'(\d+) on-screen string', f.get('message', ''))] if m), '0')
                recorded.append(record_answer(store, piece, by_rule[unmapped_rule[name]]['id'], 'pass',
                                              f'film-qa {name} lint on {Path(preview).name}: {linted} on-screen strings linted, no finding left unmapped',
                                              by, opt, machine=True, check_pin=usable[name]))
            patterns = [e['finding_match'] for e in mapping.get(name, []) if isinstance(e, dict) and e.get('finding_match')]
            stray = [f for f in findings if f.get('status') == 'FAIL' and patterns and not any(re.search(x, f['message']) for x in patterns)]
            if stray and name in unmapped_rule:
                ev = f'film-qa {name} FAIL matches no mapped rule (unmapped finding): ' + '; '.join(f['message'] for f in stray[:3])
                recorded.append(record_answer(store, piece, by_rule[unmapped_rule[name]]['id'], 'fail', ev, by, option or option_id(config, piece, Path(preview)), machine=True, check_pin=usable[name]))
    return {'recorded': len(recorded), 'checks_not_recorded': refused, 'rows': [{k: r[k] for k in ('check_id', 'option_id', 'answer')} for r in recorded]}


# --------------------------------------------------------------------------- copy gate and fact gate rows

COPY_CHECK = TOOL_DIR.parent / 'copy-gate' / 'check.mjs'
VERDICT_RULES = TOOL_DIR.parent.parent / 'consolidation' / 'data' / 'verdict-rules.json'


def _flat(text: str) -> str:
    return ' '.join(re.sub(r'[^a-z0-9%]+', ' ', str(text).lower()).split())


def lane_spec(store: Store, piece: Path, lane: Path, name: str) -> Path | None:
    """A preview's spec in its lane: the newest match of the first of the film's checklist_gate.spec_globs (gate.spec_globs when the film names none) that
    matches, each relative to the lane, {name} the preview's file name. content-gates and sweep share this one lookup, so where a film keeps its previews
    and specs is the film's DATA, not a folder-naming rule; newest is by round number, so round 10 follows round 9."""
    globs = (film_config(store, piece).get('checklist_gate') or {}).get('spec_globs') or gate_cfg(store)['spec_globs']
    for pattern in globs:
        found = sorted(lane.glob(pattern.format(name=name)), key=lambda p: [int(t) if t.isdigit() else t for t in re.split(r'(\d+)', str(p))])
        if found:
            return found[-1]
    return None


def option_words(store: Store, piece: Path, lane: Path, option: str) -> tuple[Path | None, list[str], str, list[str]]:
    """(spec path, every on-screen string, every spoken word, unresolved) of one option, read from its spec the way film-qa reads it. The spoken words are the
    first word list the spec names at gate.content_gate_spoken_paths: the cut's whole spoken track when the spec names it (his recorded lines and the inserted
    asker line), else its inserted voice. The copy gate binds each line to the plan's spans, so his lines are judged as his words and the asker line as added."""
    film_qa_tool()
    from rendercheck.checks import text as fq_text  # noqa: E402
    from rendercheck import ctx as fq_ctx  # noqa: E402
    from rendercheck import config as fq_config  # noqa: E402
    spec_path = lane_spec(store, piece, lane, option)
    if spec_path is None:
        return None, [], '', []
    spec = read_json(spec_path)
    cfg = fq_config.load(str(FILM_QA_LIMITS))
    # the on-screen strings are the ones film-qa's text check reads (config text.fields, one reviewed list per event type); an event type that list does not know
    # contributes every value under a text-bearing key, so a new type cannot hide its words from the gate
    strings = [' '.join(x.split()) for _, x in fq_text.strings(types.SimpleNamespace(cfg=cfg, spec=spec)) if x.strip()]
    known = set(cfg['text']['fields'])
    keys = set(gate_cfg(store)['content_gate_text_keys'])

    def under_keys(v, k=None):
        if isinstance(v, str):
            return [v] if k in keys else []
        if isinstance(v, dict):
            return [x for kk, vv in v.items() for x in under_keys(vv, kk)]
        if isinstance(v, list):
            return [x for vv in v for x in under_keys(vv, k)]
        return []
    declared = gate_cfg(store)['content_gate_fields']       # drawn-text paths of event types film-qa's text list does not know (reviewed here, by the checker owner)
    unresolved = []
    for ev in spec.get('events', []):
        t = ev.get('type')
        if t in known:
            got = [x for _, x in fq_text.strings(types.SimpleNamespace(cfg=cfg, spec={'events': [ev]})) if x.strip()]
            wanted = bool(cfg['text']['fields'][t])
        elif t in declared:
            got = []
            for p in declared[t]:
                for v in fq_ctx.dotted(ev, p):
                    got += [' '.join(x.split()) for x in (v if isinstance(v, list) else [v]) if isinstance(x, str) and x.strip()]
            wanted = bool(declared[t])
        else:
            got, wanted = [' '.join(x.split()) for x in under_keys(ev) if x.strip()], False
        if t not in known:      # known types are already in `strings` from film-qa's own reading above
            strings += got
        if wanted and not got and t not in gate_cfg(store)['content_gate_text_optional']:      # picture-led types: a label or caption is optional, so no text is not a miss
            unresolved.append(f'{t} "{ev.get("id")}"')
    strings = list(dict.fromkeys(strings))
    voice = ''
    words_path = next((v for path in gate_cfg(store)['content_gate_spoken_paths'] for v in fq_ctx.dotted(spec, path) if isinstance(v, str) and Path(v).is_file()), None)
    if words_path:
        data = read_json(Path(words_path))
        voice = ' '.join((w.get('text') or w.get('w') or '').strip() for w in (data['words'] if isinstance(data, dict) else data)).strip()
    for wrong, right in cfg['word_clip'].get('spelling_fixes', {}).items():      # the speech-to-text mishears his name; the shot carries the right spelling
        voice = re.sub(rf'\b{re.escape(wrong)}\b', right, voice)
    return spec_path, list(dict.fromkeys(strings)), voice, unresolved


def copy_gate_verdict(results: list[dict], held: bool = False, only: set[str] | None = None) -> tuple[str, str]:
    """('pass'|'advisory'|'fail', detail) of one check.mjs --json result list. A failed line, or a line uncertain for a qualified reason, fails. A line that check.mjs
    marks `advisory` (uncertain only because decider rows are not qualified) is advice: its decider scores are listed, the answer is advisory, never pass.
    `held`: the caller is at a delivery stage where a held artifact is shown to him (his verdict rows: a partly stance, an inferred row, a novel artifact with no
    verdict and no row; TASTE-OWNER-PLAN section 5), so uncertain with nothing failed is advisory there, never a pass; elsewhere it fails as waiting for him.
    `only`: the rule ids this row counts (his_rule_ids for S5.G03); other findings check.mjs also reports belong to another row, so one cause fails one row."""
    if only is not None:
        results = [{**r, 'breaks': [f for f in r.get('breaks', []) if f['rule'] in only], 'uncertain': [f for f in r.get('uncertain', []) if f['rule'] in only]} for r in results]
        results = [{**r, 'verdict': 'fail' if r['breaks'] else 'uncertain' if r['uncertain'] else 'pass',
                    'advisory': bool(r['uncertain']) and all(f.get('qualified') is False or f.get('advisory') is True for f in r['uncertain'])} for r in results]
    fails = [r for r in results if r.get('verdict') == 'fail']
    blocking = [r for r in results if r.get('verdict') == 'uncertain' and not r.get('advisory')]
    advice = [r for r in results if r.get('verdict') == 'uncertain' and r.get('advisory')]
    def found(r):
        return f'"{r["text"]}" (' + ', '.join(f'{f["rule"]}' + (f' {f["p_fail"]:.2f}' if isinstance(f.get('p_fail'), (int, float)) else '') for f in r.get('breaks', []) + r.get('uncertain', [])) + ')'
    if blocking and held and not fails:
        return 'advisory', 'HELD (shown to him at review, fails at final) ' + '; '.join(f'UNCERTAIN {found(r)}' for r in blocking + advice)
    if fails or blocking:
        return 'fail', ' '.join([f'FAIL {found(r)}' for r in fails] + [f'UNCERTAIN (waits for @@an) {found(r)}' for r in blocking])
    if advice:
        return 'advisory', 'ADVISORY (decider not qualified) ' + '; '.join(found(r) for r in advice)
    return 'pass', 'pass'


def spoken_lines(voice: str) -> list[str]:
    """One sentence a line: a waiver by @@an is for the exact text of one line."""
    return [x for x in re.split(r'(?<=[.?!…])\s+', voice) if x.strip()]


def run_check_mjs(file: str, extra: list[str], held: bool = False, only: set[str] | None = None) -> tuple[str, str]:
    """('pass'|'advisory'|'fail', detail) of one check.mjs run on `file`, read from its --json result (copy_gate_verdict, `held` passed through). A run it
    cannot read fails (an uncertain line waits for @@an's verdict). Exit 0 passed, 1 failed, 2 unqualified (no rule applies), 3 uncertain; 2 is also its
    usage error, which writes no result. The result goes to a fresh temporary folder, never beside `file` (a film's own spec)."""
    with tempfile.TemporaryDirectory(prefix='cis-check-') as folder:
        out = Path(folder) / 'result.json'
        run = subprocess.run(['node', str(COPY_CHECK), file, *extra, '--json', str(out)], capture_output=True, text=True, cwd=str(COPY_CHECK.parent), timeout=900)
        if run.returncode in (0, 1, 2, 3) and out.is_file():
            return copy_gate_verdict(json.loads(out.read_text(encoding='utf-8')), held, only)
    return 'fail', f'ERROR rc {run.returncode} ' + ' '.join((run.stdout + run.stderr).split())[-150:]


def lines_file(lines: list[str]) -> str:
    with tempfile.NamedTemporaryFile('w', suffix='.txt', delete=False) as f:
        f.write('\n'.join(x.replace('\n', ' ') for x in lines) + '\n')
    return f.name


def combine(answers: list[str]) -> str:
    return 'fail' if 'fail' in answers else 'advisory' if 'advisory' in answers else 'pass'


def run_copy_gate(strings: list[str], voice: str, stage: str, plan: str | None = None) -> tuple[str, str]:
    """('pass'|'advisory'|'fail', evidence) from check.mjs run on this option's strings (kind onscreen) and its spoken line (kind voiceover) at the delivery
    stage `stage` (copy_gate_verdict). A line it cannot read fails (an uncertain line waits for @@an's verdict in the copy gate's own verdict file). `plan` is
    the plan the cut was built from (the spec's own `plan`): check.mjs --plan binds each line to the recording spans it cites, so his recorded words are told
    from added words (a writing-law row holds on his words and fails on added ones)."""
    evidence, answers = [], []
    for kind, lines in (('onscreen', strings), ('voiceover', spoken_lines(voice))):
        if not lines:
            continue
        answer, detail = run_check_mjs(lines_file(lines), ['--kind', kind, '--stage', stage, *(['--plan', plan] if plan else [])])
        answers.append(answer)
        evidence.append(f'copy gate {kind} {len(lines)} line(s): {detail}')
    return combine(answers), '; '.join(evidence)


def his_rule_ids() -> set[str]:
    """Every rule id a finding of his can carry (verdict-rules.json): his rows, his stance on the artifact (stance_rule) and the novel finding."""
    doc = read_json(VERDICT_RULES)
    return {row['id'] for row in doc['rows']} | {doc['stance_rule'], doc['novel']['rule']}


def run_verdict_rules(spec: Path, strings: list[str], voice: str, stage: str, sources: dict[str, str], held: bool, plan: str | None = None) -> tuple[str, str]:
    """('pass'|'advisory'|'fail', evidence): his verdicts and verdict rows (consolidation/data/verdict-rules.json) on each artifact kind in `sources`, at the
    delivery stage. `sources` (cis_config content_gate_artifact_sources) says where a kind's artifact is read from: the option's spec (a whole JSON artifact),
    its on-screen strings or its spoken line. Every kind with an artifact is judged by check.mjs --verdict-rules, so his exact stance decides first and a kind no
    row of his names is novel there (verdict-rules.mjs), never a pass on silence. `held` (the stage is one where S5.G03 advice passes): an artifact that only
    holds is advisory, shown to him; at any other stage it fails as waiting for him. `plan` binds the lines to the spans the plan cites, as in run_copy_gate,
    so a writing-law row written for added copy holds on his own recorded words here too."""
    answers, evidence, his = [], [], his_rule_ids()
    for kind, source in sources.items():
        lines = {'strings': strings, 'voice': spoken_lines(voice)}.get(source)
        if source == 'spec':
            answer, detail = run_check_mjs(str(spec), ['--artifact-kind', kind, '--verdict-rules', str(VERDICT_RULES), '--stage', stage], held, his)
        elif lines:
            answer, detail = run_check_mjs(lines_file(lines), ['--kind', kind, '--verdict-rules', str(VERDICT_RULES), '--stage', stage, *(['--plan', plan] if plan else [])], held, his)
        else:
            continue
        answers.append(answer)
        evidence.append(f'verdict rules {kind}: {detail}')
    return combine(answers), '; '.join(evidence)


def fact_gate_tool(store: Store, piece: Path) -> Path:
    """The fact gate this film runs: its checklist_gate.fact_gate, else gate.content_gates.fact-gate.tool, a path under this repository's root. There is one
    gate (its rules beside it); every film passes its own lane with --lane-dir, so no film keeps a copy."""
    rel = (film_config(store, piece).get('checklist_gate') or {}).get('fact_gate') or gate_cfg(store)['content_gates']['fact-gate']['tool']
    return DEFAULT_HOME / rel


def run_fact_gate(store: Store, piece: Path, lane: Path, option: str, strings: list[str], voice: str) -> tuple[str, str]:
    """('pass'|'fail', evidence): fact_gate.py on the lane's own shots/claims for this option (<lane>/fact/{shots,claims}/<id>.json, the id also tried without
    its -r<round>-<n> tail). The shot must carry the very strings and spoken line the spec renders, so a gate run on other words cannot answer for this option."""
    rnd = re.search(r'-r(\d+)-\d+$', option)
    roots = [(lane / 'fact', [option, re.sub(r'-r\d+-\d+$', '', option)])]
    if rnd:         # chapter 1's own layout: narrator/{shots,claims}/r<round>-<option>.json (gates_r3.py)
        roots.append((piece / 'narrator', [f'r{rnd.group(1)}-{option}']))
    root, sid = next(((r, i) for r, ids in roots for i in ids if (r / 'claims' / f'{i}.json').is_file() and (r / 'shots' / f'{i}.json').is_file()), (None, None))
    if not sid:
        return 'fail', f'no shots and claims file for {option} under {lane.name}/fact/ (write them, then run fact_gate.py --lane-dir {lane.name}/fact <id>)'
    shot = read_json(root / 'shots' / f'{sid}.json')
    shot_text = _flat(' '.join(e.get('text', '') for e in shot.get('events', [])))
    missing = [x for x in strings if _flat(x) not in shot_text]
    if missing:
        return 'fail', f'shots/{sid}.json does not carry the on-screen string(s) the spec renders: {missing[:3]}'
    if voice:
        script = root / shot['voice']['script'] if (shot.get('voice') or {}).get('script') else None
        spoken = _flat(re.sub(r'\[[^\]]*\](\([^)]*\))?', ' ', script.read_text(encoding='utf-8'))) if script and script.is_file() else ''
        if _flat(voice) != spoken:
            return 'fail', f'the fact shot\'s script is not the line the spec speaks ("{voice[:80]}")'
    run = subprocess.run([sys.executable, '-I', str(fact_gate_tool(store, piece)), '--lane-dir', str(root), sid], capture_output=True, text=True, timeout=300)
    last = (run.stdout.strip().splitlines() or [run.stderr.strip()[-200:]])[-1]
    return ('pass' if run.returncode == 0 else 'fail'), f'fact gate {sid}: {last}'


def content_gates(store: Store, piece: Path, lane: Path, options: list[str] | None, at: str | None = None) -> dict:
    """Record the copy-gate, verdict-rules and fact-gate rows of each option from the gates' own output, run at delivery stage `at` (workflow_checklist.json
    delivery_stages; none named is its default). An option with no on-screen string and no spoken line passes copy-gate and fact-gate as an empty set. Rows are by
    copy-gate / verdict-rules / fact-gate, which no agent can claim (record_answer refuses those names)."""
    piece, lane = piece.expanduser().resolve(), lane.expanduser().resolve()
    doc = store.load('workflow_checklist.json')
    at = at or doc.get('default_delivery_stage', 'final')
    if at not in doc.get('delivery_stages', {'final': ''}):
        raise ValueError(f'unknown delivery stage {at}; stages are {", ".join(sorted(doc.get("delivery_stages", {"final": ""})))}')
    cfg = gate_cfg(store)['content_gates']
    ids = options or sorted({p.stem for p in lane.glob('previews-round-*/*.mp4')})
    by_key = {c['rule_id']: c for c in store.checks().values() if c.get('rule_id') in cfg}
    rows = []
    for opt in ids:
        spec, strings, voice, unresolved = option_words(store, piece, lane, Path(opt).name)      # a path option id (option_ids path) finds its spec and fact files by its file name in the lane
        if spec is None:
            rows.append({'option': opt, 'problem': f'no spec for {opt} in {lane.name} under its spec_globs'})
            continue
        if unresolved:      # fail closed: an event type that should draw text resolved to none, so the gates would run on less than is on screen
            rows.append({'option': opt, 'not_measured': f'{unresolved} resolve to no drawn text; fix the spec or add the type\'s text paths to gate.content_gate_fields. No gate row recorded.'})
            continue
        runners = (('copy-gate', lambda: run_copy_gate(strings, voice, at, read_json(spec).get('plan'))),
                   ('verdict-rules', lambda: run_verdict_rules(spec, strings, voice, at, gate_cfg(store)['content_gate_artifact_sources'], at in by_key['verdict-rules'].get('advisory_passes_at', []), read_json(spec).get('plan'))),
                   ('fact-gate', lambda: run_fact_gate(store, piece, lane, Path(opt).name, strings, voice)))
        for key, runner in runners:
            if not strings and not voice and key != 'verdict-rules':
                answer, ev = 'pass', f'{key}: no on-screen string and no spoken line in {spec.name} (empty set)'
            else:
                answer, ev = runner()
            with locked(store):
                r = record_answer(store, piece, by_key[key]['id'], answer, ev, cfg[key]['by'], opt, machine=True, check_pin=required_pin(store, piece, by_key[key]['id']))
            rows.append({'option': opt, 'check': key, 'answer': r['answer'], 'evidence': ev[:200]})
    return {'rows': rows, 'all_passed': all(r.get('answer') == 'pass' for r in rows)}



def measure_audio(path: Path, marks: dict) -> dict:
    """Integrated loudness (LUFS) and true peak (dBTP) by ffmpeg ebur128, and the quiet spans below marks.quiet_db by ffmpeg silencedetect: head (quiet at the start),
    tail (quiet after the last sound) and the longest gap between sounds, in seconds."""
    number = r'(-?inf|-?\d+(?:\.\d+)?)'
    loud = subprocess.run(['ffmpeg', '-hide_banner', '-nostats', '-i', str(path), '-af', 'ebur128=peak=true', '-f', 'null', '-'], capture_output=True, text=True).stderr
    summary = loud[loud.rfind('Summary:'):]
    lufs, peak = re.search(rf'I:\s+{number} LUFS', summary), re.search(rf'True peak:\s+Peak:\s+{number} dBFS', summary)
    if not (lufs and peak):
        raise ValueError(f'ffmpeg ebur128 gave no loudness summary for {path}')
    duration = float(subprocess.run(['ffprobe', '-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', str(path)], capture_output=True, text=True, check=True).stdout)
    quiet = subprocess.run(['ffmpeg', '-hide_banner', '-nostats', '-i', str(path), '-af', f'silencedetect=noise={marks["quiet_db"]}dB:d={marks["quiet_min_s"]}', '-f', 'null', '-'],
                           capture_output=True, text=True).stderr
    starts = [float(x) for x in re.findall(rf'silence_start: {number}', quiet)]
    ends = [float(x) for x in re.findall(rf'silence_end: {number}', quiet)]
    spans = [(s, ends[i] if i < len(ends) else duration) for i, s in enumerate(starts)]
    edge = 0.01
    head = next((e for s, e in spans if s <= edge), 0.0)
    tail = next((duration - s for s, e in spans if e >= duration - edge), 0.0)
    gaps = [e - s for s, e in spans if s > edge and e < duration - edge]
    return {'lufs': float(lufs.group(1)), 'true_peak_dbtp': float(peak.group(1)), 'head_s': round(head, 3), 'tail_s': round(tail, 3),
            'longest_gap_s': round(max(gaps, default=0.0), 3), 'duration_s': round(duration, 3)}


def audition_gates(store: Store, piece: Path, files: list[Path], at: str | None = None) -> dict:
    """The review stage of an audio-only audition (medium `audition`): for each file, its measured sound against gate.audition.marks (row by audio-measure)
    and his verdict rows on the take (row by verdict-rules: the artifact is {"voice": the folder holding the file, "file": its path under the film}, judged as
    gate.audition.artifact_kind at the delivery stage; a voice he has no stance on waits for him, advisory at review). Each row is for the file's option id."""
    piece = piece.expanduser().resolve()
    doc = store.load('workflow_checklist.json')
    at = at or doc.get('default_delivery_stage', 'final')
    if at not in doc.get('delivery_stages', {'final': ''}):
        raise ValueError(f'unknown delivery stage {at}; stages are {", ".join(sorted(doc.get("delivery_stages", {"final": ""})))}')
    cfg, gates = gate_cfg(store)['audition'], gate_cfg(store)['content_gates']
    marks = cfg['marks']
    by_key = {c['rule_id']: c for c in store.checks().values() if c.get('rule_id') in gates}
    config = film_config(store, piece)
    shipped = {os.path.realpath(p): option_id(config, piece, p) for p in film_previews(store, piece)}
    rows = []
    for f in files:
        opt = shipped.get(os.path.realpath(f))
        if not opt:
            rows.append({'file': str(f), 'problem': f'not a shipped preview of {piece.name} (shipped previews match {", ".join(shipped_globs(store, piece)) or "nothing"})'})
            continue
        m = measure_audio(Path(f), marks)
        low, high = marks['loudness_lufs']
        misses = [f'{name} {value}' for name, value, ok in (
            ('loudness LUFS', m['lufs'], low <= m['lufs'] <= high), ('true peak dBTP', m['true_peak_dbtp'], m['true_peak_dbtp'] <= marks['true_peak_dbtp_max']),
            ('head s', m['head_s'], m['head_s'] <= marks['head_s_max']), ('tail s', m['tail_s'], m['tail_s'] <= marks['tail_s_max']),
            ('longest gap s', m['longest_gap_s'], m['longest_gap_s'] <= marks['gap_s_max'])) if not ok]
        evidence = (f'{Path(f).name}: {m["lufs"]} LUFS (mark {low} to {high}), true peak {m["true_peak_dbtp"]} dBTP (mark <= {marks["true_peak_dbtp_max"]}), head {m["head_s"]} s, '
                    f'tail {m["tail_s"]} s, longest gap {m["longest_gap_s"]} s (marks {marks["head_s_max"]} / {marks["tail_s_max"]} / {marks["gap_s_max"]} s below {marks["quiet_db"]} dB)'
                    + (f'; outside its mark: {", ".join(misses)}' if misses else ''))
        with tempfile.NamedTemporaryFile('w', suffix='.json', delete=False) as artifact:
            artifact.write(json.dumps({'voice': Path(f).parent.name, 'file': opt}))
        verdict, detail = run_check_mjs(artifact.name, ['--artifact-kind', cfg['artifact_kind'], '--verdict-rules', str(VERDICT_RULES), '--stage', at, '--no-model'],
                                        at in by_key['verdict-rules'].get('advisory_passes_at', []), his_rule_ids())      # a take of a voice he has not ruled on: the audition is how he is asked
        for key, answer, ev in (('audio-measure', 'fail' if misses else 'pass', evidence), ('verdict-rules', verdict, f'verdict rules {cfg["artifact_kind"]} {Path(f).parent.name}: {detail}')):
            with locked(store):
                r = record_answer(store, piece, by_key[key]['id'], answer, ev, gates[key]['by'], opt, machine=True, check_pin=required_pin(store, piece, by_key[key]['id']))
            rows.append({'option': opt, 'check': key, 'answer': r['answer'], 'evidence': ev[:300]})
    advice_ok = {key: at in by_key[key].get('advisory_passes_at', []) for key in ('audio-measure', 'verdict-rules')}
    return {'rows': rows, 'all_passed': all(r.get('answer') == 'pass' or (r.get('answer') == 'advisory' and advice_ok[r['check']]) for r in rows)}


# --------------------------------------------------------------------------- audit of what is linked for @@an to watch

def watch_folders(store: Store, piece: Path) -> list[Path]:
    """Every folder under the film whose name is a watch folder (gate.watch_folder_pattern); folders no preview lives in (gate.not_previews_pattern) are not entered."""
    watch = re.compile(gate_cfg(store)['watch_folder_pattern'])
    skip = re.compile(gate_cfg(store)['not_previews_pattern'])
    found = []
    for folder, subdirs, _ in os.walk(piece):
        subdirs[:] = [d for d in subdirs if watch.search(d) or not skip.search(d)]
        if watch.search(Path(folder).name):
            found.append(Path(folder))
    return sorted(found)


def audit_watch(store: Store, piece: Path, hold: bool, files: list[Path] | None = None) -> dict:
    """Walk the watch folders under the film, map each linked file back to its option by inode against the shipped previews (pick-gate.json
    checklist_gate.option_globs), run the gate for those options, and list each linked file whose option has an open or failed MUST row. With hold=True the
    links move to the lane's held-back-from-watch/ (the shipped preview itself is never touched). This is the after-the-fact check for any route that put a
    file in front of @@an without passing the gate.
    Scope: a pick replaced by a later-round pick of the same moment is listed as a superseded pick, not audited. Per lane the latest "ROUND n - watch these", every "WHOLE FILM ..." folder, and any file whose option is a recorded pick (pick-gate.json
    picked_verdicts in its verdict_file), wherever it sits. Files of older round folders are reported as superseded and never audited or held. An option whose
    only open row is S5.G01 waiting on @@an's ruling (an UNCERTAIN copy line) is listed as waits_for_@@an, not as an offender, and is never held. A failed judgment row on a rebuild of
    a picked design (spec rebuild_of) is listed in waits_for_@@an_picked_design (option, rebuild_of, rules, files); it is not an open row, so it never moves a link: only the option's
    blocking rows do.
    A piece-level open row, or a gate problem (no piece header, so routes cannot be decided), holds every audited file. A per-option row recorded before its
    file last changed is open, and so is a piece-level row recorded before any file it routes to changed (gate's stale_reason). files: audit exactly these files (a file about to be opened or played for @@an) instead of the watch folders; a compilation
    (gate.compilation_pattern) stands for every shipped preview in its folder, and a file that maps to no shipped preview is an offender, since no check covers it."""
    piece = piece.expanduser().resolve()
    config = film_config(store, piece)
    picks = set()
    verdicts = piece / config.get('verdict_file', '')
    if verdicts.is_file():
        picks = {r['option_id'] for r in (json.loads(x) for x in verdicts.read_text(encoding='utf-8').splitlines() if x.strip()) if r.get('verdict') in config.get('picked_verdicts', [])}
    by_inode: dict[tuple[int, int], tuple[str, Path]] = {}
    for f in film_previews(store, piece):
        st = os.stat(f)
        by_inode[(st.st_dev, st.st_ino)] = (option_id(config, piece, f), f)
    folders = [] if files is not None else watch_folders(store, piece)
    latest: dict[Path, int] = {}
    for p in folders:
        m = re.match(r'(?i)ROUND (\d+) ', p.name)
        if m:
            latest[p.parent] = max(latest.get(p.parent, 0), int(m.group(1)))
    aliases = gate_cfg(store).get('moment_aliases', {})

    def moment_round(option: str) -> tuple[str, int] | None:
        return option_moment_round(option, aliases)
    pick_rounds = [mr for mr in (moment_round(o) for o in picks) if mr]

    def superseded_pick(option: str) -> bool:
        """A pick whose moment has a pick of a later round: @@an replaced it. A rebuild he has not picked yet leaves the older pick live."""
        mr = moment_round(option)
        return bool(mr) and option in picks and any(m == mr[0] and r > mr[1] for m, r in pick_rounds)

    linked, unmatched, superseded, superseded_picks = [], [], [], []
    for folder in folders:
        m = re.match(r'(?i)ROUND (\d+) ', folder.name)
        old_round = bool(m) and int(m.group(1)) < latest[folder.parent]
        for f in sorted(folder.iterdir()):
            if not (f.is_file() and not f.name.startswith('.') and f.suffix.lower() in ('.mp4', '.mov')):
                continue
            st = os.stat(f)
            hit = by_inode.get((st.st_dev, st.st_ino))
            if not hit:
                unmatched.append((f, None, None))
            elif superseded_pick(hit[0]):
                superseded_picks.append({'file': str(f), 'option': hit[0]})
            elif old_round and hit[0] not in picks:
                superseded.append(str(f))
            else:
                linked.append((f, hit[0], hit[1]))
    compilation = re.compile(gate_cfg(store)['compilation_pattern'])
    for f in files or []:
        f = f.expanduser().absolute()
        st = os.stat(f) if f.is_file() else None
        option, preview = by_inode.get((st.st_dev, st.st_ino), (None, None)) if st else (None, None)
        if preview and not compilation.search(preview.stem):
            linked.append((f, option, preview))
            continue
        members = [p for _, p in by_inode.values() if p.parent == (preview or f).parent and not compilation.search(p.stem)] if compilation.search(f.stem) or preview else []
        linked += [(f, option_id(config, piece, p), p) for p in members]
        if not members:
            unmatched.append((f, None, None))
    options = sorted({o for _, o, _ in linked})
    result = gate(store, piece, ['S5', 'S6'], options, at='review') if options else {'unanswered_must': [], 'failed_must': [], 'waits_for_@@an_picked_design': [], 'problems': []}
    open_rows: dict[str | None, list[str]] = {}
    only_ruling: dict[str | None, bool] = {}
    for kind in ('failed_must', 'unanswered_must'):
        for item in result[kind]:
            row = f"{item['id']} ({'failed' if kind == 'failed_must' else 'stale' if item.get('stale') else 'open'})"
            waits = kind == 'failed_must' and item['id'] in {c['id'] for c in store.checks().values() if c.get('rule_id') in ('copy-gate', 'verdict-rules')} and 'UNCERTAIN' in item.get('evidence', '') and 'FAIL' not in item['evidence'].replace('UNCERTAIN', '')
            for opt in ([item['option']] if item['option'] else item.get('for_options', options)):      # a piece-level open row holds every file it routes to
                open_rows.setdefault(opt, []).append(row)
                only_ruling[opt] = only_ruling.get(opt, True) and waits
    whole = result.get('problems', [])      # a gate problem holds every file
    offenders, waiting, moved = [], [], []
    if files is not None:
        offenders += [{'file': str(f), 'option': None, 'rows': [f'not a shipped preview of {piece.name}: no check covers it (shipped previews match {", ".join(shipped_globs(store, piece)) or "nothing"})']}
                      for f, _, _ in unmatched]
    for f, opt, preview in linked:
        rows = whole + open_rows.get(opt, [])
        if not rows:
            continue
        if not whole and only_ruling.get(opt):
            waiting.append({'file': str(f), 'option': opt, 'rows': rows})
            continue
        offenders.append({'file': str(f), 'option': opt, 'rows': rows})
        if hold and files is None:
            held = preview.parent.parent / 'held-back-from-watch'       # the option's own lane (previews sit one folder below it), also for the WHOLE FILM folder
            held.mkdir(exist_ok=True)
            dst = held / f.name
            if dst.exists():        # a second link of the same file: rename onto a link of the same inode is a no-op, so it takes its folder's name
                dst = held / f'{f.parent.name} - {f.name}'
            os.replace(f, dst)
            moved.append(str(dst))
    picked_waits: dict[str, dict] = {}
    for item in result.get('waits_for_@@an_picked_design', []):
        entry = picked_waits.setdefault(item['option'], {'option': item['option'], 'rebuild_of': item['rebuild_of'], 'rules': [], 'files': [str(f) for f, o, _ in linked if o == item['option']]})
        entry['rules'].append({'id': item['id'], 'rule': item['check'], 'evidence': item['evidence'][:200]})
    return {'all_passed': not offenders, 'linked_files_audited': len(linked), 'options_checked': len(options), 'offenders': offenders, 'problems': result.get('problems', []), 'advisory': result.get('advisory', []),
            'waits_for_@@an': waiting, 'waits_for_@@an_picked_design': sorted(picked_waits.values(), key=lambda e: e['option']), 'moved_to_held_back': moved, 'superseded_picks': superseded_picks,
            'superseded_not_audited': {'files': len(superseded), 'note': 'older ROUND folders that @@an already watched, and whose option is not a recorded pick; never held'},
            'files_not_matching_any_shipped_preview': [str(f) for f, _, _ in unmatched]}


def option_moment_round(option: str, aliases: dict) -> tuple[str, int] | None:
    """(moment key, round) of an option id, the one rule for which pick replaced which: m02-r2-2, m12-3-r2 and c2m03-r1-1 carry their round; a round-1 id such as m12-3 has none
    and is round 1; config gate.moment_aliases names an option whose moment was renumbered (m07-1 is the moment m11-r3-1 replaced)."""
    m = re.match(r'^(c?\d*m\d+)-(?:\d+-)?r(\d+)(?:-\d+)?$', option)
    if m:
        return aliases.get(option, m.group(1)), int(m.group(2))
    m = re.match(r'^(c?\d*m\d+)-\d+$', option)
    return (aliases.get(option, m.group(1)), 1) if m else None


def scope_options(store: Store, piece: Path, lane_name: str | None) -> list[str]:
    """The options a whole-lane gate must cover when a write names none: per lane the previews of its latest round plus the live picks (a pick with no pick of a
    later round for its moment). Superseded rounds are left out, as in audit_watch. lane_name None means every lane."""
    piece = piece.expanduser().resolve()
    aliases = gate_cfg(store).get('moment_aliases', {})
    config = film_config(store, piece)
    verdicts = piece / config.get('verdict_file', '')
    picks = set()
    if verdicts.is_file():
        picks = {r['option_id'] for r in (json.loads(x) for x in verdicts.read_text(encoding='utf-8').splitlines() if x.strip()) if r.get('verdict') in config.get('picked_verdicts', [])}

    def moment_round(option: str) -> tuple[str, int] | None:
        return option_moment_round(option, aliases)
    pick_rounds = [mr for mr in (moment_round(o) for o in picks) if mr]
    out: set[str] = set()
    by_lane: dict[str, dict[int, set[str]]] = {}
    for p in film_previews(store, piece):
        lane = next((x.name for x in p.parents if x.name.startswith('options-ch')), '')
        rnd = int(re.search(r'previews-round-(\d+)', str(p.parent.name)).group(1)) if re.search(r'previews-round-(\d+)', p.parent.name) else 0
        by_lane.setdefault(lane, {}).setdefault(rnd, set()).add(option_id(config, piece, p))
    for lane, rounds in by_lane.items():
        if lane_name and lane != lane_name:
            continue
        out |= rounds[max(rounds)]
        for r_opts in rounds.values():
            for o in r_opts:
                mr = moment_round(o)
                if o in picks and not (mr and any(m == mr[0] and r > mr[1] for m, r in pick_rounds)):
                    out.add(o)
    return sorted(out)



# --------------------------------------------------------------------------- CLI

def main(argv: list[str] | None = None) -> int:
