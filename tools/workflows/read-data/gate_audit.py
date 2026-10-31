"""Which items a gate must cover, and the audit of what has been put in front of the person.

Items come in rounds and a later round can replace an earlier pick of the same moment: the schema's `items.moments` patterns say how an item id carries its
moment and round. A watch folder is a folder the person is shown files from; a file there that no check covers, or whose item has an open or failed
required row, is an offender.
"""
from __future__ import annotations

import os
import re
from pathlib import Path

from gate_answers import gate, picked_items
from gate_library import Library
from gate_pieces import item_globs, item_id, piece_files, lane_of


def moment_round(lib: Library, option: str) -> tuple[str, int] | None:
    """(moment key, round) of an item id, the one rule for which pick replaced which: the schema's patterns, each with a moment group and a round group
    (or a fixed round); `moments.aliases` names an item whose moment was renumbered."""
    cfg = lib.section('items')['moments']
    for rule in cfg['patterns']:
        m = re.match(rule['pattern'], option)
        if m:
            return cfg['aliases'].get(option, m.group(rule['moment_group'])), int(m.group(rule['round_group'])) if 'round_group' in rule else rule['round']
    return None


def superseded_pick(lib: Library, option: str, picks: set[str], pick_rounds: list[tuple[str, int]]) -> bool:
    """A pick whose moment has a pick of a later round: the person replaced it. A rebuild they have not picked yet leaves the older pick live."""
    mr = moment_round(lib, option)
    return bool(mr) and option in picks and any(m == mr[0] and r > mr[1] for m, r in pick_rounds)


def scope_options(lib: Library, piece: Path, lane_name: str | None) -> list[str]:
    """The items a whole-lane gate must cover when a write names none: per lane the items of its latest round plus the live picks (a pick with no pick of a
    later round for its moment). Superseded rounds are left out, as in audit. lane_name None means every lane."""
    piece = piece.expanduser().resolve()
    items = lib.section('items')
    picks = picked_items(lib, piece)
    pick_rounds = [mr for mr in (moment_round(lib, o) for o in picks) if mr]
    out: set[str] = set()
    by_lane: dict[str, dict[int, set[str]]] = {}
    for p in piece_files(lib, piece):
        lane = next((x.name for x in p.parents if re.search(items['lane_dir_pattern'], x.name)), '')
        found = re.search(items['round_dir_pattern'], p.parent.name)
        rnd = int(found.group(1)) if found else 0
        by_lane.setdefault(lane, {}).setdefault(rnd, set()).add(item_id(lib, piece, p))
    for lane, rounds in by_lane.items():
        if lane_name and lane != lane_name:
            continue
        out |= rounds[max(rounds)]
        for r_opts in rounds.values():
            for o in r_opts:
                if o in picks and not superseded_pick(lib, o, picks, pick_rounds):
                    out.add(o)
    return sorted(out)


def watch_folders(lib: Library, piece: Path) -> list[Path]:
    """Every folder under the piece whose name is a watch folder (the schema's watch_folder_pattern); folders no item lives in (not_items_pattern) are not entered."""
    items = lib.section('items')
    watch, skip = re.compile(items['watch_folder_pattern']), re.compile(items['not_items_pattern'])
    found = []
    for folder, subdirs, _ in os.walk(piece):
        subdirs[:] = [d for d in subdirs if watch.search(d) or not skip.search(d)]
        if watch.search(Path(folder).name):
            found.append(Path(folder))
    return sorted(found)


def audit(lib: Library, piece: Path, hold: bool, files: list[Path] | None = None) -> dict:
    """Walk the watch folders under the piece, map each linked file back to its item by inode against the offered files, run the gate for those items, and
    list each linked file whose item has an open or failed required row. With hold=True the links move to the lane's held-back folder (the offered file itself
    is never touched). This is the after-the-fact check for any route that put a file in front of the person without passing the gate.
    Scope: a pick replaced by a later-round pick of the same moment is listed as a superseded pick, not audited. Per lane the latest round folder, every
    "whole" folder, and any file whose item is a recorded pick, wherever it sits. Files of older round folders are reported as superseded and never audited or
    held. An item whose only open row is a ruling the person owes (evidence marked uncertain by a gate named in the schema) is listed as waits_for_person, not as
    an offender, and is never held. A failed judgment row on a rebuild of a picked design is listed in waits_for_person_picked_design; it is not an open row, so it
    never moves a link. A piece-level open row, or a gate problem (no piece header), holds every audited file. files: audit exactly these files (a file about
    to be shown) instead of the watch folders; a compilation stands for every offered file in its folder, and a file that maps to no offered file is an
    offender, since no check covers it."""
    piece = piece.expanduser().resolve()
    items = lib.section('items')
    audit_cfg = lib.section('audit')
    picks = picked_items(lib, piece)
    by_inode: dict[tuple[int, int], tuple[str, Path]] = {}
    for f in piece_files(lib, piece):
        st = os.stat(f)
        by_inode[(st.st_dev, st.st_ino)] = (item_id(lib, piece, f), f)
    folders = [] if files is not None else watch_folders(lib, piece)
    round_pattern = items['watch_round_pattern']
    latest: dict[Path, int] = {}
    for p in folders:
        m = re.match(round_pattern, p.name)
        if m:
            latest[p.parent] = max(latest.get(p.parent, 0), int(m.group(1)))
    pick_rounds = [mr for mr in (moment_round(lib, o) for o in picks) if mr]

    suffixes = tuple(items['watch_suffixes'])
    linked, unmatched, superseded, superseded_picks = [], [], [], []
    for folder in folders:
        m = re.match(round_pattern, folder.name)
        old_round = bool(m) and int(m.group(1)) < latest[folder.parent]
        for f in sorted(folder.iterdir()):
            if not (f.is_file() and not f.name.startswith('.') and f.suffix.lower() in suffixes):
                continue
            st = os.stat(f)
            hit = by_inode.get((st.st_dev, st.st_ino))
            if not hit:
                unmatched.append((f, None, None))
            elif superseded_pick(lib, hit[0], picks, pick_rounds):
                superseded_picks.append({'file': str(f), 'option': hit[0]})
            elif old_round and hit[0] not in picks:
                superseded.append(str(f))
            else:
                linked.append((f, hit[0], hit[1]))
    compilation = re.compile(items['compilation_pattern'])
    for f in files or []:
        f = f.expanduser().absolute()
        st = os.stat(f) if f.is_file() else None
        option, preview = by_inode.get((st.st_dev, st.st_ino), (None, None)) if st else (None, None)
        if preview and not compilation.search(preview.stem):
            linked.append((f, option, preview))
            continue
        members = [p for _, p in by_inode.values() if p.parent == (preview or f).parent and not compilation.search(p.stem)] if compilation.search(f.stem) or preview else []
        linked += [(f, item_id(lib, piece, p), p) for p in members]
        if not members:
            unmatched.append((f, None, None))
    options = sorted({o for _, o, _ in linked})
    result = gate(lib, piece, audit_cfg['stages'], options, at=audit_cfg['at']) if options else {'unanswered_must': [], 'failed_must': [], 'waits_for_person_picked_design': [], 'problems': []}
    open_rows: dict[str | None, list[str]] = {}
    only_ruling: dict[str | None, bool] = {}
    ruling = items['ruling_waits']
    ruling_checks = {c['id'] for c in lib.checks().values() if c.get('rule_id') in ruling['rules']}
    for kind in ('failed_must', 'unanswered_must'):
        for item in result[kind]:
            row = f"{item['id']} ({'failed' if kind == 'failed_must' else 'stale' if item.get('stale') else 'open'})"
            waits = (kind == 'failed_must' and item['id'] in ruling_checks and ruling['uncertain_word'] in item.get('evidence', '')
                     and ruling['fail_word'] not in item['evidence'].replace(ruling['uncertain_word'], ''))
            for opt in ([item['option']] if item['option'] else item.get('for_options', options)):      # a piece-level open row holds every file it routes to
                open_rows.setdefault(opt, []).append(row)
                only_ruling[opt] = only_ruling.get(opt, True) and waits
    whole = result.get('problems', [])      # a gate problem holds every file
    offenders, waiting, moved = [], [], []
    if files is not None:
        offenders += [{'file': str(f), 'option': None, 'rows': [f'not a file {piece.name} offers: no check covers it (offered files match {", ".join(item_globs(lib, piece)) or "nothing"})']}
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
            held = lane_of(lib, preview) / items['held_folder']       # the item's own lane, also for the whole-piece folder
            held.mkdir(exist_ok=True)
            dst = held / f.name
            if dst.exists():        # a second link of the same file: rename onto a link of the same inode is a no-op, so it takes its folder's name
                dst = held / f'{f.parent.name} - {f.name}'
            os.replace(f, dst)
            moved.append(str(dst))
    picked_waits: dict[str, dict] = {}
    for item in result.get('waits_for_person_picked_design', []):
        entry = picked_waits.setdefault(item['option'], {'option': item['option'], 'rebuild_of': item['rebuild_of'], 'rules': [], 'files': [str(f) for f, o, _ in linked if o == item['option']]})
        entry['rules'].append({'id': item['id'], 'rule': item['check'], 'evidence': item['evidence'][:200]})
    return {'all_passed': not offenders, 'linked_files_audited': len(linked), 'options_checked': len(options), 'offenders': offenders, 'problems': result.get('problems', []), 'advisory': result.get('advisory', []),
            'waits_for_person': waiting, 'waits_for_person_picked_design': sorted(picked_waits.values(), key=lambda e: e['option']), 'moved_to_held_back': moved, 'superseded_picks': superseded_picks,
            'superseded_not_audited': {'files': len(superseded), 'note': 'older round folders the person already watched, and whose item is not a recorded pick; never held'},
            'files_not_matching_any_offered_file': [str(f) for f, _, _ in unmatched]}
