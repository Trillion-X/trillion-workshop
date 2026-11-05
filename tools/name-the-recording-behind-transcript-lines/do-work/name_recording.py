"""Name the recording behind each line range of a transcript archive.

usage: python3 name_recording.py [--base FOLDER] < request.json
       python3 name_recording.py [--base FOLDER] --archive <archive_index.json> <start-end> [<start-end> ...]
       python3 name_recording.py <archive_index.json> <start-end> [<start-end> ...]     the old command line, unchanged

Prints every archive window that overlaps a range: window id, recording title,
its line span and the first words, so a cited passage can be found in our media.

The request is one JSON object: {"archive": path, "ranges": ["12-40", ...] or "12-40 90-95", "settings": {...}}.
The archive index is a JSON list of windows {id, recording, start_line, end_line, text}. For every range the tool
prints, one tab-separated line per archive window that overlaps it, the window id, the recording's title, the
window's line span and its first words, so a cited passage can be found in the person's media. The last line is
{"result": {"matches": [...], "not_found": [...]}} with the same facts as fields.

Settings (the person's list:settings row for this folder, read by tools/settings/do-work/run-with-settings.mjs, which
hands the record in as `settings_record`, read here with request_settings): `archive`, the archive index a film's citations point into, used when the request names
none, and `preview_chars`, how many first characters of a window to show (default 120). A relative archive path is
read from --base, the folder the person let this tool read.

Moved from a film's tools folder (package_lines.py): the overlap rule and the printed line are unchanged; the archive
path and the ranges are the request's, and a bad range is refused with what to write instead.
"""
import argparse
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / 'settings' / 'read-data'))
from settings import request_settings  # noqa: E402

FOLDER = 'name-the-recording-behind-transcript-lines'
TOOL = 'tool:name-the-recording-behind-transcript-lines'

DEFAULTS = {'archive': None, 'preview_chars': 120}


def parse_range(spec):
    """'12-40' -> (12, 40). Refuses anything else, saying what a range looks like."""
    parts = str(spec).split('-')
    if len(parts) != 2 or not all(part.strip().isdigit() for part in parts):
        raise ValueError(f'range {spec!r} is not <first line>-<last line>, for example 120-180')
    lo, hi = int(parts[0]), int(parts[1])
    if lo > hi:
        raise ValueError(f'range {spec!r} ends before it starts: write the smaller line number first')
    return lo, hi


def windows_for(windows, spec):
    """Every archive window that overlaps the range, in archive order."""
    lo, hi = parse_range(spec)
    return [w for w in windows if w['start_line'] <= hi and w['end_line'] >= lo]


def printed(spec, window, preview=DEFAULTS['preview_chars']):
    """The tab-separated line the tool prints for one overlap."""
    return (f"{spec}\t{window['id']}\t{window['recording']}\t{window['start_line']}-{window['end_line']}"
            f"\t{window['text'].strip()[:preview]!r}")


def ranges_of(value):
    """A list of ranges, or one string of them separated by spaces."""
    if isinstance(value, str):
        return value.split()
    if isinstance(value, list) and all(isinstance(v, str) for v in value):
        return value
    return []


def name_recordings(archive_path, ranges, preview=DEFAULTS['preview_chars']):
    path = Path(archive_path)
    if not path.is_file():
        raise ValueError(f'there is no archive index at {path}: give the path of the JSON file that lists the archive windows')
    windows = json.loads(path.read_text())
    if not isinstance(windows, list):
        raise ValueError(f'{path} is not a list of archive windows')
    for spec in ranges:
        parse_range(spec)
    matches, lines, not_found = [], [], []
    for spec in ranges:
        found = windows_for(windows, spec)
        for window in found:
            lines.append(printed(spec, window, preview))
            matches.append({'range': spec, 'id': window['id'], 'recording': window['recording'],
                            'start_line': window['start_line'], 'end_line': window['end_line'],
                            'first_words': window['text'].strip()[:preview]})
        if not found:
            lines.append(f'{spec}\tno archive window overlaps this range')
            not_found.append(spec)
    return {'matches': matches, 'not_found': not_found, 'lines': lines}


def answer(request, base=None):
    """The whole run on one request: (exit code, printed lines, last JSON line)."""
    settings = request_settings(request, DEFAULTS, folder=FOLDER, tool=TOOL)
    archive, ranges = request.get('archive') or settings['archive'], ranges_of(request.get('ranges'))
    if not archive or not ranges:
        return 2, [], {'error': 'give the archive index path (archive, or the archive setting) and at least one line range (ranges), for example "120-180"'}
    if base and not Path(archive).is_absolute():
        archive = str(Path(base) / archive)
    try:
        found = name_recordings(archive, ranges, int(settings['preview_chars']))
    except (ValueError, KeyError, TypeError) as problem:
        return 1, [], {'error': str(problem)}
    result = {'archive': archive, 'matches': found['matches'], 'not_found': found['not_found']}
    if request.get('settings_from'):
        result['settings_from'] = request['settings_from']
    return 0, found['lines'], {'result': result}


def old_command_line():
    """The film tool's own command line, kept as it was: plain lines, no JSON, no checks."""
    windows = json.load(open(sys.argv[1]))
    for spec in sys.argv[2:]:
        lo, hi = (int(x) for x in spec.split('-'))
        for w in windows:
            if w['start_line'] <= hi and w['end_line'] >= lo:
                print(f"{spec}\t{w['id']}\t{w['recording']}\t{w['start_line']}-{w['end_line']}\t{w['text'].strip()[:120]!r}")


def main(argv):
    parser = argparse.ArgumentParser(description=__doc__.split('\n')[0])
    parser.add_argument('--base', help='the folder a relative archive path is read from')
    parser.add_argument('--archive')
    parser.add_argument('ranges', nargs='*')
    args = parser.parse_args(argv)
    if args.archive or args.ranges:
        request = {'archive': args.archive, 'ranges': args.ranges}
    else:
        try:
            request = json.loads(sys.stdin.read() or '{}')
        except json.JSONDecodeError as problem:
            print(json.dumps({'error': f'the request is not JSON: {problem}'}))
            return 2
        if not isinstance(request, dict):
            print(json.dumps({'error': 'the request must be a JSON object with archive and ranges'}))
            return 2
    try:
        code, lines, last = answer(request, args.base)
    except ValueError as problem:
        code, lines, last = 2, [], {'error': str(problem)}
    for line in lines:
        print(line)
    print(json.dumps(last, ensure_ascii=False))
    return code


if __name__ == '__main__':
    if len(sys.argv) > 2 and not sys.argv[1].startswith('-'):
        sys.exit(old_command_line())
    sys.exit(main(sys.argv[1:]))
