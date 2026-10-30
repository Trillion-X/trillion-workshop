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


def slug(text):
    return re.sub(r"[^a-z0-9]+", "_", str(text).lower()).strip("_")


def apply_reply(vocabulary, batch, reply):
    """Write the model's buckets and relevance onto each moment of the batch; new buckets join the vocabulary.

    A moment the reply did not answer is marked untagged with relevance None, so the caller can ask again for it alone.
    """
    for key, description in (reply.get("new_buckets") or {}).items():
        key = slug(key)
        if key and key not in vocabulary["buckets"]:
            vocabulary["buckets"][key] = {"description": str(description), "origin": "model"}
    by_id = {m["id"]: m for m in batch}
    for answer in reply.get("moments", []):
        moment = by_id.get(answer.get("id"))
        if not moment:
            continue
        relevance = max(0.0, min(1.0, float(answer.get("relevance", 0))))
        tags = [slug(b) for b in answer.get("buckets", [])][:3] if relevance >= KEEP_RELEVANCE else []
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
