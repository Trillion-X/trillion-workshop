"""Answer a fixed set of questions about many states with a questions-first classifier, in bulk, on the person's Mac.

    python3 -I tools/answer-questions-about-many-states/do-work/answer_many_states.py <action> [--request '<json>'] < request.json

The program `read-data/bulk-answer.mjs` starts for a row's run. It never reaches the person's records itself: the run
reads the model row, the question set, the settings and the states through its records door and hands their values
here on standard input, and it writes what comes back as rows. Nothing is kept on disk by this program.

    get-ready  {model}                                 fetch the model row's weights, check them, name them:
                                                       `{"result": ...}` or `{"error": "..."}` as the last line
    work       {model, questions, states, settings}    answer every state, as JSON lines on standard output:
                                                         {"checked": {"states": n}}        the request is good
                                                         {"answered": [{"state": i, "answers": {...}}, ...]}
                                                                                           after each batch
                                                         {"result": {status, states_done, states, classifier_answers_as,
                                                                     seconds}}             the last line
                                                         {"error": "..."}                  a refusal or a failure
                                                       SIGTERM (or SIGINT) stops it after the batch in hand; the
                                                       states already answered were printed, and status is cancelled.

The model is data: a row naming its classifier family (`classifier`) and where its weights are (`weights`:
{"folder": path} or {"hugging_face": {"repo", "revision"}}). The families this code runs are FAMILIES below. The
settings come from the person's rows too; none has a default here.
"""
import json, os, signal, sys, time

HERE = os.path.dirname(os.path.abspath(__file__))
if HERE not in sys.path:
    sys.path.insert(0, HERE)

SETTINGS = {
    "layout": "independent (one row per question: no question sees another, the decider's default) or packed (all "
              "questions in one prefix: one row per state, several times fewer tokens)",
    "dtype": "the weights' dtype on the GPU: bfloat16 (the model's own) or float32",
    "tokens_per_batch": "how many tokens one GPU pass may hold (larger is faster until memory runs out)",
    "max_state_tokens": "the most tokens of one state the model reads; a longer state is cut there, as the decider does",
    "page_bytes": "the most bytes of answers one answer row holds (at most 56000, so a row and its run row fit one records-door "
                  "message)",
}
MOST_PAGE_BYTES = 56000
MODEL_FILES = ("config.json", "decider_config.json", "tokenizer.json", "tokenizer_config.json")


class Refusal(Exception):
    pass


# ---- identities

def identity_of_bytes(data):
    import blake3
    return "1f:" + blake3.blake3(data).hexdigest()


def canonical(value):
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":")).encode("utf-8")


def identity_of_files(folder, names):
    """The identity of a model folder: BLAKE3 of the sorted list of (file name, size, BLAKE3 of its bytes)."""
    import blake3
    listing = []
    for name in sorted(names):
        h = blake3.blake3()
        with open(os.path.join(folder, name), "rb") as f:
            for block in iter(lambda: f.read(1 << 24), b""):
                h.update(block)
        listing.append([name, os.path.getsize(os.path.join(folder, name)), h.hexdigest()])
    return identity_of_bytes(canonical(listing)), listing


# ---- the model row

def need(obj, field, where):
    if not isinstance(obj, dict) or field not in obj:
        raise Refusal(f"{where} needs `{field}`")
    return obj[field]


def model_folder(model, fetch):
    """-> the local folder of the model row's weights. fetch=False only finds them (a run never downloads)."""
    weights = need(model, "weights", "the model row")
    if "folder" in weights:
        folder = os.path.expanduser(weights["folder"])
        if not os.path.isdir(folder):
            raise Refusal(f"the model row's weights folder {folder} does not exist")
        return folder
    hf = weights.get("hugging_face")
    if not isinstance(hf, dict) or not hf.get("repo") or not hf.get("revision"):
        raise Refusal("the model row's `weights` needs {\"folder\": path} or {\"hugging_face\": {\"repo\", \"revision\"}} "
                      "(a pinned revision, so the weights cannot change under the row)")
    try:
        from huggingface_hub import snapshot_download
    except ImportError:
        raise Refusal("huggingface_hub is not installed: run the row's get_it commands")
    try:
        return snapshot_download(hf["repo"], revision=hf["revision"], local_files_only=not fetch,
                                 allow_patterns=["*.json", "*.safetensors", "*.py", "*.txt", "*.model"])
    except Exception as e:  # noqa: BLE001 - the hub's own error says what was wrong; name it and what to do
        if not fetch:
            raise Refusal(f"the weights of {hf['repo']} at {hf['revision']} are not on this computer yet: run get-ready first")
        raise Refusal(f"could not fetch {hf['repo']} at {hf['revision']} ({type(e).__name__}: {e}). A gated model needs "
                      f"`huggingface-cli login` on this computer with an account that accepted its terms")


def family(model):
    name = need(model, "classifier", "the model row")
    if name not in FAMILIES:
        raise Refusal(f"this tool runs the classifier families {sorted(FAMILIES)}, not {name!r}")
    return FAMILIES[name]


# ---- the questions-first decider family

class QuestionsFirstDecider:
    """A Qwen3.5 hybrid decider with the questions-first layout (decider.schema(questions).batch(states)): weights, tokenizer,
    config.json and decider_config.json in one folder."""

    @staticmethod
    def check(folder):
        missing = [n for n in MODEL_FILES if not os.path.exists(os.path.join(folder, n))]
        weights = sorted(n for n in os.listdir(folder) if n.endswith(".safetensors"))
        if missing or not weights:
            raise Refusal(f"the model folder {folder} lacks {missing + ([] if weights else ['*.safetensors'])}")
        from questions_first.backbone import load_config
        try:
            load_config(folder)
        except ValueError as e:
            raise Refusal(str(e))
        return list(MODEL_FILES) + weights

    @staticmethod
    def answer(folder, questions, states, settings, on_answers, should_stop, timings):
        """Calls on_answers([(state index, {question id: answer})]) after each batch; -> the name the answers carry."""
        import mlx.core as mx
        from questions_first import prompt as P
        from questions_first.backbone import Backbone
        from questions_first.engine import QuestionsFirst
        from questions_first.tokenizer import load_tokenizer
        with open(os.path.join(folder, "decider_config.json")) as f:
            dc = json.load(f)
        independent = settings["layout"] == "independent"
        t = time.perf_counter()
        bb = Backbone.load(folder, getattr(mx, settings["dtype"]))
        tok, pad = load_tokenizer(folder)
        temperature = float(dc.get("temperature_schema_first", dc.get("temperature", 1.0)))
        qf = QuestionsFirst(bb, tok, pad, temperature=temperature, tokens_per_batch=settings["tokens_per_batch"])
        timings["load"] = time.perf_counter() - t
        rqs = {k: P.render_question(v) for k, v in questions.items()}
        rows, index = P.plan_rows(rqs, bool(dc.get("isolated_levels", False)) and independent)
        t = time.perf_counter()
        h = qf.prepare(rows, independent=independent)
        timings["prepare"] = time.perf_counter() - t
        t = time.perf_counter()
        qf.score(h, [P.render_state(s) for s in states], max_ctx_tokens=settings["max_state_tokens"], should_stop=should_stop,
                 on_done=lambda fresh, probs: on_answers([(s, P.assemble(rqs, index, [list(r) for r in probs[s]])) for s in fresh]))
        timings["answer"] = time.perf_counter() - t
        return "decider-" + str(dc.get("version", "dev"))


FAMILIES = {"questions-first-decider": QuestionsFirstDecider}


# ---- requests

def check_questions(questions):
    if not isinstance(questions, dict) or not questions:
        raise Refusal("`questions` must be a map {question id: {type, instructions, criteria?}} with at least one question")
    from questions_first import prompt as P
    for k, spec in questions.items():
        try:
            P.render_question(spec)
        except (ValueError, AttributeError) as e:
            raise Refusal(f"question {k!r}: {e}")


def check_settings(settings):
    if not isinstance(settings, dict):
        raise Refusal("`settings` must be an object with " + ", ".join(SETTINGS))
    for field, meaning in SETTINGS.items():
        if field not in settings:
            raise Refusal(f"`settings.{field}` is missing: {meaning}")
    if settings["layout"] not in ("independent", "packed"):
        raise Refusal("`settings.layout` must be independent or packed")
    if settings["dtype"] not in ("bfloat16", "float32"):
        raise Refusal("`settings.dtype` must be bfloat16 or float32")
    for field in ("tokens_per_batch", "max_state_tokens", "page_bytes"):
        if not isinstance(settings[field], int) or isinstance(settings[field], bool) or settings[field] < 1:
            raise Refusal(f"`settings.{field}` must be a positive whole number")
    if settings["page_bytes"] > MOST_PAGE_BYTES:
        raise Refusal(f"`settings.page_bytes` must be at most {MOST_PAGE_BYTES}, so an answer row fits one records-door message")


def say(line, out):
    out.write(json.dumps(line, ensure_ascii=False) + "\n")
    out.flush()


# ---- actions

def get_ready(request):
    model = need(request, "model", "the request")
    fam = family(model)
    folder = model_folder(model, fetch=True)
    names = fam.check(folder)
    ident, listing = identity_of_files(folder, names)
    return {"model": model.get("id"), "classifier": model["classifier"], "identity": ident,
            "files": [{"name": n, "bytes": b, "blake3": h} for n, b, h in listing], "ready": True}


def check(request):
    """-> (family, model folder, states) for a work request, or a Refusal naming what to change."""
    model = need(request, "model", "the request")
    fam = family(model)
    check_questions(need(request, "questions", "the request"))
    states = need(request, "states", "the request")
    if not isinstance(states, list) or not states:
        raise Refusal("`states` must be a list of at least one state (text or JSON)")
    check_settings(need(request, "settings", "the request"))
    folder = model_folder(model, fetch=False)
    fam.check(folder)
    return fam, folder, states


def work(request, out=None, stop=None):
    """Answer every state of the request, printing each batch's answers as they come; stop() is asked before each batch."""
    out = out or sys.stdout
    stop = stop or (lambda: False)
    fam, folder, states = check(request)
    n = len(states)
    say({"checked": {"states": n}}, out)
    begun = time.perf_counter()
    timings = {}
    done = set()

    def on_answers(answered):
        fresh = [(s, a) for s, a in answered if s not in done]
        done.update(s for s, _ in fresh)
        if fresh:
            say({"answered": [{"state": s, "answers": a} for s, a in fresh]}, out)

    name = fam.answer(folder, request["questions"], states, request["settings"], on_answers, stop, timings)
    timings["wall"] = time.perf_counter() - begun
    return {"status": "finished" if len(done) == n else "cancelled", "states_done": len(done), "states": n,
            "classifier_answers_as": name, "seconds": {k: round(v, 3) for k, v in timings.items()}}


ACTIONS = ("get-ready", "work")


def main(argv, stdin=None, out=None):
    stdin = stdin or sys.stdin
    out = out or sys.stdout
    given = None
    if len(argv) == 4 and argv[2] == "--request":
        given = argv[3]
    elif len(argv) != 2:
        argv = argv[:1]
    if len(argv) < 2 or argv[1] not in ACTIONS:
        say({"error": f"name one action: {', '.join(ACTIONS)} (the request as JSON on standard input or after --request)"}, out)
        return 2
    stopping = []
    if argv[1] == "work":
        for sig in (signal.SIGTERM, signal.SIGINT):
            signal.signal(sig, lambda *_: stopping.append(True))
        signal.signal(signal.SIGHUP, signal.SIG_IGN)
    try:
        request = json.loads(given if given is not None else (stdin.read() or "null"))
        if not isinstance(request, dict):
            raise Refusal("send one JSON object on standard input")
        if argv[1] == "work":
            say({"result": work(request, out, lambda: bool(stopping))}, out)
        else:
            say({"result": get_ready(request)}, out)
        return 0
    except Refusal as e:
        say({"error": str(e)}, out)
        return 1
    except json.JSONDecodeError as e:
        say({"error": f"standard input is not JSON ({e})"}, out)
        return 1
    except Exception as e:  # noqa: BLE001 - a failed run says why on its last line, and the trace goes to standard error
        import traceback
        traceback.print_exc()
        say({"error": f"the run failed: {type(e).__name__}: {e}"}, out)
        return 1


if __name__ == "__main__":
    sys.exit(main(sys.argv))
