"""Pure: merge a person's working rows of principles into one ranked registry, each principle backed by quotes and demonstrations.

A working row: {"id", "principle", "kind": "stated"|"demonstrated"|"stated+demonstrated", "lanes", "sources": [{"video", "t", "quote", ...}],
"demonstrated_in": [{"video", "t", "how"}], "test", "do_it", "transfer", "paraphrase"?, "contradicts"?: [{"id_or_text", "how"}]}.
corpus = {video id: video}. Nothing here reads a file; the person's own grouping and stage names come in as arguments.
"""
import re
from collections import OrderedDict

import captions

TOKEN = re.compile(r"\w+(?:-\w+)*")


def lane_stage_map(stages):
    """{lane: stage} from {stage: [lanes]}."""
    return {lane: stage for stage, lanes in (stages or {}).items() for lane in lanes}


def fix_source(source, corpus, url_template):
    """A quote's source with the channel, title, views and how it did taken from the corpus, and a link to the second."""
    video = corpus.get(source["video"])
    out = dict(channel=source.get("channel"), video=source["video"], t=source.get("t"), quote=source.get("quote"),
               title=source.get("title"), views=source.get("views"), xmed=source.get("xmed"))
    if video:
        out.update(channel=video["channel"], title=video["title"], views=video["views"], xmed=video["xmed"],
                   kind=video["kind"], median=video["median"])
    out["url"] = url_template.format(video=source["video"], t=int(source.get("t") or 0))
    return {k: v for k, v in out.items() if v is not None}


def fix_demonstration(demo, corpus, url_template):
    video = corpus.get(demo.get("video"))
    out = dict(channel=demo.get("channel"), video=demo.get("video"), t=demo.get("t"), how=demo.get("how"))
    if video:
        out.update(channel=video["channel"], title=video["title"], views=video["views"], xmed=video["xmed"])
    if demo.get("video"):
        out["url"] = url_template.format(video=demo["video"], t=int(demo.get("t") or 0))
    return {k: v for k, v in out.items() if v is not None}


def merge_group(members, corpus, lane_names, lane_stage, url_template, text=None):
    """One principle from the working rows that say it: sources and demonstrations without repeats, lanes in first-seen order, evidence strength."""
    first = members[0]
    sources, seen, source_weights = [], set(), []
    for member in members:
        for source in member.get("sources", []):
            key = (source["video"], (source.get("quote") or "").lower())
            if key in seen:
                continue
            seen.add(key)
            sources.append(fix_source(source, corpus, url_template))
            # a demonstrated-only statement's quotes are the demonstration itself, so they weigh half
            source_weights.append(0.5 if member["kind"] == "demonstrated" else 1.0)
    demonstrations, seen_demos = [], set()
    for member in members:
        for demo in member.get("demonstrated_in", []) or []:
            key = (demo.get("video"), demo.get("t"))
            if key in seen_demos:
                continue
            seen_demos.add(key)
            demonstrations.append(fix_demonstration(demo, corpus, url_template))
    lanes = []
    for member in members:
        for lane in member["lanes"]:
            lane = lane_names.get(lane, lane)
            if lane not in lanes:
                lanes.append(lane)
    kinds = set()
    for member in members:
        kinds.update(member["kind"].split("+"))
    kind = "+".join(k for k in ("stated", "demonstrated") if k in kinds)
    evidence = [(s.get("channel"), s.get("xmed"), w) for s, w in zip(sources, source_weights)] + [(d.get("channel"), d.get("xmed"), 0.5) for d in demonstrations]
    strength, best = captions.evidence_strength(evidence)
    videos = {e.get("video") for e in sources + demonstrations if e.get("video")}
    paraphrases = [mem["paraphrase"] for mem in members if mem.get("paraphrase")]
    row = OrderedDict(
        principle=text or first["principle"], kind=kind, lanes=lanes,
        stages=sorted({lane_stage[lane] for lane in lanes if lane in lane_stage}),
        channels=sorted(best),
        evidence=dict(independent_channels=len(best), videos=len(videos), quotes=len(sources), demonstrations=len(demonstrations), strength=strength),
        sources=sources)
    if paraphrases:
        row["paraphrase"] = " | ".join("PARAPHRASE: " + p if not p.lower().startswith("paraphrase") else p for p in paraphrases)
    row["demonstrated_in"] = demonstrations
    row["test"], row["do_it"], row["transfer"] = first["test"], first["do_it"], first["transfer"]
    row["_ids"] = [mem["id"] for mem in members]
    row["_contra"] = [(mem["id"], c) for mem in members for c in (mem.get("contradicts") or [])]
    if len(members) > 1:
        row["merged_from"] = [dict(staging_id=mem["id"], principle=mem["principle"], test=mem["test"], do_it=mem["do_it"], transfer=mem["transfer"]) for mem in members]
    return row


def build_registry(rows, corpus, stages=None, lane_names=None, groups=None, contradictions=None, recorded_by="merge file",
                   url_template="https://youtu.be/{video}?t={t}"):
    """(principles, {working id: principle id}).

    groups = [{"ids": [working ids to merge], "text"?: wording of the merged principle}]; a row in no group stands alone.
    contradictions = [[working id, working id, how]]: added both ways, recorded_by naming where they came from.
    Principles are ranked by evidence strength, then quotes, and numbered P-001...
    """
    by_id = OrderedDict((row["id"], row) for row in rows)
    lane_stage = lane_stage_map(stages)
    lane_names = lane_names or {}
    all_groups = list(groups or [])
    grouped = {i for g in all_groups for i in g["ids"]}
    all_groups += [dict(ids=[i]) for i in by_id if i not in grouped]
    built = [merge_group([by_id[i] for i in g["ids"]], corpus, lane_names, lane_stage, url_template, g.get("text")) for g in all_groups]
    built.sort(key=lambda r: (-r["evidence"]["strength"], -r["evidence"]["quotes"]))
    id_map = {}
    for n, row in enumerate(built, 1):
        row["id"] = f"P-{n:03d}"
        for i in row["_ids"]:
            id_map[i] = row["id"]
    by_final = {row["id"]: row for row in built}
    for row in built:
        found, seen = [], set()
        for staging_id, item in row["_contra"]:
            text = item.get("id_or_text", "")
            targets = [id_map[t] for t in TOKEN.findall(text) if t in id_map and id_map[t] != row["id"]]
            key = (tuple(targets), item.get("how"))
            if key in seen:
                continue
            seen.add(key)
            found.append(dict(with_ids=targets, with_text=None if targets else text, how=item.get("how"), recorded_by="batch " + staging_id.split("-")[0]))
        row["contradicts"] = found
    for a, b, how in contradictions or []:
        first, second = id_map[a], id_map[b]
        for x, y in ((first, second), (second, first)):
            if not any(y in c["with_ids"] for c in by_final[x]["contradicts"]):
                by_final[x]["contradicts"].append(dict(with_ids=[y], with_text=None, how=how, recorded_by=recorded_by))
    final = []
    for row in built:
        for c in row["contradicts"]:
            if c["with_text"] is None:
                del c["with_text"]
        row["staging_ids"] = row.pop("_ids")
        row.pop("_contra")
        out = OrderedDict([("id", row["id"])])
        out.update((k, v) for k, v in row.items() if k != "id")
        final.append(out)
    return final, id_map
