#!/usr/bin/env python3
# tools/words-as-picture-vector/do-work/words-as-picture-vector.py
#
# Purpose: turn words into the vector a picture model gives pictures that show them, so words can be compared with
# the picture vectors kept for a person's recordings (namespace results of kind picture-vectors). One JSON request on
# standard input, one JSON answer on standard output, nothing kept between runs.
#
# Input:  {"texts": ["tennis", ...], "model_folder": "/opt/models/clip-vit-base-patch32"}  (model_folder optional)
# Output: {"model": {"name": ..., "pretrained": ...}, "dims": 512, "vectors": [[...512 floats, unit length], ...]}
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

request = json.load(sys.stdin)
folder = request.get("model_folder") or os.environ.get("PICTURE_WORDS_MODEL", "/opt/models/clip-vit-base-patch32")
texts = [str(text)[:1000] for text in request.get("texts", [])]
if not texts or len(texts) > 64:
    sys.exit("Send between 1 and 64 texts.")
with open(os.path.join(folder, "model.json"), encoding="utf-8") as handle:
    model = json.load(handle)
tokenizer = Tokenizer.from_file(os.path.join(folder, "tokenizer.json"))
length = int(model.get("context_length", 77))
tokenizer.enable_truncation(length)
tokenizer.enable_padding(length=length, pad_id=int(model.get("pad_id", 49407)))
encoded = tokenizer.encode_batch(texts)
ids = np.array([item.ids for item in encoded], dtype=np.int64)
session = onnxruntime.InferenceSession(os.path.join(folder, "text_model.onnx"), providers=["CPUExecutionProvider"])
feeds = {"input_ids": ids}
if "attention_mask" in [item.name for item in session.get_inputs()]:
    feeds["attention_mask"] = np.array([item.attention_mask for item in encoded], dtype=np.int64)
outputs = dict(zip([item.name for item in session.get_outputs()], session.run(None, feeds)))
vectors = outputs.get("text_embeds")
if vectors is None:
    sys.exit(f"The model gave {list(outputs)}, not text_embeds.")
vectors = vectors / np.linalg.norm(vectors, axis=1, keepdims=True)
json.dump({"model": model["names"], "dims": int(vectors.shape[1]), "vectors": np.round(vectors, 6).tolist()}, sys.stdout)
