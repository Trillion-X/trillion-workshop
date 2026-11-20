#!/usr/bin/env python3
"""Embed video frames with a CLIP-family model, one shot, DATA-parameterized.

Ported from architect-societies/intake-desktop's
backfill_visual_embeddings_shot_based.py (shot-boundary + long-shot + uniform
keyframe sampling, CLIP image embedding, sequential cosine dedup) and
worker_semantic_search.py (CLIP text embedding, kept here only as the
`embed_text` command so the SAME checkpoint that indexed the frames can also
encode a query string for local/manual verification).

Every model name, pretrained checkpoint, sampling policy, and threshold is a
field on the request JSON (the process-descriptor payload) -- never a Python
constant. This script has no persistent worker loop: one invocation, one
JSON request in, one JSON result out (stdout), matching every other
media-analysis analysis-command convention (see
things-to-store-and-run.json's `analysis_command.process_descriptor`).

Output shape: `{"embeddings": [...]}` where each item is consumed directly by
the ALREADY-EXISTING generic `embedding_record()` materializer in
make-media-analysis-records-from-command-output.py -- zero new engine code,
zero new package.
"""

from __future__ import annotations

import argparse
import base64
import json
import sys
from pathlib import Path
from typing import Any


DEFAULT_MODEL_NAME = "ViT-B-32"
DEFAULT_MODEL_PRETRAINED = "openai"
DEFAULT_SHOT_THRESHOLD = 30.0
DEFAULT_UNIFORM_INTERVAL_SECONDS = 10.0
DEFAULT_LONG_SHOT_THRESHOLD_SECONDS = 30.0
DEFAULT_DEDUP_SIMILARITY_THRESHOLD = 0.95


def read_json(path: str) -> dict[str, Any]:
    with open(path, "r", encoding="utf-8") as handle:
        value = json.load(handle)
    if not isinstance(value, dict):
        raise ValueError("JSON input must be an object")
    return value


def write_json(path: str, value: dict[str, Any]) -> None:
    Path(path).parent.mkdir(parents=True, exist_ok=True)
    with open(path, "w", encoding="utf-8") as handle:
        json.dump(value, handle, ensure_ascii=False, separators=(",", ":"))


def object_or_default(value: Any, default: dict[str, Any]) -> dict[str, Any]:
    return value if isinstance(value, dict) else default


def load_clip(model_name: str, pretrained: str, device: str):
    import open_clip
    import torch

    resolved_device = device or ("mps" if torch.backends.mps.is_available() else "cpu")
    model, _, preprocess = open_clip.create_model_and_transforms(
        model_name, pretrained=pretrained, device=resolved_device
    )
    model.eval()
    tokenizer = open_clip.get_tokenizer(model_name)
    return model, preprocess, tokenizer, resolved_device


def embed_text(model, tokenizer, device, text: str):
    import torch

    tokens = tokenizer([text]).to(device)
    with torch.no_grad():
        embedding = model.encode_text(tokens)
    vector = embedding.cpu().numpy().flatten()
    norm = float((vector**2).sum() ** 0.5) or 1.0
    return (vector / norm).astype("float32")


def detect_shots(video_path: str, shot_threshold: float) -> list[tuple[float, float]]:
    """Returns a list of (start_seconds, end_seconds) shots, or [] if none found."""
    from scenedetect import open_video, SceneManager
    from scenedetect.detectors import ContentDetector

    video = open_video(video_path)
    scene_manager = SceneManager()
    scene_manager.add_detector(ContentDetector(threshold=shot_threshold))
    scene_manager.detect_scenes(video=video)
    scene_list = scene_manager.get_scene_list()
    return [
        (start.get_seconds(), end.get_seconds()) for start, end in scene_list
    ]


def video_duration_seconds(video_path: str) -> float:
    import cv2

    capture = cv2.VideoCapture(video_path)
    try:
        fps = capture.get(cv2.CAP_PROP_FPS) or 0.0
        frame_count = capture.get(cv2.CAP_PROP_FRAME_COUNT) or 0.0
        return float(frame_count / fps) if fps > 0 else 0.0
    finally:
        capture.release()


def sample_keyframes_hybrid(
    video_path: str,
    shot_threshold: float,
    long_shot_threshold_seconds: float,
    uniform_interval_seconds: float,
) -> list[dict[str, Any]]:
    """Each sample: {"timestamp": float, "sampling": {"method": str, "shot_id": int|None}}."""
    shots = detect_shots(video_path, shot_threshold)
    samples: list[dict[str, Any]] = []

    if shots:
        for shot_id, (start, end) in enumerate(shots):
            mid = start + (end - start) / 2.0
            samples.append(
                {"timestamp": mid, "sampling": {"method": "shot_boundary", "shot_id": shot_id}}
            )
            duration = end - start
            if duration > long_shot_threshold_seconds:
                cursor = start + uniform_interval_seconds
                while cursor < end:
                    samples.append(
                        {
                            "timestamp": cursor,
                            "sampling": {"method": "long_shot_sample", "shot_id": shot_id},
                        }
                    )
                    cursor += uniform_interval_seconds
    else:
        duration = video_duration_seconds(video_path)
        cursor = 0.0
        while cursor < duration:
            samples.append(
                {"timestamp": cursor, "sampling": {"method": "uniform", "shot_id": None}}
            )
            cursor += uniform_interval_seconds

    samples.sort(key=lambda item: item["timestamp"])
    return samples


def read_frame_at(video_path: str, timestamp_seconds: float):
    import cv2
    from PIL import Image

    capture = cv2.VideoCapture(video_path)
    try:
        capture.set(cv2.CAP_PROP_POS_MSEC, timestamp_seconds * 1000.0)
        ok, frame = capture.read()
        if not ok or frame is None:
            return None
        rgb = cv2.cvtColor(frame, cv2.COLOR_BGR2RGB)
        return Image.fromarray(rgb)
    finally:
        capture.release()


def embed_frames(model, preprocess, device, video_path: str, samples: list[dict[str, Any]]):
    import torch

    vectors: list[Any] = []
    kept_samples: list[dict[str, Any]] = []
    for sample in samples:
        image = read_frame_at(video_path, sample["timestamp"])
        if image is None:
            continue
        tensor = preprocess(image).unsqueeze(0).to(device)
        with torch.no_grad():
            embedding = model.encode_image(tensor)
        vector = embedding.cpu().numpy().flatten()
        norm = float((vector**2).sum() ** 0.5) or 1.0
        vectors.append((vector / norm).astype("float32"))
        # Keep a small copy of the frame alongside the vector so it survives
        # dedup (dedup filters whole samples) and can be tiled into the preview
        # sheet after dedup — full frames are not retained (memory).
        sample = dict(sample)
        thumb = image.copy().convert("RGB")
        if thumb.size[0] > 240:
            thumb = thumb.resize((240, max(1, int(round(thumb.size[1] * (240 / float(thumb.size[0])))))))
        sample["_preview_thumb"] = thumb
        kept_samples.append(sample)
    return vectors, kept_samples


def cosine_similarity(a, b) -> float:
    import numpy as np

    return float(np.dot(a, b) / ((np.linalg.norm(a) * np.linalg.norm(b)) or 1.0))


def deduplicate_keyframes(vectors, samples, similarity_threshold: float):
    """Sequential dedup against the LAST kept frame, matching the intake-desktop original."""
    kept_vectors: list[Any] = []
    kept_samples: list[dict[str, Any]] = []
    for vector, sample in zip(vectors, samples):
        if kept_vectors and cosine_similarity(kept_vectors[-1], vector) >= similarity_threshold:
            continue
        kept_vectors.append(vector)
        kept_samples.append(sample)
    return kept_vectors, kept_samples


def vector_to_artifact_ref(vector, dtype: str = "float32") -> dict[str, Any]:
    """Opaque object per the embedding contract's `vector_contract` clause --
    the vector bytes travel as base64 inline here."""
    raw = vector.astype("float32").tobytes()
    return {
        "bytes_base64": base64.b64encode(raw).decode("ascii"),
        "dim": int(vector.shape[0]),
        "dtype": dtype,
    }


def build_preview_sheet(
    images: list[Any],
    sheet_path: str,
    tile_width: int = 240,
    jpeg_quality: int = 62,
    max_dimension: int = 65000,
) -> list[dict[str, Any]]:
    """Tile every kept frame into ONE JPEG sprite sheet written to `sheet_path`
    (the storyboard pattern). Preview BYTES live in that single declared
    process output (staged to CAS by the engine per the package contract:
    "Thumbnail bytes live in artifact_ref, not inline package records") --
    records carry only a tiny region descriptor. Returns one
    {"x","y","width","height"} region per input image, in order. Column count
    respects the JPEG dimension ceiling so arbitrarily long videos still fit
    one sheet."""
    if not images:
        return []
    thumbs = []
    for image in images:
        thumb = image.copy().convert("RGB")
        width, height = thumb.size
        if width > tile_width:
            new_height = max(1, int(round(height * (tile_width / float(width)))))
            thumb = thumb.resize((tile_width, new_height))
        thumbs.append(thumb)
    tile_height = max(t.size[1] for t in thumbs)
    max_rows = max(1, max_dimension // tile_height)
    columns = (len(thumbs) + max_rows - 1) // max_rows
    rows = (len(thumbs) + columns - 1) // columns

    from PIL import Image

    sheet = Image.new("RGB", (columns * tile_width, rows * tile_height), (0, 0, 0))
    regions: list[dict[str, Any]] = []
    sheet_size = {"sheet_width": sheet.size[0], "sheet_height": sheet.size[1]}
    for index, thumb in enumerate(thumbs):
        x = (index % columns) * tile_width
        y = (index // columns) * tile_height
        sheet.paste(thumb, (x, y))
        # Self-describing region (L090): carries its own sheet dimensions so a
        # blind renderer can crop with pure CSS-sprite math, no second fetch.
        regions.append({"x": x, "y": y, "width": thumb.size[0], "height": thumb.size[1], **sheet_size})
    Path(sheet_path).parent.mkdir(parents=True, exist_ok=True)
    sheet.save(sheet_path, format="JPEG", quality=jpeg_quality)
    return regions


def build_embeddings(request: dict[str, Any]) -> dict[str, Any]:
    # Read video source: try source.artifact_ref.cas_address first, then .multihash
    source = object_or_default(request.get("source"), {})
    artifact_ref = object_or_default(source.get("artifact_ref"), {})
    video_path = str(artifact_ref.get("cas_address") or artifact_ref.get("multihash") or "")

    # Fallback to options.video_path for backward compatibility
    if not video_path:
        options_fallback = object_or_default(request.get("options"), {})
        video_path = str(options_fallback.get("video_path") or request.get("video_path") or "")

    if not video_path:
        return {"embeddings": [], "errors": [{"code": "missing_video_path", "message": "source.artifact_ref.cas_address or .multihash is required"}]}

    options = object_or_default(request.get("options"), {})
    model_config = object_or_default(options.get("model"), {})
    model_name = str(model_config.get("name") or DEFAULT_MODEL_NAME)
    model_pretrained = str(model_config.get("pretrained") or DEFAULT_MODEL_PRETRAINED)
    device = str(model_config.get("device") or "")

    shot_threshold = float(options.get("shot_threshold", DEFAULT_SHOT_THRESHOLD))
    uniform_interval_seconds = float(
        options.get("uniform_interval_seconds", DEFAULT_UNIFORM_INTERVAL_SECONDS)
    )
    long_shot_threshold_seconds = float(
        options.get("long_shot_threshold_seconds", DEFAULT_LONG_SHOT_THRESHOLD_SECONDS)
    )
    dedup_similarity_threshold = float(
        options.get("dedup_similarity_threshold", DEFAULT_DEDUP_SIMILARITY_THRESHOLD)
    )
    asset_id = str(options.get("asset_id") or request.get("request_id") or video_path)

    model, preprocess, _tokenizer, resolved_device = load_clip(model_name, model_pretrained, device)

    samples = sample_keyframes_hybrid(
        video_path, shot_threshold, long_shot_threshold_seconds, uniform_interval_seconds
    )
    vectors, samples = embed_frames(model, preprocess, resolved_device, video_path, samples)
    vectors, samples = deduplicate_keyframes(vectors, samples, dedup_similarity_threshold)

    model_descriptor = {"name": model_name, "pretrained": model_pretrained, "device": resolved_device}

    # Preview sheet (storyboard pattern): tile every kept frame into ONE JPEG
    # written to the caller-declared process output. Bytes go to CAS via the
    # engine's addressed_chunks staging (package contract: "Thumbnail bytes
    # live in artifact_ref, not inline package records"); each embedding
    # carries only its tiny sheet region.
    preview_sheet_path = str(options.get("preview_sheet_path") or "")
    regions: list[dict[str, Any]] = []
    if preview_sheet_path:
        regions = build_preview_sheet(
            [sample.get("_preview_thumb") for sample in samples if sample.get("_preview_thumb") is not None],
            preview_sheet_path,
        )

    embeddings = []
    for index, (vector, sample) in enumerate(zip(vectors, samples)):
        item: dict[str, Any] = {
            "embedding_id": f"{asset_id}:frame:{index}",
            "asset_id": asset_id,
            "modality": "video-frame",
            "model": model_descriptor,
            "time_range": {"timestamp": sample["timestamp"]},
            "sampling": sample["sampling"],
            "vector_artifact_ref": vector_to_artifact_ref(vector),
            # Self-describing preview (L090): the sheet region + time offset let a
            # blind grid render a real thumbnail and deep-link to this moment.
            "time_offset_seconds": float(sample.get("timestamp") or 0.0),
        }
        if index < len(regions):
            item["preview_sheet_mount_path"] = preview_sheet_path
            item["preview_region"] = regions[index]
        embeddings.append(item)

    return {"embeddings": embeddings, "summary": {"frame_count": len(embeddings), "model": model_descriptor, "preview_sheet_mount_path": preview_sheet_path}}


def handle_embed_text_command(request: dict[str, Any]) -> dict[str, Any]:
    """Optional query-side helper: encode a text string with the SAME
    checkpoint, for local verification without going through meaning-search.
    Not part of the embeddings-materializer contract."""
    options = object_or_default(request.get("options"), {})
    text = str(options.get("text") or "")
    model_config = object_or_default(options.get("model"), {})
    model_name = str(model_config.get("name") or DEFAULT_MODEL_NAME)
    model_pretrained = str(model_config.get("pretrained") or DEFAULT_MODEL_PRETRAINED)
    device = str(model_config.get("device") or "")

    model, _preprocess, tokenizer, resolved_device = load_clip(model_name, model_pretrained, device)
    vector = embed_text(model, tokenizer, resolved_device, text)
    return {
        "embeddings": [],
        "vector_artifact_ref": vector_to_artifact_ref(vector),
        "model": {"name": model_name, "pretrained": model_pretrained, "device": resolved_device},
    }


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--request-json", required=True)
    parser.add_argument("--output-json", required=False, default=None)
    args = parser.parse_args()

    request = read_json(args.request_json)
    command = str(request.get("command") or "embed-frames")

    try:
        if command == "embed-text":
            result = handle_embed_text_command(request)
        else:
            result = build_embeddings(request)
    except Exception as exc:  # pragma: no cover - keeps output JSON-shaped on crash
        result = {"embeddings": [], "errors": [{"code": "embed_video_frames_clip_crash", "message": str(exc)}]}
        print(str(exc), file=sys.stderr)

    if args.output_json:
        write_json(args.output_json, result)
    else:
        print(json.dumps(result, separators=(",", ":")))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
