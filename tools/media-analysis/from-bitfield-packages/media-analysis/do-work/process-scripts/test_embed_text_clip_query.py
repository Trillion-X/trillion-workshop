"""Colocated test for embed-text-clip-query.py.

Uses mock model load so the test runs with zero model download and zero GPU
dependency -- it verifies the DATA-parameterization and output-shape contract,
not the model weights themselves.
"""

import importlib.util
import sys
from pathlib import Path

import numpy as np

MODULE_PATH = Path(__file__).parent / "embed-text-clip-query.py"
spec = importlib.util.spec_from_file_location("embed_text_clip_query", MODULE_PATH)
module = importlib.util.module_from_spec(spec)
sys.modules["embed_text_clip_query"] = module
spec.loader.exec_module(module)


def test_embed_text_returns_contract_shaped_vector():
    """Verify that embed_text returns a normalized float32 vector."""
    # Mock model and tokenizer
    class FakeModel:
        pass

    class FakeTensor:
        def to(self, device):
            return self

        def __enter__(self):
            return self

        def __exit__(self, *args):
            pass

    class FakeTokenizer:
        def __call__(self, texts):
            return FakeTensor()

    model = FakeModel()
    tokenizer = FakeTokenizer()

    # Manually inject a mock encode_text method
    def mock_encode_text(tokens):
        class MockOutput:
            def cpu(self):
                return self

            def numpy(self):
                # Return a 512-dim vector (CLIP standard)
                return np.random.randn(1, 512).astype("float32")

        return MockOutput()

    model.encode_text = mock_encode_text

    # Call embed_text
    vector = module.embed_text(model, tokenizer, "cpu", "a red car")

    assert isinstance(vector, np.ndarray)
    assert vector.dtype == np.float32
    assert vector.shape == (512,)
    # Verify L2 normalization
    norm = float(np.linalg.norm(vector))
    assert abs(norm - 1.0) < 1e-5


def test_vector_to_artifact_ref_is_opaque_object_with_dimensions():
    vector = np.array([1.0, 2.0, 3.0], dtype="float32")
    ref = module.vector_to_artifact_ref(vector)

    assert isinstance(ref, dict)
    assert ref["dim"] == 3
    assert ref["dtype"] == "float32"
    assert isinstance(ref["bytes_base64"], str) and len(ref["bytes_base64"]) > 0


def test_encode_query_emits_contract_shaped_response(monkeypatch):
    def fake_load_clip(model_name, pretrained, device):
        class FakeModel:
            pass

        class FakeTokenizer:
            pass

        return FakeModel(), object(), FakeTokenizer(), "cpu"

    def fake_embed_text(model, tokenizer, device, text):
        # Return a deterministic 512-dim normalized vector
        vec = np.array([1.0] * 512, dtype="float32")
        norm = float((vec**2).sum() ** 0.5) or 1.0
        return (vec / norm).astype("float32")

    monkeypatch.setattr(module, "load_clip", fake_load_clip)
    monkeypatch.setattr(module, "embed_text", fake_embed_text)

    request = {
        "options": {
            "text": "a red car in motion",
            "model": {"name": "ViT-B-32", "pretrained": "openai"},
        }
    }

    result = module.encode_query(request)

    assert "vector_artifact_ref" in result
    assert "model" in result
    assert result["text"] == "a red car in motion"
    assert result["model"]["name"] == "ViT-B-32"
    assert result["model"]["pretrained"] == "openai"

    artifact_ref = result["vector_artifact_ref"]
    assert isinstance(artifact_ref, dict)
    assert artifact_ref["dim"] == 512
    assert artifact_ref["dtype"] == "float32"
    assert isinstance(artifact_ref["bytes_base64"], str) and len(artifact_ref["bytes_base64"]) > 0


def test_encode_query_missing_text_returns_error():
    request = {"options": {}}
    result = module.encode_query(request)

    assert result["vector_artifact_ref"] == {}
    assert "errors" in result
    assert result["errors"][0]["code"] == "missing_text"


def test_encode_query_uses_data_model_config():
    """Verify that model name/pretrained are read from DATA, not hardcoded."""
    config_seen = {}

    def fake_load_clip(model_name, pretrained, device):
        config_seen["model_name"] = model_name
        config_seen["pretrained"] = pretrained
        config_seen["device"] = device

        class FakeModel:
            pass

        class FakeTokenizer:
            pass

        return FakeModel(), object(), FakeTokenizer(), "cpu"

    def fake_embed_text(model, tokenizer, device, text):
        vec = np.array([1.0] * 512, dtype="float32")
        norm = float((vec**2).sum() ** 0.5) or 1.0
        return (vec / norm).astype("float32")

    # Monkey-patch
    import sys

    old_load_clip = module.load_clip
    old_embed_text = module.embed_text
    try:
        module.load_clip = fake_load_clip
        module.embed_text = fake_embed_text

        request = {
            "options": {
                "text": "test query",
                "model": {"name": "ViT-L-14", "pretrained": "laion2b_s32b_b82k", "device": "mps"},
            }
        }

        result = module.encode_query(request)

        assert config_seen["model_name"] == "ViT-L-14"
        assert config_seen["pretrained"] == "laion2b_s32b_b82k"
        assert config_seen["device"] == "mps"
    finally:
        module.load_clip = old_load_clip
        module.embed_text = old_embed_text
