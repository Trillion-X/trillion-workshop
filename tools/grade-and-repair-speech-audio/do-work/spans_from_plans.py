"""Write the spans file the grade reads from a folder of edit plans: every plan segment that is a cut of a recording.

  spans_from_plans.py --plans DIR [--plan name ...] --transcripts DIR [--wordtimes DIR] --out spans.json

A plan is a JSON file with a `segments` list; a segment with a `clip` is a cut {clip, from, to, text} of that recording
(a segment without one, a generated voice line, is not graded). The recording's media file is the plan's
`sources[clip]`, else the `source` of the clip's word file `<transcripts>/<clip>.words.json`. Its word times, in source
seconds, are `<wordtimes>/<clip>.json` (a whisper result: `segments[].words[]` of `word`, `start`, `end`) when there is
one, else the word file's `words`. The spans file lists every cut once per plan, with the words inside the cut, and
`groups` names each plan's span ids, so grade_and_repair_speech.py also writes one grades file per plan
(`groups/<plan>.json`). The plans, the word files and the recordings are only read.
"""
import argparse
import glob
import json
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(os.path.dirname(HERE), "read-data"))

import spans as spans_file  # noqa: E402

PLANS = TRANSCRIPTS = WORDTIMES = None  # the folders the person names (main sets them)


def plan_paths(selected=()):
    paths = sorted(glob.glob(os.path.join(PLANS, "*.json")))
    return [p for p in paths if not selected or os.path.basename(p)[:-5] in selected]


def load_plan(path):
    plan = json.load(open(path))
    spans = [s for s in plan["segments"] if s.get("clip")]
    return plan, spans


def source_for(clip, plan):
    if clip in plan.get("sources", {}):
        return plan["sources"][clip]
    return json.load(open(os.path.join(TRANSCRIPTS, f"{clip}.words.json")))["source"]


def clip_words(clip):
    """Word list [{text,start,end}] in source-file seconds, or None when the clip has no word times."""
    wt = os.path.join(WORDTIMES, f"{clip}.json") if WORDTIMES else ""
    if os.path.exists(wt):
        out = []
        for seg in json.load(open(wt))["segments"]:
            for w in seg.get("words", []):
                out.append({"text": w["word"].strip(), "start": w["start"], "end": w["end"]})
        return out
    tp = os.path.join(TRANSCRIPTS, f"{clip}.words.json")
    if os.path.exists(tp):
        return json.load(open(tp))["words"]
    return None


def spans_of_plans(selected=()):
    """{"spans": [...], "groups": {plan: [span id, ...]}}: every cut of every chosen plan, with its source and words."""
    spans, groups, cache = [], {}, {}
    for path in plan_paths(selected):
        plan, cuts = load_plan(path)
        slug = os.path.basename(path)[:-5]
        groups[slug] = []
        for s in cuts:
            if s["clip"] not in cache:
                cache[s["clip"]] = clip_words(s["clip"])
            inside = [w for w in cache[s["clip"]] or [] if w["start"] >= s["from"] - 0.02 and w["end"] <= s["to"] + 0.05]
            span = {"clip": s["clip"], "source": source_for(s["clip"], plan), "from": s["from"], "to": s["to"], "text": s["text"]}
            if inside:
                span["words"] = [{"text": w["text"], "start": w["start"], "end": w["end"]} for w in inside]
            spans.append(span)
            groups[slug].append(spans_file.span_id(s))
    return {"spans": spans, "groups": groups}


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--plans", required=True, help="the folder of plan JSON files")
    ap.add_argument("--plan", action="append", default=[], help="a plan's file name without .json (default: every plan)")
    ap.add_argument("--transcripts", required=True, help="the folder of <clip>.words.json word files ({source, words})")
    ap.add_argument("--wordtimes", help="a folder of <clip>.json whisper results, read first when a clip has one")
    ap.add_argument("--out", required=True, help="the spans file to write")
    a = ap.parse_args()
    PLANS, TRANSCRIPTS, WORDTIMES = a.plans, a.transcripts, a.wordtimes
    result = spans_of_plans(a.plan)
    json.dump(result, open(a.out, "w"), indent=1)
    print(json.dumps({"result": {"spans": a.out, "count": len(result["spans"]), "plans": len(result["groups"])}}))
