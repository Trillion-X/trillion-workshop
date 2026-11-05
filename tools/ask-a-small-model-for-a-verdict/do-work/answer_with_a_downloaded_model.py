"""decider-2b answers for copy rules that ask a yes/no question (rows with an `ask` key in records/copy-rules.json).

usage:
  decider_layer.py answer [--mode live|cache] < asks.json   [{question, options, text}] -> [{option: p} | null]
  decider_layer.py calibrate <rules.json|verdict-rules.json> [--items items.json --split test [--context-only]] [--fpr 0.05]
                                                            fits t_pass/t_fail for every `ask` row and prints the rows'
                                                            calibration; with --items, only lines of that split count
                                                            (an adapter's training lines must never calibrate it)

An `ask` may name a LoRA adapter for decider-2b: {"adapter": {"path": ..., "blake3": ...}}. The file's BLAKE3 is checked
before loading, the adapter is attached to the one loaded base model with peft, and its BLAKE3 is part of every cache
key, so base answers and adapter answers never mix. Asks without an adapter use the base model. An `ask` may instead
name a downloaded MLX-loadable chat model, {"model": {"mlx": "Qwen/Qwen3-8B"}}: its next-token probabilities over the
options, after the question, are the answer (cached under the model's snapshot). {"model": {"consult": "argon"}} asks a
hosted model through ai-command-center's consult-model.py route (its price reservation and budget), many lines per call. An `ask` may add {"examples": {"items": <path under copy-gate>, "bad_for": <tag>}}: the person's
ruled lines from that items file are shown before the judged line, never including the judged line itself. An ask (or
a calibrate item) may carry `context`, the line's place in its film from unit-context.mjs; it is shown right before the
line and is part of the cache key. `--context-only` calibrates on items whose context was rebuilt from files.

No rule lives here: the question, its options, its failing answer and the laws whose bad examples count as bad lines
(`ask.calibration.bad_from`) are the row's own data in the Trillion owner. calibrate prints the numbers; they go back
into that row through the owner's commit path. The fit is the Workshop's fit-lines (set TRILLION_WORKSHOP to a trillion-workshop
checkout); these are the bars this folder passes it. Thresholds: t_fail fails at most 5% of good lines; t_pass lets through
at most 10% of bad lines; a row is "usable" only with AUC >= 0.75, at least 6 bad lines, recall >= 0.25 at t_fail and
at most 35% of good lines failed or uncertain, where the good-line shares are held out (leave one out)."""
import json
import os
import re
import sys
import time
from pathlib import Path

HERE = Path(__file__).resolve().parent
# The model cache is where this place keeps it: HF_HUB_CACHE, else HF_HOME/hub, else the Hugging Face default under the home folder.
HF_HUB = Path(os.environ.get("HF_HUB_CACHE") or Path(os.environ.get("HF_HOME") or Path.home() / ".cache/huggingface") / "hub")
MODEL = HF_HUB / "models--Mapika--decider-2b/snapshots/b37f7e1ba3fbc9238004cf531fabbee2619973fd"
CACHE = HERE / "calibration/decider-cache.jsonl"
LABELS = HERE / "calibration/labels.jsonl"
FRAME = 'A line of copy:\n"{text}"'          # one frame for every kind of copy; the cached answers use it
BATCH = 8
WORDS = json.loads((HERE / "words.json").read_text())


def consult_route():
    """The declared hosted-model route (it owns price and budget), in the ai-command-center checkout this place reports
    (AI_COMMAND_CENTER). A place that reports none is refused in plain words; no home folder is guessed."""
    if not os.environ.get("AI_COMMAND_CENTER"):
        raise SystemExit(WORDS["place_did_not_report"]["AI_COMMAND_CENTER"])
    return Path(os.environ["AI_COMMAND_CENTER"]) / ".claude/hooks/consult-model.py"


def device(torch):
    """The device this place reports for the model: DECIDER_DEVICE, else what torch finds here (cuda, then mps, then cpu)."""
    if os.environ.get("DECIDER_DEVICE"):
        return os.environ["DECIDER_DEVICE"]
    if torch.cuda.is_available():
        return "cuda"
    mps = getattr(torch.backends, "mps", None)
    return "mps" if mps is not None and mps.is_available() else "cpu"


CONSULT_BATCH = 70
CONSULT_BYTES = 36000   # line text per hosted call, under consult-model.py's max_prompt_bytes (48000) with the question and frame


def consult_parts(group, size):
    """The lines of one question in calls of at most CONSULT_BATCH lines and CONSULT_BYTES of line text (a line with its
    examples can be a few KB, so a byte cap, not only a count, keeps every call under the route's prompt limit)."""
    parts, part, used = [], [], 0
    for i in group:
        if part and (len(part) == CONSULT_BATCH or used + size(i) > CONSULT_BYTES):
            parts.append(part)
            part, used = [], 0
        part.append(i)
        used += size(i)
    return parts + ([part] if part else [])


def blake3_of(path):
    import blake3
    h = blake3.blake3()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


class Answers:
    def __init__(self, mode):
        self.mode, self.model, self.peft, self.cache, self.mlx = mode, None, None, {}, {}
        if CACHE.exists():
            for ln in open(CACHE):
                r = json.loads(ln)
                self.cache[(r.get("a", ""), r["q"], r["c"])] = r["p"]

    def _load(self):
        import torch
        os.nice(10)
        torch.set_num_threads(2)
        sys.path.insert(0, str(MODEL))
        from decider.infer import Decider
        self.model = Decider(str(MODEL), device=device(torch))

    def _use(self, adapter):
        """Attach (once) and select the adapter; None selects the base model."""
        import contextlib
        if adapter is None:
            return self.peft.disable_adapter() if self.peft is not None else contextlib.nullcontext()
        path, b3 = Path(adapter["path"]).expanduser(), adapter["blake3"]
        name = "a" + b3[:16]
        if self.peft is None or name not in self.peft.peft_config:
            got = blake3_of(path / "adapter_model.safetensors")
            if got != b3:
                raise SystemExit(f"adapter {path} has BLAKE3 {got}, the rule names {b3}: refusing to answer with it")
            if self.peft is None:
                from peft import PeftModel
                self.peft = PeftModel.from_pretrained(self.model.m.lm, str(path), adapter_name=name)   # LoRA injected into m.lm in place
            else:
                self.peft.load_adapter(str(path), adapter_name=name)
        self.peft.set_adapter(name)
        return contextlib.nullcontext()

    def _mlx(self, snapshot, context, ask):
        """Option probabilities from a local MLX chat model's next token after the question: the softmax mass on each option
        word (as written and capitalised), renormalised over the options."""
        import mlx.core as mx
        from mlx_lm import load
        if snapshot not in self.mlx:
            self.mlx[snapshot] = load(str(snapshot))
        model, tok = self.mlx[snapshot]
        prompt = f"{context}\n\nQuestion: {ask['question']}\nAnswer with one word: {' or '.join(ask['options'])}."
        text = tok.apply_chat_template([{"role": "user", "content": prompt}], add_generation_prompt=True, tokenize=False, enable_thinking=False)
        probs = mx.softmax(model(mx.array(tok.encode(text))[None])[0, -1].astype(mx.float32))
        ids = {o: {tok.encode(w)[0] for w in (o, o.capitalize())} for o in ask["options"]}
        mass = {o: sum(probs[i].item() for i in ids[o]) for o in ask["options"]}
        total = sum(mass.values())
        return {o: round(v / total, 5) for o, v in mass.items()} if total > 0 else None

    def __call__(self, asks):
        keys = [(engine_of(a), a["question"], context_of(a)) for a in asks]
        out = [self.cache.get(k) for k in keys]
        todo = [i for i, p in enumerate(out) if p is None]
        if todo and self.mode == "live":
            groups = {}
            for i in todo:
                groups.setdefault(keys[i][0], []).append(i)
            with open(CACHE, "a") as f:
                def keep(i, p):
                    out[i] = self.cache[keys[i]] = p
                    f.write(json.dumps({"a": keys[i][0], "q": keys[i][1], "c": keys[i][2], "p": p}, ensure_ascii=False) + "\n")
                for engine, idxs in groups.items():
                    if engine.startswith("consult:"):
                        by_question = {}
                        for i in idxs:
                            by_question.setdefault((asks[i]["question"], tuple(asks[i]["options"])), []).append(i)
                        for (question, options), group in by_question.items():
                            for part in consult_parts(group, lambda i: len(keys[i][2].encode())):
                                for i, p in zip(part, consulted(engine[len("consult:"):], question, list(options), [keys[i][2] for i in part])):
                                    if p is not None:
                                        keep(i, p)
                        continue
                    if engine.startswith("mlx:"):
                        for i in idxs:
                            p = self._mlx(mlx_snapshot(asks[i]["model"]["mlx"]), keys[i][2], asks[i])
                            if p is not None:
                                keep(i, p)
                        continue
                    if self.model is None:
                        self._load()
                    with self._use(asks[idxs[0]].get("adapter") if engine else None):
                        for k in range(0, len(idxs), BATCH):
                            idx = idxs[k:k + BATCH]
                            res = self.model.decide_batch([(keys[i][2], [{"question": asks[i]["question"], "options": asks[i]["options"]}]) for i in idx])
                            for i, r in zip(idx, res):
                                keep(i, {o: round(v, 5) for o, v in r[0]["probs"].items()})
        return out


def engine_of(ask):
    """Cache identity of what answers an ask: an MLX model at its exact snapshot, a decider-2b adapter's BLAKE3, or "" for
    base decider-2b."""
    if ask.get("model", {}).get("mlx"):
        return f"mlx:{ask['model']['mlx']}@{mlx_snapshot(ask['model']['mlx']).name}"
    if ask.get("model", {}).get("consult"):
        return "consult:" + ask["model"]["consult"]
    return (ask.get("adapter") or {}).get("blake3", "")


def consulted(name, question, options, texts):
    """One hosted call through the declared consult-model route (its own price reservation and daily budget) for many
    lines that share a question: the model states each option's probability per numbered line. Lines it does not answer
    stay None (no answer, never a guess)."""
    import subprocess
    import tempfile
    lines = "\n\n".join(f"### Line {n}\n{text}" for n, text in enumerate(texts, 1))
    prompt = (f"Judge each numbered line of film copy below on one question. For every line, give the probability of each "
              f"answer option, in this order: {json.dumps(options)}.\n\nQuestion: {question}\n\n{lines}\n\n"
              f'Reply with only a JSON object mapping each line number to its list of probabilities, e.g. {{"1": [0.9, 0.1]}}.')
    with tempfile.NamedTemporaryFile("w", suffix=".txt", delete=False) as f:
        f.write(prompt)
    run = subprocess.run(["python3", str(consult_route()), "--model", name, "--prompt-file", f.name], capture_output=True, text=True, timeout=300)
    os.unlink(f.name)
    result = json.loads(run.stdout or "{}")
    if result.get("status") != "ok":
        print(f"consult {name}: {result.get('status')} {result.get('reason', '')}", file=sys.stderr)
        return [None] * len(texts)
    found = re.search(r"\{.*\}", result["answer"], re.S)
    table = json.loads(found.group(0)) if found else {}
    out = []
    for n in range(1, len(texts) + 1):
        ps = table.get(str(n))
        total = sum(ps) if isinstance(ps, list) and len(ps) == len(options) and all(isinstance(v, (int, float)) and v >= 0 for v in ps) else 0
        out.append({o: round(v / total, 5) for o, v in zip(options, ps)} if total > 0 else None)
    return out


def mlx_snapshot(repo):
    """The one downloaded snapshot of a Hugging Face repo id; refuses when it is missing or ambiguous (answers are cached
    under the snapshot, so they must never silently change model)."""
    found = sorted((HF_HUB / ("models--" + repo.replace("/", "--")) / "snapshots").glob("*"))
    if len(found) != 1:
        raise SystemExit(f"{repo}: expected exactly one downloaded snapshot under {HF_HUB}, found {len(found)}")
    return found[0]


_ITEMS = {}


def context_of(ask):
    """The text a model reads before the question. With `examples`, the lines the person ruled on (from an items file written by
    verdicts.mjs items) come first, leaving out any line that is, contains or is contained in the judged text, so a line
    is never judged with its own label in view. With `context` (unit-context.mjs DATA), where the line sits in its film
    comes right before the line."""
    spec, text = ask.get("examples"), ask["text"]
    framed = placed(ask.get("context")) + FRAME.format(text=text)
    if not spec:
        return framed
    path = (HERE / spec["items"]).resolve()
    if path not in _ITEMS:
        _ITEMS[path] = json.load(open(path))["items"]
    other = lambda t: t != text and t not in text and text not in t
    sources = spec.get("good_sources", ["person-verdict"])
    bad = [x["text"] for x in _ITEMS[path] if spec["bad_for"] in x["bad_for"] and other(x["text"])]
    good = [x["text"] for x in _ITEMS[path] if x["good"] and x.get("source") in sources and other(x["text"])]
    quote = lambda lines: "\n".join(f'- "{t}"' for t in lines)
    return f"Lines of film copy the author rejected:\n{quote(bad)}\n\nLines of film copy the author approved:\n{quote(good)}\n\n" + framed


def placed(context):
    """A line's film context as plain text, in a fixed order; "" when there is none."""
    if not context:
        return ""
    say = {"before": lambda v: f'Line before it: "{v}"', "after": lambda v: f'Line after it: "{v}"',
           "on_screen_with": lambda v: "Other text on screen with it: " + "; ".join(f'"{s.strip()}"' for s in v),
           "spoken": lambda v: f'Spoken while it is on screen: "{v}"'}
    return "Where this line appears in the film:\n" + "\n".join(say[k](context[k]) for k in say if context.get(k)) + "\n\n"


def sentences(text):
    return [s.strip() for s in re.findall(r"[^.!?]+(?:[.!?]+[\"'”)]*|$)", text) if s.strip()] or [text]


FIT_BARS = {"pass_bad_share_at_most": 0.10, "usable_when": {"auc_at_least": 0.75, "bad_lines_at_least": 6, "recall_at_least": 0.25,
                                                             "good_failed_or_uncertain_at_most": 0.35}}


def fit_lines(bad, good, fpr):
    """The Workshop's fit-lines (tools/ask-a-small-model-for-a-verdict, set TRILLION_WORKSHOP to its checkout) on the bad and good
    lines' scores (None where no answer)."""
    import subprocess
    entry = Path(os.environ["TRILLION_WORKSHOP"]) / "tools/ask-a-small-model-for-a-verdict/do-work/ask-a-small-model.mjs"
    request = {"bad": bad, "good": good, "fail_good_share_at_most": fpr, **FIT_BARS}
    run = subprocess.run(["node", str(entry), "fit-lines"], input=json.dumps(request), capture_output=True, text=True, check=False)
    answer = json.loads(run.stdout.strip().splitlines()[-1])
    if "error" in answer:
        raise SystemExit(f"fit-lines: {answer['error']}")
    return answer["result"]


def calibrate(rules_path, mode="live", items=None, split=None, fpr=0.05, context_only=False):
    doc = json.load(open(rules_path))
    rows = [r for r in doc.get("rules", doc.get("rows", [])) if r.get("ask")]   # ask-rules.json `rules` or verdict-rules.json `rows`
    if items:
        labels = [x for x in json.load(open(items))["items"] if (split is None or x["split"] == split) and (x.get("context") or not context_only)]
        good = [x for x in labels if x["good"]]
    else:
        labels = [json.loads(ln) for ln in open(LABELS)]
        good = [x for x in labels if set(x["sets"]) & {"skill-pass", "person", "captions"}]
    ans = Answers(mode)
    out = {}
    for row in rows:
        a = row["ask"]
        bad = [x for x in labels if set(x["bad_for"]) & set(a.get("calibration", {}).get("bad_from", []))]

        id_of = lambda pair: (id(pair[0]), pair[1])
        ask_of = lambda item, s: {"question": a["question"], "options": a["options"], "text": s, **{k: a[k] for k in ("adapter", "model", "examples") if a.get(k)}, **({"context": item["context"]} if item.get("context") else {})}
        everything = [(item, s) for item in bad + good for s in sentences(item["text"])]
        answered = dict(zip(map(id_of, everything), ans([ask_of(item, s) for item, s in everything])))   # one batch per row

        def score(item):
            ps = [answered[id_of((item, s))] for s in sentences(item["text"])]
            return max((p[a["fail"]] for p in ps if p), default=None)
        # The fit (t_fail, t_pass, AUC, recall, the held-out shares and the usable bar) is the Workshop's fit-lines, the
        # one copy of it; the bars stay this folder's DATA, as the docstring states them.
        found = fit_lines([score(item) for item in bad], [score(item) for item in good], fpr)
        if "auc" in found:   # fitted (an early unseparable answer has only its reason)
            found = {**found, "fpr": found.pop("fail_good_share_at_most", fpr),
                     **({"lines": f"{Path(items).name} split={split}"} if items else {}), "date": time.strftime("%Y-%m-%d")}
        out[row["id"]] = found
    return out


def main(argv):
    if argv[:1] == ["answer"]:
        mode = argv[argv.index("--mode") + 1] if "--mode" in argv else "live"
        json.dump(Answers(mode)(json.load(sys.stdin)), sys.stdout)
        return 0
    if argv[:1] == ["calibrate"] and len(argv) > 1:
        opt = lambda name, default=None: argv[argv.index(name) + 1] if name in argv else default
        print(json.dumps(calibrate(argv[1], opt("--mode", "live"), opt("--items"), opt("--split"), float(opt("--fpr", 0.05)), "--context-only" in argv), indent=1))
        return 0
    print(__doc__)
    return 2


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
