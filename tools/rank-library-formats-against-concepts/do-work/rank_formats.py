"""Rank every format in a library against every concept, and write the result into a titles file.

usage: python3 rank_formats.py [--base FOLDER] < request.json
       python3 rank_formats.py [--base FOLDER] --request <request.json>

The request is one JSON object:
  step         "catalog" or "apply"
  library      the library folder: INDEX.md (rows under "## All items") and formats/<folder>/FORMAT.md
  bank         a title-template bank markdown file                            (title templates that name a form)
  concepts     {"files": [concept markdown files]}: each "## <ID> ..." heading is a concept, its table rows its beats
  package      an optional CSV of package concepts (id, domain, viewer_gets, proof_needed)
  titles       the titles JSON file `apply` reads and rewrites
  judged       list of judged JSON files `apply` reads: {"<concept id>": [{"format": key, "fit": why}, ...] best first}
Relative paths are read (and the titles file written) in --base, the folder the person let this tool change.

What belongs to one person or film is their settings: a list:settings row read by
tools/settings/do-work/run-with-settings.mjs (which hands the record in as `settings_record`, read here with
request_settings), with the run's own `settings` over it: form_templates ({bank id: [name, form]}: the bank's templates
that name a form), stable_keys (format folder -> the key other work already uses), own_formats (candidate rows of the
person's own formats), package_ids, skip_concepts, empty_options, form_template_path, default_material and
about_template.

catalog prints every candidate and every concept as tab-separated lines, for the judges to rank:
  F <key> <type> <medium> <creator> <stats> <what it is>
  C <id> <title> <moments found> <of them local> <what it gives the viewer>
Candidates: every analysed item in the library's INDEX.md "All items" (rows that only point to another write-up are
skipped), the title templates of the bank that name a form, and the person's own formats.
apply reads judged files and writes, into the titles file: format_options (each judged option with its type, medium,
library path, fit, and the concept's moment counts), format_palette (every format some concept's options use, plus each
plan's pick in format_chosen) and format_ranking_about. A key the catalog does not hold is refused, and so is a concept
nobody judged.

Why judges and not a model score: a cross-encoder scores topic, not form, so its top picks for a personal concept were
product tutorials. The ranking is a reading of the whole catalog per concept.

Moved from a film's tools folder (rank_formats.py): its readers, its record and its refusals are unchanged; the paths
are the request's and what was the film's is the person's settings.
"""
import argparse
import csv
import json
import pathlib
import re
import sys

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[2] / 'settings' / 'read-data'))
from settings import request_settings  # noqa: E402

FOLDER = 'rank-library-formats-against-concepts'
TOOL = 'tool:rank-library-formats-against-concepts'
DEFAULTS = {
    'form_templates': {}, 'stable_keys': {}, 'own_formats': [], 'package_ids': [], 'skip_concepts': [], 'empty_options': [],
    'form_template_path': '{bank_name} template {id}',
    'default_material': "the person's recorded words for this concept and their transcripts",
    'about_template': ('Every concept was read against all {candidates} candidates ({library_items} library items, {forms} title '
                       'templates that name a form, {own} own formats); judges ranked the best fits per concept. The palette is '
                       'every format the options use, plus the plans\' picks: an output of the ranking, not a list chosen first.'),
}
# Set from the request and the person's settings by configure(); the readers below read them as the film tool did.
MODE, LIBRARY, BANK, PACKAGE, JUDGED, TITLES, CONCEPT_FILES = None, None, None, None, [], None, []
FORM_TEMPLATES, STABLE, HIS_OWN, SETTINGS = {}, {}, [], dict(DEFAULTS)


class Refusal(Exception):
    """A request that cannot be carried out; the message says what to change."""


def medium_of(kind, aspect):
    aspect = aspect.lower()
    if kind == 'long-form X article' or aspect == 'text':
        return 'write-up'
    if 'carousel' in aspect or kind == 'slideshow / carousel':
        return 'carousel'
    if kind == 'multi-panel grid':
        return 'post'
    if 'long video' in aspect or kind == 'long-form episode / talk / keynote':
        return 'long video'
    if 'web loop' in aspect:
        return 'web loop'
    return 'short'


def what_it_is(folder):
    path = LIBRARY / folder / 'FORMAT.md'
    if not path.exists():
        return ''
    found = re.search(r'\*\*What it is\.\*\*(.{0,400})', path.read_text(errors='replace'), re.S)
    return ' '.join(found.group(1).split('\n\n')[0].split()) if found else ''


def candidates():
    rows, on = [], False
    for line in (LIBRARY / 'INDEX.md').read_text().splitlines():
        if line.startswith('## All items'):
            on = True
            continue
        if on and line.startswith('## '):
            break
        if not on or not line.startswith('| ') or line.startswith('| creator') or line.startswith('|---'):
            continue
        cells = [c.strip() for c in line.strip('|').split('|')]
        if len(cells) < 12 or cells[2].startswith('see'):
            continue
        folder = re.search(r'(formats/[^)\s]+)', cells[11])
        if not folder:
            continue
        folder = folder.group(1).rstrip('/')
        name = folder.split('/')[-1]
        rows.append({'key': STABLE.get(name, name), 'type': cells[2], 'medium': medium_of(cells[2], cells[3]), 'creator': cells[0],
                     'path': f'library/{folder}/', 'stats': f'{cells[4]} s, {cells[7]} views, {cells[8]} likes, {cells[9]} bookmarks',
                     'text': f'{cells[1]}: {what_it_is(folder) or cells[10]}'})
    for line in (BANK.read_text().splitlines() if BANK else []):
        cells = [c.strip() for c in line.strip('|').split('|')]
        if len(cells) >= 8 and cells[0] in FORM_TEMPLATES and '(' in cells[2]:
            name, form = FORM_TEMPLATES[cells[0]]
            rows.append({'key': f'title_template_{cells[0]}', 'type': 'title template (a form)', 'medium': 'long video or short', 'creator': 'bank',
                         'path': SETTINGS['form_template_path'].format(bank_name=BANK.name, id=cells[0]),
                         'stats': f'{cells[2]} outliers', 'text': f'{name}: {form}'})
    return rows + HIS_OWN


def concepts():
    found = {}
    for path in CONCEPT_FILES:
        current = None
        for line in path.read_text().splitlines():
            head = re.match(r'^## ([A-Z]+\d+)(?: \||) (?:\([A-Za-z]+\) )?(.+)$', line)
            if head:
                current = head.group(1)
                found[current] = {'title': head.group(2), 'beats': [], 'n': 0, 'local': 0, 'b2': 0}
                continue
            if current and line.startswith('| ') and not line.startswith(('| beat', '| concept', '|---')):
                cells = [c.strip() for c in line.strip('|').split('|')]
                found[current]['beats'].append(re.sub(r'^(HOOK|hook|Q):?\s*', '', cells[1] if cells[0] == current else cells[0]))
                found[current]['n'] += 1
                found[current]['local'] += 'local' in line
                found[current]['b2'] += ' b2' in line.lower() or '| B2' in line
    if PACKAGE and PACKAGE.exists():
        for row in csv.DictReader(open(PACKAGE)):
            if row['id'] in SETTINGS['package_ids']:
                found[row['id']] = {'title': row['domain'], 'beats': [row['viewer_gets'], row['proof_needed']], 'n': 0, 'local': 0, 'b2': 0}
    for cid in SETTINGS['skip_concepts']:
        found.pop(cid, None)
    return found


def catalog(cands, ideas):
    for c in cands:
        print('\t'.join(['F', c['key'], c['type'], c['medium'], c['creator'], c['stats'], c['text']]))
    for cid, idea in sorted(ideas.items()):
        print('\t'.join(['C', cid, idea['title'], str(idea['n']), str(idea['local']), '; '.join(idea['beats'][:8])]))
    return {'step': 'catalog', 'candidates': len(cands), 'concepts': len(ideas)}


def apply(cands, ideas):
    by_key = {c['key']: c for c in cands}
    judged = {}
    for path in JUDGED:
        judged.update(json.loads(path.read_text()))
    unknown = sorted({o['format'] for opts in judged.values() for o in opts} - set(by_key))
    if unknown:
        sys.exit(f'refused: keys not in the catalog: {unknown}')
    missing = sorted(set(ideas) - set(judged))
    if missing:
        sys.exit(f'refused: concepts not judged: {missing}')
    doc = json.loads(TITLES.read_text())
    options = {}
    for cid, opts in judged.items():
        idea = ideas[cid]
        options[cid] = [{'format': o['format'], 'type': by_key[o['format']]['type'], 'medium': by_key[o['format']]['medium'],
                         'path': by_key[o['format']]['path'], 'fit': o['fit'],
                         'material': o.get('material', SETTINGS['default_material']),
                         'moments_fit': idea['n'], 'moments_local': idea['local'], 'moments_b2': idea['b2'],
                         'moments_drive': idea['n'] - idea['local'] - idea['b2']} for o in opts]
    used = {o['format'] for opts in options.values() for o in opts} | {c[0] for c in doc.get('format_chosen', {}).values()}
    doc['format_palette'] = {k: {'type': by_key[k]['type'], 'medium': by_key[k]['medium'], 'path': by_key[k]['path'], 'note': by_key[k]['text'][:300]}
                             for k in sorted(used)}
    doc['format_options'] = {**options, **{cid: [] for cid in SETTINGS['empty_options']}}
    doc.pop('format_ranking', None)
    doc['format_ranking_about'] = SETTINGS['about_template'].format(candidates=len(cands), library_items=len(cands) - len(FORM_TEMPLATES) - len(HIS_OWN),
                                                                    forms=len(FORM_TEMPLATES), own=len(HIS_OWN))
    TITLES.write_text(json.dumps(doc, indent=1, ensure_ascii=False) + '\n')
    print('concepts', len(options), 'palette', len(doc['format_palette']),
          'distinct in options', len({o['format'] for opts in options.values() for o in opts}))
    return {'step': 'apply', 'concepts': len(options), 'palette': len(doc['format_palette']),
            'distinct_in_options': len({o['format'] for opts in options.values() for o in opts})}


def load_settings(request):
    """The tool's defaults with the person's settings (their row, then the run's own) laid over."""
    if request.get('settings_file') is not None:
        raise Refusal('settings_file is gone: name the person\'s list:settings row in settings_record, or give settings')
    return request_settings(request, DEFAULTS, folder=FOLDER, tool=TOOL)


def configure(request, base=None):
    """Set what the readers read from the request (paths in base when relative) and the person's settings."""
    global MODE, LIBRARY, BANK, PACKAGE, JUDGED, TITLES, CONCEPT_FILES, FORM_TEMPLATES, STABLE, HIS_OWN, SETTINGS
    at = lambda value: None if not value else pathlib.Path(value) if pathlib.Path(value).is_absolute() or not base else pathlib.Path(base) / value
    MODE = request.get('step')
    if MODE not in ('catalog', 'apply'):
        raise Refusal('step is "catalog" (list every candidate and concept for the judges) or "apply" (write the judged ranking)')
    SETTINGS = load_settings(request)
    FORM_TEMPLATES, STABLE, HIS_OWN = SETTINGS['form_templates'], SETTINGS['stable_keys'], list(SETTINGS['own_formats'])
    LIBRARY, BANK, PACKAGE, TITLES = at(request.get('library')), at(request.get('bank')), at(request.get('package')), at(request.get('titles'))
    if not LIBRARY:
        raise Refusal('give library: the folder that holds INDEX.md and formats/')
    if not (LIBRARY / 'INDEX.md').is_file():
        raise Refusal(f'there is no library index at {LIBRARY / "INDEX.md"}: set library to the folder that holds INDEX.md')
    CONCEPT_FILES = [at(path) for path in (request.get('concepts') or {}).get('files') or []]
    if not CONCEPT_FILES:
        raise Refusal('give concepts.files: the concept markdown files')
    JUDGED = [at(path) for path in request.get('judged') or []]
    if MODE == 'apply':
        for key, value in (('titles', TITLES), ('judged', JUDGED)):
            if not value:
                raise Refusal(f'{key} is required for apply')


def run(request, base=None):
    configure(request, base)
    cands, ideas = candidates(), concepts()
    return catalog(cands, ideas) if MODE == 'catalog' else apply(cands, ideas)


def main(argv):
    parser = argparse.ArgumentParser(description=__doc__.split('\n')[0])
    parser.add_argument('--request', help='a JSON file holding the request (default: the request on standard input)')
    parser.add_argument('--base', help='the folder relative paths are read from and written in')
    args = parser.parse_args(argv)
    try:
        request = json.loads(pathlib.Path(args.request).read_text() if args.request else (sys.stdin.read() or '{}'))
        if not isinstance(request, dict):
            raise Refusal('the request must be a JSON object')
        answer = run(request, args.base)
    except SystemExit as problem:
        print(json.dumps({'error': str(problem.code)}))
        return 1
    except Refusal as problem:
        print(json.dumps({'error': str(problem)}))
        return 1
    except (ValueError, OSError, KeyError) as problem:
        print(json.dumps({'error': f'{type(problem).__name__}: {problem}'}))
        return 1
    if request.get('settings_from'):
        answer['settings_from'] = request['settings_from']
    print(json.dumps({'result': answer}))
    return 0


if __name__ == '__main__':
    sys.exit(main(sys.argv[1:]))
