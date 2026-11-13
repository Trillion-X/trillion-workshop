"""Pure parts of filing spoken moments into topic buckets: cutting a transcript into moments, reading the model's reply, counting.

Nothing here asks a model or touches a file. A transcript is {"segments": [{"text", "start", "end"}]}; a moment is
{"start", "end", "text", "segments": [index], "id"}; a vocabulary is {"note": str, "buckets": {slug: {"description", "origin"}}}.
"""
import collections
import re

GAP_SECONDS = 4.0
MAX_WORDS = 120
BATCH = 8
KEEP_RELEVANCE = 0.15


def new_vocabulary(defaults):
    """A vocabulary to start from: the defaults' seed_buckets when they carry any, else empty (the model proposes the buckets)."""
    return {"note": defaults["note_vocabulary"],
            "buckets": {slug: {"description": text, "origin": "seed"} for slug, text in defaults.get("seed_buckets", {}).items()}}


def moments_of(doc, gap=GAP_SECONDS, max_words=MAX_WORDS):
    """Cut a transcript's segments into moments: a new one starts after a silence longer than gap seconds or past max_words words."""
    out, current = [], []

    def flush():
        if current:
            out.append({"start": current[0]["start"], "end": current[-1]["end"],
                        "text": " ".join(s["text"] for s in current), "segments": [s["idx"] for s in current]})

    previous_end, count = None, 0
    for index, segment in enumerate(doc["segments"]):
        segment = dict(segment, idx=index)
        words = len(segment["text"].split())
        if current and (segment["start"] - previous_end > gap or count + words > max_words):
            flush()
            current.clear()
            count = 0
        current.append(segment)
        count += words
        previous_end = segment["end"]
    flush()
    return out


def windows_of(segments, size):
    """The segments, each given its index as idx, in runs of at most `size`: the stretches a model is asked to cut into ideas."""
    indexed = [dict(segment, idx=i) for i, segment in enumerate(segments)]
    return [indexed[i:i + size] for i in range(0, len(indexed), size)]


def ends_sentence(text):
    """Whether a segment's text ends on a sentence mark (. ? !), allowing closing quotes or brackets after it."""
    return re.search(r"[.?!][\"')\]]*\s*$", text.strip()) is not None


def snap_starts(segments, starts):
    """Starts moved so each idea begins where a sentence begins: one inside a sentence moves forward to the next segment that starts one.

    The first segment always starts an idea. A start with no sentence start after it is dropped.
    """
    ok = lambda i: i == 0 or ends_sentence(segments[i - 1]["text"])
    snapped = set()
    for s in starts:
        if not isinstance(s, int) or isinstance(s, bool) or not 0 <= s < len(segments):
            continue
        while s < len(segments) and not ok(s):
            s += 1
        if s < len(segments):
            snapped.add(s)
    return sorted(snapped | ({0} if segments else set()))


def ideas_from_starts(segments, starts):
    """Ideas from the positions where the model says one begins: each keeps its segments, their first start and last end, and their words.

    A start that is not a position among the segments is dropped, and the first segment always begins an idea.
    """
    valid = {s for s in starts if isinstance(s, int) and not isinstance(s, bool) and 0 <= s < len(segments)} | ({0} if segments else set())
    ordered, out = sorted(valid), []
    for k, first in enumerate(ordered):
        last = (ordered[k + 1] if k + 1 < len(ordered) else len(segments)) - 1
        run = segments[first:last + 1]
        out.append({"start": run[0]["start"], "end": run[-1]["end"], "text": " ".join(s["text"] for s in run), "segments": list(range(first, last + 1))})
    return out


def merge_short(ideas, least_words):
    """Ideas with fewer than `least_words` words joined to the idea before them (the first, to the one after), so none is a fragment."""
    out = []
    for idea in ideas:
        idea = dict(idea)
        if out and len(out[-1]["text"].split()) < least_words:
            out[-1] = join_ideas(out[-1], idea)
        elif out and len(idea["text"].split()) < least_words:
            out[-1] = join_ideas(out[-1], idea)
        else:
            out.append(idea)
    return out


def join_ideas(first, second):
    return {**first, "end": second["end"], "text": first["text"] + " " + second["text"], "segments": first["segments"] + second["segments"]}


def vocabulary_from_rows(answers, describe, label_fields):
    """A closed vocabulary from the rows of the person's own lists (each answer is a records:list answer {"records": [{"id", "value"}]}).

    A row is one bucket, keyed by the end of its id (the value a link to the row holds). Its words are its label (the first of
    `label_fields` it has) and then those of its `describe` fields it has. The model may only choose among these buckets.
    """
    buckets = {}
    for answer in answers:
        for row in answer["records"]:
            key, value = row["id"].rsplit(":", 1)[-1], row.get("value") or {}
            if key in buckets:
                raise ValueError(f"two rows end in the same key {key}, so a bucket could not name one of them")
            label = next((str(value[f]) for f in label_fields if value.get(f)), key)
            words = " ".join(str(value[f]) for f in describe if value.get(f))
            buckets[key] = {"name": slug(label), "description": words, "origin": "row"}
    return {"note": "Buckets read from the person's own list rows; the model may not add to them.", "closed": True, "buckets": buckets}


def slug(text):
    return re.sub(r"[^a-z0-9]+", "_", str(text).lower()).strip("_")


def apply_reply(vocabulary, batch, reply):
    """Write the model's buckets and relevance onto each moment of the batch; new buckets join the vocabulary.

    A moment the reply did not answer is marked untagged with relevance None, so the caller can ask again for it alone.
    """
    closed = vocabulary.get("closed")
    own = {slug(k): k for k in vocabulary["buckets"]}
    own.update({slug(v["name"]): k for k, v in vocabulary["buckets"].items() if v.get("name")})
    for key, description in ({} if closed else reply.get("new_buckets") or {}).items():
        key = slug(key)
        if key and key not in vocabulary["buckets"]:
            vocabulary["buckets"][key] = {"description": str(description), "origin": "model"}
    by_id = {m["id"]: m for m in batch}
    for answer in reply.get("moments", []):
        moment = by_id.get(answer.get("id")) if isinstance(answer, dict) and isinstance(answer.get("id"), (int, str)) else None
        if not moment:
            continue
        relevance = max(0.0, min(1.0, float(answer.get("relevance", 0))))
        said = [slug(b) for b in answer.get("buckets", [])]
        if closed:
            said = [own[b] for b in said if b in own]
        tags = said[:3] if relevance >= KEEP_RELEVANCE else []
        for tag in tags:
            vocabulary["buckets"].setdefault(tag, {"description": "", "origin": "model"})
        moment["buckets"], moment["relevance"] = tags, round(relevance, 2)
    for moment in batch:
        if "relevance" not in moment:
            moment["buckets"], moment["relevance"], moment["untagged"] = [], None, True


def band(relevance):
    r = relevance or 0
    return "irrelevant <0.15" if r < 0.15 else "low 0.15-0.5" if r < 0.5 else "usable >=0.5"


def count_buckets(moments, vocabulary):
    """{moments, untagged, bands, per_bucket: [(bucket, count, description)] most used first}."""
    per, bands, untagged = collections.Counter(), collections.Counter(), 0
    for moment in moments:
        untagged += bool(moment.get("untagged"))
        bands[band(moment["relevance"])] += 1
        for bucket in moment["buckets"]:
            per[bucket] += 1
    return {"moments": len(moments), "untagged": untagged, "bands": dict(bands),
            "per_bucket": [(b, c, vocabulary.get(b, {}).get("description", "")) for b, c in per.most_common()]}
