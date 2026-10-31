#!/usr/bin/env python3
"""Inspect ordered text and structure from any readable Word DOCX package."""

import json
import re
import sys
import xml.etree.ElementTree as ET
from zipfile import BadZipFile, ZipFile

WORD_NS = "http://schemas.openxmlformats.org/wordprocessingml/2006/main"
CORE_NS = "http://purl.org/dc/elements/1.1/"
NS = {"w": WORD_NS, "dc": CORE_NS}


def qn(name):
    return f"{{{WORD_NS}}}{name}"


def text_content(element):
    parts = []
    for child in element.iter():
        if child.tag == qn("t"):
            parts.append(child.text or "")
        elif child.tag == qn("tab"):
            parts.append("\t")
        elif child.tag in (qn("br"), qn("cr")):
            parts.append("\n")
    return "".join(parts)


def parse_styles(data):
    if data is None:
        return {}
    root = ET.fromstring(data)
    styles = {}
    for style in root.findall("w:style", NS):
        style_id = style.get(qn("styleId"))
        if not style_id:
            continue
        name = style.find("w:name", NS)
        based_on = style.find("w:basedOn", NS)
        outline = style.find("w:pPr/w:outlineLvl", NS)
        numpr = style.find("w:pPr/w:numPr", NS)
        num_id = numpr.find("w:numId", NS) if numpr is not None else None
        num_level = numpr.find("w:ilvl", NS) if numpr is not None else None
        styles[style_id] = {
            "name": name.get(qn("val")) if name is not None else None,
            "based_on": based_on.get(qn("val")) if based_on is not None else None,
            "outline_level": outline.get(qn("val")) if outline is not None else None,
            "numbering_id": num_id.get(qn("val")) if num_id is not None else None,
            "numbering_level": num_level.get(qn("val")) if num_level is not None else None,
        }
    return styles


def style_outline_level(style_id, styles, seen=None):
    if not style_id:
        return None
    seen = seen or set()
    if style_id in seen:
        return None
    seen.add(style_id)
    style = styles.get(style_id) or {}
    outline = style.get("outline_level")
    if outline is not None:
        try:
            value = int(outline)
            return value + 1 if 0 <= value <= 8 else None
        except (TypeError, ValueError):
            return None
    match = re.fullmatch(r"Heading([1-9])", style_id, flags=re.IGNORECASE)
    if match:
        return int(match.group(1))
    return style_outline_level(style.get("based_on"), styles, seen)


def style_list(style_id, styles, seen=None):
    if not style_id:
        return None
    seen = seen or set()
    if style_id in seen:
        return None
    seen.add(style_id)
    style = styles.get(style_id) or {}
    if style.get("numbering_id") is not None:
        return {
            "numbering_id": style["numbering_id"],
            "level": int(style.get("numbering_level") or "0") + 1,
        }
    return style_list(style.get("based_on"), styles, seen)


def parse_numbering(data):
    if data is None:
        return {}
    root = ET.fromstring(data)
    abstract_formats = {}
    for abstract in root.findall("w:abstractNum", NS):
        abstract_id = abstract.get(qn("abstractNumId"))
        if abstract_id is None:
            continue
        levels = {}
        for level in abstract.findall("w:lvl", NS):
            index = level.get(qn("ilvl"))
            fmt = level.find("w:numFmt", NS)
            text = level.find("w:lvlText", NS)
            levels[index] = {
                "format": fmt.get(qn("val")) if fmt is not None else None,
                "text": text.get(qn("val")) if text is not None else None,
            }
        abstract_formats[abstract_id] = levels

    numbering = {}
    for num in root.findall("w:num", NS):
        num_id = num.get(qn("numId"))
        abstract = num.find("w:abstractNumId", NS)
        if num_id is None or abstract is None:
            continue
        abstract_id = abstract.get(qn("val"))
        numbering[num_id] = abstract_formats.get(abstract_id, {})
    return numbering


def paragraph_block(paragraph, styles, numbering):
    ppr = paragraph.find("w:pPr", NS)
    style_node = ppr.find("w:pStyle", NS) if ppr is not None else None
    style_id = style_node.get(qn("val")) if style_node is not None else None
    outline = ppr.find("w:outlineLvl", NS) if ppr is not None else None
    heading_level = None
    if outline is not None:
        try:
            value = int(outline.get(qn("val")))
            heading_level = value + 1 if 0 <= value <= 8 else None
        except (TypeError, ValueError):
            heading_level = None
    if heading_level is None:
        heading_level = style_outline_level(style_id, styles)

    block = {"kind": "paragraph", "text": text_content(paragraph)}
    if style_id:
        block["style_id"] = style_id
        name = (styles.get(style_id) or {}).get("name")
        if name:
            block["style_name"] = name
    if heading_level is not None:
        block["heading_level"] = heading_level

    numpr = ppr.find("w:numPr", NS) if ppr is not None else None
    if numpr is not None:
        num_id_node = numpr.find("w:numId", NS)
        level_node = numpr.find("w:ilvl", NS)
        num_id = num_id_node.get(qn("val")) if num_id_node is not None else None
        level_index = level_node.get(qn("val"), "0") if level_node is not None else "0"
        list_info = (
            {"numbering_id": num_id, "level": int(level_index) + 1}
            if num_id is not None else style_list(style_id, styles)
        )
        if list_info is not None and level_node is not None:
            list_info["level"] = int(level_index) + 1
    else:
        list_info = style_list(style_id, styles)
        level_index = str((list_info or {}).get("level", 1) - 1)
    if list_info is not None:
        num_id = list_info["numbering_id"]
        level_info = (numbering.get(num_id) or {}).get(level_index)
        if level_info:
            if level_info.get("format"):
                list_info["format"] = level_info["format"]
            if level_info.get("text"):
                list_info["marker_pattern"] = level_info["text"]
        block["list"] = list_info
    return block


def table_block(table):
    rows = []
    for row in table.findall("w:tr", NS):
        rows.append([text_content(cell) for cell in row.findall("w:tc", NS)])
    return {"kind": "table", "rows": rows}


def body_blocks(container):
    for element in container:
        if element.tag in (qn("p"), qn("tbl")):
            yield element
        elif element.tag != qn("sectPr"):
            # Content controls and custom XML wrappers can contain ordinary
            # body blocks. Unwrap containers while keeping their document order.
            yield from body_blocks(element)


def inspect(path):
    try:
        with ZipFile(path) as docx:
            names = set(docx.namelist())
            if "word/document.xml" not in names:
                raise ValueError("DOCX package is missing word/document.xml")
            document = ET.fromstring(docx.read("word/document.xml"))
            styles = parse_styles(docx.read("word/styles.xml") if "word/styles.xml" in names else None)
            numbering = parse_numbering(docx.read("word/numbering.xml") if "word/numbering.xml" in names else None)
            core = ET.fromstring(docx.read("docProps/core.xml")) if "docProps/core.xml" in names else None
    except BadZipFile as exc:
        raise ValueError("input is not a readable DOCX ZIP package") from exc

    body = document.find("w:body", NS)
    if body is None:
        raise ValueError("DOCX document has no body")
    blocks = []
    for element in body_blocks(body):
        if element.tag == qn("p"):
            blocks.append(paragraph_block(element, styles, numbering))
        elif element.tag == qn("tbl"):
            blocks.append(table_block(element))

    metadata = {}
    if core is not None:
        title = core.find("dc:title", NS)
        creator = core.find("dc:creator", NS)
        if title is not None and title.text:
            metadata["title"] = title.text
        if creator is not None and creator.text:
            metadata["creator"] = creator.text
    paragraphs = [block for block in blocks if block["kind"] == "paragraph"]
    tables = [block for block in blocks if block["kind"] == "table"]
    return {
        "metadata": metadata,
        "blocks": blocks,
        "counts": {
            "paragraphs": len(paragraphs),
            "headings": sum("heading_level" in block for block in paragraphs),
            "lists": sum("list" in block for block in paragraphs),
            "tables": len(tables),
            "table_rows": sum(len(table["rows"]) for table in tables),
            "cells": sum(len(row) for table in tables for row in table["rows"]),
        },
    }


def main():
    if len(sys.argv) != 2:
        raise SystemExit("usage: read-structured-docx.py <document.docx>")
    try:
        print(json.dumps(inspect(sys.argv[1]), ensure_ascii=False))
    except (OSError, ET.ParseError, ValueError) as exc:
        raise SystemExit(str(exc)) from exc


if __name__ == "__main__":
    main()
