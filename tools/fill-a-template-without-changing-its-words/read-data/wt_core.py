"""word-template core: registry, errors, words, sources and readers.

Everything about WHAT can be measured lives in dimensions.json (dimensions, value kinds, media, readers,
slot rules, tokenizer settings). This module holds only the generic machinery: it never names a dimension,
a medium or a slot type. Readers are the one place that knows a file format; a reader turns a file into
records {id, t0?, t1?, unit?, region?, is_unit?, fields{}} and nothing else.
"""
import copy
import json
import math
import os
import re
import shutil
import statistics
import subprocess
import unicodedata
from pathlib import Path
from html.parser import HTMLParser

HERE = Path(__file__).resolve().parent
DEFAULT_REGISTRY = HERE / "dimensions.json"
SCHEMA = "word-template@1"
SLOT_MARK = "⟨slot⟩"     # how an empty slot looks after normalising
EMPTY_SLOT_WORD = r"[^\w\s\[\]]*\[[^\[\]]+:\s*no source yet\][^\w\s\[\]]*"
BREAK = "↵"                   # a line break inside a text value


class WTError(Exception):
    """An error a person can act on: what is wrong, and how to fix it."""

    def __init__(self, what, fix):
        super().__init__(f"{what}\n  fix: {fix}")
        self.what, self.fix = what, fix


# ---------------------------------------------------------------- files

def load_json(path, role="file"):
    p = Path(os.path.expanduser(str(path)))
    if not p.exists():
        raise WTError(f"{role} not found: {p}", f"check the path, or rebuild the {role} (make_template.py writes templates)")
    try:
        return json.loads(p.read_text(encoding="utf-8"))
    except json.JSONDecodeError as e:
        raise WTError(f"{role} is not valid JSON: {p} (line {e.lineno}, column {e.colno}: {e.msg})",
                      "fix the JSON at that position, or regenerate the file")


def write_json(path, data):
    p = Path(path)
    p.parent.mkdir(parents=True, exist_ok=True)
    tmp = p.with_suffix(p.suffix + ".tmp")
    tmp.write_text(json.dumps(data, ensure_ascii=False, indent=1) + "\n", encoding="utf-8")
    tmp.replace(p)


def expand(path, root=None):
    p = Path(os.path.expanduser(str(path)))
    if not p.is_absolute() and root:
        p = Path(os.path.expanduser(str(root))) / p
    return p


def stamp(path):
    """Change stamp of a source file (size + mtime). Used to rebuild only what changed."""
    p = Path(path)
    if not p.exists():
        return {"path": str(p), "missing": True}
    if p.is_dir():
        files = sorted(x for x in p.iterdir() if x.is_file())
        return {"path": str(p), "files": len(files), "size": sum(f.stat().st_size for f in files),
                "mtime_ns": max([f.stat().st_mtime_ns for f in files] or [0])}
    st = p.stat()
    return {"path": str(p), "size": st.st_size, "mtime_ns": st.st_mtime_ns}


# ---------------------------------------------------------------- registry

class Registry:
    def __init__(self, data, path=None):
        self.data, self.path = data, str(path) if path else None
        self.dims = {}
        for row in data.get("dimensions", []):
            if "id" not in row:
                raise WTError(f"a dimension row has no id: {json.dumps(row)[:120]}", "give every dimensions[] row an 'id'")
            if row["id"] in self.dims:
                raise WTError(f"dimension id used twice: {row['id']}", "rename one of the two rows")
            self.dims[row["id"]] = row
        self.kinds = {k: v for k, v in data.get("value_kinds", {}).items() if not k.startswith("_")}
        self.media = {k: v for k, v in data.get("media", {}).items() if not k.startswith("_")}
        self.readers = {k: v for k, v in data.get("readers", {}).items() if not k.startswith("_")}
        self.slot_rules = data.get("slot_rules", {})
        self.tokenizer = data.get("tokenizer", {})
        self.moment_spans = data.get("moment_spans", {})

    @classmethod
    def load(cls, path=None):
        p = expand(path) if path else DEFAULT_REGISTRY
        return cls(load_json(p, "registry"), p)

    def dim(self, dim_id):
        return self.dims.get(dim_id)

    def kind_of(self, dim_id):
        row = self.dims.get(dim_id)
        if not row:
            return None
        return self.kinds.get(row.get("value_kind"))

    def applies(self, row, medium):
        media = row.get("media", ["*"])
        return "*" in media or medium in media

    def is_text(self, dim_id):
        k = self.kind_of(dim_id)
        return bool(k and k.get("split"))


# ---------------------------------------------------------------- words

_PUNCT_EDGE = None


def _no_space_char(ch, scripts):
    try:
        name = unicodedata.name(ch)
    except ValueError:
        return False
    return any(name.startswith(s) for s in scripts)


def split_words(text, registry=None):
    """Split text into word tokens. Bracket groups ('[NUMBER: no source yet],') stay one token; a line
    break becomes BREAK; characters of scripts written without spaces (registry tokenizer.per_char_scripts)
    become one token each."""
    scripts = tuple((registry.tokenizer if registry else {}).get("per_char_scripts", []))
    out = []
    for i, line in enumerate(str(text).split("\n")):
        if i:
            out.append(BREAK)
        for m in re.finditer(EMPTY_SLOT_WORD + r"|\[[^\[\]]*\]\S*|\S+", line):
            w = m.group(0)
            if scripts and not w.startswith("[") and any(_no_space_char(c, scripts) for c in w):
                buf = ""
                for c in w:
                    if _no_space_char(c, scripts):
                        if buf:
                            out.append(buf)
                            buf = ""
                        out.append(c)
                    else:
                        buf += c
                if buf:
                    out.append(buf)
            else:
                out.append(w)
    return out


def norm(word):
    """Normalise one word for comparison: case-folded, NFKC, edge punctuation (any Unicode P*/S* except
    # @ $ %) removed, thousands separators dropped. Bracket groups become SLOT_MARK."""
    if word == BREAK:
        return BREAK
    if word.startswith("[") or re.fullmatch(EMPTY_SLOT_WORD, word):
        return SLOT_MARK
    w = unicodedata.normalize("NFKC", word).casefold()
    w = w.replace("’", "'").replace("‘", "'")
    w = re.sub(r"(?<=\d)[,.](?=\d{3}\b)", "", w)
    keep = set("#@$%")

    def edge(c):
        return unicodedata.category(c)[0] in "PS" and c not in keep

    while w and edge(w[0]):
        w = w[1:]
    while w and edge(w[-1]) and w[-1] != "%":
        w = w[:-1]
    return w


def norm_value(v):
    if isinstance(v, str):
        return " ".join(norm(w) for w in split_words(v) if norm(w))
    return v


# ---------------------------------------------------------------- sources

def check_source(src, root=None):
    """A slot value's source must be one of: a URL; git:<repo>@<commit>; a file path with a line
    (path:12 or path#L12), a timestamp (path@12.5s or path@0:12) or a time range (path@12.5-18.2s, a span of a
    recording or of its word-timed transcript). Returns {ok, kind, why}."""
    s = str(src or "").strip()
    if not s:
        return {"ok": False, "kind": None, "why": "no source given"}
    if re.match(r"^https?://\S+$", s):
        return {"ok": True, "kind": "url", "why": ""}
    m = re.match(r"^git:(.+)@([0-9a-fA-F]{7,40})$", s)
    if m:
        repo = expand(m.group(1), root)
        if not (repo / ".git").exists() and not repo.name.endswith(".git"):
            return {"ok": False, "kind": "commit", "why": f"not a git repository: {repo}"}
        r = subprocess.run(["git", "-C", str(repo), "cat-file", "-e", m.group(2) + "^{commit}"],
                           capture_output=True, text=True)
        return {"ok": r.returncode == 0, "kind": "commit",
                "why": "" if r.returncode == 0 else f"commit {m.group(2)} not found in {repo}"}
    if re.match(r"^[0-9a-fA-F]{7,40}$", s):
        return {"ok": False, "kind": "commit", "why": "a bare commit cannot be checked; write git:<repo path>@<commit>"}
    m = re.match(r"^(.*?)(?::(\d+)(?:-\d+)?|#L(\d+)(?:-L?\d+)?|@(\d+(?:\.\d+)?-\d+(?:\.\d+)?s|\d+(?:\.\d+)?s|\d+:\d{2}(?::\d{2})?(?:\.\d+)?))$", s)
    if not m:
        p = expand(s, root)
        if p.exists():
            return {"ok": False, "kind": "file", "why": f"file source needs a line (:12) or a timestamp (@12.5s): {s}"}
        return {"ok": False, "kind": None, "why": f"not a URL, git:<repo>@<commit>, or path:line/@time: {s}"}
    p = expand(m.group(1), root)
    if not p.exists():
        return {"ok": False, "kind": "file", "why": f"source file no longer exists: {p}"}
    line = m.group(2) or m.group(3)
    if line and p.is_file():
        try:
            with open(p, "rb") as f:
                n = sum(1 for _ in f)
        except OSError as e:
            return {"ok": False, "kind": "file", "why": f"cannot read {p}: {e}"}
        if int(line) > max(n, 1):
            return {"ok": False, "kind": "file", "why": f"{p} has {n} lines; line {line} does not exist"}
    span = _time_range(s)
    if span and span[1][0] >= span[1][1]:
        return {"ok": False, "kind": "file", "why": f"a time range must end after it starts: {s}"}
    return {"ok": True, "kind": "file", "why": ""}


def _time_range(src):
    """(path text, (from, to)) of a path@<from>-<to>s source, else None."""
    m = re.match(r"^(.*?)@(\d+(?:\.\d+)?)-(\d+(?:\.\d+)?)s$", str(src or "").strip())
    return (m.group(1), (float(m.group(2)), float(m.group(3)))) if m else None


SPAN_TOLERANCE_S = 1e-6   # word times are cited as written; this only absorbs float rounding


def _timed_words(src, root=None):
    """(transcript, words) of a time-range source on a word-timed transcript (read by the transcript_words reader:
    every word whose whole interval lies inside the range), else None (the range is into media, not words)."""
    rng = _time_range(src)
    if not rng:
        return None
    p = expand(rng[0], root)
    try:
        d = load_json(p, "transcript") if p.suffix == ".json" else None
    except WTError:
        return None
    if not isinstance(d, dict) or not isinstance(d.get("words"), list):
        return None
    a, b = rng[1]
    words = [r for r in READERS["transcript_words"](p, {}) if r.get("one_word") and r["t0"] is not None and r["t1"] is not None
             and r["t0"] >= a - SPAN_TOLERANCE_S and r["t1"] <= b + SPAN_TOLERANCE_S]
    return d, words


def source_span(src, registry, root=None):
    """Where a moment source plays, {source, clip, from, to, media}, or None when the source is not a moment. A
    moment is a time range of a word-timed transcript (its media file names the clip), a time range of a recording
    itself (the file names the clip), or one cited row of a TSV whose header holds the registry's
    moment_spans.tsv_columns. Column and key names are registry DATA, not code."""
    spans = registry.moment_spans if registry else {}
    timed = _timed_words(src, root)
    if timed is not None:
        d, _ = timed
        rng = _time_range(src)
        media = d.get(spans.get("transcript_media_key", "source"))
        clip = Path(str(media)).stem if media else expand(rng[0], root).name.split(".")[0]
        return {"source": src, "clip": clip, "from": rng[1][0], "to": rng[1][1], "media": media}
    rng = _time_range(src)
    if rng:
        p = expand(rng[0], root)
        return {"source": src, "clip": p.stem, "from": rng[1][0], "to": rng[1][1], "media": str(p)}
    cols = spans.get("tsv_columns") or {}
    m = re.match(r"^(.*?):(\d+)$", str(src or "").strip())
    if not m or not cols:
        return None
    p = expand(m.group(1), root)
    if p.suffix != ".tsv" or not p.is_file():
        return None
    want = int(m.group(2))
    with p.open(encoding="utf-8") as f:
        head = f.readline().rstrip("\n").split("\t")
        if want < 2 or not all(cols.get(k) in head for k in ("clip", "from", "to")):
            return None
        for number, line in enumerate(f, 2):
            if number == want:
                row = dict(zip(head, line.rstrip("\n").split("\t")))
                return {"source": src, "clip": row[cols["clip"]], "from": _float(row[cols["from"]]),
                        "to": _float(row[cols["to"]]), "media": row.get(cols.get("media", "")) or None}
    return None


def source_text(src, root=None):
    """The text a source points at, so a value can be checked against it. None when it cannot be read
    here (a URL offline, a timestamp or range into media, a file cited without a line). A time range of a word-timed
    transcript is the words spoken inside it."""
    s = str(src or "").strip()
    timed = _timed_words(s, root)
    if timed is not None:
        return " ".join(w["fields"]["text"] for w in timed[1])
    m = re.match(r"^git:(.+)@([0-9a-fA-F]{7,40})$", s)
    if m:
        r = subprocess.run(["git", "-C", str(expand(m.group(1), root)), "show", "--format=%B", m.group(2)],
                           capture_output=True, text=True, errors="replace")
        return r.stdout[:400000] if r.returncode == 0 else None
    m = re.match(r"^(.*?)(?::(\d+)(?:-(\d+))?|#L(\d+)(?:-L?(\d+))?)$", s)
    if m and not s.startswith("http"):
        p = expand(m.group(1), root)
        a = int(m.group(2) or m.group(4))
        b = int(m.group(3) or m.group(5) or a)
        try:
            # Citations and check_source count physical LF-delimited file lines.
            # Unicode separators and bare CRs inside a record are content.
            lines = []
            with p.open("rb") as f:
                for number, raw in enumerate(f, 1):
                    if number > b:
                        break
                    if number >= a:
                        content = raw[:-2] if raw.endswith(b"\r\n") else raw.removesuffix(b"\n")
                        lines.append(content.decode("utf-8", errors="replace"))
        except OSError:
            return None
        return "\n".join(lines)
    return None


def _citation_terms(text):
    """Use the same lexical terms for offered values and cited source text.

    Preserve contractions and complete numbers while also retaining the existing
    compound components used for identifiers and hyphenated words.
    """
    text = unicodedata.normalize("NFKC", str(text))
    text = re.sub(r"(?<=\d)[,.](?=\d{3}\b)", "", text)
    terms = {norm(w) for w in re.split(r'[\s/=&?<>()\[\]{}",;:]+', text) if w}
    terms |= {x for term in list(terms) for x in re.split(r"[-_.]", term) if x}
    return terms


def value_in_sources(value, srcs, root=None):
    """(found, where): found True when every word of 3+ characters (and every number) of the value appears
    in one cited source's text; None when no cited source can be read here."""
    if isinstance(srcs, str):
        srcs = [srcs]
    vals = value.values() if isinstance(value, dict) else [value]
    want = {w for v in vals for w in _citation_terms(v) if len(w) >= 3 or re.search(r"\d", w)}
    readable = False
    have_all = set()
    for src in srcs or []:
        text = source_text(src, root)
        if text is None:
            continue
        readable = True
        have = _citation_terms(text)
        have_all |= have
        if want <= have:
            return True, src
    if not readable:
        return None, ""
    return (want <= have_all), "across the cited sources" if want <= have_all else ""


def check_sources(srcs, root=None):
    if isinstance(srcs, str):
        srcs = [srcs]
    srcs = [s for s in (srcs or []) if str(s).strip()]
    if not srcs:
        return False, ["no source given"]
    whys = [c["why"] for c in (check_source(s, root) for s in srcs) if not c["ok"]]
    return not whys, whys


# ---------------------------------------------------------------- readers
# Each reader: (path, ctx) -> list of records. ctx is a dict for notes. Readers never decide marks or slots.

READERS = {}


def reader(name):
    def deco(fn):
        READERS[name] = fn
        return fn
    return deco


def _clock(s):
    parts = [float(x) for x in s.split(":")]
    t = 0.0
    for x in parts:
        t = t * 60 + x
    return t


@reader("transcript_words")
def r_transcript(path, ctx):
    d = load_json(path, "transcript")
    words = [w for w in d.get("words", []) if w.get("type", "word") == "word"]
    recs = []
    for i, w in enumerate(words):
        t0, t1 = w.get("start"), w.get("end")
        fields = {"text": w.get("text", ""), "speaker": w.get("speaker")}
        if t0 is not None and t1 is not None:
            fields["duration"] = round(t1 - t0, 3)
        recs.append({"id": w.get("id") or f"w{i}", "t0": t0, "t1": t1, "fields": fields, "one_word": True})
    timed = [r for r in recs if r["t0"] is not None]
    if timed:
        span = timed[-1]["t1"] - timed[0]["t0"]
        if span > 0:
            recs.append({"id": "speech-summary", "fields": {"wpm": round(len(timed) / span * 60, 1)}})
    ctx["asr_dropped"] = d.get("guards", {}).get("dropped", [])
    ctx["language"] = d.get("language")
    return recs


_SEGMENT_CAPTION_TIME = r"(?:\d+(?:\.\d+)?s?|\d+:\d{2}(?::\d{2}(?:\.\d+)?)?)"
_SEGMENT_CAPTION = re.compile(
    rf"^\s*\[({_SEGMENT_CAPTION_TIME})(?:-({_SEGMENT_CAPTION_TIME}))?\]\s*(.*?)\s*$"
)
_CAPTION_CUE = re.compile(
    r"^(?:music|laughter|laughing|applause|inaudible|overlap|crosstalk|sighs?|gasps?|"
    r"[A-Z][A-Za-z .'-]+ talks? over [A-Z][A-Za-z .'-]+)$", re.I
)


def _caption_spoken(text):
    annotations = []
    if text.startswith(">>"):
        annotations.append({"kind": "speaker-turn-marker", "text": ">>"})
        text = text[2:].lstrip()

    def retain_cue(m):
        cue = m.group(1)
        if _CAPTION_CUE.fullmatch(cue.strip()):
            annotations.append({"kind": "caption-annotation", "text": f"[{cue}]"})
            return ""
        return m.group(0)

    return re.sub(r"\[([^\]]+)\]", retain_cue, text).strip(), annotations


@reader("segment_captions")
def r_segment_captions(path, ctx):
    """Read timestamped caption segments without promoting segment times to word timings."""
    lines = Path(path).read_text(encoding="utf-8").splitlines()
    recs, provenance = [], {}
    seen_caption = False
    for line_no, raw in enumerate(lines, 1):
        if not raw.strip():
            continue
        match = _SEGMENT_CAPTION.match(raw)
        if not match:
            if re.match(r"^\s*\[\d", raw):
                raise WTError(f"malformed timestamped caption at line {line_no}: {raw.strip()!r}",
                              "use [seconds] text or [start-end] text (optional s suffix), or [minutes:seconds] text")
            if seen_caption and raw.strip():
                raise WTError(f"un-timestamped text after captions began at line {line_no}",
                              "put each caption segment on its own timestamped line; preamble headers are allowed before the first caption")
            continue  # Headers and other preamble before the first caption are not speech.

        seen_caption = True
        timestamp, timestamp_end, text = match.groups()
        seconds = _clock(timestamp) if ":" in timestamp else float(timestamp.removesuffix("s"))
        record_id = f"caption-{line_no:06d}"
        spoken, annotations = _caption_spoken(text)
        provenance_record = {"source_line": line_no, "timestamp_text": timestamp,
                             "timestamp_seconds": seconds, "raw_caption": raw,
                             "annotations": annotations}
        if timestamp_end is not None:
            end_seconds = (_clock(timestamp_end) if ":" in timestamp_end
                           else float(timestamp_end.removesuffix("s")))
            if end_seconds < seconds:
                raise WTError(f"caption range ends before it starts at line {line_no}: {raw.strip()!r}",
                              "put the segment end after its start")
            provenance_record["timestamp_end_text"] = timestamp_end
            provenance_record["timestamp_end_seconds"] = end_seconds
        provenance[record_id] = provenance_record
        # Do not set t0/t1: these are segment boundaries, not per-word timings.
        recs.append({"id": record_id, "fields": {"text": spoken}})

    ctx["segment_caption_provenance"] = provenance
    if not recs:
        ctx["segment_caption_status"] = "no timestamped caption segments found"
    return recs


@reader("json3_captions")
def r_json3_captions(path, ctx):
    """Read reported caption text; display durations/offsets are provenance, not word timing."""
    doc = load_json(path, "JSON3 captions")
    events = doc.get("events") if isinstance(doc, dict) else None
    if not isinstance(events, list):
        raise WTError("JSON3 captions need an events array", "use the original JSON3 caption response")
    recs, provenance = [], {}
    for index, event in enumerate(events):
        if not isinstance(event, dict):
            raise WTError(f"invalid JSON3 event {index}", "each event must be an object")
        segs = event.get("segs")
        if segs is None:  # Window/style events contain no reported speech.
            continue
        if not isinstance(segs, list) or any(not isinstance(s, dict) or not isinstance(s.get("utf8"), str) for s in segs):
            raise WTError(f"invalid JSON3 caption segments at event {index}",
                          "each caption segment must carry its original utf8 string")
        raw = "".join(s["utf8"] for s in segs)
        if not raw.strip():  # Common append-newline display events are not words.
            continue
        start = event.get("tStartMs")
        duration = event.get("dDurationMs")
        if any(isinstance(v, bool) or not isinstance(v, (int, float)) or v < 0
               or not math.isfinite(v) for v in [start] + ([duration] if duration is not None else [])):
            raise WTError(f"invalid JSON3 timestamp at event {index}", "retain finite nonnegative caption timestamps in milliseconds")
        record_id = f"json3-event-{index:06d}"
        spoken, annotations = _caption_spoken(raw.strip())
        provenance[record_id] = {"source_event_index": index, "timestamp_seconds": start / 1000,
                                 "raw_caption": raw, "raw_event": event, "annotations": annotations}
        recs.append({"id": record_id, "fields": {"text": spoken}})
    ctx["json3_caption_provenance"] = provenance
    ctx["json3_caption_limit"] = "Reported event text; no inferred word timings, speakers, or deduplication of overlapping captions."
    return recs


@reader("html_json_records")
def r_html_json_records(path, ctx):
    """Read authored records from an explicitly selected inert JSON script block.

    No JavaScript executes. The same declared records may drive a document's own view.
    Their source configuration is not evidence that the browser rendered them.
    """
    script_id = ctx.get("opts", {}).get("script_id")
    if not isinstance(script_id, str) or not script_id.strip():
        raise WTError("HTML JSON records need an explicit script_id", "name the inert application/json script block in source options")

    class Blocks(HTMLParser):
        def __init__(self):
            super().__init__(convert_charrefs=False)
            self.matches, self.active, self.chunks, self.bad = 0, False, [], False

        def handle_starttag(self, tag, attrs):
            ids = [value for key, value in attrs if key == "id"]
            if script_id not in ids:
                return
            self.matches += 1
            self.bad |= tag != "script" or len(ids) != 1
            duplicate_type = sum(key == "type" for key, _ in attrs) != 1
            attrs = dict(attrs)
            if tag == "script":
                self.active = True
                self.bad |= attrs.get("type", "").lower() != "application/json" or "src" in attrs
                self.bad |= duplicate_type

        def handle_data(self, data):
            if self.active:
                self.chunks.append(data)

        def handle_endtag(self, tag):
            if tag == "script":
                self.active = False

    parser = Blocks()
    parser.feed(Path(path).read_text(encoding="utf-8"))
    parser.close()
    if parser.matches != 1 or parser.bad or parser.active:
        raise WTError(f"HTML source needs exactly one closed inert application/json block with id {script_id!r}",
                      "select a unique inline JSON block; external or executable scripts are not records")
    try:
        def refuse_constant(value):
            raise ValueError(f"non-JSON numeric constant {value}")
        def finite_number(value):
            number = float(value)
            if not math.isfinite(number):
                raise ValueError("nonfinite JSON number")
            return number
        raw = json.loads("".join(parser.chunks), parse_constant=refuse_constant, parse_float=finite_number)
    except (ValueError, json.JSONDecodeError) as e:
        raise WTError(f"invalid JSON in HTML block {script_id!r}: {e}", "repair the authored JSON, without executing scripts")
    if not isinstance(raw, list):
        raise WTError("HTML JSON records must be an array", "supply records with unique id and fields objects")
    recs, seen = [], set()
    for index, record in enumerate(raw):
        if not isinstance(record, dict) or not isinstance(record.get("id"), str) or not record["id"].strip() \
                or record["id"] in seen or not isinstance(record.get("fields"), dict):
            raise WTError(f"invalid or duplicate authored record at index {index}", "each record needs a unique nonempty string id and fields object")
        seen.add(record["id"])
        for key in ("t0", "t1"):
            if key in record and (isinstance(record[key], bool) or not isinstance(record[key], (int, float))
                                  or not math.isfinite(record[key]) or record[key] < 0):
                raise WTError(f"invalid authored record time {key!r} at index {index}", "times, when supplied, are finite nonnegative seconds")
        if "t1" in record and ("t0" not in record or record["t1"] < record["t0"]):
            raise WTError(f"invalid authored record interval at index {index}", "an end requires a start and cannot precede it")
        recs.append(copy.deepcopy(record))
    ctx["html_json_records_source"] = {"path": str(path), "script_id": script_id,
        "raw_records": raw, "time_semantics": "Authored source exposure or event seconds; split text tokens inherit the record interval, never inferred spoken-word onsets.",
        "limit": "Authored source data only; no JavaScript execution, browser visibility, OCR, rendered appearance, speaker identity or human preference is inferred."}
    return recs


@reader("tsv_rows")
def r_tsv(path, ctx):
    lines = Path(path).read_text(encoding="utf-8").splitlines()
    opts = ctx.get("opts") or {}
    id_column = opts.get("id_column")
    if id_column is not None and (not isinstance(id_column, str) or not id_column.strip()):
        raise WTError("tsv_rows id_column must name a present column",
                      'set source options such as "id_column": "record_id"')
    if not lines:
        if id_column is not None:
            raise WTError(f"tsv_rows id_column {id_column!r} is missing from the TSV header",
                          "name a column present in the TSV header")
        return []
    head = lines[0].split("\t")
    if id_column is not None and head.count(id_column) != 1:
        raise WTError(f"tsv_rows id_column {id_column!r} must name exactly one TSV column",
                      "name a unique column present in the TSV header")
    id_index = head.index(id_column) if id_column is not None else None
    missing_values = opts.get("missing_values", [])
    if not isinstance(missing_values, list) or any(not isinstance(v, str) for v in missing_values):
        raise WTError("tsv_rows missing_values must be a list of strings",
                      'declare source options such as "missing_values": ["unknown"]')
    recs = []
    for i, line in enumerate(lines[1:], 1):
        if not line.strip():
            continue
        cells = line.split("\t")
        f = {h: (cells[k] if k < len(cells) else "") for k, h in enumerate(head)}
        if id_index is None:
            record_id = f"{(ctx.get('reader_row') or {}).get('id_prefix', 'row')}-{i:02d}"
        else:
            record_id = cells[id_index] if id_index < len(cells) else ""
            if not record_id.strip():
                raise WTError(f"tsv_rows row {i + 1} has a blank identity in {id_column!r}",
                              "supply a nonempty unique identity for every TSV record")
            if any(record.get("id") == record_id for record in recs):
                raise WTError(f"tsv_rows row {i + 1} duplicates identity {record_id!r} in {id_column!r}",
                              "supply a unique identity for every TSV record")
        missing = {key: value for key, value in f.items() if value in missing_values}
        if missing:
            ctx.setdefault("tsv_missing_values", {})[record_id] = missing
            f.update({key: None for key in missing})
        t0, t1 = _float(f.get("t0")), _float(f.get("t1"))
        if t0 is not None and t1 is not None:
            f["duration"] = round(t1 - t0, 3)
        recs.append({"id": record_id, "t0": t0, "t1": t1, "fields": f, "is_unit": True, "order": i})
    return recs


def _float(v):
    try:
        return float(v)
    except (TypeError, ValueError):
        return None


@reader("post_json")
def r_post(path, ctx):
    d = load_json(path, "post JSON")
    posts = [d] + [p for p in d.get("thread", []) if isinstance(p, dict)]
    recs = []
    import datetime
    for n, p in enumerate(posts, 1):
        unit = f"post-{n}"
        recs.append({"id": unit, "is_unit": True, "order": n, "fields": {"order": n}})
        paras = [x for x in re.split(r"\n\s*\n", p.get("text") or "") if x.strip()]
        for k, para in enumerate(paras, 1):
            recs.append({"id": f"{unit}.p{k}", "unit": unit, "region": f"paragraph-{k}", "fields": {"text": para}})
        # An X article (long-form post) keeps its body in article.content.blocks, not in text. Each heading opens a
        # new section unit; the region names the block's role (paragraph, heading, quote, list-item) and its order.
        blocks = (((p.get("article") or {}).get("content") or {}).get("blocks")) or []
        section, k = unit, 0
        if blocks and (p.get("article") or {}).get("title"):
            recs.append({"id": f"{unit}.title", "unit": unit, "region": "title", "fields": {"text": p["article"]["title"]}})
        for b in blocks:
            body = (b.get("text") or "").strip()
            if not body:
                continue
            role = {"header-one": "heading", "header-two": "heading", "header-three": "heading", "blockquote": "quote",
                    "ordered-list-item": "list-item", "unordered-list-item": "list-item"}.get(b.get("type"), "paragraph")
            if role == "heading":
                section = f"{unit}.s{sum(1 for r in recs if r.get('is_unit')) }"
                recs.append({"id": section, "is_unit": True, "order": len([r for r in recs if r.get("is_unit")]) + 1,
                             "fields": {"order": len([r for r in recs if r.get("is_unit")]) + 1}})
            k += 1
            recs.append({"id": f"{section}.b{k}", "unit": section, "region": f"{role}-{k}", "fields": {"text": body}})
        for k, fc in enumerate((p.get("raw_text") or {}).get("facets", []) or [], 1):
            typ = fc.get("type")
            val = fc.get("replacement") or fc.get("display") or fc.get("original") or fc.get("text")
            key = {"url": "link", "mention": "mention", "hashtag": "hashtag"}.get(typ)
            if key and val:
                recs.append({"id": f"{unit}.{key}{k}", "unit": unit, "fields": {key: val}})
        for k, m in enumerate(((p.get("media") or {}).get("all") or []), 1):
            desc = f"{m.get('type')} {m.get('width')}x{m.get('height')}"
            if m.get("duration"):
                desc += f" {round(m['duration'])}s"
            f = {"media": desc}
            if m.get("alt_text"):
                f["alt_text"] = m["alt_text"]
            recs.append({"id": f"{unit}.media{k}", "unit": unit, "region": "media", "fields": f})
        ts = p.get("created_timestamp")
        if ts:
            dt = datetime.datetime.fromtimestamp(ts, datetime.timezone.utc)
            recs.append({"id": f"{unit}.posted", "unit": unit,
                         "fields": {"posted_day": dt.strftime("%a"), "posted_hour_utc": dt.hour}})
    return recs


@reader("ocr_images")
def r_ocr(path, ctx):
    """path = a folder of images (sorted by name = slide order) or one image."""
    p = Path(path)
    pat = (ctx.get("opts") or {}).get("glob")
    nat = lambda x: [int(c) if c.isdigit() else c for c in re.split(r"(\d+)", x.name)]
    imgs = sorted((x for x in (p.glob(pat) if pat else p.iterdir())
                   if x.suffix.lower() in (".png", ".jpg", ".jpeg", ".webp", ".tif", ".tiff")), key=nat) \
        if p.is_dir() else [p]
    recs = []
    for n, img in enumerate(imgs, 1):
        unit = f"slide-{n}"
        r = subprocess.run(["tesseract", str(img), "stdout", "--psm", "3", "tsv"], capture_output=True, text=True)
        if r.returncode != 0:
            raise WTError(f"tesseract failed on {img}: {r.stderr.strip()[:200]}", "check the image opens; or install tesseract (brew install tesseract)")
        rows = [ln.split("\t") for ln in r.stdout.splitlines()[1:]]
        W = H = None
        blocks = {}
        for c in rows:
            if len(c) < 12:
                continue
            level, block = int(c[0]), int(c[2])
            x, y, w, h, conf, text = int(c[6]), int(c[7]), int(c[8]), int(c[9]), float(c[10]), c[11]
            if level == 1:
                W, H = w, h
            if level == 5 and text.strip() and conf >= 0:
                blocks.setdefault(block, []).append((x, y, w, h, conf, text))
        recs.append({"id": unit, "is_unit": True, "order": n,
                     "fields": {"order": n, "size": f"{W}x{H}", "image": str(img)}})
        for b, ws in sorted(blocks.items()):
            good = [x for x in ws if x[4] >= 60 and re.search(r"\w", x[5])]
            if not good or statistics.mean(x[4] for x in ws) < 60:
                continue
            x0 = min(x[0] for x in good); y0 = min(x[1] for x in good)
            x1 = max(x[0] + x[2] for x in good); y1 = max(x[1] + x[3] for x in good)
            recs.append({"id": f"{unit}.b{b}", "unit": unit, "region": f"block-{b}", "fields": {
                "text": " ".join(x[5] for x in good),
                "box": [round(x0 / W, 3), round(y0 / H, 3), round((x1 - x0) / W, 3), round((y1 - y0) / H, 3)],
                "line_height_px": round(statistics.median(x[3] for x in good) * 1080 / W, 1),
                "conf_min": min(x[4] for x in good)}})
    return recs


def reader_available(registry, name):
    """(ok, why). A reader needs its code here and every tool its registry row names in 'needs'."""
    if name not in READERS:
        return False, f"no reader called '{name}' exists in wt_core.py"
    row = registry.readers.get(name)
    needs = row.get("needs", []) if isinstance(row, dict) else []
    missing = [t for t in needs if not shutil.which(t)]
    if missing:
        return False, f"tool not installed: {', '.join(missing)}"
    return True, ""


def read_source(registry, name, path, ctx, opts=None):
    ctx["opts"] = opts or {}
    ok, why = reader_available(registry, name)
    if not ok:
        return None, why
    p = Path(os.path.expanduser(str(path)))
    if not p.exists():
        return None, f"source missing: {p}"
    ctx["reader_row"] = registry.readers.get(name) or {}
    try:
        return READERS[name](p, ctx), ""
    except WTError as e:
        return None, e.what
    except (OSError, ValueError, KeyError, TypeError, IndexError, AttributeError) as e:
        return None, f"{name} could not read {p}: {type(e).__name__}: {e}"
    finally:
        ctx.pop("opts", None)
        ctx.pop("reader_row", None)
