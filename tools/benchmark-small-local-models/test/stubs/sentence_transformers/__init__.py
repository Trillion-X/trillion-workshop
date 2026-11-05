"""Stand-in sentence-transformers: a cross-encoder scores a pair by the words they share, and a bi-encoder gives word
vectors (stand_in_words)."""
import math

from stand_in_words import Tensor, shared, vector


class CrossEncoder:
    def __init__(self, name, device=None):
        self.name = name

    def predict(self, pairs, batch_size=None):
        return [float(shared(a, b)) for a, b in pairs]


class SentenceTransformer:
    def __init__(self, name, device=None):
        self.name = name

    def encode(self, texts, normalize_embeddings=False, convert_to_tensor=False):
        rows = [vector(t) for t in texts]
        if normalize_embeddings:
            rows = [[x / math.sqrt(sum(y * y for y in r)) for x in r] for r in rows]
        return Tensor(rows)
