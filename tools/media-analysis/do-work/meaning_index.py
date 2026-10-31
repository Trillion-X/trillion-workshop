#!/usr/bin/env python3
"""A local index of what recordings LOOK like and what is SAID in them, and a search over it.

Purpose
  Answers "which recordings show, or mention, this phrase, and when" on the person's own computer.

  - Picture lane: sampled video frames and still images, embedded with a CLIP model (open_clip).
  - Speech lane: transcript chunks embedded with a local sentence model.
  - Both lanes are one index shape: rows of (recording identity, moment, unit vector). A query is one matrix
    product and the best row per recording wins.

Non-negotiable invariants
  - Everything runs on this computer at no cost; models load from the local cache (HF_HUB_OFFLINE), never a
    paid service and never a download.
  - A value this script produces is keyed by the identity the caller gave and returned to the caller to keep, so
    the same bytes need never be embedded twice: `add` brings kept values back in, nothing is recomputed.
  - Model names, sampling policy and thresholds arrive as request DATA; the constants below are only defaults.
  - No temporary files: frames travel from ffmpeg over a pipe.

How it runs
  `meaning_index.py [CONFIG_FILE]` reads one JSON request per line on standard input and writes one reply per line
  on standard output (every request carries `id`; its reply echoes it with `ok: true` plus fields, or `error`).
  CONFIG_FILE is a JSON file that may hold `picture_model` {name, pretrained, device?}, `speech_model` {name, query_prefix?},
  `query_encoders` (a folder where each model's text side is kept so a later start answers a search quickly)
  and `in_order` (true: requests are answered one after another in the order given, so a search sees every
  recording added before it; the default is a warm process whose searches never wait behind indexing).
  When standard input ends, what was asked is answered, then the last line `{"result": {"answered", "failed"}}`
  is printed.

  embed_picture   {identity, file, media_kind?, duration?, sampling?}  -> {value, seconds, frames}
  embed_speech    {identity, chunks:[{start?, end?, text}]}            -> {value, seconds, chunks}
  add             {kind:'picture'|'speech', identity, value}           -> {rows}
  search          {query, lanes?, limit?}                              -> {picture:[...], speech:[...]}
  prepare         {}                                                   -> {seconds}  (loads the query encoders)
"""

from __future__ import annotations

import base64
import importlib.util
import json
import os
import queue
import re
import subprocess
import sys
import threading
import time
from pathlib import Path
from typing import Any

os.environ.setdefault("HF_HUB_OFFLINE", "1")
os.environ.setdefault("TRANSFORMERS_OFFLINE", "1")
os.environ.setdefault("TOKENIZERS_PARALLELISM", "false")

import numpy as np  # noqa: E402

DEFAULT_PICTURE_MODEL = {"name": "ViT-B-32", "pretrained": "openai"}
DEFAULT_SPEECH_MODEL = {"name": "BAAI/bge-small-en-v1.5", "query_prefix": "Represent this sentence for searching relevant passages: "}
DEFAULT_SAMPLING = {"interval_seconds": 6.0, "max_frames": 20, "dedup_similarity": 0.95}
FRAME_SIDE = 224
IMAGE_KINDS = {"image"}


def load_clip(model_name: str, pretrained: str, device: str = ""):
    """The one CLIP definition: (model, preprocess, tokenizer, device). MPS when available."""
    import open_clip
    import torch

    resolved_device = device or ("mps" if torch.backends.mps.is_available() else "cpu")
    model, _, preprocess = open_clip.create_model_and_transforms(model_name, pretrained=pretrained, device=resolved_device)
    model.eval()
    tokenizer = open_clip.get_tokenizer(model_name)
    return model, preprocess, tokenizer, resolved_device


def embed_text(model, tokenizer, device: str, text: str):
    """A phrase as a unit float32 vector in the picture lane's space."""
    import torch

    tokens = tokenizer([text]).to(device)
    with torch.no_grad():
        embedding = model.encode_text(tokens)
    vector = embedding.cpu().numpy().flatten()
    norm = float((vector**2).sum() ** 0.5) or 1.0
    return (vector / norm).astype("float32")


def to_b64(vector: np.ndarray) -> str:
    return base64.b64encode(vector.astype("<f2").tobytes()).decode("ascii")


def from_b64(text: str, dtype: str) -> np.ndarray:
    raw = base64.b64decode(text)
    return np.frombuffer(raw, dtype="<f2" if dtype == "float16" else "<f4").astype("float32")


def unit(matrix: np.ndarray) -> np.ndarray:
    norms = np.linalg.norm(matrix, axis=-1, keepdims=True)
    norms[norms == 0] = 1.0
    return (matrix / norms).astype("float32")


class Lane:
    """One index: rows of unit vectors, each owned by a recording and a moment."""

    def __init__(self) -> None:
        self.lock = threading.Lock()
        self.blocks: list[np.ndarray] = []
        self.owners: list[np.ndarray] = []
        self.moments: list[dict[str, Any]] = []  # per row: {"t"} or {"start","end","text"}
        self.identities: list[str] = []
        self.position: dict[str, int] = {}
        self.matrix: np.ndarray | None = None
        self.owner_of: np.ndarray | None = None
        self.retired: set[int] = set()

    def put(self, identity: str, vectors: np.ndarray, moments: list[dict[str, Any]]) -> int:
        with self.lock:
            if identity in self.position:
                # A newer value replaces the recording's earlier rows.
                self.retired.add(self.position[identity])
            index = len(self.identities)
            self.identities.append(identity)
            self.position[identity] = index
            self.blocks.append(unit(vectors))
            self.owners.append(np.full(len(vectors), index, dtype="int32"))
            self.moments.extend(moments)
            self.matrix = None
            return len(vectors)

    def snapshot(self):
        with self.lock:
            if self.matrix is None and self.blocks:
                self.matrix = np.vstack(self.blocks)
                self.owner_of = np.concatenate(self.owners)
                self.blocks, self.owners = [self.matrix], [self.owner_of]
            return self.matrix, self.owner_of, self.moments, self.identities, set(self.retired)

    def best(self, query: np.ndarray, limit: int) -> list[tuple[str, float, dict[str, Any]]]:
        matrix, owners, moments, identities, retired = self.snapshot()
        if matrix is None or not len(matrix):
            return []
        with np.errstate(all="ignore"):  # Accelerate's matmul raises spurious flags on finite float32 input
            scores = np.nan_to_num(matrix @ query, nan=-1.0, posinf=-1.0, neginf=-1.0)
        order = np.argsort(-scores)
        found: list[tuple[str, float, dict[str, Any]]] = []
        seen: set[int] = set()
        for row in order[: max(limit * 60, 4000)]:
            owner = int(owners[row])
            if owner in seen or owner in retired:
                continue
            seen.add(owner)
            found.append((identities[owner], float(scores[row]), moments[row]))
            if len(found) >= limit:
                break
        return found


class Models:
    def __init__(self) -> None:
        # One lock per model: picture indexing and speech indexing run side by side; a search holds each for milliseconds.
        self.picture_lock = threading.Lock()
        self.speech_lock = threading.Lock()
        self.clip = None
        self.clip_config: dict[str, str] | None = None
        self.speech = None
        self.speech_config: dict[str, str] | None = None

    def picture(self, config: dict[str, str]):
        with self.picture_lock:
            if self.clip is None or self.clip_config != config:
                self.clip = load_clip(config["name"], config["pretrained"], config.get("device", ""))
                self.clip_config = dict(config)
            return self.clip

    def speech_model(self, config: dict[str, str]):
        with self.speech_lock:
            if self.speech is None or self.speech_config != config:
                from sentence_transformers import SentenceTransformer
                import torch

                device = "mps" if torch.backends.mps.is_available() else "cpu"
                self.speech = SentenceTransformer(config["name"], device=device)
                self.speech_config = dict(config)
            return self.speech


MODELS = Models()


class QueryEncoders:
    """Phrase -> query vector for each lane, answered seconds after start.

    Importing the full picture stack (open_clip pulls in transformers, timm, torchvision and more) takes about twenty
    seconds, and it would be paid on every start before the first search could answer. A search only needs each
    model's text side, so the first time a model is used its text encoder is traced to a TorchScript file in the
    encoder folder, with its tokenizer beside it; every later start loads those with `torch` and a tokenizer alone.
    A traced encoder is kept only when it reproduces the full model's vector for a probe phrase. The file name
    carries the model and the torch version, so a changed model or torch is traced again, never mismatched.
    Query encoders run on the CPU (one short phrase), so they never wait behind indexing on the GPU."""

    PROBE = "a person drawing on a whiteboard"

    def __init__(self) -> None:
        self.folder: Path | None = None
        self.locks = {"picture": threading.Lock(), "speech": threading.Lock()}
        self.loaded: dict[str, Any] = {}

    def file(self, lane: str, config: dict[str, str]) -> Path | None:
        import torch

        if self.folder is None:
            return None
        name = "-".join([lane, *(str(config.get(key, "")) for key in ("name", "pretrained")), "torch" + torch.__version__])
        return self.folder / (re.sub(r"[^A-Za-z0-9._-]+", "_", name) + ".pt")

    def encode(self, lane: str, config: dict[str, str], text: str) -> np.ndarray:
        with self.locks[lane]:
            key = json.dumps(config, sort_keys=True)
            if self.loaded.get(lane, (None,))[0] != key:
                self.loaded[lane] = (key, self.open(lane, config))
            encode = self.loaded[lane][1]
        return encode(text)

    def open(self, lane: str, config: dict[str, str]):
        import torch

        torch.set_num_threads(max(1, min(4, os.cpu_count() or 1)))
        path = self.file(lane, config)
        tokenizer_path = path.with_suffix(".tokenizer.json") if path else None
        if path and path.exists() and (lane == "picture" or tokenizer_path.exists()):
            return self.from_saved(lane, config, torch.jit.load(str(path), map_location="cpu"), tokenizer_path)
        traced, full = self.trace(lane, config, keep=path is not None)
        if path and traced is not None:
            path.parent.mkdir(parents=True, exist_ok=True)
            partial = path.with_suffix(".partial")
            traced.save(str(partial))
            if lane == "speech":
                MODELS.speech_model(config).tokenizer.backend_tokenizer.save(str(tokenizer_path))
            os.replace(partial, path)
            return self.from_saved(lane, config, torch.jit.load(str(path), map_location="cpu"), tokenizer_path)
        return full

    @staticmethod
    def clip_tokenizer():
        """open_clip's own tokenizer file, loaded by path so the rest of open_clip is never imported."""
        spec = importlib.util.find_spec("open_clip")
        location = Path(list(spec.submodule_search_locations)[0]) / "tokenizer.py"
        module_spec = importlib.util.spec_from_file_location("open_clip_tokenizer_only", location)
        module = importlib.util.module_from_spec(module_spec)
        module_spec.loader.exec_module(module)
        return module.SimpleTokenizer()

    def from_saved(self, lane: str, config: dict[str, str], module, tokenizer_path: Path | None):
        import torch

        if lane == "picture":
            tokenizer = self.clip_tokenizer()

            def picture(text: str) -> np.ndarray:
                with torch.no_grad():
                    vector = module(tokenizer([text])).numpy().flatten()
                return unit(vector[None, :])[0]

            return picture
        from tokenizers import Tokenizer

        tokenizer = Tokenizer.from_file(str(tokenizer_path))
        tokenizer.enable_truncation(512)
        prefix = config.get("query_prefix", "")

        def speech(text: str) -> np.ndarray:
            encoded = tokenizer.encode(prefix + text)
            ids = torch.tensor([encoded.ids], dtype=torch.long)
            mask = torch.tensor([encoded.attention_mask], dtype=torch.long)
            with torch.no_grad():
                vector = module(ids, mask).numpy().flatten()
            return unit(vector[None, :])[0]

        return speech

    def trace(self, lane: str, config: dict[str, str], keep: bool = True):
        """The full model's query function, and (when it will be kept) its text side traced for CPU if that
        reproduces it."""
        import copy

        import torch

        if lane == "picture":
            model, _preprocess, tokenizer, device = MODELS.picture(config)

            def full(text: str) -> np.ndarray:
                with MODELS.picture_lock:
                    return embed_text(model, tokenizer, device, text)

            if not keep:
                return None, full

            class Text(torch.nn.Module):
                def __init__(self, source) -> None:
                    super().__init__()
                    self.source = source

                def forward(self, tokens):
                    return self.source.encode_text(tokens)

            with MODELS.picture_lock:
                source = copy.deepcopy(model).to("cpu").eval()
            # Only the text side is kept: the picture tower is most of the file and a query never uses it.
            source.visual = torch.nn.Identity()
            text = Text(source)
            probe = tokenizer([self.PROBE])
            with torch.no_grad():
                traced = torch.jit.trace(text, probe, check_trace=False)
                vector = traced(probe).numpy().flatten()
        else:
            model = MODELS.speech_model(config)

            def full(text: str) -> np.ndarray:
                with MODELS.speech_lock:
                    return np.asarray(model.encode([config.get("query_prefix", "") + text], normalize_embeddings=True, show_progress_bar=False)[0], dtype="float32")

            if not keep:
                return None, full
            pooling = model[1].get_pooling_mode_str() if len(model) > 1 and hasattr(model[1], "get_pooling_mode_str") else "cls"

            class Text(torch.nn.Module):
                def __init__(self, source, mode: str) -> None:
                    super().__init__()
                    self.source = source
                    self.mean = mode == "mean"

                def forward(self, ids, mask):
                    hidden = self.source(input_ids=ids, attention_mask=mask, return_dict=False)[0]
                    if self.mean:
                        weights = mask.unsqueeze(-1).to(hidden.dtype)
                        return (hidden * weights).sum(1) / weights.sum(1).clamp(min=1e-9)
                    return hidden[:, 0]

            with MODELS.speech_lock:
                text = Text(copy.deepcopy(model[0].auto_model).to("cpu").eval(), pooling)
            encoded = model.tokenizer([config.get("query_prefix", "") + self.PROBE], return_tensors="pt", truncation=True, max_length=512)
            with torch.no_grad():
                traced = torch.jit.trace(text, (encoded["input_ids"], encoded["attention_mask"]), check_trace=False, strict=False)
                vector = traced(encoded["input_ids"], encoded["attention_mask"]).numpy().flatten()
        agrees = float(unit(vector[None, :])[0] @ unit(np.asarray(full(self.PROBE), dtype="float32")[None, :])[0]) >= 0.999
        return (traced if agrees else None), full


ENCODERS = QueryEncoders()
LANES = {"picture": Lane(), "speech": Lane()}
PICTURE_MODEL = dict(DEFAULT_PICTURE_MODEL)
SPEECH_MODEL = dict(DEFAULT_SPEECH_MODEL)


def ffprobe_duration(file: str) -> float:
    try:
        out = subprocess.run(["ffprobe", "-v", "error", "-show_entries", "format=duration", "-of", "default=nw=1:nk=1", file], capture_output=True, text=True, timeout=30).stdout.strip()
        return float(out)
    except (ValueError, subprocess.TimeoutExpired, OSError):
        return 0.0


def frame_at(file: str, seconds: float | None):
    """One square RGB frame (FRAME_SIDE px, center crop like CLIP's own preprocess) over a pipe."""
    from PIL import Image

    command = ["ffmpeg", "-nostdin", "-v", "error"]
    if seconds is not None:
        command += ["-skip_frame", "nokey", "-ss", f"{seconds:.3f}"]
    command += ["-i", file, "-frames:v", "1", "-vf", f"scale={FRAME_SIDE}:{FRAME_SIDE}:force_original_aspect_ratio=increase,crop={FRAME_SIDE}:{FRAME_SIDE}", "-f", "rawvideo", "-pix_fmt", "rgb24", "pipe:1"]
    try:
        raw = subprocess.run(command, capture_output=True, timeout=60).stdout
    except (subprocess.TimeoutExpired, OSError):
        return None
    size = FRAME_SIDE * FRAME_SIDE * 3
    if len(raw) < size:
        return None
    return Image.frombytes("RGB", (FRAME_SIDE, FRAME_SIDE), raw[:size])


def still_image(file: str):
    from PIL import Image

    Image.MAX_IMAGE_PIXELS = None
    try:
        with Image.open(file) as image:
            image.draft("RGB", (FRAME_SIDE * 2, FRAME_SIDE * 2))
            return image.convert("RGB")
    except Exception:  # noqa: BLE001 - an unreadable format falls through to ffmpeg's decoders
        return frame_at(file, None)


def sample_times(duration: float, sampling: dict[str, Any]) -> list[float]:
    if duration <= 0:
        return [0.0]
    count = int(min(sampling["max_frames"], max(1, np.ceil(duration / sampling["interval_seconds"]))))
    return [round(duration * (index + 0.5) / count, 2) for index in range(count)]


def embed_picture(request: dict[str, Any]) -> dict[str, Any]:
    started = time.time()
    sampling = {**DEFAULT_SAMPLING, **(request.get("sampling") or {})}
    file = str(request["file"])
    if not os.path.exists(file):
        raise FileNotFoundError("The recording is not on this computer.")
    if request.get("media_kind") in IMAGE_KINDS:
        images, times = [still_image(file)], [None]
    else:
        duration = float(request.get("duration") or 0) or ffprobe_duration(file)
        times = sample_times(duration, sampling)
        images = [frame_at(file, seconds) for seconds in times]
    kept = [(image, seconds) for image, seconds in zip(images, times) if image is not None]
    if not kept:
        raise ValueError("No picture could be read from this recording.")
    import torch

    model, preprocess, _tokenizer, device = MODELS.picture(PICTURE_MODEL)
    batch = torch.stack([preprocess(image) for image, _ in kept]).to(device)
    with MODELS.picture_lock, torch.no_grad():
        features = model.encode_image(batch)
    vectors = unit(features.float().cpu().numpy())
    frames, last = [], None
    for vector, (_image, seconds) in zip(vectors, kept):
        if last is not None and float(vector @ last) >= sampling["dedup_similarity"]:
            continue
        frames.append((vector, seconds))
        last = vector
    value = {
        "model": PICTURE_MODEL, "dims": int(vectors.shape[1]), "dtype": "float16", "timing": "measured",
        "sampling": sampling, "frames": [{"t": seconds, "v": to_b64(vector)} for vector, seconds in frames],
    }
    LANES["picture"].put(str(request["identity"]), np.stack([vector for vector, _ in frames]), [{"t": seconds} for _, seconds in frames])
    return {"value": value, "seconds": round(time.time() - started, 3), "frames": len(frames)}


def embed_speech(request: dict[str, Any]) -> dict[str, Any]:
    started = time.time()
    chunks = [chunk for chunk in request.get("chunks") or [] if str(chunk.get("text") or "").strip()]
    if not chunks:
        raise ValueError("This recording has no transcript text to index.")
    model = MODELS.speech_model(SPEECH_MODEL)
    with MODELS.speech_lock:
        vectors = model.encode([str(chunk["text"]) for chunk in chunks], normalize_embeddings=True, batch_size=32, show_progress_bar=False)
    vectors = unit(np.asarray(vectors, dtype="float32"))
    moments = [{key: chunk[key] for key in ("start", "end") if isinstance(chunk.get(key), (int, float))} | {"text": str(chunk["text"])[:280]} for chunk in chunks]
    value = {"model": {"name": SPEECH_MODEL["name"]}, "dims": int(vectors.shape[1]), "dtype": "float16", "chunks": [{**moment, "v": to_b64(vector)} for moment, vector in zip(moments, vectors)]}
    LANES["speech"].put(str(request["identity"]), vectors, moments)
    return {"value": value, "seconds": round(time.time() - started, 3), "chunks": len(chunks)}


def add_value(kind: str, identity: str, value: dict[str, Any]) -> int:
    if kind not in LANES:
        raise ValueError(f"Unknown kind {kind!r}: use 'picture' or 'speech'.")
    dtype = value.get("dtype", "float32")
    if kind == "picture":
        rows = value.get("frames") or []
        moments = [{"t": row.get("t")} for row in rows]
    else:
        rows = value.get("chunks") or []
        moments = [{key: row[key] for key in ("start", "end", "text") if key in row} for row in rows]
    if not rows:
        return 0
    vectors = np.stack([from_b64(row["v"], dtype) for row in rows])
    return LANES[kind].put(identity, vectors, moments)


def search(request: dict[str, Any]) -> dict[str, Any]:
    text = str(request.get("query") or "").strip()[:500]
    limit = int(request.get("limit") or 40)
    lanes = request.get("lanes") or ["picture", "speech"]
    reply: dict[str, Any] = {}
    if "picture" in lanes and LANES["picture"].identities:
        query = ENCODERS.encode("picture", PICTURE_MODEL, text)
        reply["picture"] = [{"identity": identity, "score": round(score, 4), **({"t": moment["t"]} if moment.get("t") is not None else {})} for identity, score, moment in LANES["picture"].best(query, limit)]
    if "speech" in lanes and LANES["speech"].identities:
        query = ENCODERS.encode("speech", SPEECH_MODEL, text)
        reply["speech"] = [{"identity": identity, "score": round(score, 4), **moment} for identity, score, moment in LANES["speech"].best(np.asarray(query, dtype="float32"), limit)]
    return reply


def prepare(_request: dict[str, Any]) -> dict[str, Any]:
    """Loads both query encoders, so the first search answers at once."""
    started = time.time()
    ENCODERS.encode("picture", PICTURE_MODEL, "a recording")
    ENCODERS.encode("speech", SPEECH_MODEL, "a recording")
    return {"seconds": round(time.time() - started, 2)}


OPERATIONS = {"embed_picture": embed_picture, "embed_speech": embed_speech, "search": search, "prepare": prepare,
              "add": lambda request: {"rows": add_value(request["kind"], request["identity"], request["value"])}}
LANE_OF = {"search": "fast", "prepare": "fast", "add": "fast", "embed_speech": "speech"}  # everything else runs on the picture thread
WRITE = threading.Lock()
TALLY = {"answered": 0, "failed": 0}


def reply(message: dict[str, Any]) -> None:
    line = json.dumps(message, separators=(",", ":"))
    with WRITE:
        sys.stdout.write(line + "\n")
        sys.stdout.flush()


def answer(request: dict[str, Any]) -> None:
    try:
        operation = OPERATIONS.get(request.get("op"))
        if operation is None:
            raise ValueError(f"Unknown operation {request.get('op')!r}: use one of {sorted(OPERATIONS)}.")
        reply({"id": request.get("id"), "ok": True, **operation(request)})
        TALLY["answered"] += 1
    except Exception as error:  # noqa: BLE001 - every failure is answered, never swallowed
        reply({"id": request.get("id"), "error": f"{type(error).__name__}: {error}"})
        TALLY["failed"] += 1


def serve(jobs: "queue.Queue[dict[str, Any] | None]") -> None:
    while True:
        request = jobs.get()
        if request is None:
            return
        answer(request)


def main() -> int:
    global PICTURE_MODEL, SPEECH_MODEL
    configuration = json.loads(Path(sys.argv[1]).read_text(encoding="utf-8")) if len(sys.argv) > 1 else {}
    PICTURE_MODEL = {**DEFAULT_PICTURE_MODEL, **(configuration.get("picture_model") or {})}
    SPEECH_MODEL = {**DEFAULT_SPEECH_MODEL, **(configuration.get("speech_model") or {})}
    if configuration.get("query_encoders"):
        ENCODERS.folder = Path(configuration["query_encoders"])
    in_order = bool(configuration.get("in_order"))
    queues: dict[str, "queue.Queue[dict[str, Any] | None]"] = {name: queue.Queue() for name in ("fast", "picture", "speech")}
    threads = [] if in_order else [threading.Thread(target=serve, args=(jobs,)) for jobs in queues.values()]
    for thread in threads:
        thread.start()
    reply({"id": None, "ok": True, "ready": True})
    for line in sys.stdin:
        if not line.strip():
            continue
        try:
            request = json.loads(line)
        except ValueError:
            continue
        if in_order:
            answer(request)
        else:
            queues[LANE_OF.get(request.get("op"), "picture")].put(request)
    # Standard input ended: answer what was already asked, then stop.
    for jobs in queues.values():
        jobs.put(None)
    for thread in threads:
        thread.join()
    reply({"result": dict(TALLY)})
    return 0


if __name__ == "__main__":
    sys.exit(main())
