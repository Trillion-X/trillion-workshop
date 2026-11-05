"""A stand-in for sentence-transformers, so the model steps run with no model files: a sentence's vector counts its words
(each word to one of 32 places by a fixed checksum), and the cross-encoder's score is the share of the question's words the
passage holds. Same words, same numbers, every run. Each model name asked for is logged to $STAND_IN_LOG when it is set."""
import os
import re
import zlib

import numpy as np

PLACES = 32


def _words(text):
    return re.findall(r"[a-z0-9']+", text.lower())


def _log(name):
    if os.environ.get("STAND_IN_LOG"):
        with open(os.environ["STAND_IN_LOG"], "a") as log:
            log.write(name + "\n")


class SentenceTransformer:
    def __init__(self, name):
        _log(name)

    def encode(self, texts, batch_size=32, normalize_embeddings=False, show_progress_bar=False):
        out = np.zeros((len(texts), PLACES), dtype=np.float32)
        for row, text in enumerate(texts):
            for word in _words(text.replace("Represent this sentence for searching relevant passages: ", "")):
                out[row, zlib.crc32(word.encode()) % PLACES] += 1
        if normalize_embeddings:
            norms = np.linalg.norm(out, axis=1, keepdims=True)
            out = out / np.where(norms == 0, 1, norms)
        return out


class CrossEncoder:
    def __init__(self, name):
        _log(name)

    def predict(self, pairs, activation_fn=None):
        scores = []
        for question, passage in pairs:
            asked, held = set(_words(question)), set(_words(passage))
            scores.append(len(asked & held) / len(asked) if asked else 0.0)
        return np.array(scores, dtype=np.float32)
