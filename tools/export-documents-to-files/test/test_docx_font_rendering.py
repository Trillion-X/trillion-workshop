"""Synthetic OOXML font-resolution controls for the native Word consumer."""
import argparse
from io import BytesIO
import json
import os
from pathlib import Path
import runpy
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch
import xml.etree.ElementTree as ET
from zipfile import ZipFile

RENDERER = Path(__file__).resolve().parent.parent / "do-work" / "render-structured-file-export.py"
WORD = "http://schemas.openxmlformats.org/wordprocessingml/2006/main"
NS = {"w": WORD}
PROBE = "Latin text Chinese (好奇) (問題) (问题) (追求) Greek (αβγ) arrows (→ ←). Compare 8 > 3 < 9 + 1."
TITLE = "Unicode font resolution probe >"
FAMILY = "Arial Unicode MS"


def probe_bytes():
    renderer = runpy.run_path(str(RENDERER))
    sections = [{"heading": None, "blocks": [{"type": "paragraph", "text": PROBE}]}]
    return renderer["render_docx"](TITLE, sections,
                                   {"body_style": {"font_family": FAMILY, "size_half_points": 22}})


def rewrite_xml(data, change):
    output = BytesIO()
    with ZipFile(BytesIO(data)) as original, ZipFile(output, "w") as changed:
        for item in original.infolist():
            content = original.read(item.filename)
            if item.filename in ("word/document.xml", "word/styles.xml"):
                root = ET.fromstring(content)
                change(item.filename, root)
                content = ET.tostring(root, encoding="utf-8", xml_declaration=True)
            changed.writestr(item, content)
    return output.getvalue()


def font_element():
    return ET.Element(f"{{{WORD}}}rFonts", {f"{{{WORD}}}{field}": FAMILY
                                           for field in ("ascii", "hAnsi", "eastAsia", "cs")})


def variants():
    original = probe_bytes()
    def explicit_normal(name, root):
        if name == "word/document.xml":
            for paragraph in root.findall(".//w:body/w:p", NS):
                ppr = paragraph.find("w:pPr", NS)
                if ppr is None:
                    ppr = ET.Element(f"{{{WORD}}}pPr")
                    paragraph.insert(0, ppr)
                if ppr.find("w:pStyle", NS) is None:
                    ET.SubElement(ppr, f"{{{WORD}}}pStyle", {f"{{{WORD}}}val": "Normal"})
    def doc_defaults(name, root):
        if name == "word/styles.xml":
            defaults = ET.Element(f"{{{WORD}}}docDefaults")
            rpr_default = ET.SubElement(defaults, f"{{{WORD}}}rPrDefault")
            ET.SubElement(rpr_default, f"{{{WORD}}}rPr").append(font_element())
            root.insert(0, defaults)
    def direct_runs(name, root):
        if name == "word/document.xml":
            for run in root.findall(".//w:r", NS):
                rpr = ET.Element(f"{{{WORD}}}rPr")
                rpr.append(font_element())
                run.insert(0, rpr)
    return {"baseline": original,
            "explicit-normal": rewrite_xml(original, explicit_normal),
            "doc-defaults": rewrite_xml(original, doc_defaults),
            "direct-runs": rewrite_xml(original, direct_runs)}


def write_probes(directory):
    directory.mkdir(mode=0o700, parents=True, exist_ok=True)
    written = []
    for name, data in variants().items():
        path = directory / (name + ".docx")
        with open(path, "xb", opener=lambda p, flags: os.open(p, flags, 0o600)) as output:
            output.write(data)
        written.append(str(path))
    print(json.dumps({"written": written, "probe_text": PROBE}, ensure_ascii=False))


class FontConfigurationTests(unittest.TestCase):
    def setUp(self):
        self.renderer = runpy.run_path(str(RENDERER))

    def test_docx_keeps_all_script_font_slots_and_literal_unicode(self):
        data = probe_bytes()
        with ZipFile(BytesIO(data)) as archive:
            document = ET.fromstring(archive.read("word/document.xml"))
            styles = ET.fromstring(archive.read("word/styles.xml"))
            self.assertEqual("".join(document.itertext()), TITLE + PROBE)
            fonts = styles.find("w:style[@w:styleId='Normal']/w:rPr/w:rFonts", NS)
            self.assertEqual([fonts.get(f"{{{WORD}}}{key}") for key in ("ascii", "hAnsi", "eastAsia", "cs")],
                             [FAMILY] * 4)
            self.assertFalse(any(name.startswith("word/fonts/") for name in archive.namelist()))

    def test_font_configuration_is_explicit_and_does_not_change_default_exports(self):
        self.assertEqual(self.renderer["docx_render_environment"]({}), {})
        for configuration in ({}, True, {"source": "system"}, {"source": "bundled_runtime", "command": "other"}):
            with self.subTest(configuration=configuration), self.assertRaises(ValueError):
                self.renderer["docx_render_environment"]({"font_configuration": configuration})

    def test_selected_runtime_configuration_is_returned_without_copying_fonts(self):
        with tempfile.TemporaryDirectory() as temp:
            dependencies = Path(temp) / "dependencies"
            config = dependencies / "native/libreoffice-headless/libreoffice/LibreOfficeDev.app/Contents/Resources/fontconfig/fonts.conf"
            config.parent.mkdir(parents=True)
            config.write_text("<fontconfig/>")
            executable = dependencies / "python/bin/python3"
            with patch.object(sys, "executable", str(executable)):
                actual = self.renderer["docx_render_environment"]({"font_configuration": {"source": "bundled_runtime"}})
            self.assertEqual(actual, {"FONTCONFIG_FILE": str(config)})
            self.assertEqual(config.read_text(), "<fontconfig/>")

    def test_unprovided_configuration_has_no_silent_system_runtime_fallback(self):
        for executable in ("/different-runtime/bin/python3", "/unprovided/dependencies/python/bin/python3"):
            with self.subTest(executable=executable), patch.object(sys, "executable", executable):
                with self.assertRaises(ValueError):
                    self.renderer["docx_render_environment"]({"font_configuration": {"source": "bundled_runtime"}})

    def test_read_only_cli_returns_font_environment_without_an_artifact(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            job = {"descriptor": {"format_id": "docx", "destination_dir": str(root / "unwritten"), "file_stem": "unwritten"}, "tree": {}}
            rules = [{"kind": "structured-file-projection-rules", "id": "default", "formats": {"docx": {"renderer": "docx", "extension": "docx"}}}]
            job_path, rules_path = root / "job.json", root / "rules.json"
            job_path.write_text(json.dumps(job))
            rules_path.write_text(json.dumps(rules))
            run = subprocess.run([sys.executable, str(RENDERER), "--job-file", str(job_path), "--rules-rows-file", str(rules_path),
                                  "--render-environment-only"], capture_output=True, text=True, check=True)
            self.assertEqual(json.loads(run.stdout), {"kind": "structured-file-render-environment", "format_id": "docx", "environment": {}})
            self.assertFalse((root / "unwritten").exists())


def verify_native_renderer(directory, official_renderer):
    """Exercise the real bundled consumer with the current owner's env DATA."""
    from pypdf import PdfReader
    directory.mkdir(parents=True, mode=0o700, exist_ok=True)
    source = directory / "native-font-probe.docx"
    data = probe_bytes()
    with open(source, "xb", opener=lambda p, flags: os.open(p, flags, 0o600)) as output:
        output.write(data)
    renderer = runpy.run_path(str(RENDERER))
    environment = renderer["docx_render_environment"]({"font_configuration": {"source": "bundled_runtime"}})
    config = Path(environment["FONTCONFIG_FILE"])
    config_before = config.read_bytes()
    job = {"descriptor": {"format_id": "docx"}, "tree": {}}
    rules = [{"kind": "structured-file-projection-rules", "id": "default", "formats": {"docx": {
        "renderer": "docx", "extension": "docx", "font_configuration": {"source": "bundled_runtime"}}}}]
    job_path, rules_path = directory / "environment-job.json", directory / "environment-rules.json"
    for path, value in ((job_path, job), (rules_path, rules)):
        with open(path, "x", opener=lambda p, flags: os.open(p, flags, 0o600)) as output:
            json.dump(value, output)
    resolved = subprocess.run([sys.executable, str(RENDERER), "--job-file", str(job_path), "--rules-rows-file", str(rules_path),
                              "--render-environment-only"], check=True, capture_output=True, text=True)
    assert json.loads(resolved.stdout)["environment"] == environment
    output_dir = directory / "configured-render"
    output_dir.mkdir(mode=0o700)
    run = subprocess.run([sys.executable, str(official_renderer), str(source), "--output_dir", str(output_dir), "--emit_pdf"],
                         env={**os.environ, **environment}, check=True, capture_output=True, text=True)
    reader = PdfReader(output_dir / "native-font-probe.pdf")
    text = "\n".join(page.extract_text() or "" for page in reader.pages)
    assert TITLE in text and PROBE in text, "Native PDF readback lost synthetic Unicode or comparison characters"
    fonts = sorted({str(ref.get_object().get("/BaseFont")) for page in reader.pages
                    for ref in page.get("/Resources", {}).get("/Font", {}).values()})
    assert fonts and all("ArialUnicodeMS" in font for font in fonts), fonts
    assert source.read_bytes() == data and config.read_bytes() == config_before
    assert (output_dir / "page-1.png").is_file()
    print(json.dumps({"status": "passed", "unicode_text_readback": text, "fonts": fonts,
                      "docx_unchanged": True, "vendor_config_unchanged": True, "environment": environment,
                      "page_image": str(output_dir / "page-1.png"), "renderer_stdout": run.stdout}, ensure_ascii=False))


if __name__ == "__main__":
    if "--write-probes" in sys.argv or "--verify-native" in sys.argv:
        parser = argparse.ArgumentParser(description=__doc__)
        parser.add_argument("--write-probes", type=Path)
        parser.add_argument("--verify-native", type=Path)
        parser.add_argument("--official-renderer", type=Path)
        args = parser.parse_args()
        if args.write_probes:
            write_probes(args.write_probes)
        elif args.verify_native and args.official_renderer:
            verify_native_renderer(args.verify_native, args.official_renderer)
        else:
            parser.error("Native verification requires its official renderer path")
    else:
        unittest.main()
