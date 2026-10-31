#!/usr/bin/env python3
# tools/export-documents-to-files/do-work/render-structured-file-export.py
#
# Renders a caller-supplied node tree to a file on disk, driven entirely by
# projection-rules DATA. The tree is opaque caller vocabulary: which props
# carry text, what shape counts as a table, and how each format's body is
# assembled all come from the rules record, never from code constants.

import argparse
from html import escape
from io import BytesIO
import json
import os
import stat
import sys
import unicodedata
import xml.sax.saxutils
from zipfile import ZIP_DEFLATED, ZipFile


# File-backed JSON inputs keep large structured jobs out of process argv while
# retaining a bounded read when this renderer is called directly.
MAX_JSON_INPUT_BYTES = 4 * 1024 * 1024


def first_text(node, text_properties):
    props = node.get("props") or {}
    for key in text_properties:
        value = props.get(key)
        if isinstance(value, str) and value.strip():
            return value.strip()
    return None


_MISSING = object()


def value_at_path(value, path):
    """Resolve a DATA-selected field path without interpreting caller node keys."""
    if not isinstance(path, list) or not path:
        return _MISSING
    for key in path:
        if isinstance(value, dict) and isinstance(key, str) and key in value:
            value = value[key]
        else:
            return _MISSING
    return value


def positive_heading_level(value, label="heading level"):
    if isinstance(value, bool) or not isinstance(value, int) or not 1 <= value <= 9:
        raise ValueError(f"{label} must be an integer from 1 through 9")
    return value


def visible_children(node):
    return [child for child in (node.get("children") or []) if child.get("visible") is not False]


def row_cells(node, rules):
    kids = visible_children(node)
    if len(kids) < rules["table"]["min_cells"]:
        return None
    cells = []
    for kid in kids:
        text = first_text(kid, rules["text_properties"])
        if text is None or visible_children(kid):
            return None
        cells.append(text)
    return cells


def table_rows(node, rules):
    kids = visible_children(node)
    if len(kids) < rules["table"]["min_rows"]:
        return None
    rows = []
    for kid in kids:
        cells = row_cells(kid, rules)
        if not cells:
            return None
        rows.append(cells)
    return rows


def project(node, rules, title=None):
    """One generic walk -> sections with legacy views and ordered body blocks."""
    sections = []
    current = {"heading": None, "heading_level": None, "lines": [], "rows": [], "blocks": []}
    skip_title_echo = rules.get("skip_root_text_matching_title", True)

    def empty_section():
        return {"heading": None, "heading_level": None, "lines": [], "rows": [], "blocks": []}

    def flush():
        nonlocal current
        if current["heading"] or current["lines"] or current["rows"]:
            sections.append(current)
        current = empty_section()

    def visit(item, item_depth):
        if item.get("visible") is False:
            return
        rows = table_rows(item, rules)
        if rows:
            current["rows"].extend(rows)
            current["blocks"].append({"type": "table", "rows": rows})
            return
        kids = visible_children(item)
        own_text = first_text(item, rules["text_properties"])
        source_heading_level = value_at_path(item, rules.get("heading_level_path"))
        has_source_heading_level = source_heading_level is not _MISSING
        if item_depth == 0 and skip_title_echo and own_text is not None and own_text == title:
            own_text = None
        if item_depth > 0 and own_text is not None and (kids or has_source_heading_level):
            flush()
            current["heading"] = own_text
            if has_source_heading_level:
                current["heading_level"] = positive_heading_level(source_heading_level)
            for kid in kids:
                visit(kid, item_depth + 1)
            flush()
            return
        if own_text is not None:
            current["lines"].append(own_text)
            current["blocks"].append({"type": "paragraph", "text": own_text})
        for kid in kids:
            visit(kid, item_depth + 1)

    visit(node, 0)
    flush()
    return sections


def section_blocks(section):
    """Read ordered blocks, projecting older section-only data in legacy order."""
    blocks = section.get("blocks")
    if isinstance(blocks, list):
        return blocks
    return ([{"type": "paragraph", "text": line} for line in section.get("lines", [])]
            + ([{"type": "table", "rows": section.get("rows", [])}]
               if section.get("rows") else []))


def apply_escapes(value, escapes):
    for rule in escapes or []:
        value = value.replace(rule["find"], rule["replace"])
    return value


def render(title, sections, fmt):
    """Assemble the body purely from the format's DATA templates."""
    if fmt.get("renderer") == "docx":
        return render_docx(title, sections, fmt)
    if fmt.get("renderer") == "pdf":
        return render_pdf(title, sections, fmt)
    parts = []
    if fmt.get("title_template"):
        parts.append(fmt["title_template"].replace("{title}", title))
    for section in sections:
        if section["heading"] and fmt.get("heading_template"):
            parts.append(fmt["heading_template"].replace("{heading}", section["heading"]))
        for block in section_blocks(section):
            if block.get("type") == "paragraph":
                parts.append(fmt["line_template"].replace("{line}", block["text"]))
                continue
            if block.get("type") != "table":
                continue
            rows = block["rows"]
            width = max(len(row) for row in rows)
            padded = [row + [""] * (width - len(row)) for row in rows]
            cell_sep = fmt.get("cell_separator", " ")
            row_sep = fmt.get("row_separator", "\n")
            table_lines = []
            for index, row in enumerate(padded):
                cells = [apply_escapes(cell, fmt.get("cell_escapes")) for cell in row]
                table_lines.append(fmt["row_template"].replace("{cells}", cell_sep.join(cells)))
                if index == 0 and fmt.get("header_rule_template"):
                    rule_cells = cell_sep.join([fmt.get("header_rule_cell", "---")] * width)
                    table_lines.append(fmt["header_rule_template"].replace("{cells}", rule_cells))
            parts.append(row_sep.join(table_lines))
    body = fmt.get("part_separator", "\n\n").join(parts)
    return fmt.get("document_template", "{body}\n").replace("{body}", body)


def render_docx(title, sections, fmt):
    """Create a minimal Word OOXML document with only the Python stdlib."""
    word = "http://schemas.openxmlformats.org/wordprocessingml/2006/main"
    word_rel = "http://schemas.openxmlformats.org/officeDocument/2006/relationships"
    package_rel = "http://schemas.openxmlformats.org/package/2006/relationships"

    def style_properties(config, default_size=None, default_bold=False):
        if not isinstance(config, dict):
            raise ValueError("DOCX paragraph style configuration must be an object")
        run, paragraph = [], []
        family = config.get("font_family")
        if family is not None:
            if not isinstance(family, str) or not family.strip() or len(family) > 200:
                raise ValueError("DOCX font_family must be a nonempty bounded string")
            family = escape(family, quote=True)
            run.append(f'<w:rFonts w:ascii="{family}" w:hAnsi="{family}" w:eastAsia="{family}" w:cs="{family}"/>')
        size = config.get("size_half_points", default_size)
        if size is not None:
            if isinstance(size, bool) or not isinstance(size, int) or size <= 0:
                raise ValueError("DOCX style size_half_points must be a positive integer")
            run.append(f'<w:sz w:val="{size}"/>')
        bold = config.get("bold", default_bold)
        if type(bold) is not bool:
            raise ValueError("DOCX style bold must be boolean")
        if bold:
            run.append("<w:b/>")
        spacing = []
        for key, attribute in (("space_before_twips", "before"), ("space_after_twips", "after"),
                               ("line_spacing", "line")):
            if key not in config:
                continue
            value = config[key]
            minimum = 1 if key == "line_spacing" else 0
            if type(value) is not int or not minimum <= value <= 31680:
                raise ValueError(f"DOCX {key} must be a bounded integer")
            spacing.append(f'w:{attribute}="{value}"')
        if "line_spacing" in config:
            spacing.append('w:lineRule="auto"')
        if spacing:
            paragraph.append('<w:spacing ' + " ".join(spacing) + '/>')
        if "widow_control" in config:
            widow_control = config["widow_control"]
            if type(widow_control) is not bool:
                raise ValueError("DOCX widow_control must be boolean")
            paragraph.append(f'<w:widowControl w:val="{1 if widow_control else 0}"/>')
        return "".join(paragraph), "".join(run)

    heading_styles = fmt.get("heading_styles") or {}
    heading_levels = {}
    used_style_ids = {"Normal", "Title"} | ({"TableText"} if "table_style" in fmt else set())
    for raw_level, config in heading_styles.items():
        level = positive_heading_level(int(raw_level), "configured heading level")
        if not isinstance(config, dict) or not isinstance(config.get("style_id"), str):
            raise ValueError(f"DOCX heading style for level {level} must define style_id")
        style_id = config["style_id"]
        if not style_id or not style_id.replace("_", "").isalnum():
            raise ValueError(f"DOCX heading style id for level {level} is invalid")
        if style_id in used_style_ids:
            raise ValueError("DOCX paragraph style identities must be unique")
        used_style_ids.add(style_id)
        heading_levels[level] = {**config, "style_id": style_id}

    header_rows = fmt.get("table_header_rows", 0)
    if type(header_rows) is not int or not 0 <= header_rows <= 64:
        raise ValueError("DOCX table_header_rows must be an integer from 0 to 64")
    allow_row_split = fmt.get("table_allow_row_split", True)
    if type(allow_row_split) is not bool:
        raise ValueError("DOCX table_allow_row_split must be boolean")
    after_table = fmt.get("space_after_table_twips")
    if after_table is not None and (type(after_table) is not int or not 0 <= after_table <= 31680):
        raise ValueError("DOCX space_after_table_twips must be a bounded integer")

    # Unicode WORD JOINER supplies the missing no-break form of caller-selected
    # punctuation without substituting its visible glyph or editing the source
    # tree. Opt-in DATA applies equally to title, headings, prose and table cells.
    no_break_characters = fmt.get("no_break_characters", [])
    if (not isinstance(no_break_characters, list) or len(no_break_characters) > 64
            or any(not isinstance(char, str) or len(char) != 1
                   or unicodedata.category(char)[0] in {"C", "Z"}
                   for char in no_break_characters)):
        raise ValueError("DOCX no_break_characters must be a bounded list of visible single characters")
    no_break_characters = set(no_break_characters)

    def protect_breaks(text):
        if not no_break_characters:
            return text
        output = []
        for index, char in enumerate(text):
            if char in no_break_characters and (not output or output[-1] != "\u2060"):
                output.append("\u2060")
            output.append(char)
            if char in no_break_characters and (index + 1 == len(text) or text[index + 1] != "\u2060"):
                output.append("\u2060")
        return "".join(output)

    def paragraph(text, style=None, space_before=None):
        if style in {config["style_id"] for config in heading_levels.values()}:
            # Keep the heading with its first following paragraph, and prevent
            # Word from splitting the heading itself across pages.
            ppr = f'<w:pPr><w:pStyle w:val="{escape(style, quote=True)}"/><w:keepNext/><w:keepLines/></w:pPr>'
        else:
            ppr = f'<w:pPr><w:pStyle w:val="{escape(style, quote=True)}"/></w:pPr>' if style else ""
        if space_before is not None:
            spacing = f'<w:spacing w:before="{space_before}"/>'
            ppr = ppr.replace("</w:pPr>", spacing + "</w:pPr>") if ppr else f'<w:pPr>{spacing}</w:pPr>'
        return f'<w:p>{ppr}<w:r><w:t xml:space="preserve">{escape(protect_breaks(text))}</w:t></w:r></w:p>'

    def table(rows):
        width = max([1] + [len(row) for row in rows])
        # Word's editable table model requires a grid even when it later
        # autofits the cells. Match the existing Letter page's text width.
        column_width = 9360 // width
        grid = '<w:tblGrid>' + ''.join(
            f'<w:gridCol w:w="{column_width + (9360 % width if index == width - 1 else 0)}"/>'
            for index in range(width)) + '</w:tblGrid>'
        rendered_rows = []
        if header_rows > len(rows):
            raise ValueError("DOCX table_header_rows exceeds the table's row count")
        for row_index, row in enumerate(rows):
            cells = []
            for index in range(width):
                value = row[index] if index < len(row) else ""
                cells.append(f'<w:tc><w:tcPr><w:tcW w:w="0" w:type="auto"/></w:tcPr>{paragraph(value, "TableText" if "table_style" in fmt else None)}</w:tc>')
            row_properties = ('<w:tblHeader/>' if row_index < header_rows else "") + ("" if allow_row_split else '<w:cantSplit/>')
            row_properties = '<w:trPr>' + row_properties + '</w:trPr>' if row_properties else ""
            rendered_rows.append(f'<w:tr>{row_properties}{"".join(cells)}</w:tr>')
        return '<w:tbl><w:tblPr><w:tblBorders><w:top w:val="single" w:sz="4"/><w:left w:val="single" w:sz="4"/><w:bottom w:val="single" w:sz="4"/><w:right w:val="single" w:sz="4"/><w:insideH w:val="single" w:sz="4"/><w:insideV w:val="single" w:sz="4"/></w:tblBorders></w:tblPr>' + grid + "".join(rendered_rows) + "</w:tbl>"

    body = [paragraph(title, "Title")] if title else []
    previous_table = False
    for section in sections:
        if section.get("heading"):
            level = positive_heading_level(
                section.get("heading_level") if section.get("heading_level") is not None
                else fmt.get("default_heading_level", 1),
                "projected heading level",
            )
            config = heading_levels.get(level)
            if config is None:
                raise ValueError(f"DOCX heading level {level} has no configured style")
            body.append(paragraph(section["heading"], config["style_id"]))
            previous_table = False
        for block in section_blocks(section):
            if block.get("type") == "paragraph":
                body.append(paragraph(block["text"], space_before=after_table if previous_table else None))
                previous_table = False
            elif block.get("type") == "table":
                body.append(table(block["rows"]))
                previous_table = True
    body.append('<w:sectPr><w:pgSz w:w="12240" w:h="15840"/><w:pgMar w:top="1440" w:right="1440" w:bottom="1440" w:left="1440"/></w:sectPr>')

    heading_style_xml = []
    for level, config in sorted(heading_levels.items()):
        size = config.get("size_half_points")
        if isinstance(size, bool) or not isinstance(size, int) or size <= 0:
            raise ValueError(f"DOCX heading style for level {level} must define positive size_half_points")
        style_id = escape(config["style_id"], quote=True)
        style_name = escape(str(config.get("name", f"heading {level}")), quote=True)
        paragraph_properties, run_properties = style_properties(config, default_size=size, default_bold=True)
        heading_style_xml.append(
            f'<w:style w:type="paragraph" w:styleId="{style_id}"><w:name w:val="{style_name}"/>'
            f'<w:basedOn w:val="Normal"/><w:uiPriority w:val="{level}"/><w:qFormat/>'
            f'<w:pPr><w:keepNext/><w:keepLines/><w:outlineLvl w:val="{level - 1}"/>{paragraph_properties}</w:pPr>'
            f'<w:rPr>{run_properties}</w:rPr></w:style>'
        )
    normal_ppr, normal_rpr = style_properties(fmt.get("body_style", {}), default_size=22)
    title_ppr, title_rpr = style_properties(fmt.get("title_style", {}), default_size=36, default_bold=True)
    table_style = ""
    if "table_style" in fmt:
        table_ppr, table_rpr = style_properties(fmt["table_style"])
        table_style = ('<w:style w:type="paragraph" w:styleId="TableText"><w:name w:val="Table Text"/>'
                       f'<w:basedOn w:val="Normal"/><w:pPr>{table_ppr}</w:pPr><w:rPr>{table_rpr}</w:rPr></w:style>')
    styles = (f'<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:styles xmlns:w="{word}">'
              f'<w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/><w:pPr>{normal_ppr}</w:pPr><w:rPr>{normal_rpr}</w:rPr></w:style>'
              f'<w:style w:type="paragraph" w:styleId="Title"><w:name w:val="Title"/><w:basedOn w:val="Normal"/><w:pPr>{title_ppr}</w:pPr><w:rPr>{title_rpr}</w:rPr></w:style>'
              + table_style + "".join(heading_style_xml) + "</w:styles>")
    document = f'<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document xmlns:w="{word}" xmlns:r="{word_rel}"><w:body>{"".join(body)}</w:body></w:document>'
    content_types = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/><Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/></Types>'
    root_rels = f'<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="{package_rel}"><Relationship Id="rId1" Type="{word_rel}/officeDocument" Target="word/document.xml"/></Relationships>'
    document_rels = f'<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="{package_rel}"><Relationship Id="rId1" Type="{word_rel}/styles" Target="styles.xml"/></Relationships>'
    output = BytesIO()
    with ZipFile(output, "w", compression=ZIP_DEFLATED) as archive:
        archive.writestr("[Content_Types].xml", content_types)
        archive.writestr("_rels/.rels", root_rels)
        archive.writestr("word/document.xml", document)
        archive.writestr("word/_rels/document.xml.rels", document_rels)
        archive.writestr("word/styles.xml", styles)
    return output.getvalue()


def resolve_pdf_font(font_file):
    """Resolve a DATA-selected font filename from standard system font roots."""
    if not isinstance(font_file, str) or os.path.basename(font_file) != font_file:
        raise ValueError("PDF font_file must be a simple filename selected by projection rules")
    roots = [
        "/System/Library/Fonts/Supplemental",
        "/System/Library/Fonts",
        "/Library/Fonts",
        "/usr/share/fonts/truetype/msttcorefonts",
        "/usr/share/fonts/truetype/dejavu",
        "/usr/share/fonts/truetype/liberation",
        "C:/Windows/Fonts",
    ]
    try:
        from reportlab import __file__ as reportlab_init
        roots.insert(0, os.path.join(os.path.dirname(reportlab_init), "fonts"))
    except ImportError as exc:
        raise RuntimeError("PDF export requires the bundled ReportLab runtime") from exc
    for root in roots:
        candidate = os.path.join(root, font_file)
        if os.path.isfile(candidate):
            return candidate
    raise FileNotFoundError(f"configured PDF font {font_file!r} was not found in a supported font directory")


def render_pdf(title, sections, fmt):
    """Render a paginated Unicode PDF with an embedded DATA-selected font."""
    from reportlab.lib import colors
    from reportlab.lib.pagesizes import letter
    from reportlab.lib.styles import ParagraphStyle, getSampleStyleSheet
    from reportlab.lib.units import inch
    from reportlab.pdfbase import pdfmetrics
    from reportlab.pdfbase.ttfonts import TTFont
    from reportlab.platypus import Paragraph, SimpleDocTemplate, Spacer, Table, TableStyle

    font_file = resolve_pdf_font(fmt.get("font_file"))
    family = fmt.get("font_family", "StructuredOutputUnicode")
    regular = TTFont(f"{family}-Regular", font_file, validate=1)
    all_text = title + "".join(
        (section.get("heading") or "") + "".join(
            block.get("text", "") if block.get("type") == "paragraph"
            else "".join("".join(row) for row in block.get("rows", []))
            for block in section_blocks(section)
        )
        for section in sections
    )
    missing = sorted({char for char in all_text if not char.isspace() and ord(char) not in regular.face.charWidths})
    if missing:
        raise ValueError(f"configured PDF font {fmt.get('font_file')!r} lacks glyph coverage for: {''.join(missing[:16])!r}")
    pdfmetrics.registerFont(regular)

    sample = getSampleStyleSheet()
    body = ParagraphStyle("StructuredBody", parent=sample["BodyText"], fontName=regular.fontName,
                          fontSize=10, leading=14, spaceAfter=6, allowWidows=0, allowOrphans=0)
    title_style = ParagraphStyle("StructuredTitle", parent=sample["Title"], fontName=regular.fontName,
                                 fontSize=22, leading=27, spaceAfter=18, keepWithNext=True)
    heading_styles = fmt.get("heading_styles") or {}
    default_heading_level = fmt.get("default_heading_level", 2)
    positive_heading_level(default_heading_level, "PDF default heading level")

    def heading_style(level):
        level = positive_heading_level(level, "projected heading level")
        config = heading_styles.get(str(level))
        if not isinstance(config, dict):
            raise ValueError(f"PDF heading level {level} has no configured style")
        required = ("font_size", "leading", "space_before", "space_after")
        if any(not isinstance(config.get(key), (int, float)) or isinstance(config.get(key), bool)
               or config[key] <= 0 for key in required):
            raise ValueError(f"PDF heading style for level {level} has invalid typography metadata")
        return ParagraphStyle(
            f"StructuredHeading{level}", parent=body, fontName=regular.fontName,
            fontSize=config["font_size"], leading=config["leading"],
            spaceBefore=config["space_before"], spaceAfter=config["space_after"],
            keepWithNext=config.get("keep_with_next", True),
            keepTogether=config.get("keep_together", True),
        )
    cell_style = ParagraphStyle("StructuredCell", parent=body, fontSize=8.5, leading=11, spaceAfter=0)
    # Explicitly split long unbroken Unicode tokens instead of allowing them to
    # widen a table cell beyond its allocated printable column.
    cell_style.splitLongWords = 1

    output = BytesIO()
    document = SimpleDocTemplate(output, pagesize=letter,
                                rightMargin=0.75 * inch, leftMargin=0.75 * inch,
                                topMargin=0.7 * inch, bottomMargin=0.7 * inch,
                                title=title, author=fmt.get("author", ""))

    def para(value, style=body):
        return Paragraph(xml.sax.saxutils.escape(value), style)

    story = [para(title, title_style)] if title else []
    for section in sections:
        if section.get("heading"):
            level = section.get("heading_level") if section.get("heading_level") is not None else default_heading_level
            story.append(para(section["heading"], heading_style(level)))
        for block in section_blocks(section):
            if block.get("type") == "paragraph":
                story.append(para(block["text"]))
                continue
            if block.get("type") != "table":
                continue
            rows = block["rows"]
            width = max(len(row) for row in rows)
            column_width = document.width / width
            horizontal_padding = 12
            if column_width <= horizontal_padding:
                raise ValueError(
                    f"PDF table with {width} columns cannot fit the printable width "
                    f"({document.width:.1f} pt) with readable cell space"
                )
            normalized = [row + [""] * (width - len(row)) for row in rows]
            table = Table([[para(cell, cell_style) for cell in row] for row in normalized],
                          colWidths=[column_width] * width, repeatRows=1, hAlign="LEFT")
            table.setStyle(TableStyle([
                ("GRID", (0, 0), (-1, -1), 0.45, colors.HexColor("#AAB7C4")),
                ("BACKGROUND", (0, 0), (-1, 0), colors.HexColor("#EAF0F5")),
                ("VALIGN", (0, 0), (-1, -1), "TOP"),
                ("LEFTPADDING", (0, 0), (-1, -1), 6),
                ("RIGHTPADDING", (0, 0), (-1, -1), 6),
                ("TOPPADDING", (0, 0), (-1, -1), 4),
                ("BOTTOMPADDING", (0, 0), (-1, -1), 4),
            ]))
            story.extend([table, Spacer(1, 8)])

    document.build(story)
    return output.getvalue()


def pick_rules(rows, rules_id):
    for row in rows:
        payload = row.get("payload") if isinstance(row.get("payload"), dict) else row
        if isinstance(payload, dict) and payload.get("kind") == "structured-file-projection-rules":
            if payload.get("id") == rules_id:
                return payload
    for row in rows:
        payload = row.get("payload") if isinstance(row.get("payload"), dict) else row
        if isinstance(payload, dict) and payload.get("kind") == "structured-file-projection-rules":
            return payload
    return None


def read_json_file(path, label):
    """Read bounded UTF-8 JSON while the opened file and path stay unchanged."""
    descriptor = None

    def snapshot(info):
        return (
            info.st_dev, info.st_ino, info.st_mode, info.st_size,
            info.st_mtime_ns, info.st_ctime_ns,
        )

    try:
        before = os.lstat(path)
        if not stat.S_ISREG(before.st_mode):
            raise ValueError(f"{label} file must be a regular, non-symlink file")
        flags = os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0)
        descriptor = os.open(path, flags)
        opened = os.fstat(descriptor)
        if not stat.S_ISREG(opened.st_mode) or snapshot(opened) != snapshot(before):
            raise ValueError(f"{label} file must be a regular, non-symlink file")
        if opened.st_size > MAX_JSON_INPUT_BYTES:
            raise ValueError(f"{label} file exceeds the {MAX_JSON_INPUT_BYTES}-byte JSON input limit")
        with os.fdopen(descriptor, "rb") as handle:
            descriptor = None
            data = handle.read(MAX_JSON_INPUT_BYTES + 1)
            if len(data) > MAX_JSON_INPUT_BYTES:
                raise ValueError(f"{label} file exceeds the {MAX_JSON_INPUT_BYTES}-byte JSON input limit")
            after_fd = os.fstat(handle.fileno())
            after_path = os.lstat(path)
            if (not stat.S_ISREG(after_fd.st_mode)
                    or not stat.S_ISREG(after_path.st_mode)
                    or snapshot(after_fd) != snapshot(opened)
                    or snapshot(after_path) != snapshot(opened)
                    or len(data) != opened.st_size
                    or len(data) != after_fd.st_size):
                raise ValueError(f"{label} file changed during read or was replaced")
    except ValueError:
        raise
    except OSError as exc:
        raise ValueError(f"{label} file could not be read safely") from exc
    finally:
        if descriptor is not None:
            try:
                os.close(descriptor)
            except OSError:
                pass

    try:
        text = data.decode("utf-8")
    except UnicodeDecodeError as exc:
        raise ValueError(f"{label} file is not valid UTF-8") from exc
    try:
        return json.loads(text)
    except json.JSONDecodeError as exc:
        raise ValueError(f"{label} file is not valid JSON") from exc


def main():
    parser = argparse.ArgumentParser()
    job_input = parser.add_mutually_exclusive_group(required=True)
    job_input.add_argument("--job-json")
    job_input.add_argument("--job-file")
    rules_input = parser.add_mutually_exclusive_group(required=True)
    rules_input.add_argument("--rules-rows-json")
    rules_input.add_argument("--rules-rows-file")
    parser.add_argument(
        "--project-only",
        action="store_true",
        help="emit the DATA-driven projection without rendering or writing an export",
    )
    parser.add_argument("--result-path", default=None)
    args = parser.parse_args()

    try:
        job = (read_json_file(args.job_file, "job") if args.job_file is not None
               else json.loads(args.job_json))
        rules_rows = (read_json_file(args.rules_rows_file, "projection rules")
                      if args.rules_rows_file is not None else json.loads(args.rules_rows_json))
    except ValueError as exc:
        print(json.dumps({"error": str(exc)}))
        sys.exit(1)
    descriptor = job["descriptor"]
    rules = pick_rules(rules_rows, job.get("rules_id", descriptor.get("rules_id", "default")))
    if rules is None:
        print(json.dumps({"error": "no projection rules record was found"}))
        sys.exit(1)

    fmt = (rules.get("formats") or {}).get(descriptor["format_id"])
    if fmt is None:
        print(json.dumps({"error": f"format {descriptor['format_id']} is not in the projection rules"}))
        sys.exit(1)

    sections = project(job["tree"], rules, title=job.get("title"))
    if args.project_only:
        projection = {
            "kind": "structured-file-export-projection",
            "schema_version": 1,
            "format_id": descriptor["format_id"],
            "title": job.get("title", ""),
            "sections": sections,
        }
        print(json.dumps(projection, ensure_ascii=False))
        return

    body = render(job.get("title", ""), sections, fmt)

    destination_dir = descriptor["destination_dir"]
    if not destination_dir.startswith("/"):
        print(json.dumps({"error": "destination_dir must be a full path starting with /"}))
        sys.exit(1)
    stem = descriptor["file_stem"]
    if not isinstance(stem, str) or not stem or os.path.basename(stem) != stem or stem in (".", ".."):
        print(json.dumps({"error": "file_stem must be a plain file name without a folder"}))
        sys.exit(1)
    data = body if isinstance(body, bytes) else body.encode("utf-8")

    os.makedirs(destination_dir, exist_ok=True)
    path = os.path.join(destination_dir, f"{descriptor['file_stem']}.{fmt['extension']}")
    with open(path, "wb") as handle:
        handle.write(data)

    # Fail closed (L117): verify the file actually landed on disk with the exact
    # bytes we intended before reporting success — never claim "saved" for a write
    # the filesystem didn't durably accept (short write, full disk, path removed).
    try:
        written = os.path.getsize(path)
    except OSError as exc:
        print(json.dumps({"error": f"export could not confirm the saved file: {exc}"}))
        sys.exit(1)
    if written != len(data):
        print(json.dumps({"error": f"export wrote {written} bytes but expected {len(data)}"}))
        sys.exit(1)
    try:
        with open(path, "rb") as handle:
            written_data = handle.read()
    except OSError as exc:
        print(json.dumps({"error": f"export could not verify the saved bytes: {exc}"}))
        sys.exit(1)
    if written_data != data:
        print(json.dumps({"error": "export saved bytes differ from the rendered content"}))
        sys.exit(1)
    result = {
        "kind": "structured-file-export-result",
        "path": path,
        "byte_length": len(data),
        "format_id": descriptor["format_id"],
    }
    if args.result_path is not None:
        with open(args.result_path, "w") as handle:
            json.dump(result, handle)
    print(json.dumps(result))


if __name__ == "__main__":
    main()
