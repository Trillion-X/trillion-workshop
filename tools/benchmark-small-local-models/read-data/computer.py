"""What the place running these experiments reports, read in one spot (docs/decouple-sweep.md, "The shape").

- device(): DECIDER_DEVICE, else what torch finds here (cuda, then mps, then cpu). Apple's mps is one option, not the rule.
- hf_hub(): the model cache, HF_HUB_CACHE, else HF_HOME/hub, else the Hugging Face default under the home folder.
- snapshot(repo): a downloaded model's snapshot folder in that cache, or a plain error naming the repo.
- reported(name): another checkout or store the computer reports (TRILLION_CHECKOUT, TRILLION_SITE, ...);
  stops with the name of the missing input instead of guessing a home folder.
- load_decider(repo): a decider-style choice classifier (decider.infer.Decider) from its snapshot, and the seconds it took.

And what every command of this tool shares (one JSON request in, one JSON answer out):
- request(): the JSON request, from the file named by the first argument or from standard input, with the person's
  settings under it (with_settings): their row record:setting:benchmark-small-local-models~<scope_kind>~<scope_id> from
  list:settings as `settings_record` (or inline `settings`), read by the one shared reader, tools/settings.
- need(request, key): a field, or a refusal naming it. refuse(message): { error } as the last line, exit 2.
- answer(result): { result } as the last line; with `write_to` the whole answer goes to that file and the line counts it.
"""
import json
import os
import sys
from pathlib import Path

FOLDER = "benchmark-small-local-models"
SETTINGS_READER = Path(__file__).resolve().parents[2] / "settings" / "read-data"
REQUEST = {}


def refuse(message):
    print(json.dumps({"error": message}))
    sys.exit(2)


def device():
    if REQUEST.get("device"):
        return REQUEST["device"]
    if os.environ.get("DECIDER_DEVICE"):
        return os.environ["DECIDER_DEVICE"]
    import torch
    if torch.cuda.is_available():
        return "cuda"
    mps = getattr(torch.backends, "mps", None)
    return "mps" if mps is not None and mps.is_available() else "cpu"


def hf_hub():
    return Path(os.environ.get("HF_HUB_CACHE") or Path(os.environ.get("HF_HOME") or Path.home() / ".cache/huggingface") / "hub")


def snapshot(repo, revision=None):
    snaps = hf_hub() / f"models--{repo.replace('/', '--')}" / "snapshots"
    if revision and (snaps / revision).is_dir():
        return snaps / revision
    found = sorted(snaps.iterdir()) if snaps.is_dir() else []
    if not found:
        refuse(f"{repo} is not in this computer's model cache ({hf_hub()}); download it there (hf download {repo}) or set HF_HUB_CACHE")
    return found[-1]


def reported(name):
    at = REQUEST.get(name.lower()) or os.environ.get(name)
    if not at:
        refuse(f"This computer has not said where it keeps {name}. Give {name.lower()} in the request, or set {name} to the folder this place holds.")
    return Path(at)


def load_decider(repo, on=None, revision=None):
    import time
    D = snapshot(repo, revision)
    sys.path.insert(0, str(D))
    from decider.infer import Decider
    t = time.time(); d = Decider(str(D), device=on or device()); return d, time.time() - t


def with_settings(request, command):
    """The request with the person's settings under it: `settings_record` (their list:settings rows
    record:setting:benchmark-small-local-models~<scope_kind>~<scope_id> as records:read gave them, or a file of them),
    the row of the first of `scopes` ([[scope_kind, scope_id]], most specific first) that has one, read by the one shared
    reader, tools/settings; or `settings` inline. The settings hold `commands` ({ command: { field: value } }, each
    command's defaults, which the request's own fields override). A request with neither is used as it is."""
    if request.get("settings_record") is None and request.get("settings") is None:
        return request
    settings = request.get("settings")
    if request.get("settings_record") is not None:
        sys.path.insert(0, str(SETTINGS_READER))
        try:
            import settings as reader
        except ImportError:
            refuse(f"the shared settings reader is not at {SETTINGS_READER}: run from a whole Workshop checkout")
        scopes = request.get("scopes")
        try:
            settings = reader.setting(request["settings_record"], FOLDER, [tuple(x) for x in scopes] if scopes else None)
        except reader.SettingError as error:
            refuse(str(error))
        if settings is None:
            refuse(f"no settings row of {FOLDER} for the scopes {scopes}: give the row record:setting:{FOLDER}~<scope_kind>~<scope_id>")
    if not isinstance(settings, dict):
        refuse("the settings are not a JSON object of { commands: { command: { field: value } } }")
    own = {k: v for k, v in request.items() if k not in ("settings_record", "settings", "scopes")}
    return {**(settings.get("commands") or {}).get(command, {}), **own}


def request(argv=None):
    argv = sys.argv if argv is None else argv
    if len(argv) > 1 and argv[1] != "-":
        path = Path(argv[1])
        if not path.is_file():
            refuse(f"{path} is not there: name the JSON request file, or pass the request on standard input")
        text = path.read_text()
    else:
        text = sys.stdin.read()
    try:
        r = json.loads(text)
    except json.JSONDecodeError as error:
        refuse(f"the request is not JSON ({error}): send one JSON object")
    if not isinstance(r, dict):
        refuse("the request is not a JSON object: send one object with the fields the script's header names")
    REQUEST.clear(); REQUEST.update(with_settings(r, Path(argv[0]).stem))
    return REQUEST


def need(r, key, where="the request"):
    if key not in r:
        refuse(f"{where} has no `{key}`: add it (the script's header names every field)")
    return r[key]


def json_of(value, what):
    """A JSON value given inline, or the path of a file holding it (a { result } answer of another command is opened)."""
    if isinstance(value, str):
        if not Path(value).is_file():
            refuse(f"{what} names {value}, which is not there: give the value, or a file holding it")
        value = json.loads(Path(value).read_text())
        if isinstance(value, dict) and set(value) == {"result"}:
            value = value["result"]
    return value


def answer(result):
    out = REQUEST.get("write_to")
    if out:
        Path(out).parent.mkdir(parents=True, exist_ok=True)
        Path(out).write_text(json.dumps(result, indent=1, ensure_ascii=False))
        result = {"written_to": out, **{k: (len(v) if isinstance(v, (list, dict)) else v) for k, v in result.items()}}
    print(json.dumps({"result": result}, ensure_ascii=False))


def vocabulary(r):
    """FIELDS, values(field) and DEFINE from the request's `vocabulary` ({ field: { value: plain definition } }, the
    person's shot vocabulary): the fields and values in the order given, and each value's definition."""
    v = need(r, "vocabulary")
    if not isinstance(v, dict) or not all(isinstance(d, dict) and d for d in v.values()):
        refuse("`vocabulary` is { field: { value: plain definition } }: give at least one value per field")
    return list(v), (lambda f: list(v[f])), v


def shots_of(r, key="shots"):
    """The sampled shots: a list, a sample answer { shots }, or a file holding either."""
    s = json_of(need(r, key), key)
    return s[key] if isinstance(s, dict) and key in s else s


def sync(dev):
    import torch
    if dev == "mps": torch.mps.synchronize()


def mps_gb(dev):
    import torch
    return round(torch.mps.driver_allocated_memory()/1e9, 2) if dev == "mps" else None
