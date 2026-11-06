"""The questions-first prompt and its answers, ported from the decider's own code (Mapika/decider-2b, Apache-2.0,
snapshot b37f7e1ba3fbc9238004cf531fabbee2619973fd: decider/prompt.py and decider/systemone.py). Token-for-token
the same layout, so the model reads what it was trained on:

    Question 1: ...\\nOptions:\\n(A) ...\\n\\nQuestion 2: ...          <- the prefix: questions only, computed once
    \\n\\nContext:\\n<state>\\n\\nAnswer 1: (\\nAnswer 2: (              <- the suffix: one per state

`tok` is anything with `encode(text) -> [int]` (no special tokens added).
"""
import json, math, re, string

LETTERS = "ABCDEFGHIJ"
NARROW = len(LETTERS)
MAX_OPTIONS = 255
MAX_CHOICE, MAX_LEVELS = 255, 10
ANNOTATE_MIN = 8
ISOLATED = "{q}\nProposed answer: {level}\nDoes the proposed answer fit?"


class LabelTable:
    """The option labels: A..J for narrow questions, then single-token two-letter labels up to MAX_OPTIONS."""
    def __init__(self, tok):
        names = list(string.ascii_uppercase) + [a + b for a in string.ascii_uppercase for b in string.ascii_uppercase]
        out = []
        for n in names:
            t = tok.encode(n)
            if len(t) == 1:
                out.append((n, t[0]))
            if len(out) == MAX_OPTIONS:
                break
        if len(out) != MAX_OPTIONS or len({i for _, i in out}) != MAX_OPTIONS:
            raise ValueError(f"the tokenizer has {len(out)} single-token option labels; the decider's head needs {MAX_OPTIONS}")
        for j, L in enumerate(LETTERS):
            if tok.encode(L) != [out[j][1]]:
                raise ValueError(f"the tokenizer does not encode {L!r} as its own label token")
        self.names = [n for n, _ in out]
        self.ids = [i for _, i in out]
        self.open_ids = tok.encode("\n(")


def options_ids(tok, labels, options):
    if len(options) <= NARROW:
        return tok.encode("".join(f"\n({LETTERS[j]}) {o}" for j, o in enumerate(options)))
    out = []
    for j, o in enumerate(options):
        out += labels.open_ids + [labels.ids[j]] + tok.encode(f") {o}")
    return out


def prefix_ids(tok, labels, rows):
    """rows: [{"question", "options"}] packed into one prefix (Question 1, Question 2, ... when more than one)."""
    multi = len(rows) > 1
    pre = []
    for k, r in enumerate(rows):
        pre += tok.encode(f"{chr(10) * 2 if k else ''}Question{' ' + str(k + 1) if multi else ''}: {r['question']}\nOptions:") + options_ids(tok, labels, r["options"])
    return pre


CONTEXT_OPENING = "\n\nContext:\n"


def suffix_ids(tok, context, n_slots, max_ctx_tokens, opening=True):
    """-> (ids, slot positions): the context, cut to max_ctx_tokens tokens, then one answer slot per question.
    The opening "\\n\\nContext:\\n" is tokenized on its own (as the decider does), so with opening=False it can be run
    once at the end of the prefix instead: the same tokens either way."""
    ids = (tok.encode(CONTEXT_OPENING) if opening else []) + tok.encode(context)[:max_ctx_tokens]
    slots = []
    for k in range(n_slots):
        ids += tok.encode(f"{chr(10) * 2 if k == 0 else chr(10)}Answer{' ' + str(k + 1) if n_slots > 1 else ''}: (")
        slots.append(len(ids) - 1)
    return ids, slots


# ---- the typed questions (choice, score, noul) and their answers

def _txt(v):
    return v if isinstance(v, str) else json.dumps(v, ensure_ascii=False)


def annotate_indices(x, min_len=ANNOTATE_MIN):
    if isinstance(x, list):
        if len(x) >= min_len:
            return [({"_index": i, **annotate_indices(v, min_len)} if isinstance(v, dict) else {"_index": i, "value": annotate_indices(v, min_len)}) for i, v in enumerate(x)]
        return [annotate_indices(v, min_len) for v in x]
    if isinstance(x, dict):
        return {k: annotate_indices(v, min_len) for k, v in x.items()}
    return x


def render_state(state):
    return state if isinstance(state, str) else json.dumps(annotate_indices(state), ensure_ascii=False)


def render_question(spec):
    t = spec.get("type", "choice")
    ins = _txt(spec.get("instructions", spec.get("question", "")))
    crit = spec.get("criteria", spec.get("options"))
    if not ins:
        raise ValueError("a question needs instructions")
    if t == "choice":
        if isinstance(crit, (list, tuple)):
            crit = {str(c): None for c in crit}
        if not isinstance(crit, dict) or not 2 <= len(crit) <= MAX_CHOICE:
            raise ValueError(f"choice criteria must be a map of 2 to {MAX_CHOICE} options")
        names = list(crit)
        opts = [n if crit[n] in (None, "") else f"{n}: {_txt(crit[n])}" for n in names]
    elif t == "score":
        if isinstance(crit, dict):
            crit = [crit[k] for k in sorted(crit, key=float)]
        if not isinstance(crit, (list, tuple)) or not 2 <= len(crit) <= MAX_LEVELS:
            raise ValueError(f"score criteria must be an ordered list of 2 to {MAX_LEVELS} level descriptions")
        names = list(range(len(crit)))
        opts = [f"{i}: {_txt(c)}" for i, c in enumerate(crit)]
    elif t in ("noul", "bool"):
        names = [False, True]
        c = crit or {}
        f, tr = c.get("false", c.get(False)), c.get("true", c.get(True))
        opts = ["no" if f in (None, "") else f"no: {_txt(f)}", "yes" if tr in (None, "") else f"yes: {_txt(tr)}"]
    else:
        raise ValueError(f"unknown question type {t!r}: use choice, score or noul")
    return dict(question=ins, options=opts, type="noul" if t == "bool" else t, names=names,
                legend=[_txt(c) for c in crit] if t == "score" else None, isolated=bool(spec.get("isolated", True)))


def strip_level_number(text):
    return re.sub(r"^\s*-?\d+\s*:\s*", "", text)


def plan_rows(rqs, isolated=True):
    """One scoring row per question; a score question with isolated levels becomes one yes/no row per level."""
    rows, index = [], []
    for k, r in rqs.items():
        if isolated and r["type"] == "score" and r.get("isolated", True):
            rws = [(ISOLATED.format(q=r["question"], level=strip_level_number(l)), ["no", "yes"]) for l in r["legend"]]
            index.append((k, "iso", len(rows), len(rws)))
            rows += [dict(question=t, options=o) for t, o in rws]
        else:
            index.append((k, "list", len(rows), 1))
            rows.append(dict(question=r["question"], options=r["options"]))
    return rows, index


def certainty(p):
    h = -sum(x * math.log(x) for x in p if x > 0)
    return max(0.0, 1.0 - h / math.log(len(p))) if len(p) > 1 else 1.0


def format_answer(rq, p, nd=4):
    p = [float(x) for x in p[:len(rq["options"])]]
    s = sum(p) or 1.0
    p = [x / s for x in p]
    j = max(range(len(p)), key=p.__getitem__)
    if rq["type"] == "noul":
        return {"type": "noul", "noul": round(p[1], nd)}
    if rq["type"] == "choice":
        return {"type": "choice", "choice": rq["names"][j], "confidence": round(p[j], nd), "certainty": round(certainty(p), nd),
                "probabilities": {n: round(x, nd) for n, x in zip(rq["names"], p)}}
    return {"type": "score", "score": round(sum(i * x for i, x in enumerate(p)), 2), "confidence": round(p[j], nd), "certainty": round(certainty(p), nd),
            "legend": {str(i): d for i, d in enumerate(rq["legend"])}, "probabilities": {str(i): round(x, nd) for i, x in enumerate(p)}}


def assemble(rqs, index, probs):
    """probs: one probability list per row, in plan_rows order -> {question id: answer}."""
    out = {}
    for k, kind, s, n in index:
        if kind == "iso":
            fit = [float(probs[s + j][1]) for j in range(n)]
            tot = sum(fit) or 1e-9
            a = format_answer(rqs[k], [x / tot for x in fit])
            a["level_fit"] = {str(j): round(x, 4) for j, x in enumerate(fit)}
            a["fit_mass"] = round(tot, 4)
            out[k] = a
        else:
            out[k] = format_answer(rqs[k], probs[s])
    return out
