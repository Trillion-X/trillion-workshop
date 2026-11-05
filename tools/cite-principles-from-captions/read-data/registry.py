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


PLACEHOLDER = re.compile(r"\{(ids|count|evidence):([^}]*)\}")
MARKER = re.compile(r"^<!-- cite-principles:(\S+)(.*?) -->\s*$")
END_MARKER = re.compile(r"^<!-- /cite-principles:(\S+) -->\s*$")
TABLE_RULE = re.compile(r"^\|(\s*:?-+:?\s*\|)+\s*$")
MARKER_ARG = re.compile(r'(\w[\w-]*)="([^"]*)"|(\d+)')


def principle_number(principle_id):
    found = re.search(r"\d+", principle_id or "")
    return int(found.group()) if found else 0


def short(text, most=150):
    text = (text or "").replace("|", "/")
    return text if len(text) <= most else text[:most].rsplit(" ", 1)[0] + " ..."


def stage_order(stage):
    found = re.match(r"\D*(\d+)", stage)
    return (0, int(found.group(1)), stage) if found else (1, 0, stage)


class TemplateError(ValueError):
    """A template the index cannot fill: the message names the line and what to write instead."""


def default_template(catalog_given):
    """The index a person gets without a template of their own: every section, with plain headings."""
    channels = ("| channel | videos read | catalog | principles stated | principles demonstrated |\n|---|---|---|---|---|" if catalog_given
                else "| channel | videos read | principles stated | principles demonstrated |\n|---|---|---|---|")
    silent = ("\n### Channels in the catalog with no videos read\n\n<!-- cite-principles:silent-channels -->\n"
              "<!-- /cite-principles:silent-channels -->\n" if catalog_given else "")
    return f"""# Principles registry: index

## Counts

- **{{count:principles}} principles**: {{count:stated}} stated, {{count:demonstrated}} demonstrated only, {{count:both}} both.
- **{{count:quotes}} verbatim quotes** and **{{count:demonstrations}} demonstrations**.
- {{count:merged}} principles merge statements from several rows; {{count:multi-channel}} have more than one independent channel.
- **{{count:contradiction-pairs}} contradiction pairs** between principles, plus {{count:one-sided}} one-sided disagreement notes inside rows.
- Corpus read: {{count:videos-read}} videos from {{count:channels-read}} channels.

## Top 30 principles by evidence strength

<!-- cite-principles:top 30 -->
| # | id | principle | channels | strength | sources (channel video@second, xmed) |
|---|---|---|---|---|---|
<!-- /cite-principles:top -->

## Demonstrated, not only stated

{{count:with-demonstrations}} principles carry demonstrations. Demonstration-only principles (top 15 by strength):

<!-- cite-principles:demonstrated 15 -->
<!-- /cite-principles:demonstrated -->

## Contradictions (flagged, not resolved)

<!-- cite-principles:contradictions -->
| a | b | how they disagree |
|---|---|---|
<!-- /cite-principles:contradictions -->

## Principles per stage

<!-- cite-principles:stages -->
| stage | principles |
|---|---|
<!-- /cite-principles:stages -->

## Counts per channel

<!-- cite-principles:channels -->
{channels}
<!-- /cite-principles:channels -->
{silent}
## Counts per lane

{{count:lanes}} distinct lanes; the 60 most used:

<!-- cite-principles:lanes 60 -->
<!-- /cite-principles:lanes -->
"""


class Index:
    """What an index says about one registry: its counts and the rows of each section a template can ask for.
    corpus_channels = {channel: videos read}; catalog = {channel: videos listed} or None; id_map = {working id: principle id}."""

    SECTIONS = ("top", "demonstrated", "contradictions", "stages", "channels", "silent-channels", "lanes")

    def __init__(self, principles, corpus_channels, catalog=None, id_map=None):
        self.principles, self.corpus_channels, self.catalog, self.id_map = principles, corpus_channels, catalog, id_map or {}
        self.by_id = {p["id"]: p for p in principles}
        kinds = Counter(p["kind"] for p in principles)
        self.stated, self.shown = Counter(), Counter()
        for p in principles:
            for channel in {s.get("channel") for s in p["sources"] if s.get("channel")}:
                self.stated[channel] += 1
            for channel in {d.get("channel") for d in p.get("demonstrated_in", []) if d.get("channel")}:
                self.shown[channel] += 1
        self.lanes = Counter(lane for p in principles for lane in p["lanes"])
        self.stages = Counter(stage for p in principles for stage in p.get("stages", []))
        pairs = OrderedDict()
        for p in principles:
            for item in p.get("contradicts", []):
                for other in item.get("with_ids", []):
                    a, b = sorted((p["id"], other), key=principle_number)
                    pairs.setdefault((a, b), item.get("how"))
        self.pairs = OrderedDict(sorted(pairs.items(), key=lambda kv: (principle_number(kv[0][0]), principle_number(kv[0][1]))))
        self.counts = {
            "principles": len(principles), "stated": kinds["stated"], "demonstrated": kinds["demonstrated"], "both": kinds["stated+demonstrated"],
            "with-demonstrations": kinds["demonstrated"] + kinds["stated+demonstrated"],
            "quotes": sum(p["evidence"]["quotes"] for p in principles),
            "demonstrations": sum(p["evidence"]["demonstrations"] for p in principles),
            "merged": sum(1 for p in principles if p.get("merged_from")),
            "multi-channel": sum(1 for p in principles if p["evidence"]["independent_channels"] > 1),
            "contradiction-pairs": len(self.pairs),
            "one-sided": sum(1 for p in principles for item in p.get("contradicts", []) if not item.get("with_ids")),
            "videos-read": sum(corpus_channels.values()), "channels-read": len(corpus_channels), "lanes": len(self.lanes),
        }

    def value(self, kind, name, where):
        """The text one {ids:...}, {count:...} or {evidence:...} stands for."""
        if kind == "ids":
            working = [w.strip() for w in name.split(",") if w.strip()]
            return ", ".join(sorted({self.id_map.get(w, w) for w in working}, key=principle_number))
        if kind == "count":
            if name not in self.counts:
                raise TemplateError(f"{where}: {{count:{name}}} is no count; use one of {', '.join(sorted(self.counts))}.")
            return str(self.counts[name])
        working, _, field = name.partition(".")
        principle = self.by_id.get(self.id_map.get(working, working))
        if principle is None or field not in principle["evidence"]:
            fields = ", ".join(sorted(self.principles[0]["evidence"])) if self.principles else "quotes"
            raise TemplateError(f"{where}: {{evidence:{name}}} names no principle's evidence; write "
                                f"{{evidence:<working or principle id>.<one of {fields}>}}.")
        return str(principle["evidence"][field])

    def fill(self, text, where):
        return PLACEHOLDER.sub(lambda m: self.value(m.group(1), m.group(2), where), text)

    def rows(self, name, most, options):
        """The generated lines of one section; the template keeps its own heading and table header around them."""
        if name == "top":
            out = []
            for n, p in enumerate(self.principles[:most or 30], 1):
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
                out.append(f"| {n} | {p['id']} | {short(p['principle'])} | {p['evidence']['independent_channels']} | {p['evidence']['strength']} | "
                           + "; ".join(cited[:5]) + (f"; +{more} more" if more > 0 else "") + " |")
            return out
        if name == "demonstrated":
            out = []
            for p in [p for p in self.principles if p["kind"] == "demonstrated"][:most or 15]:
                d = (p.get("demonstrated_in") or [{}])[0]
                out.append(f"- {p['id']} {short(p['principle'], 120)} ({', '.join(p['channels'][:4])}; e.g. {d.get('video', '')}@{d.get('t', '')})")
            return out
        if name == "contradictions":
            return [f"| {a} {short(self.by_id[a]['principle'], 70) if a in self.by_id else ''} | {b} {short(self.by_id[b]['principle'], 70) if b in self.by_id else ''} | {short(how or '', 160)} |"
                    for (a, b), how in self.pairs.items()]
        if name == "stages":
            return [f"| {stage} | {n} |" for stage, n in sorted(self.stages.items(), key=lambda kv: stage_order(kv[0]))]
        if name == "channels":
            missing = options.get("missing", "n.a.")
            out = []
            for channel in sorted(set(self.corpus_channels) | set(self.stated) | set(self.shown),
                                  key=lambda ch: (-(self.stated[ch] + self.shown[ch]), ch.lower())):
                listed = "" if self.catalog is None else f" {self.catalog.get(channel, missing)} |"
                out.append(f"| {channel} | {self.corpus_channels.get(channel, 0)} |{listed} {self.stated[channel]} | {self.shown[channel]} |")
            return out
        if name == "silent-channels":
            unread = [(ch, n) for ch, n in Counter(self.catalog or {}).most_common() if ch and not self.corpus_channels.get(ch)]
            return [(", ".join(f"{ch} ({n} videos)" for ch, n in unread) or "None") + "."]
        return [", ".join(f"{lane} {n}" for lane, n in self.lanes.most_common(most or 60)) + "."]


def index_markdown(principles, corpus_channels, catalog=None, template=None, id_map=None):
    """A Markdown index of a registry, written into the person's template (default_template when they have none).

    Outside the sections, {ids:A-1,B-2} becomes the principle ids those working ids went into (lowest first), {count:NAME} one of the
    registry's counts and {evidence:ID.FIELD} one principle's evidence (ID a working or principle id). A section is the lines from
    <!-- cite-principles:NAME [N] [missing="..."] --> to <!-- /cite-principles:NAME -->; its table header (the lines up to its |---| rule)
    is kept as the person wrote it and every line after is written anew, so the result is a template again. NAME is one of
    Index.SECTIONS; N is how many rows top, demonstrated and lanes show."""
    index = Index(principles, corpus_channels, catalog, id_map)
    lines = (default_template(catalog is not None) if template is None else template).split("\n")
    out, n = [], 0
    while n < len(lines):
        line = lines[n]
        start = MARKER.match(line)
        if not start:
            if END_MARKER.match(line):
                raise TemplateError(f"template line {n + 1}: {line.strip()} closes a section that was not opened.")
            out.append(index.fill(line, f"template line {n + 1}"))
            n += 1
            continue
        name, args = start.group(1), start.group(2)
        if name not in Index.SECTIONS:
            raise TemplateError(f"template line {n + 1}: cite-principles:{name} is no section; use one of {', '.join(Index.SECTIONS)}.")
        most, options = None, {}
        for key, value, number in MARKER_ARG.findall(args):
            if number:
                most = int(number)
            else:
                options[key] = value
        end = next((k for k in range(n + 1, len(lines)) if END_MARKER.match(lines[k])), None)
        if end is None or END_MARKER.match(lines[end]).group(1) != name:
            raise TemplateError(f"template line {n + 1}: cite-principles:{name} needs its closing line <!-- /cite-principles:{name} --> before the next section.")
        body = lines[n + 1:end]
        rule = next((k for k, text in enumerate(body) if TABLE_RULE.match(text)), None)
        header = body[:rule + 1] if rule is not None else []
        out.append(line)
        out += [index.fill(text, f"template line {n + 2 + k}") for k, text in enumerate(header)]
        out += index.rows(name, most, options)
        out.append(lines[end])
        n = end + 1
    return "\n".join(out)
