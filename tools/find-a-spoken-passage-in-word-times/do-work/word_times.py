"""Find exact word-timed spans in a clip's word list.

usage: python3 -I span.py <words.json> "<first words>" "<last words>" [--after SECONDS]

Reads either a whisper JSON (segments[].words[] with word/start/end) or a
library .words.json (words[] with text/start/end). Prints the start of the
first matched word, the end of the last matched word and the text between,
so a stitch plan's from/to cut on word boundaries.
"""
import json
import re
import sys


def load(path):
    doc = json.load(open(path))
    if 'words' in doc:
        return [(w['text'], w['start'], w['end']) for w in doc['words']]
    return [(w['word'], w['start'], w['end']) for s in doc['segments'] for w in s.get('words', [])]


def norm(t):
    return re.sub(r"[^a-z0-9']", '', t.lower())


def find(words, phrase, start_at=0):
    target = [norm(t) for t in phrase.split() if norm(t)]
    keys = [norm(w[0]) for w in words]
    for i in range(start_at, len(keys) - len(target) + 1):
        if keys[i:i + len(target)] == target:
            return i, i + len(target) - 1
    return None


def main():
    args = sys.argv[1:]
    after = 0.0
    if '--after' in args:
        k = args.index('--after')
        after = float(args[k + 1])
        args = args[:k] + args[k + 2:]
    path, first, last = args
    words = load(path)
    begin = next((i for i, w in enumerate(words) if w[1] >= after), 0)
    a = find(words, first, begin)
    if not a:
        sys.exit(f'first words not found: {first}')
    b = find(words, last, a[0])
    if not b:
        sys.exit(f'last words not found: {last}')
    text = ' '.join(w[0].strip() for w in words[a[0]:b[1] + 1])
    print(f'{words[a[0]][1]:.2f}\t{words[b[1]][2]:.2f}\t{text}')


main()
