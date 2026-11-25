#!/usr/bin/env python3
"""The stages of workflow:make-matched-movement-clips, each one command that prints one {"result"} or {"error"} line.

Each stage only chains pieces this tool already has; it adds no matcher, renderer or contact finder of its own:
  prepare   files_road.fetch of the models and every clip by identity from Files, and the job file.
  perceive  process-scripts/perception/run_perception.py on each clip (pose, then describe_clip with the physical
            stroke rules on), written as an index folder the matcher reads: <key>.desc.json + _work/<key>.kp.json.
            A clip already described (same key) is skipped, so a rerun does no work twice.
  match     process-scripts/match/select_partner.py for every window of every target against the reference index;
            only admitted pairs are kept (it refuses an unverified camera direction and an ambiguous match).
  render    author_comparison_edl.py plans each pair (stacked or side by side, crop on each person, centred on each
            contact second) and media-composition's render-an-edit.mjs renders it.
  check     side_by_side.py check: two different sources, contact in sync within one output frame.
  keep      files_road.keep puts each passed clip in Files; its identity is the local file's BLAKE3.

USAGE: make_matched_clips.py prepare < SPEC.json   (fetches models and clips, writes WORK/job.json)
       make_matched_clips.py STAGE --job JOB.json
JOB.json (DATA; nothing about a person, a sport or a folder is in this file):
{
  "work": "/a/folder",                                   where every stage reads and writes
  "models": "/a/folder/models",                          MATCH_VENDOR_ROOT for perception
  "salience": {"lost_body_frac": 0.4, "max_body_heights_per_frame": 1.0, "cap_percentile": 0.99},
  "targets":    [{"path": "...", "identity": "1f:...", "name": "...", "date": "2026-09-10", "people": ["..."]}],
  "references": [{"path": "...", "identity": "1f:...", "name": "...", "year": "2019", "people": ["..."]}],
  "layout": "v", "padding_s": 2.5, "size": [1080, 1920], "call": ["<engine command>", "op"], "keep_folder": "/Recordings/..."
}
"""
import argparse
import hashlib
import json
import os
import re
import subprocess
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
PERCEPTION = os.path.join(HERE, "process-scripts", "perception")
MATCH = os.path.join(HERE, "process-scripts", "match")


def key(clip):
    """The index key of a clip: its identity when it has one, else its path; stable across runs."""
    ident = clip.get("identity") or clip["path"]
    slug = re.sub(r"[^A-Za-z0-9]+", "-", os.path.splitext(os.path.basename(clip["path"]))[0]).strip("-")[:60]
    return f"{slug}-{hashlib.sha1(ident.encode()).hexdigest()[:10]}"


def perceive(job, side):
    """Describe each clip of job[side] into work/<side>-index, skipping clips already described."""
    index = os.path.join(job["work"], f"{side}-index")
    os.makedirs(os.path.join(index, "_work"), exist_ok=True)
    env = {**os.environ, "MATCH_VENDOR_ROOT": job["models"], "MATCH_PERCEPTION_BACKEND": job.get("backend", "onnx")}
    made, kept, failed = [], [], []
    for clip in job[side]:
        k = key(clip)
        desc = os.path.join(index, f"{k}.desc.json")
        if os.path.exists(desc):
            kept.append(k)
            continue
        cmd = [sys.executable, os.path.join(PERCEPTION, "run_perception.py"), "--clip", clip["path"], "--out", desc,
               "--kp", os.path.join(index, "_work", f"{k}.kp.json"), "--salience-config", json.dumps(job.get("salience") or {})]
        r = subprocess.run(cmd, capture_output=True, text=True, env=env)
        if r.returncode or not os.path.exists(desc):
            failed.append({"clip": clip["path"], "why": (r.stderr.strip().splitlines() or ["no output"])[-1][:300]})
            continue
        made.append(k)
    return {"index": index, "made": made, "already": kept, "failed": failed}


def read(path):
    with open(path) as f:
        return json.load(f)


def run_json(cmd, env=None):
    """Run one tool script and return its JSON answer: the whole stdout, or its last {"result"}/{"error"} line."""
    r = subprocess.run(cmd, capture_output=True, text=True, env=env)
    out = r.stdout.strip()
    try:
        return json.loads(out)
    except ValueError:
        lines = out.splitlines()
        return json.loads(lines[-1]) if lines else {"error": (r.stderr.strip().splitlines() or ["no output"])[-1]}


def by_key(job, side):
    return {key(c): c for c in job[side]}


def match(job):
    """Every window of every target against the reference index; keep the matcher's admitted best pair."""
    t_index, r_index = (os.path.join(job["work"], f"{s}-index") for s in ("targets", "references"))
    refs_by_src = {os.path.realpath(c["path"]): c for c in job["references"]}
    env = {**os.environ, "MATCH_VENDOR_ROOT": job["models"], "MATCH_PERCEPTION_BACKEND": job.get("backend", "onnx")}
    pairs, refused = [], []
    for k, clip in by_key(job, "targets").items():
        desc_path = os.path.join(t_index, f"{k}.desc.json")
        if not os.path.exists(desc_path):
            continue
        desc = read(desc_path)
        for w, window in enumerate(desc.get("windows", [])):
            got = run_json([sys.executable, os.path.join(MATCH, "select_partner.py"), "--target-desc", f"{desc_path}:{w}",
                            "--target-kp", os.path.join(t_index, "_work", f"{k}.kp.json"), "--index", r_index], env)
            if got.get("no_match", True) or not got.get("partner_clip"):
                refused.append({"target": k, "window": w, "reason": got.get("reason") or got.get("error")})
                continue
            ref = refs_by_src.get(os.path.realpath(got["partner_clip"]))
            pdesc = read(os.path.join(r_index, f"{key(ref)}.desc.json")) if ref else None
            if pdesc is None:
                refused.append({"target": k, "window": w, "reason": f"partner not in the job: {got['partner_clip']}"})
                continue
            pw = pdesc["windows"][got["partner_window"]]
            pairs.append({"target": k, "target_window": w, "target_peak": window["peak_t"], "target_t": got["target_t"],
                          "reference": key(ref), "reference_window": got["partner_window"], "reference_peak": pw["peak_t"],
                          "reference_t": got["partner_t"], "parity": got.get("parity"), "dist": got.get("dist"),
                          "heading_dist": got.get("heading_dist"), "scorecard": got.get("scorecard")})
    out = os.path.join(job["work"], "pairs.json")
    with open(out, "w") as f:
        json.dump({"pairs": pairs, "refused": refused}, f, indent=1)
    return {"pairs": len(pairs), "refused": len(refused), "file": out}


def clip_name(job, pair):
    t, r = by_key(job, "targets")[pair["target"]], by_key(job, "references")[pair["reference"]]
    stamp = lambda c, field: c.get(field) or "unknown-date"
    who = lambda c: re.sub(r"[^a-z0-9]+", "-", (c.get("people") or ["someone"])[0].lower()).strip("-")
    return (f"{who(t)}-{stamp(t, 'date')}-{round(pair['target_peak'])}s_vs_{who(r)}-{stamp(r, 'year')}-"
            f"{pair['reference_window']}_{job.get('movement', 'movement')}-{job.get('view', 'view')}.mp4")


def render(job):
    """Plan each pair with author_comparison_edl (reference on top, target below unless the job says otherwise) and
    render it with media-composition's render-an-edit.mjs."""
    pairs = read(os.path.join(job["work"], "pairs.json"))["pairs"]
    T, R = by_key(job, "targets"), by_key(job, "references")
    folder = os.path.join(job["work"], "clips")
    os.makedirs(folder, exist_ok=True)
    width, height = job.get("size", [1080, 1920])
    renderer = job.get("renderer") or os.path.join(HERE, "..", "..", "media-composition", "do-work", "render-an-edit.mjs")
    made, failed = [], []
    for pair in pairs:
        out = os.path.join(folder, clip_name(job, pair))
        if os.path.exists(out):
            made.append({"pair": pair, "file": out, "already": True})
            continue
        def side(clip, k, peak, flip, index):
            return {"clip": clip["path"], "kp": os.path.join(job["work"], f"{index}-index", "_work", f"{k}.kp.json"),
                    "peak": peak, "label": "", **({"flip": "h"} if flip else {})}
        top = side(R[pair["reference"]], pair["reference"], pair["reference_peak"], pair.get("parity") == "reflected", "references")
        bottom = side(T[pair["target"]], pair["target"], pair["target_peak"], False, "targets")
        spec = {"encode": {"width": width, "height": height, "fps": 30, "crf": 18, "preset": "medium"},
                "layout": job.get("layout", "v"), "bg": "black", "left": top, "right": bottom,
                "passes": [{"id": "full", "half": float(job.get("padding_s", 2.5))}]}
        base = out[:-4]
        with open(base + ".spec.json", "w") as f:
            json.dump(spec, f, indent=1)
        planned = run_json([sys.executable, os.path.join(HERE, "author_comparison_edl.py"), "--spec", base + ".spec.json",
                            "--out", base + ".edit.json"])
        if "error" in planned:
            failed.append({"pair": pair, "why": planned["error"]})
            continue
        r = subprocess.run(["node", renderer, "--edl", open(base + ".edit.json").read(), "--output", out],
                           capture_output=True, text=True)
        if r.returncode or not os.path.exists(out):
            failed.append({"pair": pair, "why": (r.stderr.strip().splitlines() or ["render failed"])[-1][:300]})
            continue
        made.append({"pair": pair, "file": out, "edit": base + ".edit.json"})
    with open(os.path.join(job["work"], "rendered.json"), "w") as f:
        json.dump({"made": made, "failed": failed}, f, indent=1)
    return {"made": len(made), "failed": len(failed), "first_failure": failed[0]["why"] if failed else None}


def check(job):
    """side_by_side.py check on every rendered clip, from the edit it was rendered from."""
    rendered = read(os.path.join(job["work"], "rendered.json"))["made"]
    T, R = by_key(job, "targets"), by_key(job, "references")
    results = []
    for item in rendered:
        edit = read(item["edit"]) if item.get("edit") else read(item["file"][:-4] + ".edit.json")
        top_src, bottom_src = edit["spine"]["segments"][0]["sources"]
        pair = item["pair"]
        half = (top_src["out"] - top_src["in"]) / 2

        def side(src, clip, peak, data_side):
            fps = read(os.path.join(job["work"], f"{data_side}-index", "_work", f"{key(clip)}.kp.json"))["video"]["fps"]
            c = src["crop"]
            return {"source": clip["path"], "fps": fps, "contact_frame": round(peak * fps), "crop": [c["w"], c["h"], c["x"], c["y"]],
                    "mirror": src.get("flip") == "h", "stroke": job.get("movement"), "hand": clip.get("hand", "right"),
                    "camera": clip.get("camera", job.get("camera", "behind")),
                    "stroke_seen": f"{job.get('movement')}: from the job's source folder, and the matcher admitted the pair as the same motion (dist {pair.get('dist')})"}
        width, height = job.get("size", [1080, 1920])
        cell = [width, height // 2] if job.get("layout", "v") == "v" else [width // 2, height]
        spec = {"top": side(top_src, R[pair["reference"]], pair["reference_peak"], "references"),
                "bottom": side(bottom_src, T[pair["target"]], pair["target_peak"], "targets"),
                "cell": cell, "fps": 30, "before_s": half, "after_s": half}
        spec_path = item["file"][:-4] + ".check-spec.json"
        with open(spec_path, "w") as f:
            json.dump(spec, f, indent=1)
        got = run_json([sys.executable, os.path.join(HERE, "side_by_side.py"), "check", "--spec", spec_path, "--clip", item["file"],
                        "--sheet", item["file"][:-4] + ".sheet.jpg"])
        results.append({"file": item["file"], "pair": pair, "check": got.get("result", got)})
    with open(os.path.join(job["work"], "checked.json"), "w") as f:
        json.dump(results, f, indent=1)
    passed = [r for r in results if (r["check"] or {}).get("pass")]
    return {"checked": len(results), "passed": len(passed),
            "failed_checks": sorted({n for r in results for n, c in ((r["check"] or {}).get("checks") or {}).items() if not c.get("pass")})}


def keep(job):
    """Keep every passed clip in Files under job.keep_folder and answer one row per clip for the recording index."""
    sys.path.insert(0, HERE)
    import files_road
    T, R = by_key(job, "targets"), by_key(job, "references")
    rows, failed = [], []
    for item in read(os.path.join(job["work"], "checked.json")):
        if not (item["check"] or {}).get("pass"):
            continue
        name = job["keep_folder"].rstrip("/") + "/" + os.path.basename(item["file"])
        ident = files_road.keep(job["call"], item["file"], name, "video/mp4")
        if not ident:
            failed.append(item["file"])
            continue
        pair, t, r = item["pair"], T[item["pair"]["target"]], R[item["pair"]["reference"]]
        rows.append({"id": "record:recording-moment:" + os.path.basename(item["file"])[:-4],
                     "moment": f"{', '.join(t.get('people') or [])} {job.get('movement')} {t.get('date')} vs {', '.join(r.get('people') or [])} {r.get('year') or ''}, {job.get('view')}, synced at contact",
                     "recording": t.get("identity"), "recording_name": t.get("name"), "captured_day": t.get("date"),
                     "start": str(round(pair["target_peak"] - float(job.get("padding_s", 2.5)), 3)),
                     "end": str(round(pair["target_peak"] + float(job.get("padding_s", 2.5)), 3)),
                     "extra": {"kind": "movement-comparison", "made_by": "workflow:make-matched-movement-clips",
                               "run": job.get("run"), "made_file": name, "made_identity": ident,
                               "people": (r.get("people") or []) + (t.get("people") or []), "movement": job.get("movement"),
                               "view": job.get("view"), "layout": job.get("layout", "v"),
                               "target": {"identity": t.get("identity"), "name": t.get("name"), "contact_s": pair["target_peak"]},
                               "reference": {"identity": r.get("identity"), "name": r.get("name"), "contact_s": pair["reference_peak"],
                                             "flipped": pair.get("parity") == "reflected"},
                               "match": {"tool": "track-and-compare-movement select_partner", "dist": pair.get("dist"),
                                         "heading_dist": pair.get("heading_dist")},
                               "check": item["check"]}})
    return {"rows": rows, "failed": failed}


DATE = re.compile(r"(?<!\d)(\d\d)-(\d\d)-(\d\d)(?!\d)")
YEAR = re.compile(r"(?<!\d)((?:19|20)\d\d)(?!\d)")


def prepare(spec):
    """Fetch the models and every clip by identity from Files into spec.work, and write the job the other stages read.
    spec: {work, call, models: [{name, identity}], targets: [{name, identity}], references: [{name, identity}],
    target_people, reference_people, and the job settings (movement, view, layout, padding_s, size, keep_folder, salience)}."""
    sys.path.insert(0, HERE)
    import files_road
    work, call = spec["work"], spec["call"]  # the engine command that holds the Files right, given by the caller
    models, media = os.path.join(work, "models"), os.path.join(work, "media")
    os.makedirs(models, exist_ok=True)
    os.makedirs(media, exist_ok=True)
    for m in spec["models"]:
        files_road.fetch(call, m["identity"], os.path.join(models, m["name"]))

    def clips(rows, people, side):
        out = []
        for row in rows:
            ext = os.path.splitext(row["name"])[1].lower() or ".mp4"
            path = os.path.join(media, side + "-" + row["identity"][3:19] + ext)
            files_road.fetch(call, row["identity"], path)
            clip = {"path": path, "identity": row["identity"], "name": row["name"], "people": people}
            d = DATE.search(os.path.basename(row["name"]))
            if d:
                clip["date"] = f"20{d.group(1)}-{d.group(2)}-{d.group(3)}"
            y = YEAR.search(os.path.basename(row["name"]))
            clip["year"] = y.group(1) if y else (clip["date"][:4] if "date" in clip else "unknown-year")
            out.append(clip)
        return out
    settings = {k: v for k, v in spec.items() if k not in ("models", "targets", "references", "target_people", "reference_people")}
    job = {**settings, "work": work, "models": models, "call": call,
           "targets": clips(spec["targets"], spec.get("target_people") or [], "target"),
           "references": clips(spec["references"], spec.get("reference_people") or [], "reference")}
    path = os.path.join(work, "job.json")
    with open(path, "w") as f:
        json.dump(job, f, indent=1)
    return {"job": path, "targets": len(job["targets"]), "references": len(job["references"])}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("stage", choices=["prepare", "perceive", "match", "render", "check", "keep"])
    ap.add_argument("--job", help="the job file (every stage but prepare, which reads its spec on stdin)")
    ap.add_argument("--side", choices=["targets", "references"], default="targets")
    a = ap.parse_args()
    try:
        if a.stage == "prepare":
            out = prepare(json.load(sys.stdin))
        else:
            job = read(a.job)
            out = perceive(job, a.side) if a.stage == "perceive" else \
                {"match": match, "render": render, "check": check, "keep": keep}[a.stage](job)
    except Exception as e:  # one line the workflow reads, with the reason
        print(json.dumps({"error": f"{a.stage}: {type(e).__name__}: {e}"}))
        return 1
    print(json.dumps({"result": out}))
    return 0


if __name__ == "__main__":
    sys.exit(main())
