#!/usr/bin/env python3
"""Unit tests for the descriptor-owned Ollama embedding executor."""

from __future__ import annotations

import importlib.util
import json
import sys
import tempfile
from pathlib import Path
from unittest import mock

HERE = Path(__file__).parent
SCRIPT = HERE / "embed-text-ollama.py"
spec = importlib.util.spec_from_file_location("embed_text_ollama", SCRIPT)
mod = importlib.util.module_from_spec(spec)
spec.loader.exec_module(mod)


def run(request: object, reply: dict | None = None) -> tuple[int, dict, mock.Mock]:
    with tempfile.TemporaryDirectory() as directory:
        request_path = Path(directory) / "request.json"
        output_path = Path(directory) / "output.json"
        request_path.write_text(json.dumps(request), encoding="utf-8")
        argv = [
            "embed-text-ollama.py",
            "--request-json",
            str(request_path),
            "--output-json",
            str(output_path),
            "--model",
            "model-a",
            "--endpoint",
            "http://example.test",
        ]
        post = mock.Mock(return_value=reply or {})
        with mock.patch.object(sys, "argv", argv), mock.patch.object(mod, "post_json", post):
            status = mod.main()
        output = (
            json.loads(output_path.read_text(encoding="utf-8"))
            if output_path.exists()
            else {}
        )
        return status, output, post


def test_single_request_contract() -> None:
    status, output, post = run(
        {"content_text": "hello"},
        {"embedding": [1, -2.5]},
    )
    assert status == 0
    assert output == {
        "vector": [1.0, -2.5],
        "provenance": {"model_id": "model-a", "model_version": "ollama"},
    }
    assert post.call_args.args == (
        "http://example.test/api/embeddings",
        {"model": "model-a", "prompt": "hello"},
    )


def test_batch_request_is_one_owner_call() -> None:
    status, output, post = run(
        {"items": [{"id": "a", "text": "first"}, {"id": "b", "text": "second"}]},
        {"embeddings": [[1, 2], [3.5, 4]]},
    )
    assert status == 0
    assert output == {
        "vectors": {"a": [1.0, 2.0], "b": [3.5, 4.0]},
        "provenance": {"model_id": "model-a", "model_version": "ollama"},
    }
    assert post.call_count == 1
    assert post.call_args.args == (
        "http://example.test/api/embed",
        {"model": "model-a", "input": ["first", "second"]},
    )


def test_empty_batch_is_valid_without_provider_call() -> None:
    status, output, post = run({"items": []})
    assert status == 0
    assert output["vectors"] == {}
    post.assert_not_called()


def test_batch_rejects_duplicate_ids_and_shape_mismatch() -> None:
    status, _, post = run(
        {"items": [{"id": "a", "text": "first"}, {"id": "a", "text": "second"}]}
    )
    assert status == 1
    post.assert_not_called()

    status, _, post = run(
        {"items": [{"id": "a", "text": "first"}, {"id": "b", "text": "second"}]},
        {"embeddings": [[1, 2]]},
    )
    assert status == 1
    assert post.call_count == 1


if __name__ == "__main__":
    for name, value in sorted(globals().items()):
        if name.startswith("test_") and callable(value):
            value()
