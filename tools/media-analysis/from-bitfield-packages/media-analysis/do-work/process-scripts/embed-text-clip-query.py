#!/usr/bin/env python3
"""Encode text queries with a CLIP-family model, one shot, DATA-parameterized.

Ported from architect-societies/intake-desktop's worker_semantic_search.py
embed_text() method. Takes a query string and model config (name, pretrained
checkpoint, device) as DATA fields on the request JSON, encodes the text with
CLIP's text encoder, and returns a normalized vector artifact ref.

One invocation, one JSON request in, one JSON result out (stdout), matching
every other media-analysis analysis-command convention.

Output shape: `{"vector_artifact_ref": {...}, "model": {...}}` — consumed
directly by find-similar query flow or manual verification. No persistent
worker loop.
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


def vector_to_artifact_ref(vector, dtype: str = "float32") -> dict[str, Any]:
    """Opaque object per the embedding contract's `vector_contract` clause --
    the vector bytes travel as base64 inline here."""
    raw = vector.astype("float32").tobytes()
    return {
        "bytes_base64": base64.b64encode(raw).decode("ascii"),
        "dim": int(vector.shape[0]),
        "dtype": dtype,
    }


def encode_query(request: dict[str, Any]) -> dict[str, Any]:
    """Encode a text query string with CLIP text encoder.

    Accepts the meaning-search executor contract (top-level `query_text` /
    `content_text`, as `embed-text-ollama.py` does — find-similar's `run_embed`
    step mounts the workflow input verbatim as request.json) as well as the
    older `options.text` shape."""
    options = object_or_default(request.get("options"), {})
    text = str(
        request.get("query_text")
        or request.get("content_text")
        or options.get("text")
        or ""
    )

    if not text:
        return {"vector_artifact_ref": {}, "errors": [{"code": "missing_text", "message": "options.text is required"}]}

    model_config = object_or_default(options.get("model"), {})
    model_name = str(model_config.get("name") or DEFAULT_MODEL_NAME)
    model_pretrained = str(model_config.get("pretrained") or DEFAULT_MODEL_PRETRAINED)
    device = str(model_config.get("device") or "")

    model, _preprocess, tokenizer, resolved_device = load_clip(model_name, model_pretrained, device)
    vector = embed_text(model, tokenizer, resolved_device, text)

    return {
        "vector_artifact_ref": vector_to_artifact_ref(vector),
        # Plain numeric list under `vector` — the find-similar `ann_query`/`rank`
        # bindings extract it with op:core.lookup key "vector" (same contract as
        # embed-text-ollama.py's output).
        "vector": [float(item) for item in vector.tolist()],
        "model": {"name": model_name, "pretrained": model_pretrained, "device": resolved_device},
        "text": text,
    }


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--request-json", required=True)
    parser.add_argument("--output-json", required=False, default=None)
    args = parser.parse_args()

    request = read_json(args.request_json)

    try:
        result = encode_query(request)
    except Exception as exc:  # pragma: no cover - keeps output JSON-shaped on crash
        result = {"vector_artifact_ref": {}, "errors": [{"code": "embed_text_clip_query_crash", "message": str(exc)}]}
        print(str(exc), file=sys.stderr)

    if args.output_json:
        write_json(args.output_json, result)
    else:
        print(json.dumps(result, separators=(",", ":")))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
