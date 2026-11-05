"""Find exact word-timed spans in a clip's word list.

usage: python3 word_times.py [--base FOLDER] < request.json                       one JSON request (below)
       python3 word_times.py span <words.json> "<first words>" "<last words>" [--after SECONDS]
       python3 word_times.py sentences <words.json> [<from> <to>]
       python3 word_times.py words-home <words.json> <source media> <out.words.json>
The three command lines are the film tools' own (span.py, sentences.py, words_home.py), unchanged.

Reads either a whisper JSON (segments[].words[] with word/start/end) or a
library .words.json (words[] with text/start/end). Prints the start of the
first matched word, the end of the last matched word and the text between,
so a stitch plan's from/to cut on word boundaries.
It also reads the {t, start, end} words tools/audio-transcription writes.

The request is one JSON object with a `step`:
  span       {words, first, last, after?}: the line above, "<start>\t<end>\t<text>"; the last words are searched from the
             first match on.
  sentences  {words, from?, to?}: every sentence (ended by . ? or !) whose words start inside [from, to], printed
             "<start>-<end> <text>"; an unfinished last sentence prints "<start>- <text>".
  words-file {words, source, out, offset?}: writes {"source", "timing", "words": [{text, start, end}]}, the one shape a
             plan's clips are cut from; offset seconds are added to every time (a window heard alone).
Instead of `words`, `clip` names <words_folder>/<clip>.words.json. Relative paths are read and written in --base, the
folder the person let this tool change.

Settings (the person's list:settings row for this folder, read by tools/settings/do-work/run-with-settings.mjs, which
hands the record in as `settings_record`, read here with request_settings): words_folder (where a film's <clip>.words.json
files are), timing (the word written in a words file's "timing", default "word") and round_to (decimals every written
time is rounded to; none by default, and 2 when an offset moves them).

Moved from a film's tools folder: span.py, sentences.py and words_home.py (with the shape half of wordtime.py).
"""
import argparse
import json
import pathlib
import re
import sys

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[2] / 'settings' / 'read-data'))
from settings import request_settings  # noqa: E402

FOLDER = 'find-a-spoken-passage-in-word-times'
TOOL = 'tool:find-a-spoken-passage-in-word-times'
DEFAULTS = {'words_folder': None, 'timing': 'word', 'round_to': None}
STEPS = ('span', 'sentences', 'words-file')


class Refusal(Exception):
    """A request that cannot be carried out; the message says what to change."""


def with_text(doc):
    """The {t, start, end} words tools/audio-transcription writes, as {text, start, end}; any other shape as it is."""
    if isinstance(doc, dict) and isinstance(doc.get('words'), list) and any('text' not in w and 't' in w for w in doc['words']):
        return {**doc, 'words': [{**w, 'text': w.get('text', w.get('t'))} for w in doc['words']]}
    if not (isinstance(doc, dict) and (isinstance(doc.get('words'), list) or isinstance(doc.get('segments'), list))):
        raise Refusal('the word-time file holds neither a "words" list nor Whisper "segments" with "words"')
    return doc


def words_of(doc):
    """[(text, start, end)] from any word-time shape this tool reads (span.py's load, on a file already read)."""
    doc = with_text(doc)
    if 'words' in doc:
        return [(w['text'], w['start'], w['end']) for w in doc['words']]
    return [(w['word'], w['start'], w['end']) for s in doc['segments'] for w in s.get('words', [])]


def load(path):
    return words_of(json.load(open(path)))


def norm(t):
    return re.sub(r"[^a-z0-9']", '', t.lower())


def find(words, phrase, start_at=0):
    target = [norm(t) for t in phrase.split() if norm(t)]
    keys = [norm(w[0]) for w in words]
    for i in range(start_at, len(keys) - len(target) + 1):
        if keys[i:i + len(target)] == target:
            return i, i + len(target) - 1
    return None


def span(words, first, last, after=0.0):
    """span.py's main on words already read: prints its line and answers {start, end, text}."""
    begin = next((i for i, w in enumerate(words) if w[1] >= after), 0)
    a = find(words, first, begin)
    if not a:
        sys.exit(f'first words not found: {first}')
    b = find(words, last, a[0])
    if not b:
        sys.exit(f'last words not found: {last}')
    text = ' '.join(w[0].strip() for w in words[a[0]:b[1] + 1])
    print(f'{words[a[0]][1]:.2f}\t{words[b[1]][2]:.2f}\t{text}')
    return {'start': words[a[0]][1], 'end': words[b[1]][2], 'text': text}


def sentences(doc, lo=float('-inf'), hi=float('inf')):
    """sentences.py's main on a file already read (Whisper segments too): prints each sentence and answers them."""
    doc = {'words': [{'text': t, 'start': s, 'end': e} for t, s, e in words_of(doc)]}
    found = []
    line, t0 = [], None
    for w in doc['words']:
        if not lo <= w['start'] <= hi:
            continue
        t0 = w['start'] if t0 is None else t0
        line.append(w['text'])
        if w['text'].endswith(('.', '?', '!')):
            print(f"{t0:.2f}-{w['end']:.2f} {' '.join(line)}")
            found.append({'start': t0, 'end': w['end'], 'text': ' '.join(line)})
            line, t0 = [], None
    if line:
        print(f"{t0:.2f}- {' '.join(line)}")
        found.append({'start': t0, 'end': None, 'text': ' '.join(line)})
    return found


def words_home(doc, source, out, timing='word', offset=0.0, round_to=None):
    """words_home.py's main on a file already read: writes the one words-file shape, moving and rounding times if asked."""
    doc = with_text(doc)
    if 'words' in doc:
        words = doc['words']
    else:
        words = [{'text': w['word'].strip(), 'start': w['start'], 'end': w['end']}
                 for s in doc['segments'] for w in s.get('words', [])]
    if offset or round_to is not None or any(set(w) != {'text', 'start', 'end'} for w in words if 't' in w):
        place = (lambda t: round(t + offset, round_to)) if round_to is not None else (lambda t: round(t + offset, 2) if offset else t)
        words = [{'text': w['text'].strip(), 'start': place(w['start']), 'end': place(w['end'])} for w in words]
    pathlib.Path(out).write_text(json.dumps({'source': source, 'timing': timing, 'words': words}))
    print(f'{len(words)} words -> {out}')
    return {'out': str(out), 'count': len(words)}


def old_command_line(argv):
    """The three film tools' command lines, as they were."""
    step, args = argv[0], argv[1:]
    if step == 'span':
        after = 0.0
        if '--after' in args:
            k = args.index('--after')
            after = float(args[k + 1])
            args = args[:k] + args[k + 2:]
        path, first, last = args
        span(load(path), first, last, after)
    elif step == 'sentences':
        sentences(json.load(open(args[0])), float(args[1]) if len(args) > 1 else float('-inf'), float(args[2]) if len(args) > 2 else float('inf'))
    else:
        words_home(json.load(open(args[0])), args[1], args[2])
    return 0


def run(request, base=None):
    settings = request_settings(request, DEFAULTS, folder=FOLDER, tool=TOOL)
    step = request.get('step')
    if step not in STEPS:
        raise Refusal('step is "span" (where a passage starts and ends), "sentences" (timed sentences) or "words-file" (keep word times in the one shape)')
    at = lambda p: p if p is None or pathlib.Path(p).is_absolute() or not base else str(pathlib.Path(base) / p)
    path = request.get('words')
    if not path and request.get('clip'):
        if not settings['words_folder']:
            raise Refusal('clip needs the words_folder setting (where <clip>.words.json files are), or give words: the file itself')
        path = str(pathlib.Path(settings['words_folder']) / f"{request['clip']}.words.json")
    if not path:
        raise Refusal('give words (a word-time file) or clip (with the words_folder setting)')
    path = at(path)
    if not pathlib.Path(path).is_file():
        raise Refusal(f'there is no word-time file at {path}')
    doc = json.loads(pathlib.Path(path).read_text())
    answer = {'step': step, 'words': path}
    if step == 'span':
        if not request.get('first') or not request.get('last'):
            raise Refusal('span needs first (the passage\'s first words) and last (its last words)')
        answer.update(span(words_of(doc), request['first'], request['last'], float(request.get('after', 0.0))))
    elif step == 'sentences':
        lo = float(request['from']) if request.get('from') is not None else float('-inf')
        hi = float(request['to']) if request.get('to') is not None else float('inf')
        answer['sentences'] = sentences(doc, lo, hi)
    else:
        if not request.get('source') or not request.get('out'):
            raise Refusal('words-file needs source (the recording the words are of) and out (the .words.json file to write)')
        answer.update(words_home(doc, request['source'], at(request['out']), settings['timing'], float(request.get('offset', 0.0)), settings['round_to']))
    if request.get('settings_from'):
        answer['settings_from'] = request['settings_from']
    return answer


def main(argv):
    if argv and argv[0] in ('span', 'sentences', 'words-home'):
        return old_command_line(argv)
    parser = argparse.ArgumentParser(description=__doc__.split('\n')[0])
    parser.add_argument('--base', help='the folder relative paths are read from and written in')
    args = parser.parse_args(argv)
    try:
        request = json.loads(sys.stdin.read() or '{}')
        if not isinstance(request, dict):
            raise Refusal('the request must be a JSON object with a step')
        answer = run(request, args.base)
    except SystemExit as problem:
        print(json.dumps({'error': str(problem.code)}))
        return 1
    except Refusal as problem:
        print(json.dumps({'error': str(problem)}))
        return 1
    except (ValueError, KeyError, TypeError, OSError) as problem:
        print(json.dumps({'error': f'{type(problem).__name__}: {problem}'}))
        return 1
    print(json.dumps({'result': answer}, ensure_ascii=False))
    return 0


if __name__ == '__main__':
    sys.exit(main(sys.argv[1:]))
