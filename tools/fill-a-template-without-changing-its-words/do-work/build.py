#!/usr/bin/env python3
"""build.py <discovery.json> [--registry dimensions.json] [--only TEXT] [--force]

Rebuilds every template, every fill drift and every film drift that the discovery file describes, but
only where an input changed (sources, spec, fill, registry or this tool's code): each output's inputs are
stamped (size + mtime) in the manifest, so a second run with nothing changed rebuilds nothing. Pieces are
processed one at a time; only small summaries are kept, so cost follows the pieces that changed, not the
library. Writes the INDEX (readback) named in the discovery file.

The discovery file (JSON, paths relative to its "root"):
  references   a group or a list of groups: {glob, items?: "directories"|"files", skip_names?, medium, out, spec?, sources}
  templates    [{spec, out}]: extra templates built from a spec
  fill_values  {glob, template, suffix?}: fill-values files, each filled into its template (fill.py)
  fills        {glob, template, out, skip_dir_prefix?, skip_names?}: filled scripts checked for drift against their template
  films        a JSON file {"films": [{film, reference_template, script?, column?, render?, render_template?, why?}]}
  manifest     where the stamps and summaries are kept
  index        where the INDEX (Markdown) is written
  film_drifts  folder for film drift reports (default: drift/films beside the manifest)
  renders      folder for render measurements (default: renders beside the manifest)
  registry     the person's dimensions registry (default: the shipped read-data/dimensions.json); --registry overrides it
"""
import argparse
import glob
import json
import re
import sys
import time
from pathlib import Path

HERE = Path(__file__).resolve().parent
READ_DATA = HERE.parent / "read-data"
sys.path.insert(0, str(READ_DATA))
from wt_core import Registry, WTError, expand, load_json, stamp, write_json  # noqa: E402
from wt_ops import drift, fill, tokenize  # noqa: E402
from wt_render import render_drift_text, render_fill_md, render_template_md  # noqa: E402

CODE = [READ_DATA / n for n in ("wt_core.py", "wt_ops.py", "wt_render.py")] + [HERE / "build.py"]


def key_of(paths):
    return json.dumps([stamp(p) for p in paths], sort_keys=True)


def fmt(s, **kw):
    return re.sub(r"\{(\w+)\}", lambda m: str(kw.get(m.group(1), m.group(0))), s)


def resolve_source(v, root, **kw):
    if isinstance(v, dict) and "from_file" in v:
        f = expand(fmt(v["from_file"], **kw), root)
        if not f.exists():
            return None
        m = re.search(v["regex"], f.read_text(encoding="utf-8", errors="replace"))
        if not m:
            return None
        return fmt(v["path"], **{str(i): g for i, g in enumerate(m.groups(), 1)})
    if isinstance(v, dict):
        return {**v, "path": fmt(v["path"], **kw)}
    return fmt(v, **kw)


def fill_template_paths(doc, pattern, fill_dir, root):
    """Use an explicit template named by a fill-values document, or the configured directory pattern."""
    explicit = doc.get("template") if isinstance(doc, dict) else None
    if isinstance(explicit, str) and explicit.strip():
        target = expand(explicit, doc.get("root") or root)
        return [str(target)] if target.is_file() else []
    return glob.glob(str(root / fmt(pattern, fill_dir=fill_dir)))


def summary_of(p):
    toks = p["tokens"]
    slot = sum(1 for t in toks if t.get("mark") == "SLOT")
    return {"id": p["piece"]["id"], "medium": p["piece"]["medium"], "tokens": len(toks), "keep": len(toks) - slot,
            "slot_tokens": slot, "slots": len(p["slots"]),
            "measured": len({d for t in toks for d in t["dims"]}), "pending": len(p["pending"]),
            "sources": sum(1 for b in p["piece"].get("built_from", []) if not b.get("missing"))}


def drift_summary(rep):
    s = rep["summary"]
    return {"keep_pct": s["keep_preserved_pct"], "keep_total": s["keep_total"], "inserted": s["inserted"],
            "new_words": s.get("new_words", 0), "unsourced": s["unsourced_fills"], "sourced": s["sourced_slots"],
            "empty": s["empty_slots"], "dims": ", ".join(f"{d} {r['pct']}%" for d, r in rep["dims"].items()),
            "pass": rep["check"]["pass"]}


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("discovery")
    ap.add_argument("--registry", help="the dimensions registry to measure with (default: the discovery file's registry, else the shipped one)")
    ap.add_argument("--only")
    ap.add_argument("--force", action="store_true")
    a = ap.parse_args(argv)
    disc = load_json(a.discovery, "discovery file")
    disc["_path"] = Path(a.discovery).name
    root = expand(disc.get("root", "."))
    reg = Registry.load(a.registry or (str(expand(disc["registry"], root)) if disc.get("registry") else None))
    man_path = expand(disc["manifest"], root)
    man = load_json(man_path, "manifest") if man_path.exists() else {}
    film_drifts = expand(disc["film_drifts"], root) if disc.get("film_drifts") else man_path.parent / "drift" / "films"
    renders = expand(disc["renders"], root) if disc.get("renders") else man_path.parent / "renders"
    base = [Path(reg.path), expand(a.discovery)] + CODE
    counts = {"templates_built": 0, "templates_unchanged": 0, "templates_failed": 0, "drifts_built": 0,
              "drifts_unchanged": 0, "drifts_failed": 0}
    t0 = time.time()

    def build_template(name, spec, out, extra_inputs):
        srcs = []
        for v in (spec.get("sources") or {}).values():
            srcs.append(expand(v["path"] if isinstance(v, dict) else v, spec.get("root") or root))
        k = key_of(base + srcs + extra_inputs)
        entry = man.get(name)
        if not a.force and entry and entry.get("key") == k and Path(out).exists():
            counts["templates_unchanged"] += 1
            return entry
        try:
            p = tokenize(spec, reg, spec.get("root") or root)
            p["piece"]["build_key"] = k
            write_json(out, p)
            Path(str(out)[:-5] + ".md").write_text(render_template_md(p, reg), encoding="utf-8")
            entry = {"key": k, "out": str(out), "summary": summary_of(p)}
            counts["templates_built"] += 1
        except WTError as e:
            entry = {"key": k, "out": str(out), "error": e.what, "fix": e.fix}
            counts["templates_failed"] += 1
        man[name] = entry
        return entry

    # 1. every reference item. A group can discover directories or individual source files;
    # a corpus directory is not itself a film, and separate sources must keep separate identities.
    groups = disc["references"]
    if isinstance(groups, dict):
        groups = [groups]
    current_refs = set()
    for R in groups:
        files = R.get("items", "directories") == "files"
        for d in sorted(glob.glob(str(root / R["glob"]))):
            dp = Path(d)
            if not (dp.is_file() if files else dp.is_dir()) or dp.name in R.get("skip_names", []):
                continue
            pid = dp.stem if files else dp.name
            if a.only and a.only not in str(dp):
                continue
            directory = dp.parent if files else dp
            kw = {"dir": str(directory) + "/", "parent_dir": str(directory.parent) + "/",
                  "id": pid, "path": str(dp), "name": dp.name}
            name = "ref:" + (str(dp.relative_to(root)) if files else f"{dp.parent.name}/{pid}")
            current_refs.add(name)
            spec_path = expand(fmt(R["spec"], **kw), root) if R.get("spec") else None
            if spec_path and spec_path.exists():
                spec = load_json(spec_path, "spec")
                spec["_path"] = str(spec_path)
                extra = [spec_path]
            else:
                sources = {}
                for rname, v in R["sources"].items():
                    r = resolve_source(v, root, **kw)
                    if r:
                        sources[rname] = r
                spec = {"schema": "word-template-spec@1", "piece": {"id": pid, "medium": R["medium"], "kind": "reference",
                                                                      "format_dir": str(directory)}, "sources": sources}
                extra = [dp] if files else [dp / "FORMAT.md"]
            build_template(name, spec, expand(fmt(R["out"], **kw), root), extra)
    if not a.only:
        # Retire only current discovery entries. Keep their historical files recoverable.
        for name in list(man):
            if name.startswith("ref:") and name not in current_refs:
                man.pop(name)
    for t in disc.get("templates", []):
        if a.only and a.only not in t["spec"]:
            continue
        sp = expand(t["spec"], root)
        spec = load_json(sp, "spec")
        spec["_path"] = str(sp)
        build_template(f"tpl:{t['out']}", spec, expand(t["out"], root), [sp])

    # 2a. every fill-values file -> its filled script (fill.py), when it or its template changed
    V = disc.get("fill_values")
    for fv in sorted(glob.glob(str(root / V["glob"]))) if V else []:
        fp = Path(fv)
        fdir = fp.parent.name
        if a.only and a.only not in str(fp):
            continue
        name = f"fillvalues:{fdir}/{fp.name}"
        out = fp.with_name(fp.name.replace(V.get("suffix", ".fills.json"), ".md"))
        doc = load_json(fp, "fills file")
        tps = fill_template_paths(doc, V["template"], fdir, root)
        if not tps:
            man[name] = {"error": f"no template for {fdir}", "fix": "build the reference first"}
            continue
        k = key_of(base + [fp, Path(tps[0])])
        if not a.force and man.get(name, {}).get("key") == k and out.exists():
            continue
        try:
            piece = fill(load_json(tps[0], "template"), doc, reg, str(expand(doc.get("root") or root)))
            out.write_text(render_fill_md(piece, doc, reg, str(Path(tps[0]).relative_to(root)), str(fp.relative_to(root))), encoding="utf-8")
            write_json(out.with_suffix(".piece.json"), piece)
            man[name] = {"key": k, "out": str(out), "status": {s_: sum(1 for f in piece["fills"].values() if f["status"] == s_)
                                                                for s_ in ("sourced", "empty", "unsourced")}}
        except WTError as e:
            man[name] = {"key": k, "error": e.what, "fix": e.fix}

    # 2b. every fill against its template
    F = disc["fills"]
    for f in sorted(glob.glob(str(root / F["glob"]))):
        fp = Path(f)
        fdir = fp.parent.name
        name = f"fill:{fdir}/{fp.name}"
        if fdir.startswith(F.get("skip_dir_prefix", "\0")) or fp.name in F.get("skip_names", []):
            # Skipped administrative files can have stale entries from older discovery
            # rules. Remove the report record so the manifest reflects current scope.
            man.pop(name, None)
            continue
        if a.only and a.only not in str(fp):
            continue
        fill_values_path = fp.with_name(fp.stem + (V.get("suffix", ".fills.json") if V else ".fills.json"))
        fill_doc = load_json(fill_values_path, "fills file") if fill_values_path.is_file() else {}
        tps = fill_template_paths(fill_doc, F["template"], fdir, root)
        if not tps:
            man[name] = {"error": f"no template for {fdir}", "fix": "build the reference first"}
            counts["drifts_failed"] += 1
            continue
        out = expand(fmt(F["out"], fill_dir=fdir, stem=fp.stem), root)
        drift_inputs = [fp, Path(tps[0])] + ([fill_values_path] if fill_values_path.is_file() else [])
        run_drift(name, Path(tps[0]), fp.read_text(encoding="utf-8"), drift_inputs, out, base, man, a, counts, reg,
                  root, "line", target_label=str(fp.relative_to(root)))

    # 3. every film against its reference
    films_path = expand(disc["films"], root)
    films = load_json(films_path, "films file")
    for fl in films["films"]:
        if a.only and a.only not in fl["film"]:
            continue
        film_key = f"film:{fl['film']}"
        current_reports = set()
        if fl.get("script"):
            current_reports.add(f"{film_key}:script")
        if fl.get("render") or fl.get("render_template"):
            current_reports.add(f"{film_key}:render")
        for old in list(man):
            if old.startswith(film_key + ":") and old not in current_reports:
                man.pop(old)
        if not fl.get("render"):
            man.pop(f"render:{fl['film']}", None)
        tp = expand(fl["reference_template"], root)
        outbase = film_drifts / fl["film"]
        done = False
        if not tp.exists():
            for old in current_reports:
                man.pop(old, None)
            man[f"film:{fl['film']}"] = {"error": f"reference template missing: {tp}", "fix": "build the reference first (it is one of the discovery file's references or templates)"}
            counts["drifts_failed"] += 1
            continue
        if fl.get("script"):
            sp = expand(fl["script"], root)
            run_drift(f"film:{fl['film']}:script", tp, sp.read_text(encoding="utf-8"), [sp, tp, films_path], Path(str(outbase) + ".script"),
                      base, man, a, counts, reg, root, fl.get("column", "line"), target_label=fl["script"])
            done = True
        if fl.get("render"):
            spec = {"schema": "word-template-spec@1", "piece": {"id": f"{fl['film']}.render", "medium": fl["render"]["medium"], "kind": "render"},
                    "sources": fl["render"]["sources"], "auto_slot_rules": False}
            rout = renders / f"{fl['film']}.render.json"
            ent = build_template(f"render:{fl['film']}", spec, rout, [films_path])
            if not ent.get("error"):
                run_drift(f"film:{fl['film']}:render", tp, load_json(rout), [rout, tp, films_path], Path(str(outbase) + ".render"),
                          base, man, a, counts, reg, root, "line", target_label=str(rout.relative_to(root)) if rout.is_relative_to(root) else str(rout))
            else:
                man[f"{film_key}:render"] = {"error": ent["error"], "fix": ent.get("fix"),
                                             "template": str(tp), "target": str(rout)}
            done = True
        if fl.get("render_template"):
            rp = expand(fl["render_template"], root)
            run_drift(f"film:{fl['film']}:render", tp, load_json(rp), [rp, tp, films_path], Path(str(outbase) + ".render"),
                      base, man, a, counts, reg, root, "line", target_label=fl["render_template"])
            done = True
        if not done:
            man[f"film:{fl['film']}"] = {"note": fl.get("why", "nothing to judge"), "reference": str(tp)}
        else:
            man.pop(f"film:{fl['film']}", None)

    man["_counts"] = {**counts, "seconds": round(time.time() - t0, 1)}
    write_json(man_path, man)
    write_index(disc, man, root)
    print(json.dumps(man["_counts"]))
    return 0


def run_drift(name, tp, target, inputs, outbase, base, man, a, counts, reg, root, column, target_label):
    k = key_of(base + inputs)
    entry = man.get(name)
    if not a.force and entry and entry.get("key") == k and Path(str(outbase) + ".txt").exists():
        counts["drifts_unchanged"] += 1
        return
    try:
        out = drift(load_json(tp, "template"), target, reg, str(root), [], None, column)
        rep = out["notes"]["drift"]
        rep["target"] = target_label
        Path(outbase).parent.mkdir(parents=True, exist_ok=True)
        Path(str(outbase) + ".txt").write_text(render_drift_text(rep, "all"), encoding="utf-8")
        write_json(str(outbase) + ".json", rep)
        man[name] = {"key": k, "template": str(tp), "target": target_label, "report": str(outbase) + ".txt",
                     "summary": drift_summary(rep)}
        counts["drifts_built"] += 1
    except WTError as e:
        man[name] = {"key": k, "error": e.what, "fix": e.fix}
        counts["drifts_failed"] += 1


def write_index(disc, man, root):
    rel = lambda p: str(Path(p).relative_to(root)) if p and str(p).startswith(str(root)) else str(p)
    refs = {k: v for k, v in man.items() if k.startswith(("ref:", "tpl:", "render:"))}
    fills = {k: v for k, v in man.items() if k.startswith("fill:")}
    films = {k: v for k, v in man.items() if k.startswith("film:")}
    ok = [v for v in refs.values() if "summary" in v]
    pend = sum(v["summary"]["pending"] for v in ok)
    checked_fills = [v for v in fills.values() if "summary" in v]
    passed_fills = sum(1 for v in checked_fills if v["summary"].get("pass"))
    failed_fills = sum(1 for v in checked_fills if not v["summary"].get("pass"))
    fill_errors = sum(1 for v in fills.values() if "error" in v)
    c = man.get("_counts", {})
    L = ["# Word-level templates: INDEX", "",
         f"Generated by `build.py {disc.get('_path', 'discovery.json')}`; do not edit. Rerun it after any change:",
         "it rebuilds only what changed (inputs are stamped in `manifest.json`).", "",
         f"Last run: {c.get('templates_built', 0)} templates built, {c.get('templates_unchanged', 0)} unchanged, {c.get('templates_failed', 0)} failed; "
         f"{c.get('drifts_built', 0)} drifts built, {c.get('drifts_unchanged', 0)} unchanged, {c.get('drifts_failed', 0)} failed; {c.get('seconds')} s.", "",
         "## Counts", "",
         "| what | count |", "|---|---|",
         f"| templates (references, extra templates, renders) | {len(ok)} of {len(refs)} |",
         f"| tokens in all templates | {sum(v['summary']['tokens'] for v in ok)} |",
         f"| SLOT tokens / slots | {sum(v['summary']['slot_tokens'] for v in ok)} / {sum(v['summary']['slots'] for v in ok)} |",
         f"| pending dimension entries (each with its reason inside the template) | {pend} |",
         f"| fills checked for drift | {len(checked_fills)} of {len(fills)} |",
         f"| fill checks passed | {passed_fills} |",
         f"| fill checks failed | {failed_fills} |",
         f"| fill reports with errors | {fill_errors} |",
         f"| film drifts | {sum(1 for v in films.values() if 'summary' in v)} (+{sum(1 for v in films.values() if 'note' in v)} with nothing measurable yet) |", "",
         "## Fills against their template (speech words)", "",
         "| fill | KEEP preserved | inserted | target words not matching | unsourced fills | sourced / empty slot uses | check | report |",
         "|---|---|---|---|---|---|---|---|"]
    for k, v in sorted(fills.items(), key=lambda kv: kv[1].get("summary", {}).get("keep_pct", -1)):
        s = v.get("summary")
        if not s:
            L.append(f"| {k[5:]} | error: {v.get('error')} | | | | | | |")
            continue
        L.append(f"| {k[5:]} | {s['keep_pct']}% of {s['keep_total']} | {s['inserted']} | {s['new_words']} | {s['unsourced']} | "
                 f"{s['sourced']} / {s['empty']} | {'PASS' if s['pass'] else 'FAIL'} | `{rel(v['report'])}` |")
    L += ["", "## Films against their references", "", "| film drift | reference | KEEP preserved | judged | check | report or note |", "|---|---|---|---|---|---|"]
    for k, v in films.items():
        if "summary" in v:
            s = v["summary"]
            L.append(f"| {k[5:]} | `{rel(v['template'])}` | {s['keep_pct']}% of {s['keep_total']} | {s['dims']} | {'PASS' if s['pass'] else 'FAIL'} | `{rel(v['report'])}` |")
        else:
            L.append(f"| {k[5:]} | `{rel(v.get('reference', ''))}` | - | - | - | {v.get('note') or v.get('error')} |")
    L += ["", "## Templates", "", "| template | medium | tokens | KEEP | SLOT (slots) | dims measured | pending | sources read | file |", "|---|---|---|---|---|---|---|---|---|"]
    for k, v in sorted(refs.items()):
        if "summary" not in v:
            L.append(f"| {k} | error: {v.get('error')} ({v.get('fix')}) | | | | | | | |")
            continue
        s = v["summary"]
        L.append(f"| {s['id']} | {s['medium']} | {s['tokens']} | {s['keep']} | {s['slot_tokens']} ({s['slots']}) | {s['measured']} | {s['pending']} | {s['sources']} | `{rel(v['out'])}` |")
    Path(expand(disc["index"], root)).write_text("\n".join(L) + "\n", encoding="utf-8")


if __name__ == "__main__":
    sys.exit(main())
