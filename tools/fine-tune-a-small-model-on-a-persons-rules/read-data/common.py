"""Shared pieces for building, training and scoring: one JSON request in and one answer out, and the decider model
(the model, the prompt frame and the scorer).

The prompt is the person's gate's: the request's frame (such as 'A line of copy:\n"{text}"') holding the line, one
question, options in the row's own order (no shuffle), read at the answer slot and softmaxed over the option letters
with the stored temperature. The model is a decider-style multiple-choice model folder that carries its own `decider`
package (infer, model, prompt) and decider_config.json, such as a Hugging Face snapshot of decider-2b; torch is only
imported once a model is configured, so building rows needs no torch."""
import json
import os
import sys
from pathlib import Path

MODEL = DEVICE = FRAME = LORA_TARGETS = None


class Refused(Exception):
    """A request the tool cannot run; the message says what to change."""


def read(argv):
    """The request: the JSON file named on the command line, or standard input for '-'."""
    if len(argv) != 1:
        raise Refused("give one argument: the request JSON file, or - to read the request from standard input")
    raw = sys.stdin.read() if argv[0] == "-" else Path(argv[0]).read_text()
    try:
        req = json.loads(raw)
    except ValueError as e:
        raise Refused(f"the request is not JSON: {e}")
    if not isinstance(req, dict):
        raise Refused("the request must be a JSON object")
    return req


def need(req, key, kind, what):
    if key not in req:
        raise Refused(f"{key} is required: {what}")
    if not isinstance(req[key], kind) or (kind is int and isinstance(req[key], bool)):
        raise Refused(f"{key} must be {what}")
    return req[key]


def rows_of(value, key):
    """A list of objects given inline, or {"file": <path>} naming a JSON Lines file of them."""
    if isinstance(value, list):
        return value
    if isinstance(value, dict) and isinstance(value.get("file"), str):
        path = Path(value["file"]).expanduser()
        if not path.is_file():
            raise Refused(f"{key}.file {path} is not a file")
        return [json.loads(ln) for ln in path.read_text().splitlines() if ln.strip()]
    raise Refused(f"{key} must be a list of rows or {{\"file\": <a JSON Lines file>}}")


def with_settings(req, step, folder):
    """The request with the person's settings for this step under it: settings_record (their list:settings row
    record:setting:<folder>~<scope_kind>~<scope_id>, as records:read gives it, or a JSON file of it), read by the one
    Workshop reader (tools/settings/read-data/settings.py); with several rows given, settings_scope [kind, id] picks
    one. `settings` may be given inline instead, for a test. The settings' `<step>` object gives every key the request
    does not; an object both give is merged key by key."""
    if "settings_record" not in req and "settings" not in req:
        return req
    if "settings_record" in req:
        sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "settings" / "read-data"))
        try:
            import settings
        except ModuleNotFoundError:
            raise Refused("settings_record needs the Workshop's tools/settings folder beside this one: run from a full Workshop checkout")
        scope = req.get("settings_scope")
        try:
            given = settings.setting(req["settings_record"], folder, [tuple(scope)] if scope else None)
        except settings.SettingError as e:
            raise Refused(str(e))
        if given is None:
            raise Refused(f"settings_record holds no row record:setting:{folder}~...{' for ' + '~'.join(scope) if scope else ''}: "
                          "give this tool's own row from the person's list:settings")
    else:
        given = req["settings"]
    part = given.get(step, {}) if isinstance(given, dict) else None
    if not isinstance(part, dict):
        raise Refused(f"the settings must be an object whose {step} is an object of this step's request keys")
    out = {k: v for k, v in part.items()}
    for k, v in req.items():
        if k in ("settings_record", "settings", "settings_scope"):
            continue
        out[k] = {**out[k], **v} if isinstance(v, dict) and isinstance(out.get(k), dict) else v
    return out


def run(main, argv):
    """Run main(request) and print its answer as the last line; exit 0 on a result, 2 on a refusal."""
    try:
        result = main(read(argv))
    except Refused as e:
        print(json.dumps({"error": str(e)}))
        return 2
    print(json.dumps({"result": result}, ensure_ascii=False))
    return 0


def configure(base_model, frame, device=None):
    """The decider model folder, the frame a line is put in and the device: the one asked for, else DECIDER_DEVICE,
    else what torch finds here (cuda, then mps, then cpu)."""
    global MODEL, DEVICE, FRAME, torch, Example, Q, DecisionModel, collate, MAX_OPTIONS, build
    MODEL = Path(base_model).expanduser()
    if not (MODEL / "decider").is_dir() or not (MODEL / "decider_config.json").is_file():
        raise Refused(f"{MODEL} is not a decider model folder: it needs decider/ and decider_config.json")
    if "{text}" not in frame:
        raise Refused("frame must hold {text}, where the line goes")
    FRAME = frame
    import torch
    DEVICE = os.environ.get("DECIDER_DEVICE") or ("cuda" if torch.cuda.is_available() else "mps" if getattr(torch.backends, "mps", None) and torch.backends.mps.is_available() else "cpu")
    DEVICE = device or DEVICE
    sys.path.insert(0, str(MODEL))
    from decider.infer import Example, Q  # noqa: E402
    from decider.model import DecisionModel, collate  # noqa: E402
    from decider.prompt import MAX_OPTIONS, build  # noqa: E402


class _Keep:
    def shuffle(self, x):
        pass

    def sample(self, xs, k):
        return xs[:k]


def quiet(nice=15, threads=2):
    """Run beside the person's work: at least this nice (lowest useful CPU priority) and this many CPU threads."""
    now = os.nice(0)
    if now < nice:
        os.nice(nice - now)
    torch.set_num_threads(threads)


def load(adapter=None, train=False):
    m = DecisionModel(str(MODEL), dtype=torch.bfloat16, grad_ckpt=False)
    if adapter:
        from peft import PeftModel
        PeftModel.from_pretrained(m.lm, str(adapter), is_trainable=train)     # injects LoRA into m.lm in place
    return m.to(DEVICE)


def item(tok, text, question, options, gold=0):
    return build(Example(FRAME.format(text=text), [Q(question, list(options), gold)]), tok, _Keep(), max_options=MAX_OPTIONS)


def temperature():
    import json
    return float(json.load(open(MODEL / "decider_config.json"))["temperature"])


def score(m, asks, batch=16):
    """asks: [(text, question, options)] -> [[p per option]] at the stored temperature."""
    T, out = temperature(), []
    with torch.no_grad():
        for k in range(0, len(asks), batch):
            items = [item(m.tok, *a) for a in asks[k:k + batch]]
            b = collate(items, m.tok.pad_token_id)
            lg = m.slot_logits(*[b[x].to(DEVICE) for x in ("input_ids", "attention_mask", "slot_idx", "slot_batch", "nopts")])
            p = torch.softmax(lg / T, -1).cpu()
            out += [p[i, :len(a[2])].tolist() for i, a in enumerate(asks[k:k + batch])]
    return out
