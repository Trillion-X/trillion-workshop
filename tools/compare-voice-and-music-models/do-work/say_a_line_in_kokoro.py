  - Each unit is one generation. Kokoro has no context across generations, so a unit never splits a sentence.
  - Pronunciation goes in the unit text as misaki markup, [word](/IPA/), with misaki's British symbols (lang 'b':
    Q = /əʊ/, so "Close" is /klˈQs/). A word is never slowed or time-stretched to fix how it sounds.
  - A silence the model makes inside a unit (an ellipsis) is kept, but shortened to `inner_most` seconds when it is
    longer. Only silent samples are removed. `inner_most` is one number for every unit, or a list with one cap per unit
    (a longer cap for the unit with the ellipsis, so the model's other in-phrase pauses stay short).
  - Units are joined by the `pause_after` silences. Speech is never stretched.
Round 3 (narrator/vo/ch1-r3-a.say.txt) did the opposite: it stacked [pause 0.6] on "...", which measured 1.40 s of
silence, and it slowed the vowel of a hand-written /klˈoːs/.
Run with python3 (mlx-audio 0.5.8, misaki 0.9.4).
"""
import argparse
import json
import numpy as np
import soundfile as sf

EDGE_DB = -45  # a unit's own leading/trailing silence below this level is trimmed before the set pause is added


def read_line(path):
    line = json.load(open(path))
    assert len(line['units']) == len(line['pause_after']), 'one pause_after per unit'
    assert not isinstance(line['inner_most'], list) or len(line['inner_most']) == len(line['units']), 'one inner_most per unit'
    return line


def envelope_db(y, sr):
    win = int(0.01 * sr)
    return 20 * np.log10(np.sqrt(np.convolve(y ** 2, np.ones(win) / win, mode='same')) + 1e-9)


def trim(y, sr):
    loud = np.where(envelope_db(y, sr) > EDGE_DB)[0]
    if not len(loud):
        return y
    a, b = max(0, loud[0] - int(0.02 * sr)), min(len(y), loud[-1] + int(0.04 * sr))
    return y[a:b]


def cap_inner(y, sr, inner_most):
    quiet, keep, i, most = envelope_db(y, sr) < EDGE_DB, np.ones(len(y), bool), 0, int(inner_most * sr)
    while i < len(y):
        if quiet[i]:
            j = i
            while j < len(y) and quiet[j]:
                j += 1
            if j - i > most:
                cut = (j - i) - most
                keep[i + (j - i - cut) // 2: i + (j - i - cut) // 2 + cut] = False
            i = j
        else:
            i += 1
    return y[keep]


def join(units, line, sr):
    """units: one audio array per unit -> the take: each unit trimmed, inner silences capped, set pauses between."""
    caps = line['inner_most'] if isinstance(line['inner_most'], list) else [line['inner_most']] * len(units)
    parts = []
    for y, pause, cap in zip(units, line['pause_after'], caps):
        parts += [cap_inner(trim(y, sr), sr, cap), np.zeros(int(pause * sr), np.float32)]
    return np.concatenate(parts)


def lang_of(voice):
    """Kokoro names a voice by its accent first: 'b' British (bm_lewis), 'a' American (af_heart). The G2P must match it,
