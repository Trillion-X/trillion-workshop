"""Fresh classifier-program entry point for the answer-many controller.

Keep the established command actions and JSON line protocol.  The controller
owns admission and record semantics; the active numerical forward is owned by
``read-data/mlx_decider_core.py`` and reached through the weight backend.
"""
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
if HERE not in sys.path:
    sys.path.insert(0, HERE)

from answer_many_states import main  # noqa: E402


if __name__ == "__main__":
    sys.exit(main(sys.argv))
