"""Serve a contrastive language model (CLM) on this machine over the shared decision contract.

What it is
    CLM scores the options it is handed: a frozen encoder turns the state and
    each option into vectors, two small trained heads project them into one
    space, and a softmax over their similarities is the answer. The published
    server (`clm-serve`) expects the encoder behind a separate vLLM pooling
    server, and vLLM needs Linux and an NVIDIA card. This machine has neither,
    so this server runs the same encoder in-process on whatever torch offers
    (Apple's GPU here) and hands its vectors to the published engine unchanged.
    The heads, the scoring, the question shapes and the replies are the
    `contrastive-lm` package's own; only where the encoder runs differs.

What it speaks
    POST /v1/systemone with {"state": ..., "questions": {...}}, the shape the
    other classifiers here take, so one adapter drives all of them and which
    one answers is decided by calibration.

How it matches the published encoder
    The heads only make sense against the embeddings they were trained on:
    Qwen3-8B, the last token's final hidden state, L2-normalised, at most 2,048
    tokens with the start of a longer text dropped (as vLLM's
    `truncate_prompt_tokens` does). The encoder and pooling are read from the
    head's own config.json rather than assumed.

Environment
    SERVE_MODEL_PATH   the downloaded head repository (holds config.json and the .pt)
    SERVE_PORT         port to listen on
    CLM_MAX_TOKENS     encoder token limit (default 2048)
    SERVE_STALE_SECONDS  how long a request may wait when its caller does not say
    SERVE_HEADS_DIR    more heads trained on this machine (default: `trained` inside the
                       contrastive-lm package's own checkpoint folder);
                       each <name>.pt is served as model <name> beside the published one
"""

import asyncio
import glob
import json
import os
import threading
import time

import numpy as np
import torch

HEAD_PATH = os.environ.get("SERVE_MODEL_PATH", "")
MAX_TOKENS = int(os.environ.get("CLM_MAX_TOKENS", "2048"))
STALE_SECONDS = float(os.environ.get("SERVE_STALE_SECONDS", "4"))

with open(os.path.join(HEAD_PATH, "config.json")) as handle:
    CONFIG = json.load(handle)
if CONFIG.get("encoder_pooling") != "last-token":
    raise SystemExit(f"this server pools the last token; the head asks for {CONFIG.get('encoder_pooling')!r}")

DEVICE = "cuda" if torch.cuda.is_available() else "mps" if torch.backends.mps.is_available() else "cpu"


def load_encoder():
    from huggingface_hub import snapshot_download
    from transformers import AutoModel, AutoTokenizer

    where = snapshot_download(CONFIG["base_model"], local_files_only=True)
    tokenizer = AutoTokenizer.from_pretrained(where)
    tokenizer.truncation_side = "left"
    # Padding goes AFTER the text. Padded in front, a padded row's first
    # positions attend to nothing, and Apple's attention kernel turns such a
    # row into NaN for the whole text (measured: a batch of two came back NaN
    # for the shorter one). Padded behind, no real token ever sees a pad.
    tokenizer.padding_side = "right"
    started = time.time()
    model = AutoModel.from_pretrained(where, dtype=torch.bfloat16).to(DEVICE).eval()
    print(f"[clm] encoder {CONFIG['base_model']} ready on {DEVICE} in {time.time() - started:.1f}s", flush=True)
    return tokenizer, model


TOKENIZER, ENCODER = load_encoder()
FORWARD = threading.Lock()


class InProcessEmbedder:
    """The `contrastive-lm` Embedder interface, with the encoder in this process."""

    def __init__(self):
        # On MPS a half-precision pass over more than one text returns a wrong
        # vector for the first row even with no padding (torch 2.8, measured
        # 2026-09-27: cosine 0.57 against the same text alone; float32 and CPU
        # agree to 0.9999999). So on MPS each text gets its own pass.
        self.batch = 1 if DEVICE == "mps" else 16

    @torch.inference_mode()
    def embed(self, texts):
        # Texts share a pass only with texts of the same token length, so no pass
        # carries padding.
        ids = TOKENIZER(list(texts), truncation=True, max_length=MAX_TOKENS)["input_ids"]
        by_length = {}
        for index, row in enumerate(ids):
            by_length.setdefault(len(row), []).append(index)
        vectors = np.zeros((len(texts), ENCODER.config.hidden_size), dtype=np.float32)
        for indexes in by_length.values():
            for start in range(0, len(indexes), self.batch):
                chunk = indexes[start:start + self.batch]
                batch = torch.tensor([ids[i] for i in chunk], device=DEVICE)
                with FORWARD:
                    last = ENCODER(input_ids=batch).last_hidden_state[:, -1].float()
                    last = torch.nn.functional.normalize(last, dim=-1)
                    vectors[chunk] = last.cpu().numpy()
        return vectors, sum(len(row) for row in ids)

    def healthy(self):
        return True


from clm.engine import DEFAULT_MODEL, Engine, ModelNotFound  # noqa: E402

checkpoints = sorted(glob.glob(os.path.join(HEAD_PATH, "*.pt")))
if not checkpoints:
    raise SystemExit(f"no head checkpoint in {HEAD_PATH}")
from clm.heads import DEFAULT_CKPT_DIR  # noqa: E402

HEADS_DIR = os.environ.get("SERVE_HEADS_DIR", os.path.join(DEFAULT_CKPT_DIR, "trained"))
ENGINE = Engine(embedder=InProcessEmbedder(), checkpoint=checkpoints[0],
                checkpoint_dir=HEADS_DIR if os.path.isdir(HEADS_DIR) else None, device=DEVICE)
print(f"[clm] heads {os.path.basename(checkpoints[0])} on {DEVICE}; models {[m['name'] for m in ENGINE.models()]}", flush=True)

from fastapi import FastAPI, HTTPException, Request  # noqa: E402

app = FastAPI()
ONE_AT_A_TIME = asyncio.Lock()


@app.post("/v1/systemone")
async def system_one(body: dict, request: Request):
    arrived = time.monotonic()
    state, questions = body.get("state"), body.get("questions")
    if state is None or not isinstance(questions, dict) or not questions:
        raise HTTPException(status_code=422, detail="a request needs a `state` to read and a non-empty `questions` map to answer")
    # The published engine names its models itself; a caller's own label for
    # this server (the name calibration files it under) maps to the default.
    asked = body.get("model")
    model = asked if isinstance(asked, str) and ENGINE.has(asked) else DEFAULT_MODEL
    try:
        patience = float(request.headers.get("x-answer-within-seconds", STALE_SECONDS))
    except ValueError:
        patience = STALE_SECONDS
    async with ONE_AT_A_TIME:
        waited = time.monotonic() - arrived
        if waited > patience or await request.is_disconnected():
            raise HTTPException(status_code=503, detail=f"not answered: it waited {waited:.1f} s behind other requests, and its caller had already stopped waiting")
        started = time.perf_counter()
        try:
            out = await asyncio.to_thread(ENGINE.answer, state, questions, model, float(body.get("temperature", 1.0)))
        except ModelNotFound as error:
            raise HTTPException(status_code=422, detail=str(error)) from error
        except (ValueError, KeyError, TypeError) as error:
            raise HTTPException(status_code=422, detail=f"invalid request: {error}") from error
    out["latency_ms"] = round((time.perf_counter() - started) * 1000, 1)
    return out


@app.get("/health")
async def health():
    return {"serving": HEAD_PATH, "encoder": CONFIG["base_model"], "device": DEVICE, "models": [m["name"] for m in ENGINE.models()]}


if __name__ == "__main__":
    import uvicorn

    uvicorn.run(app, host="127.0.0.1", port=int(os.environ.get("SERVE_PORT", "8700")), log_level="warning")
