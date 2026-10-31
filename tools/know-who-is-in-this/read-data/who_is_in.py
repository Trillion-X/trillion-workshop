"""Who is in a recording or a picture, from the voice and face prints a person enrolled. Pure: numbers in, answers out.

A print is one record per person and kind (voice-print, face-print): the person's name, whether it is them (`me`),
the sample vectors measured from what they enrolled with, and the consent words that say who agreed to be known by
their voice or face and how. A print is never made without consent words. Prints and the session of unknown voices
stay on the device they were made on (their kinds are declared stays_on_this_device in the tool rows); this module
only reads and returns them.

Every threshold is an input with a stated starting value: `person_at_least` how alike a sample must be to count as a
person, `sure_by` how far ahead of the next person the best must be before it is named, `maybe_at_least` the lowest
score at which a person is listed as a possibility, `same_unknown_at_least` how alike two unknown voices must be to be
one voice, `same_in_piece_at_least` the same inside one recording, `shortest_seconds` the shortest stretch worth
measuring and `new_voice_shortest_seconds` how long an unknown voice must speak before it counts as a new voice.
"""

from __future__ import annotations

import math
import re
from datetime import datetime, timezone

KINDS = {"voice": {"record": "voice-print", "size": 192}, "face": {"record": "face-print", "size": 128}}

# Starting values for the 192-number CAM++ voice print and the 128-number SFace face print. They have not been
# calibrated on a person's own consented clips; the README says how.
VOICE_RULES = {"shortest_seconds": 1.0, "person_at_least": 0.72, "sure_by": 0.05, "maybe_at_least": 0.55,
               "same_unknown_at_least": 0.72, "same_in_piece_at_least": 0.72, "new_voice_shortest_seconds": 2.5}
FACE_RULES = {"person_at_least": 0.363, "sure_by": 0.05, "maybe_at_least": 0.25}
WORDS = {"unknown": "Someone ({voice})", "unsure": "Unsure ({names}?)", "or": "or"}


class Refused(ValueError):
    """The input says something this tool will not do (no consent words, an unknown kind, a vector of the wrong size)."""


def unit(values, size=None):
    vector = [float(x) for x in values]
    if size is not None and len(vector) != size:
        raise Refused(f"A print holds {size} numbers; this one holds {len(vector)}.")
    if not all(math.isfinite(x) for x in vector):
        raise Refused("A print holds only finite numbers.")
    norm = math.sqrt(sum(x * x for x in vector))
    if norm == 0:
        raise Refused("A print cannot be all zeros.")
    return [x / norm for x in vector]


def alike(a, b):
    return sum(x * y for x, y in zip(a, b))


def slug(name):
    return re.sub(r"[^a-z0-9]+", "-", str(name).lower()).strip("-") or "person"


def consented(consent):
    """The consent words trimmed, or a refusal: nobody is enrolled without words saying who agreed and how."""
    words = str(consent or "").strip()
    if not words:
        raise Refused("Say who agreed to be known by their voice or face here, and how, before enrolling them.")
    return words


def kind_of(kind):
    if kind not in KINDS:
        raise Refused("Enrol a voice or a face.")
    return KINDS[kind]


def print_record(kind, name, vectors, consent, existing=None, me=False, now=None):
    """The print record for one person: `existing` (the same person's earlier record value, or None) gains the new
    sample vectors and consent words; the earlier samples and consent words are kept. Returns { id, type, value }."""
    spec = kind_of(kind)
    words = consented(consent)
    name = str(name or "").strip()
    if not name:
        raise Refused("Give the person's name.")
    if not vectors:
        raise Refused(f"Nothing to enrol: no {kind} was measured.")
    value = dict(existing or {})
    person = slug(name)
    stamp = (now or datetime.now(timezone.utc)).isoformat()
    value.update({"person": person, "name": name, "me": bool(value.get("me")) or bool(me)})
    value["samples"] = list(value.get("samples", [])) + [[round(x, 7) for x in unit(v, spec["size"])] for v in vectors]
    value["consent"] = list(value.get("consent", [])) + [{"kind": kind, "said": words, "at": stamp}]
    return {"id": f"{spec['record']}:{person}", "type": spec["record"], "value": value}


def best_of(vector, prints, rules):
    """Who a vector is: (who, score, unsure). Named only when the best person reaches `person_at_least` and nobody else
    is within `sure_by` of them; otherwise the people it could be (the best, and anyone within `sure_by`, when the best
    reaches `maybe_at_least`) come back as `unsure`, so a guess is never made silently."""
    ranked = sorted(((max((alike(vector, s) for s in value.get("samples", [])), default=-1.0), value) for value in prints),
                    key=lambda pair: pair[0], reverse=True)
    if not ranked:
        return None, -1.0, []
    score, best = ranked[0]
    close = [value for other, value in ranked[1:] if score - other < rules.get("sure_by", 0)]
    if score >= rules["person_at_least"] and not close:
        return {"id": best["person"], "name": best["name"], "me": bool(best.get("me"))}, score, []
    maybe = [best] + close if score >= rules.get("maybe_at_least", rules["person_at_least"]) else []
    return None, score, [{"id": p["person"], "name": p["name"]} for p in maybe]


def pooled(vectors, weights):
    total = [0.0] * len(vectors[0])
    for vector, weight in zip(vectors, weights):
        for at, x in enumerate(vector):
            total[at] += x * weight
    return unit(total)


def groups_of(vectors, at_least):
    """Stretches of one recording that sound like one voice, grouped before any is named, so a voice is judged on all
    it said in the recording rather than on one short stretch."""
    groups = []
    for index, vector in enumerate(vectors):
        best, best_score = None, -1.0
        for group in groups:
            value = alike(vector, group["mean"])
            if value > best_score:
                best, best_score = group, value
        if best is not None and best_score >= at_least:
            best["members"].append(index)
            best["mean"] = unit([sum(vectors[at][i] for at in best["members"]) for i in range(len(vector))])
        else:
            groups.append({"members": [index], "mean": vector})
    return groups


def join_voice(voice, vector, seconds):
    """Adds speech to a session voice: its numbers are a running mean weighted by seconds heard."""
    heard = voice.get("seconds", 1.0)
    voice["mean"] = pooled([voice["mean"], vector], [heard, seconds])
    voice["seconds"] = heard + seconds
    voice["count"] = voice.get("count", 1) + 1


def merge_alike(session, at_least):
    """Two session voices that have become as alike as one voice are one voice: the older keeps its id and lists the
    other in `also`, so turns already kept under either label can be named together later."""
    merged = True
    while merged:
        merged = False
        voices = session["unknown"]
        for first in range(len(voices)):
            for second in range(first + 1, len(voices)):
                if alike(voices[first]["mean"], voices[second]["mean"]) >= at_least:
                    keep, gone = voices[first], voices.pop(second)
                    join_voice(keep, gone["mean"], gone.get("seconds", 1.0))
                    keep["also"] = keep.get("also", []) + [gone["id"]] + gone.get("also", [])
                    merged = True
                    break
            if merged:
                break


def voice_of(session, voice_id):
    """The session voice an id names: itself, or the voice it was merged into (its `also`)."""
    return next((v for v in session["unknown"] if v["id"] == voice_id or voice_id in v.get("also", [])), None)


def name_spans(spans, vectors, prints, session=None, rules=None):
    """Names the voice of each span of one recording.

    spans    [{ start, end }] seconds, in order; vectors[i] is the voice vector measured for spans[i], or None when it
             could not be measured (too short, no speech).
    prints   the person's voice-print record values.
    session  { unknown: [{ id, mean, seconds, count, also? }], made } the unknown voices already heard in this listening,
             so voice-3 stays voice-3 from one recording to the next.
    Returns (answers, session): answers[i] = { start, end, who, score, voice, unsure } where `who` is { id, name, me } or
    None, and `voice` is the person's id or the session's unknown-voice label."""
    rules = {**VOICE_RULES, **(rules or {})}
    session = {"unknown": [dict(v) for v in (session or {}).get("unknown", [])], "made": (session or {}).get("made")}
    if session["made"] is None:
        session["made"] = len(session["unknown"])
    answers = [{"start": float(s["start"]), "end": float(s["end"]), "who": None, "score": None, "voice": None, "unsure": []} for s in spans]
    measured = [at for at, vector in enumerate(vectors)
                if vector is not None and answers[at]["end"] - answers[at]["start"] >= rules["shortest_seconds"]]
    seconds_of = lambda at: answers[at]["end"] - answers[at]["start"]
    for group in groups_of([vectors[at] for at in measured], rules["same_in_piece_at_least"]):
        members = [measured[at] for at in group["members"]]
        seconds = sum(seconds_of(at) for at in members)
        vector = pooled([vectors[at] for at in members], [seconds_of(at) for at in members])
        who, score, unsure = best_of(vector, prints, rules)
        if who:
            for at in members:
                answers[at].update(who=who, score=round(score, 3), voice=who["id"], unsure=[])
            continue
        best, best_score = None, -1.0
        for voice in session["unknown"]:
            value = alike(vector, voice["mean"])
            if value > best_score:
                best, best_score = voice, value
        if best is not None and best_score >= rules["same_unknown_at_least"]:
            join_voice(best, vector, seconds)
        elif seconds >= rules["new_voice_shortest_seconds"]:
            session["made"] += 1
            best = {"id": f"voice-{session['made']}", "mean": vector, "count": 1, "seconds": seconds}
            session["unknown"].append(best)
        elif best is None or best_score < rules["maybe_at_least"]:
            continue
        for at in members:
            answers[at].update(score=round(score, 3), voice=best["id"], unsure=unsure)
    merge_alike(session, rules["same_unknown_at_least"])
    for answer in answers:
        if answer["voice"] and not answer["who"]:
            answer["voice"] = voice_of(session, answer["voice"])["id"]
    # A stretch too short to measure takes the voice of the nearest measured stretch before it, else after it.
    for index, answer in enumerate(answers):
        if answer["voice"] is None:
            order = list(range(index - 1, -1, -1)) + list(range(index + 1, len(answers)))
            near = next((answers[at] for at in order if answers[at]["voice"] and answers[at]["score"] is not None), None)
            if near:
                answer.update(who=near["who"], voice=near["voice"], unsure=near["unsure"])
    return answers, session


def speaker_label(answer, words=None):
    """Who a stretch is from in words: the person's name; when it could be more than one person, all of them; else the
    unknown voice's label. `words` overrides the default phrases."""
    words = {**WORDS, **(words or {})}
    if answer.get("who"):
        return answer["who"]["name"]
    names = [p["name"] for p in answer.get("unsure") or []]
    if names:
        listed = names[0] if len(names) == 1 else f"{', '.join(names[:-1])} {words['or']} {names[-1]}"
        return words["unsure"].replace("{names}", listed)
    return words["unknown"].replace("{voice}", answer.get("voice") or "")


def speakers_of(segments, answers, join_within_seconds=2.0, words=None):
    """Transcript segments ([{ start, end, text }], seconds) with the answer for each span, as turns: consecutive
    segments of the same voice with at most `join_within_seconds` between them are one turn. A turn is as sure of its
    voice as its least sure segment. Returns [{ start, end, who, me, voice, score, unsure?, text }]."""
    turns = []
    for segment, answer in zip(segments, answers):
        entry = {"start": float(segment["start"]), "end": float(segment["end"]), "text": str(segment.get("text", "")).strip(),
                 "voice": answer["voice"], "who": answer["who"], "score": answer["score"], "unsure": answer["unsure"]}
        last = turns[-1] if turns else None
        if last and last["voice"] == entry["voice"] and entry["start"] - last["end"] <= join_within_seconds:
            last["end"] = entry["end"]
            last["text"] = f"{last['text']} {entry['text']}".strip()
            last["score"] = min(last["score"], entry["score"]) if last["score"] is not None and entry["score"] is not None else None
        else:
            turns.append(entry)
    return [{"start": t["start"], "end": t["end"], "who": speaker_label(t, words), "me": bool(t["who"] and t["who"]["me"]),
             "voice": t["voice"], "score": t["score"], **({"unsure": [p["name"] for p in t["unsure"]]} if t["unsure"] else {}),
             "text": t["text"]} for t in turns]


def name_faces(vectors, prints, rules=None):
    """For each face vector (or None), { who, score, unsure }: the same naming rule as voices over the face prints."""
    rules = {**FACE_RULES, **(rules or {})}
    out = []
    for vector in vectors:
        who, score, unsure = best_of(vector, prints, rules) if vector is not None else (None, None, [])
        out.append({"who": who, "score": round(score, 3) if score is not None else None, "unsure": unsure})
    return out


def heard_voice_as_sample(session, voice_id):
    """What enrolling an unknown voice heard in a listening takes: its numbers, and every label it was heard under."""
    voice = voice_of(session or {"unknown": []}, voice_id)
    if voice is None:
        raise Refused(f"No voice {voice_id} was heard in that listening.")
    return voice["mean"], [voice["id"], *voice.get("also", [])]
