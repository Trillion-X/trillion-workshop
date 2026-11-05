#!/usr/bin/env python3
"""Build a styled DOCX from Markdown using a retained Word template.

The source Markdown remains the content authority. The template supplies page
geometry, styles, numbering, theme, and section furniture. No source text is
stored alongside this tool. Which manuscript, template and output folder, and the
writing gate's settings, come from the person's settings row
record:setting:export-documents-to-files~piece~<book-id> (tools/settings) or
from arguments.

Moved from trillion-launch-video tools/private-book-reader/private_book_reader.py.
"""

from __future__ import annotations

import argparse
import json
import re
import sys
from dataclasses import dataclass, field
from pathlib import Path
from typing import Iterable

from docx import Document
from docx.enum.text import WD_ALIGN_PARAGRAPH, WD_BREAK, WD_TAB_ALIGNMENT, WD_TAB_LEADER
from docx.oxml import OxmlElement
from docx.oxml.ns import qn
from docx.shared import Inches, Pt


@dataclass
class Block:
    kind: str
    text: str = ""
    level: int = 0
    rows: list[list[str]] = field(default_factory=list)
    ordered: bool = False
    items: list[tuple[int, str, bool]] = field(default_factory=list)


@dataclass
class ParsedBook:
    title: str
    blocks: list[Block]

    @property
    def headings(self) -> list[Block]:
        return [b for b in self.blocks if b.kind == "heading"]

    @property
    def tables(self) -> list[Block]:
        return [b for b in self.blocks if b.kind == "table"]


def _split_table_row(line: str) -> list[str]:
    line = line.strip()
    if line.startswith("|"):
        line = line[1:]
    if line.endswith("|") and not line.endswith("\\|"):
        line = line[:-1]
    cells: list[str] = []
    part: list[str] = []
    escaped = False
    for char in line:
        if char == "|" and not escaped:
            cells.append("".join(part).strip())
            part = []
        else:
            part.append(char)
        escaped = char == "\\" and not escaped
        if char != "\\":
            escaped = False
    cells.append("".join(part).strip())
    return cells


def _is_table_separator(line: str) -> bool:
    cells = _split_table_row(line)
    return bool(cells) and all(re.fullmatch(r":?-{3,}:?", c.replace(" ", "")) for c in cells)


def parse_markdown(text: str) -> ParsedBook:
    """Parse the Markdown subset used by book manuscripts and general prose."""
    lines = text.replace("\r\n", "\n").replace("\r", "\n").split("\n")
    blocks: list[Block] = []
    title = ""
    i = 0
    while i < len(lines):
        raw = lines[i]
        line = raw.strip()
        if not line:
            i += 1
            continue
        heading = re.match(r"^(#{1,6})\s+(.+?)\s*#*\s*$", line)
        if heading:
            level, value = len(heading.group(1)), heading.group(2).strip()
            if not title and level == 1:
                title = value
            else:
                # H1 is the book title; subsequent heading depths map to Word
                # Heading 1..6 while preserving the source hierarchy.
                blocks.append(Block("heading", value, max(1, min(6, level - (1 if title else 0)))))
            i += 1
            continue
        if line.startswith("|") and i + 1 < len(lines) and _is_table_separator(lines[i + 1].strip()):
            header = _split_table_row(line)
            rows = [header]
            i += 2
            while i < len(lines) and lines[i].strip().startswith("|"):
                row = _split_table_row(lines[i])
                if len(row) < len(header):
                    row.extend([""] * (len(header) - len(row)))
                elif len(row) > len(header):
                    row = row[:len(header) - 1] + [" | ".join(row[len(header) - 1:])]
                rows.append(row)
                i += 1
            blocks.append(Block("table", rows=rows))
            continue
        if re.match(r"^(?:[-*+]\s+|\d+[.)]\s+)", line):
            items: list[tuple[int, str, bool]] = []
            while i < len(lines):
                current = lines[i]
                match = re.match(r"^(\s*)([-*+]\s+|\d+[.)]\s+)(.*)$", current)
                if not match:
                    break
                indent = len(match.group(1).expandtabs(4))
                is_ordered = bool(re.match(r"\d", match.group(2)))
                items.append((indent // 2, match.group(3).strip(), is_ordered))
                i += 1
            blocks.append(Block("list", items=items))
            continue
        if line.startswith("> ") or line == ">":
            quote_lines = []
            while i < len(lines) and (lines[i].strip().startswith(">") or not lines[i].strip()):
                quote_lines.append(re.sub(r"^\s*> ?", "", lines[i]).strip())
                i += 1
            blocks.append(Block("quote", " ".join(x for x in quote_lines if x)))
            continue
        # Join ordinary wrapped Markdown lines into one paragraph. A blank line
        # or a recognized block start ends the paragraph.
        paragraph = [line]
        i += 1
        while i < len(lines) and lines[i].strip():
            candidate = lines[i].strip()
            if (re.match(r"^#{1,6}\s", candidate) or candidate.startswith("|")
                    or re.match(r"^(?:[-*+]\s+|\d+[.)]\s+|>)", candidate)):
                break
            paragraph.append(candidate)
            i += 1
        blocks.append(Block("paragraph", " ".join(paragraph)))
    return ParsedBook(title or "Manuscript", blocks)


_INLINE_TOKEN = re.compile(
    r"(?<!\\)(`[^`\n]+`|\*\*(?=\S).+?(?<=\S)\*\*"
    r"|(?<!\w)__(?=\S).+?(?<=\S)__(?!\w)"
    r"|(?<!\*)\*(?=\S)[^*\n]+?(?<=\S)\*(?!\*)"
    r"|(?<![\w_])_(?=\S)[^_\n]+?(?<=\S)_(?![\w_]))"
)


def _literal_inline(value: str) -> str:
    return re.sub(r"\\([*_`])", r"\1", value)


def _inline_parts(value: str, strong=False, italic=False) -> Iterable[tuple[str, bool, bool, bool]]:
    """Project supported inline markup without deleting literal punctuation.

    Underscores inside identifiers and all characters inside code spans stay
    literal. Formatting wrappers are removed only when a matching pair exists.
    """
    cursor = 0
    for match in _INLINE_TOKEN.finditer(value):
        if match.start() > cursor:
            yield _literal_inline(value[cursor:match.start()]), strong, italic, False
        marker = match.group(0)
        if marker.startswith("`"):
            yield marker[1:-1], strong, italic, True
        elif marker.startswith(("**", "__")):
            yield from _inline_parts(marker[2:-2], True, italic)
        else:
            yield from _inline_parts(marker[1:-1], strong, True)
        cursor = match.end()
    if cursor < len(value):
        yield _literal_inline(value[cursor:]), strong, italic, False


def _plain_inline(value: str) -> str:
    return "".join(text for text, _, _, _ in _inline_parts(value))


def _bookmark(paragraph, name: str, bookmark_id: int) -> None:
    start = OxmlElement("w:bookmarkStart")
    start.set(qn("w:id"), str(bookmark_id))
    start.set(qn("w:name"), name)
    end = OxmlElement("w:bookmarkEnd")
    end.set(qn("w:id"), str(bookmark_id))
    paragraph._p.insert(0, start)
    paragraph._p.append(end)


def _add_link(paragraph, label: str, anchor: str) -> None:
    hyperlink = OxmlElement("w:hyperlink")
    hyperlink.set(qn("w:anchor"), anchor)
    run = OxmlElement("w:r")
    props = OxmlElement("w:rPr")
    color = OxmlElement("w:color")
    color.set(qn("w:val"), "365F91")
    props.append(color)
    underline = OxmlElement("w:u")
    underline.set(qn("w:val"), "single")
    props.append(underline)
    run.append(props)
    text = OxmlElement("w:t")
    text.text = label
    run.append(text)
    hyperlink.append(run)
    paragraph._p.append(hyperlink)


def _add_field(paragraph, instruction: str, placeholder: str = "1") -> None:
    run = OxmlElement("w:r")
    begin = OxmlElement("w:fldChar")
    begin.set(qn("w:fldCharType"), "begin")
    run.append(begin)
    code_run = OxmlElement("w:r")
    code = OxmlElement("w:instrText")
    code.set(qn("xml:space"), "preserve")
    code.text = f" {instruction} "
    code_run.append(code)
    separate_run = OxmlElement("w:r")
    separate = OxmlElement("w:fldChar")
    separate.set(qn("w:fldCharType"), "separate")
    separate_run.append(separate)
    value_run = OxmlElement("w:r")
    value = OxmlElement("w:t")
    value.text = placeholder
    value_run.append(value)
    end_run = OxmlElement("w:r")
    end = OxmlElement("w:fldChar")
    end.set(qn("w:fldCharType"), "end")
    end_run.append(end)
    paragraph._p.extend([run, code_run, separate_run, value_run, end_run])


def _text_runs(paragraph, value: str, strong=False, italic=False, code=False) -> None:
    # The retained template's bold face renders comparison signs as wedges
    # and a plus as a star. Preserve their mathematical shapes explicitly.
    # Give only those signs an explicit font; retain the surrounding typography.
    for part in re.split(r"([<>+])", value):
        if not part:
            continue
        run = paragraph.add_run(part)
        run.bold = True if strong else None
        run.italic = True if italic else None
        if part in ("<", ">", "+"):
            run.font.name = "Arial"
            fonts = run._element.get_or_add_rPr().rFonts
            for field in ("ascii", "hAnsi", "eastAsia", "cs"):
                fonts.set(qn(f"w:{field}"), "Arial")
        elif code:
            run.font.name = "Menlo"
            run.font.size = Pt(9)


def _inline(paragraph, value: str) -> None:
    for text, strong, italic, code in _inline_parts(value):
        _text_runs(paragraph, text, strong, italic, code)


def _clear_body(document) -> None:
    body = document._element.body
    for child in list(body):
        if child.tag != qn("w:sectPr"):
            body.remove(child)


def _ensure_numbering(document) -> tuple[int, int]:
    numbering = document.part.numbering_part.element
    abstract_ids = [int(el.get(qn("w:abstractNumId"))) for el in numbering.findall(qn("w:abstractNum"))]
    num_ids = [int(el.get(qn("w:numId"))) for el in numbering.findall(qn("w:num"))]
    next_abstract = max(abstract_ids or [0]) + 1
    next_num = max(num_ids or [0]) + 1
    ids = []
    for ordered in (False, True):
        abstract = OxmlElement("w:abstractNum")
        abstract.set(qn("w:abstractNumId"), str(next_abstract))
        multi = OxmlElement("w:multiLevelType")
        multi.set(qn("w:val"), "multilevel")
        abstract.append(multi)
        for level in range(9):
            lvl = OxmlElement("w:lvl")
            lvl.set(qn("w:ilvl"), str(level))
            start = OxmlElement("w:start"); start.set(qn("w:val"), "1"); lvl.append(start)
            num_fmt = OxmlElement("w:numFmt"); num_fmt.set(qn("w:val"), "decimal" if ordered else "bullet"); lvl.append(num_fmt)
            text = OxmlElement("w:lvlText")
            text.set(qn("w:val"), ("%" + str(level + 1) + ".") if ordered else ["•", "◦", "▪"][level % 3])
            lvl.append(text)
            # A tab suffix can collapse when a digit reaches the tab stop
            # in a retained template. Keep the marker's visible separator.
            suffix = OxmlElement("w:suff")
            suffix.set(qn("w:val"), "space")
            lvl.append(suffix)
            jc = OxmlElement("w:lvlJc"); jc.set(qn("w:val"), "left"); lvl.append(jc)
            ppr = OxmlElement("w:pPr")
            tabs = OxmlElement("w:tabs"); tab = OxmlElement("w:tab"); tab.set(qn("w:val"), "num"); tab.set(qn("w:pos"), str(360 + 360 * level)); tabs.append(tab); ppr.append(tabs)
            ind = OxmlElement("w:ind"); ind.set(qn("w:left"), str(360 + 360 * level)); ind.set(qn("w:hanging"), "180"); ppr.append(ind)
            lvl.append(ppr)
            abstract.append(lvl)
        numbering.append(abstract)
        num = OxmlElement("w:num"); num.set(qn("w:numId"), str(next_num)); abstract_ref = OxmlElement("w:abstractNumId"); abstract_ref.set(qn("w:val"), str(next_abstract)); num.append(abstract_ref); numbering.append(num)
        ids.append(next_num)
        next_abstract += 1; next_num += 1
    return ids[0], ids[1]


def _set_list(paragraph, num_id: int, depth: int) -> None:
    ppr = paragraph._p.get_or_add_pPr()
    numpr = OxmlElement("w:numPr")
    ilvl = OxmlElement("w:ilvl"); ilvl.set(qn("w:val"), str(min(depth, 8)))
    numid = OxmlElement("w:numId"); numid.set(qn("w:val"), str(num_id))
    numpr.extend([ilvl, numid]); ppr.append(numpr)


def _new_numbering_instance(document, source_num_id: int) -> int:
    numbering = document.part.numbering_part.element
    instances = numbering.findall(qn("w:num"))
    next_id = max([int(el.get(qn("w:numId"))) for el in instances] or [0]) + 1
    source = next(el for el in instances if int(el.get(qn("w:numId"))) == source_num_id)
    abstract_id = source.find(qn("w:abstractNumId")).get(qn("w:val"))
    num = OxmlElement("w:num"); num.set(qn("w:numId"), str(next_id))
    abstract = OxmlElement("w:abstractNumId"); abstract.set(qn("w:val"), abstract_id)
    num.append(abstract)
    # A fresh numId alone can still continue the shared abstract list in
    # LibreOffice. Explicitly restart each level for this separate list block.
    for depth in range(9):
        override = OxmlElement("w:lvlOverride")
        override.set(qn("w:ilvl"), str(depth))
        start = OxmlElement("w:startOverride")
        start.set(qn("w:val"), "1")
        override.append(start)
        num.append(override)
    numbering.append(num)
    return next_id


def render_document(parsed: ParsedBook, template_path: Path, output_path: Path, page_map: dict[str, int] | None = None,
                   *, source_path: Path | None = None, source_bytes: bytes | None = None,
                   settings: dict | None = None, checks_receipt: dict | None = None) -> dict:
    if source_path is None or source_bytes is None:
        raise ValueError("A current source snapshot is required for DOCX export")
    source_path = source_path.resolve(strict=True)
    try:
        if source_path.read_bytes() != source_bytes:
            raise ValueError("Source changed after loading; export remains blocked")
        snapshot_text = source_bytes.decode("utf-8")
    except (OSError, UnicodeError):
        raise ValueError("The source snapshot is missing or invalid; export remains blocked") from None
    if parse_markdown(snapshot_text) != parsed:
        raise ValueError("Parsed content does not match the source snapshot; export remains blocked")
    from writing_gate import enforce_writing_policy
    gate_receipt = enforce_writing_policy(source_path, expected_bytes=source_bytes,
                                          settings=settings, checks_receipt=checks_receipt)
    page_map = page_map or {}
    doc = Document(str(template_path))
    _clear_body(doc)
    bullet_num, ordered_num = _ensure_numbering(doc)
    title = doc.add_paragraph(style="Title")
    _inline(title, parsed.title)
    _bookmark(title, "BookTop", 1)

    contents = doc.add_paragraph(style="Heading 1")
    contents.add_run("Contents")
    _bookmark(contents, "BookContents", 2)
    headings = parsed.headings
    names: dict[int, str] = {}
    for index, heading in enumerate(headings, start=1):
        names[id(heading)] = f"BookHeading{index}"

    for heading in headings:
        p = doc.add_paragraph()
        p.paragraph_format.left_indent = Inches(min(heading.level - 1, 5) * 0.16)
        p.paragraph_format.space_after = Pt(1)
        _add_link(p, _plain_inline(heading.text), names[id(heading)])
        section = doc.sections[0]
        width = section.page_width - section.left_margin - section.right_margin
        p.paragraph_format.tab_stops.add_tab_stop(width, WD_TAB_ALIGNMENT.RIGHT, WD_TAB_LEADER.DOTS)
        p.add_run("\t")
        _add_field(p, f"PAGEREF {names[id(heading)]} \\h", str(page_map.get(names[id(heading)], 1)))

    body_start = doc.add_paragraph()
    # A run-level break can spill this empty marker onto a fresh page and
    # then force another page, leaving a footer-only page after Contents.
    # Move the marker and its following source content together instead.
    body_start.paragraph_format.page_break_before = True
    body_start.paragraph_format.keep_with_next = True
    _bookmark(body_start, "BookBody", 3)
    heading_ids = {id(heading): index + 4 for index, heading in enumerate(headings)}
    for block in parsed.blocks:
        if block.kind == "heading":
            p = doc.add_paragraph(style=f"Heading {block.level}")
            _inline(p, block.text)
            _bookmark(p, names[id(block)], heading_ids[id(block)])
        elif block.kind == "paragraph":
            p = doc.add_paragraph(style="Normal")
            _inline(p, block.text)
            # Standalone emphasis labels introduce the following passage.
            # Keep them with it when pagination changes; inline emphasis
            # inside ordinary prose must retain normal paragraph behavior.
            if re.fullmatch(r"(?:\*\*[^*\n]+\*\*|__[^_\n]+__)", block.text.strip()):
                p.paragraph_format.keep_with_next = True
        elif block.kind == "quote":
            p = doc.add_paragraph(style="Quote" if "Quote" in [s.name for s in doc.styles] else "Normal")
            _inline(p, block.text)
        elif block.kind == "list":
            ordered_instance = _new_numbering_instance(doc, ordered_num) if any(x[2] for x in block.items) else ordered_num
            for depth, value, ordered in block.items:
                p = doc.add_paragraph(style="Normal")
                _set_list(p, ordered_instance if ordered else bullet_num, depth)
                _inline(p, value)
        elif block.kind == "table":
            columns = max(len(row) for row in block.rows)
            table = doc.add_table(rows=len(block.rows), cols=columns)
            table.style = "Normal Table" if "Normal Table" in [s.name for s in doc.styles] else "Table Grid"
            table.autofit = False
            section = doc.sections[0]
            available_width = section.page_width - section.left_margin - section.right_margin
            ratios = {2: (0.34, 0.66), 3: (0.24, 0.38, 0.38)}.get(columns)
            if ratios is None:
                ratios = tuple(1 / columns for _ in range(columns))
            for col, ratio in zip(table.columns, ratios):
                col.width = int(available_width * ratio)
            for ri, row in enumerate(block.rows):
                trpr = table.rows[ri]._tr.get_or_add_trPr()
                trpr.append(OxmlElement("w:cantSplit"))
                for ci in range(columns):
                    cell = table.cell(ri, ci)
                    cell.width = int(available_width * ratios[ci])
                    cell.text = ""
                    p = cell.paragraphs[0]
                    _inline(p, row[ci] if ci < len(row) else "")
                    if ri == 0:
                        for run in p.runs:
                            run.bold = True
            if table.rows:
                trpr = table.rows[0]._tr.get_or_add_trPr()
                repeat = OxmlElement("w:tblHeader"); repeat.set(qn("w:val"), "true"); trpr.append(repeat)
            doc.add_paragraph(style="Normal")

    # Restore the Contents heading as the first item after the title, then
    # place a stable Top link in the footer and a page field on every page.
    # The title and Contents nodes are already first; TOC entries follow them.
    footer = doc.sections[0].footer
    footer_p = footer.paragraphs[0]
    footer_p.text = ""
    footer_p.alignment = WD_ALIGN_PARAGRAPH.CENTER
    footer_p.add_run("Page ")
    _add_field(footer_p, "PAGE")
    settings = doc.settings.element
    update = settings.find(qn("w:updateFields"))
    if update is None:
        update = OxmlElement("w:updateFields")
        settings.append(update)
    update.set(qn("w:val"), "true")
    try:
        if source_path.read_bytes() != source_bytes:
            raise ValueError("Source changed before DOCX save; export remains blocked")
    except OSError:
        raise ValueError("Source is unavailable before DOCX save; export remains blocked") from None
    output_path.parent.mkdir(parents=True, exist_ok=True)
    doc.save(str(output_path))
    verify_output(parsed, output_path)
    return gate_receipt


def verify_output(parsed: ParsedBook, output_path: Path) -> None:
    """Read the saved DOCX back and enforce heading and table text parity."""
    readback = Document(str(output_path))
    heading_bookmarks = {
        el.get(qn("w:name"))
        for el in readback.element.iter(qn("w:bookmarkStart"))
        if (el.get(qn("w:name")) or "").startswith("BookHeading")
    }
    expected_bookmarks = {f"BookHeading{i}" for i in range(1, len(parsed.headings) + 1)}
    if heading_bookmarks != expected_bookmarks:
        raise ValueError(f"Heading bookmark readback mismatch: {len(heading_bookmarks)} != {len(expected_bookmarks)}")
    # Inspect all source content after the generated contents, including
    # introductory paragraphs that can precede the first heading.
    actual_body: list[str] = []
    body_children = list(readback.element.body)
    body_start_index = next(
        (
            index
            for index, child in enumerate(body_children)
            if any(el.get(qn("w:name")) == "BookBody" for el in child.iter(qn("w:bookmarkStart")))
        ),
        None,
    )
    if body_start_index is None:
        # Retained documents written before BookBody was introduced still
        # have the generated Contents bookmark and its following page break.
        contents_index = next(
            (
                index
                for index, child in enumerate(body_children)
                if any(el.get(qn("w:name")) == "BookContents" for el in child.iter(qn("w:bookmarkStart")))
            ),
            None,
        )
        if contents_index is not None:
            body_start_index = next(
                (
                    index
                    for index in range(contents_index + 1, len(body_children))
                    if any(
                        (el.tag == qn("w:br") and el.get(qn("w:type")) == "page")
                        or (el.tag == qn("w:pageBreakBefore") and el.get(qn("w:val"), "true") not in ("false", "0", "off"))
                        for el in body_children[index].iter()
                    )
                ),
                None,
            )
        if body_start_index is None:
            raise ValueError("DOCX source body boundary bookmark or Contents page break is missing")
    for child in body_children[body_start_index + 1 :]:
        actual_body.extend(el.text or "" for el in child.iter(qn("w:t")))
    expected_body: list[str] = []
    for block in parsed.blocks:
        if block.kind in ("heading", "paragraph", "quote"):
            expected_body.append(_plain_inline(block.text))
        elif block.kind == "list":
            expected_body.extend(_plain_inline(value) for _, value, _ in block.items)
        elif block.kind == "table":
            expected_body.extend(_plain_inline(cell) for row in block.rows for cell in row)
    compact = lambda text: re.sub(r"\s+", "", text)
    if compact("".join(actual_body)) != compact("".join(expected_body)):
        raise ValueError("Saved DOCX body differs from source prose, headings, lists or tables")
    if len(readback.tables) != len(parsed.tables):
        raise ValueError(f"Native table readback mismatch: {len(readback.tables)} != {len(parsed.tables)}")
    for index, (actual, expected) in enumerate(zip(readback.tables, parsed.tables), start=1):
        actual_rows = [[cell.text for cell in row.cells] for row in actual.rows]
        expected_rows = [[_plain_inline(cell) for cell in row] for row in expected.rows]
        if actual_rows != expected_rows:
            raise ValueError(f"Table {index} cell text differs from Markdown source")


def _check(parsed: ParsedBook, source: str) -> None:
    # Compare visible words and punctuation in source order, including table
    # cells. Markdown styling and layout whitespace are ignored.
    heading_texts = [b.text for b in parsed.headings]
    table_row_count = sum(len(t.rows) for t in parsed.tables)
    table_cell_count = sum(len(row) for t in parsed.tables for row in t.rows)
    normalized_text = [parsed.title]
    for block in parsed.blocks:
        if block.kind in ("heading", "paragraph", "quote"):
            normalized_text.append(block.text)
        elif block.kind == "list":
            normalized_text.extend(value for _, value, _ in block.items)
        elif block.kind == "table":
            normalized_text.extend(cell for row in block.rows for cell in row)
    actual = " ".join(_plain_inline(value) for value in normalized_text)
    expected: list[str] = []
    source_headings: list[str] = []
    source_tables: list[list[list[str]]] = []
    active_table: list[list[str]] | None = None
    has_title = False
    for line in source.replace("\r\n", "\n").replace("\r", "\n").split("\n"):
        stripped = line.strip()
        if not stripped:
            active_table = None
            continue
        if stripped.startswith("|"):
            if _is_table_separator(stripped):
                continue
            if active_table is None:
                active_table = []
                source_tables.append(active_table)
            source_row = _split_table_row(stripped)
            active_table.append(source_row)
            expected.extend(source_row)
        else:
            heading_match = re.match(r"^(#{1,6})\s+(.+?)\s*#*\s*$", stripped)
            if heading_match:
                if not (not has_title and len(heading_match.group(1)) == 1):
                    source_headings.append(heading_match.group(2))
                has_title = has_title or len(heading_match.group(1)) == 1
                stripped = heading_match.group(2)
            else:
                active_table = None
            stripped = re.sub(r"^(?:[-*+]\s+|\d+[.)]\s+|>\s*)", "", stripped)
            expected.append(stripped)
    if [_plain_inline(h) for h in source_headings] != [_plain_inline(h) for h in heading_texts]:
        raise ValueError("Heading text or order differs from Markdown source")
    if source_tables != [table.rows for table in parsed.tables]:
        raise ValueError("Table count, row count, or cell boundaries differ from Markdown source")
    expected_text = " ".join(_plain_inline(value) for value in expected)
    collapse = lambda value: re.sub(r"\s+", " ", value).strip()
    if collapse(actual) != collapse(expected_text):
        raise ValueError("Parsed visible text does not match Markdown source text")
    print(f"Title: {parsed.title}")
    print(f"Headings: {len(heading_texts)}")
    print(f"Native tables: {len(parsed.tables)} ({table_row_count} rows, {table_cell_count} cells)")
    print(f"Paragraphs: {sum(b.kind in ('paragraph', 'quote') for b in parsed.blocks)}")
    print(f"Lists: {sum(len(b.items) for b in parsed.blocks if b.kind == 'list')} items")
    print(f"Text readback: {len(actual)} characters; exact visible-text parity passed")


TOOL_FOLDER = "export-documents-to-files"
TOOL_ID = "tool:export-a-markdown-book-to-word"
SETTINGS_READER = Path(__file__).resolve().parents[2] / "settings" / "read-data"


def read_settings(settings_record: Path | None, book_id: str | None) -> dict | None:
    """The book's settings row (the record records:read gave, saved as JSON), read through the one shared reader
    (tools/settings `setting`): only record:setting:export-documents-to-files~piece~<book_id>, active, for this tool."""
    if settings_record is None:
        return None
    if not book_id:
        raise ValueError("--book-id names the piece whose settings row to read")
    if not (SETTINGS_READER / "settings.py").is_file():
        raise ValueError("tools/settings is not in this checkout; the settings row cannot be read")
    sys.path.insert(0, str(SETTINGS_READER))
    try:
        import settings as settings_reader
    finally:
        sys.path.remove(str(SETTINGS_READER))
    try:
        value = settings_reader.setting(settings_record, TOOL_FOLDER, [("piece", book_id)], tool=TOOL_ID)
    except settings_reader.SettingError as error:
        raise ValueError(str(error)) from None
    if value is None:
        raise ValueError(f"No settings row {settings_reader.setting_id(TOOL_FOLDER, 'piece', book_id)} was given; export remains blocked")
    return value


def _json_file(path: Path | None):
    return json.loads(path.read_text(encoding="utf-8")) if path else None


def main(argv: Iterable[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("markdown", type=Path, nargs="?", help="Markdown source book (else the settings' manuscript)")
    parser.add_argument("--template", type=Path, help="Retained DOCX providing layout and styles (else the settings' template)")
    parser.add_argument("--output", type=Path, help="DOCX output path (else <output_folder>/<book-id>.docx from the settings)")
    parser.add_argument("--page-map", type=Path, help="Optional bookmark to rendered page number mapping for cached contents values")
    parser.add_argument("--check", action="store_true", help="Parse and report structure without writing a DOCX")
    parser.add_argument("--book-id", help="The piece id of the book's settings row")
    parser.add_argument("--settings-record", type=Path, help="The book's settings row as records:read gave it (a JSON file)")
    parser.add_argument("--settings", type=Path, help="The already-read settings object (a JSON file); for tests and the node wrapper")
    parser.add_argument("--checks-receipt", type=Path, help="The book's checks branch result for these bytes (export-a-book.mjs writes it)")
    args = parser.parse_args(argv)
    try:
        settings = _json_file(args.settings) if args.settings else read_settings(args.settings_record, args.book_id)
    except (ValueError, OSError, json.JSONDecodeError) as error:
        parser.error(str(error))
    settings_view = settings if isinstance(settings, dict) else {}
    markdown = args.markdown or (Path(settings_view["manuscript"]) if settings_view.get("manuscript") else None)
    if markdown is None:
        parser.error("the Markdown source is required (an argument or the settings' manuscript)")
    source_bytes = markdown.read_bytes()
    source_text = source_bytes.decode("utf-8")
    parsed = parse_markdown(source_text)
    if args.check:
        _check(parsed, source_text)
        return 0
    template = args.template or (Path(settings_view["template"]) if settings_view.get("template") else None)
    output = args.output or (Path(settings_view["output_folder"]) / f"{args.book_id}.docx"
                             if settings_view.get("output_folder") and args.book_id else None)
    if not template or not output:
        parser.error("--template and --output are required unless --check is used or the settings name them")
    page_map = json.loads(args.page_map.read_text()) if args.page_map else None
    try:
        gate_receipt = render_document(parsed, template, output, page_map,
                                       source_path=markdown, source_bytes=source_bytes,
                                       settings=settings, checks_receipt=_json_file(args.checks_receipt))
    except (ValueError, json.JSONDecodeError) as error:
        parser.error(str(error))
    print(f"Created {output} ({len(parsed.headings)} headings, {len(parsed.tables)} tables)")
    decider = gate_receipt.get("decider2b_evidence") if isinstance(gate_receipt, dict) else None
    if isinstance(decider, dict):
        print(f"Decider execution: {decider['status']}; model qualification: {decider['model_qualification']}; voice certification: {decider['voice_certification']}")
    print(json.dumps({"written": str(output), "headings": len(parsed.headings), "tables": len(parsed.tables),
                      "gate": gate_receipt}, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    sys.exit(main())
