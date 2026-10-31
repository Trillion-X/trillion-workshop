"""word-template operations. Every operation takes pieces and returns a piece (same schema), so any operation
can be applied to the result of any other, including itself:

  tokenize(spec)          measurements -> piece            mark_keep(piece, ids, reason)
  mark_slot(piece, ids, slot, type, note, dims)            fill(piece, fills)
  drift(template, target) -> template annotated with drift.status (+ report in piece.notes.drift)
  diff(a, b) = drift(a, b)                                 merge(a, b)       fork(a, new_id)
  nest(parent, child, at)                                  xref(piece, from_id, to_id, rel)
  delete(piece, ids)      restore(piece, ids)              aggregate(iterable of pieces, family_id)
  bind(piece, ids, words, edge, offset_s)            retime(piece, timed_words) = move bound tokens to their words

Nothing here names a dimension, medium, slot type or reader: those come from the registry and the spec.
"""
import copy
import difflib
import math
import re

from wt_core import (BREAK, SCHEMA, SLOT_MARK, Registry, WTError, check_sources, expand, norm, norm_value,
                     read_source, source_span, split_words, stamp, value_in_sources)


def judge_value(value, srcs, derived=None, root=None):
    """Is a slot value sourced? The source must check out AND the value's words must be in it, unless the
    entry says how it was derived (then it is 'derived', still visible). Returns (status, check, whys)."""
    if value in (None, "", {}, []):
        return "empty", "", ["no value given"]
    ok, whys = check_sources(srcs, root)
    if not ok:
        return "unsourced", "", whys
    found, where = value_in_sources(value, srcs, root)
    if found:
        return "sourced", f"found in {where}", []
    if found is None:
        return "sourced", "source not readable here (URL or media timestamp): not checked", []
    if derived:
        return "sourced", f"derived: {derived}", []
    return "unsourced", "", ["the value's words are not in the cited source: quote the source, or add \"derived\": \"<how>\""]


# ================================================================ helpers

def new_piece(pid, medium, kind="reference"):
    return {"schema": SCHEMA, "piece": {"id": pid, "medium": medium, "kind": kind, "built_from": [], "provenance": []},
            "registry": None, "units": [], "lines": [], "slots": {}, "tokens": [], "fills": {}, "deleted": [],
            "includes": [], "pending": [], "conflicts": [], "notes": {}}


def _check_piece(p, role="piece"):
    if not isinstance(p, dict) or p.get("schema") != SCHEMA:
        got = p.get("schema") if isinstance(p, dict) else type(p).__name__
        raise WTError(f"{role} is not a word-template piece (schema is {got!r}, expected {SCHEMA!r})",
                      "pass a file written by make_template.py, fill.py or one of the ops")
    for k, v in new_piece("x", "x").items():
        p.setdefault(k, copy.deepcopy(v))
    return p


def _prov(p, op, **kw):
    p["piece"].setdefault("provenance", []).append({"op": op, **kw})


def tok_index(p):
    return {t["id"]: t for t in p["tokens"]}


def _words(v, reg):
    if v is None:
        return []
    if isinstance(v, (list, tuple)):
        return [str(x) for x in v]
    return split_words(str(v), reg)


def slot_dims(t):
    return t.get("slot_dims") or list(t.get("dims", {}).keys())


def dim_tokens(p, d):
    return [t for t in p["tokens"] if d in t.get("dims", {})]


def runs(tokens, d):
    """Group a dimension's tokens into runs: a KEEP token alone, or one slot occurrence.

    Distinct logical text lines are separate occurrences even with one shared slot id. A text line
    may span picture units without splitting its multiword phrase. Without line metadata, units
    separate occurrences; pieces predating both keep the legacy adjacency behavior.
    """
    out, i = [], 0
    while i < len(tokens):
        t = tokens[i]
        if t.get("mark") == "SLOT" and d in slot_dims(t):
            j = i + 1
            while j < len(tokens) and tokens[j].get("mark") == "SLOT" and tokens[j].get("slot") == t.get("slot") \
                    and d in slot_dims(tokens[j]) and _same_occurrence(t, tokens[j], d):
                j += 1
            out.append(("SLOT", tokens[i:j]))
            i = j
        else:
            out.append(("KEEP", [t]))
            i += 1
    return out


def _same_occurrence(first, next_token, d):
    """Prefer logical text lines; a phrase can cross a picture-unit boundary."""
    first_line = (first.get("line") or {}).get(d)
    next_line = (next_token.get("line") or {}).get(d)
    if first_line is not None and next_line is not None:
        return first_line == next_line
    return first.get("unit") == next_token.get("unit")


def _edge_punct(text):
    m = re.match(r"^(\W*)(.*?)(\W*)$", str(text), re.S)
    return (m.group(1), m.group(3)) if m else ("", "")


def empty_text(slot):
    return f"[{slot.get('type', 'SLOT')}: no source yet]"


# ================================================================ tokenize (make)

def tokenize(spec, registry=None, root=None):
    reg = registry or Registry.load(spec.get("registry"))
    sp = spec.get("piece") or {}
    pid, medium = sp.get("id"), sp.get("medium")
    if not pid or not medium:
        raise WTError("the spec has no piece.id or piece.medium", "add \"piece\": {\"id\": ..., \"medium\": ...} to the spec")
    if medium not in reg.media:
        raise WTError(f"medium {medium!r} is not in the registry (known: {', '.join(sorted(reg.media))})",
                      f"add a row \"{medium}\": {{\"unit\": ..., \"regions\": [...]}} under media in {reg.path}")
    root = root or spec.get("root")
    p = new_piece(pid, medium, sp.get("kind", "reference"))
    p["piece"].update({k: v for k, v in sp.items() if k not in ("id", "medium", "kind")})
    p["registry"] = reg.path
    ctx, records, missing = {}, {}, {}
    for rname, path in (spec.get("sources") or {}).items():
        opts = path if isinstance(path, dict) else {}
        full = expand(opts.get("path") if opts else path, root)
        p["piece"]["built_from"].append({"reader": rname, **stamp(full)})
        recs, why = read_source(reg, rname, full, ctx, opts)
        if recs is None:
            if opts.get("required"):
                raise WTError(f"required source {rname!r} could not be read: {why}",
                              "repair the declared source or remove required:true only when its absence is genuinely optional")
            missing[rname] = why
        else:
            records[rname] = recs
    for rname, extra in (spec.get("records") or {}).items():          # a reading layer: records written by a person
        have = records.setdefault(rname, [])
        ids = {r["id"] for r in extra}
        merged = [r for r in have if r["id"] not in ids] + copy.deepcopy(extra)
        explicit_orders = [r.get("record_order") for r in merged if "record_order" in r]
        if any(not isinstance(order, int) or isinstance(order, bool) or order < 0
               for order in explicit_orders):
            raise WTError(f"{rname} record_order values must be nonnegative integers",
                          "give each explicitly ordered record a nonnegative integer record_order")
        if len(set(explicit_orders)) != len(explicit_orders):
            raise WTError(f"{rname} record_order values must be unique",
                          "give each explicitly ordered record a distinct record_order")
        if explicit_orders:
            # Explicit record_order is a source-sequence pin. It must win over
            # unit grouping: assigning an old piece-level record to "piece"
            # otherwise moves it after timed units and can change existing
            # line membership. Unoverridden source records keep their original
            # position in the reader output; new authored records follow them.
            source_positions = {record["id"]: index for index, record in enumerate(have)}
            appended_start = len(have)
            records[rname] = [r for _, r in sorted(enumerate(merged), key=lambda x: (
                x[1].get("record_order", source_positions.get(x[1]["id"], appended_start + x[0])), x[0]))]
        else:
            uo = {r["id"]: r.get("order") or 0 for r in merged if r.get("is_unit")}
            records[rname] = [r for _, r in sorted(enumerate(merged), key=lambda x: (
                uo.get(x[1].get("unit") or x[1]["id"], float("inf")), 0 if x[1].get("is_unit") else 1,
                x[1].get("t0") or 0, x[1]["id"] if x[1]["id"] in ids or not x[1].get("unit") else "", x[0]))]
        missing.pop(rname, None)
    for c in spec.get("corrections") or []:
        for recs in records.values():
            for r in recs:
                if r["id"] == c.get("record") and isinstance(r["fields"].get(c.get("field")), str):
                    before = r["fields"][c["field"]]
                    r["fields"][c["field"]] = re.sub(rf"(?<!\w){re.escape(c['from'])}(?!\w)", c["to"], before)
                    p["notes"].setdefault("corrections", []).append(c)
    p["notes"].update({k: v for k, v in ctx.items() if v})
    unit_kind = reg.media[medium].get("unit", "unit")
    for recs in records.values():
        for r in recs:
            if r.get("is_unit"):
                p["units"].append({"id": r["id"], "kind": unit_kind, "t0": r.get("t0"), "t1": r.get("t1"),
                                   "order": r.get("order")})
    tokens, order = {}, []

    def tok(tid, rec, row):
        if tid not in tokens:
            tokens[tid] = {"id": tid, "unit": rec.get("unit") or (rec["id"] if rec.get("is_unit") else None),
                           "region": rec.get("region") or row.get("region"), "dims": {}, "mark": "KEEP"}
            if rec.get("t0") is not None:
                tokens[tid]["t"] = rec["t0"]
            if rec.get("t1") is not None:
                tokens[tid]["t1"] = rec["t1"]
            tokens[tid]["record"] = rec["id"]
            order.append(tid)
        return tokens[tid]

    for row in reg.dims.values():
        if not reg.applies(row, medium) or row.get("written_by"):
            continue
        kind = reg.kinds.get(row.get("value_kind"))
        measures = row.get("measure") or []
        measures = [measures] if isinstance(measures, dict) else measures
        chosen, reasons = None, []
        for m in measures:
            r = m.get("reader")
            if r is None:
                reasons.append(m.get("method") or "no method written")
            elif r not in records:
                reasons.append(missing.get(r) or f"no {r} source given for this piece")
            else:
                field, where = m.get("field"), m.get("where") or {}
                def qualifies(rec):
                    if any(str(rec["fields"].get(k)) not in [str(x) for x in vs] for k, vs in where.items()):
                        return False
                    value = rec["fields"].get(field)
                    return value is not None and value != "" and (value != "-" or "-" in [str(x) for x in where.get(field, [])])
                source_options = spec.get("sources", {}).get(r)
                allow_empty = isinstance(source_options, dict) and source_options.get("allow_empty")
                if any(qualifies(rec) for rec in records[r]) or allow_empty:
                    chosen = m
                    break
                reasons.append(f"{r} has no qualifying nonempty '{field}' values for this piece")
        if not chosen:
            sources = spec.get("sources") or {}
            # Absence of optional structural metadata is inapplicability, not pending work.
            # Every alternative must opt in and be undeclared; mixed rules keep their pending fallback.
            optional_unconfigured = bool(measures) and all(
                isinstance(m.get("reader"), str)
                and m.get("optional_if_reader_not_declared") is True
                and m["reader"] not in sources
                for m in measures
            )
            if optional_unconfigured:
                continue
            p["pending"].append({"dim": row["id"], "reason": "; ".join(reasons) or "the registry row has no measure entry"})
            continue
        field, where, n = chosen.get("field"), chosen.get("where") or {}, 0
        for rec in records[chosen["reader"]]:
            if any(str(rec["fields"].get(k)) not in [str(x) for x in vs] for k, vs in where.items()):
                continue
            v = rec["fields"].get(field)
            if v is None or v == "" or (v == "-" and "-" not in [str(x) for x in where.get(field, [])]):
                continue
            if chosen.get("token") == "word" and not rec.get("one_word") and kind and kind.get("split"):
                for k, w in enumerate(split_words(v, reg)):
                    t = tok(f"{rec['id']}/{field}/{k}", rec, row)
                    t["dims"][row["id"]] = w
                    t["record"] = rec["id"]
                    t["word"] = True
            else:
                t = tok(rec["id"], rec, row)
                t["dims"][row["id"]] = v
                if chosen.get("token") == "word":
                    t["word"] = True
            n += 1
        chosen_source = spec.get("sources", {}).get(chosen["reader"])
        if not n and not (isinstance(chosen_source, dict) and chosen_source.get("allow_empty")):
            p["pending"].append({"dim": row["id"], "reason": f"{chosen['reader']} has no '{field}' values for this piece"})
    p["tokens"] = [tokens[t] for t in order]
    regions = spec.get("regions") or {}
    for t in p["tokens"]:
        if t.get("record") in regions:
            t["region"] = regions[t["record"]]
    _assign_units(p)
    _annotate(p, spec.get("annotate") or [], reg)
    _lines(p, spec, reg)
    for a in spec.get("refs") or []:
        p = xref(p, a["from"], a["to"], a.get("rel", "refers_to"))
    _spec_slots(p, spec, reg)
    if spec.get("auto_slot_rules", True):
        _auto_slots(p, spec, reg, ctx.get("language") or sp.get("language") or "en")
    for b in spec.get("binds") or []:
        p = bind(p, b["tokens"], b["words"], b.get("edge", "start"), b.get("offset_s", 0), b.get("slot"), b.get("occurrence", 1))
    _prov(p, "tokenize", spec=spec.get("_path"))
    return p


def _assign_units(p):
    timed = sorted([u for u in p["units"] if u.get("t0") is not None], key=lambda u: u["t0"])
    for t in p["tokens"]:
        if t.get("unit"):
            continue
        if t.get("t") is not None:
            for u in timed:
                end = u.get("t1")
                upper = end if end is not None else float("inf")
                # A duration belongs to a picture only when the whole record fits.
                # Keep onset half-open; allow endpoint arithmetic rounding only.
                if (u["t0"] <= t["t"] < upper
                        and (t.get("t1") is None or t["t1"] <= upper + 1e-9)):
                    t["unit"] = u["id"]
                    break
        t.setdefault("unit", None)
        if t["unit"] is None:
            t["unit"] = "piece"


def _annotate(p, notes, reg):
    idx = tok_index(p)
    for a in notes:
        src = a.get("source") or "unsourced reading"
        targets = list(a.get("tokens") or [])
        if a.get("new_token"):
            nt = dict(a["new_token"])
            nt.setdefault("dims", {})
            nt.setdefault("mark", "KEEP")
            if nt["id"] in idx:
                raise WTError(f"annotate.new_token id already exists: {nt['id']}", "pick a new id, or list it under tokens to add dims to it")
            p["tokens"].append(nt)
            idx[nt["id"]] = nt
            targets.append(nt["id"])
        for tid in targets:
            t = idx.get(tid)
            if not t:
                raise WTError(f"annotate names a token that does not exist: {tid}",
                              "use a token id from the template (make_template.py prints them in the .template.json)")
            for d, v in (a.get("dims") or {}).items():
                if d in t["dims"] and t["dims"][d] != v:
                    p["conflicts"].append({"token": tid, "dim": d, "values": [
                        {"value": t["dims"][d], "from": "measurement"}, {"value": v, "from": src}]})
                    continue
                t["dims"][d] = v
                t.setdefault("read_by", {})[d] = src
    measured = {d for t in p["tokens"] for d in t["dims"]}
    p["pending"] = [x for x in p["pending"] if x["dim"] not in measured]


def _sentence_end(word):
    return bool(re.search(r"[.!?。！？]['\")\]]*$", str(word)))


def _lines(p, spec, reg):
    given = spec.get("lines") or {}
    for d in sorted({d for t in p["tokens"] for d in t["dims"] if reg.is_text(d)}):
        toks = dim_tokens(p, d)
        pos = {t["id"]: i for i, t in enumerate(toks)}
        if d in given:
            for ln in given[d]:
                a, b = pos.get(ln["from"]), pos.get(ln["to"])
                if a is None or b is None:
                    raise WTError(f"line {ln.get('id')} of {d} names a token that is not a {d} token: {ln['from'] if a is None else ln['to']}",
                                  "use token ids from the same dimension (for a transcript: w0, w1, ...)")
                p["lines"].append({"id": ln["id"], "dim": d, "job": ln.get("job"), "format_slot": ln.get("format_slot"),
                                   "tokens": [t["id"] for t in toks[a:b + 1]]})
            continue
        brk_dims = [x for x, row in reg.dims.items() if row.get("line_break_on_change")]
        pause = reg.tokenizer.get("line_pause_s", 1.5)

        def boundary(prev, t):
            if prev is None:
                return False
            if not t.get("word"):                            # a whole-record text value is its own line
                return True
            if "/" in t["id"] or "/" in prev["id"]:          # words split from one record: one line per record
                return t.get("record") != prev.get("record")
            if _sentence_end(prev["dims"][d]):
                return True
            if any(t["dims"].get(b) != prev["dims"].get(b) for b in brk_dims):
                return True
            return t.get("t") is not None and prev.get("t1") is not None and t["t"] - prev["t1"] > pause

        cur, n, prev = [], 0, None
        for t in toks:
            if boundary(prev, t) and cur:
                n += 1
                p["lines"].append({"id": f"{d}:L{n}", "dim": d, "job": None, "tokens": cur})
                cur = []
            cur.append(t["id"])
            prev = t
        if cur:
            n += 1
            p["lines"].append({"id": f"{d}:L{n}", "dim": d, "job": None, "tokens": cur})
    idx = tok_index(p)
    jobs = spec.get("line_jobs") or {}
    for ln in p["lines"]:
        if ln["id"] in jobs:
            ln["job"] = jobs[ln["id"]]
        for tid in ln["tokens"]:
            idx[tid].setdefault("line", {})[ln["dim"]] = ln["id"]
    unknown = set(jobs) - {ln["id"] for ln in p["lines"]}
    if unknown:
        raise WTError(f"line_jobs names lines that do not exist: {sorted(unknown)}", "use line ids from the template (e.g. post.word:L1)")


def _phrase_hits(p, d, phrase, reg):
    want = [norm(w) for w in split_words(phrase, reg) if norm(w)]
    toks = [t for t in dim_tokens(p, d)]
    words = [norm(str(t["dims"][d])) for t in toks]
    hits = []
    for i in range(len(words) - len(want) + 1):
        if words[i:i + len(want)] == want:
            hits.append([t["id"] for t in toks[i:i + len(want)]])
    return hits


def _spec_slots(p, spec, reg):
    idx = tok_index(p)
    for k in spec.get("keep") or []:
        for tid in k.get("tokens", []):
            if tid not in idx:
                raise WTError(f"keep names a token that does not exist: {tid}", "use a token id from the template")
            idx[tid]["keep_reason"] = k.get("reason", "")
    for s in spec.get("slots") or []:
        if "id" not in s or "type" not in s:
            raise WTError(f"a spec slot needs id and type: {s}", "add \"id\" and \"type\" (any word, e.g. NUMBER) to the slot")
        groups = []
        if s.get("tokens"):
            groups.append(s["tokens"])
        if s.get("range"):
            d = s.get("dim") or next(iter(idx.get(s["range"][0], {}).get("dims", {})), None)
            toks = dim_tokens(p, d) if d else []
            pos = {t["id"]: i for i, t in enumerate(toks)}
            a, b = pos.get(s["range"][0]), pos.get(s["range"][1])
            if a is None or b is None:
                raise WTError(f"slot {s['id']}: range {s['range']} is not inside one dimension's tokens",
                              "give both ends as token ids of the same dimension, and set \"dim\"")
            groups.append([t["id"] for t in toks[a:b + 1]])
        for m in s.get("match") or []:
            hits = _phrase_hits(p, m["dim"], m["phrase"], reg)
            if not hits and not m.get("optional"):
                raise WTError(f"slot {s['id']}: phrase {m['phrase']!r} not found in {m['dim']}",
                              "copy the phrase exactly as the creator said or wrote it, or mark it \"optional\": true")
            groups.extend(hits)
        if not groups:
            raise WTError(f"slot {s['id']} covers no tokens", "give it tokens, a range or a match")
        for g in groups:
            mark_slot(p, g, s["id"], s["type"], s.get("note", ""), dims=s.get("dims"), rule=s.get("rule", "spec"),
                      _inplace=True, registry=reg)


def _auto_slots(p, spec, reg, lang):
    rules = {r["test"]: r for r in reg.slot_rules.get("auto", [])}
    numw = set(reg.slot_rules.get("number_words", {}).get(lang, []))
    funcw = set(reg.slot_rules.get("function_words", {}).get(lang, []))
    products = [[norm(w) for w in split_words(x, reg)] for x in spec.get("product_names", [])]
    idx = tok_index(p)
    for d in [d for d, row in reg.dims.items() if row.get("auto_slot_rules")]:
        for ln in [l for l in p["lines"] if l["dim"] == d]:
            toks = [idx[i] for i in ln["tokens"]]
            words = [str(t["dims"][d]) for t in toks]
            kinds = [None] * len(toks)
            for i, w in enumerate(words):
                n = norm(w)
                if "has_digit_or_number_word" in rules and (re.search(r"\d", w) or n in numw):
                    kinds[i] = "has_digit_or_number_word"
            for ph in products:
                for i in range(len(toks) - len(ph) + 1):
                    if ph and [norm(w) for w in words[i:i + len(ph)]] == ph and "product_phrase" in rules:
                        for k in range(i, i + len(ph)):
                            kinds[k] = "product_phrase"
            for i, w in enumerate(words):
                first = i == 0 or _sentence_end(words[i - 1]) or words[i - 1] == BREAK or str(words[i - 1]).endswith(":")
                letters = [c for c in w if c.isalpha()]
                shouting = len(letters) > 1 and all(c.isupper() for c in letters)
                if kinds[i] is None and "capital_mid_sentence" in rules and w[:1].isupper() and w[:1] != w[:1].lower() \
                        and not first and not shouting and norm(w) not in funcw:
                    kinds[i] = "capital_mid_sentence"
            i = 0
            while i < len(toks):
                if kinds[i] is None or toks[i].get("mark") == "SLOT" or "keep_reason" in toks[i]:
                    i += 1
                    continue
                j = i + 1
                while j < len(toks) and kinds[j] == kinds[i] and toks[j].get("mark") != "SLOT" and "keep_reason" not in toks[j]:
                    j += 1
                r = rules[kinds[i]]
                key = "-".join(norm(w) for w in words[i:j]) if r["test"] != "has_digit_or_number_word" else toks[i]["id"]
                sid = f"auto-{r['type'].lower()}-{key}"
                mark_slot(p, [t["id"] for t in toks[i:j]], sid, r["type"], r["note"], dims=[d], rule=r["id"], _inplace=True, _idx=idx)
                i = j
        # a name seen once inside a sentence is a name everywhere in this dimension
        named = {}
        for t in dim_tokens(p, d):
            if t.get("mark") == "SLOT" and str(t.get("slot", "")).startswith("auto-name-"):
                named[norm(str(t["dims"][d]))] = t
        for t in dim_tokens(p, d):
            n = norm(str(t["dims"][d]))
            w0 = str(t["dims"][d])[:1]
            if t.get("mark") != "SLOT" and "keep_reason" not in t and n in named and n not in funcw and w0.isupper():
                src = named[n]
                mark_slot(p, [t["id"]], f"auto-name-{n}", src["slot_type"], src["slot_note"], dims=[d],
                          rule="R4-name", _inplace=True, _idx=idx)


# ================================================================ marks

def mark_keep(p, ids, reason="", _inplace=False):
    p = _check_piece(p if _inplace else copy.deepcopy(p))
    idx = tok_index(p)
    for tid in ids:
        t = idx.get(tid)
        if not t:
            raise WTError(f"mark_keep: no token {tid!r} in {p['piece']['id']}", "use an id from the piece's tokens")
        for k in ("slot", "slot_type", "slot_note", "slot_dims"):
            t.pop(k, None)
        t["mark"], t["keep_reason"] = "KEEP", reason
    _drop_unused_slots(p)
    _prov(p, "mark_keep", tokens=len(ids))
    return p


def mark_slot(p, ids, slot, type_, note="", dims=None, rule="manual", _inplace=False, registry=None, _idx=None):
    p = _check_piece(p if _inplace else copy.deepcopy(p))
    reg = None
    if not slot or not type_:
        raise WTError("mark_slot needs a slot id and a type", "pass slot='my-slot' and a type word such as NUMBER")
    idx = _idx if _idx is not None else tok_index(p)
    for tid in ids:
        t = idx.get(tid)
        if not t:
            raise WTError(f"mark_slot: no token {tid!r} in {p['piece']['id']}", "use an id from the piece's tokens")
        t.update({"mark": "SLOT", "slot": slot, "slot_type": type_, "slot_note": note})
        t.pop("keep_reason", None)
        sd = dims or t.get("slot_dims")
        if not sd:
            if reg is None:
                reg = registry or Registry.load(p.get("registry"))
            alld = [d for d in t["dims"] if d != "drift.status"]
            sd = [d for d in alld if reg.is_text(d)] or alld
        t["slot_dims"] = list(sd)
    s = p["slots"].setdefault(slot, {"type": type_, "note": note, "rule": rule})
    if s["type"] != type_:
        p["conflicts"].append({"slot": slot, "dim": "type", "values": [{"value": s["type"]}, {"value": type_}]})
    _prov(p, "mark_slot", slot=slot, tokens=len(ids)) if not _inplace else None
    return p


def _drop_unused_slots(p):
    used = {t.get("slot") for t in p["tokens"] if t.get("mark") == "SLOT"} | \
           {d["token"].get("slot") for d in p.get("deleted", [])}
    p["slots"] = {k: v for k, v in p["slots"].items() if k in used}


# ================================================================ fill

def fill(p, fills_doc, registry=None, root=None):
    p = _check_piece(copy.deepcopy(p))
    reg = registry or Registry.load(p.get("registry"))
    fills = (fills_doc or {}).get("fills", fills_doc or {})
    unknown = [k for k in fills if k not in p["slots"] and not k.startswith("_")]
    if unknown:
        raise WTError(f"fills name ids that are not slots of {p['piece']['id']}: {', '.join(unknown)}",
                      "use slot ids from the template's slots table; KEEP words cannot be changed by a fill")
    p["piece"]["kind"] = "fill"
    p["piece"]["fill_of"] = p["piece"]["id"]
    if fills_doc.get("piece_id"):
        p["piece"]["id"] = fills_doc["piece_id"]
    for sid, slot in p["slots"].items():
        e = fills.get(sid) or {}
        value = e.get("value")
        srcs = e.get("sources") if e.get("sources") is not None else e.get("source")
        status, chk, whys = judge_value(value, srcs, e.get("derived"), root)
        srcs = [srcs] if isinstance(srcs, str) else (srcs or [])
        # a source that is one of the person's recorded moments keeps where it plays (registry moment_spans)
        moments = [span for span in (source_span(s, reg, root) for s in srcs) if span] if status == "sourced" else []
        p["fills"][sid] = {"status": status, "value": value if status == "sourced" else None,
                           "offered": value if status == "unsourced" else None,
                           "sources": srcs, "moments": moments,
                           "check": chk, "derived": e.get("derived"), "why": whys,
                           "needs": e.get("needs"), "note": e.get("note")}
    for d in sorted({d for t in p["tokens"] for d in t["dims"]}):
        for kind, run in runs(dim_tokens(p, d), d):
            if kind == "KEEP":
                continue
            sid = run[0]["slot"]
            f = p["fills"].get(sid, {"status": "empty"})
            v = f.get("value")
            if isinstance(v, dict):
                v = v.get(d)
            if reg.is_text(d) or isinstance(run[0]["dims"].get(d), str):
                lead, _ = _edge_punct(run[0]["dims"][d])
                _, trail = _edge_punct(run[-1]["dims"][d])
                body = str(v) if v not in (None, "") else empty_text(p["slots"][sid])
                # A value that already carries the slot's edge punctuation ("$20,930" in a "$14,950" slot) keeps one copy.
                text = ("" if body.startswith(lead) else lead) + body + ("" if body.endswith(trail) else trail)
            else:
                text = v
            run[0]["dims"][d] = text
            run[0]["filled"] = f.get("status") == "sourced" and v not in (None, "")
            for t in run[1:]:
                t["dims"].pop(d, None)
    p["tokens"] = [t for t in p["tokens"] if t["dims"]]
    live = {t["id"] for t in p["tokens"]}
    for ln in p["lines"]:
        ln["tokens"] = [i for i in ln["tokens"] if i in live]
    _prov(p, "fill", slots=len(p["fills"]))
    return p


# ================================================================ drift

METRICS = {
    "abs_or_rel": lambda a, b, lim: (abs(float(a) - float(b)),
                                      max(lim.get("max", 0), lim.get("rel", 0) * abs(float(a)))),
    "one_minus_iou": lambda a, b, lim: (1 - _iou(a, b), lim.get("max", 0.5)),
    "cie76": lambda a, b, lim: (_de76(a, b), lim.get("max", 10)),
    "euclidean": lambda a, b, lim: (math.dist([float(x) for x in a], [float(x) for x in b]), lim.get("max", 0)),
}


def _iou(a, b):
    ax, ay, aw, ah = a
    bx, by, bw, bh = b
    ix = max(0, min(ax + aw, bx + bw) - max(ax, bx))
    iy = max(0, min(ay + ah, by + bh) - max(ay, by))
    inter = ix * iy
    union = aw * ah + bw * bh - inter
    return inter / union if union else 0.0


def _lab(hexs):
    h = str(hexs).lstrip("#")
    rgb = [int(h[i:i + 2], 16) / 255 for i in (0, 2, 4)]
    rgb = [((c + 0.055) / 1.055) ** 2.4 if c > 0.04045 else c / 12.92 for c in rgb]
    x = (rgb[0] * .4124 + rgb[1] * .3576 + rgb[2] * .1805) / .95047
    y = (rgb[0] * .2126 + rgb[1] * .7152 + rgb[2] * .0722)
    z = (rgb[0] * .0193 + rgb[1] * .1192 + rgb[2] * .9505) / 1.08883
    f = [c ** (1 / 3) if c > 0.008856 else 7.787 * c + 16 / 116 for c in (x, y, z)]
    return (116 * f[1] - 16, 500 * (f[0] - f[1]), 200 * (f[1] - f[2]))


def _de76(a, b):
    return math.dist(_lab(a), _lab(b))


def target_from_text(text, tpl, reg, column="line"):
    """Read a script (.md or .txt) as target words per text dimension. Order: fenced ```dim:<id>``` blocks;
    else a markdown table column whose header starts with 'line'; else the whole text for the template's
    main text dimension. Declared fills come from a <!-- word-template-fills {...} --> comment."""
    fills = {}
    m = re.search(r"<!--\s*word-template-fills\s*(\{.*?\})\s*-->", text, re.S)
    if m:
        import json
        fills = json.loads(m.group(1)).get("fills", {})
    by_dim = {}
    for fm in re.finditer(r"```dim:([^\s`]+)\n(.*?)```", text, re.S):
        by_dim.setdefault(fm.group(1), []).append(fm.group(2))
    if not by_dim:
        texts = [d for d in {d for t in tpl["tokens"] for d in t["dims"]} if reg.is_text(d)]
        main = max(texts, key=lambda d: len(dim_tokens(tpl, d))) if texts else None
        body = _table_column(text, column) or _strip_md(text)
        if main:
            by_dim[main] = [body]
    return {d: "\n".join(v) for d, v in by_dim.items()}, fills


def _table_column(text, head):
    """The column (header starting with `head`) holding the most words, across every table in the text."""
    tables, cur, col = [], [], None
    for line in text.splitlines() + [""]:
        if not line.strip().startswith("|"):
            if cur:
                tables.append(cur)
            cur, col = [], None
            continue
        cells = [c.strip() for c in line.strip().strip("|").split("|")]
        if col is None:
            col = next((i for i, c in enumerate(cells) if c.lower().startswith(head)), -1)
            continue
        if col < 0 or set("".join(cells)) <= set("-: "):
            continue
        if col < len(cells):
            cur.append(cells[col])
    if not tables:
        return ""
    best = max(tables, key=lambda t: sum(len(c.split()) for c in t))
    return _strip_md("\n".join(best))


def _strip_md(t):
    t = re.sub(r"<!--.*?-->", " ", t, flags=re.S)
    t = re.sub(r"<[^>]+>", " ", t)
    t = re.sub(r"\*\*|__|`", "", t)
    t = re.sub(r"(?m)^\s*(#+|>|[-*]\s)", "", t)
    return t


def drift(tpl, target, registry=None, root=None, exceptions=None, threshold=None, column="line"):
    """Compare a target (a piece, or script text) with a template. Returns the template annotated with
    drift.status per token; the full report is in piece['notes']['drift']."""
    tpl = _check_piece(copy.deepcopy(tpl), "template")
    reg = registry or Registry.load(tpl.get("registry"))
    if isinstance(target, str):
        texts, declared = target_from_text(target, tpl, reg, column)
        tdims = {d: [{"dims": {d: v}} for v in [texts[d]]] for d in texts}
        tname = "script text"
    else:
        target = _check_piece(target, "target")
        declared = target.get("fills") or {}
        tdims = {}
        for t in target["tokens"]:
            for d in t["dims"]:
                tdims.setdefault(d, []).append(t)
        tname = target["piece"]["id"]
    tpl_dims = []
    for t in tpl["tokens"]:
        for d in t["dims"]:
            if d not in tpl_dims and d != "drift.status":
                tpl_dims.append(d)
    rep = {"template": tpl["piece"]["id"], "target": tname, "dims": {}, "not_measured_in_target": [],
           "extra_in_target": [], "unknown": [], "pending_in_template": tpl.get("pending", []), "slots": {},
           "conflicts": tpl.get("conflicts", [])}
    exc = exceptions or []
    for d in tpl_dims + [d for d in tdims if d not in tpl_dims]:
        row = reg.dim(d)
        if d not in tdims:
            rep["not_measured_in_target"].append(d)
            continue
        if d not in tpl_dims:
            rep["extra_in_target"].append(d)
            continue
        if not row:
            rep["unknown"].append({"dim": d, "why": f"{d} is not in the registry; add a row to judge it"})
            continue
        kind = reg.kinds.get(row.get("value_kind"))
        if not kind:
            rep["unknown"].append({"dim": d, "why": f"value kind {row.get('value_kind')!r} is not in value_kinds"})
            continue
        res = _compare(tpl, d, tdims[d], declared, reg, row, kind, root, exc)
        rep["dims"][d] = res
        for sid, st in res.get("slot_runs", {}).items():
            prev = rep["slots"].get(sid)
            if prev is None or _worse(st["status"], prev["status"]):
                rep["slots"][sid] = st
    tot = sum(r["keep_total"] for r in rep["dims"].values())
    kept = sum(r["kept"] + r.get("excused", 0) for r in rep["dims"].values())
    rep["summary"] = {
        "keep_total": tot, "kept": kept, "keep_preserved_pct": round(100 * kept / tot, 1) if tot else 100.0,
        "inserted": sum(r.get("inserted", 0) for r in rep["dims"].values()),
        "new_words": sum(r.get("new_words", 0) for r in rep["dims"].values()),
        "unsourced_fills": sum(1 for s in rep["slots"].values() if s["status"] in ("unsourced", "reference-left")),
        "reference_values_left": sum(1 for s in rep["slots"].values() if s["status"] == "reference-left"),
        "empty_slots": sum(1 for s in rep["slots"].values() if s["status"] == "empty"),
        "removed_slots": sum(1 for s in rep["slots"].values() if s["status"] == "removed"),
        "sourced_slots": sum(1 for s in rep["slots"].values() if s["status"] == "sourced"),
        "judged_dims": len(rep["dims"]),
    }
    fails = []
    if not rep["dims"]:
        fails.append("no measured dimensions are shared by the template and target; nothing was judged")
    for d, r in rep["dims"].items():
        th = threshold if threshold is not None else reg.dim(d).get("drift", {}).get("threshold", 1.0)
        if r["keep_total"] and (r["kept"] + r.get("excused", 0)) / r["keep_total"] < th - 1e-9:
            fails.append(f"{d}: {r['pct']}% of KEEP preserved, needs {th * 100:.0f}%")
        if r.get("inserted_unexcused"):
            fails.append(f"{d}: {r['inserted_unexcused']} inserted value(s) not listed as exceptions")
    if rep["summary"]["unsourced_fills"]:
        fails.append(f"{rep['summary']['unsourced_fills']} slot fill(s) without a valid source")
    rep["check"] = {"pass": not fails, "fails": fails}
    status = {}
    for r in rep["dims"].values():
        for tid, st in r.get("token_status", {}).items():
            if tid not in status or _worse(st, status[tid]):
                status[tid] = st
    for t in tpl["tokens"]:
        if t["id"] in status:
            t["dims"]["drift.status"] = status[t["id"]]
    for r in rep["dims"].values():
        r.pop("token_status", None)
    tpl["notes"]["drift"] = rep
    tpl["piece"]["kind"] = "drift"
    _prov(tpl, "drift", target=tname)
    return tpl


_RANK = ["kept", "sourced", "empty", "excused", "removed", "deleted", "replaced", "inserted", "reference-left", "unsourced"]


def _worse(a, b):
    return _RANK.index(a) > _RANK.index(b) if a in _RANK and b in _RANK else False


def _declared_ok(declared, sid, root):
    f = declared.get(sid)
    if not f:
        return None
    val = f.get("value")
    st, _, _ = judge_value(val, f.get("sources") or f.get("source"), f.get("derived"), root)
    return val if st == "sourced" else None


def _compare(tpl, d, ttoks, declared, reg, row, kind, root, exc):
    lim = row.get("drift", {})
    pair = kind.get("pair", "sequence")
    toks = dim_tokens(tpl, d)
    res = {"kind": row.get("value_kind"), "pair": pair, "keep_total": 0, "kept": 0, "excused": 0, "deleted": 0,
           "replaced": 0, "inserted": 0, "inserted_unexcused": 0, "changes": [], "slot_runs": {}, "token_status": {},
           "lines": []}
    split = kind.get("split")
    if pair == "sequence":
        E = []
        for rk, run in runs(toks, d):
            line = (run[0].get("line") or {}).get(d)
            if rk == "KEEP":
                t = run[0]
                ws = _words(t["dims"][d], reg) if split else [t["dims"][d]]
                for w in ws:
                    n = norm(w) if split else norm_value(w)
                    if n != "" and n is not None:
                        E.append({"n": n, "k": "keep", "tok": t["id"], "line": line, "text": w})
                continue
            sid = run[0]["slot"]
            rid = f"{sid}@{run[0]['id']}"
            ref = " ".join(str(x["dims"][d]) for x in run)
            val = _declared_ok(declared, sid, root)
            if isinstance(val, dict):
                val = val.get(d)
            if val not in (None, ""):
                vs = _words(val, reg) if split else [val]
                for w in vs:
                    n = norm(w) if split else norm_value(w)
                    if n:
                        E.append({"n": n, "k": "fill", "slot": sid, "run": rid, "line": line, "text": w, "ref": ref,
                                  "toks": [x["id"] for x in run]})
            else:
                E.append({"n": SLOT_MARK, "k": "hole", "slot": sid, "run": rid, "line": line, "ref": ref,
                          "type": run[0].get("slot_type"), "toks": [x["id"] for x in run]})
        T = []
        for t in ttoks:
            v = t["dims"][d]
            for w in (_words(v, reg) if split else [v]):
                n = norm(w) if split else norm_value(w)
                if n not in ("", None):
                    T.append({"n": n, "text": w})
        if not any(e["n"] == BREAK for e in E):
            T = [x for x in T if x["n"] != BREAK]
        sm = difflib.SequenceMatcher(None, [e["n"] for e in E], [x["n"] for x in T], autojunk=False)
        seg = {}

        def add(line, s):
            seg.setdefault(line, []).append(s)

        def run_status(e, st, got=None):
            r = res["slot_runs"].setdefault(e["run"], {"slot": e["slot"], "status": st, "line": e["line"],
                                                       "reference": e["ref"], "target": []})
            if _worse(st, r["status"]):
                r["status"] = st
            if got:
                r["target"].extend(got)
            for tid in e.get("toks", []):
                res["token_status"][tid] = r["status"]

        for op, i1, i2, j1, j2 in _anchored(sm.get_opcodes(), reg.tokenizer.get("min_anchor_words", 2),
                                            reg.tokenizer.get("anchor_context_words", 4)):
            es, ts = E[i1:i2], T[j1:j2]
            if op != "equal":
                res["new_words"] = res.get("new_words", 0) + sum(1 for x in ts if x["n"] != SLOT_MARK)
            if op == "equal":
                for e, x in zip(es, ts):
                    if e["k"] == "keep":
                        res["kept"] += 1
                        res["token_status"][e["tok"]] = "kept"
                        add(e["line"], x["text"])
                    elif e["k"] == "fill":
                        run_status(e, "sourced", [x["text"]])
                        if seg.get(e["line"]) and seg[e["line"]][-1].endswith(">>") and seg[e["line"]][-1].startswith("<<"):
                            seg[e["line"]][-1] = seg[e["line"]][-1][:-2] + f" {x['text']}>>"
                        else:
                            add(e["line"], f"<<{x['text']}>>")
                    else:
                        run_status(e, "empty", [x["text"]])
                        add(e["line"], f"[{e.get('type')}: empty]")
                continue
            line = (es[0] if es else (E[i1 - 1] if i1 > 0 and E else (E[0] if E else {"line": None})))["line"]
            words_t = [x["text"] for x in ts]
            if op == "insert":
                if i1 > 0 and E[i1 - 1]["k"] != "keep":       # words right after a slot: the fill ran longer
                    e = E[i1 - 1]
                    run_status(e, "unsourced", words_t)
                    add(e["line"], "{+" + " ".join(words_t) + "+}(slot " + e["slot"] + ")")
                    continue
                exc_hit = _excused(exc, d, line, "inserted", words_t)
                res["inserted"] += len(ts)
                if not exc_hit:
                    res["inserted_unexcused"] += len(ts)
                res["changes"].append({"op": "inserted", "line": line, "words": " ".join(words_t), "excused": exc_hit})
                add(line, "{+" + " ".join(words_t) + "+}")
                continue
            groups = []
            for e in es:
                if groups and groups[-1][0] == e["line"]:
                    groups[-1][1].append(e)
                else:
                    groups.append((e["line"], [e]))
            for gi, (gline, ges) in enumerate(groups):
                here = words_t if gi == 0 else []
                keeps = [e for e in ges if e["k"] == "keep"]
                slots_ = [e for e in ges if e["k"] != "keep"]
                if keeps:
                    kind_ = "deleted" if not here else "replaced"
                    exc_hit = _excused(exc, d, gline, kind_, [e["text"] for e in keeps])
                    if exc_hit:
                        res["excused"] += len(keeps)
                    res[kind_] += len(keeps)
                    for e in keeps:
                        res["token_status"][e["tok"]] = "excused" if exc_hit else kind_
                    res["changes"].append({"op": kind_, "line": gline, "words": " ".join(e["text"] for e in keeps),
                                           "by": " ".join(here) if not slots_ else "", "excused": exc_hit})
                first = True
                for e in slots_:
                    if not here:
                        run_status(e, "removed")
                    else:
                        got = here if first else []
                        same_as_ref = norm_value(" ".join(here)) == norm_value(e["ref"])
                        run_status(e, "reference-left" if same_as_ref else "unsourced", got)
                        first = False
                old = " ".join(e.get("text") or e["ref"] for e in ges)
                add(gline, "[-" + old + "-]" + ("{+" + " ".join(here) + "+}" if here else ""))
        res["keep_total"] = sum(1 for e in E if e["k"] == "keep")
        per = {}
        for e in E:
            if e["k"] == "keep":
                per.setdefault(e["line"], [0, 0])[0] += 1
        for e in E:
            if e["k"] == "keep" and res["token_status"].get(e["tok"]) in ("kept", "excused"):
                per[e["line"]][1] += 1
        order = []
        for ln in tpl["lines"]:
            if ln["dim"] == d:
                order.append(ln["id"])
        for lid in order + [k for k in seg if k not in order]:
            tot, kp = per.get(lid, [0, 0])
            res["lines"].append({"line": lid, "job": next((l.get("job") for l in tpl["lines"] if l["id"] == lid), None),
                                 "keep_total": tot, "kept": kp, "pct": round(100 * kp / tot, 1) if tot else 100.0,
                                 "view": " ".join(seg.get(lid, []))})
    elif pair in ("order", "time"):
        T = [t for t in ttoks]
        if pair == "time":
            pairs, used = [], set()
            tol = lim.get("tolerance_s", 0.1)
            for t in sorted(toks, key=lambda x: x.get("t") or 0):
                best = None
                for k, x in enumerate(T):
                    if k in used or x.get("t") is None or t.get("t") is None:
                        continue
                    dt = abs(x["t"] - t["t"])
                    if dt <= tol and (not lim.get("match_value") or norm_value(x["dims"][d]) == norm_value(t["dims"][d])):
                        if best is None or dt < best[0]:
                            best = (dt, k)
                if best:
                    used.add(best[1])
                pairs.append((t, T[best[1]] if best else None))
            res["extra"] = len(T) - len(used)
        else:
            pairs = [(t, T[i] if i < len(T) else None) for i, t in enumerate(toks)]
            res["extra"] = max(0, len(T) - len(toks))
        for t, x in pairs:
            sid = t.get("slot") if t.get("mark") == "SLOT" and d in slot_dims(t) else None
            if sid:
                val = _declared_ok(declared, sid, root)
                if isinstance(val, dict):
                    val = val.get(d)
                got = x["dims"][d] if x else None
                st = "removed" if x is None else ("sourced" if val is not None and _same(kind, lim, val, got) else
                                                  ("reference-left" if _same(kind, lim, t["dims"][d], got) else
                                                   ("empty" if got is None or (isinstance(got, str) and got.startswith("[")) else "unsourced")))
                rid = f"{sid}@{t['id']}"
                res["slot_runs"][rid] = {"slot": sid, "status": st, "line": t.get("unit"), "reference": t["dims"][d],
                                         "target": [got]}
                res["token_status"][t["id"]] = st
                continue
            res["keep_total"] += 1
            if x is not None and (pair == "time" and not kind.get("metric") or _same(kind, lim, t["dims"][d], x["dims"][d])):
                res["kept"] += 1
                res["token_status"][t["id"]] = "kept"
            else:
                op = "deleted" if x is None else "replaced"
                exc_hit = _excused(exc, d, t.get("unit"), op, [str(t["dims"][d])])
                res[op] += 1
                res["excused"] += 1 if exc_hit else 0
                res["token_status"][t["id"]] = "excused" if exc_hit else op
                res["changes"].append({"op": op, "line": t.get("unit"), "token": t["id"], "words": str(t["dims"][d]),
                                       "by": "" if x is None else str(x["dims"][d]), "excused": exc_hit})
    else:
        raise WTError(f"value kind {row.get('value_kind')!r} has pair {pair!r}, which drift does not know",
                      "use pair: sequence, order or time in value_kinds")
    res["pct"] = round(100 * (res["kept"] + res["excused"]) / res["keep_total"], 1) if res["keep_total"] else 100.0
    return res


def _anchored(ops, min_words, context):
    """An equal run shorter than min_words, between two changes whose target side holds at least `context`
    words together, is a chance match ('the', 'and' inside rewritten text): count it as changed."""
    ops = [list(o) for o in ops]
    for k, o in enumerate(ops):
        if o[0] == "equal" and (o[2] - o[1]) < min_words and 0 < k < len(ops) - 1:
            a, b = ops[k - 1], ops[k + 1]
            if a[0] != "equal" and b[0] != "equal" and (a[4] - a[3]) + (b[4] - b[3]) >= context:
                o[0] = "replace"
    out = []
    for o in ops:
        if out and o[0] != "equal" and out[-1][0] != "equal":
            prev = out[-1]
            i1, i2, j1, j2 = prev[1], o[2], prev[3], o[4]
            out[-1] = ["replace" if i2 > i1 and j2 > j1 else ("delete" if j2 == j1 else "insert"), i1, i2, j1, j2]
        else:
            out.append(o)
    return [tuple(o) for o in out]


def _same(kind, lim, a, b):
    if b is None:
        return False
    test = kind.get("test", "equal")
    if test in ("equal", "equal_if"):
        return norm_value(a) == norm_value(b)
    if test == "distance":
        m = METRICS.get(kind.get("metric"))
        if not m:
            raise WTError(f"metric {kind.get('metric')!r} is not defined", f"use one of {', '.join(METRICS)} or add it to wt_ops.METRICS")
        try:
            dist, mx = m(a, b, lim)
        except (TypeError, ValueError):
            return False
        return dist <= mx + 1e-9
    raise WTError(f"test {test!r} is not defined", "use test: equal, equal_if or distance in value_kinds")


def _excused(exc, d, line, op, words):
    w = norm_value(" ".join(words))
    for e in exc:
        if e.get("dim", d) == d and e.get("op", op) == op and (e.get("line") in (None, line)) \
                and norm_value(e.get("words", "")) == w and e.get("reason"):
            return e["reason"]
    return None


def diff(a, b, registry=None, root=None):
    return drift(a, b, registry, root)


# ================================================================ merge / fork / nest / xref / delete / restore

def merge(a, b):
    a = _check_piece(copy.deepcopy(a), "first piece")
    b = _check_piece(b, "second piece")
    idx = tok_index(a)
    for t in b["tokens"]:
        if t["id"] not in idx:
            nt = copy.deepcopy(t)
            a["tokens"].append(nt)
            idx[t["id"]] = nt
            continue
        mine = idx[t["id"]]
        for d, v in t["dims"].items():
            if d not in mine["dims"]:
                mine["dims"][d] = v
            elif mine["dims"][d] != v and d != "drift.status":
                a["conflicts"].append({"token": t["id"], "dim": d, "values": [
                    {"value": mine["dims"][d], "from": a["piece"]["id"]}, {"value": v, "from": b["piece"]["id"]}]})
        if t.get("mark") == "SLOT" and mine.get("mark") != "SLOT":
            for k in ("mark", "slot", "slot_type", "slot_note", "slot_dims"):
                if k in t:
                    mine[k] = t[k]
        for r in t.get("refs", []):
            if r not in mine.setdefault("refs", []):
                mine["refs"].append(r)
    for sid, s in b["slots"].items():
        if sid in a["slots"] and a["slots"][sid].get("type") != s.get("type"):
            a["conflicts"].append({"slot": sid, "dim": "type", "values": [{"value": a["slots"][sid]["type"]}, {"value": s["type"]}]})
        a["slots"].setdefault(sid, copy.deepcopy(s))
    have_u = {u["id"] for u in a["units"]}
    a["units"] += [copy.deepcopy(u) for u in b["units"] if u["id"] not in have_u]
    have_l = {l["id"] for l in a["lines"]}
    a["lines"] += [copy.deepcopy(l) for l in b["lines"] if l["id"] not in have_l]
    for sid, f in b.get("fills", {}).items():
        a["fills"].setdefault(sid, copy.deepcopy(f))
    a["includes"] += [x for x in b.get("includes", []) if x not in a["includes"]]
    measured = {d for t in a["tokens"] for d in t["dims"]}
    seen, pend = set(), []
    for x in a["pending"] + b.get("pending", []):
        if x["dim"] not in measured and x["dim"] not in seen:
            seen.add(x["dim"])
            pend.append(x)
    a["pending"] = pend
    a["piece"]["built_from"] = a["piece"].get("built_from", []) + b["piece"].get("built_from", [])
    _prov(a, "merge", with_=b["piece"]["id"])
    return a


def fork(a, new_id=None):
    a = _check_piece(copy.deepcopy(a))
    old = a["piece"]["id"]
    a["piece"]["id"] = new_id or f"{old}~fork"
    _prov(a, "fork", from_=old)
    return a


def nest(parent, child, at=None):
    """Put a whole piece inside another (an episode inside a series, an object inside a scene). The child's
    ids are prefixed '<child id>::' so nesting any depth, or a piece inside itself, never collides."""
    parent = _check_piece(copy.deepcopy(parent), "parent piece")
    child = _check_piece(copy.deepcopy(child), "child piece")
    pre = f"{child['piece']['id']}::"
    n = sum(1 for x in parent["includes"] if x["id"].startswith(child["piece"]["id"]))
    if n:
        pre = f"{child['piece']['id']}#{n + 1}::"
    if at is not None and at not in tok_index(parent) and at not in {u["id"] for u in parent["units"]}:
        raise WTError(f"nest: {at!r} is not a token or unit of {parent['piece']['id']}", "pass at=<an existing token or unit id>, or at=None")

    def P(x):
        return None if x is None else pre + str(x)
    for t in child["tokens"]:
        t["id"] = P(t["id"])
        t["unit"] = P(t.get("unit"))
        if t.get("parent") is not None:
            t["parent"] = P(t["parent"])
        else:
            t["parent"] = at
        if t.get("slot"):
            t["slot"] = P(t["slot"])
        for r in t.get("refs", []):
            r["to"] = P(r["to"]) if not str(r["to"]).startswith(pre) else r["to"]
        if isinstance(t.get("line"), dict):
            t["line"] = {d: P(l) for d, l in t["line"].items()}
        parent["tokens"].append(t)
    for u in child["units"]:
        u["id"] = P(u["id"])
        u.setdefault("parent", at)
        parent["units"].append(u)
    for l in child["lines"]:
        l["id"] = P(l["id"])
        l["tokens"] = [P(x) for x in l["tokens"]]
        parent["lines"].append(l)
    for sid, s in child["slots"].items():
        parent["slots"][P(sid)] = s
    for sid, f in child.get("fills", {}).items():
        parent["fills"][P(sid)] = f
    parent["includes"].append({"id": pre[:-2], "at": at, "medium": child["piece"]["medium"]})
    _prov(parent, "nest", child=child["piece"]["id"], at=at)
    return parent


def xref(p, from_id, to_id, rel="refers_to"):
    p = _check_piece(copy.deepcopy(p))
    idx = tok_index(p)
    units = {u["id"] for u in p["units"]}
    if from_id not in idx:
        raise WTError(f"xref: no token {from_id!r}", "pass the id of an existing token as from_id")
    if to_id not in idx and to_id not in units:
        raise WTError(f"xref: no token or unit {to_id!r}", "pass the id of an existing token or unit as to_id (restore it first if it was deleted)")
    r = {"to": to_id, "rel": rel}
    if r not in idx[from_id].setdefault("refs", []):
        idx[from_id]["refs"].append(r)
    _prov(p, "xref", from_=from_id, to=to_id, rel=rel)
    return p


BIND_EDGES = ("start", "end")


def _bound_problem(b):
    """What is wrong with a token's bound_to field, or None. {"words": str, "edge": start|end (default start),
    "offset_s": number (default 0), "slot": slot id whose fill replaces words, "occurrence": integer >= 1}."""
    if not isinstance(b, dict) or not isinstance(b.get("words"), str) or not b["words"].strip():
        return "bound_to needs a non-empty words string"
    if b.get("edge", "start") not in BIND_EDGES:
        return f"bound_to edge {b.get('edge')!r} is not one of {BIND_EDGES}"
    off = b.get("offset_s", 0)
    if isinstance(off, bool) or not isinstance(off, (int, float)):
        return "bound_to offset_s must be a number of seconds"
    occ = b.get("occurrence", 1)
    if isinstance(occ, bool) or not isinstance(occ, int) or occ < 1:
        return "bound_to occurrence must be an integer of 1 or more"
    if "slot" in b and not isinstance(b["slot"], str):
        return "bound_to slot must be a slot id"
    return None


def bind(p, ids, words, edge="start", offset_s=0, slot=None, occurrence=1):
    """Record the word or phrase each token responds to (`bound_to`, beside its time). The binding is about words, so
    it holds for a transition, a graphic, a slide, a caption or a page section alike."""
    p = _check_piece(copy.deepcopy(p))
    b = {"words": words, "edge": edge, "offset_s": offset_s, "occurrence": occurrence}
    if slot is not None:
        b["slot"] = slot
    bad = _bound_problem(b)
    if bad:
        raise WTError(f"bind: {bad}", "pass words as text, edge as start or end, offset_s as seconds")
    if slot is not None and slot not in p["slots"]:
        raise WTError(f"bind: no slot {slot!r}", "use a slot id from the template's slots table")
    idx = tok_index(p)
    missing = [i for i in ids if i not in idx]
    if missing:
        raise WTError(f"bind: no token {missing[0]!r}", "pass ids of existing tokens")
    for i in ids:
        idx[i]["bound_to"] = dict(b)
    _prov(p, "bind", tokens=len(ids), words=words)
    return p


def _find_words(timed, want, occurrence):
    """The occurrence-th run of timed words whose normalised text equals want, or None."""
    toks = [(norm(r["fields"]["text"]), r) for r in timed if r.get("t0") is not None and r.get("t1") is not None]
    toks = [(w, r) for w, r in toks if w]
    seen = 0
    for i in range(len(toks) - len(want) + 1):
        if [w for w, _ in toks[i:i + len(want)]] == want:
            seen += 1
            if seen == occurrence:
                return [r for _, r in toks[i:i + len(want)]]
    return None


def retime(p, timed, registry=None):
    """Move every bound token to where its words now play. `timed` is word-timed records (transcript_words reader:
    {"t0", "t1", "fields": {"text"}}) of the rewritten script. A token bound to a slot follows the slot's sourced fill
    value. A token whose words are not in `timed` keeps its time and is listed as unmatched. A token with an end
    time keeps its length. The result is listed in notes.retime."""
    p = _check_piece(copy.deepcopy(p))
    reg = registry or Registry.load(p.get("registry"))
    rows = []
    for t in p["tokens"]:
        b = t.get("bound_to")
        if b is None:
            continue
        bad = _bound_problem(b)
        if bad:
            raise WTError(f"retime: token {t['id']}: {bad}", "rebind the token with bind()")
        fill_value = (p["fills"].get(b.get("slot")) or {}).get("value") if b.get("slot") else None
        phrase = fill_value if isinstance(fill_value, str) and fill_value.strip() else b["words"]
        want = [norm(w) for w in split_words(phrase, reg) if norm(w)]
        hit = _find_words(timed, want, b.get("occurrence", 1)) if want else None
        row = {"token": t["id"], "phrase": phrase, "from": t.get("t"), "to": t.get("t"), "status": "moved"}
        if hit is None:
            row.update(status="unmatched", why="these words are not in the new transcript; the time is unchanged")
        else:
            new_t = round((hit[0]["t0"] if b.get("edge", "start") == "start" else hit[-1]["t1"]) + b.get("offset_s", 0), 3)
            if t.get("t1") is not None and t.get("t") is not None:
                t["t1"] = round(t["t1"] + (new_t - t["t"]), 3)
            t["t"] = row["to"] = new_t
        rows.append(row)
    p["notes"]["retime"] = rows
    _prov(p, "retime", bound=len(rows), moved=sum(r["status"] == "moved" for r in rows))
    return p


def delete(p, ids):
    p = _check_piece(copy.deepcopy(p))
    ids = list(ids)
    pos = {t["id"]: i for i, t in enumerate(p["tokens"])}
    missing = [i for i in ids if i not in pos]
    if missing:
        raise WTError(f"delete: no token(s) {', '.join(map(str, missing[:5]))}", "pass ids of tokens that exist (deleted ones are under 'deleted')")
    gone = set(ids)
    for tid in ids:
        lines = {l["id"]: l["tokens"].index(tid) for l in p["lines"] if tid in l["tokens"]}
        p["deleted"].append({"token": p["tokens"][pos[tid]], "index": pos[tid], "lines": lines})
    p["tokens"] = [t for t in p["tokens"] if t["id"] not in gone]
    for l in p["lines"]:
        l["tokens"] = [x for x in l["tokens"] if x not in gone]
    _prov(p, "delete", tokens=len(ids))
    return p


def restore(p, ids=None):
    p = _check_piece(copy.deepcopy(p))
    want = set(ids) if ids is not None else {d["token"]["id"] for d in p["deleted"]}
    have = {t["id"] for t in p["tokens"]}
    keep, back = [], []
    for d in p["deleted"]:
        (back if d["token"]["id"] in want and d["token"]["id"] not in have else keep).append(d)
    missing = want - {d["token"]["id"] for d in back} - have
    if ids is not None and missing:
        raise WTError(f"restore: {', '.join(sorted(map(str, missing))[:5])} not in the deleted list", "pass ids listed under the piece's 'deleted'")
    for d in sorted(back, key=lambda x: x["index"]):
        p["tokens"].insert(min(d["index"], len(p["tokens"])), d["token"])
        for lid, k in d.get("lines", {}).items():
            for l in p["lines"]:
                if l["id"] == lid and d["token"]["id"] not in l["tokens"]:
                    l["tokens"].insert(min(k, len(l["tokens"])), d["token"]["id"])
    p["deleted"] = keep
    _prov(p, "restore", tokens=len(back))
    return p


# ================================================================ aggregate (family template)

def aggregate(pieces, family_id="family", registry=None):
    """Fold many pieces into one family template, one piece at a time (memory = one family + one piece).
    A value every member shares stays KEEP; a value that differs becomes a VARIES slot."""
    it = iter(pieces)
    try:
        fam = fork(next(it), family_id)
    except StopIteration:
        raise WTError("aggregate got no pieces", "pass at least one piece")
    fam["piece"]["kind"] = "family"
    fam["piece"]["members"] = [fam["piece"]["provenance"][-1].get("from_")]
    for other in it:
        other = _check_piece(other, "family member")
        fam["piece"]["members"].append(other["piece"]["id"])
        for d in {d for t in fam["tokens"] for d in t["dims"]} - {"drift.status"}:
            mine = [t for t in dim_tokens(fam, d) if t.get("mark") == "KEEP"]
            theirs = dim_tokens(other, d)
            if not theirs:
                continue
            a = [norm_value(t["dims"][d]) for t in mine]
            b = [norm_value(t["dims"][d]) for t in theirs]
            sm = difflib.SequenceMatcher(None, a, b, autojunk=False)
            matched = set()
            for blk in sm.get_matching_blocks():
                matched.update(range(blk.a, blk.a + blk.size))
            for i, t in enumerate(mine):
                if i not in matched:
                    mark_slot(fam, [t["id"]], f"varies-{t['id']}", "VARIES",
                              f"differs across the family (first seen: {t['dims'][d]!r})", dims=[d], rule="aggregate",
                              _inplace=True)
    _prov(fam, "aggregate", members=len(fam["piece"]["members"]))
    return fam


# ================================================================ validate

def validate(p, registry=None):
    """Problems in a piece, each with what and fix. Errors break the piece; warnings are listed."""
    errs, warns = [], []
    try:
        _check_piece(p)
    except WTError as e:
        return [{"what": e.what, "fix": e.fix}], []
    reg = registry
    ids = [t["id"] for t in p["tokens"]]
    if len(ids) != len(set(ids)):
        dup = sorted({i for i in ids if ids.count(i) > 1})[:5]
        errs.append({"what": f"token ids used twice: {dup}", "fix": "nest or fork the piece instead of copying tokens"})
    idset, units = set(ids), {u["id"] for u in p["units"]}
    for t in p["tokens"]:
        if not isinstance(t.get("dims"), dict):
            errs.append({"what": f"token {t['id']} has no dims", "fix": "give it dims: {}"})
        if t.get("mark") not in ("KEEP", "SLOT"):
            errs.append({"what": f"token {t['id']} mark is {t.get('mark')!r}", "fix": "use KEEP or SLOT"})
        if t.get("mark") == "SLOT" and t.get("slot") not in p["slots"]:
            errs.append({"what": f"token {t['id']} names slot {t.get('slot')!r} that is not in slots", "fix": "mark_slot again, or mark_keep it"})
        if "bound_to" in t and _bound_problem(t["bound_to"]):
            errs.append({"what": f"token {t['id']}: {_bound_problem(t['bound_to'])}", "fix": "rebind the token with bind()"})
        for r in t.get("refs", []):
            if r["to"] not in idset and r["to"] not in units:
                warns.append({"what": f"token {t['id']} refers to {r['to']}, which is not present (deleted?)",
                              "fix": "restore the target or remove the ref"})
        if reg:
            for d in t["dims"]:
                if not reg.dim(d):
                    warns.append({"what": f"dimension {d} on {t['id']} is not in the registry", "fix": f"add a row for {d} to {reg.path}"})
    for l in p["lines"]:
        bad = [x for x in l["tokens"] if x not in idset]
        if bad:
            errs.append({"what": f"line {l['id']} lists tokens that do not exist: {bad[:3]}", "fix": "restore them or rebuild lines"})
    return errs, warns
