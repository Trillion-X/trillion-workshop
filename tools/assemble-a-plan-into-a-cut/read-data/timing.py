"""Times: the room a cut has beside its neighbouring words, the time of each shown word, caption chunks, and moving every time a
graphics event carries.

Words are [{"text", "start", "end"}] in seconds. Which keys of an event are times is DATA of the overlay renderer
("time_fields": {"keys": [...], "suffix": "_at", "lists": [...]}): every number under one of keys or a key ending in suffix, and
every number in a list under one of lists, at any depth. A list of numbers under a time key is a list of times; a word-timed
[word, offset] list is not.
"""
import difflib
import re


def norm(word):
    return re.sub(r"[^a-z0-9']", '', word.lower().replace('’', "'"))


def room(words, t, side, edges):
    """seconds the source leaves free between t and its neighbouring word (side -1: the word before t, +1: the word after), less
    edges.safety_s, at most edges.handle_s"""
    slack, handle, safety = edges['word_slack_s'], edges['handle_s'], edges['safety_s']
    if side < 0:
        before = [w['end'] for w in words if w['end'] <= t + slack]
        free = t - max(before) if before else t
    else:
        after = [w['start'] for w in words if w['start'] >= t - slack]
        free = min(after) - t if after else handle + safety
    return max(0.0, min(handle, free - safety))


def word_times(shown, heard, dur):
    """one start time per shown word: the heard word it matches (difflib over normalised words), else interpolated between matched
    neighbours; with nothing heard, spread over dur"""
    if not heard:
        return [round(0.3 + k * (dur - 0.6) / max(1, len(shown)), 3) for k in range(len(shown))]
    t = [None] * len(shown)
    sm = difflib.SequenceMatcher(None, [norm(w) for w in shown], [norm(w['text']) for w in heard], autojunk=False)
    for blk in sm.get_matching_blocks():
        for k in range(blk.size):
            t[blk.a + k] = heard[blk.b + k]['start']
    known = [k for k, v in enumerate(t) if v is not None]
    if not known:
        a, b = heard[0]['start'], heard[-1]['end']
        return [round(a + k * (b - a) / len(shown), 3) for k in range(len(shown))]
    for k in range(len(t)):
        if t[k] is None:
            lo = max((j for j in known if j < k), default=None)
            hi = min((j for j in known if j > k), default=None)
            t[k] = t[hi] if lo is None else t[lo] + 0.15 * (k - lo) if hi is None else t[lo] + (t[hi] - t[lo]) * (k - lo) / (hi - lo)
    for k in range(1, len(t)):
        t[k] = max(t[k], t[k - 1])
    return [round(v, 3) for v in t]


def caption_chunks(words, rules):
    """the cheapest way to cut words into chunks of 1..max_words. rules (DATA): aim_words, min_words, min_s, max_words,
    dangling_words, clause_words, stops, commas and cost {after_stop, after_comma, before_clause, elsewhere, after_dangling,
    per_word_off_aim, short}. A break costs after_stop after a full stop, after_comma after a comma, before_clause before a word that
    starts a clause (or a dangling word), elsewhere otherwise, plus after_dangling after a dangling word; a chunk costs per_word_off_aim
    per word away from aim_words, plus short when it has fewer than min_words or lasts under min_s. Without max_words, the most is
    dense_words - room_words (a checker's dense-text line, read from its owner, less the room other text beside it needs)."""
    n, cost = len(words), rules['cost']
    most = rules['max_words'] if 'max_words' in rules else rules['dense_words'] - rules['room_words']
    dangling, clause = set(rules['dangling_words']), set(rules['clause_words'])

    def brk(j):
        if j == n - 1:
            return 0.0
        end = words[j]['text'].rstrip()[-1:]
        starts_clause = norm(words[j + 1]['text']) in dangling | clause
        return (cost['after_dangling'] if norm(words[j]['text']) in dangling else 0.0) + (
            cost['after_stop'] if end in rules['stops'] else cost['after_comma'] if end in rules['commas']
            else cost['before_clause'] if starts_clause else cost['elsewhere'])

    def size(i, j):
        k = j - i + 1
        short = k < rules['min_words'] or words[j]['end'] - words[i]['start'] < rules['min_s']
        return cost['per_word_off_aim'] * abs(k - rules['aim_words']) + (cost['short'] if short and n > k else 0.0)
    best = [0.0] + [float('inf')] * n
    back = [0] * (n + 1)
    for k in range(1, n + 1):
        for i in range(max(0, k - most), k):
            c = best[i] + size(i, k - 1) + brk(k - 1)
            if c < best[k]:
                best[k], back[k] = c, i
    chunks, k = [], n
    while k:
        chunks.insert(0, words[back[k]:k])
        k = back[k]
    return chunks


def _number(v):
    return isinstance(v, (int, float)) and not isinstance(v, bool)


def _is_time_key(k, fields):
    return k in fields['keys'] or k.endswith(fields['suffix'])


def _times_list(key, value, fields):
    return key is not None and (key in fields['lists'] or (_is_time_key(key, fields) and all(_number(v) for v in value)))


def _walk(value, fields, at_time, key=None):
    if isinstance(value, dict):
        return {k: _walk(v, fields, at_time, k) for k, v in value.items()}
    if isinstance(value, list):
        inner = key if _times_list(key, value, fields) else None
        return [_walk(v, fields, at_time, inner) for v in value]
    if _number(value) and key is not None and (_is_time_key(key, fields) or key in fields['lists']):
        return at_time(value)
    return value


def shifted(e, by, fields):
    """a copy of event e with every time it carries moved by `by` seconds; anything else (positions, sizes, durations) is left as it is"""
    return _walk(e, fields, lambda v: round(v + by, 3))


def times_of(e, fields):
    """every time event e carries (the numbers shifted() moves)"""
    found = []

    def keep(v):
        found.append(v)
        return v
    _walk(e, fields, keep)
    return found
