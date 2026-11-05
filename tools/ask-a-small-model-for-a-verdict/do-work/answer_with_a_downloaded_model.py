"""Answers for check rows that ask a yes/no question (rows with an `ask` key in the person's Checks list) from a model kept
on this computer: decider-2b, a LoRA adapter of it, a downloaded MLX chat model, a hosted model through the consult-model
route, or a stand-in that answers from the ask itself.

usage (one JSON request on standard input, { result } or { error } on the last line):
  answer_with_a_downloaded_model.py answer < request.json      { settings, asks: [{question, options, text, ...}], mode?,
                                                                 line_sets? } -> [{option: p} | null]
  answer_with_a_downloaded_model.py calibrate < request.json   { settings, rules: [check rows with ask], lines: [...],
                                                                 lines_name?, split?, context_only?, fpr?, mode?, line_sets? }
                                                                 fits t_pass/t_fail for every `ask` row and answers the rows'
                                                                 calibration; with a split, only lines of that split count
                                                                 (an adapter's training lines must never calibrate it)

`settings` is the person's setting row for this tool (list:settings, record:setting:ask-a-small-model-for-a-verdict~...),
already read: do-work/answer-with-a-downloaded-model.mjs reads it through the records door with tools/settings `setting` and
hands it here. Every model id, snapshot, adapter path, the model cache, the answer cache, the frame and the bars are in it; nothing
about a person is in this file.

An `ask` may name a LoRA adapter for decider-2b: {"adapter": {"name": ..., "blake3": ...}}, its folder being the setting's
`adapters[name]` (or {"path": ..., "blake3": ...} as the old rows held it). The file's BLAKE3 is checked
before loading, the adapter is attached to the one loaded base model with peft, and its BLAKE3 is part of every cache
key, so base answers and adapter answers never mix. Asks without an adapter use the base model. An `ask` may instead
name a downloaded MLX-loadable chat model, {"model": {"mlx": "<repo id>"}}: its next-token probabilities over the
options, after the question, are the answer (cached under the model's snapshot). {"model": {"consult": "<name>"}} asks a
hosted model through the consult-model.py route (its price reservation and budget), many lines per call.
{"model": {"stand_in": {"answers": {<text>: {option: p}}, "otherwise": {option: p} | null}}} answers from the ask itself,
never cached: what a sample run and a test use where no model is. An `ask` may add {"examples": {"items": <set>, "bad_for": <tag>}}: the person's
ruled lines from that set of labelled lines (`line_sets`, read from their Checks list; a path names the set by its file
stem) are shown before the judged line, never including the judged line itself. An ask (or
a calibrate line) may carry `context`, the line's place in its film; it is shown right before the
line and is part of the cache key. `context_only` calibrates on lines whose context was rebuilt from files.

No rule lives here: the question, its options, its failing answer and the laws whose bad examples count as bad lines
(`ask.calibration.bad_from`) are the row's own data in the person's Checks list. calibrate answers the numbers; they go back
into that row through the owner's write path. The fit is this folder's fit-lines (do-work/ask-a-small-model.mjs
fit-lines); the bars it passes are the setting's `fit`: `fail_good_share_at_most` (t_fail fails at most that share of
good lines), `pass_bad_share_at_most` (t_pass lets through at most that share of bad lines) and `usable_when`, where the
good-line shares are held out (leave one out)."""
import json
import os
import re
import sys
import time
from pathlib import Path

HERE = Path(__file__).resolve().parent
HF_HUB = None
MODEL = None
CACHE = None
FRAME = None
BATCH = None
CONSULT_BATCH = None
CONSULT_BYTES = None
FIT_BARS = None
GOOD_SETS = None
GOOD_SOURCES = None
ADAPTERS = {}
MLX_PINS = {}
SETTINGS = {}
LINE_SETS = {}
PLACE_DID_NOT_REPORT = "This place has not said where it keeps {what}. Set {name}, or {setting} in this tool's settings."


class Refused(Exception):
    """A request this tool will not answer, in words that say what to change."""


def setting(name, what):
    if SETTINGS.get(name) in (None, "", [], {}):
        raise Refused(f"settings.{name} is required: {what}")
    return SETTINGS[name]


def configure(settings, line_sets=None):
    """The person's settings for this tool, the one place every model id, path and bar comes from."""
    global HF_HUB, MODEL, CACHE, FRAME, BATCH, CONSULT_BATCH, CONSULT_BYTES, FIT_BARS, GOOD_SETS, GOOD_SOURCES, ADAPTERS, MLX_PINS, SETTINGS, LINE_SETS
    if not isinstance(settings, dict):
        raise Refused("settings is required: the person's setting row for this tool (its `settings` object)")
    SETTINGS, LINE_SETS = settings, dict(line_sets or {})
    # The model cache is where this place keeps it: the setting, else HF_HUB_CACHE, else HF_HOME/hub, else the Hugging Face default under the home folder.
    HF_HUB = Path(settings.get("model_cache_root") or os.environ.get("HF_HUB_CACHE") or Path(os.environ.get("HF_HOME") or Path.home() / ".cache/huggingface") / "hub").expanduser()
    base = settings.get("base_model") or {}
    MODEL = HF_HUB / ("models--" + base["repo"].replace("/", "--")) / "snapshots" / base["snapshot"] if base.get("repo") and base.get("snapshot") else None
    CACHE = Path(settings["cache_file"]).expanduser() if settings.get("cache_file") else None
    FRAME = settings.get("frame")
    BATCH = settings.get("batch")
    CONSULT_BATCH = settings.get("consult_batch")
    CONSULT_BYTES = settings.get("consult_bytes")   # line text per hosted call, under the route's prompt limit with the question and frame
    FIT_BARS = settings.get("fit")
    GOOD_SETS = settings.get("good_sets") or []
    GOOD_SOURCES = settings.get("example_good_sources")
    ADAPTERS = settings.get("adapters") or {}
    MLX_PINS = settings.get("mlx_snapshots") or {}


def consult_route():
    """The declared hosted-model route (it owns price and budget): the setting's consult_route, else the ai-command-center
    checkout this place reports (AI_COMMAND_CENTER). A place that reports none is refused in plain words; no home folder is guessed."""
    if SETTINGS.get("consult_route"):
        return Path(SETTINGS["consult_route"]).expanduser()
    if not os.environ.get("AI_COMMAND_CENTER"):
        raise Refused(PLACE_DID_NOT_REPORT.format(what="ai-command-center", name="AI_COMMAND_CENTER", setting="consult_route"))
    return Path(os.environ["AI_COMMAND_CENTER"]) / ".claude/hooks/consult-model.py"


def device(torch):
    """The device this place reports for the model: the setting, else DECIDER_DEVICE, else what torch finds here (cuda, then mps, then cpu)."""
    if SETTINGS.get("device"):
        return SETTINGS["device"]
    if os.environ.get("DECIDER_DEVICE"):
        return os.environ["DECIDER_DEVICE"]
    if torch.cuda.is_available():
        return "cuda"
    mps = getattr(torch.backends, "mps", None)
    return "mps" if mps is not None and mps.is_available() else "cpu"


def consult_parts(group, size):
    """The lines of one question in calls of at most CONSULT_BATCH lines and CONSULT_BYTES of line text (a line with its
    examples can be a few KB, so a byte cap, not only a count, keeps every call under the route's prompt limit)."""
    most, most_bytes = setting("consult_batch", "how many lines one hosted call may carry"), setting("consult_bytes", "how many bytes of line text one hosted call may carry")
    parts, part, used = [], [], 0
    for i in group:
        if part and (len(part) == most or used + size(i) > most_bytes):
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


def stand_in(ask):
    """A stand-in's answer: the probabilities the ask itself gives for its text, else its `otherwise`, else none."""
    table = ask["model"]["stand_in"]
    p = (table.get("answers") or {}).get(ask["text"], table.get("otherwise"))
    if p is not None and (not isinstance(p, dict) or set(p) != set(ask["options"])):
        raise Refused(f"a stand-in answer must give a probability for each option {ask['options']}")
    return p


class Answers:
    def __init__(self, mode):
        self.mode, self.model, self.peft, self.cache, self.mlx = mode, None, None, {}, {}
        if CACHE is not None and CACHE.exists():
            for ln in open(CACHE):
                r = json.loads(ln)
                self.cache[(r.get("a", ""), r["q"], r["c"])] = r["p"]

    def _load(self):
        import torch
        if MODEL is None:
            raise Refused("settings.base_model is required: the base model's repo id and snapshot ({repo, snapshot}) in the model cache")
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
        path, b3 = adapter_path(adapter), adapter["blake3"]
        name = "a" + b3[:16]
        if self.peft is None or name not in self.peft.peft_config:
            got = blake3_of(path / "adapter_model.safetensors")
            if got != b3:
                raise Refused(f"adapter {path} has BLAKE3 {got}, the rule names {b3}: refusing to answer with it")
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
        prompt = mlx_prompt(context, ask)
        text = tok.apply_chat_template([{"role": "user", "content": prompt}], add_generation_prompt=True, tokenize=False, enable_thinking=False)
        probs = mx.softmax(model(mx.array(tok.encode(text))[None])[0, -1].astype(mx.float32))
        ids = {o: {tok.encode(w)[0] for w in (o, o.capitalize())} for o in ask["options"]}
        mass = {o: sum(probs[i].item() for i in ids[o]) for o in ask["options"]}
        total = sum(mass.values())
        return {o: round(v / total, 5) for o, v in mass.items()} if total > 0 else None

    def __call__(self, asks):
        keys = [(engine_of(a), a["question"], context_of(a)) for a in asks]
        out = [stand_in(a) if k[0] == "stand-in" else self.cache.get(k) for a, k in zip(asks, keys)]
        todo = [i for i, p in enumerate(out) if p is None and keys[i][0] != "stand-in"]
        if todo and self.mode == "live":
            if CACHE is None:
                raise Refused("settings.cache_file is required: where the answers a model gave are kept, so a line is never asked twice")
            groups = {}
            for i in todo:
                groups.setdefault(keys[i][0], []).append(i)
            CACHE.parent.mkdir(parents=True, exist_ok=True)
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
                    batch = setting("batch", "how many lines the base model reads at once")
                    with self._use(asks[idxs[0]].get("adapter") if engine else None):
                        for k in range(0, len(idxs), batch):
                            idx = idxs[k:k + batch]
                            res = self.model.decide_batch([(keys[i][2], [{"question": asks[i]["question"], "options": asks[i]["options"]}]) for i in idx])
                            for i, r in zip(idx, res):
                                keep(i, {o: round(v, 5) for o, v in r[0]["probs"].items()})
        return out


def adapter_path(adapter):
    """An adapter's folder: the one the ask names, else the one the setting keeps under the adapter's name."""
    if adapter.get("path"):
        return Path(adapter["path"]).expanduser()
    if adapter.get("name") in ADAPTERS:
        return Path(ADAPTERS[adapter["name"]]).expanduser()
    raise Refused(f"settings.adapters has no folder for the adapter {adapter.get('name')!r}: add {{\"{adapter.get('name')}\": <its folder>}}")


def mlx_prompt(context, ask):
    """The words an MLX chat model reads: the line in its frame, then the question and its options."""
    return f"{context}\n\nQuestion: {ask['question']}\nAnswer with one word: {' or '.join(ask['options'])}."


def engine_of(ask):
    """Cache identity of what answers an ask: an MLX model at its exact snapshot, a decider-2b adapter's BLAKE3, or "" for
    base decider-2b."""
    if ask.get("model", {}).get("stand_in") is not None:
        return "stand-in"
    if ask.get("model", {}).get("mlx"):
        return f"mlx:{ask['model']['mlx']}@{mlx_snapshot(ask['model']['mlx']).name}"
    if ask.get("model", {}).get("consult"):
        return "consult:" + ask["model"]["consult"]
    return (ask.get("adapter") or {}).get("blake3", "")


def consult_prompt(question, options, texts):
    """One hosted call's words: every numbered line, one question, and the shape of the reply."""
    lines = "\n\n".join(f"### Line {n}\n{text}" for n, text in enumerate(texts, 1))
    return (f"Judge each numbered line of film copy below on one question. For every line, give the probability of each "
            f"answer option, in this order: {json.dumps(options)}.\n\nQuestion: {question}\n\n{lines}\n\n"
            f'Reply with only a JSON object mapping each line number to its list of probabilities, e.g. {{"1": [0.9, 0.1]}}.')


def consult_table(answer, options, count):
    """The hosted reply as one probability table per line; a line it does not answer stays None (no answer, never a guess)."""
    found = re.search(r"\{.*\}", answer, re.S)
    table = json.loads(found.group(0)) if found else {}
    out = []
    for n in range(1, count + 1):
        ps = table.get(str(n))
        total = sum(ps) if isinstance(ps, list) and len(ps) == len(options) and all(isinstance(v, (int, float)) and v >= 0 for v in ps) else 0
        out.append({o: round(v / total, 5) for o, v in zip(options, ps)} if total > 0 else None)
    return out


def consulted(name, question, options, texts):
    """One hosted call through the declared consult-model route (its own price reservation and daily budget) for many
    lines that share a question: the model states each option's probability per numbered line. Lines it does not answer
    stay None (no answer, never a guess)."""
    import subprocess
    import tempfile
    prompt = consult_prompt(question, options, texts)
    with tempfile.NamedTemporaryFile("w", suffix=".txt", delete=False) as f:
        f.write(prompt)
    run = subprocess.run(["python3", str(consult_route()), "--model", name, "--prompt-file", f.name], capture_output=True, text=True, timeout=300)
    os.unlink(f.name)
    result = json.loads(run.stdout or "{}")
    if result.get("status") != "ok":
        print(f"consult {name}: {result.get('status')} {result.get('reason', '')}", file=sys.stderr)
        return [None] * len(texts)
    return consult_table(result["answer"], options, len(texts))


def mlx_snapshot(repo):
    """The one downloaded snapshot of a Hugging Face repo id (the one the setting pins in mlx_snapshots, when it pins one);
    refuses when it is missing or ambiguous (answers are cached under the snapshot, so they must never silently change model)."""
    folder = HF_HUB / ("models--" + repo.replace("/", "--")) / "snapshots"
    found = [folder / MLX_PINS[repo]] if repo in MLX_PINS and (folder / MLX_PINS[repo]).exists() else sorted(folder.glob("*")) if repo not in MLX_PINS else []
    if len(found) != 1:
        raise Refused(f"{repo}: expected exactly one downloaded snapshot{' ' + MLX_PINS[repo] if repo in MLX_PINS else ''} under {HF_HUB}, found {len(found)}")
    return found[0]


def line_set(items):
    """The labelled lines an `examples` names: a set of the person's ruled lines given in line_sets, named by itself or,
    as the old rows name it, by a file path whose stem is the set's name."""
    name = Path(items).stem
    if name not in LINE_SETS:
        raise Refused(f"line_sets has no set {name!r}: give the labelled lines the ask's examples name")
    return LINE_SETS[name]


def context_of(ask):
    """The text a model reads before the question. With `examples`, the lines the person ruled on (from a set of labelled
    lines) come first, leaving out any line that is, contains or is contained in the judged text, so a line
    is never judged with its own label in view. With `context`, where the line sits in its film
    comes right before the line."""
    if FRAME is None:
        raise Refused("settings.frame is required: the words a line is shown in, with {text} where the line goes (cached answers are keyed by it)")
    spec, text = ask.get("examples"), ask["text"]
    framed = placed(ask.get("context")) + FRAME.format(text=text)
    if not spec:
        return framed
    if not spec.get("items"):
        raise Refused("this ask's examples are not a set of labelled lines ({items, bad_for}); inline yes and no examples are for a classifier that reads them (tool:ask-a-small-model-for-a-verdict)")
    items = line_set(spec["items"])
    other = lambda t: t != text and t not in text and text not in t
    sources = spec.get("good_sources") or GOOD_SOURCES or []
    bad = [x["text"] for x in items if spec["bad_for"] in x["bad_for"] and other(x["text"])]
    good = [x["text"] for x in items if x["good"] and x.get("source") in sources and other(x["text"])]
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


def fit_lines(bad, good, fpr):
    """This folder's fit-lines (do-work/ask-a-small-model.mjs fit-lines) on the bad and good lines' scores (None where no
    answer), with the setting's bars."""
    import subprocess
    bars = setting("fit", "the bars a question must clear: {fail_good_share_at_most, pass_bad_share_at_most, usable_when}")
    entry = HERE / "ask-a-small-model.mjs"
    request = {"bad": bad, "good": good, **bars, "fail_good_share_at_most": fpr}
    run = subprocess.run(["node", str(entry), "fit-lines"], input=json.dumps(request), capture_output=True, text=True, check=False)
    answer = json.loads(run.stdout.strip().splitlines()[-1])
    if "error" in answer:
        raise Refused(f"fit-lines: {answer['error']}")
    return answer["result"]


def ask_of(a, item, s):
    """The ask a calibration line is put as: the row's question about one sentence of the line, with its context."""
    return {"question": a["question"], "options": a["options"], "text": s, **{k: a[k] for k in ("adapter", "model", "examples") if a.get(k)}, **({"context": item["context"]} if item.get("context") else {})}


def calibrate(rules, lines, mode="live", lines_name=None, split=None, fpr=None, context_only=False):
    rows = [r for r in rules if r.get("ask")]
    fpr = fpr if fpr is not None else setting("fit", "the bars a question must clear").get("fail_good_share_at_most")
    if lines and all("good" in x for x in lines):   # ruled lines, each saying good or bad
        labels = [x for x in lines if (split is None or x["split"] == split) and (x.get("context") or not context_only)]
        good = [x for x in labels if x["good"]]
    else:   # labelled lines by set, good when a set the setting names as good holds them
        labels = list(lines)
        good = [x for x in labels if set(x["sets"]) & set(setting("good_sets", "the sets whose lines count as good"))]
    ans = Answers(mode)
    out = {}
    for row in rows:
        a = row["ask"]
        bad = [x for x in labels if set(x["bad_for"]) & set(a.get("calibration", {}).get("bad_from", []))]

        id_of = lambda pair: (id(pair[0]), pair[1])
        everything = [(item, s) for item in bad + good for s in sentences(item["text"])]
        answered = dict(zip(map(id_of, everything), ans([ask_of(a, item, s) for item, s in everything])))   # one batch per row

        def score(item):
            ps = [answered[id_of((item, s))] for s in sentences(item["text"])]
            return max((p[a["fail"]] for p in ps if p), default=None)
        # The fit (t_fail, t_pass, AUC, recall, the held-out shares and the usable bar) is this folder's fit-lines, the
        # one copy of it; the bars are the person's setting.
        found = fit_lines([score(item) for item in bad], [score(item) for item in good], fpr)
        if "auc" in found:   # fitted (an early unseparable answer has only its reason)
            found = {**found, "fpr": found.pop("fail_good_share_at_most", fpr),
                     **({"lines": f"{lines_name} split={split}"} if lines_name and split is not None else {}), "date": time.strftime("%Y-%m-%d")}
        out[row["id"]] = found
    return out


def run(action, request):
    configure(request.get("settings"), request.get("line_sets"))
    mode = request.get("mode", "live")
    if mode not in ("live", "cache"):
        raise Refused("mode must be live (ask a model for what is not cached) or cache (answer only from the cache)")
    if action == "answer":
        if not isinstance(request.get("asks"), list):
            raise Refused("asks is required: [{question, options, text, adapter?, model?, examples?, context?}]")
        return Answers(mode)(request["asks"])
    if action == "calibrate":
        if not isinstance(request.get("rules"), list) or not isinstance(request.get("lines"), list):
            raise Refused("rules and lines are required: the check rows with an ask, and the labelled lines that calibrate them")
        return calibrate(request["rules"], request["lines"], mode, request.get("lines_name"), request.get("split"), request.get("fpr"), bool(request.get("context_only")))
    raise Refused("the action must be answer or calibrate")


def main(argv):
    try:
        request = json.loads(sys.stdin.read() or "{}")
        print(json.dumps({"result": run(argv[0] if argv else None, request)}, ensure_ascii=False))
        return 0
    except json.JSONDecodeError:
        print(json.dumps({"error": "the request must be one JSON object on standard input"}))
    except Refused as refused:
        print(json.dumps({"error": str(refused)}))
    return 1


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
