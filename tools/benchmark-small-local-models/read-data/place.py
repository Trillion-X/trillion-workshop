"""What the place running these experiments reports, read in one spot (docs/decouple-sweep.md, "The shape").

- device(): DECIDER_DEVICE, else what torch finds here (cuda, then mps, then cpu). Apple's mps is one option, not the rule.
- hf_hub(): the model cache, HF_HUB_CACHE, else HF_HOME/hub, else the Hugging Face default under the home folder.
- snapshot(repo): a downloaded model's snapshot folder in that cache, or a plain error naming the repo.
- reported(name): another checkout or store the place reports (AI_COMMAND_CENTER, TRILLION_CHECKOUT, TRILLION_SITE, ...);
  stops with the name of the missing input instead of guessing a home folder.
"""
import os
import sys
from pathlib import Path


def device():
    if os.environ.get("DECIDER_DEVICE"):
        return os.environ["DECIDER_DEVICE"]
    import torch
    if torch.cuda.is_available():
        return "cuda"
    mps = getattr(torch.backends, "mps", None)
    return "mps" if mps is not None and mps.is_available() else "cpu"


def hf_hub():
    return Path(os.environ.get("HF_HUB_CACHE") or Path(os.environ.get("HF_HOME") or Path.home() / ".cache/huggingface") / "hub")


def snapshot(repo, revision=None):
    snaps = hf_hub() / f"models--{repo.replace('/', '--')}" / "snapshots"
    if revision and (snaps / revision).is_dir():
        return snaps / revision
    found = sorted(snaps.iterdir()) if snaps.is_dir() else []
    if not found:
        sys.exit(f"{repo} is not in this place's model cache ({hf_hub()}); download it there or set HF_HUB_CACHE")
    return found[-1]


def reported(name):
    at = os.environ.get(name)
    if not at:
        sys.exit(f"This place has not said where it keeps {name}. Set {name} to the folder this place holds.")
    return Path(at)
