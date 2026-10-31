"""Pure: cut a corpus of captioned videos into the parts a model reads, fill the person's prompt, read the model's reply, and put
each quote the model gives back onto the exact caption words it came from, with the seconds they start and end.

Nothing here reads a file or calls a model. A video is {"id", "channel", "title", "segs": [[second, text]], ...} (the corpus line).
The person's asks file says what to ask for and how the reply is shaped; this module only knows four things about a reply: it is a
JSON object, its rows are in asks["rows_key"], each row names its part in asks["part_field"], and its quote is in asks["quote_field"].
Every other field of a row is the person's and is carried as it is.
"""
import difflib
import json
import re

WORD = re.compile(r"[\w']+")


class Captions:
    """One video's captions as one text, with each line's start second, so a span of characters has a start and an end second."""

    def __init__(self, segs, duration=None):
        self.text, self.starts = "", []
        for second, line in segs:
            if self.text:
                self.text += " "
            self.starts.append((len(self.text), second))
            self.text += line
        self.duration = duration
        self.words = [(m.start(), m.end(), _norm(m.group(0))) for m in WORD.finditer(self.text.replace("’", "'"))]

    def line_at(self, offset):
        """Index of the caption line holding the character at offset."""
        index = 0
        for i, (position, _) in enumerate(self.starts):
            if position > offset:
                break
            index = i
        return index

    def seconds(self, start, end):
        """(second the span starts, second its last line ends): the end is the next line's start, else the duration, else its own start."""
        first, last = self.line_at(start), self.line_at(max(start, end - 1))
        t = self.starts[first][1]
        if last + 1 < len(self.starts):
            t_end = self.starts[last + 1][1]
        else:
            t_end = self.duration if self.duration else self.starts[last][1]
        return int(t), int(round(t_end))

    def word_range(self, first_line, end_line):
        """Indices [i, j) of the words said in caption lines [first_line, end_line)."""
        low = self.starts[first_line][0]
        high = self.starts[end_line][0] if end_line < len(self.starts) else len(self.text) + 1
        indices = [i for i, (s, _, _) in enumerate(self.words) if low <= s < high]
        return (indices[0], indices[-1] + 1) if indices else (0, 0)


def _norm(word):
    return word.lower().replace("’", "'").strip("'")


def quote_words(quote):
    return [w for w in (_norm(m.group(0)) for m in WORD.finditer((quote or "").replace("’", "'"))) if w]


def place_quote(captions, quote, within=None, at_least=0.8, most_words=25):
    """Find the caption words a quote came from.

    The quote's words are matched to the caption's words (case, punctuation and apostrophes ignored), first as an exact run, then as
    the window with the most words in order (difflib) when at least `at_least` of the quote's words are there. `within` = (i, j)
    limits the search to those caption words (the part the model read). The kept quote is the caption's own words over the matched
    span, cut to `most_words` words. Returns {quote, t, t_end, match} or None when the words are not there.
    """
    wanted = quote_words(quote)
    if not wanted:
        return None
    i0, j0 = within if within else (0, len(captions.words))
    said = [w for _, _, w in captions.words[i0:j0]]
    n = len(wanted)
    start = None
    for k in range(0, len(said) - n + 1):
        if said[k:k + n] == wanted:
            start, end, match = k, k + n, 1.0
            break
    if start is None:
        best = None
        for k in range(0, max(1, len(said) - n + 1)):
            window = said[k:k + n + max(2, n // 4)]
            blocks = difflib.SequenceMatcher(None, wanted, window, autojunk=False).get_matching_blocks()
            hit = sum(b.size for b in blocks)
            if best is None or hit > best[0]:
                matched = [b for b in blocks if b.size]
                if matched:
                    best = (hit, k + matched[0].b, k + matched[-1].b + matched[-1].size)
        if best is None or best[0] / n < at_least:
            return None
        start, end, match = best[1], best[2], round(best[0] / n, 3)
    end = min(end, start + most_words)
    first, last = captions.words[i0 + start], captions.words[i0 + end - 1]
    t, t_end = captions.seconds(first[0], last[1])
    return {"quote": captions.text[first[0]:last[1]], "t": t, "t_end": t_end, "match": match}


def parts_of(videos, most_words):
    """Cut videos into parts of at most `most_words` words at caption-line boundaries, then pack consecutive short parts together.

    Returns chunks: [[{"video", "first_line", "end_line", "words"}]], each chunk at most `most_words` words (a single line longer than
    that is its own part). Videos are packed in the order given, so pass one channel's videos together.
    """
    chunks, current, size = [], [], 0
    for video in videos:
        counts = [len(text.split()) for _, text in video["segs"]]
        line = 0
        while line < len(counts):
            end, words = line, 0
            while end < len(counts) and (words + counts[end] <= most_words or end == line):
                words += counts[end]
                end += 1
            part = {"video": video["id"], "first_line": line, "end_line": end, "words": words}
            if current and size + words > most_words:
                chunks.append(current)
                current, size = [], 0
            current.append(part)
            size += words
            line = end
    if current:
        chunks.append(current)
    return chunks


class Missing(dict):
    def __missing__(self, key):
        return ""


def fill(template, values):
    return template.format_map(Missing({k: ("" if v is None else v) for k, v in values.items()}))


def prompt_of(asks, chunk, videos):
    """The user message for one chunk: each part's header (the asks' `part_header`, filled from the video and the part number)
    and its words."""
    pieces = []
    for number, part in enumerate(chunk, 1):
        video = videos[part["video"]]
        text = " ".join(line for _, line in video["segs"][part["first_line"]:part["end_line"]])
        values = {**{k: v for k, v in video.items() if not isinstance(v, (list, dict))}, "part": number,
                  "desc": (video.get("desc") or "")[:asks.get("description_chars", 400)],
                  "from_second": int(video["segs"][part["first_line"]][0])}
        pieces.append(fill(asks["part_header"], values) + "\n" + text)
    return fill(asks.get("user", "{parts}"), {"parts": "\n\n".join(pieces), "parts_count": len(chunk)})


def json_values(text):
    """Every JSON object or list in a model's answer, in order. Thinking blocks, code fences and words between them are ignored."""
    text = re.sub(r"<think>.*?</think>", "", text or "", flags=re.S)
    decoder, values, at = json.JSONDecoder(), [], 0
    while True:
        starts = [i for i in (text.find("{", at), text.find("[", at)) if i >= 0]
        if not starts:
            return values
        try:
            value, at = decoder.raw_decode(text, min(starts))
            values.append(value)
        except ValueError:
            at = min(starts) + 1


def reply_rows(text, rows_key):
    """The rows in a model's answer (json_values). A server that cannot hold the answer to the schema may write
    {rows_key: [...]}, a bare list of rows, or one object per row one after another; all three give the same rows. An answer
    with no JSON value, or whose values hold no rows key and no row objects, is an error (an answer of {rows_key: []} is none)."""
    rows, held = [], False
    for value in json_values(text):
        if isinstance(value, dict) and rows_key in value:
            held = True
            rows.extend(value[rows_key] or [])
        elif isinstance(value, list):
            held = True
            rows.extend(value)
        elif isinstance(value, dict):
            held = True
            rows.append(value)
    if not held:
        raise ValueError("no rows in the answer")
    return rows


def _number_or_word(token):
    """A content word as it is compared: a number keeps its digits and point ("$1,200" and "1200" match), a word is folded."""
    if re.search(r"\d", token):
        return re.sub(r"[^\d.]", "", token).strip(".")
    return _norm(re.sub(r"[^\w'’]", "", token).replace("’", "'"))


def content_words(rule, statement):
    """The statement's words the rule's `words` pattern names (for example numbers and names), each folded; a match that
    starts the statement or a sentence in it is left out, since a capital there says nothing about a name."""
    found = []
    for match in re.finditer(rule["words"], statement or ""):
        before = statement[:match.start()].rstrip()
        if not before or before[-1] in ".!?:;":
            continue
        word = _number_or_word(match.group(0))
        if word and word not in rule.get("ignore", []) and word not in found:
            found.append(word)
    return found


def _support_tokens(text):
    return {_number_or_word(m.group(0)) for m in re.finditer(r"[\w'’$.,%]+", (text or "").replace("’", "'"))} - {""}


def carried(rule, statement, captions, placed, within, video):
    """Whether the quote carries the statement: every content word is in the quote or in the video fields the rule names
    (`also_in`, for names a title or description gives). When some are only in the caption lines around the quote (the
    rule's `neighbour_lines` either side, inside the part the model read), the quote is taken again: the shortest run of
    words there holding all of them, widened to at least `least_words` and kept at most `most_words`.

    Returns (placed, missing): placed is the quote kept or taken again, None when the statement is not carried; missing
    names the content words found in neither.
    """
    words = content_words(rule, statement)
    beside = _support_tokens(" ".join(str(video.get(field) or "") for field in rule.get("also_in", [])))
    wanted = [word for word in words if word not in beside and word not in _support_tokens(placed["quote"])]
    if not wanted:
        return placed, []
    start = captions.text.find(placed["quote"])
    first, last = captions.line_at(start), captions.line_at(start + len(placed["quote"]) - 1)
    n = rule.get("neighbour_lines", 1)
    lo, hi = captions.word_range(max(0, first - n), min(len(captions.starts), last + n + 1))
    lo, hi = max(lo, within[0]), min(hi, within[1])
    said = [_number_or_word(captions.text[s:e]) for s, e, _ in captions.words[lo:hi]]
    most, best = rule.get("most_words", 25), None
    for left in range(len(said)):
        seen = set()
        for right in range(left, min(len(said), left + most)):
            if said[right] in wanted:
                seen.add(said[right])
            if len(seen) == len(set(wanted)):
                if best is None or right - left < best[1] - best[0]:
                    best = (left, right)
                break
    if best is None:
        return None, [word for word in wanted if word not in said]
    left, right = best
    while right - left + 1 < rule.get("least_words", 8) and (left > 0 or right < len(said) - 1):
        left, right = max(0, left - 1), min(len(said) - 1, right + 1)
    s, e = captions.words[lo + left][0], captions.words[lo + right][1]
    t, t_end = captions.seconds(s, e)
    return {"quote": captions.text[s:e], "t": t, "t_end": t_end, "match": placed["match"], "requoted": True}, []


def guest_of(rules, video):
    """The guest a video names, by the person's patterns over its fields ({field, pattern} with a named group `name`), first
    match wins; None when no pattern finds one."""
    for rule in rules or []:
        match = re.search(rule["pattern"], str(video.get(rule["field"]) or ""))
        if match and match.group("name"):
            return match.group("name").strip()
    return None


def rows_of_reply(asks, chunk, videos, captions_of, rows, base):
    """The rows a reply gives (reply_rows), each placed on the exact caption words of its quote.

    Returns (kept, dropped): a kept row is the model's fields (without its part and quote), base, and `sources`: one
    {video, platform, channel, title, t, t_end, quote, quote_match} whose quote is the caption's own words; dropped rows say why
    (no part, a field value the asks' `drop_when` {field: [values]} names, quote not said in the part).
    """
    kept, dropped = [], []
    quote_field, part_field = asks["quote_field"], asks["part_field"]
    drop_when = asks.get("drop_when") or {}
    for row in rows:
        if not isinstance(row, dict):
            dropped.append({"why": "not an object", "row": row})
            continue
        number = row.get(part_field, 1 if len(chunk) == 1 else None)
        try:
            part = chunk[int(number) - 1]
        except (TypeError, ValueError, IndexError):
            dropped.append({"why": "names no part it read", "row": row})
            continue
        named = next((field for field, values in drop_when.items() if row.get(field) in values), None)
        if named:
            dropped.append({"why": f"{named} is {row[named]}", "video": part["video"], "row": row})
            continue
        caption = captions_of(part["video"])
        placed = place_quote(caption, row.get(quote_field), caption.word_range(part["first_line"], part["end_line"]),
                             asks.get("quote_match_at_least", 0.8), asks.get("quote_most_words", 25))
        if placed is None:
            dropped.append({"why": "quote not said in the part", "video": part["video"], "row": row})
            continue
        video = videos[part["video"]]
        rule = asks.get("carried_by_quote")
        if rule:
            within = caption.word_range(part["first_line"], part["end_line"])
            placed, missing = carried({"most_words": asks.get("quote_most_words", 25), **rule}, row.get(rule["field"]), caption, placed, within, video)
            if placed is None:
                dropped.append({"why": "statement not carried by its quote", "missing": missing, "video": part["video"], "row": row})
                continue
        fields = {k: v for k, v in row.items() if k not in (quote_field, part_field)}
        source = {"video": video["id"], "platform": video.get("platform"), "channel": video.get("channel"),
                  "guest": guest_of(asks.get("guest_from"), video), "title": video.get("title"),
                  **({"url": video['url']} if video.get('url') else {}),
                  "t": placed["t"], "t_end": placed["t_end"], "quote": placed["quote"], "quote_match": placed["match"],
                  **({"requoted": True} if placed.get("requoted") else {})}
        kept.append({**fields, **base, "sources": [source]})
    return kept, dropped
