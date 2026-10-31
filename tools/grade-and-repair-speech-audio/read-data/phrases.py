"""Split a span's words into phrases at the pauses of the original, so each phrase can be re-voiced and laid at its own offset."""

PAUSE = 0.25
SENTENCE_GAP = 0.05


def phrases(words):
    """Words with times -> list of phrases. A gap under SENTENCE_GAP never splits; a gap under PAUSE splits only after a sentence end."""
    out = []
    for w in words:
        gap = w["start"] - out[-1][-1]["end"] if out else 0
        if out and (gap < SENTENCE_GAP or (gap < PAUSE and not out[-1][-1]["text"].endswith((".", "?", "!")))):
            out[-1].append(w)
        else:
            out.append([w])
    return out
