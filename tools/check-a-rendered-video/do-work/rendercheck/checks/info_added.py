"""info-added: an informational graphic adds real information beyond the spoken words, instead of only repeating them.
A moment is informational when its spec says `moment_kind: informational`; with no moment_kind, when it has an event of a type in config info_added.informational_types (cards, callouts,
labels, charts; not a count-up of a figure the speaker says, which is emphasis). Any other `moment_kind` is not informational. Every word and number on those events is compared with
the words spoken in the video (the cached word timings): a token not spoken, after the stop words and a plural s are dropped, is new. The video fails when
fewer than min_new_tokens of them are new, or none is a number: an informational graphic needs at least one sourced amount, percentage or price the speaker did not say; new words alone can be filler. The fact gate checks that each new fact is sourced.
A moment that is not informational (a mood, a joke, a bridge) is an empty set."""
import re

from ..report import Finding
from .dwell import element_strings

NAME = 'info-added'
EMPTY_SET = 'no informational graphic'


def informational(ctx):
    """True when the moment is informational: the spec says so (`moment_kind: informational`), or, with no moment_kind, it has an event of an informational type. Any other
    moment_kind (emphasis, joke, bridge) is not informational: a count-up of a figure the speaker says is emphasis."""
    kind = ctx.spec.get('moment_kind')
    if kind is not None:
        return kind == 'informational'
    return any(ev.get('type') in ctx.cfg['info_added']['informational_types'] for ev in ctx.spec.get('events', []))


def needs(ctx):
    if not informational(ctx):
        return EMPTY_SET
    return None if ctx.words_if_present() is not None else 'no word timings of the preview (run the word-clip check once to cache them)'


def stem(w):
    return w[:-1] if len(w) > 3 and w.endswith('s') else w


def tokens(text):
    return [stem(w) for w in re.findall(r"[a-z0-9%]+(?:'[a-z]+)?", text.lower()) if len(w) > 1 or w.isdigit()]


def run(ctx):
    c = ctx.cfg['info_added']
    stop = set(c['stop_words'])
    spoken = {stem(t) for w in ctx.words_if_present() for t in tokens(w['w'])}
    skip = set(ctx.cfg['dwell']['non_text_keys']) | set(c['skip_keys'])      # values that are directions and styles, not words on screen
    shown, new = [], []
    for ev in ctx.spec.get('events', []):
        if ev.get('type') not in c['informational_types']:
            continue
        for s in element_strings(ev, skip):
            for t in tokens(s):
                if t in stop or t in shown:
                    continue
                shown.append(t)
                if t not in spoken and not (t.isdigit() and t in spoken):
                    new.append(t)
    numbers = [t for t in new if re.search(r'\d', t)]
    if len(new) < c['min_new_tokens']:
        return [Finding(NAME, 'FAIL', f'the informational graphic adds {len(new)} new word(s) or number(s) beyond what the speaker says ({", ".join(new) or "none"}; at least {c["min_new_tokens"]} are needed): it only repeats the spoken words; add sourced '
                        'information the speaker did not say (amounts, percentages, which ones, what else, taste)', data={'new': new})]
    if not numbers:
        return [Finding(NAME, 'FAIL', f'the informational graphic adds {len(new)} new words beyond what the speaker says ({", ".join(new[:10])}) but no number: add at least one sourced amount, percentage or price '
                        'the speaker did not say (the fact gate then checks its source)', data={'new': new})]
    return [Finding(NAME, 'INFO', f'{len(new)} new tokens beyond the spoken words, {len(numbers)} numbers: {", ".join(new[:10])}')]
