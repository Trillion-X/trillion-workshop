#!/usr/bin/env python3
"""fill.py <template.json> <fills.json> <out.md> [--piece out.piece.json] [--root DIR]

fills.json: {"title": ..., "root": <dir that relative sources are read from>,
             "fills": {"<slot id>": {"value": ..., "sources": ["path:12" | "path@12.5s" | "path@12.5-18.2s" | "https://..." | "git:<repo>@<commit>"],
                                     "needs": "what would fill it, when empty", "note": ...}}}
Only slots can be filled; a KEEP word cannot be changed here. A value without a checkable source is not
used: the slot stays visibly empty as [TYPE: no source yet] and is listed with the reason.
A source may be one of the person's recorded moments (a time range of a word-timed transcript, or a moments TSV row cited
by line): the value must be their words in it, and the fill keeps where it plays (clip, from, to; dimensions.json
moment_spans), beside product-capability sources (a listing line) in the same fills file.
"""
import argparse
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / 'read-data'))
from wt_core import Registry, WTError, load_json, write_json  # noqa: E402
from wt_ops import fill  # noqa: E402
from wt_render import render_fill_md  # noqa: E402


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("template")
    ap.add_argument("fills")
    ap.add_argument("out")
    ap.add_argument("--piece", help="also write the filled piece (same schema) here")
    ap.add_argument("--root")
    a = ap.parse_args(argv)
    try:
        tpl = load_json(a.template, "template")
        doc = load_json(a.fills, "fills file")
        reg = Registry.load(tpl.get("registry"))
        root = a.root or doc.get("root") or str(Path(a.fills).resolve().parent)
        piece = fill(tpl, doc, reg, root)
        Path(a.out).write_text(render_fill_md(piece, doc, reg, a.template, a.fills), encoding="utf-8")
        if a.piece:
            write_json(a.piece, piece)
        st = [f["status"] for f in piece["fills"].values()]
        print(f"{a.out}: {st.count('sourced')} slots filled from checked sources, {st.count('empty')} empty, "
              f"{st.count('unsourced')} offered without a valid source (left empty)")
        for sid, f in piece["fills"].items():
            if f["status"] == "unsourced":
                print(f"  {sid}: not used: {'; '.join(f['why'])}")
    except WTError as e:
        print(f"fill: {e}", file=sys.stderr)
        return 2
    return 0


if __name__ == "__main__":
    sys.exit(main())
