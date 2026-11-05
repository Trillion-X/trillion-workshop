#!/usr/bin/env python3
"""Move each word's start to where the voice really starts, for graphics timed to words.

Whisper puts part of a pause into the next word's start (a word given at 1.02 s when the voice starts at 1.39 s), so a
graphic timed to it lands early. Each word's start moves to the first 10 ms window inside the word whose level is above
`edge_db` (default -45 dBFS, the same silence line the take maker trims at); its end stays.

With the take's line file (`line`, JSON with `script`), each word takes the script's spelling (Whisper may spell a name
another way), so graphics can cue on the script's words; a word Whisper split at a hyphen ("nutrient", "-dense") is one
script word, so one timed word. Only when the script and Whisper give the same number of words; otherwise Whisper's
spelling stays and the answer says so.

One JSON request on standard input:
  {"take": the voice take (wav or any file soundfile reads), "words": a word list {"words": [{text, start, end}]},
   "out": where to write the timed words, "line": optional line file with "script", "edge_db": optional}
Writes {"source", "timing", "words": [{text, start, end}]} to `out` and prints a last line
{"result": {"out", "words", "moved", "spelling": "script" | "whisper" | "whisper (counts differ: ...)"}} or {"error"}.

Ported one to one from a film repository's narrator/tools/word_onsets.py; the silence line is a request field.
"""
import json
import os
import sys

EDGE_DB = -45


def script_spelling(words, line_json):
    """(words, how): with the line's script, each word takes the script's spelling when the counts agree."""
    if not line_json:
        return words, 'whisper'
    with open(line_json) as f:
        script = json.load(f)['script'].split()
    joined = []
    for w in words:  # Whisper splits a hyphenated word ("nutrient", "-dense"): one script word, so one timed word
        if joined and w['text'].startswith('-'):
            joined[-1] = dict(joined[-1], text=joined[-1]['text'] + w['text'], end=w['end'])
        else:
            joined.append(w)
    words = joined
    if len(script) != len(words):
        note = f'script has {len(script)} words, whisper {len(words)}; kept whisper spelling'
        print(f'word_onsets: {note}', file=sys.stderr)
        return words, f'whisper (counts differ: {note})'
    return [dict(w, text=s) for w, s in zip(words, script)], 'script'


def onsets(take, words_in, edge_db=EDGE_DB):
    import numpy as np
    import soundfile as sf
    y, sr = sf.read(take, always_2d=True)
    y = y.mean(1)
    win = int(0.01 * sr)
    db = 20 * np.log10(np.sqrt(np.convolve(y ** 2, np.ones(win) / win, mode='same')) + 1e-9)
    with open(words_in) as f:
        given = json.load(f)['words']
    words = []
    for w in given:
        a, b = int(w['start'] * sr), int(w['end'] * sr)
        loud = np.where(db[a:b] > edge_db)[0]
        start = round((a + loud[0]) / sr, 3) if len(loud) else w['start']
        words.append({'text': w['text'], 'start': start, 'end': w['end']})
    return words


def run(request):
    for key in ('take', 'words', 'out'):
        if key not in request:
            raise ValueError(f'the request has no "{key}"; it needs take, words and out (see the top of word_onsets.py)')
    edge_db = float(request.get('edge_db', EDGE_DB))
    given = onsets(request['take'], request['words'], edge_db)
    words, spelling = script_spelling(given, request.get('line'))
    with open(request['out'], 'w') as f:
        json.dump({'source': os.path.basename(request['take']), 'timing': f'whisper words, starts moved to the first level above {edge_db:g} dBFS',
                   'words': words}, f, indent=1)
    with open(request['words']) as f:
        before = json.load(f)['words']
    moved = sum(1 for a, b in zip(before, given) if a['start'] != b['start'])
    return {'out': request['out'], 'words': len(words), 'moved': moved, 'spelling': spelling}


def main():
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
    sys.exit(main())
