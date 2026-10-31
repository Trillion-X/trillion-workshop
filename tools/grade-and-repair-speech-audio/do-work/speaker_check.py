"""Is this span the voice of the clone reference? Cosine similarity of wespeaker embeddings.

  speaker_check.py <reference.wav> [<span.wav> ...]    prints similarity per file
A span is cloned only when its similarity to the reference reaches the settings' speaker_similarity_min, so
nobody else's voice is ever cloned: the reference must be a recording of the person who agreed to be cloned.
"""
import sys

import librosa
import numpy as np
import soundfile as sf
import torch
from pyannote.audio import Inference, Model

_inference = None


def embed(path):
    global _inference
    if _inference is None:
        _inference = Inference(Model.from_pretrained("pyannote/wespeaker-voxceleb-resnet34-LM"), window="whole")
        _inference.to(torch.device("cpu"))
    x, sr = sf.read(path, dtype="float32", always_2d=True)
    x = librosa.resample(x.mean(axis=1), orig_sr=sr, target_sr=16000)
    return np.asarray(_inference({"waveform": torch.from_numpy(x)[None, :], "sample_rate": 16000})).reshape(-1)


def similarity(a, b):
    ea, eb = embed(a), embed(b)
    return float(ea @ eb / (np.linalg.norm(ea) * np.linalg.norm(eb)))


if __name__ == "__main__":
    for p in sys.argv[2:]:
        print(round(similarity(sys.argv[1], p), 3), p)
