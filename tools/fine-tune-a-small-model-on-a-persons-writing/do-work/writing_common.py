"""Shared pieces for the writing fine-tune: the request helpers of the rules fine-tune (its public read-data/common.py,
which loads no model when imported), the one way a case is put into words for the model, and the BLAKE3 of a file.

A case is {channel, context: [{who: "them" | "him", words}], draft}: the thread before the person's message and a plain
draft of what they mean to say. Training rows and every later ask use this same rendering, so the input the adapter is
trained on is the input it is asked with."""
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "fine-tune-a-small-model-on-a-persons-rules" / "read-data"))
from common import Refused, need, rows_of, run, with_settings  # noqa: E402,F401

FOLDER = "fine-tune-a-small-model-on-a-persons-writing"


def render(frame, system, case, context_lines):
    """The chat messages for one case: the person's system words (may hold {channel}) and the frame (holds {thread}
    and {draft}). The thread is the last context_lines lines, one per line as "them: ..." or "me: ..."."""
    for key in ("{thread}", "{draft}"):
        if key not in frame:
            raise Refused(f"frame must hold {key}")
    context = case.get("context") or []
    if not isinstance(context, list):
        raise Refused("a case's context must be a list of {who, words}")
    lines = []
    for c in context[-context_lines:] if context_lines else []:
        who = "me" if c.get("who") in ("him", "me") else "them"
        lines.append(f"{who}: {str(c.get('words', '')).strip()}")
    user = frame.replace("{thread}", "\n".join(lines) or "(none)").replace("{draft}", str(case["draft"]).strip())
    return [{"role": "system", "content": system.replace("{channel}", str(case.get("channel", "")))},
            {"role": "user", "content": user}]


def blake3_of(path):
    """The BLAKE3 of a file's bytes, read in pieces."""
    import blake3
    h = blake3.blake3()
    with open(path, "rb") as f:
        for piece in iter(lambda: f.read(1 << 20), b""):
            h.update(piece)
    return h.hexdigest()
