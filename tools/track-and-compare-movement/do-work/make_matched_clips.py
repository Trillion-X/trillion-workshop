#!/usr/bin/env python3
"""The stages of workflow:make-matched-movement-clips, each one command that prints one {"result"} or {"error"} line.

Each stage only chains pieces this tool already has; it adds no matcher, renderer or contact finder of its own:
  prepare   files_road.fetch of the models and every clip by identity from Files, and the job file.
  perceive  process-scripts/perception/run_perception.py on each clip (pose, then describe_clip with the physical
            stroke rules on), written as an index folder the matcher reads: <key>.desc.json + _work/<key>.kp.json.
            A clip already described (same key) is skipped, so a rerun does no work twice.
  match     process-scripts/match/select_partner.py for every window of every target against the reference index;
            only admitted pairs are kept (it refuses an unverified camera direction and an ambiguous match).
  render    per pair: contact_moment.py (the hit's sound, else the wrist peak), phase_sync.py (the reference retimed so
            every phase lands with the target's), author_comparison_edl.py --variants (9:16 and 16:9, 1x, smooth 0.5x /
            0.25x / 0.1x, a contact still), whole_movement_check.py (body and racket in every crop), and media-composition's
            render-an-edit.mjs renders each format.
  check     side_by_side.py check: two different sources, contact in sync within one output frame.
  keep      files_road.keep puts each passed clip in Files; its identity is the local file's BLAKE3.
  progression  from a finished batch's pairs.json: one fixed reference swing on top and a target's swings of many dates
            under it, oldest first, each synced by the same pieces as render, each with its date as a caption
            (media-composition's caption-subtitle.mjs places the letters); job.progression is its DATA.

USAGE: make_matched_clips.py prepare < SPEC.json   (fetches models and clips, writes WORK/job.json)
       make_matched_clips.py STAGE --job JOB.json
JOB.json (DATA; nothing about a person, a sport or a folder is in this file):
{
  "work": "/a/folder",                                   where every stage reads and writes
  "models": "/a/folder/models",                          MATCH_VENDOR_ROOT for perception
  "salience": {"lost_body_frac": 0.4, "max_body_heights_per_frame": 1.0, "cap_percentile": 0.99},
  "targets":    [{"path": "...", "identity": "1f:...", "name": "...", "date": "2026-09-10", "people": ["..."]}],
  "references": [{"path": "...", "identity": "1f:...", "name": "...", "year": "2019", "people": ["..."], "class": "forehand"}],
  "reference_max_seconds": 8,                             prepare leaves out longer references (their label may not hold)
  "movement": "forehand", "class_margin": 0.05, "class_admit": 0.6,   when references carry a class (a human label, e.g.
                                                          from their folder), match uses select_partner's labelled mode
  "layout": "v", "padding_s": 2.5, "size": [1080, 1920], "call": ["<engine command>", "op"], "keep_folder": "/Recordings/...",
  "progression": {...}                                    optional: what the progression stage makes (see progression())
}
"""
import argparse
import datetime
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
    """Describe each clip of job[side] into work/<side>-index, skipping clips already described with the job's
    salience rules. A descriptor made under other rules is described again; pose keeps its own cache, so only the
    describe step runs again."""
    index = os.path.join(job["work"], f"{side}-index")
    os.makedirs(os.path.join(index, "_work"), exist_ok=True)
    env = {**os.environ, "MATCH_VENDOR_ROOT": job["models"], "MATCH_PERCEPTION_BACKEND": job.get("backend", "onnx")}
    made, kept, failed = [], [], []
    rules = json.dumps(job.get("salience") or {})
    fp = salience_fingerprint(rules)
    for clip in job[side]:
        k = key(clip)
        desc = os.path.join(index, f"{k}.desc.json")
        if os.path.exists(desc) and read(desc).get("salience_fp") == fp:
            kept.append(k)
            continue
        cmd = [sys.executable, os.path.join(PERCEPTION, "run_perception.py"), "--clip", clip["path"], "--out", desc,
               "--kp", os.path.join(index, "_work", f"{k}.kp.json"), "--salience-config", rules]
        r = subprocess.run(cmd, capture_output=True, text=True, env=env)
        if r.returncode or not os.path.exists(desc):
            failed.append({"clip": clip["path"], "why": (r.stderr.strip().splitlines() or ["no output"])[-1][:300]})
            continue
        made.append(k)
    return {"index": index, "made": made, "already": kept, "failed": failed}


def salience_fingerprint(rules):
    """describe_clip's own fingerprint of the salience rules a descriptor was made with."""
    sys.path.insert(0, PERCEPTION)
    try:
        import describe_clip
    finally:
        sys.path.remove(PERCEPTION)
    return describe_clip.salience_fingerprint(rules)


def read(path):
    with open(path) as f:
        return json.load(f)


def run_json(cmd, env=None, input_text=None):
    """Run one tool script (given `input_text` on stdin) and return its JSON answer: the whole stdout, or its last
    {"result"}/{"error"} line."""
    r = subprocess.run(cmd, capture_output=True, text=True, env=env, input=input_text)
    out = r.stdout.strip()
    try:
        return json.loads(out)
    except ValueError:
        lines = out.splitlines()
        return json.loads(lines[-1]) if lines else {"error": (r.stderr.strip().splitlines() or ["no output"])[-1]}


def by_key(job, side):
    return {key(c): c for c in job[side]}


def match(job):
    """Every window of every target against the reference index. The matcher returns every admitted partner in its
    own order; each of job.partner_choices (DATA, default one "best") picks a different one of them:
      {"name": "best"}                                   the matcher's order
      {"name": "footwork", "channels": ["approach", ...]} the scorecard channels named, closest first (each channel's
                                                         rank among the admitted partners, summed: no units to weigh)
    Only partners whose own takeback is the movement count. Each pair says its choice and which orderings it tops."""
    t_index, r_index = (os.path.join(job["work"], f"{s}-index") for s in ("targets", "references"))
    refs_by_src = {os.path.realpath(c["path"]): c for c in job["references"]}
    env = {**os.environ, "MATCH_VENDOR_ROOT": job["models"], "MATCH_PERCEPTION_BACKEND": job.get("backend", "onnx")}
    pairs, refused = [], []
    labelled = []
    classes = {key(r): r["class"] for r in job["references"] if r.get("class")}
    if classes:
        if len(classes) != len(job["references"]):
            raise ValueError("every reference needs a class when any has one")
        for need in ("movement", "class_margin", "class_admit"):
            if job.get(need) is None:
                raise ValueError(f"labelled references need job.{need}")
        labels = os.path.join(job["work"], "labels.json")
        with open(labels, "w") as f:
            json.dump(classes, f, indent=1)
        labelled = ["--labels", labels, "--want", job["movement"], "--class-margin", str(job["class_margin"]),
                    "--class-admit", str(job["class_admit"])]
    for k, clip in by_key(job, "targets").items():
        desc_path = os.path.join(t_index, f"{k}.desc.json")
        if not os.path.exists(desc_path):
            continue
        desc = read(desc_path)
        for w, window in enumerate(desc.get("windows", [])):
            got = run_json([sys.executable, os.path.join(MATCH, "select_partner.py"), "--target-desc", f"{desc_path}:{w}",
                            "--target-kp", os.path.join(t_index, "_work", f"{k}.kp.json"), "--index", r_index,
                            "--top", str(int(job.get("partner_pool", 50)))] + labelled, env)
            if got.get("no_match", True) or not got.get("partner_clip"):
                refused.append({"target": k, "window": w, "reason": got.get("reason") or got.get("error"),
                                "class_check": got.get("class_check")})
                continue
            side_check = None
            if clip.get("forehand_side"):
                side_check = stroke_of_window(os.path.join(t_index, "_work", f"{k}.kp.json"), window, clip["forehand_side"], job)
                if side_check["stroke"] != job.get("movement"):
                    refused.append({"target": k, "window": w, "reason": f"takeback side says {side_check['stroke'] or 'unclear'}",
                                    "stroke_side": side_check, "class_check": got.get("class_check")})
                    continue
            options = []
            for option in got.get("pairs") or [got]:      # every admitted partner whose own takeback is the movement too
                r_ = refs_by_src.get(os.path.realpath(option.get("partner_clip") or ""))
                d_ = read(os.path.join(r_index, f"{key(r_)}.desc.json")) if r_ else None
                if d_ is None:
                    continue
                w_ = d_["windows"][option["partner_window"]]
                ps = None
                if r_.get("forehand_side"):
                    ps = stroke_of_window(os.path.join(r_index, "_work", f"{key(r_)}.kp.json"), w_, r_["forehand_side"], job)
                    if ps["stroke"] != job.get("movement"):
                        continue
                options.append({"ref": r_, "pw": w_, "side": ps, "got": {**got, **option}})
            if not options:
                refused.append({"target": k, "window": w, "reason": "no admitted partner is the movement by its takeback side",
                                "stroke_side": side_check})
                continue
            orders = {c["name"]: order_options(options, c.get("channels")) for c in job.get("partner_choices") or [{"name": "best"}]}
            taken = set()
            for name, order in orders.items():
                pick = next((o for o in order if (key(o["ref"]), o["got"]["partner_window"]) not in taken), None)
                if pick is None:
                    continue
                taken.add((key(pick["ref"]), pick["got"]["partner_window"]))
                ref, pw, g = pick["ref"], pick["pw"], pick["got"]
                pairs.append({"target": k, "target_window": w, "target_peak": window["peak_t"], "target_t": g["target_t"],
                              "reference": key(ref), "reference_window": g["partner_window"], "reference_peak": pw["peak_t"],
                              "reference_t": g["partner_t"], "parity": g.get("parity"), "dist": g.get("dist"),
                              "heading_dist": g.get("heading_dist"), "scorecard": g.get("scorecard"),
                              "motion_dist": g.get("motion_dist"), "class_check": g.get("class_check"),
                              "choice": name, "tops": [n for n, o in orders.items() if o[0] is pick],
                              "admitted": len(options), "stroke_side": {"target": side_check, "reference": pick["side"]}})
    out = os.path.join(job["work"], "pairs.json")
    with open(out, "w") as f:
        json.dump({"pairs": pairs, "refused": refused}, f, indent=1)
    return {"pairs": len(pairs), "refused": len(refused), "file": out}


def order_options(options, channels):
    """The admitted partners in the matcher's order, or, given scorecard channel names, by the sum of each channel's
    rank among them (closest = 0; a channel a partner lacks ranks last), ties kept in the matcher's order."""
    if not channels:
        return list(options)

    def dist(o, name):
        got = ((o["got"].get("scorecard") or {}).get("channels") or {}).get(name) or {}
        return got.get("dist") if isinstance(got.get("dist"), (int, float)) else float("inf")
    rank = {id(o): 0 for o in options}
    for name in channels:
        for place, o in enumerate(sorted(options, key=lambda o: dist(o, name))):
            rank[id(o)] += place
    return sorted(options, key=lambda o: rank[id(o)])        # sorted is stable: ties stay in the matcher's order


def stroke_of_window(kp_path, window, forehand_side, job):
    """stroke_side.py's reading of one swing window: its takeback side and, with the recording's forehand side, its stroke."""
    sys.path.insert(0, HERE)
    import stroke_side
    with open(kp_path) as f:
        side, wrist = stroke_side.takeback_side(json.load(f), window["t0"], window["peak_t"])
    return {"side": side, "hitting_wrist": wrist, "forehand_side": forehand_side,
            "stroke": stroke_side.stroke_of(side, forehand_side, float(job.get("stroke_side_margin", 2.0)))}


def on_screen(clip, job):
    """The facts side_by_side.screen_direction reads. A recording with a forehand side says it directly (its forehand
    travels like a right hand seen from behind when +1); otherwise the clip's hand and camera."""
    if clip.get("forehand_side") in (1, -1):
        return {"hand": "right" if clip["forehand_side"] == 1 else "left", "camera": "behind"}
    return {"hand": clip.get("hand", "right"), "camera": clip.get("camera", job.get("camera", "behind"))}


def clip_name(job, pair):
    t, r = by_key(job, "targets")[pair["target"]], by_key(job, "references")[pair["reference"]]
    stamp = lambda c, field: c.get(field) or "unknown-date"
    who = lambda c: re.sub(r"[^a-z0-9]+", "-", (c.get("people") or ["someone"])[0].lower()).strip("-")
    clip_id = (r.get("identity") or "1f:" + key(r))[3:9]       # two clips of one year stay apart
    choice = f"_{pair['choice']}" if pair.get("choice") else ""
    return (f"{who(t)}-{stamp(t, 'date')}-{round(pair['target_peak'])}s_vs_{who(r)}-{stamp(r, 'year')}-{clip_id}-"
            f"{pair['reference_window']}_{job.get('movement', 'movement')}-{job.get('view', 'view')}{choice}.mp4")


def media_of(job):
    """The media-composition tool folder: job.media_composition, else the one beside this tool."""
    return job.get("media_composition") or os.path.join(HERE, "..", "..", "media-composition")


def kp_of(job, index, k):
    return os.path.join(job["work"], f"{index}-index", "_work", f"{k}.kp.json")


def plan_pair(job, pair, base, media, steps):
    """One pair's plan, written beside `base` for author_comparison_edl.py: each side's contact (a person's mark, else
    contact_moment.py), the phase sync of the reference to the target (phase_sync.py; refused = contact only), the
    mirror from facts both sides carry, and the two-sided spec (BASE.spec.json, reference first: top / left). `steps`
    is filled as it goes, so a failure still says what was found; a piece that fails raises RuntimeError."""
    T, R = by_key(job, "targets"), by_key(job, "references")
    t, r = T[pair["target"]], R[pair["reference"]]
    contacts = {}
    for name, clip, k, index, window, peak in (
            ("target", t, pair["target"], "targets", pair["target_t"], pair["target_peak"]),
            ("reference", r, pair["reference"], "references", pair["reference_t"], pair["reference_peak"])):
        marks = [m for m in (job.get("contact_marks") or {}).get(clip.get("identity"), [])
                 if window[0] <= float(m) <= window[1]]
        if marks:  # a person's mark is the contact: no detector here is frame-exact on every kind of video
            near = min(marks, key=lambda m: abs(float(m) - peak))
            contacts[name] = {"time": float(near), "source": "mark", "hit": None,
                              "why": f"marked by a person, {float(near) - peak:+.3f} s from the wrist peak"}
            continue
        tolerance = (job.get("contact_tolerance_s") or {}).get(name, 0.25)
        lag = (job.get("contact_audio_lag_s") or {}).get(name, 0.0)  # how late this side's sound is (DATA)  # 0 = never the sound (its audio
        got = run_json([sys.executable, os.path.join(HERE, "contact_moment.py"), "--clip", clip["path"],  # may be off)
                        "--t0", str(window[0]), "--t1", str(window[1]), "--wrist-peak", str(peak),
                        "--media-composition", media, "--tolerance", str(tolerance), "--audio-lag", str(lag)])
        if "error" in got:
            raise RuntimeError(f"contact {name}: {got['error']}")
        contacts[name] = got["result"]
    steps["contact"] = contacts
    tc, rc = contacts["target"]["time"], contacts["reference"]["time"]
    # each side's window comes from its own swing landmarks (phase_sync); the clips make its landmark sheet
    sync_spec = {"fps": 30, "target": {"kp": kp_of(job, "targets", pair["target"]), "contact": tc, "clip": t["path"]},
                 "reference": {"kp": kp_of(job, "references", pair["reference"]), "contact": rc, "clip": r["path"]}}
    if "mark" in (contacts["target"]["source"], contacts["reference"]["source"]):
        # a person's mark is the contact; the fastest hands can come before it (measured Nov 26 2026: 0.127 s
        # on a student's phone clip), so the fastest-moment check only asks for the same swing
        sync_spec["settings"] = {"landmarks": {"contact_off_s": 0.35}}
    with open(base + ".sync-spec.json", "w") as f:
        json.dump(sync_spec, f, indent=1)
    got = run_json([sys.executable, os.path.join(HERE, "phase_sync.py"), "--spec", base + ".sync-spec.json",
                    "--out", base + ".sync.json"])
    # a refused sync never distorts the reference: the pair is cut on contact alone (both contacts meet, the
    # phases around them play as recorded) and the clip's row says which alignment it has
    synced = "error" not in got
    steps["sync"] = got["result"] if synced else {"aligned": "contact only", "refused": got["error"]}

    # mirror from facts both sides carry (hand, where the camera stands), by the same rule the check holds
    # them to; the matcher's pose parity is kept beside it, never used to decide
    sys.path.insert(0, HERE)
    from side_by_side import screen_direction
    facts = lambda c: on_screen(c, job)
    flip = screen_direction(facts(r)) != screen_direction(facts(t))
    steps["mirror"] = {"flip": flip, "reference": facts(r), "target": facts(t), "matcher_parity": pair.get("parity")}

    def side(clip, k, index, peak, flip, sync=None):
        return {"clip": clip["path"], "kp": kp_of(job, index, k), "peak": peak, "label": "",
                **({"flip": "h"} if flip else {}), **({"sync": sync} if sync else {})}
    spec = {"encode": {"fps": 30, "crf": 18, "preset": "medium"}, "bg": "black",
            "left": side(r, pair["reference"], "references", rc, flip,
                         base + ".sync.json" if synced else None),
            "right": side(t, pair["target"], "targets", tc, False)}
    with open(base + ".spec.json", "w") as f:
        json.dump(spec, f, indent=1)
    return spec


def frame_edit(job, edit, framed, when_too_wide):
    """whole_movement_check.py on an edit: a cell's crop widened where the body or racket would leave it, or, where no
    crop of the cell's shape fits the source, the whole movement fitted over a blurred fill (`when_too_wide`
    fit-blurred) or refused (refuse), written to `framed`. Answers (framing result, None) or (framing result, why)."""
    seg_model = os.path.join(job["models"], job.get("framing_model", "yolo11n-seg.pt"))
    got = run_json([sys.executable, os.path.join(HERE, "whole_movement_check.py"), "--edit", edit, "--model", seg_model,
                    "--work", framed[:-5] + ".framing", "--write-edit", framed, "--when-too-wide", when_too_wide])
    if "error" in got or not os.path.exists(framed) or (got.get("result") or {}).get("cells_refused"):
        return got.get("result"), f"framing: {got.get('error') or 'a cell cannot hold the whole movement'}"
    return got.get("result"), None


def render_edit(media, edl, out):
    """media-composition's render-an-edit.mjs renders an edit to `out`. Answers None, or why it made no video."""
    rr = subprocess.run(["node", os.path.join(media, "do-work", "render-an-edit.mjs"), "--edl", json.dumps(edl),
                         "--output", out], capture_output=True, text=True)
    if rr.returncode or not os.path.exists(out):
        return (rr.stderr.strip().splitlines() or ["render failed"])[-1][:300]
    return None


def render(job):
    """Each admitted pair becomes one clip per format of the variants (comparison-variants.json: 9:16 stacked and
    16:9 side by side, each with a 1x pass, 0.5x / 0.25x / 0.1x smooth slow motion and a contact still), made only by
    this tool's pieces, in order:
      contact_moment.py        each side's contact: the hit's sound near the wrist peak, else the wrist peak (says which)
      phase_sync.py            the reference retimed in bounded speed pieces so takeback, contact and finish land with
                               the target's; a pair that cannot be synced within the bounds is refused, never distorted
      author_comparison_edl.py the edit per format (reference on top / left, mirrored when the matcher says reflected)
      whole_movement_check.py  body and racket inside every cell's crop for the whole cut (crop widened, or refused)
      render-an-edit.mjs       media-composition renders it (smooth slow motion = its motion-compensated interpolation)"""
    pairs = read(os.path.join(job["work"], "pairs.json"))["pairs"]
    folder = os.path.join(job["work"], "clips")
    os.makedirs(folder, exist_ok=True)
    media = media_of(job)
    variants_path = job.get("variants") or os.path.join(HERE, "comparison-variants.json")
    variants = read(variants_path)
    made, failed = [], []
    for pair in pairs:
        base = os.path.join(folder, clip_name(job, pair)[:-4])
        formats = [f["id"] for f in variants["formats"]]
        if all(os.path.exists(f"{base}.{fid}.mp4") for fid in formats):
            made += [already_made(pair, base, fmt) for fmt in variants["formats"]]
            continue
        steps = {}
        try:
            plan_pair(job, pair, base, media, steps)
            got = run_json([sys.executable, os.path.join(HERE, "author_comparison_edl.py"), "--spec", base + ".spec.json",
                            "--out", base + ".edit.json", "--variants", variants_path])
            if "error" in got:
                raise RuntimeError(f"edit: {got['error']}")
        except RuntimeError as e:
            failed.append({"pair": pair, "why": str(e), "steps": steps})
            continue
        for fmt in variants["formats"]:
            fid = fmt["id"]
            edit, out = f"{base}.edit.{fid}.json", f"{base}.{fid}.mp4"   # author_comparison_edl --variants names OUT.FORMAT.json
            framing, why = frame_edit(job, edit, f"{base}.{fid}.edit.json", variants.get("when_too_wide", "fit-blurred"))
            why = why or render_edit(media, read(f"{base}.{fid}.edit.json"), out)
            if why:
                failed.append({"pair": pair, "format": fid, "why": why, "framing": framing, "steps": steps})
                continue
            entry = {"pair": pair, "file": out, "edit": f"{base}.{fid}.edit.json", "format": fid,
                     "size": [fmt["width"], fmt["height"]], "layout": fmt["layout"], "steps": {**steps, "framing": framing}}
            with open(f"{base}.{fid}.made.json", "w") as f:   # a rerun reads this back instead of making the clip again
                json.dump(entry, f, indent=1)
            made.append(entry)
    with open(os.path.join(job["work"], "rendered.json"), "w") as f:
        json.dump({"made": made, "failed": failed}, f, indent=1)
    return {"made": len(made), "failed": len(failed), "first_failure": failed[0]["why"] if failed else None}


def already_made(pair, base, fmt):
    """A clip a previous run made: its own record when that run kept one, else rebuilt from what it left beside the
    clip (each side's contact from the sync spec), so the check reads the contact and the cell shape it was made
    with, never the wrist peak or another format's shape."""
    fid = fmt["id"]
    kept = f"{base}.{fid}.made.json"
    if os.path.exists(kept):
        return {**read(kept), "pair": pair, "already": True}
    steps = {}
    if os.path.exists(base + ".sync-spec.json"):
        spec = read(base + ".sync-spec.json")
        steps["contact"] = {name: {"time": spec[name]["contact"], "source": "sync-spec"} for name in ("target", "reference")}
    return {"pair": pair, "file": f"{base}.{fid}.mp4", "edit": f"{base}.{fid}.edit.json", "format": fid,
            "size": [fmt["width"], fmt["height"]], "layout": fmt["layout"], "steps": steps, "already": True}


def progression(job):
    """One video of a target's swings over time against ONE fixed reference swing: the reference on the top cell, the
    target's swings under it oldest first, each played as recorded with the reference phase-synced to it (render's own
    plan_pair), each a whole swing ("span": "swing"), and over each swing its date as a caption whose letters sit where
    the label says (media-composition's caption-subtitle.mjs measures them). It is made from a finished batch's
    pairs.json by the pieces render uses, and adds no matcher, sync or renderer of its own.
    job.progression (DATA; nothing about a person, a stroke or a reference is in this code):
      "reference": {"key" | "identity", "window"}   optional; else the reference swing that partners the most distinct
                                                    target dates with a swing that can be shown (ties: the lowest mean
                                                    motion distance; `references_tried` says how many each showed). One batch is
                                                    one camera view (job.view), so every candidate is at that angle
      "targets": [{"key" | "identity", "window"}]   optional, in play order; else per date its pair closest to the
                                                    reference (lowest motion_dist) whose sync holds and whose cells
                                                    hold the whole movement (render's framing rule), spread over time
      "count": 12, "seconds": [30, 50]              how many swings, and the length the video must fit: fewer or more
                                                    swings until it does
      "slow_last": {"speed": 0.5, "smooth": true}   optional: the newest swing once more, slowed
      "label": {"format": "%b %Y", "style": <caption style id | row>, "letters": {"edge": "top", "at": 0.5},
                "fontsdir": "/a/folder"}            the date text, its caption style and where its letters sit
      "size": [1080, 1920], "layout": "v", "name": "<file name without .mp4>"
      "when_too_wide": "fit-blurred" | "refuse"     a swing no crop of the cell's shape can hold: shown whole over a
                                                    blurred fill (the default), or not shown
    Without job.progression it does nothing and says so."""
    p = job.get("progression")
    if not p:
        return {"skipped": "the job has no progression"}
    pairs = read(os.path.join(job["work"], "pairs.json"))["pairs"]
    T, R = by_key(job, "targets"), by_key(job, "references")
    by_identity = {c.get("identity"): k for side in (T, R) for k, c in side.items()}

    def named_key(named):
        return named.get("key") or by_identity.get(named.get("identity"))

    def dist(pair):
        return pair["motion_dist"] if isinstance(pair.get("motion_dist"), (int, float)) else float("inf")

    dated = [pair for pair in pairs if T[pair["target"]].get("date")]
    width, height = (int(n) for n in p.get("size") or job.get("size") or [1080, 1920])
    layout = p.get("layout", "v")
    name = p.get("name") or f"{job.get('movement', 'movement')}-{job.get('view', 'view')}-progression"
    folder = os.path.join(job["work"], "progression", name)
    os.makedirs(folder, exist_ok=True)
    media = media_of(job)
    slow = p.get("slow_last")

    def plan(pair):
        """A swing is shown only when its sync holds and both cells hold the whole movement (the render rules)."""
        base = os.path.join(folder, f"{pair['target']}-{pair['target_window']}-vs-{pair['reference']}-{pair['reference_window']}")
        steps = {}
        try:
            spec = plan_pair(job, pair, base, media, steps)
        except RuntimeError as e:
            return None, str(e)
        if (steps.get("sync") or {}).get("aligned") == "contact only":
            return None, f"sync refused: {steps['sync']['refused']}"
        passes = [{"id": "swing", "half": 1.0, "span": "swing"}]
        if slow:      # made for every swing, shown for the newest only
            passes.append({"id": "slow", "half": 1.0, "span": "swing", "speed": float(slow["speed"]),
                           **({"smooth": True} if slow.get("smooth") else {})})
        spec.update({"encode": {**spec["encode"], "width": width, "height": height}, "layout": layout, "passes": passes})
        with open(base + ".progression-spec.json", "w") as f:
            json.dump(spec, f, indent=1)
        got = run_json([sys.executable, os.path.join(HERE, "author_comparison_edl.py"), "--spec",
                        base + ".progression-spec.json", "--out", base + ".progression-edit.json"])
        if "error" in got:
            return None, f"edit: {got['error']}"
        framing, why = frame_edit(job, base + ".progression-edit.json", base + ".progression-framed.json",
                                  p.get("when_too_wide", "fit-blurred"))
        if why:
            return None, {"why": why, "framing": framing}
        sync = read(base + ".sync.json")
        return {"pair": pair, "base": base, "steps": {**steps, "framing": framing}, "date": T[pair["target"]]["date"],
                "seconds": sync["target"]["out"] - sync["target"]["in"]}, None

    def with_swing(swing):
        return [pair for pair in dated if (pair["reference"], pair["reference_window"]) == swing]

    def plan_named(swing):
        planned, dropped = [], []
        for named in p["targets"]:
            want = (named_key(named), int(named.get("window", 0)))
            pair = min((x for x in with_swing(swing) if (x["target"], x["target_window"]) == want), key=dist, default=None)
            got, why = plan(pair) if pair else (None, "no pair of this target swing with the reference swing")
            if got:
                planned.append(got)
            else:
                dropped.append({"target": want, "why": why})
        return planned, dropped

    def plan_dates(swing):
        planned, dropped = [], []
        for date in sorted({T[x["target"]]["date"] for x in with_swing(swing)}):
            whys = []
            for pair in sorted((x for x in with_swing(swing) if T[x["target"]]["date"] == date), key=dist):
                got, why = plan(pair)
                if got:
                    planned.append(got)
                    break
                whys.append(why)
            else:
                dropped.append({"date": date, "why": whys})
        return planned, dropped

    planner = plan_named if p.get("targets") else plan_dates
    tried = []
    if p.get("reference"):
        swing = (named_key(p["reference"]), int(p["reference"].get("window", 0)))
        if swing[0] not in R:
            raise ValueError(f"the job has no reference {swing[0]}")
        planned, dropped = planner(swing)
    else:
        # the reference swing that partners the most dates WITH a swing that can be shown: candidates in order of their
        # partnered dates (ties: the lowest mean motion distance), each planned until no later one could show more
        swings = {}
        for pair in dated:
            swings.setdefault((pair["reference"], pair["reference_window"]), []).append(pair)
        if not swings:
            raise ValueError("pairs.json has no pair of a dated target")
        reach = {s: len({T[x["target"]]["date"] for x in found}) for s, found in swings.items()}
        swing, planned, dropped = None, [], []
        for s in sorted(swings, key=lambda s: (-reach[s], sum(map(dist, swings[s])) / len(swings[s]), s)):
            if swing is not None and reach[s] <= len(planned):
                break
            got, lost = planner(s)
            tried.append({"reference": s[0], "window": s[1], "dates": reach[s], "shown": len(got)})
            if swing is None or len(got) > len(planned):
                swing, planned, dropped = s, got, lost
    chosen = planned if p.get("targets") else fit(planned, int(p.get("count", 12)), p.get("seconds"), slow)
    if not chosen:
        raise ValueError(f"no swing of a dated target syncs and frames with the reference swing {list(swing)}: {dropped[:3]}")

    fps = 30
    label = p.get("label") or {}
    segments, lines, shown, at_frame, edit = [], [], [], 0, None
    for n, item in enumerate(chosen):
        edit = read(item["base"] + ".progression-framed.json")
        if n < len(chosen) - 1:
            edit["spine"]["segments"] = edit["spine"]["segments"][:1]
        text = datetime.date.fromisoformat(item["date"]).strftime(label.get("format", "%Y-%m-%d"))
        starts, contact = at_frame, None
        for segment in edit["spine"]["segments"]:
            target = segment["sources"][1]                     # the target plays as recorded, so its seconds time the cell
            if contact is None:
                contact = at_frame / fps + item["steps"]["contact"]["target"]["time"] - target["in"]
            segment["id"] = f"{n:02d}-{segment['id']}"
            at_frame += round((target["out"] - target["in"]) / float(segment.get("speed", 1)) * fps)
            segments.append(segment)
        lines.append({"text": text, "start": starts / fps, "end": at_frame / fps, "x": 0.5})
        shown.append({"target": item["pair"]["target"], "target_window": item["pair"]["target_window"],
                      "date": item["date"], "label": text, "motion_dist": item["pair"].get("motion_dist"),
                      "from_s": round(starts / fps, 3), "to_s": round(at_frame / fps, 3), "contact_s": round(contact, 3),
                      "max_phase_error_frames": item["steps"]["sync"].get("max_phase_error_frames"),
                      "contact": item["steps"]["contact"]})
    hold_reference_crop(segments, read(kp_of(job, "references", swing[0]))["video"], width, height, layout)
    out = os.path.join(job["work"], "progression", name + ".mp4")
    fonts = {"fontsdir": label["fontsdir"]} if label.get("fontsdir") else {}
    caption = run_json(["node", os.path.join(media, "do-work", "caption-subtitle.mjs")], input_text=json.dumps(
        {"lines": lines, "style": label.get("style"), "width": width, "height": height, "letters": label.get("letters"), **fonts}))
    if "error" in caption:
        raise RuntimeError(f"date captions: {caption['error']}")
    edl = {**edit, "spine": {"segments": segments}, "subtitles": {"ass": caption["result"]["ass"], **fonts}}
    with open(out[:-4] + ".edit.json", "w") as f:
        json.dump(edl, f, indent=1)
    why = render_edit(media, edl, out)
    if why:
        raise RuntimeError(why)
    r = R[swing[0]]
    made = {"file": out, "edit": out[:-4] + ".edit.json", "size": [width, height], "seconds": round(at_frame / fps, 3),
            "reference": {"key": swing[0], "window": swing[1], "name": r.get("name"), "identity": r.get("identity")},
            "swings": shown, "labels": caption["result"]["lines"], "dropped": dropped, "references_tried": tried}
    with open(out[:-4] + ".json", "w") as f:
        json.dump(made, f, indent=1)
    return {"file": out, "record": out[:-4] + ".json", "swings": len(shown), "seconds": made["seconds"],
            "reference": made["reference"], "dates": [s["date"] for s in shown], "dropped": len(dropped)}


def fit(planned, count, seconds, slow):
    """`count` of the planned swings spread evenly over time (the oldest and the newest always in), then fewer or more
    of them until the whole video, the slowed newest swing included, lasts within `seconds` [least, most] if given."""
    planned = sorted(planned, key=lambda x: x["date"])
    if not planned:
        return []

    def day(item):
        return datetime.date.fromisoformat(item["date"]).toordinal()

    def spread(k):
        if k >= len(planned):
            return list(planned)
        first, last = day(planned[0]), day(planned[-1])
        left, out = list(planned), []
        for i in range(k):
            when = first + (last - first) * i / max(k - 1, 1)
            near = min(left, key=lambda x: (abs(day(x) - when), day(x)))
            left.remove(near)
            out.append(near)
        return sorted(out, key=lambda x: x["date"])

    def length(chosen):
        return sum(x["seconds"] for x in chosen) + (chosen[-1]["seconds"] / float(slow["speed"]) if slow else 0.0)

    k = max(1, min(count, len(planned)))
    if seconds:
        least, most = (float(n) for n in seconds)
        while k > 1 and length(spread(k)) > most:
            k -= 1
        while k < len(planned) and length(spread(k)) < least and length(spread(k + 1)) <= most:
            k += 1
    return spread(k)


def hold_reference_crop(segments, video, width, height, layout):
    """One crop for the reference cell of every segment: the union of their crops at the cell's aspect inside the
    source frame, so the reference never jumps when the date changes. When that shape does not fit the source, the
    union cut to the source is shown whole over a blurred fill (the framing check's own fit), the same in every segment."""
    sources = [s["sources"][0] for s in segments]
    x0, y0 = min(c["crop"]["x"] for c in sources), min(c["crop"]["y"] for c in sources)
    x1 = max(c["crop"]["x"] + c["crop"]["w"] for c in sources)
    y1 = max(c["crop"]["y"] + c["crop"]["h"] for c in sources)
    aspect = (width / 2) / height if layout == "h" else width / (height / 2)
    cell = [width // 2, height] if layout == "h" else [width, height // 2]
    w, h = max(x1 - x0, (y1 - y0) * aspect), max(y1 - y0, (x1 - x0) / aspect)
    fit = None
    if w > video["width"] or h > video["height"]:
        w, h = min(w, video["width"]), min(h, video["height"])
        if abs(w / h - aspect) > 1e-3:
            scale = min(cell[0] / w, cell[1] / h)
            iw, ih = 2 * int(w * scale / 2), 2 * int(h * scale / 2)
            fit = {"fill": "blur", "cell": cell, "inner": {"w": iw, "h": ih, "x": (cell[0] - iw) // 2, "y": (cell[1] - ih) // 2}}
    cx, cy = (x0 + x1) / 2, (y0 + y1) / 2
    crop = {"w": int(w), "h": int(h), "x": int(max(0, min(cx - w / 2, video["width"] - w))),
            "y": int(max(0, min(cy - h / 2, video["height"] - h)))}
    for source in sources:
        source["crop"] = dict(crop)
        if fit:
            source["fit"] = json.loads(json.dumps(fit))
        else:
            source.pop("fit", None)
    return crop


def check(job):
    """side_by_side.py check on every rendered clip, from the edit it was rendered from: its first pass (1x, the target
    as recorded, the reference phase-synced with contact pinned) must show two sources whose contacts meet within one
    output frame."""
    rendered = read(os.path.join(job["work"], "rendered.json"))["made"]
    T, R = by_key(job, "targets"), by_key(job, "references")
    results = []
    for item in rendered:
        edit = read(item["edit"])
        top_src, bottom_src = edit["spine"]["segments"][0]["sources"]
        pair = item["pair"]
        contact = (item.get("steps") or {}).get("contact") or {}
        # the target (bottom / right) plays as recorded, so its contact is this far into the first pass; a pass that
        # shows the whole swing ("span": "swing") is not centred on contact
        t_contact = (contact.get("target") or {}).get("time", pair["target_peak"])
        before, after = t_contact - bottom_src["in"], bottom_src["out"] - t_contact

        def side(src, clip, peak, data_side):
            fps = read(os.path.join(job["work"], f"{data_side}-index", "_work", f"{key(clip)}.kp.json"))["video"]["fps"]
            c = src["crop"]
            inner = (src.get("fit") or {}).get("inner")
            return {"source": clip["path"], "fps": fps, "contact_frame": round(peak * fps), "crop": [c["w"], c["h"], c["x"], c["y"]],
                    **({"inner": [inner["w"], inner["h"], inner["x"], inner["y"]]} if inner else {}),
                    "mirror": src.get("flip") == "h", "stroke": job.get("movement"), **on_screen(clip, job),
                    "stroke_seen": f"{job.get('movement')}: the reference's labelled class, and the matcher admitted the pair (motion {pair.get('motion_dist')}, class check {pair.get('class_check')})"}
        width, height = item.get("size") or job.get("size", [1080, 1920])
        cell = [width, height // 2] if item.get("layout", job.get("layout", "v")) == "v" else [width // 2, height]
        spec = {"top": side(top_src, R[pair["reference"]], (contact.get("reference") or {}).get("time", pair["reference_peak"]), "references"),
                "bottom": side(bottom_src, T[pair["target"]], (contact.get("target") or {}).get("time", pair["target_peak"]), "targets"),
                "cell": cell, "layout": item.get("layout", job.get("layout", "v")), "fps": 30, "before_s": round(before, 6), "after_s": round(after, 6)}
        spec_path = item["file"][:-4] + ".check-spec.json"
        with open(spec_path, "w") as f:
            json.dump(spec, f, indent=1)
        got = run_json([sys.executable, os.path.join(HERE, "side_by_side.py"), "check", "--spec", spec_path, "--clip", item["file"],
                        "--sheet", item["file"][:-4] + ".sheet.jpg"])
        results.append({"file": item["file"], "pair": pair, "format": item.get("format"), "steps": item.get("steps"),
                        "check": got.get("result", got)})
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
                                         "heading_dist": pair.get("heading_dist"), "motion_dist": pair.get("motion_dist"),
                                         "class_check": pair.get("class_check"), "choice": pair.get("choice"),
                                         "tops": pair.get("tops"), "admitted": pair.get("admitted"),
                                         "scorecard": pair.get("scorecard")},
                               "format": item.get("format"), "steps": item.get("steps"),
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

    left_out = []
    longest = spec.get("reference_max_seconds")  # a folder's label holds for its one-swing clips, not for a long
    #                                              practice recording filed under it (measured Nov 25 2026: 5 to 11
    #                                              minute "backhand" sessions hold forehands too), so those are left out

    def clips(rows, people, side):
        out = []
        for row in rows:
            ext = os.path.splitext(row["name"])[1].lower() or ".mp4"
            path = os.path.join(media, side + "-" + row["identity"][3:19] + ext)
            files_road.fetch(call, row["identity"], path)
            if side == "reference" and longest:
                seconds = duration(path)
                if seconds is None or seconds > float(longest):
                    left_out.append({"name": row["name"], "seconds": seconds, "why": f"longer than {longest} s or unreadable"})
                    continue
            clip = {"path": path, "identity": row["identity"], "name": row["name"], "people": people}
            if row.get("class"):
                clip["class"] = row["class"]                  # a human label (e.g. from the clip's folder)
            if spec.get(f"{side}_forehand_side") in (1, -1):  # how the recording was filmed: +1 forehand takebacks go
                clip["forehand_side"] = spec[f"{side}_forehand_side"]   # to screen right, -1 to screen left
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
    return {"job": path, "targets": len(job["targets"]), "references": len(job["references"]), "references_left_out": left_out,
            "progression": bool(job.get("progression"))}


def duration(path):
    """A file's length in seconds by ffprobe, or None when it cannot be read."""
    r = subprocess.run(["ffprobe", "-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", path],
                       capture_output=True, text=True)
    try:
        return float(r.stdout.strip())
    except ValueError:
        return None


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("stage", choices=["prepare", "perceive", "match", "render", "check", "keep", "progression"])
    ap.add_argument("--job", help="the job file (every stage but prepare, which reads its spec on stdin)")
    ap.add_argument("--side", choices=["targets", "references"], default="targets")
    a = ap.parse_args()
    try:
        if a.stage == "prepare":
            out = prepare(json.load(sys.stdin))
        else:
            job = read(a.job)
            out = perceive(job, a.side) if a.stage == "perceive" else \
                {"match": match, "render": render, "check": check, "keep": keep,
                 "progression": progression}[a.stage](job)
    except Exception as e:  # one line the workflow reads, with the reason
        print(json.dumps({"error": f"{a.stage}: {type(e).__name__}: {e}"}))
        return 1
    print(json.dumps({"result": out}))
    return 0


if __name__ == "__main__":
    sys.exit(main())
