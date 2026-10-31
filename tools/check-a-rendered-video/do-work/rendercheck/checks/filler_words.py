"""filler-words-cut: filler words are cut from speech the video cuts, rebuilds or inserts. The word lists are the person's rows (config filler_words):
  - `fillers`: always a hit ("uh", "um");
  - `sentence_opening`: a hit when the word opens a sentence;
  - `after_filler`: a hit when the word follows a filler ("um, yeah");
  - `before_filler`: a hit when a filler follows the word ("no uh");
  - `loose`: a hit unless the word before it is in `loose_keep_after` (a comparison or a verb frame where the word carries meaning).
Read from the video's word timings (the cached transcript). Words are judged inside join_window_s of every cut or hold of the spec (the speech this video edited), and everywhere
when the spec sets `rebuilds_speech: true`; a video that leaves the speech as recorded is an empty set. Each hit is listed with its context so a person can overrule one with
`filler_keep: ["<time in seconds>"]`. `loose` is a heuristic; the other lists are exact."""
import re

from ..report import Finding

NAME = 'filler-words-cut'
EMPTY_SET = 'the video does not edit its speech'


def needs(ctx):
    if not (ctx.edit.get('cuts') or ctx.edit.get('hold') or ctx.edit.get('prepend') or ctx.spec.get('rebuilds_speech')):
        return EMPTY_SET
    return None if ctx.words_if_present() is not None else 'no word timings of the video (run the word-clip check once to cache them)'


def core(word):
    return re.sub(r"[^a-z']", '', word.lower())


def hits(words, c):
    """[(index, label, None)] over the word list."""
    out = []
    fill, opening, after, before = set(c['fillers']), set(c['sentence_opening']), set(c['after_filler']), set(c['before_filler'])
    loose, keep_after = set(c['loose']), set(c['loose_keep_after'])
    for k, w in enumerate(words):
        t = core(w['w'])
        prev = core(words[k - 1]['w']) if k else ''
        prev_raw = words[k - 1]['w'] if k else '.'
        following = core(words[k + 1]['w']) if k + 1 < len(words) else ''
        if t in fill:
            out.append((k, t, None))
        elif t in opening and (k == 0 or prev_raw.rstrip().endswith(('.', '?', '!'))):
            out.append((k, f'{t} (opening a sentence)', None))
        elif t in after and prev in fill:
            out.append((k, f'{prev}, {t}', None))
        elif t in loose and prev not in keep_after:
            out.append((k, t, None))
        elif t in before and following in fill:
            out.append((k, f'{t} {following}', None))
    return out

def run(ctx):
    c = ctx.cfg['filler_words']
    words = ctx.words_if_present()
    joins = [j['t'] for j in ctx.joins()]
    near = (lambda w: True) if ctx.spec.get('rebuilds_speech') else (lambda w: any(abs(w['s'] - t) <= c['join_window_s'] for t in joins))
    kept = {float(x) for x in ctx.spec.get('filler_keep', [])}
    out = []
    for k, what, _ in hits(words, c):
        w = words[k]
        if not near(w) or any(abs(w['s'] - x) < 0.3 for x in kept):
            continue
        context = ' '.join(x['w'] for x in words[max(k - 3, 0):k + 4])
        out.append(Finding(NAME, 'FAIL', f'"{what}" at {w["s"]:.1f}s is left in the speech this video edits ("{context}"): cut it', w['s'], data={'filler': what}))
    return out or [Finding(NAME, 'INFO', f'{len(words)} words read near {len(joins)} joins; no filler left')]
