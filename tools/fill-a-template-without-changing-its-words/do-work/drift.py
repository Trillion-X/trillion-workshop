#!/usr/bin/env python3
"""drift.py <template.json> <target> [--json out.json] [--annotated out.json] [--exceptions exc.json]
           [--threshold 1.0] [--check] [--lines all|worst] [--root DIR]

<target> is any script (.md/.txt: fenced ```dim:<id>``` blocks, else a table column starting 'line', else
the whole text) or any piece JSON (a fill, our own render measured by make_template.py, another template).
Every dimension is judged by its registry value kind; unknown dimensions are reported, never dropped.
--exceptions: [{"dim", "line", "op": deleted|replaced|inserted, "words", "reason"}]; a listed change with
a reason counts as preserved and stays visible. --check exits 1 unless every judged dimension meets its
threshold, no unexcused word was inserted and every slot fill has a source.
"""
import argparse
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / 'read-data'))
from wt_core import SCHEMA, Registry, WTError, load_json, write_json  # noqa: E402
from wt_ops import drift  # noqa: E402
from wt_render import render_drift_text  # noqa: E402


def load_target(path):
    p = Path(path)
    if p.suffix == ".json":
        d = load_json(p, "target")
        if isinstance(d, dict) and d.get("schema") == SCHEMA:
            return d
        raise WTError(f"{p} is JSON but not a word-template piece", "measure it first with make_template.py, then drift the result")
    if not p.exists():
        raise WTError(f"target not found: {p}", "check the path")
    return p.read_text(encoding="utf-8")


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("template")
    ap.add_argument("target")
    ap.add_argument("--json")
    ap.add_argument("--annotated")
    ap.add_argument("--exceptions")
    ap.add_argument("--threshold", type=float)
    ap.add_argument("--check", action="store_true")
    ap.add_argument("--lines", default="all", choices=["all", "worst"])
    ap.add_argument("--root")
    ap.add_argument("--column", default="line", help="for a markdown script without dim fences: the table column to read (header starts with this)")
    a = ap.parse_args(argv)
    try:
        tpl = load_json(a.template, "template")
        reg = Registry.load(tpl.get("registry"))
        exc = load_json(a.exceptions, "exceptions file") if a.exceptions else []
        out = drift(tpl, load_target(a.target), reg, a.root or str(Path.cwd()), exc, a.threshold, a.column)
        rep = out["notes"]["drift"]
        rep["target"] = a.target if rep["target"] == "script text" else rep["target"]
        print(render_drift_text(rep, a.lines))
        if a.json:
            write_json(a.json, rep)
        if a.annotated:
            write_json(a.annotated, out)
    except WTError as e:
        print(f"drift: {e}", file=sys.stderr)
        return 2
    return 1 if a.check and not rep["check"]["pass"] else 0


if __name__ == "__main__":
    sys.exit(main())
