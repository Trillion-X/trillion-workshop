#!/usr/bin/env python3
"""make_template.py <input> <out.template.json> [--registry R] [--root DIR] [--medium M] [--id ID]

<input> is a spec (schema word-template-spec@1: sources, lines, slots, keeps, readings) or any one
measurement a registry reader can detect (a transcript JSON, a post JSON, a table .tsv, a folder of images).
Writes <out>.template.json and a readable <out>.template.md next to it.
"""
import argparse
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / 'read-data'))
from wt_core import Registry, WTError, load_json, write_json  # noqa: E402
from wt_ops import tokenize  # noqa: E402
from wt_render import render_template_md  # noqa: E402


def spec_for(inp, reg, medium=None, pid=None):
    """Build a spec for a bare measurement from the registry's reader 'detect' rows (data, not code)."""
    p = Path(inp)
    if p.suffix == ".json":
        d = load_json(p, "input")
        if d.get("schema") == "word-template-spec@1":
            d["_path"] = str(p)
            return d
        keys = set(d) if isinstance(d, dict) else set()
    else:
        keys = set()
    for name, row in reg.readers.items():
        det = row.get("detect") if isinstance(row, dict) else None
        if not det:
            continue
        if p.is_dir():
            if det.get("dir_of") and any(x.suffix.lower() in det["dir_of"] for x in p.iterdir()):
                break
            continue
        if det.get("suffix") and p.suffix not in det["suffix"]:
            continue
        if det.get("keys") and not set(det["keys"]) <= keys:
            continue
        break
    else:
        raise WTError(f"no registry reader recognises {p}",
                      "write a spec (schema word-template-spec@1) naming the reader under sources, or add a 'detect' row to a reader in dimensions.json")
    return {"schema": "word-template-spec@1",
            "piece": {"id": pid or p.stem.replace(".template", ""), "medium": medium or row.get("default_medium")},
            "sources": {name: str(p.resolve())}}


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("input")
    ap.add_argument("out")
    ap.add_argument("--registry")
    ap.add_argument("--root")
    ap.add_argument("--medium")
    ap.add_argument("--id")
    a = ap.parse_args(argv)
    try:
        reg = Registry.load(a.registry)
        spec = spec_for(a.input, reg, a.medium, a.id)
        if a.registry:
            spec["registry"] = a.registry
        piece = tokenize(spec, reg, a.root or spec.get("root"))
        out = Path(a.out)
        write_json(out, piece)
        md = out.with_name(out.name.replace(".json", "") + ".md") if out.name.endswith(".json") else out.with_suffix(".md")
        md.write_text(render_template_md(piece, reg), encoding="utf-8")
        n_slot = sum(1 for t in piece["tokens"] if t.get("mark") == "SLOT")
        print(f"{out}: {len(piece['tokens'])} tokens ({n_slot} SLOT in {len(piece['slots'])} slots), "
              f"{len({d for t in piece['tokens'] for d in t['dims']})} dimensions measured, {len(piece['pending'])} pending; view {md}")
    except WTError as e:
        print(f"make_template: {e}", file=sys.stderr)
        return 2
    return 0


if __name__ == "__main__":
    sys.exit(main())
