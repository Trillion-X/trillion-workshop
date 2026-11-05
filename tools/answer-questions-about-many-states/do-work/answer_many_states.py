"""Answer a fixed set of questions about many states with a questions-first classifier, in bulk, on the person's Mac.

    python3 -I tools/answer-questions-about-many-states/do-work/answer_many_states.py <action> [--request '<json>'] < request.json

One JSON request (on standard input, or after --request), one action on the command line, `{"result": ...}` or `{"error": "..."}` as the
last line printed:

    get-ready  {model}                                          fetch the model row's weights, check them, name them
    start      {model, questions, states, settings, jobs_folder} start a run in the background -> {job_id}
    read       {job_id, jobs_folder, after_byte?}                how far it is; when finished, the answers in byte pages
    cancel     {job_id, jobs_folder}                             stop it after the batch in hand

The model is data: a row naming its classifier family (`classifier`) and where its weights are (`weights`:
{"folder": path} or {"hugging_face": {"repo", "revision"}}). The families this code runs are FAMILIES below. The
settings come from the person's rows too; none has a default here. A run's working files (its request, how far it
is, its answers) live in `jobs_folder/<job id>/` on the person's computer until the caller has read them; what is kept
is the caller's to write to the person's lists. A job id is the content identity (BLAKE3) of the whole request, so the
same request names the same run.
"""
import base64, json, os, signal, subprocess, sys, time

HERE = os.path.dirname(os.path.abspath(__file__))
if HERE not in sys.path:
    sys.path.insert(0, HERE)

SETTINGS = {
    "layout": "independent (one row per question: no question sees another, the decider's default) or packed (all "
              "questions in one prefix: one row per state, several times fewer tokens)",
    "dtype": "the weights' dtype on the GPU: bfloat16 (the model's own) or float32",
    "tokens_per_batch": "how many tokens one GPU pass may hold (larger is faster until memory runs out)",
    "max_state_tokens": "the most tokens of one state the model reads; a longer state is cut there, as the decider does",
    "page_bytes": "how many bytes of answers one read returns",
}
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
    def answer(folder, questions, states, settings, on_batch, should_stop, timings):
        import mlx.core as mx
        from questions_first import prompt as P
        from questions_first.backbone import Backbone
        from questions_first.engine import QuestionsFirst
        from questions_first.tokenizer import load_tokenizer
        dc = json.load(open(os.path.join(folder, "decider_config.json")))
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
        probs = qf.score(h, [P.render_state(s) for s in states], max_ctx_tokens=settings["max_state_tokens"],
                         on_batch=on_batch, should_stop=should_stop)
        timings["answer"] = time.perf_counter() - t
        name = "decider-" + str(dc.get("version", "dev"))
        return name, lambda s: P.assemble(rqs, index, [list(r) for r in probs[s]])


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
        if not isinstance(settings[field], int) or settings[field] < 1:
            raise Refusal(f"`settings.{field}` must be a positive whole number")


def job_dir(request):
    jobs = os.path.expanduser(need(request, "jobs_folder", "the request"))
    job = need(request, "job_id", "the request")
    if not isinstance(job, str) or not job.startswith("1f:") or not all(c in "0123456789abcdef" for c in job[3:]) or len(job) != 67:
        raise Refusal("`job_id` is the 1f:<64 hex> a start answered")
    path = os.path.join(jobs, job[3:])
    if not os.path.isdir(path):
        raise Refusal(f"no run {job} in {jobs}")
    return path


def write_json(path, value):
    tmp = f"{path}.{os.getpid()}.tmp"
    with open(tmp, "wb") as f:
        f.write(canonical(value))
    os.replace(tmp, path)


def read_json(path, default=None):
    try:
        with open(path, "rb") as f:
            return json.loads(f.read())
    except FileNotFoundError:
        return default


def run_pid(path, status):
    return status.get("pid") or read_json(os.path.join(path, "pid.json"))


def alive(pid):
    try:
        os.kill(pid, 0)
        return True
    except (ProcessLookupError, PermissionError, TypeError):
        return False


# ---- actions

def get_ready(request):
    model = need(request, "model", "the request")
    fam = family(model)
    folder = model_folder(model, fetch=True)
    names = fam.check(folder)
    ident, listing = identity_of_files(folder, names)
    return {"model": model.get("id"), "classifier": model["classifier"], "folder": folder, "identity": ident,
            "files": [{"name": n, "bytes": b, "blake3": h} for n, b, h in listing], "ready": True}


def start(request, spawn=None):
    model = need(request, "model", "the request")
    fam = family(model)
    check_questions(need(request, "questions", "the request"))
    states = need(request, "states", "the request")
    if not isinstance(states, list) or not states:
        raise Refusal("`states` must be a list of at least one state (text or JSON)")
    check_settings(need(request, "settings", "the request"))
    jobs = os.path.expanduser(need(request, "jobs_folder", "the request"))
    folder = model_folder(model, fetch=False)
    fam.check(folder)
    body = {k: request[k] for k in ("model", "questions", "states", "settings")}
    job = identity_of_bytes(canonical(body))
    path = os.path.join(jobs, job[3:])
    status = read_json(os.path.join(path, "status.json"))
    if status and (status["status"] in ("finished", "cancelled") or alive(run_pid(path, status))):
        return {"job_id": job, **{k: status[k] for k in ("status", "states_done", "states")}, "already": True}
    os.makedirs(path, exist_ok=True)
    write_json(os.path.join(path, "request.json"), {**body, "folder": folder})
    for stale in ("cancel", "answers.json", "pid.json"):
        if os.path.exists(os.path.join(path, stale)):
            os.remove(os.path.join(path, stale))
    write_json(os.path.join(path, "status.json"), {"status": "queued", "states_done": 0, "states": len(states), "pid": None})
    pid = (spawn or spawn_worker)(path)
    write_json(os.path.join(path, "pid.json"), pid)          # its own file: the worker may already be writing status.json
    return {"job_id": job, "status": "queued", "states_done": 0, "states": len(states)}


def spawn_worker(path):
    log = open(os.path.join(path, "log.txt"), "ab")
    p = subprocess.Popen([sys.executable, "-I", os.path.abspath(__file__), "work", path], stdin=subprocess.DEVNULL,
                         stdout=log, stderr=log, start_new_session=True)
    return p.pid


def work(path, families=None):
    """The background run: answer every state, keeping how far it is in status.json and the answers in answers.json."""
    req = read_json(os.path.join(path, "request.json"))
    fam = (families or FAMILIES)[req["model"]["classifier"]]
    n = len(req["states"])
    status_path = os.path.join(path, "status.json")
    begun = time.perf_counter()
    timings = {}
    base = {"states": n, "pid": os.getpid()}
    write_json(status_path, {**base, "status": "running", "states_done": 0})
    done = []

    def on_batch(finished, total):
        done[:] = finished
        write_json(status_path, {**base, "status": "running", "states_done": len(finished)})

    def should_stop():
        return os.path.exists(os.path.join(path, "cancel"))

    try:
        name, answers_of = fam.answer(req["folder"], req["questions"], req["states"], req["settings"], on_batch, should_stop, timings)
        timings["wall"] = time.perf_counter() - begun
        finished = sorted(done)
        stopped = len(finished) < n
        write_json(os.path.join(path, "answers.json"), {
            "model": req["model"].get("id"), "classifier_answers_as": name, "layout": req["settings"]["layout"],
            "questions": list(req["questions"]), "states": n,
            "answers": [{"state": s, "answers": answers_of(s)} for s in finished],
            "seconds": {k: round(v, 3) for k, v in timings.items()}})
        write_json(status_path, {**base, "status": "cancelled" if stopped else "finished", "states_done": len(finished),
                                 "seconds": {k: round(v, 3) for k, v in timings.items()}})
    except Exception as e:  # noqa: BLE001 - a failed run says why in its status
        write_json(status_path, {**base, "status": "failed", "states_done": len(done), "error": f"{type(e).__name__}: {e}"})
        raise


def read(request):
    path = job_dir(request)
    status = read_json(os.path.join(path, "status.json"))
    pid = run_pid(path, status)
    if status["status"] in ("queued", "running") and pid and not alive(pid):
        status = {**status, "status": "failed", "error": "the run's process ended without finishing; see log.txt in its folder"}
        write_json(os.path.join(path, "status.json"), status)
    out = {"job_id": request["job_id"], **{k: v for k, v in status.items() if k != "pid"}}
    if status["status"] in ("finished", "cancelled"):
        with open(os.path.join(path, "answers.json"), "rb") as f:
            data = f.read()
        page = read_json(os.path.join(path, "request.json"))["settings"]["page_bytes"]
        after = request.get("after_byte", 0)
        if not isinstance(after, int) or not 0 <= after <= len(data):
            raise Refusal(f"`after_byte` must be a whole number from 0 to {len(data)}")
        chunk = data[after:after + page]
        end = after + len(chunk)
        out["byte_page"] = {"total": len(data), "blake3": identity_of_bytes(data)[3:], "offset": after, "length": len(chunk),
                            "base64": base64.b64encode(chunk).decode("ascii"), "next_after_byte": end if end < len(data) else None}
    return out


def cancel(request):
    path = job_dir(request)
    status = read_json(os.path.join(path, "status.json"))
    if status["status"] in ("queued", "running"):
        open(os.path.join(path, "cancel"), "w").close()
        if not alive(run_pid(path, status)):
            status = {**status, "status": "cancelled"}
            write_json(os.path.join(path, "status.json"), status)
    return {"job_id": request["job_id"], "status": status["status"] if status["status"] not in ("queued", "running") else "cancelling",
            "states_done": status["states_done"], "states": status["states"]}


ACTIONS = {"get-ready": get_ready, "start": start, "read": read, "cancel": cancel}


def main(argv):
    if len(argv) >= 3 and argv[1] == "work":
        signal.signal(signal.SIGHUP, signal.SIG_IGN)
        work(argv[2])
        return 0
    given = None
    if len(argv) == 4 and argv[2] == "--request":
        given = argv[3]
    elif len(argv) != 2:
        argv = argv[:1]
    if len(argv) < 2 or argv[1] not in ACTIONS:
        print(json.dumps({"error": f"name one action: {', '.join(ACTIONS)} (the request as JSON on standard input or after --request)"}))
        return 2
    try:
        request = json.loads(given if given is not None else (sys.stdin.read() or "null"))
        if not isinstance(request, dict):
            raise Refusal("send one JSON object on standard input")
        print(json.dumps({"result": ACTIONS[argv[1]](request)}, ensure_ascii=False))
        return 0
    except Refusal as e:
        print(json.dumps({"error": str(e)}, ensure_ascii=False))
        return 1
    except json.JSONDecodeError as e:
        print(json.dumps({"error": f"standard input is not JSON ({e})"}))
        return 1


if __name__ == "__main__":
    sys.exit(main(sys.argv))
