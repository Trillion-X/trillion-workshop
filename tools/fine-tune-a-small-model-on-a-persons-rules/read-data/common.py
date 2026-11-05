"""Shared pieces for training and scoring decider-2b on copy laws: the model, the prompt frame and the scorer.

The prompt is exactly the copy gate's: context 'A line of copy:\n"<text>"', one question, options in the row's own
order (no shuffle), read at the answer slot and softmaxed over the option letters with the stored temperature."""
import os
import sys
from pathlib import Path

import torch

# The model cache and the device are what this place reports (docs/decouple-sweep.md): HF_HUB_CACHE / HF_HOME, and
# DECIDER_DEVICE, else what torch finds here (cuda, then mps, then cpu).
HF_HUB = Path(os.environ.get("HF_HUB_CACHE") or Path(os.environ.get("HF_HOME") or Path.home() / ".cache/huggingface") / "hub")
MODEL = HF_HUB / "models--Mapika--decider-2b/snapshots/b37f7e1ba3fbc9238004cf531fabbee2619973fd"
DEVICE = os.environ.get("DECIDER_DEVICE") or ("cuda" if torch.cuda.is_available() else "mps" if getattr(torch.backends, "mps", None) and torch.backends.mps.is_available() else "cpu")
FRAME = 'A line of copy:\n"{text}"'
LORA_TARGETS = ["q_proj", "k_proj", "v_proj", "o_proj", "in_proj_qkv", "in_proj_z", "out_proj", "gate_proj", "up_proj", "down_proj"]
sys.path.insert(0, str(MODEL))
from decider.infer import Example, Q  # noqa: E402
from decider.model import DecisionModel, collate  # noqa: E402
from decider.prompt import MAX_OPTIONS, build  # noqa: E402


class _Keep:
    def shuffle(self, x):
        pass

    def sample(self, xs, k):
        return xs[:k]


def quiet():
