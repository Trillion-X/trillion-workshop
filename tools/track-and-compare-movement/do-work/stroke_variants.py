"""Make the clip-library variants of every stroke in one recording and keep them in the person's Files.

USAGE: stroke_variants.py --job JOB.json --state STATE.json --work DIR [--spec SPEC.json] [--contacts S1,S2]

JOB: {call (the engine command up to its method), source_identity, source_name, date, person, files_folder, strokes: STROKES.json from find_strokes.py,
      track: TRACK.json from fast_pose.py}
SPEC (DATA): the aspects and speeds are comparison-variants.json's, the one list a comparison's variants use too
(its formats: 9x16 1080x1920 and 16x9 1920x1080; the speeds of its passes that are not a still: 1, 0.5, 0.25, 0.1, here
plain: frames repeated, no interpolation); --spec can still replace either. An every-frame copy per aspect (every frame a keyframe, so any frame can be
held as long as wanted); the contact still. Each stroke is cut from its ready to its finish, at most max_pad_s each
side of contact and never past halfway to the next stroke, so a clip holds one stroke.
All of a stroke's files come from one decode of the source. Before each decode it waits while the 5-minute load
average is over load_max. STATE records each kept file and its identity, so a stopped run goes on where it stopped
(keep STATE out of /tmp: a restart empties it). --contacts makes only the strokes whose contact second is listed (each
stroke still pads against its real neighbours); without it every stroke is made.
Prints one line per kept file and a last {"result": ...}.
"""
import argparse, json, os, subprocess, sys, time

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import files_road  # noqa: E402

VARIANTS = os.path.join(os.path.dirname(os.path.abspath(__file__)), "comparison-variants.json")


def variant_lists(path=VARIANTS):
    """The aspects ({id: [width, height]}) and speeds of comparison-variants.json: each format, and the speed of each
    pass that is not a still (1 when a pass names none)."""
    with open(path, encoding="utf-8") as handle:
        variants = json.load(handle)
    return {"aspects": {one["id"]: [int(one["width"]), int(one["height"])] for one in variants["formats"]},
            "speeds": [one.get("speed", 1) for one in variants["passes"] if not one.get("still")]}


SPEC = {**variant_lists(), "max_pad_s": 2.5, "load_max": 90, "frame_of_body": 1.5}


def wait_for_load(limit):
    while float(subprocess.run(["sysctl", "-n", "vm.loadavg"], capture_output=True, text=True).stdout.split()[2]) > limit:
        time.sleep(60)


def body_box(frames, t0, t1):
    pts = [p for f in frames if t0 <= f["t"] <= t1 for p in f["kp"] if p[2] > 0.3]
    xs = [p[0] for p in pts]
    ys = [p[1] for p in pts]
    return min(xs), min(ys), max(xs), max(ys)


def crop(box, video, ow, oh, scale_of_body):
    x0, y0, x1, y1 = box
    cx, cy = (x0 + x1) / 2, (y0 + y1) / 2
    h = min(video["height"], (y1 - y0) * scale_of_body)
    w = h * ow / oh
    if w > video["width"]:
        w = video["width"]
        h = w * oh / ow
    x = max(0, min(video["width"] - w, cx - w / 2))
    y = max(0, min(video["height"] - h, cy - h / 2))
    return f"crop={int(w) // 2 * 2}:{int(h) // 2 * 2}:{int(x)}:{int(y)},scale={ow}:{oh}"


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--job", required=True)
    ap.add_argument("--state", required=True)
    ap.add_argument("--work", required=True)
    ap.add_argument("--spec")
    ap.add_argument("--contacts", help="comma-separated contact seconds of the strokes to make; all when absent")
    a = ap.parse_args()
    spec = dict(SPEC, **(json.load(open(a.spec)) if a.spec else {}))
    job = json.load(open(a.job))
    state = json.load(open(a.state)) if os.path.exists(a.state) else {}
    os.makedirs(a.work, exist_ok=True)
    source = files_road.fetch(job["call"], job["source_identity"], os.path.join(a.work, "source" + os.path.splitext(job["source_name"])[1]))
    track = json.load(open(job["track"]))
    frames, video = track["persons"][0]["frames"], track["video"]
    contacts = sorted(s["contact_s"] for s in json.load(open(job["strokes"]))["strokes"])
    end_s = video["frames"] / video["fps"]
    wanted = [float(x) for x in a.contacts.split(",")] if a.contacts else None
    kept = failed = 0
    for k, c in enumerate(contacts):
        if wanted is not None and not any(abs(c - w) < 0.0005 for w in wanted):
            continue
        sid = f"{job['person'].split()[0].lower()}-{job['date']}-{c:07.2f}s".replace(".", "_")
        before = min(spec["max_pad_s"], c, (c - contacts[k - 1]) / 2 if k else 1e9)
        after = min(spec["max_pad_s"], end_s - c, (contacts[k + 1] - c) / 2 if k + 1 < len(contacts) else 1e9)
        box = body_box(frames, c - before, c + after)
        s = state.setdefault(sid, {"contact_s": c, "start_s": round(c - before, 3), "end_s": round(c + after, 3), "files": {}})
        outputs = []
        for aspect, (ow, oh) in spec["aspects"].items():
            vf = crop(box, video, ow, oh, spec["frame_of_body"])
            for sp in spec["speeds"]:
                outputs.append((f"{sid}_{aspect}_{int(sp * 100)}pct.mp4", f"setpts=(PTS-STARTPTS)/{sp},{vf}",
                                ["-crf", "17", "-r", str(round(video["fps"], 3))]))
            outputs.append((f"{sid}_{aspect}_every-frame.mp4", f"setpts=PTS-STARTPTS,{vf}", ["-crf", "12", "-g", "1"]))
        todo = [o for o in outputs if not s["files"].get(o[0], {}).get("identity")]
        if todo:
            wait_for_load(spec["load_max"])
            graph = [f"[0:v]split={len(todo)}" + "".join(f"[s{i}]" for i in range(len(todo)))]
            graph += [f"[s{i}]{vf}[o{i}]" for i, (_, vf, _) in enumerate(todo)]
            cmd = ["ffmpeg", "-v", "error", "-y", "-ss", str(c - before), "-t", str(before + after), "-i", source,
                   "-filter_complex", ";".join(graph)]
            for i, (name, _, extra) in enumerate(todo):
                cmd += ["-map", f"[o{i}]", "-an", "-c:v", "libx264", "-preset", "medium", "-pix_fmt", "yuv420p",
                        "-threads", "2"] + extra + [os.path.join(a.work, name)]
            subprocess.run(cmd, check=True)
        still = f"{sid}_contact.jpg"
        if not s["files"].get(still, {}).get("identity"):
            subprocess.run(["ffmpeg", "-v", "error", "-y", "-ss", str(c), "-i", source, "-frames:v", "1", "-vf",
                            crop(box, video, 1920, 1080, spec["frame_of_body"]), "-q:v", "2", os.path.join(a.work, still)],
                           check=True)
            todo = todo + [(still, None, None)]
        for name, _, _ in todo:
            local = os.path.join(a.work, name)
            remote = f"{job['files_folder']}/{sid}/{name}"
            ident = files_road.keep(job["call"], local, remote, "image/jpeg" if name.endswith(".jpg") else "video/mp4")
            s["files"][name] = {"name": remote, "identity": ident}
            json.dump(state, open(a.state, "w"), indent=1)
            print(json.dumps({"stroke": sid, "file": name, "kept": bool(ident)}), flush=True)
            if ident:
                os.remove(local)
                kept += 1
            else:
                failed += 1
    print(json.dumps({"result": {"strokes": len(contacts), "kept": kept, "failed": failed, "state": a.state}}))
    return 0


if __name__ == "__main__":
    sys.exit(main())
