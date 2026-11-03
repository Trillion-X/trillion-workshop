"""Make a vector set of what a folder of videos shows: one frame every few seconds, with its time, as a picture vector.

  make_picture_vector_set.py --videos DIR --out DIR [--pattern GLOB] [--every SECONDS] [--lut FILE.cube]
                             [--proxy PATTERN] [--threads N] [--model NAME --pretrained TAG]

Writes, in --out, the two files of a vector set that tool:find-similar-to-a-vector reads (see the README):
  frames.npy    float16, one L2-normalised row per frame
  frames.jsonl  one line per row: `video` (its name under --videos), `path` (the video), `t` (seconds), `decoded` (the file read)
  done.json     the videos finished, so a run that stops can be run again and goes on where it stopped
  vector-set.json  the `vector_set` member for the person's semantic-index-descriptor record, and the model that made the vectors

The default model is open_clip ViT-B-32 with the openai weights, the model tool:words-as-picture-vector turns words into
vectors with, so the two compare. It decodes key frames only, small (398x224), and keeps one every --every seconds (2).
--lut applies a 3D LUT (for log footage) before the model sees the frame. --proxy names a smaller copy of each video on the
same timeline to decode instead, as a pattern with {dir} (the video's folder) and {stem} (its name without extension), for
example '{dir}/../SUB/{stem}S03.MP4' for a camera that writes proxies beside its clips; results still name the original.
The videos are only read. Needs ffmpeg, numpy and, for the model, torch, open_clip_torch and Pillow.
"""
import argparse
import glob
import json
import os
import re
import subprocess
import threading

import numpy as np

W, H = 398, 224  # 16:9 at the model's short side
BATCH = 64


def frames(path, every, lut=None):
    """(seconds, RGB array H x W x 3) for one frame every `every` seconds, decoding key frames only."""
    vf = f"select='isnan(prev_selected_t)+gte(t-prev_selected_t\\,{every - 0.05})',scale={W}:{H}:flags=fast_bilinear"
    if lut:
        vf += f",lut3d='{lut}'"
    vf += ",showinfo"
    p = subprocess.Popen(["ffmpeg", "-nostdin", "-hide_banner", "-threads", "2", "-skip_frame", "nokey", "-i", path,
                          "-an", "-vf", vf, "-fps_mode", "vfr", "-f", "rawvideo", "-pix_fmt", "rgb24", "pipe:1"],
                         stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    times, err = [], []

    def read_err():
        for line in p.stderr:
            m = re.search(rb"pts_time:\s*([\d.]+)", line)
            if m:
                times.append(float(m.group(1)))
            elif b"rror" in line:
                err.append(line.decode(errors="replace").strip())

    t = threading.Thread(target=read_err)
    t.start()
    size, i = W * H * 3, 0
    while True:
        buf = p.stdout.read(size)
        if len(buf) < size:
            break
        while len(times) <= i and t.is_alive():
            t.join(0.01)
        yield (times[i] if i < len(times) else i * every), np.frombuffer(buf, np.uint8).reshape(H, W, 3)
        i += 1
    p.wait()
    t.join()
    if p.returncode:
        raise RuntimeError(f"ffmpeg {p.returncode} on {path}: {err[-3:]}")


def decoded_file(path, proxy):
    if not proxy:
        return path
    stem = os.path.splitext(os.path.basename(path))[0]
    candidate = os.path.normpath(proxy.format(dir=os.path.dirname(path), stem=stem))
    return candidate if os.path.exists(candidate) else path


def build(videos, out, embed, every=2.0, lut=None, proxy=None, pattern="*", model="", log=print):
    """Add every video under `videos` matching `pattern` and not yet in done.json to the set in `out`.

    `embed(list of RGB arrays) -> array (n, d)` is the picture model; rows are normalised and kept as float16.
    """
    os.makedirs(out, exist_ok=True)
    done_path = os.path.join(out, "done.json")
    vec_path, rows_path = os.path.join(out, "frames.npy"), os.path.join(out, "frames.jsonl")
    done = set(json.load(open(done_path))) if os.path.exists(done_path) else set()
    vectors = [np.load(vec_path)] if os.path.exists(vec_path) else []
    all_rows = [json.loads(line) for line in open(rows_path)] if os.path.exists(rows_path) else []
    if sum(len(v) for v in vectors) != len(all_rows):
        raise SystemExit(f"{vec_path} and {rows_path} disagree on how many frames there are; nothing was added")
    paths = sorted(p for p in glob.glob(os.path.join(videos, pattern)) if os.path.isfile(p))
    added = 0
    for n, path in enumerate(paths, 1):
        name = os.path.relpath(path, videos)
        if name in done:
            continue
        decode = decoded_file(path, proxy)
        rows, batch, got = [], [], []

        def flush():
            if batch:
                v = np.asarray(embed(batch), dtype=np.float32)
                got.append((v / np.linalg.norm(v, axis=1, keepdims=True)).astype(np.float16))
                batch.clear()

        for sec, rgb in frames(decode, every, lut):
            batch.append(rgb)
            rows.append({"video": name, "path": os.path.abspath(path), "t": round(sec, 3), "decoded": os.path.abspath(decode)})
            if len(batch) == BATCH:
                flush()
        flush()
        if got:
            vectors.append(np.concatenate(got))
            all_rows.extend(rows)
            np.save(vec_path + ".tmp.npy", np.concatenate(vectors))
            with open(rows_path + ".tmp", "w") as f:
                f.write("".join(json.dumps(r) + "\n" for r in all_rows))
            os.replace(vec_path + ".tmp.npy", vec_path)
            os.replace(rows_path + ".tmp", rows_path)
        done.add(name)
        with open(done_path, "w") as f:
            json.dump(sorted(done), f)
        added += len(rows)
        log(f"{n}/{len(paths)} {name} {len(rows)} frames")
    with open(os.path.join(out, "vector-set.json"), "w") as f:
        json.dump({"vector_set": {"items": {"file": rows_path}, "vectors": {"file": vec_path},
                                  "points_to": {"file": "path", "start": "t"}},
                   "model": model, "every_seconds": every, "frames": len(all_rows)}, f, indent=1)
    return {"frames": len(all_rows), "added": added, "videos_done": len(done), "out": out}


def open_clip_embedder(model_name, pretrained, threads):
    import open_clip
    import torch
    from PIL import Image

    torch.set_num_threads(threads)
    model, _, preprocess = open_clip.create_model_and_transforms(model_name, pretrained=pretrained)
    model.eval()

    def embed(rgbs):
        with torch.no_grad():
            return model.encode_image(torch.stack([preprocess(Image.fromarray(rgb)) for rgb in rgbs])).float().numpy()
    return embed


if __name__ == "__main__":
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--videos", required=True, help="the folder of videos (only read)")
    ap.add_argument("--out", required=True, help="the folder of the vector set; run again to add new videos")
    ap.add_argument("--pattern", default="*", help="which files in --videos (default every file)")
    ap.add_argument("--every", type=float, default=2.0, help="seconds between kept frames (default 2)")
    ap.add_argument("--lut", help="a 3D LUT (.cube) applied before the model sees a frame")
    ap.add_argument("--proxy", help="a smaller copy on the same timeline to decode instead: {dir} and {stem} are filled in")
    ap.add_argument("--threads", type=int, default=2, help="torch threads (default 2)")
    ap.add_argument("--model", default="ViT-B-32")
    ap.add_argument("--pretrained", default="openai")
    a = ap.parse_args()
    embed = open_clip_embedder(a.model, a.pretrained, a.threads)
    result = build(a.videos, a.out, embed, a.every, a.lut, a.proxy, a.pattern, f"open_clip {a.model} {a.pretrained}",
                   log=lambda line: print(line, flush=True))
    print(json.dumps({"result": result}))
