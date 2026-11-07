#!/usr/bin/env python3
"""Inspect captured private PDF bytes with the bundled PDF library.

Produces page pixels, searchable text and bounded source-block/page mappings.
It never grants voice qualification or substitutes pixels for visual review.
"""
import argparse
import bisect
from contextlib import closing
import json
import os
from pathlib import Path
import re
import tempfile

from writing_gate import _PrivateInput, _private_layout_core, private_layout_admission


def normalized(text):
    return re.sub(r"\s+", " ", text).strip()


def block_text(block):
    if block["kind"] == "table":
        return " ".join(cell for row in block["rows"] for cell in row)
    return block["text"]


def text_mapping(projection, page_texts, title, confirmed_hyphens=None):
    prefix = normalized(title)
    expected_parts = [normalized(block_text(block)) for block in projection["ordered_blocks"]]
    expected = " ".join(expected_parts)
    compounds = set(re.findall(r"\w+(?:[-‐‑–]\w+)+", expected))
    wraps, marker_restorations = [], []
    source_tokens = (prefix + " " + expected).split()
    token_set = set(source_tokens)
    source_token_boundaries = set(zip(source_tokens, source_tokens[1:]))
    token_wraps = []
    page_parts = []
    pattern = re.compile(r"([\w‐‑–-]+[-‐‑–])[ \t]*\r?\n[ \t]*([\w‐‑–-]+)")
    for page_index, text in enumerate(page_texts):
        allowed = set((confirmed_hyphens or {}).get(page_index + 1, []))
        def restore_marker(match):
            if match.start(2) not in allowed:
                return match[0]
            choices = [match[1] + hyphen + match[3] for hyphen in "-‐‑–"
                       if match[1] + hyphen + match[3] in compounds]
            if len(choices) != 1:
                return match[0]
            marker_restorations.append({"page_number": page_index + 1,
                "original_text_range": [match.start(), match.end()],
                "original": match[0], "source_compound": choices[0],
                "basis": "PDFium IsHyphen=1 at this exact extraction position; unique exact source compound"})
            return choices[0]
        text = re.sub(r"([\w‐‑–-]+)([\x02\ufffe])([\w‐‑–-]+)", restore_marker, text)
        def join_wrap(match):
            joined = match[1] + match[2]
            if joined not in compounds:
                return match[0]
            wraps.append({"page_number": page_index + 1, "original": match[0], "joined": joined})
            return joined
        text = pattern.sub(join_wrap, text)
        text = re.sub(r"([\w‐‑–-]+)[ \t]*\r?\n[ \t]*([-‐‑–][\w‐‑–-]+)", join_wrap, text)
        def join_source_token(match):
            joined = match[1] + match[2]
            # A layout line break can split one source token in any script.
            # Never remove an ordinary space, invent a missing character, or
            # join a boundary that the source itself intentionally contains.
            if joined not in token_set or (match[1], match[2]) in source_token_boundaries:
                return match[0]
            token_wraps.append({"page_number": page_index + 1,
                "comparison_input_range": [match.start(), match.end()],
                "original": match[0], "joined": joined,
                "basis": "Exact contiguous source token; extracted line break; split token pair is not a source boundary",
                "coordinate_scope": "Page text after listed compound restorations, before source-token restorations"})
            return joined
        text = re.sub(r"(\S+)[ \t]*\r?\n[ \t]*(\S+)", join_source_token, text)
        page_parts.append(normalized(text))
    separators = [""] + [" "] * max(0, len(page_parts) - 1)
    for index in range(1, len(page_parts)):
        left = re.search(r"([\w‐‑–-]+[-‐‑–])$", page_parts[index - 1])
        right = re.match(r"([\w‐‑–-]+)", page_parts[index])
        if left and right and left[1] + right[1] in compounds:
            separators[index] = ""
            wraps.append({"page_boundary": [index, index + 1],
                          "left": left[1], "right": right[1], "joined": left[1] + right[1]})
        else:
            left = re.search(r"([\w‐‑–-]+)$", page_parts[index - 1])
            right = re.match(r"([-‐‑–][\w‐‑–-]+)", page_parts[index])
            if left and right and left[1] + right[1] in compounds:
                separators[index] = ""
                wraps.append({"page_boundary": [index, index + 1],
                              "left": left[1], "right": right[1], "joined": left[1] + right[1]})
    expected_stream = prefix + " " + expected
    intervals, position = [], len(prefix) + 1
    for index, (block, text) in enumerate(zip(projection["ordered_blocks"], expected_parts)):
        if block["kind"] == "table":
            intervals.append((position, position + len(text), index,
                              normalized(" ".join(block["rows"][0]))))
        position += len(text) + 1
    # A layout engine can repeat a table header at a page break. Recognize it
    # only inside that same source table, after its original header, when
    # removing exactly that page prefix restores the complete page's match.
    repetitions, stream_position, stream_matches = [], 0, True
    for page_index, part in enumerate(page_parts):
        stream_position += len(separators[page_index])
        if stream_matches:
            for start, end, block_index, header in intervals:
                if (start + len(header) < stream_position < end and part.startswith(header + " ")
                        and part[len(header) + 1:]
                        and expected_stream.startswith(part[len(header) + 1:], stream_position)):
                    part = part[len(header) + 1:]
                    page_parts[page_index] = part
                    repetitions.append({"page_number": page_index + 1,
                        "request_block_index": block_index, "header_text": header,
                        "normalized_original_page_prefix_range": [0, len(header)]})
                    break
            stream_matches = expected_stream.startswith(part, stream_position)
        stream_position += len(part)
    offsets, cursor = [], 0
    for index, part in enumerate(page_parts):
        cursor += len(separators[index])
        offsets.append(cursor)
        cursor += len(part)
    actual = "".join(separator + part for separator, part in zip(separators, page_parts))
    title_matches = bool(prefix and actual.startswith(prefix + " "))
    body_start = len(prefix) + 1 if title_matches else 0
    mappings, search_at = [], body_start
    for index, text in enumerate(expected_parts):
        start = actual.find(text, search_at)
        if start < 0:
            mappings.append({"request_block_index": index, "mapped": False})
            continue
        end = start + len(text)
        mappings.append({"request_block_index": index, "mapped": True,
            "first_page": bisect.bisect_right(offsets, start),
            "last_page": bisect.bisect_right(offsets, max(start, end - 1)),
            "normalized_pdf_comparison_range": [start, end],
            "source_binding": projection["ordered_bindings"][index]})
        search_at = end
    return {"title_matches": title_matches,
        "exact_ordered_text_after_whitespace_normalization": actual[body_start:] == expected,
        "layout_header_repetitions": repetitions,
        "source_compound_line_wraps": wraps,
        "source_token_line_wraps": token_wraps,
        "source_compound_hyphen_marker_restorations": marker_restorations,
        "mapped_blocks": sum(row["mapped"] for row in mappings),
        "total_blocks": len(expected_parts), "blocks": mappings,
        "scope": "Whitespace-normalized comparison coordinates after listed table-header repetitions, source-confirmed token/compound line wraps and PDFium-confirmed hyphen-marker restorations to unique exact source compounds. Both original API texts are retained. Token restoration never joins an intentional source token boundary. These are not Markdown byte offsets; no words or quantities are rewritten."}


def inspect_pdf(source_path, settings, job_path, pdf_path, dpi, text_only=False):
    import pypdfium2 as pdfium
    import pypdfium2.raw as pdfium_raw
    if not 72 <= dpi <= 200:
        raise ValueError("Inspection raster DPI must be between 72 and 200")
    source_path, job_path, pdf_path = map(Path, (source_path, job_path, pdf_path))
    for path in (source_path, job_path, pdf_path):
        if not path.is_absolute() or any(part in {".", ".."} for part in str(path).split("/")):
            raise ValueError("Inspection paths must be exact absolute paths without dot segments")
    with private_layout_admission(source_path, settings, job_path) as admission:
        input_root = admission["input_root"]
        output_root = admission["output_root"]
        if not pdf_path.is_relative_to(output_root) or not pdf_path.is_file():
            raise ValueError("The PDF must exist inside the policy-owned private proof output")
        projection = json.loads(admission["captures"]["projection"].content)
        if projection.get("schema") != "documents-structured-file-projection-v1":
            raise ValueError("A maintained Documents plain projection is required")
        core = _private_layout_core()
        with _PrivateInput(pdf_path, input_root, max_bytes=128 * 1024 * 1024) as pdf:
            admission["validate"]()
            core.private_directory(pdf_path.parent)
            output = Path(tempfile.mkdtemp(prefix="page-inspection-", dir=pdf_path.parent))
            pages, texts, confirmed_hyphens = [], [], {}
            with pdfium.PdfDocument(pdf.content) as document:
                if not 0 < len(document) <= 500:
                    raise ValueError("A readable PDF with 1 to 500 pages is required")
                for index in range(len(document)):
                    with closing(document[index]) as page:
                        width, height = page.get_size()
                        with closing(page.get_textpage()) as textpage:
                            range_text = textpage.get_text_range(errors="strict")
                            # Keep both PDFium APIs; neither is treated as source text.
                            text = textpage.get_text_bounded(errors="strict")
                            hyphen_markers = []
                            for marker in re.finditer("\ufffe", range_text):
                                char_index = pdfium_raw.FPDFText_GetCharIndexFromTextIndex(textpage, marker.start())
                                hyphen_markers.append({"range_text_index": marker.start(), "char_index": char_index,
                                    "pdfium_is_hyphen": pdfium_raw.FPDFText_IsHyphen(textpage, char_index),
                                    "pdfium_unicode": pdfium_raw.FPDFText_GetUnicode(textpage, char_index)})
                            aligned = range_text.replace("\ufffe", "\x02") == text
                            if aligned:
                                confirmed_hyphens[index + 1] = [row["range_text_index"] for row in hyphen_markers
                                    if row["pdfium_is_hyphen"] == 1 and row["pdfium_unicode"] == 2]
                            outside = []
                            for box_index in range(textpage.count_rects()):
                                x0, y0, x1, y1 = textpage.get_rect(box_index)
                                if min(x0, y0) < -0.5 or x1 > width + 0.5 or y1 > height + 0.5:
                                    outside.append([x0, y0, x1, y1])
                        texts.append(text)
                        image, pixel_size = None, None
                        if not text_only:
                            image = output / f"page-{index + 1:03d}.png"
                            with closing(page.render(scale=dpi / 72)) as bitmap:
                                pixel_size = [bitmap.width, bitmap.height]
                                pixels = bitmap.to_pil()
                                pixels.save(image)
                                pixels.close()
                            image.chmod(0o600)
                        pages.append({"page_number": index + 1, "image": str(image) if image else None, "text": text,
                            "range_api_text": range_text, "text_extraction": "PDFium full-page bounded Unicode",
                            "pdfium_hyphen_markers": hyphen_markers,
                            "api_texts_align_except_confirmed_hyphen_encoding": aligned,
                            "page_points": [width, height], "pixel_size": pixel_size,
                            "text_boxes_outside_page": outside})
            admission["validate"]()
            report = {"schema": "private-pdf-page-inspection-v1", "pdf": str(pdf_path),
                "pdf_identity": "1f:" + pdf.identity,
                "projection_identity": "1f:" + admission["captures"]["projection"].identity.removeprefix("blake3:"),
                "page_count": len(pages), "dpi": None if text_only else dpi, "rasterized": not text_only, "pages": pages,
                "text_readback": text_mapping(projection, texts, admission["title"], confirmed_hyphens),
                "visual_review": "not_performed", "voice_qualification": "not_established",
                "delivery_eligible": False}
            core.write_private(output / "inspection.json", report)
            pdf.validate()
            admission["validate"]()
            return {"inspection": str(output / "inspection.json"), "pdf_identity": "1f:" + pdf.identity,
                    "page_count": len(pages),
                    "text_readback": {key: value for key, value in report["text_readback"].items() if key != "blocks"}}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("source", help="Exact Markdown source admitted by the private layout purpose")
    parser.add_argument("--settings", required=True, help="Current export settings row with private purpose admission")
    parser.add_argument("--job-file", required=True, help="Exact source-bound structured job admitted by policy")
    parser.add_argument("--pdf", required=True, help="Rendered PDF inside policy-owned private proof output")
    parser.add_argument("--dpi", type=int, default=120)
    parser.add_argument("--text-only", action="store_true")
    args = parser.parse_args()
    os.umask(0o077)
    with open(args.settings, encoding="utf-8") as handle:
        settings = json.load(handle)
    print(json.dumps(inspect_pdf(args.source, settings, args.job_file, args.pdf, args.dpi, args.text_only)))


if __name__ == "__main__":
    main()
