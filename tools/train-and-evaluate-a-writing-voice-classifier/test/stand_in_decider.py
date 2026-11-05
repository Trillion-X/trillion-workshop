"""Stand-ins for the decider model frame, so the trainer, scorer and packer load and run their DATA checks here.

The real frame is the person's: `common.py` (the fine-tune folder) and the `decider` package inside the pinned model
snapshot, on the computer that trains. These stand-ins load no weights and answer deterministically; nothing here is a
model. `install()` puts them in sys.modules before a test loads a script, and puts a stand-in `b3sum` (the Python
blake3 module, the same digits) on PATH when the program is missing.
"""
from __future__ import annotations

import os
import shutil
import stat
import sys
import tempfile
import types
from pathlib import Path


class Example:
    def __init__(self, state, questions):
        self.state, self.questions = state, questions


class Q:
    def __init__(self, question, options, gold):
        self.question, self.options, self.gold = question, list(options), gold


def render_question(spec):
    """The question text and option texts a stand-in model would read: the instructions and each named criterion."""
    criteria = spec.get("criteria") or {}
    options = [name if description is None else f"{name}: {description}" for name, description in criteria.items()]
    return {"question": spec["instructions"], "names": list(criteria), "options": options}


def render_state(text):
    return text


def plan_rows(questions, _shuffle):
    return [{"question": rendered["question"], "options": rendered["options"]} for rendered in questions.values()], None



def build(example, tokenizer, _rng=None, max_options=8, max_ctx_tokens=4097, layout="state_first", **_):
    text = "Context:\n" + example.state + "".join(f"\n{q.question}\n" + "\n".join(q.options) for q in example.questions)
    return {"ids": tokenizer.encode(text, add_special_tokens=False), "gold": example.questions[0].gold}


class Tokenizer:
    pad_token_id = 0

    @classmethod
    def from_pretrained(cls, _path):
        return cls()

    def encode(self, text, add_special_tokens=False):
        """One id per whitespace-separated word, by its length: deterministic and dependency-free."""
        return [len(word) for word in text.split()]


class _Keep:
    def shuffle(self, _values):
        return None

    def sample(self, values, count):
        return values[:count]


def _module(name, **attributes):
    module = types.ModuleType(name)
    module.__dict__.update(attributes)
    return module


def install():
    common = _module("common", MODEL=Path("/stand-in/decider-snapshot"), DEVICE="cpu", MAX_OPTIONS=8,
                     LORA_TARGETS=["q_proj", "v_proj"], FRAME='A line of copy:\n"{text}"', _Keep=_Keep, build=build,
                     collate=lambda items, pad: {"items": items, "pad": pad}, quiet=lambda: None,
                     temperature=lambda: 1.0, load=None, DecisionModel=None)
    decider = _module("decider")
    sys.modules.setdefault("common", common)
    sys.modules.setdefault("decider", decider)
    sys.modules.setdefault("decider.infer", _module("decider.infer", Example=Example, Q=Q))
    sys.modules.setdefault("decider.systemone", _module("decider.systemone", render_question=render_question,
                                                         render_state=render_state, plan_rows=plan_rows))
    sys.modules.setdefault("decider.prompt", _module("decider.prompt", build=build, MAX_OPTIONS=8))
    sys.modules.setdefault("transformers", _module("transformers", AutoTokenizer=Tokenizer))
    if not shutil.which("b3sum"):
        _b3sum_on_path()


def _b3sum_on_path():
    folder = Path(tempfile.mkdtemp(prefix="stand-in-b3sum-"))
    program = folder / "b3sum"
    program.write_text(
        f"#!{sys.executable}\n"
        "import sys, blake3\n"
        "args = [a for a in sys.argv[1:] if a != '--no-names']\n"
        "names = '--no-names' not in sys.argv\n"
        "if not args:\n"
        "    print(blake3.blake3(sys.stdin.buffer.read()).hexdigest())\n"
        "for path in args:\n"
        "    digest = blake3.blake3(open(path, 'rb').read()).hexdigest()\n"
        "    print(f'{digest}  {path}' if names else digest)\n")
    program.chmod(program.stat().st_mode | stat.S_IXUSR)
    os.environ["PATH"] = f"{folder}{os.pathsep}{os.environ.get('PATH', '')}"
