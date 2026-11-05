"""Build the train and held-out test rows for teaching a decider model the person's laws (their writing rules).

usage: python3 -I build_training_rows.py <request.json | ->     writes <out_dir>/items.json and <out_dir>/train.jsonl

Every law, line, set name and number is the request's (or the person's settings row's); this file names none of them.
Real lines come from the person's labels (labelled_lines, rows {text, sets, bad_for}): the guides' bad and good
examples, the person's spoken sentences and human YouTube caption sentences. The split is by source, decided before any
training:
  guide lines   grouped by (guide file, nearest heading above the line); test_share of the groups go to test
  spoken        sentences from the first half of the transcript train, the second half test
  captions      split by video
  narrator      the request's never_train lines are never trained on; they are scored on their own
Synthetic rows (synthetic, {law, text, label, kind}) only ever train. Each law also trains on a sample of other
laws' synthetic good lines as good lines, so a written line is not failed for being written (per_law.other_goods),
and short plain lines and on-screen labels as good lines (per_law.short_goods). The held_out lines (real copy)
are never trained on: they are the second held-out set.

For law L a line is bad when one of the laws in L's bad_from lists it as a fail example, and good when it is in a
good set (good_sets). A line that is bad for some other law is not a label for L."""
import glob
import hashlib
import json
import random
import re
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "read-data"))
from common import Refused, need, rows_of, run, with_settings  # noqa: E402

FOLDER = "fine-tune-a-small-model-on-a-persons-rules"
SKILLS = None                                          # the folder of guides a ruled line is grouped by, when given


def norm(t):
    return re.sub(r"\s+", " ", t.replace("’", "'").replace("‘", "'").replace("“", '"').replace("”", '"')).strip()


def sentences(text):
    return [s.strip() for s in re.findall(r"[^.!?]+(?:[.!?]+[\"'”)]*|$)", text) if s.strip()] or [text]


def side(key, test_share=0.5):
    """Deterministic train/test side for a group key."""
    return "test" if int(hashlib.blake2b(key.encode(), digest_size=8).hexdigest(), 16) % 1000 < test_share * 1000 else "train"


def laws(req):
    out = need(req, "laws", dict, "an object of laws: {<law id>: {question, options: [two answers], fail, bad_from}}")
    if not out:
        raise Refused("laws must name at least one law: {<law id>: {question, options, fail, bad_from}}")
    for lid, law in out.items():
        for key in ("question", "options", "fail", "bad_from"):
            if key not in law:
                raise Refused(f"laws.{lid}.{key} is required")
        if law["fail"] not in law["options"] or len(law["options"]) != 2:
            raise Refused(f"laws.{lid}: options must be two answers and fail must be one of them")
    return out


def skill_group(text, docs):
    key = norm(text)[:40]
    for f, d in docs.items():
        k = d.find(key)
        if k >= 0:
            head = [m.group(0) for m in re.finditer(r"(?m)^(?:#+ |\d+[a-z]?\. |\*\*[^*\n]+\*\*).*$", d[:k])]
            return f"{Path(f).relative_to(SKILLS)}::{head[-1] if head else ''}"
    return None


def spoken_lines(spec):
    TRANSCRIPT = Path(need(spec, "transcript_file", str, "the transcript file of the person speaking")).expanduser()
    txt = TRANSCRIPT.read_text().replace("\r", " ")
    words = " ".join(ln.strip() for ln in txt.split("\n") if ln.strip() and not re.match(r"^\d\d:\d\d:\d\d", ln))
    sents = [s for s in sentences(words) if len(s.split()) >= spec.get("min_words", 4)]
    half = len(sents) // 2
    return [(s, "train" if i < half else "test", f"{spec['set']}-{'a' if i < half else 'b'}") for i, s in enumerate(sents)]


def caption_lines(spec, RNG, test_share):
    CAPTIONS = Path(need(spec, "folder", str, "the folder of caption files")).expanduser()
    out = []
    for info in sorted(CAPTIONS.glob("*.info.json")):
        try:
            d = json.load(open(info))
        except ValueError:
            continue
        vid = info.name[:-len(".info.json")]
        files = [CAPTIONS / f"{vid}.{k}.json3" for k in (d.get("subtitles") or {}) if k.startswith(spec.get("language", "en")) and (CAPTIONS / f"{vid}.{k}.json3").exists()]
        if not files:
            continue
        ev = json.load(open(files[0])).get("events", [])
        text = " ".join("".join(s.get("utf8", "") for s in e.get("segs", [])) for e in ev if e.get("segs"))
        text = re.sub(r"\([^)]*\)|\[[^]]*\]", " ", text)
        text = re.sub(r"(?:^|\s)-\s", " ", re.sub(r"\s+", " ", text))
        sents = [s for s in sentences(text[:spec["max_characters"]]) if spec["min_words"] <= len(s.split()) <= spec["max_words"]]
        for s in RNG.sample(sents, min(spec["per_video"], len(sents))):
            out.append((s, side("video:" + vid, test_share), "video:" + vid))
    return out


def main(req):
    req = with_settings(req, "build", FOLDER)
    L = laws(req)
    global SKILLS
    DATA = Path(need(req, "out_dir", str, "the folder items.json and train.jsonl are written to")).expanduser()
    RNG = random.Random(need(req, "seed", int, "the integer seed of the random generator, so a build can be made again"))
    test_share = need(req, "test_share", (int, float), "the share of groups that go to test, from 0 to 1")
    GOOD_SETS = set(need(req, "good_sets", list, "the names of the sets whose lines are good lines"))
    fail_set = need(req, "fail_set", str, "the set name of lines ruled bad")
    pass_set = need(req, "pass_set", str, "the set name of lines ruled good")
    per_law = need(req, "per_law", dict, "{spoken_goods, other_goods, short_goods}: how many of each kind of good line each law trains on")
    OTHER_GOODS_PER_LAW, SHORT_GOODS_PER_LAW = per_law["other_goods"], per_law["short_goods"]
    short_kinds = set(need(req, "short_kinds", list, "the kinds of short good lines (law *) every law trains on"))
    SHORT_KINDS_FOR = {k: set(v) for k, v in req.get("short_kinds_for", {}).items()}
    NO_OTHER_GOODS = set(req.get("no_other_goods", []))
    NARRATOR = need(req, "never_train", list, "the lines never trained on (an empty list when there are none)")
    narrator = {norm(t) for t in NARRATOR}
    SKILLS = Path(req["group_by_headings_in"]).expanduser() if req.get("group_by_headings_in") else None
    docs = {f: open(f, errors="ignore").read().replace("’", "'").replace("‘", "'") for f in sorted(glob.glob(str(SKILLS / "**/*.md"), recursive=True))} if SKILLS else {}
    items = {}

    def add(text, set_, split, group, bad_for=()):
        t = norm(text)
        if any(n in t for n in narrator):
            return
        it = items.setdefault(t, {"text": t, "sets": set(), "bad_for": set(), "split": split, "group": group})
        it["sets"].add(set_)
        it["bad_for"] |= set(bad_for)

    for x in rows_of(need(req, "labelled_lines", (list, dict), "the lines the person ruled on: rows {text, sets, bad_for}"), "labelled_lines"):
        sk = set(x["sets"]) & {fail_set, pass_set}
        if not sk:
            continue                                   # spoken/captions/held are rebuilt below with a source split
        g = skill_group(x["text"], docs) or ("law:" + sorted(x["bad_for"])[0] if x["bad_for"] else "line:" + norm(x["text"]))
        for s in sk:
            add(x["text"], s, side(g, test_share), g, x["bad_for"])
    if "spoken" in req:
        br = spoken_lines(req["spoken"])
        for split in ("train", "test"):
            pool = [b for b in br if b[1] == split]
            for s, sp, g in RNG.sample(pool, min(req["spoken"]["per_split"], len(pool))):
                add(s, req["spoken"]["set"], sp, g)
    if "captions" in req:
        caps = caption_lines(req["captions"], RNG, test_share)
        for split in ("train", "test"):
            pool = [c for c in caps if c[1] == split]
            for s, sp, g in RNG.sample(pool, min(req["captions"][split], len(pool))):
                add(s, req["captions"]["set"], sp, g)
    for it in items.values():                          # a line that is some law's bad example is never also a good line
        if fail_set in it["sets"]:
            it["sets"] -= GOOD_SETS
        it["good"] = bool(it["sets"] & GOOD_SETS)
        it["bad_laws"] = sorted(lid for lid, law in L.items() if it["bad_for"] & set(law["bad_from"]))
        it["sets"], it["bad_for"] = sorted(it["sets"]), sorted(it["bad_for"])
    items = sorted(items.values(), key=lambda it: it["text"])
    film = {norm(x["text"]) for x in rows_of(req.get("held_out", []), "held_out")}     # real copy held out only ever tests
    test_texts = {it["text"] for it in items if it["split"] == "test"} | narrator | film

    syn = rows_of(req.get("synthetic", []), "synthetic")
    dropped = [s for s in syn if norm(s["text"]) in test_texts]
    syn = [s for s in syn if norm(s["text"]) not in test_texts]

    rows = []
    for lid, law in L.items():
        def row(text, bad, source):
            gold = law["options"].index(law["fail"]) if bad else 1 - law["options"].index(law["fail"])
            return {"law": lid, "question": law["question"], "options": law["options"], "text": norm(text), "gold": gold, "bad": bad, "source": source}
        tr = [it for it in items if it["split"] == "train"]
        rows += [row(it["text"], True, "real") for it in tr if lid in it["bad_laws"]]
        rows += [row(it["text"], False, "real") for it in tr if it["good"] and pass_set in it["sets"]]
        spoken = [it for it in tr if it["good"] and pass_set not in it["sets"]]
        rows += [row(it["text"], False, "real") for it in RNG.sample(spoken, min(per_law["spoken_goods"], len(spoken)))]
        rows += [row(s["text"], s["label"] == "bad", "synthetic") for s in syn if s["law"] == lid]
        if lid not in NO_OTHER_GOODS:
            own = {norm(s["text"]) for s in syn if s["law"] == lid}
            other = [s for s in syn if s["law"] not in (lid, "*") and s["label"] == "good" and norm(s["text"]) not in own]
            rows += [row(s["text"], False, "synthetic-other-law-good") for s in RNG.sample(other, min(OTHER_GOODS_PER_LAW, len(other)))]
        short = [s for s in syn if s["law"] == "*" and s["label"] == "good" and s["kind"] in SHORT_KINDS_FOR.get(lid, short_kinds)]
        rows += [row(s["text"], False, "synthetic-short-good") for s in RNG.sample(short, min(SHORT_GOODS_PER_LAW, len(short)))]
    RNG.shuffle(rows)
    DATA.mkdir(parents=True, exist_ok=True)
    json.dump({"laws": L, "narrator": NARRATOR, "items": items, "synthetic_dropped_as_test_overlap": [s["text"] for s in dropped]},
              open(DATA / "items.json", "w"), indent=1, ensure_ascii=False)
    with open(DATA / "train.jsonl", "w") as f:
        for r in rows:
            f.write(json.dumps(r, ensure_ascii=False) + "\n")
    print(f"items {len(items)}: train {sum(it['split'] == 'train' for it in items)}, test {sum(it['split'] == 'test' for it in items)}; "
          f"train rows {len(rows)} ({sum(r['source'] == 'synthetic' for r in rows)} synthetic); synthetic dropped as test overlap {len(dropped)}")
    for lid in L:
        te = [it for it in items if it["split"] == "test"]
        print(f"  {lid:24} train bad {sum(r['law'] == lid and r['bad'] for r in rows):3} good {sum(r['law'] == lid and not r['bad'] for r in rows):3} | "
              f"test bad {sum(lid in it['bad_laws'] for it in te):3} good {sum(it['good'] for it in te):3}")
    te = [it for it in items if it["split"] == "test"]
    return {"items_file": str(DATA / "items.json"), "train_file": str(DATA / "train.jsonl"),
            "items": len(items), "train_items": len(items) - len(te), "test_items": len(te),
            "train_rows": len(rows), "synthetic_rows": sum(r["source"] == "synthetic" for r in rows), "synthetic_dropped": len(dropped),
            "per_law": {lid: {"train_bad": sum(r['law'] == lid and r['bad'] for r in rows), "train_good": sum(r['law'] == lid and not r['bad'] for r in rows),
                              "test_bad": sum(lid in it['bad_laws'] for it in te), "test_good": sum(it['good'] for it in te)} for lid in L}}


if __name__ == "__main__":
    sys.exit(run(main, sys.argv[1:]))
