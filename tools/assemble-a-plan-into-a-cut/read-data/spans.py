"""The recorded spans of a plan: their one key, the media file each clip names, and the words said in it.

A span is a plan segment with a clip: {kind, clip, from, to, text}. Segments with no clip (a voiced line, a card) are not spans.
The span key is <clip>_<from>_<to>, seconds to 2 places, the same for the same cut in any plan, so a repeated cut is graded once
and its grade row is found by the key.

The cutter and the checks that cut a span out of its source to hear it (tool:check-a-rendered-video's plan check) read the
source through this one lookup, so a check cuts what the render cuts. Every folder is an argument; nothing here names a film.

  words_folder      <clip>.words.json per recording: {"source": media file, "words": [{text, start, end}]} (source seconds)
  wordtimes_folder  optional: <clip>.json from a word timer, {"segments": [{"words": [{word, start, end}]}]}; when it holds the
                    clip, its words are read before the words file's
"""
import json
from pathlib import Path


def span_key(s):
    """the one key of a recorded span, the same for the same cut in any plan: <clip>_<from>_<to>, seconds to 2 places. Audio grade
    rows are keyed by it."""
    return f"{s['clip']}_{s['from']:.2f}_{s['to']:.2f}"


def plan_spans(plan):
    """the segments of a plan that cut a recording, in plan order"""
    return [s for s in plan['segments'] if s.get('clip')]


def words_file(clip, words_folder):
    if not words_folder:
        raise LookupError(f'clip {clip} needs a words folder, the folder of <clip>.words.json')
    return Path(words_folder) / f'{clip}.words.json'


def source_for(clip, plan, words_folder):
    """the media file of clip: the plan's own sources entry, else the source its words file names"""
    found = (plan.get('sources') or {}).get(clip)
    return found or json.loads(words_file(clip, words_folder).read_text())['source']


def clip_words(clip, words_folder, wordtimes_folder=None):
    """[{text, start, end}] in source seconds: the word timer's file when wordtimes_folder holds one for the clip, else the words file"""
    if wordtimes_folder:
        timed = Path(wordtimes_folder) / f'{clip}.json'
        if timed.is_file():
            return [{'text': w['word'].strip(), 'start': w['start'], 'end': w['end']}
                    for seg in json.loads(timed.read_text())['segments'] for w in seg.get('words', [])]
    return json.loads(words_file(clip, words_folder).read_text())['words']


def span_words(words, s):
    """the words inside span s, times relative to the span's start"""
    if not words:
        return []
    return [{'text': w['text'], 'start': round(w['start'] - s['from'], 3), 'end': round(w['end'] - s['from'], 3)}
            for w in words if w['start'] >= s['from'] - 0.02 and w['end'] <= s['to'] + 0.05]
