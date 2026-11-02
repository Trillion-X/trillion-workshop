"""Pure: merge a person's working rows of principles into one ranked registry, each principle backed by quotes and demonstrations.

A working row: {"id", "principle", "kind": "stated"|"demonstrated"|"stated+demonstrated", "lanes", "sources": [{"video", "t", "quote", ...}],
"demonstrated_in": [{"video", "t", "how"}], "test", "do_it", "transfer", "paraphrase"?, "contradicts"?: [{"id_or_text", "how"}]}.
corpus = {video id: video}. Nothing here reads a file; the person's own grouping and stage names come in as arguments.
"""
import re
from collections import Counter, OrderedDict

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


ID_REF = re.compile(r"\{ids:([^}]*)\}")


def principle_number(principle_id):
    found = re.search(r"\d+", principle_id or "")
    return int(found.group()) if found else 0


def short(text, most=150):
    text = (text or "").replace("|", "/")
    return text if len(text) <= most else text[:most].rsplit(" ", 1)[0] + " ..."


def fill_id_refs(text, id_map):
    """The person's own prose with every {ids:A-1,B-2} replaced by the principle ids those working ids became, lowest first."""
    def one(match):
        working = [w.strip() for w in match.group(1).split(",") if w.strip()]
        return ", ".join(sorted({id_map.get(w, w) for w in working}, key=principle_number))
    return ID_REF.sub(one, text)


def stage_order(stage):
    found = re.match(r"\D*(\d+)", stage)
    return (0, int(found.group(1)), stage) if found else (1, 0, stage)


def index_markdown(principles, corpus_channels, catalog=None, title="Principles registry: index", intro="", outro="",
                   top=30, demonstrated_top=15, lanes_top=60):
    """A Markdown index of a registry: counts, the strongest principles with their sources, demonstration-only ones, contradiction pairs,
    principles per stage, per channel (videos read, videos in the person's catalog, principles stated and demonstrated), channels in the
    catalog with nothing read, and lanes. corpus_channels = {channel: videos read}; catalog = {channel: videos listed} or None.
    intro and outro are the person's own Markdown, put in as they are."""
    by_id = {p["id"]: p for p in principles}
    kinds = Counter(p["kind"] for p in principles)
    quotes = sum(p["evidence"]["quotes"] for p in principles)
    demos = sum(p["evidence"]["demonstrations"] for p in principles)
    merged = sum(1 for p in principles if p.get("merged_from"))
    multi = sum(1 for p in principles if p["evidence"]["independent_channels"] > 1)
    stated, shown = Counter(), Counter()
    for p in principles:
        for channel in {s.get("channel") for s in p["sources"] if s.get("channel")}:
            stated[channel] += 1
        for channel in {d.get("channel") for d in p.get("demonstrated_in", []) if d.get("channel")}:
            shown[channel] += 1
    lanes = Counter(lane for p in principles for lane in p["lanes"])
    stages = Counter(stage for p in principles for stage in p.get("stages", []))
    pairs = OrderedDict()
    for p in principles:
        for item in p.get("contradicts", []):
            for other in item.get("with_ids", []):
                a, b = sorted((p["id"], other), key=principle_number)
                pairs.setdefault((a, b), item.get("how"))
    pairs = OrderedDict(sorted(pairs.items(), key=lambda kv: (principle_number(kv[0][0]), principle_number(kv[0][1]))))
    one_sided = sum(1 for p in principles for item in p.get("contradicts", []) if not item.get("with_ids"))
    lines = [f"# {title}", ""]
    if intro.strip():
        lines += [intro.strip(), ""]
    lines += ["## Counts", "",
              f"- **{len(principles)} principles**: {kinds['stated']} stated, {kinds['demonstrated']} demonstrated only, {kinds['stated+demonstrated']} both.",
              f"- **{quotes} verbatim quotes** and **{demos} demonstrations**.",
              f"- {merged} principles merge statements from several rows; {multi} have more than one independent channel.",
              f"- **{len(pairs)} contradiction pairs** between principles, plus {one_sided} one-sided disagreement notes inside rows.",
              f"- Corpus read: {sum(corpus_channels.values())} videos from {len(corpus_channels)} channels.", "",
              f"## Top {top} principles by evidence strength", "",
              "| # | id | principle | channels | strength | sources (channel video@second, xmed) |", "|---|---|---|---|---|---|"]
    for n, p in enumerate(principles[:top], 1):
        seen, cited = set(), []
        for s in p["sources"]:
            if s.get("channel") in seen:
                continue
            seen.add(s.get("channel"))
            cited.append(f"{s.get('channel')} [{s['video']}@{s.get('t')}]({s.get('url')}) {s.get('xmed', '?')}x")
        for d in p.get("demonstrated_in", []):
            if d.get("channel") in seen or not d.get("video"):
                continue
            seen.add(d.get("channel"))
            cited.append(f"{d.get('channel')} demo [{d['video']}@{d.get('t')}]({d.get('url')}) {d.get('xmed', '?')}x")
        more = len(seen) - 5
        lines.append(f"| {n} | {p['id']} | {short(p['principle'])} | {p['evidence']['independent_channels']} | {p['evidence']['strength']} | "
                     + "; ".join(cited[:5]) + (f"; +{more} more" if more > 0 else "") + " |")
    lines += ["", "## Demonstrated, not only stated", "",
              f"{kinds['demonstrated'] + kinds['stated+demonstrated']} principles carry demonstrations. Demonstration-only principles (top {demonstrated_top} by strength):", ""]
    for p in [p for p in principles if p["kind"] == "demonstrated"][:demonstrated_top]:
        d = (p.get("demonstrated_in") or [{}])[0]
        lines.append(f"- {p['id']} {short(p['principle'], 120)} ({', '.join(p['channels'][:4])}; e.g. {d.get('video', '')}@{d.get('t', '')})")
    lines += ["", "## Contradictions (flagged, not resolved)", "", "| a | b | how they disagree |", "|---|---|---|"]
    for (a, b), how in pairs.items():
        lines.append(f"| {a} {short(by_id[a]['principle'], 70) if a in by_id else ''} | {b} {short(by_id[b]['principle'], 70) if b in by_id else ''} | {short(how or '', 160)} |")
    if stages:
        lines += ["", "## Principles per stage", "", "| stage | principles |", "|---|---|"]
        lines += [f"| {stage} | {n} |" for stage, n in sorted(stages.items(), key=lambda kv: stage_order(kv[0]))]
    lines += ["", "## Counts per channel", ""]
    if catalog is None:
        lines += ["| channel | videos read | principles stated | principles demonstrated |", "|---|---|---|---|"]
    else:
        lines += ["| channel | videos read | catalog | principles stated | principles demonstrated |", "|---|---|---|---|---|"]
    for channel in sorted(set(corpus_channels) | set(stated) | set(shown), key=lambda ch: (-(stated[ch] + shown[ch]), ch.lower())):
        listed = "" if catalog is None else f" {catalog.get(channel, 'n.a.')} |"
        lines.append(f"| {channel} | {corpus_channels.get(channel, 0)} |{listed} {stated[channel]} | {shown[channel]} |")
    if catalog is not None:
        unread = [(ch, n) for ch, n in Counter(catalog).most_common() if ch and not corpus_channels.get(ch)]
        lines += ["", "### Channels in the catalog with no videos read", "",
                  (", ".join(f"{ch} ({n} videos)" for ch, n in unread) or "None") + "."]
    lines += ["", "## Counts per lane", "", f"{len(lanes)} distinct lanes; the {lanes_top} most used:", "",
              ", ".join(f"{lane} {n}" for lane, n in lanes.most_common(lanes_top)) + "."]
    if outro.strip():
        lines += ["", outro.strip()]
    return "\n".join(lines) + "\n"
