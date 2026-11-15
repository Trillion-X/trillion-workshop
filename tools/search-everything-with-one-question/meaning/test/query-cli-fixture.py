"""Synthetic store fixture and deterministic query encoder for legacy CLI parity."""
import base64
import contextlib
import json
import os
from pathlib import Path
import runpy
import sqlite3
import sys
import types
import numpy as np


def make_fixture(folder):
    root = Path(folder)
    assets, timed = root / "assets", root / "timed"
    assets.mkdir(parents=True, exist_ok=True)
    timed.mkdir(parents=True, exist_ok=True)
    video_paths = [str(root / "z.mp4"), str(root / "a.mp4"), str(root / "z.mp4")]
    image_paths = [str(root / "image.png"), str(root / "other.png")]
    (root / "z.mp4").touch()
    np.save(assets / "clip-video-embeddings.npy", np.array([[1, 0, 0], [.6, .8, 0], [1, 0, 0]], dtype=np.float32))
    np.save(assets / "clip-embeddings.npy", np.array([[0, 1, 0], [.6, .8, 0]], dtype=np.float32))
    (assets / "clip-video-ids.json").write_text(json.dumps(video_paths))
    (assets / "clip-ids.json").write_text(json.dumps(image_paths))
    (assets / "assets.jsonl").write_text("".join(json.dumps({"path": path, "name": "Readable " + Path(path).name}) + "\n" for path in video_paths + image_paths))
    np.save(timed / "frames.npy", np.array([[.6001, .7999, 0], [.5996, .7988, 0], [.6, .8, 0], [.6, .8, 0]], dtype=np.float16))
    (timed / "frames.jsonl").write_text("".join(json.dumps({"path": str(root / name), "t": t}) + "\n" for name, t in [("close-a.mp4", 0), ("close-b.mp4", 0), ("close-a.mp4", 5), ("close-a.mp4", 15)]))
    (timed / "transcripts.jsonl").write_text("".join(json.dumps({"path": path, "t": t, "end": t + 1, "text": text}) + "\n" for path, t, text in [(video_paths[0], 0, "blue sky nearby"), (str(root / "speech.m4a"), 3, "a blue sky above"), (video_paths[0], 9, "blue alone")]))
    results = sqlite3.connect(root / "results.sqlite")
    results.execute("create table results(identity text, kind text, value text)")
    results.execute("insert into results values(?,?,?)", ("12:synthetic", "library-entry", json.dumps({"path": str(root / "expansion.mp4")})))
    vector = base64.b64encode(np.array([.9, .1, 0], dtype=np.float16).tobytes()).decode()
    results.execute("insert into results values(?,?,?)", ("12:synthetic", "picture-vectors", json.dumps({"dims": 3, "frames": [{"v": vector, "t": 4}]})))
    results.commit()
    results.close()
    namespace = sqlite3.connect(root / "namespace.sqlite")
    namespace.execute("create table versions(id text, body text, resource text, valid_to integer, deleted integer)")
    namespace.execute("insert into versions values(?,?,?,?,?)", ("12:synthetic", json.dumps({"identity": "synthetic-b2"}), "@namespace/aliases", 9223372036854775807, 0))
    namespace.commit()
    namespace.close()
    print(json.dumps({"ASSET_INDEX": str(assets), "SSD_INDEX": str(timed), "EXPANSION_RESULTS": str(root / "results.sqlite"), "TRILLION_NAMESPACE": str(root / "namespace.sqlite")}))


def run_cli(script, arguments):
    class Tensor:
        def __init__(self, values): self.values = values
        def float(self): return self
        def numpy(self): return np.asarray(self.values, dtype=np.float32)

    class Model:
        def eval(self): return self
        def encode_text(self, queries): return Tensor([[1, 0, 0] if query != "green field" else [0, 1, 0] for query in queries])

    def create_model(name, pretrained):
        assert name == "ViT-B-32" and pretrained == "openai"
        return Model(), None, None

    sys.modules["torch"] = types.SimpleNamespace(no_grad=contextlib.nullcontext)
    sys.modules["open_clip"] = types.SimpleNamespace(create_model_and_transforms=create_model, get_tokenizer=lambda name: lambda queries: queries)
    sys.argv = [script, *arguments]
    runpy.run_path(script, run_name="__main__")


if sys.argv[1] == "make":
    make_fixture(sys.argv[2])
elif sys.argv[1] == "run":
    run_cli(sys.argv[2], sys.argv[3:])
else:
    raise ValueError("expected make or run")
