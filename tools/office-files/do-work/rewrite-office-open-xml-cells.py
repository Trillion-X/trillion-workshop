#!/usr/bin/env python3
# tools/office-files/do-work/rewrite-office-open-xml-cells.py
#
# PURPOSE: Rewrite cells and shared strings inside an existing workbook from a
# DATA rule list, producing a new file. The sibling decoder reads; this writes
# back the same container with only the matched cells changed. Every other
# byte of every part is copied verbatim, so styles, charts and formatting
# survive.
#
# NON-NEGOTIABLE INVARIANTS
# 1. Standard library only. The input file is never modified; a new path is written.
# 2. A rule says WHAT to match and WHAT to set. This file knows no sheet name,
#    no formula, no domain word; all of that arrives as DATA.
# 3. A rule that matches nothing is reported, never silently accepted.
# 4. Cached values are rewritten alongside formulas so the next reader sees
#    the intended value without a recalculation pass.
#
# RULES FILE (JSON array). Each rule is one of:
#   {"kind": "cell", "sheet": "<name or omitted for all>",
#    "match": {"formula_contains": "...", "value_equals": <json>},
#    "set": {"formula": "...", "value": <json>}}
#      value may be a number or a string; a string becomes an inline string cell.
#      "formula" may use {formula} to keep the matched formula text inside a new one.
#   {"kind": "shared-string", "match": {"equals": "..."}, "set": {"text": "..."}}
#   {"kind": "shared-string", "match": {"contains": "..."}, "set": {"replace": ["old", "new"]}}
#   {"kind": "document-text", "part": "<optional word/document.xml>",
#    "match": {"equals": "..."} or {"contains": "..."},
#    "set": {"text": "..."} or {"replace": ["old", "new"]}}
#
# CLI:
#   rewrite-office-open-xml-cells.py <in.xlsx> <rules.json> <out.xlsx>
#   Emits one JSON report: {"rules": [{"index", "matched"}], "written": "<out>"}

import json
import re
import sys
import zipfile
import xml.etree.ElementTree as ET

NS_MAIN = "http://schemas.openxmlformats.org/spreadsheetml/2006/main"
NS_REL = "http://schemas.openxmlformats.org/officeDocument/2006/relationships"
NS_PKG_REL = "http://schemas.openxmlformats.org/package/2006/relationships"
NS_WORD = "http://schemas.openxmlformats.org/wordprocessingml/2006/main"
ET.register_namespace("", NS_MAIN)
ET.register_namespace("r", NS_REL)
ET.register_namespace("w", NS_WORD)


def _q(tag):
    return "{%s}%s" % (NS_MAIN, tag)


def _serialize(root):
    """One XML declaration shape for every part written back. Excel requires the
    standalone flag, and the standard library serializer has no argument for it."""
    body = ET.tostring(root, encoding="unicode")
    return ('<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n' + body).encode("utf-8")


def _sheet_parts(z):
    wb = ET.fromstring(z.read("xl/workbook.xml"))
    rels = ET.fromstring(z.read("xl/_rels/workbook.xml.rels"))
    target_by_id = {}
    for r in rels.findall("{%s}Relationship" % NS_PKG_REL):
        t = r.get("Target")
        target_by_id[r.get("Id")] = (t if t.startswith("/") else "xl/" + t).lstrip("/")
    return {s.get("name"): target_by_id[s.get("{%s}id" % NS_REL)]
            for s in wb.find(_q("sheets")).findall(_q("sheet"))}


def _rewrite_document_text(parts, rules, counts):
    """Apply DATA text rules to WordprocessingML text nodes without disturbing runs."""
    word_names = [n for n in parts if n == "word/document.xml" or
                  (n.startswith("word/") and n.endswith(".xml") and
                   n not in ("word/settings.xml", "word/styles.xml", "word/webSettings.xml"))]
    for name in word_names:
        root = ET.fromstring(parts[name])
        touched = False
        for idx, rule in enumerate(rules):
            if rule.get("kind") != "document-text":
                continue
            if rule.get("part") and rule["part"] != name:
                continue
            m, s = rule["match"], rule["set"]
            for t in root.iter("{%s}t" % NS_WORD):
                text = t.text or ""
                hit = ("equals" in m and text == m["equals"]) or ("contains" in m and m["contains"] in text)
                if not hit:
                    continue
                new = s["text"] if "text" in s else text.replace(s["replace"][0], s["replace"][1])
                if new != text:
                    t.text = new
                    if new[:1].isspace() or new[-1:].isspace():
                        t.set("{http://www.w3.org/XML/1998/namespace}space", "preserve")
                    counts[idx] += 1
                    touched = True
        if touched:
            parts[name] = _serialize(root)


def _cell_value(c, strings):
    t = c.get("t")
    v = c.find(_q("v"))
    if t == "s" and v is not None:
        return strings[int(v.text)]
    if t == "inlineStr":
        return "".join(x.text or "" for x in c.iter(_q("t")))
    if v is None or v.text is None:
        return None
    if t in ("str", "e"):
        return v.text
    if t == "b":
        return v.text == "1"
    try:
        return float(v.text)
    except ValueError:
        return v.text


def _matches(c, strings, match):
    f = c.find(_q("f"))
    if "formula_contains" in match:
        if f is None or f.text is None or match["formula_contains"] not in f.text:
            return False
    if "value_equals" in match:
        got = _cell_value(c, strings)
        want = match["value_equals"]
        if isinstance(want, (int, float)) and isinstance(got, (int, float)):
            if float(got) != float(want):
                return False
        elif got != want:
            return False
    if "text_contains" in match:
        got = _cell_value(c, strings)
        if not isinstance(got, str) or match["text_contains"] not in got:
            return False
    return True


def _apply_set(c, setting):
    f = c.find(_q("f"))
    if "formula" in setting or "formula_replace" in setting:
        old = f.text if (f is not None and f.text) else ""
        if f is None:
            f = ET.SubElement(c, _q("f"))
            c.remove(f)
            c.insert(0, f)
        if "formula_replace" in setting:
            a, b = setting["formula_replace"]
            f.text = old.replace(a, b)
        else:
            f.text = setting["formula"].replace("{formula}", old)
    if "text_replace" in setting:
        a, b = setting["text_replace"]
        current = _cell_value(c, [])
        if c.get("t") == "inlineStr":
            for t in c.iter(_q("t")):
                t.text = (t.text or "").replace(a, b)
        elif isinstance(current, str):
            setting = dict(setting)
            setting["value"] = current.replace(a, b)
    if "value" in setting:
        for child in list(c):
            if child.tag in (_q("v"), _q("is")):
                c.remove(child)
        val = setting["value"]
        if isinstance(val, str):
            # A formula cell keeps t="str"; a constant cell becomes an inline string.
            if c.find(_q("f")) is not None:
                c.set("t", "str")
                v = ET.SubElement(c, _q("v"))
                v.text = val
            else:
                c.set("t", "inlineStr")
                is_ = ET.SubElement(c, _q("is"))
                t = ET.SubElement(is_, _q("t"))
                t.text = val
        else:
            if "t" in c.attrib:
                del c.attrib["t"]
            v = ET.SubElement(c, _q("v"))
            v.text = repr(val) if isinstance(val, float) else str(val)


def main():
    if len(sys.argv) != 4:
        sys.stderr.write(__doc__ or "usage: in rules out\n")
        sys.exit(2)
    in_path, rules_path, out_path = sys.argv[1:4]
    with open(rules_path, encoding="utf-8") as fh:
        rules = json.load(fh)
    counts = [0] * len(rules)
    with zipfile.ZipFile(in_path) as zin:
        parts = {n: zin.read(n) for n in zin.namelist()}
        infos = {i.filename: i for i in zin.infolist()}

    _rewrite_document_text(parts, rules, counts)

    strings = []
    shared_root = None
    if "xl/sharedStrings.xml" in parts:
        shared_root = ET.fromstring(parts["xl/sharedStrings.xml"])
        for si in shared_root.findall(_q("si")):
            strings.append("".join(t.text or "" for t in si.iter(_q("t"))))

    # Shared-string rules.
    if shared_root is not None:
        for idx, rule in enumerate(rules):
            if rule.get("kind") != "shared-string":
                continue
            m, s = rule["match"], rule["set"]
            for si in shared_root.findall(_q("si")):
                text = "".join(t.text or "" for t in si.iter(_q("t")))
                hit = ("equals" in m and text == m["equals"]) or ("contains" in m and m["contains"] in text)
                if not hit:
                    continue
                new = s["text"] if "text" in s else text.replace(s["replace"][0], s["replace"][1])
                for child in list(si):
                    si.remove(child)
                t = ET.SubElement(si, _q("t"))
                t.text = new
                counts[idx] += 1
        parts["xl/sharedStrings.xml"] = _serialize(shared_root)
        strings = ["".join(t.text or "" for t in si.iter(_q("t"))) for si in shared_root.findall(_q("si"))]

    # Cell rules (spreadsheets only).
    if "xl/workbook.xml" in parts:
        with zipfile.ZipFile(in_path) as zin:
            sheets = _sheet_parts(zin)
        for name, part in sheets.items():
            root = ET.fromstring(parts[part])
            touched = False
            for idx, rule in enumerate(rules):
                if rule.get("kind") != "cell":
                    continue
                if rule.get("sheet") and rule["sheet"] != name:
                    continue
                for c in root.iter(_q("c")):
                    if _matches(c, strings, rule["match"]):
                        _apply_set(c, rule["set"])
                        counts[idx] += 1
                        touched = True
            if touched:
                parts[part] = _serialize(root)

    with zipfile.ZipFile(out_path, "w") as zout:
        for n, data in parts.items():
            info = infos[n]
            zout.writestr(zipfile.ZipInfo(n, date_time=info.date_time), data, compress_type=zipfile.ZIP_DEFLATED)
    report = {"rules": [{"index": i, "kind": r.get("kind"), "matched": counts[i]} for i, r in enumerate(rules)], "written": out_path}
    unmatched = [r for r in report["rules"] if r["matched"] == 0]
    if unmatched:
        report["warning"] = "rules matched nothing: " + ", ".join(str(r["index"]) for r in unmatched)
    json.dump(report, sys.stdout, indent=1)
    sys.stdout.write("\n")


if __name__ == "__main__":
    main()
