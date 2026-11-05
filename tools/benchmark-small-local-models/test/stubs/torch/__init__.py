"""Stand-in torch for the tests: no gradients to turn off, a made-up MPS memory figure, and the few tensor functions the
scripts call, over stand_in_words.Tensor."""
import contextlib
import math
import types

from stand_in_words import Tensor


@contextlib.contextmanager
def no_grad():
    yield


def _rows(t):
    return t.rows if isinstance(t, Tensor) else t


def _normalize(t, dim=-1):
    rows = _rows(t)
    one = lambda r: [x / (math.sqrt(sum(y * y for y in r)) or 1.0) for x in r]
    return Tensor([one(r) for r in rows] if rows and isinstance(rows[0], list) else one(rows))


def softmax(t, dim=-1):
    rows = _rows(t)
    top = max(rows)
    e = [math.exp(x - top) for x in rows]
    return Tensor([x / sum(e) for x in e])


def argsort(t, descending=False):
    rows = _rows(t)
    return Tensor(sorted(range(len(rows)), key=lambda j: -rows[j] if descending else rows[j]))


nn = types.SimpleNamespace(functional=types.SimpleNamespace(normalize=_normalize))
mps = types.SimpleNamespace(synchronize=lambda: None, driver_allocated_memory=lambda: 2_000_000_000)
cuda = types.SimpleNamespace(is_available=lambda: False, memory_allocated=lambda: 0)
backends = types.SimpleNamespace(mps=types.SimpleNamespace(is_available=lambda: False))
