"""Make the file a site shows for one made swing clip, keep it in the person's Files, and say how to place it.

USAGE: make_site_clip.py --plan PLAN.json --work DIR --call CMD ...  (CMD: the engine command up to its method)

PLAN (DATA, one object per clip in "clips"):
  {"clips": [{
     "piece":   stable id of the thing across its versions (site-clip:<slug>),
     "source":  {"identity": "1f:...", "name": its Files name, "local": optional path already holding those bytes},
     "keep":    optional [[start_s, end_s], ...] stretches of the source kept in order (the whole source when absent),
     "files_name": where the made file is kept in Files (an export folder of the player, never /published-clips/),
     "stills":  {"cover": {"at": s, "why": ...}} for a single clip, or {"left": {"at": s, "crop": [x, y, w, h], "why": ...},
                "right": {...}} for a comparison; seconds are on the made file, crops in its pixels, why says what the
                still shows and why that frame,
     "extra":   what the site row carries (kind, moment, aspect, speed, captured_day, pair, format_id, why, style, sources)
  }],
  "encode": {"crf": 18, "preset": "slow", "max_bytes": 33554432, "sound": false}}
The made file is the source's own pixels, cut to the kept stretches and encoded once for the web (H.264, yuv420p, moov
first); nothing is drawn on it and no frame is invented. Sound is left out unless encode.sound is true (then AAC): a
voice is a person too, and the consent check looks at pictures only. It must fit one Files piece (max_bytes).
A plan clip whose source bytes do not match its identity is refused.

Prints one JSON line per clip: {piece, identity, bytes, files_name, place} where place is the input of
workflow:place-each-allowed-clip-where-the-site-reads-it (identity, material, value, stills, extra; the store is the
caller's), then a last {"result": ...}.
"""
import argparse
import json
import os
import subprocess
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import files_road  # noqa: E402

ENCODE = {"crf": 18, "preset": "slow", "max_bytes": files_road.MAX_PIECE, "sound": False}


def has_sound(path):
    out = subprocess.run(["ffprobe", "-v", "error", "-select_streams", "a", "-show_entries", "stream=index", "-of", "csv=p=0", path],
                         capture_output=True, text=True).stdout
    return bool(out.strip())


def cut_filter(stretches, sound):
    """The filter graph that keeps the stretches in order, picture and (when the source has it) sound together."""
    parts, labels = [], []
    for i, (start, end) in enumerate(stretches):
        if not end > start >= 0:
            raise ValueError(f"stretch {i} must run forward from 0 or later: {start}..{end}")
        parts.append(f"[0:v]trim=start={start}:end={end},setpts=PTS-STARTPTS[v{i}]")
        labels.append(f"[v{i}]")
        if sound:
            parts.append(f"[0:a]atrim=start={start}:end={end},asetpts=PTS-STARTPTS[a{i}]")
            labels.append(f"[a{i}]")
    joined = f"concat=n={len(stretches)}:v=1:a={1 if sound else 0}[v]" + ("[a]" if sound else "")
    return ";".join(parts) + ";" + "".join(labels) + joined


def encode_args(stretches, encode, sound):
    picture = ["-c:v", "libx264", "-preset", str(encode["preset"]), "-crf", str(encode["crf"]), "-pix_fmt", "yuv420p"]
    sound_args = ["-c:a", "aac", "-b:a", "160k"] if sound else ["-an"]
    if stretches:
        maps = ["-map", "[v]"] + (["-map", "[a]"] if sound else [])
        return ["-filter_complex", cut_filter(stretches, sound)] + maps + picture + sound_args
    return ["-map", "0:v:0"] + (["-map", "0:a:0"] if sound else []) + picture + sound_args


def refuse_uncited(clip):
    """Every element the site shows cites why it is there: the clip (extra.why) and each still (its why)."""
    if not str(clip["extra"].get("why", "")).strip():
        raise ValueError(f"{clip['piece']}: extra.why is missing")
    for name, still in clip["stills"].items():
        if not str(still.get("why", "")).strip():
            raise ValueError(f"{clip['piece']}: still {name} has no why")


def place_input(clip, identity):
    """The place workflow's input for the made file: its consent value names the material the fence reads."""
    material = f"recording/{identity}"
    return {"identity": identity, "material": material, "value": {"material": material, "piece": clip["piece"]},
            "stills": clip["stills"], "extra": clip["extra"]}


def make(clip, work, call, encode):
    refuse_uncited(clip)
    source = clip["source"]
    local = source.get("local")
    if not local:
        local = files_road.fetch(call, source["identity"], os.path.join(work, source["identity"][3:] + ".source"))
    elif files_road.blake3_identity(local) != source["identity"]:
        raise RuntimeError(f"{clip['piece']}: the bytes at {local} are not {source['identity']}")
    out = os.path.join(work, clip["piece"].split(":")[-1] + ".mp4")
    subprocess.run(["ffmpeg", "-v", "error", "-y", "-i", local] + encode_args(clip.get("keep"), encode, bool(encode["sound"]) and has_sound(local))
                   + ["-movflags", "+faststart", out], check=True)
    size = os.path.getsize(out)
    if size > encode["max_bytes"]:
        raise RuntimeError(f"{clip['piece']}: {size} bytes is more than one Files piece ({encode['max_bytes']})")
    identity = files_road.keep(call, out, clip["files_name"], "video/mp4")
    if not identity:
        raise RuntimeError(f"{clip['piece']}: Files did not keep {clip['files_name']}")
    return {"piece": clip["piece"], "identity": identity, "bytes": size, "local": out, "files_name": clip["files_name"],
            "place": place_input(clip, identity)}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--plan", required=True)
    ap.add_argument("--work", required=True)
    ap.add_argument("--call", nargs="+", required=True, help="the engine command up to its method")
    a = ap.parse_args()
    plan = json.load(open(a.plan))
    encode = dict(ENCODE, **plan.get("encode", {}))
    os.makedirs(a.work, exist_ok=True)
    made = []
    for clip in plan["clips"]:
        made.append(make(clip, a.work, a.call, encode))
        print(json.dumps(made[-1]), flush=True)
    print(json.dumps({"result": {"made": len(made)}}))
    return 0


if __name__ == "__main__":
    sys.exit(main())
