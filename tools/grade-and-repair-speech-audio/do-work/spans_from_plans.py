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
    wt = os.path.join(WORDTIMES, f"{clip}.json")
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
