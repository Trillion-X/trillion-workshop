#!/usr/bin/env python3
# tools/words-as-picture-vector/do-work/words-as-picture-vector-session.py
#
# Purpose: the same CLIP text embedding as words-as-picture-vector.py, kept running as a session: the model is loaded once
# when the session starts, and each `tools/call` of the Model Context Protocol over standard input answers one embedding.
# Standard output carries only protocol lines; the logs go to standard error.
#
# Input (tools/call, arguments): {"texts": ["tennis", ...]}  (1 to 64 texts)
# Output (tools/call result): structuredContent {"model": {"name", "pretrained"}, "dims": 512, "vectors": [[...], ...]},
#   the same answer words-as-picture-vector.py gives, also as one JSON text in content.
#
# Invariants:
#   - The model folder holds text_model.onnx and tokenizer.json of one CLIP model and model.json naming it; the answer
#     names that model, so a caller compares only with vectors made by the same model.
#   - Vectors are unit length; texts are cut to the model's 77 tokens.
import json
import os
import sys

import numpy as np
import onnxruntime
from tokenizers import Tokenizer

PROTOCOL_VERSION = "2025-06-18"
TOOL_NAME = "words-as-picture-vector"
# The model sits in the run's models folder beside this tool's own folder: /opt/models/clip-vit-base-patch32 in a run.
MODEL_FOLDER = os.environ.get("PICTURE_WORDS_MODEL") or os.path.join(
    os.path.dirname(os.path.abspath(__file__)), "..", "..", "models", "clip-vit-base-patch32"
)


def load_model(folder):
    with open(os.path.join(folder, "model.json"), encoding="utf-8") as handle:
        model = json.load(handle)
    tokenizer = Tokenizer.from_file(os.path.join(folder, "tokenizer.json"))
    length = int(model.get("context_length", 77))
    tokenizer.enable_truncation(length)
    tokenizer.enable_padding(length=length, pad_id=int(model.get("pad_id", 49407)))
    session = onnxruntime.InferenceSession(os.path.join(folder, "text_model.onnx"), providers=["CPUExecutionProvider"])
    return model, tokenizer, session


def embed(loaded, texts):
    model, tokenizer, session = loaded
    encoded = tokenizer.encode_batch(texts)
    feeds = {"input_ids": np.array([item.ids for item in encoded], dtype=np.int64)}
    if "attention_mask" in [item.name for item in session.get_inputs()]:
        feeds["attention_mask"] = np.array([item.attention_mask for item in encoded], dtype=np.int64)
    outputs = dict(zip([item.name for item in session.get_outputs()], session.run(None, feeds)))
    vectors = outputs.get("text_embeds")
    if vectors is None:
        raise ValueError(f"The model gave {list(outputs)}, not text_embeds.")
    vectors = vectors / np.linalg.norm(vectors, axis=1, keepdims=True)
    return {"model": model["names"], "dims": int(vectors.shape[1]), "vectors": np.round(vectors, 6).tolist()}


def send(message):
    sys.stdout.write(json.dumps(message) + "\n")
    sys.stdout.flush()


def call(loaded, arguments):
    texts = [str(text)[:1000] for text in arguments.get("texts", [])]
    if not texts or len(texts) > 64:
        raise ValueError("Send between 1 and 64 texts.")
    answer = embed(loaded, texts)
    return {"content": [{"type": "text", "text": json.dumps(answer)}], "structuredContent": answer, "isError": False}


def main():
    loaded = load_model(MODEL_FOLDER)
    for line in sys.stdin:
        if not line.strip():
            continue
        message = json.loads(line)
        method = message.get("method")
        if "id" not in message:
            continue
        request_id = message["id"]
        if method == "initialize":
            send({"jsonrpc": "2.0", "id": request_id, "result": {
                "protocolVersion": PROTOCOL_VERSION, "capabilities": {"tools": {}},
                "serverInfo": {"name": TOOL_NAME, "version": "1"}}})
        elif method == "tools/list":
            send({"jsonrpc": "2.0", "id": request_id, "result": {"tools": [{"name": TOOL_NAME, "inputSchema": {
                "type": "object", "required": ["texts"], "properties": {"texts": {"type": "array", "minItems": 1, "maxItems": 64}}}}]}})
        elif method == "tools/call" and message.get("params", {}).get("name") == TOOL_NAME:
            try:
                result = call(loaded, message["params"].get("arguments") or {})
            except ValueError as error:
                result = {"content": [{"type": "text", "text": str(error)}], "isError": True}
            send({"jsonrpc": "2.0", "id": request_id, "result": result})
        else:
            send({"jsonrpc": "2.0", "id": request_id, "error": {"code": -32601, "message": f"no method {method}"}})


if __name__ == "__main__":
    main()
