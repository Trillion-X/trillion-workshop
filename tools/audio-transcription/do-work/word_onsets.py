#!/usr/bin/env python3
"""word_onsets.py: a narrator's word times for on-the-word graphics, one JSON request on standard input.

Whisper puts part of a pause into the next word's start ("This" 1.02 s when the voice starts at 1.39 s), so a graphic
timed to it would land early. Each word's start moves to the first 10 ms window inside the word whose level is above
EDGE_DB (the same silence line as kokoro_take.py); its end stays. Writes {"source", "timing", "words": [{text, start,
end}]}, the format a film's on-the-word graphics read.

Request: {"take": the voice take, "words": a word list {"words": [{text, start, end}]}, "out": where to write,
"line": optional line file with "script", "edge_db": optional silence line (default EDGE_DB)}. Prints a last line
{"result": {"out", "words", "moved", "spelling": "script" | "whisper"}} or {"error": "what to change"}, exit 2.
The older form, word_onsets.py <take.wav> <whisper.words.json> <out.words.json> [line.json], still works.

Moved from a film repository's narrator/tools/word_onsets.py; the silence line is a request field.
"""
import json
import os
import sys

import numpy as np
import soundfile as sf

EDGE_DB = -45


def script_spelling(words, line_json):
    """With the take's line.json, each word takes the script's spelling (whisper may spell a name another way), so specs can
    cue on the script's words. Only when the script and whisper give the same number of words; otherwise whisper's stay."""
    if not line_json:
        return words
    script = json.load(open(line_json))['script'].split()
    joined = []
    for w in words:  # whisper splits a hyphenated word ("nutrient", "-dense"): one script word, so one timed word
        if joined and w['text'].startswith('-'):
            joined[-1] = dict(joined[-1], text=joined[-1]['text'] + w['text'], end=w['end'])
        else:
            joined.append(w)
    words = joined
    if len(script) != len(words):
        print(f'word_onsets: script has {len(script)} words, whisper {len(words)}; kept whisper spelling', file=sys.stderr)
        return words
    return [dict(w, text=s) for w, s in zip(words, script)]


def main(take, words_in, out, line_json=None, edge_db=EDGE_DB):
    y, sr = sf.read(take, always_2d=True)
    y = y.mean(1)
    win = int(0.01 * sr)
    db = 20 * np.log10(np.sqrt(np.convolve(y ** 2, np.ones(win) / win, mode='same')) + 1e-9)
    words = []
    for w in json.load(open(words_in))['words']:
        a, b = int(w['start'] * sr), int(w['end'] * sr)
        loud = np.where(db[a:b] > edge_db)[0]
        start = round((a + loud[0]) / sr, 3) if len(loud) else w['start']
        words.append({'text': w['text'], 'start': start, 'end': w['end']})
    timed = words
    words = script_spelling(words, line_json)
    json.dump({'source': os.path.basename(take), 'timing': f'whisper words, starts moved to the first level above {edge_db} dBFS',
               'words': words}, open(out, 'w'), indent=1)
    return timed, words


def run(request):
    """One request: {take, words, out, line?, edge_db?} -> {out, words, moved, spelling}."""
    for key in ('take', 'words', 'out'):
        if key not in request:
            raise ValueError(f'the request has no "{key}"; it needs take, words and out (see the top of word_onsets.py)')
    edge_db = request.get('edge_db', EDGE_DB)
    if not isinstance(edge_db, (int, float)) or isinstance(edge_db, bool):
        raise ValueError('edge_db is a number of dBFS, for example -45')
    timed, words = main(request['take'], request['words'], request['out'], request.get('line'), edge_db)
    before = json.load(open(request['words']))['words']
    moved = sum(1 for a, b in zip(before, timed) if a['start'] != b['start'])
    spelling = 'whisper'
    if request.get('line'):
        script = json.load(open(request['line']))['script'].split()
        spelling = 'script' if len(script) == len(words) else f'whisper (counts differ: script {len(script)} words, whisper {len(words)})'
    return {'out': request['out'], 'words': len(words), 'moved': moved, 'spelling': spelling}


def from_stdin():
    try:
        request = json.load(sys.stdin)
        if not isinstance(request, dict):
            raise ValueError('the request must be one JSON object')
        result = run(request)
    except (ValueError, KeyError, OSError, RuntimeError) as e:
        print(json.dumps({'error': str(e) if not isinstance(e, KeyError) else f'a file lacks {e}'}))
        return 2
    print(json.dumps({'result': result}))
    return 0


if __name__ == '__main__':
    if len(sys.argv) > 1:
        main(*sys.argv[1:5])
    else:
        sys.exit(from_stdin())
