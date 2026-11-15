"""Compatibility entry for the indexed-start scan owned by the fresh MLX decider core.

The captured shared-start kernel now lives with the active ``_mix`` and is generalized there
to read each row's start from ``state_in[start[row]]``.  Keeping this caller preserves the
package's existing kernel-test seam and external import path.

Upstream MLX-LM MIT license notice for the adapted gated-delta kernel:
MIT License

Copyright © 2023 Apple Inc.

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
"""
import os
import sys

import mlx.core as mx


def available():
    try:
        return mx.metal.is_available()
    except Exception:
        return False


def scan(q, k, v, decay, beta, state_in, start):
    read_data = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "..", "read-data"))
    if read_data not in sys.path:
        sys.path.insert(0, read_data)
    from mlx_decider_core import _indexed_scan
    return _indexed_scan(q, k, v, decay, beta, state_in, start)
