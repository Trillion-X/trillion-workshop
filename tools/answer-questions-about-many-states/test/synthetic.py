"""Made-up questions, states and a made-up tokenizer for the tests. No real text: every word is drawn from the small
lists below by a seeded generator."""
import json, random, string

NOUNS = ["parcel", "ticket", "invoice", "sensor", "garden", "engine", "lamp", "river", "kettle", "ledger", "orbit", "violin"]
ADJ = ["late", "broken", "urgent", "quiet", "blue", "heavy", "fresh", "missing", "warm", "duplicate", "small", "open"]
VERBS = ["arrived", "failed", "paused", "moved", "glowed", "stopped", "grew", "returned", "rang", "split"]


class SyntheticTokenizer:
    """Runs of capital letters become one token per pair (so A..Z and AA..ZZ are single tokens, as the decider's
    labels need); every other character is its own token. Deterministic, with no files."""
    pad_token_id = 0

    def __init__(self):
        U = string.ascii_uppercase
        self.pairs = {a: 1 + i for i, a in enumerate(U)}
        self.pairs.update({a + b: 27 + 26 * i + j for i, a in enumerate(U) for j, b in enumerate(U)})

    def encode(self, text, add_special_tokens=False):
        out, i = [], 0
        while i < len(text):
            c = text[i]
            if c in string.ascii_uppercase:
                if i + 1 < len(text) and text[i + 1] in string.ascii_uppercase:
                    out.append(self.pairs[text[i:i + 2]]); i += 2
                else:
                    out.append(self.pairs[c]); i += 1
            else:
                out.append(1000 + (ord(c) % 60000)); i += 1
        return out


def questions(n, seed=0):
    """n made-up questions {id: spec}: choice, score and noul in turn."""
    rng = random.Random(seed)
    qs = {}
    for k in range(n):
        noun, adj = rng.choice(NOUNS), rng.choice(ADJ)
        kind = ("choice", "score", "noul")[k % 3]
        if kind == "choice":
            opts = rng.sample(NOUNS, rng.randint(2, 5))
            qs[f"q{k}"] = {"type": "choice", "instructions": f"Which thing is the {adj} one?", "criteria": {o: None for o in opts}}
        elif kind == "score":
            qs[f"q{k}"] = {"type": "score", "instructions": f"How {adj} is the {noun}?", "criteria": ["not at all", "a little", "very"][:rng.randint(2, 3)]}
        else:
            qs[f"q{k}"] = {"type": "noul", "instructions": f"Is the {noun} {adj}?"}
    return qs


def states(n, seed=1, words=(6, 14)):
    rng = random.Random(seed)
    out = []
    for _ in range(n):
        if rng.random() < 0.5:
            out.append(" ".join(f"The {rng.choice(ADJ)} {rng.choice(NOUNS)} {rng.choice(VERBS)}." for _ in range(rng.randint(*words) // 4)))
        else:
            out.append({"item": rng.choice(NOUNS), "state": rng.choice(ADJ), "events": [rng.choice(VERBS) for _ in range(rng.randint(1, 3))]})
    return out


def dumps(x):
    return json.dumps(x, ensure_ascii=False, sort_keys=True)
