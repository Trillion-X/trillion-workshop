#!/usr/bin/env python3
"""tools/office-files/test/decode-office-open-xml.test.py

Proof for the decoder and the cell rewriter against a workbook this test
BUILDS itself, so the fixture is the real thing at both ends (no hand-typed
JSON pretending to be a workbook). Runs under plain python3, no runner.

Covers:
  1. shared-string, inline-string, number and formula cells decode with the
     documented {"value", "formula"} shape and stable column keys;
  2. a `cell` rule matching `formula_contains` rewrites the formula and value;
  3. a `cell` rule with `text_contains` rewrites an inline string;
  4. a rule that matches nothing reports matched 0 and leaves bytes alone;
  5. the rewritten workbook decodes again (the XML declaration survives).
"""
from __future__ import annotations

import json
import pathlib
import subprocess
import sys
import tempfile
import zipfile

HERE = pathlib.Path(__file__).resolve().parent
DECODER = HERE.parent / "do-work" / "decode-office-open-xml.py"
REWRITER = HERE.parent / "do-work" / "rewrite-office-open-xml-cells.py"

CONTENT_TYPES = (
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
    '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">'
    '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>'
    '<Default Extension="xml" ContentType="application/xml"/>'
    '<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>'
    '<Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>'
    '<Override PartName="/xl/sharedStrings.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sharedStrings+xml"/>'
    "</Types>"
)
ROOT_RELS = (
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
    '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
    '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>'
    "</Relationships>"
)
WORKBOOK = (
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
    '<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" '
    'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">'
    '<sheets><sheet name="Model" sheetId="1" r:id="rId1"/></sheets></workbook>'
)
WORKBOOK_RELS = (
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
    '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
    '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/>'
    '<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/sharedStrings" Target="sharedStrings.xml"/>'
    "</Relationships>"
)
SHARED = (
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
    '<sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" count="1" uniqueCount="1">'
    "<si><t>Runway (months)</t></si></sst>"
)
SHEET = (
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
    '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>'
    '<row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1" t="inlineStr"><is><t>Price is $2,499 per seat</t></is></c></row>'
    '<row r="2"><c r="A2"><v>12</v></c><c r="B2"><f>IF(A2&gt;0,999,A2)</f><v>999</v></c></row>'
    "</sheetData></worksheet>"
)


def build_workbook(path: pathlib.Path) -> None:
    with zipfile.ZipFile(path, "w", zipfile.ZIP_DEFLATED) as z:
        z.writestr("[Content_Types].xml", CONTENT_TYPES)
        z.writestr("_rels/.rels", ROOT_RELS)
        z.writestr("xl/workbook.xml", WORKBOOK)
        z.writestr("xl/_rels/workbook.xml.rels", WORKBOOK_RELS)
        z.writestr("xl/sharedStrings.xml", SHARED)
        z.writestr("xl/worksheets/sheet1.xml", SHEET)


def run(argv: list[str]) -> str:
    done = subprocess.run([sys.executable, *argv], capture_output=True, text=True, check=False)
    if done.returncode != 0:
        raise AssertionError(f"{argv[0]} failed: {done.stderr}")
    return done.stdout


def cells(decoded: dict) -> dict:
    sheet = decoded["sheets"][0] if "sheets" in decoded else decoded
    rows = sheet["rows"]
    return {f"{col}{row['row']}": entry for row in rows for col, entry in row["cells"].items()}


def main() -> None:
    with tempfile.TemporaryDirectory() as folder:
        src = pathlib.Path(folder) / "in.xlsx"
        out = pathlib.Path(folder) / "out.xlsx"
        rules = pathlib.Path(folder) / "rules.json"
        build_workbook(src)

        decoded = json.loads(run([str(DECODER), str(src), "--formulas"]))
        c = cells(decoded)
        assert c["A1"]["value"] == "Runway (months)", c["A1"]
        assert c["B1"]["value"] == "Price is $2,499 per seat", c["B1"]
        assert c["A2"]["value"] == 12, c["A2"]
        assert c["B2"]["value"] == 999 and c["B2"]["formula"] == "IF(A2>0,999,A2)", c["B2"]

        rules.write_text(json.dumps([
            {"kind": "cell", "match": {"formula_contains": "999"}, "set": {"formula_replace": ["999", "\"n/a\""], "value": "n/a"}},
            {"kind": "cell", "match": {"text_contains": "$2,499"}, "set": {"text_replace": ["$2,499 per seat", "$100/month bundle"]}},
            {"kind": "cell", "match": {"text_contains": "never present"}, "set": {"text_replace": ["x", "y"]}},
        ]), encoding="utf-8")
        report = json.loads(run([str(REWRITER), str(src), str(rules), str(out)]))
        matched = [r["matched"] for r in report["rules"]] if "rules" in report else report["matched"]
        assert matched[0] == 1 and matched[1] == 1 and matched[2] == 0, report

        again = cells(json.loads(run([str(DECODER), str(out), "--formulas"])))
        assert again["B2"]["formula"] == 'IF(A2>0,"n/a",A2)', again["B2"]
        assert again["B2"]["value"] == "n/a", again["B2"]
        assert again["B1"]["value"] == "Price is $100/month bundle", again["B1"]
        assert again["A1"]["value"] == "Runway (months)", again["A1"]
        with zipfile.ZipFile(out) as z:
            assert z.read("xl/worksheets/sheet1.xml").startswith(b"<?xml"), "XML declaration lost"
    print(json.dumps({"ok": True, "cases": 5}))


if __name__ == "__main__":
    main()
