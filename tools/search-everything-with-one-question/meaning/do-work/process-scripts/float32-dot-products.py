"""One arithmetic primitive for already-normalized source vectors, with no I/O or ranking."""
import json
import sys
import numpy as np

header = json.loads(sys.stdin.buffer.readline())
dimensions, rows = header["dimensions"], header["rows"]
if not isinstance(dimensions, int) or dimensions < 1 or not isinstance(rows, int) or rows < 0:
    raise ValueError("dimensions must be positive and rows nonnegative")
values = np.frombuffer(sys.stdin.buffer.read(), dtype="<f4")
if values.size != (rows + 1) * dimensions:
    raise ValueError("query and stored vector dimensions must agree")
query = values[:dimensions]
vectors = values[dimensions:].reshape(rows, dimensions)
scores = vectors @ query
if not np.isfinite(scores).all():
    raise ValueError("source dot products must be finite")
sys.stdout.buffer.write(scores.astype("<f4").tobytes())
