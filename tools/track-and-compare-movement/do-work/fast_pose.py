"""Read one person's joints from a video, fast: ffmpeg decodes small frames, the pose model reads 16 at a time.

USAGE: fast_pose.py --video IN.mp4 --out TRACK.json --checkpoint POSE_WEIGHTS.pt [--height 720] [--device mps|cpu|cuda]

Writes the same pose.keypoints.v1 track estimate_pose.py writes (keypoints in source pixels), with one person:
the largest body in the first frame with one, then in each frame the body whose box centre is nearest the last one.
About 4x the frame rate of estimate_pose.py on this Mac (26 against 6-8 frames a second, Nov 20 2026), because the
decode is small and the model reads a batch; the tracker runs on the kept points, not inside the model.
The checkpoint is the caller's: this script names no model and downloads none.
Last line: {"result": {...}} or {"error": "..."}.
"""
import argparse, json, subprocess, sys, time

NAMES = ["nose", "l_eye", "r_eye", "l_ear", "r_ear", "l_shoulder", "r_shoulder", "l_elbow", "r_elbow",
         "l_wrist", "r_wrist", "l_hip", "r_hip", "l_knee", "r_knee", "l_ankle", "r_ankle"]
BATCH = 16


def probe(video):
    out = subprocess.run(["ffprobe", "-v", "error", "-select_streams", "v:0", "-show_entries",
                          "stream=width,height,r_frame_rate", "-of", "json", video], capture_output=True, text=True)
    s = json.loads(out.stdout)["streams"][0]
    num, den = map(int, s["r_frame_rate"].split("/"))
    return s["width"], s["height"], num / den


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--video", required=True)
    ap.add_argument("--out", required=True)
    ap.add_argument("--checkpoint", required=True)
    ap.add_argument("--height", type=int, default=720)
    ap.add_argument("--device", default="mps")
    a = ap.parse_args()
    try:
        import numpy as np
        from ultralytics import YOLO
    except Exception as e:
        print(json.dumps({"error": f"numpy and ultralytics are needed: {e}"}))
        return 2
    sw, sh, fps = probe(a.video)
    h = a.height
    w = int(round(sw * h / sh / 2) * 2)
    sx, sy = sw / w, sh / h
    model = YOLO(a.checkpoint)
    dec = subprocess.Popen(["ffmpeg", "-v", "error", "-i", a.video, "-vf", f"scale={w}:{h}", "-f", "rawvideo",
                            "-pix_fmt", "bgr24", "-"], stdout=subprocess.PIPE)
    frames, batch, n, prev = [], [], 0, None
    t0 = time.time()

    def read_batch(images, start):
        nonlocal prev
        for k, r in enumerate(model.predict(images, device=a.device, verbose=False, imgsz=min(1280, max(w, h)))):
            if r.keypoints is None or r.keypoints.data.shape[0] == 0:
                continue
            pts = r.keypoints.data.cpu().numpy()
            boxes = r.boxes.xyxy.cpu().numpy()
            cs = [((b[0] + b[2]) / 2, (b[1] + b[3]) / 2, b[3] - b[1]) for b in boxes]
            if prev is None:
                j = max(range(len(cs)), key=lambda i: cs[i][2])
            else:
                j = min(range(len(cs)), key=lambda i: abs(cs[i][0] - prev[0]) + abs(cs[i][1] - prev[1]) - 0.5 * cs[i][2])
            prev = cs[j]
            frames.append({"t": round((start + k) / fps, 4), "i": start + k,
                           "kp": [[float(x * sx), float(y * sy), float(c)] for x, y, c in pts[j]]})

    while True:
        raw = dec.stdout.read(w * h * 3)
        if not raw:
            break
        batch.append(np.frombuffer(raw, np.uint8).reshape(h, w, 3))
        n += 1
        if len(batch) == BATCH:
            read_batch(batch, n - BATCH)
            batch = []
    if batch:
        read_batch(batch, n - len(batch))
    track = {"schema": "pose.keypoints.v1",
             "engine": {"name": "ultralytics-pose-batched", "checkpoint": a.checkpoint, "decode_height": h},
             "video": {"path": a.video, "fps": fps, "width": sw, "height": sh, "frames": n},
             "keypoint_names": NAMES, "persons": [{"id": 1, "frames": frames}]}
    with open(a.out, "w") as f:
        json.dump(track, f, separators=(",", ":"))
    print(json.dumps({"result": {"out": a.out, "frames": n, "with_person": len(frames),
                                 "frames_per_second_read": round(n / max(time.time() - t0, 1e-6), 1)}}))
    return 0


if __name__ == "__main__":
    sys.exit(main())
