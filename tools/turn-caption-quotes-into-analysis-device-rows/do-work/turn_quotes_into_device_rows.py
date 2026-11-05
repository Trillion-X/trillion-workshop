#!/usr/bin/env python3
"""Check every caption quote in a set of device rows against the videos' caption files, then (when asked and every quote holds)
write the family file, add the family's tables to an index file once, and write the checked rows with the second each quote is said.

  python3 turn_quotes_into_device_rows.py --settings-record FILE [--scope KIND:ID ...] --captions 'FOLDER/{video}.*json3'
      [--captions ...] [--family-file FILE] [--index-file FILE] [--checked-file FILE]

--settings-record is a JSON file holding the person's list:settings row for this tool, as records:read gives it
(record:setting:turn-caption-quotes-into-analysis-device-rows~<scope_kind>~<scope_id>), or several such rows; it is read
through tools/settings/read-data/settings.py. --scope picks the row (most specific first, e.g. piece:<family>); with one
row and no scope, that row is read. read-data/device_rows.py says what its settings hold.
--captions is a glob with {video} for the video id; the first non-empty caption file found is used. Quotes are matched as exact
words, ignoring case, white space and curly apostrophes (the CaptionText finder of tools/cite-principles-from-captions, given
event starts that are not rounded). Nothing is written
unless every quote is found. The last line printed is {"result": {...}}; the exit code is 1 when a quote failed, 2 when the
request could not be used.
"""
import argparse
import glob
import json
import os
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(HERE / "read-data"))
sys.path.insert(0, str(HERE.parent / "cite-principles-from-captions" / "read-data"))
sys.path.insert(0, str(HERE.parent / "settings" / "read-data"))
import device_rows as d  # noqa: E402
import captions as c  # noqa: E402
import settings as s  # noqa: E402

FOLDER = "turn-caption-quotes-into-analysis-device-rows"
TOOL = "tool:" + FOLDER


class CaptionFinder:
    """The second a quote is said at in a video's captions, from the first non-empty caption file the patterns find."""

    def __init__(self, patterns):
        self.patterns = patterns
        self.texts = {}

    def __call__(self, video, quote):
        if video not in self.texts:
            self.texts[video] = None
            for pattern in self.patterns:
                for path in sorted(glob.glob(pattern.replace("{video}", glob.escape(video)))):
                    with open(path, encoding="utf-8") as handle:
                        segs = d.exact_segs_from_json3(json.load(handle))
                    if segs:
                        self.texts[video] = c.CaptionText(segs)
                        break
                if self.texts[video] is not None:
                    break
        text = self.texts[video]
        return "MISSING" if text is None else text.second_of(quote)


def refuse(message):
    print(json.dumps({"result": {"error": message}}))
    sys.exit(2)


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    parser.add_argument("--settings-record", required=True,
                        help="a JSON file with the person's list:settings row(s) for this tool, as records:read gives them")
    parser.add_argument("--scope", action="append", default=[],
                        help="KIND:ID of the row to read, most specific first (kind piece, film, person or account)")
    parser.add_argument("--captions", action="append", required=True, help="a glob with {video} for the video id")
    parser.add_argument("--family-file")
    parser.add_argument("--index-file")
    parser.add_argument("--checked-file")
    args = parser.parse_args(argv)
    scopes = []
    for given in args.scope:
        kind, _, scope_id = given.partition(":")
        if kind not in s.SCOPE_KINDS or not scope_id:
            refuse(f"--scope {given!r} is not KIND:ID with KIND one of {', '.join(s.SCOPE_KINDS)}, for example piece:<family>")
        scopes.append((kind, scope_id))
    try:
        settings = s.setting(args.settings_record, FOLDER, scopes or None, default=None, tool=TOOL)
    except s.SettingError as error:
        refuse(f"{error} (read the row with records:read and save it as the --settings-record file)")
    if settings is None:
        wanted = ", ".join(f"{kind}:{scope_id}" for kind, scope_id in scopes) or "any scope"
        refuse(f"the --settings-record file holds no record:setting:{FOLDER}~... row for {wanted}; read the person's row from list:settings")
    if not isinstance(settings, dict):
        refuse("the row's settings field is not a JSON object; read-data/device_rows.py says what it holds")
    lacking = d.missing_settings(settings)
    if lacking:
        refuse(f"the settings lack {', '.join(lacking)}; read-data/device_rows.py says what each holds")
    if any("{video}" not in pattern for pattern in args.captions):
        refuse("each --captions glob must contain {video}, where the video id goes, for example 'captions/{video}.*json3'")
    try:
        rows, bad = d.check_rows(settings, CaptionFinder(args.captions))
        result = {"rows": len(rows), "bad": bad, "written": []}
        if not bad:
            if args.family_file:
                Path(args.family_file).write_text(d.family_text(rows, settings), encoding="utf-8")
                result["written"].append(args.family_file)
            if args.index_file:
                text, added = d.index_with_family(Path(args.index_file).read_text(encoding="utf-8"), rows, settings)
                if added:
                    Path(args.index_file).write_text(text, encoding="utf-8")
                    result["written"].append(args.index_file)
                result["index"] = "added" if added else "already holds this family"
            if args.checked_file:
                with open(args.checked_file, "w", encoding="utf-8") as handle:
                    json.dump(d.checked_records(rows, settings), handle, indent=1)
                result["written"].append(args.checked_file)
    except d.SettingsError as error:
        refuse(str(error))
    except OSError as error:
        refuse(f"a file could not be read or written: {error}")
    for item in bad:
        print(f"BAD {item['video']} ({item['reason']}) {item['quote'][:70]}", file=sys.stderr)
    print(json.dumps({"result": result}, ensure_ascii=False))
    return 1 if bad else 0


if __name__ == "__main__":
    sys.exit(main())
