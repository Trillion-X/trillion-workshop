#!/usr/bin/env python3
# tools/office-files/do-work/decode-office-open-xml.py
#
# PURPOSE: Pure bounded decoder from one Office Open XML container (the zip
# that .xlsx, .docx and .pptx all are) to plain JSON a reader or a test can
# hold. Sibling of structured-file-output, which only WRITES these bytes.
#
# NON-NEGOTIABLE INVARIANTS
# 1. Standard library only. No network, no writes except stdout.
# 2. Every cell reports BOTH what was typed (formula) and what the last
#    calculator cached (value). A workbook whose cached values are missing
#    says so through null values, never through a guess.
# 3. Which parts exist is read from the container, never assumed: a workbook
#    with nine sheets and a document with zero tables decode the same way.
# 4. Dumb: no vocabulary of what the sheets or paragraphs MEAN.
#
# CLI:
#   decode-office-open-xml.py <file> [--sheet NAME] [--max-rows N] [--formulas]
#   Emits one JSON object: {"kind": "workbook"|"document"|"presentation"|"container", ...}

import argparse
import json
import re
import sys
import zipfile
import xml.etree.ElementTree as ET

NS_MAIN = "http://schemas.openxmlformats.org/spreadsheetml/2006/main"
NS_REL = "http://schemas.openxmlformats.org/officeDocument/2006/relationships"
NS_PKG_REL = "http://schemas.openxmlformats.org/package/2006/relationships"
NS_WORD = "http://schemas.openxmlformats.org/wordprocessingml/2006/main"
NS_DRAW = "http://schemas.openxmlformats.org/drawingml/2006/main"


def _q(ns, tag):
    return "{%s}%s" % (ns, tag)


def _shared_strings(z):
    if "xl/sharedStrings.xml" not in z.namelist():
        return []
    root = ET.fromstring(z.read("xl/sharedStrings.xml"))
    out = []
    for si in root.findall(_q(NS_MAIN, "si")):
        out.append("".join(t.text or "" for t in si.iter(_q(NS_MAIN, "t"))))
    return out


def _sheet_parts(z):
    wb = ET.fromstring(z.read("xl/workbook.xml"))
    rels = ET.fromstring(z.read("xl/_rels/workbook.xml.rels"))
    target_by_id = {}
    for r in rels.findall(_q(NS_PKG_REL, "Relationship")):
        t = r.get("Target")
        target_by_id[r.get("Id")] = t if t.startswith("/") else "xl/" + t
    sheets = []
    for s in wb.find(_q(NS_MAIN, "sheets")).findall(_q(NS_MAIN, "sheet")):
        sheets.append({"name": s.get("name"), "part": target_by_id[s.get(_q(NS_REL, "id"))].lstrip("/")})
    return sheets


_COL_RE = re.compile(r"([A-Z]+)(\d+)")


def _split_ref(ref):
    m = _COL_RE.match(ref)
    return m.group(1), int(m.group(2))


def _decode_sheet(z, part, strings, max_rows, want_formulas):
    root = ET.fromstring(z.read(part))
    rows = []
    for row in root.iter(_q(NS_MAIN, "row")):
        r_index = int(row.get("r"))
        if max_rows and r_index > max_rows:
            break
        cells = {}
        for c in row.findall(_q(NS_MAIN, "c")):
            ref = c.get("r")
            t = c.get("t")
            v = c.find(_q(NS_MAIN, "v"))
            f = c.find(_q(NS_MAIN, "f"))
            value = None
            if t == "s" and v is not None:
                value = strings[int(v.text)]
            elif t == "inlineStr":
                value = "".join(x.text or "" for x in c.iter(_q(NS_MAIN, "t")))
            elif v is not None and v.text is not None:
                raw = v.text
                if t == "b":
                    value = raw == "1"
                elif t in ("str", "e"):
                    value = raw
                else:
                    try:
                        value = float(raw)
                        if value.is_integer() and "." not in raw and "E" not in raw.upper():
                            value = int(value)
                    except ValueError:
                        value = raw
            if value is None and f is None:
                continue
            col, _ = _split_ref(ref)
            entry = {"value": value}
            if want_formulas and f is not None:
                entry["formula"] = f.text if f.text is not None else ("shared:" + str(f.get("si")))
            cells[col] = entry
        if cells:
            rows.append({"row": r_index, "cells": cells})
    return rows


def _decode_workbook(z, args):
    strings = _shared_strings(z)
    out = {"kind": "workbook", "sheets": []}
    for s in _sheet_parts(z):
        if args.sheet and s["name"] != args.sheet:
            out["sheets"].append({"name": s["name"], "skipped": True})
            continue
        out["sheets"].append({"name": s["name"], "rows": _decode_sheet(z, s["part"], strings, args.max_rows, args.formulas)})
    return out


def _decode_document(z):
    root = ET.fromstring(z.read("word/document.xml"))
    body = root.find(_q(NS_WORD, "body"))
    blocks = []
    paragraph_ordinal = 0
    for el in body:
        if el.tag == _q(NS_WORD, "p"):
            # Source locators count direct body paragraphs, including empty
            # ones. Table paragraphs never consume this ordinal.
            paragraph_ordinal += 1
            style = el.find(_q(NS_WORD, "pPr") + "/" + _q(NS_WORD, "pStyle"))
            text = "".join(t.text or "" for t in el.iter(_q(NS_WORD, "t")))
            if text.strip():
                blocks.append({"type": "paragraph", "style": style.get(_q(NS_WORD, "val")) if style is not None else None, "text": text,
                               "selector_kind": "document_paragraph", "selector": "paragraph:%d" % paragraph_ordinal})
        elif el.tag == _q(NS_WORD, "tbl"):
            table = []
            for tr in el.findall(_q(NS_WORD, "tr")):
                table.append(["".join(t.text or "" for t in tc.iter(_q(NS_WORD, "t"))) for tc in tr.findall(_q(NS_WORD, "tc"))])
            blocks.append({"type": "table", "rows": table})
    return {"kind": "document", "blocks": blocks}


NS_PML = "http://schemas.openxmlformats.org/presentationml/2006/main"


def _presentation_slide_parts(z):
    """Slide parts in the order the presentation DECLARES, never filename order.
    slide10.xml sorts before slide2.xml as a string, and a deck that has been
    reordered keeps its old part names, so the file list says nothing about sequence."""
    names = set(z.namelist())
    if "ppt/presentation.xml" not in names or "ppt/_rels/presentation.xml.rels" not in names:
        return sorted(n for n in names if re.match(r"ppt/slides/slide\d+\.xml$", n))
    rels = ET.fromstring(z.read("ppt/_rels/presentation.xml.rels"))
    target_by_id = {}
    for r in rels.findall(_q(NS_PKG_REL, "Relationship")):
        t = r.get("Target")
        target_by_id[r.get("Id")] = (t if t.startswith("/") else "ppt/" + t).lstrip("/")
    pres = ET.fromstring(z.read("ppt/presentation.xml"))
    ordered = []
    for sld in pres.iter(_q(NS_PML, "sldId")):
        part = target_by_id.get(sld.get(_q(NS_REL, "id")))
        if part:
            ordered.append(part)
    return ordered


def _decode_presentation(z):
    slides = _presentation_slide_parts(z)
    out = []
    for n in slides:
        root = ET.fromstring(z.read(n))
        texts = []
        for p in root.iter(_q(NS_DRAW, "p")):
            t = "".join(x.text or "" for x in p.iter(_q(NS_DRAW, "t")))
            if t.strip():
                texts.append(t)
        out.append({"part": n, "paragraphs": texts})
    return {"kind": "presentation", "slides": out}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("file")
    ap.add_argument("--sheet")
    ap.add_argument("--max-rows", type=int, default=0)
    ap.add_argument("--formulas", action="store_true")
    args = ap.parse_args()
    with zipfile.ZipFile(args.file) as z:
        names = set(z.namelist())
        if "xl/workbook.xml" in names:
            result = _decode_workbook(z, args)
        elif "word/document.xml" in names:
            result = _decode_document(z)
        elif any(n.startswith("ppt/slides/") for n in names):
            result = _decode_presentation(z)
        else:
            result = {"kind": "container", "parts": sorted(names)}
    json.dump(result, sys.stdout, ensure_ascii=False, indent=1)
    sys.stdout.write("\n")


if __name__ == "__main__":
    main()
