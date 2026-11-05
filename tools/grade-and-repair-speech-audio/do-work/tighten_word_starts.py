import json
import os
import sys

import numpy as np
import soundfile as sf

EDGE_DB = -45


def script_spelling(words, line_json):
    """With the take's line.json, each word takes the script's spelling (whisper may spell a name otherwise), so specs can
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


def main(take, words_in, out, line_json=None):
    y, sr = sf.read(take, always_2d=True)
    y = y.mean(1)
    win = int(0.01 * sr)
    db = 20 * np.log10(np.sqrt(np.convolve(y ** 2, np.ones(win) / win, mode='same')) + 1e-9)
    words = []
    for w in json.load(open(words_in))['words']:
        a, b = int(w['start'] * sr), int(w['end'] * sr)
        loud = np.where(db[a:b] > EDGE_DB)[0]
        start = round((a + loud[0]) / sr, 3) if len(loud) else w['start']
        words.append({'text': w['text'], 'start': start, 'end': w['end']})
    words = script_spelling(words, line_json)
    json.dump({'source': os.path.basename(take), 'timing': f'whisper words, starts moved to the first level above {EDGE_DB} dBFS',
               'words': words}, open(out, 'w'), indent=1)


if __name__ == '__main__':
    main(*sys.argv[1:5])
