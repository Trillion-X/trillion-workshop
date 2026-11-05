"""Pure readers for device rows whose evidence is caption quotes: check every quote against its video's captions, then lay the
checked rows out as Markdown tables by the person's own column templates.

Nothing here touches a file or the network. A settings object holds:
  family        the name of the set of rows (put in templates as {family})
  title, introduction
  channels      {video id: [channel, title]}
  groups        the order the groups are written in
  rows          [{group, name, seen: [[video id or null, words]], extra?, ...any field the templates name}]
  columns       [{head, parts: [{text, when?}]}]: a cell is its parts joined; a part with `when` is kept only when that field is set
  file_head     the lines a family file starts with
  index_marker  the line that marks a family's tables in an index file
  seen_quote    how one checked quote is written in {seen_text}
  seen_join     what joins the pieces of {seen_text}
  list_join     what joins a list field (such as also) inside a cell
  checked_fields the fields of each row kept in the checked-rows file, beside t
In a template, {field} is the row's field (or a computed one: family, creators, items, seen_text, and for seen_quote channel,
video, stamp, quote); {field|one|many} is `one` when that field is 1 and `many` otherwise.
"""
import re

TOKEN = re.compile(r"\{([a-z_]+)(?:\|([^|{}]*)\|([^|{}]*))?\}")
REQUIRED = ("family", "title", "introduction", "channels", "groups", "rows", "columns", "file_head", "index_marker",
            "seen_quote", "seen_join", "list_join", "checked_fields")


class SettingsError(ValueError):
    pass


def missing_settings(settings):
    """The keys a settings object lacks, in the order they are documented."""
    return [key for key in REQUIRED if key not in settings]


def fill(template, values, list_join="; "):
    """The template with each {field} and {field|one|many} replaced from values."""
    def one(match):
        name, single, plural = match.groups()
        if name not in values:
            raise SettingsError(f"the template {template!r} names {{{name}}}, which this row does not have")
        value = values[name]
        if single is not None:
            return single if value == 1 else plural
        if isinstance(value, list):
            return list_join.join(str(v) for v in value)
        return str(value)
    return TOKEN.sub(one, template)


def exact_segs_from_json3(document):
    """[[start second, text]] of a YouTube json3 caption file's events, with the start kept exact.

    A quote's second is the start of the event it begins in, cut down to the whole second; rounding the start first (as a
    display corpus does) would put a quote said at 2:58.96 at 2:59.
    """
    segs = []
    for event in document.get("events", []):
        if "segs" not in event:
            continue
        text = "".join(s.get("utf8", "") for s in event["segs"]).replace("\n", " ").strip()
        if text:
            segs.append([event.get("tStartMs", 0) / 1000, text])
    return segs


def stamp(second):
    """m:ss of a second count."""
    return f"{int(second // 60)}:{int(second % 60):02d}"


def check_rows(settings, second_of):
    """Each row with seen_text, creators, items and t ([[video, second, quote]]) added, and the quotes that failed.

    second_of(video, quote) gives the second the quote is said at, None when it is not in the captions, or "MISSING" when the
    video has no caption file. A row with no checked quote counts one creator and one item.
    """
    channels = settings["channels"]
    checked, bad = [], []
    for source in settings["rows"]:
        row = dict(source)
        parts, videos, names = [], set(), set()
        for video, words in row.get("seen", []):
            if video is None:
                parts.append(words)
                continue
            if video not in channels:
                raise SettingsError(f"row {row['name']!r} quotes video {video}, which `channels` does not name")
            second = second_of(video, words)
            if second is None or second == "MISSING":
                bad.append({"name": row["name"], "video": video, "quote": words,
                            "reason": "no caption file" if second == "MISSING" else "not in the captions"})
                continue
            videos.add(video)
            names.add(channels[video][0])
            parts.append(fill(settings["seen_quote"], {"channel": channels[video][0], "video": video,
                                                       "stamp": stamp(second), "quote": words}))
            row.setdefault("t", []).append([video, int(second), words])
        if row.get("extra"):
            parts.append(row["extra"])
        row["seen_text"] = settings["seen_join"].join(parts)
        row["creators"], row["items"] = (len(names), len(videos)) if videos else (1, 1)
        checked.append(row)
    return checked, bad


def cells(row, settings):
    """The row's cells, one per column."""
    values = dict(row, family=settings["family"])
    out = []
    for column in settings["columns"]:
        text = "".join(fill(part["text"], values, settings["list_join"]) for part in column["parts"]
                       if not part.get("when") or values.get(part["when"]))
        if "|" in text:
            raise SettingsError(f"a cell of row {row['name']!r} holds '|', which would break the table: {text[:60]}")
        out.append(text)
    return out


def table_head(settings):
    heads = [column["head"] for column in settings["columns"]]
    return "| " + " | ".join(heads) + " |\n|" + "---|" * len(heads)


def group_blocks(rows, settings):
    """The lines of every group's table, in the settings' group order."""
    lines = []
    for group in settings["groups"]:
        lines += [f"## {group}", "", table_head(settings)]
        lines += ["| " + " | ".join(cells(row, settings)) + " |" for row in rows if row["group"] == group]
        lines.append("")
    return lines


def family_text(rows, settings):
    """The family file: the head lines, then a table per group."""
    head = [fill(line, {"title": settings["title"], "introduction": settings["introduction"], "rows": len(rows),
                        "family": settings["family"]}) for line in settings["file_head"]]
    return "\n".join(head + group_blocks(rows, settings))


def index_with_family(index, rows, settings):
    """(the index text with the family's tables added under its marker, whether they were added); unchanged when the marker is there."""
    marker = fill(settings["index_marker"], {"family": settings["family"]})
    if marker in index:
        return index, False
    return index.rstrip("\n") + "\n\n" + "\n".join([marker, ""] + group_blocks(rows, settings)), True


def checked_records(rows, settings):
    """The checked-rows file's records: the settings' checked_fields and t of each row."""
    keep = list(settings["checked_fields"]) + ["t"]
    return [{key: row[key] for key in keep if key in row} for row in rows]
