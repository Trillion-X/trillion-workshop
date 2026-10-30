"""Pure readers for a corpus of captioned videos: caption files to timed lines, exact-quote search, how well a video did against
its channel's usual, and scoring of passages.

Nothing here touches a file or the network. A video is {"id", "channel", "title", "views", "kind", "xmed", "segs": [[seconds, text]]}.
"""
import math
import re
import statistics

SHORT_SECONDS = 180
WINDOW_SECONDS = 40
MIN_PASSAGE_WORDS = 25
EVIDENCE_CAP = 64
TOP_PASSAGES_PER_VIDEO = 3


def segs_from_json3(document):
    """[[start second, text]] from a YouTube json3 caption file's events."""
    segs = []
    for event in document.get("events", []):
        if "segs" not in event:
            continue
        text = "".join(s.get("utf8", "") for s in event["segs"]).replace("\n", " ").strip()
        if text:
            segs.append([round(event.get("tStartMs", 0) / 1000, 1), text])
    return segs


def kind_of(info):
    """'short' or 'video' from a video's info record."""
    if info.get("media_type") == "short":
        return "short"
    if (info.get("duration") or 999) <= SHORT_SECONDS and "/shorts/" in (info.get("webpage_url") or ""):
        return "short"
    return "video"


def medians(pairs):
    """{key: median} of [(key, number)]."""
    grouped = {}
    for key, number in pairs:
        grouped.setdefault(key, []).append(number)
    return {key: statistics.median(numbers) for key, numbers in grouped.items() if numbers}


def times_the_usual(views, median):
    """How many times the channel's usual views this video got (None when either is unknown)."""
    return round(views / median, 2) if median and views is not None else None


def fold(text):
    """(text with runs of white space made one space, lower-cased, curly apostrophes made straight; offset of each kept character in the original)."""
    kept, offsets, after_space = [], [], False
    for index, char in enumerate(text.replace("\xa0", " ").replace("’", "'")):
        if char.isspace():
            if after_space or not kept:
                continue
            kept.append(" ")
            offsets.append(index)
            after_space = True
        else:
            kept.append(char.lower())
            offsets.append(index)
            after_space = False
    return "".join(kept), offsets


class CaptionText:
    """One video's captions as a single folded text, to find where an exact quote is said."""

    def __init__(self, segs):
        text, starts = "", []
        for second, line in segs:
            if text:
                text += " "
            starts.append((len(text), second))
            text += line
        self.folded, self.offsets = fold(text)
        self.starts = starts

    def second_of(self, quote):
        """The second the quote starts at, or None when the words are not there in that order."""
        needle = re.sub(r"\s+", " ", quote.replace("\xa0", " ").replace("’", "'")).strip().lower()
        index = self.folded.find(needle)
        if index < 0:
            return None
        offset = self.offsets[index]
        return int(max(second for position, second in self.starts if position <= offset))


def passages(video, craft, advice, title_pattern, window=WINDOW_SECONDS, per_video=TOP_PASSAGES_PER_VIDEO):
    """The best windows of one video: those that say the most about the topic in advice-giving words, from a video that did well.

    craft, advice and title_pattern are compiled regular expressions the person supplies. score = 1.5 per distinct topic word
    (first six letters) + 1 per advice phrase + 1.5 when the title matches + 0.7 * log2(times the channel's usual views).
    """
    segs = video["segs"]
    title_bonus = 1.5 if title_pattern.search(video["title"] or "") else 0
    performance = math.log2(max(video["xmed"] or 1, 0.25))
    windows, i = [], 0
    while i < len(segs):
        j = i
        while j < len(segs) and segs[j][0] - segs[i][0] < window:
            j += 1
        text = " ".join(line for _, line in segs[i:j])
        terms = {match.group(0).lower()[:6] for match in craft.finditer(text)}
        score = len(terms) * 1.5 + len(advice.findall(text)) * 1.0 + title_bonus + performance * 0.7
        windows.append((score, i, j, text))
        i = max(j - 1, i + 1) if j - i > 2 else j
    windows.sort(reverse=True)
    return [dict(score=round(score, 2), id=video["id"], t=int(segs[i][0]), title=video["title"], views=video["views"],
                 xmed=video["xmed"], kind=video["kind"], text=text)
            for score, i, j, text in windows[:per_video] if len(text.split()) >= MIN_PASSAGE_WORDS]


def evidence_strength(items):
    """Sum over independent channels of the best weight * log2(1 + min(times the usual, 64)) among that channel's evidence.

    items = [(channel, times_the_usual or None, weight)]; a video with no known times_the_usual counts 0.5 * weight.
    Returns (strength rounded to 2 places, {channel: best}).
    """
    best = {}
    for channel, times, weight in items:
        if not channel:
            continue
        value = weight * (math.log2(1 + min(times, EVIDENCE_CAP)) if times is not None else 0.5)
        best[channel] = max(best.get(channel, 0.0), value)
    return round(sum(best.values()), 2), best
