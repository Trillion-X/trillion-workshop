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


# The decider lane's speed set (ai-command-center measure_decider_batches.py, measured on the M5 Max 2026-11-05:
# 303 x 132 in 121.0 s), made up from these lists by a fixed seed, so this tool's numbers compare with that build's.
CHECKS = [
    "use the passive voice", "contain a number written as digits", "name a real person", "end with a question",
    "use a word longer than twelve letters", "repeat a word within five words", "start with a conjunction",
    "use an adverb ending in -ly", "contain dialogue", "mention a colour", "mention a time of day",
    "use a cliche", "contain a list of three", "use the first person", "use the second person",
    "contain a simile", "contain a metaphor", "mention weather", "mention a sound", "mention a smell",
    "use a semicolon", "use an exclamation", "use a filler word such as 'very' or 'really'",
    "contain a sentence fragment", "change tense mid-sentence", "use a technical term", "mention money",
    "describe a facial expression", "name a place", "use alliteration",
]
FRAMES = [
    "Does the line {c}?", "Is it true that this line does {c}?", "Rule check: does the text {c}?",
    "Would an editor say this line does {c}?", "Style rule: the line must not {c}. Does it {c}?",
    "Answer yes if the line does {c}, otherwise no.", "Copy-edit pass: does this sentence {c}?",
    "Does any clause of the line {c}?", "Taken as a whole, does the line {c}?",
    "Read the line once. Does it {c}?", "Strictly, does the line {c}?",
]
SUBJECTS = ["The old ferry", "A tired clerk", "Our neighbour", "The committee", "Seven gulls", "The tall lamp",
            "Her brother", "The quiet river", "A stray dog", "The night shift", "My uncle", "The orchard"]
LINE_VERBS = ["waited by", "drifted past", "argued about", "painted", "counted", "forgot", "carried", "repaired",
              "listened to", "circled", "described", "measured"]
OBJECTS = ["the broken gate", "a pile of letters", "the harbour lights", "twelve green bottles", "the ledger",
           "a cold kettle", "the morning train", "an empty chair", "the north field", "a paper map"]
TAILS = ["while the rain kept falling", "before anyone noticed", "and then laughed quietly",
         "because nobody else would", "at exactly 6:40", "as the bells rang out", "without saying a word",
         "until the lamps went dim", "and the smell of smoke lingered", "though it was really very late"]


def rule_questions(count, seed=7):
    rng = random.Random(seed)
    pairs = [(f, c) for f in FRAMES for c in CHECKS]
    rng.shuffle(pairs)
    out = {}
    for i, (frame, check) in enumerate(pairs[:count]):
        spec = {"type": "noul", "instructions": frame.format(c=check)}
        if i % 3 == 0:
            spec["criteria"] = {"true": f"the line does {check}", "false": f"the line does not {check}"}
        out[f"rule-{i:03d}"] = spec
    return out


def rule_lines(count, seed=11):
    rng = random.Random(seed)
    lines = []
    for _ in range(count):
        parts = [rng.choice(SUBJECTS), rng.choice(LINE_VERBS), rng.choice(OBJECTS)]
        for _ in range(rng.randint(0, 2)):
            parts.append(rng.choice(TAILS))
        lines.append(" ".join(parts) + rng.choice([".", ".", "!", "?"]))
    return lines
