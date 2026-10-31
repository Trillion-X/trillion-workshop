#!/usr/bin/env python3
"""Predict, second by second, how an average viewer's cortex responds to a video.

Runs Meta FAIR's TRIBE v2 (github.com/facebookresearch/tribev2, weights
facebook/tribev2 on Hugging Face, CC-BY-NC-4.0: non-commercial use only) on one
video and writes one per-second response curve with its spikes and flat zones.

One invocation, one JSON request on stdin, one JSON result out (the last stdout line). Every
model name, modality, device and threshold is a request field, never a Python constant:

  {
    "video": "<path to read; never written>",
    "out_dir": "<folder for curve.json, curve.png and the work copy>",
    "model": "facebook/tribev2",
    "modalities": ["video", "audio"],          # add "text" once the gated
                                                # meta-llama/Llama-3.2-3B is granted
    "words_tsv": "<optional transcript: text, start, duration, sequence_id, sentence>",
    "device": "mps" | "cpu" | "cuda",
    "mps_memory_fraction": 0.3,                 # optional cap on Apple GPU memory; without it
                                                # PyTorch's MPS cache grew past 60 GB on a 75 s
                                                # video and pushed the computer into full swap
    "mps_synchronize_after": ["VJEPA2Layer"],    # optional module class names: wait for the GPU
                                                # after each and hand its freed buffers back, so
                                                # they return before the next layer queues (MPS
                                                # runs ahead otherwise and each V-JEPA 2 layer's
                                                # attention holds 5.5 GB)
    "spike_z": 1.0, "flat_z": -0.5, "min_flat_seconds": 3
  }

What the curve is: TRIBE v2 predicts fMRI responses on ~20k cortical vertices
(fsaverage5) for the training subjects' average, once per second, already
shifted back by the 5 s haemodynamic lag the model was trained with, so second t
describes what is on screen at second t. The curve is the mean predicted
response over all vertices, then z-scored over this video. It is a predicted
brain response, not a measured retention or view count: compare cuts of the
same video with it, never videos with each other.

Upstream writes the extracted audio beside the video (and deletes a .wav of the
same name first), so the video is copied into `out_dir` and only the copy is
ever handed to the model.

Why the device is assigned after loading: neuralset's extractor fields only
accept "auto", "cpu", "cuda" (and "accelerate"), and "auto" never picks Apple's
MPS. The device is excluded from neuralset's cache identity, so loading on
"cpu" and then assigning the requested device changes where the encoders run
and nothing else.
"""

from __future__ import annotations

import json
import shutil
import sys
import time
from pathlib import Path
from typing import Any

ENCODER_DEVICE_FIELDS = {
    "text": ("text_feature",),
    "audio": ("audio_feature",),
    "video": ("video_feature", "image"),
}


def response_curve(preds: Any, starts: list[float]) -> list[dict[str, float]]:
    """Per-second mean cortical response, z-scored over the video, ordered by time."""
    import numpy as np

    level = np.asarray(preds, dtype=np.float64).mean(axis=1)
    spread = level.std()
    z = (level - level.mean()) / spread if spread > 0 else np.zeros_like(level)
    order = np.argsort(np.asarray(starts))
    return [
        {"t": round(float(starts[i]), 3), "response": float(level[i]), "z": round(float(z[i]), 4)}
        for i in order
    ]


def spikes(curve: list[dict[str, float]], spike_z: float) -> list[dict[str, float]]:
    """Local maxima of z at or above spike_z, highest first."""
    found = []
    for i, point in enumerate(curve):
        before = curve[i - 1]["z"] if i > 0 else float("-inf")
        after = curve[i + 1]["z"] if i + 1 < len(curve) else float("-inf")
        if point["z"] >= spike_z and point["z"] >= before and point["z"] > after:
            found.append({"t": point["t"], "z": point["z"]})
    return sorted(found, key=lambda spike: -spike["z"])


def flat_zones(curve: list[dict[str, float]], flat_z: float, min_seconds: float) -> list[dict[str, float]]:
    """Runs of consecutive seconds with z at or below flat_z lasting at least min_seconds."""
    zones, run = [], []
    for point in curve + [{"t": float("inf"), "z": float("inf")}]:
        if point["z"] <= flat_z:
            run.append(point)
            continue
        if run:
            start, end = run[0]["t"], run[-1]["t"] + 1.0
            if end - start >= min_seconds:
                zones.append({
                    "start": start,
                    "end": end,
                    "seconds": round(end - start, 3),
                    "mean_z": round(sum(p["z"] for p in run) / len(run), 4),
                })
            run = []
    return zones


def plot(curve: list[dict[str, float]], found_spikes: list[dict[str, float]], zones: list[dict[str, float]],
         title: str, path: Path) -> None:
    import matplotlib

    matplotlib.use("Agg")
    import matplotlib.pyplot as plt

    times = [p["t"] for p in curve]
    values = [p["z"] for p in curve]
    figure, axis = plt.subplots(figsize=(12, 3.6), dpi=150)
    for zone in zones:
        axis.axvspan(zone["start"], zone["end"], color="#9aa3ad", alpha=0.25, linewidth=0)
    axis.plot(times, values, color="#2f6fdf", linewidth=1.6)
    axis.scatter([s["t"] for s in found_spikes], [s["z"] for s in found_spikes], color="#2f6fdf", s=18, zorder=3)
    axis.axhline(0, color="#c8ccd2", linewidth=0.8)
    axis.set_xlabel("seconds")
    axis.set_ylabel("predicted response (z)")
    axis.set_title(title, loc="left", fontsize=10)
    for side in ("top", "right"):
        axis.spines[side].set_visible(False)
    figure.tight_layout()
    figure.savefig(path)
    plt.close(figure)


def run(request: dict[str, Any]) -> dict[str, Any]:
    import pandas as pd
    import torch
    from tribev2.demo_utils import TribeModel, get_audio_and_text_events

    video = Path(request["video"]).resolve()
    out_dir = Path(request["out_dir"]).resolve()
    modalities = list(request["modalities"])
    device = request["device"]
    work_dir = out_dir / "work"
    work_dir.mkdir(parents=True, exist_ok=True)
    work_video = work_dir / video.name
    shutil.copyfile(video, work_video)
    if request.get("words_tsv"):
        shutil.copyfile(request["words_tsv"], work_video.with_suffix(".tsv"))

    if device == "mps" and request.get("mps_memory_fraction") is not None:
        torch.mps.set_per_process_memory_fraction(float(request["mps_memory_fraction"]))
    if device == "mps" and request.get("mps_synchronize_after"):
        settle_after = frozenset(request["mps_synchronize_after"])

        def settle(module: Any, inputs: Any, output: Any) -> None:
            if type(module).__name__ in settle_after:
                torch.mps.synchronize()
                torch.mps.empty_cache()

        torch.nn.modules.module.register_module_forward_hook(settle)
    started = time.monotonic()
    config_update: dict[str, Any] = {"data.features_to_use": modalities}
    for modality in ENCODER_DEVICE_FIELDS:
        config_update[".".join(("data",) + ENCODER_DEVICE_FIELDS[modality] + ("device",))] = "cpu"
    model = TribeModel.from_pretrained(
        request["model"], cache_folder=str(out_dir / "feature-cache"), device=device, config_update=config_update)
    for modality in modalities:
        holder = model.data
        for field in ENCODER_DEVICE_FIELDS[modality]:
            holder = getattr(holder, field)
        holder.device = device
    loaded = time.monotonic()

    events = get_audio_and_text_events(
        pd.DataFrame([{"type": "Video", "filepath": str(work_video), "start": 0,
                       "timeline": "default", "subject": "default"}]),
        audio_only="text" not in modalities,
    )
    preds, segments = model.predict(events=events, verbose=False)
    predicted = time.monotonic()

    curve = response_curve(preds, [float(s.start) for s in segments])
    found_spikes = spikes(curve, float(request["spike_z"]))
    zones = flat_zones(curve, float(request["flat_z"]), float(request["min_flat_seconds"]))
    result = {
        "kind": "predicted-brain-response-curve",
        "video": str(video),
        "model": request["model"],
        "modalities": modalities,
        "missing_modalities_are_zeroed": sorted(set(ENCODER_DEVICE_FIELDS) - set(modalities)),
        "device": device,
        "mps_memory_fraction": request.get("mps_memory_fraction"),
        "mps_synchronize_after": request.get("mps_synchronize_after"),
        "torch": torch.__version__,
        "vertices": int(preds.shape[1]),
        "seconds": {"load": round(loaded - started, 1), "predict": round(predicted - loaded, 1)},
        "thresholds": {k: request[k] for k in ("spike_z", "flat_z", "min_flat_seconds")},
        "what_the_curve_is": "Mean predicted fMRI response over all fsaverage5 cortical vertices for the average training subject, one value per second, lag-corrected to stimulus time, z-scored over this video. A prediction, not measured retention.",
        "curve": curve,
        "spikes": found_spikes,
        "flat_zones": zones,
    }
    (out_dir / "curve.json").write_text(json.dumps(result, indent=1) + "\n", encoding="utf-8")
    plot(curve, found_spikes, zones, f"{video.name}: TRIBE v2 predicted response ({'+'.join(modalities)})",
         out_dir / "curve.png")
    shutil.rmtree(work_dir)
    return {key: value for key, value in result.items() if key != "curve"} | {
        "curve_json": str(out_dir / "curve.json"), "curve_png": str(out_dir / "curve.png")}


if __name__ == "__main__":
    print(json.dumps({"result": run(json.load(sys.stdin))}))
