"""Compatibility import for callers of the former ``questions_first.engine`` module.

The batched questions-first computation lives in ``read-data/mlx_decider_core.py``. This module owns no scoring,
cache or batching logic.
"""
import os
import sys

_READ_DATA = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "..", "read-data"))
if _READ_DATA not in sys.path:
    sys.path.insert(0, _READ_DATA)

from mlx_decider_core import MlxDeciderCore, Prepared  # noqa: E402

QuestionsFirst = MlxDeciderCore

__all__ = ["MlxDeciderCore", "QuestionsFirst", "Prepared"]
