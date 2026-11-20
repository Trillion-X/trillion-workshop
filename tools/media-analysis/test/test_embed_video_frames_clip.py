"""Colocated test for embed-video-frames-clip.py.

Uses mock vectors/samples so the test runs with zero model download and zero
GPU/video dependency -- it verifies the DATA-parameterization, dedup, and
output-shape contract, not the model weights themselves.
"""

import importlib.util
import sys
from pathlib import Path

import numpy as np

MODULE_PATH = Path(__file__).resolve().parent.parent / "do-work" / "embed-video-frames-clip.py"
spec = importlib.util.spec_from_file_location("embed_video_frames_clip", MODULE_PATH)
module = importlib.util.module_from_spec(spec)
sys.modules["embed_video_frames_clip"] = module
spec.loader.exec_module(module)


def test_sample_keyframes_hybrid_uses_data_interval(monkeypatch):
    monkeypatch.setattr(module, "detect_shots", lambda video_path, threshold: [])
    monkeypatch.setattr(module, "video_duration_seconds", lambda video_path: 25.0)

    samples = module.sample_keyframes_hybrid(
        "fake.mp4",
        shot_threshold=30.0,
        long_shot_threshold_seconds=30.0,
        uniform_interval_seconds=10.0,
    )

    timestamps = [s["timestamp"] for s in samples]
    assert timestamps == [0.0, 10.0, 20.0]
    assert all(s["sampling"]["method"] == "uniform" for s in samples)


def test_sample_keyframes_hybrid_long_shot_adds_extra_samples(monkeypatch):
    monkeypatch.setattr(module, "detect_shots", lambda video_path, threshold: [(0.0, 60.0)])

    samples = module.sample_keyframes_hybrid(
        "fake.mp4",
        shot_threshold=30.0,
        long_shot_threshold_seconds=30.0,
        uniform_interval_seconds=10.0,
    )

    methods = {s["sampling"]["method"] for s in samples}
    assert "shot_boundary" in methods
    assert "long_shot_sample" in methods
    assert all(s["sampling"]["shot_id"] == 0 for s in samples)


def test_deduplicate_keyframes_drops_near_identical_sequential_frames():
    base = np.array([1.0, 0.0, 0.0], dtype="float32")
    near_dup = np.array([0.999, 0.001, 0.0], dtype="float32")
    distinct = np.array([0.0, 1.0, 0.0], dtype="float32")

    vectors = [base, near_dup, distinct]
    samples = [
        {"timestamp": 0.0, "sampling": {"method": "uniform", "shot_id": None}},
        {"timestamp": 10.0, "sampling": {"method": "uniform", "shot_id": None}},
        {"timestamp": 20.0, "sampling": {"method": "uniform", "shot_id": None}},
    ]

    kept_vectors, kept_samples = module.deduplicate_keyframes(
        vectors, samples, similarity_threshold=0.95
    )

    assert len(kept_vectors) == 2
    assert [s["timestamp"] for s in kept_samples] == [0.0, 20.0]


def test_vector_to_artifact_ref_is_opaque_object_with_dimensions():
    vector = np.array([1.0, 2.0, 3.0], dtype="float32")
    ref = module.vector_to_artifact_ref(vector)

    assert isinstance(ref, dict)
    assert ref["dim"] == 3
    assert ref["dtype"] == "float32"
    assert isinstance(ref["bytes_base64"], str) and len(ref["bytes_base64"]) > 0


def test_build_embeddings_emits_contract_shaped_items(monkeypatch):
    def fake_load_clip(model_name, pretrained, device):
        return object(), object(), object(), "cpu"

    def fake_sample_keyframes_hybrid(video_path, shot_threshold, long_shot_threshold_seconds, uniform_interval_seconds):
        return [
            {"timestamp": 0.0, "sampling": {"method": "uniform", "shot_id": None}},
            {"timestamp": 10.0, "sampling": {"method": "uniform", "shot_id": None}},
        ]

    def fake_embed_frames(model, preprocess, device, video_path, samples):
        vectors = [np.array([1.0, 0.0], dtype="float32"), np.array([0.0, 1.0], dtype="float32")]
        return vectors, samples

    def fake_deduplicate_keyframes(vectors, samples, threshold):
        return vectors, samples

    monkeypatch.setattr(module, "load_clip", fake_load_clip)
    monkeypatch.setattr(module, "sample_keyframes_hybrid", fake_sample_keyframes_hybrid)
    monkeypatch.setattr(module, "embed_frames", fake_embed_frames)
    monkeypatch.setattr(module, "deduplicate_keyframes", fake_deduplicate_keyframes)

    request = {
        "request_id": "req-1",
        "options": {
            "video_path": "/tmp/fake.mp4",
            "asset_id": "asset-red-car",
            "model": {"name": "ViT-B-32", "pretrained": "openai"},
            "shot_threshold": 30.0,
            "uniform_interval_seconds": 10.0,
            "long_shot_threshold_seconds": 30.0,
            "dedup_similarity_threshold": 0.95,
        },
    }

    result = module.build_embeddings(request)

    assert "embeddings" in result
    assert len(result["embeddings"]) == 2
    for item in result["embeddings"]:
        assert item["asset_id"] == "asset-red-car"
        assert item["modality"] == "video-frame"
        assert item["model"] == {"name": "ViT-B-32", "pretrained": "openai", "device": "cpu"}
        assert "timestamp" in item["time_range"]
        assert "method" in item["sampling"]
        assert isinstance(item["vector_artifact_ref"], dict)
        assert "bytes_base64" in item["vector_artifact_ref"]


def test_build_embeddings_missing_video_path_returns_error_not_crash():
    result = module.build_embeddings({"options": {}})
    assert result["embeddings"] == []
    assert result["errors"][0]["code"] == "missing_video_path"
