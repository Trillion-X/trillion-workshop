#!/usr/bin/env python3
"""Find recurring voices in Trillion media with a pinned CAM++ model.

Signed namespace URLs are supplied by Workshop through stdin. This model finds
candidate voice matches; a separate explicit record gives a voice a person's name.
"""

from __future__ import annotations

import json
import re
import subprocess
import sys
from urllib.parse import urlparse

import blake3
import kaldi_native_fbank as knf
import numpy as np
import onnxruntime as ort
import webrtcvad


MODEL = "/opt/models/campplus-voice/campplus_cn_en_common_200k.onnx"
RATE = 16000
FRAME = 480  # 30 ms
FILE_ID = re.compile(r"/namespace/bytes/((?:1f|12):[0-9a-f]{64})(?:$|/)")


def identity_of(file: object) -> str:
    url = file.get("url") if isinstance(file, dict) else file
    if not isinstance(url, str):
        raise ValueError("A media input has no readable file address.")
    match = FILE_ID.search(urlparse(url).path)
    if not match:
        raise ValueError("A media input did not resolve to a Trillion file address.")
    return match.group(1)


def value_of(record: object) -> dict:
    if not isinstance(record, dict):
        return {}
    for key in ("value", "payload"):
        if isinstance(record.get(key), dict):
            return record[key]
    return record


def unit(values: object) -> np.ndarray | None:
    try:
        vector = np.asarray(values, dtype=np.float32)
        if vector.shape != (192,) or not np.isfinite(vector).all():
            return None
        norm = float(np.linalg.norm(vector))
        return vector / norm if norm > 0 else None
    except (TypeError, ValueError):
        return None


def audio_from(url: str, seconds: int) -> np.ndarray:
    command = ["ffmpeg", "-hide_banner", "-loglevel", "error", "-i", url, "-vn", "-ac", "1", "-ar", str(RATE), "-t", str(seconds), "-f", "s16le", "pipe:1"]
    run = subprocess.run(command, capture_output=True, timeout=max(90, seconds * 2), check=False)
    if run.returncode:
        raise ValueError(f"Could not read this file's sound: {run.stderr.decode(errors='replace')[-250:]}")
    return np.frombuffer(run.stdout, dtype="<i2")


def speech_windows(audio: np.ndarray, limit: int = 500) -> list[tuple[int, int]]:
    vad = webrtcvad.Vad(2)
    flags = [vad.is_speech(audio[at:at + FRAME].tobytes(), RATE)
             for at in range(0, len(audio) - FRAME + 1, FRAME)]
    windows, first, last = [], None, None
    for index, active in enumerate(flags + [False] * 11):
        if active:
            first = index if first is None else first
            last = index
        elif first is not None and index - last > 10:
            start, end = first * FRAME, (last + 1) * FRAME
            while end - start >= RATE * 2 and len(windows) < limit:
                stop = min(start + RATE * 8, end)
                windows.append((start, stop))
                start = stop
            first = last = None
    return windows


def embed(session: ort.InferenceSession, speech: np.ndarray) -> np.ndarray | None:
    options = knf.FbankOptions()
    options.frame_opts.samp_freq = RATE
    options.frame_opts.dither = 0.0
    options.mel_opts.num_bins = 80
    bank = knf.OnlineFbank(options)
    bank.accept_waveform(RATE, speech.astype(np.float32))
    bank.input_finished()
    if bank.num_frames_ready < 100:
        return None
    frames = np.stack([bank.get_frame(i) for i in range(bank.num_frames_ready)]).astype(np.float32)
    frames -= frames.mean(axis=0, keepdims=True)
    result = session.run(None, {session.get_inputs()[0].name: frames[np.newaxis]})[0]
    return unit(result[0])


def group(samples: list[dict], known: list[dict], bindings: list[dict], threshold: float) -> dict:
    names = {row["voice_id"]: row["person_name"] for row in map(value_of, bindings)
             if row.get("voice_id") and row.get("person_name")}
    clusters = {}
    for row in map(value_of, known):
        vector = unit(row.get("embedding"))
        if isinstance(row.get("voice_id"), str) and vector is not None:
            key = row["voice_id"]
            clusters[key] = {"embedding": vector, "prior": max(1, int(row.get("sample_count") or 1)), "new": 0,
                             "files": set(row.get("files") or [])}
    segments = []
    for sample in sorted(samples, key=lambda item: (item["file"], item["from"])):
        vector = unit(sample["embedding"])
        if vector is None:
            continue
        ranked = sorted(((float(np.dot(vector, row["embedding"])), key) for key, row in clusters.items()), reverse=True)
        similarity, key = ranked[0] if ranked else (-1.0, "")
        if similarity < threshold:
            seed = f'{sample["file"]}:{sample["from"]:.2f}'
            key = "voice:" + blake3.blake3(seed.encode()).hexdigest()[:24]
            clusters[key] = {"embedding": vector, "prior": 0, "new": 0, "files": set()}
            similarity = None
        cluster = clusters[key]
        count = cluster["prior"] + cluster["new"]
        centroid = unit(cluster["embedding"] * count + vector)
        cluster["embedding"] = centroid if centroid is not None else vector
        cluster["new"] += 1
        cluster["files"].add(sample["file"])
        segments.append({"file": sample["file"], "from": sample["from"], "to": sample["to"], "voice_id": key,
                         "similarity": round(similarity, 4) if similarity is not None else None,
                         "person_name": names.get(key)})
    visible, records = [], []
    for key, row in sorted(clusters.items()):
        if not row["new"]:
            continue
        visible.append({"voice_id": key, "person_name": names.get(key), "new_segments": row["new"],
                        "files": sorted(row["files"]), "needs_name": key not in names})
        records.append({"kind": "media-voice-cluster", "id": key, "voice_id": key,
                        "embedding": [round(float(x), 7) for x in row["embedding"]],
                        "sample_count": row["prior"] + row["new"], "files": sorted(row["files"])})
    return {"clusters": visible, "segments": segments, "voice_records": records}


def main() -> None:
    request = json.load(sys.stdin)
    urls = request.get("files")
    if not isinstance(urls, list) or not 1 <= len(urls) <= 20:
        raise ValueError("Give between one and twenty audio or video files.")
    seconds = min(3600, max(30, int(request.get("max_seconds_per_file") or 1800)))
    threshold = float(request.get("minimum_similarity") or 0.72)
    if not 0.5 <= threshold <= 0.95:
        raise ValueError("minimum_similarity must be between 0.5 and 0.95.")
    session = ort.InferenceSession(MODEL, providers=["CPUExecutionProvider"])
    samples, errors = [], []
    for file in urls:
        file_id = identity_of(file)
        url = file["url"] if isinstance(file, dict) else file
        try:
            audio = audio_from(url, seconds)
            for first, last in speech_windows(audio):
                vector = embed(session, audio[first:last].astype(np.float32) / 32768.0)
                if vector is not None:
                    samples.append({"file": file_id, "from": round(first / RATE, 2),
                                    "to": round(last / RATE, 2), "embedding": vector.tolist()})
        except (ValueError, subprocess.TimeoutExpired) as exc:
            errors.append({"file": file_id, "reason": str(exc)})
    result = group(samples, request.get("known_voices") or [], request.get("person_bindings") or [], threshold)
    result.update({"files_checked": len(urls), "errors": errors,
                   "method": "CAM++ voice embeddings, speech windows, cosine similarity",
                   "warning": "Voice matches are candidates until a person confirms the name."})
    print(json.dumps(result, separators=(",", ":")))


if __name__ == "__main__":
    main()
