#!/usr/bin/env python3
"""Keep a library of records valid, and work one piece through a question bank with evidence.

  validate                            run every check, table check, builder and derived-file command the schema declares
  rebuild-data [--check] [--out DIR]  rebuild the files the schema's builders derive from sources (--check writes nothing)
  start <piece> --profile ID          write <piece>/investigation.json with a small question set for a run profile
  next <piece>                        open questions whose prerequisites are done
  evidence <piece> --q ID ...         answer a question with evidence files (refused when a file is missing); stores each file's BLAKE3 identity
  finding <piece> --kind K --title T  add a finding at piece level and to the findings library
  progress <piece>                    status counts, defects and whether evidence still matches its recorded identity
  adopt-window INPUT                  adopt a saved, reviewed packet of picture evidence into the files that own it
  project-frame-manifest ...          a frame manifest as records whose files carry their BLAKE3 identity
  frame-pages MANIFEST OUTPUT ...     labelled review pages from already-extracted frames
  finalize-page-journal ...           join a manifest, an extraction readback and page notes into a pinned journal
  validate-page-journal JOURNAL       recheck every join and identity of a finalized journal
  locate-quote ...                    where a literal quote occurs, once, in a transcript and a JSON3 caption file

`--library DIR` is the library root and `--schema FILE` the JSON file that names the library's files, checks, builders and
settings (see the README); `locate-quote` and `frame-pages` need neither. A recorded answer establishes structure and file
identity, not that the answer is true.
Run with: python3 -I do-work/keep_a_record_library.py --library DIR --schema FILE COMMAND ...
"""
from __future__ import annotations

import argparse
import contextlib
import json
import subprocess
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'read-data'))

import adoption  # noqa: E402
import checks  # noqa: E402
import derived_data  # noqa: E402
import frame_evidence  # noqa: E402
import investigation  # noqa: E402
import quote_locator  # noqa: E402
from library import PROGRAM, Store, read_json  # noqa: E402

WRITERS = ('start', 'evidence', 'finding')
NEEDS_LIBRARY = ('validate', 'rebuild-data', 'start', 'next', 'evidence', 'finding', 'progress', 'adopt-window')


def pair(text: str) -> tuple[str, str]:
    name, sep, value = text.partition('=')
    if not sep or not name:
        raise argparse.ArgumentTypeError(f'{text!r} is not name=value')
    return name, value


def build_parser() -> argparse.ArgumentParser:
    ap = argparse.ArgumentParser(prog=PROGRAM, description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('--library', type=Path, help='the library root')
    ap.add_argument('--schema', type=Path, help='the schema file')
    ap.add_argument('--input', action='append', default=[], type=pair, metavar='NAME=PATH',
                    help='a file a builder reads that is not in the library, such as a database (repeatable); a builder whose input is not given is not checked')
    sub = ap.add_subparsers(dest='cmd', required=True)
    sub.add_parser('validate')
    rb = sub.add_parser('rebuild-data')
    rb.add_argument('--out', type=Path, help='Write here, under each output\'s own relative path, instead of the library')
    rb.add_argument('--check', action='store_true', help='Write nothing; list stale files, exit 1 if any')
    s = sub.add_parser('start')
    s.add_argument('piece', type=Path)
    s.add_argument('--profile', required=True)
    s.add_argument('--limit', type=int)
    s.add_argument('--objective', default='')
    n = sub.add_parser('next')
    n.add_argument('piece', type=Path)
    n.add_argument('--limit', type=int, default=20)
    e = sub.add_parser('evidence')
    e.add_argument('piece', type=Path)
    e.add_argument('--q', required=True)
    e.add_argument('--status', required=True)
    e.add_argument('--file', action='append', default=[])
    e.add_argument('--note', default='')
    e.add_argument('--append', action='store_true', help='Keep distinct source references and the note; revised paths use their new identity while history remains; identical retries do not duplicate the note')
    e.add_argument('--label', help='the claim label (default: the first the schema lists)')
    e.add_argument('--defect', action='store_true', help='The answer found something wrong in the piece')
    e.add_argument('--caught-by', action='append', default=[], help='id of a check that already caught this (repeatable), or none')
    f = sub.add_parser('finding')
    f.add_argument('piece', type=Path)
    f.add_argument('--kind', required=True, help='one of the finding kinds the schema names')
    f.add_argument('--title', required=True)
    f.add_argument('--field', action='append', default=[], type=pair, metavar='NAME=VALUE', help='a field the finding kind requires (repeatable)')
    f.add_argument('--q')
    f.add_argument('--evidence', action='append', default=[])
    f.add_argument('--label')
    p = sub.add_parser('progress')
    p.add_argument('piece', type=Path)
    ad = sub.add_parser('adopt-window')
    ad.add_argument('input', type=Path, help='the saved adoption input (its `schema` member picks intervals or evidence-only)')
    pm = sub.add_parser('project-frame-manifest')
    pm.add_argument('--manifest', required=True, type=Path)
    pm.add_argument('--output', required=True, type=Path)
    fp = sub.add_parser('frame-pages')
    fp.add_argument('manifest', type=Path)
    fp.add_argument('output', type=Path)
    fp.add_argument('--per-page', type=int, default=48)
    fp.add_argument('--tile-width', type=int, default=256)
    fp.add_argument('--quality', type=int, default=40)
    fp.add_argument('--font', type=Path, help='a TrueType/OpenType file for the labels (default: Pillow\'s own)')
    fp.add_argument('--candidate-pairs', action='store_true', help='Arrange adjacent native candidates with explicit frame/PTS/time labels')
    fp.add_argument('--pairs-per-page', type=int, default=6)
    fj = sub.add_parser('finalize-page-journal')
    fj.add_argument('--manifest', required=True, type=Path)
    fj.add_argument('--extraction-readback', required=True, type=Path)
    fj.add_argument('--page-observation', type=Path, action='append', default=[])
    fj.add_argument('--page-readback', type=Path, action='append', default=[])
    fj.add_argument('--output', required=True, type=Path)
    vj = sub.add_parser('validate-page-journal')
    vj.add_argument('journal', type=Path)
    lq = sub.add_parser('locate-quote')
    lq.add_argument('--transcript', required=True, type=Path)
    lq.add_argument('--json3', required=True, type=Path)
    quote = lq.add_mutually_exclusive_group(required=True)
    quote.add_argument('--quote')
    quote.add_argument('--quote-file', type=Path, help='UTF-8 file containing the literal quote')
    return ap


def rebuild(store: Store, a: argparse.Namespace) -> dict:
    built, not_checked = derived_data.build_all(store, dict((k, Path(v)) for k, v in a.input))
    if a.check:
        bad = derived_data.stale(store, built)
        return {'stale': bad, 'current': [n for n in built if n not in bad], 'not_checked': not_checked, 'all_passed': not bad}
    target = a.out or store.root
    derived_data.write_all(target, built)
    return {'written': str(target), 'files': {n: len(v) for n, v in built.items()}, 'not_written': not_checked}


def adoption_profile(store: Store) -> dict:
    """The schema's adoption profile with its frame-evidence profile, as the adoption code reads them."""
    return {**store.schema.get('adoption', {}), 'frame_evidence': store.schema.get('frame_evidence', {})}


def profile_of(a: argparse.Namespace) -> dict:
    if not a.schema:
        raise ValueError('This command needs --schema, which holds the frame_evidence profile')
    return frame_evidence.check_profile(read_json(a.schema).get('frame_evidence'))


def run_library(a: argparse.Namespace):
    store = Store(a.library, a.schema)
    with contextlib.ExitStack() as stack:
        if a.cmd in WRITERS:
            stack.enter_context(store.lock())
        return dispatch(store, a)


def dispatch(store: Store, a: argparse.Namespace):
    if a.cmd == 'start':
        return investigation.start(store, a.piece, a.profile, a.limit, a.objective)
    if a.cmd == 'next':
        return investigation.next_open(store, a.piece, a.limit)
    if a.cmd == 'evidence':
        return investigation.record_evidence(store, a.piece, a.q, a.status, a.file, a.note, a.label, a.defect, a.caught_by, append=a.append)
    if a.cmd == 'finding':
        return investigation.add_finding(store, a.piece, a.kind, a.title, dict(a.field), a.q, a.evidence, a.label)
    if a.cmd == 'progress':
        return investigation.progress(store, a.piece)
    if a.cmd == 'rebuild-data':
        return rebuild(store, a)
    if a.cmd == 'adopt-window':
        profile = adoption.check_profile(adoption_profile(store))
        frame_evidence.check_profile(profile['frame_evidence'])
        # The adoption takes the library lock itself, where it must.
        data = read_json(a.input)
        if data.get('schema') == profile['source_evidence_only']['schema']:
            return adoption.adopt_source_evidence_only(store, profile, a.input, store.root)
        return adoption.adopt_intervals(store, profile, a.input, store.root)
    return checks.validate(store, dict((k, Path(v)) for k, v in a.input))


def run_frames(a: argparse.Namespace):
    if a.cmd == 'project-frame-manifest':
        return frame_evidence.write_projection(a.manifest, a.output, profile_of(a)['projection_schema'])
    if a.cmd == 'frame-pages':
        if a.candidate_pairs:
            result = frame_evidence.build_candidate_pair_pages_from_manifest(a.manifest, a.output, a.pairs_per_page, a.tile_width, a.quality, a.font)
            keys = ('pair_count', 'page_count', 'review_status')
        else:
            result = frame_evidence.build_pages(a.manifest, a.output, a.per_page, a.tile_width, a.quality, a.font)
            keys = ('frame_count', 'page_count', 'review_status')
        return {key: result[key] for key in keys}
    if a.cmd == 'finalize-page-journal':
        return frame_evidence.finalize_page_journal(a.manifest, a.extraction_readback, a.page_observation, a.page_readback, a.output, profile_of(a))
    if a.cmd == 'validate-page-journal':
        return frame_evidence.validate_page_journal(a.journal, profile_of(a))
    text = a.quote_file.read_text(encoding='utf-8') if a.quote_file else a.quote
    return quote_locator.locate_quote(a.transcript, a.json3, text)


def main(argv: list[str] | None = None) -> int:
    a = build_parser().parse_args(argv)
    try:
        if a.cmd in NEEDS_LIBRARY:
            if not a.library or not a.schema:
                raise ValueError(f'{a.cmd} needs --library and --schema')
            out = run_library(a)
        else:
            out = run_frames(a)
        print(json.dumps(out, ensure_ascii=False, indent=1))
        return 1 if isinstance(out, dict) and out.get('all_passed') is False else 0
    except (ValueError, TypeError, KeyError, OSError, json.JSONDecodeError, subprocess.CalledProcessError) as exc:
        print(f'Error: {exc}', file=sys.stderr)
        return 2


if __name__ == '__main__':
    raise SystemExit(main())
