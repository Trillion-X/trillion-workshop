"""The engine's entry for every row of this folder: Python's standard library only (the engine's python3), the person's
records through the run's records door, the GPU work in worker.py under the Python the person granted.

    python3 -I run_in_engine.py get-ready <kept folder>               {classifier}
    python3 -I run_in_engine.py answer    <kept folder> <mlx python>  {classifier, questions, states, settings}
    python3 -I run_in_engine.py read                                   {run, after?, limit?}
    python3 -I run_in_engine.py stop                                   {run}

The input is one JSON object on standard input; the answer is {"result": ...} or {"error": "..."} as the last line.
Everything is a row in the person's lists (read-data/answer-many-states.json names them): the classifier, the question
set, the state set and the settings are read from them, and every answer and the run's measurements are written to them.
The only thing kept on the computer is a model's weights, in the tool's kept folder.
"""
import hashlib, json, os, subprocess, sys, time, urllib.error, urllib.parse, urllib.request
from datetime import datetime, timezone

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
from records_door import DoorError, RecordsDoor, content_hash  # noqa: E402

with open(os.path.join(HERE, "..", "read-data", "answer-many-states.json")) as _f:
    DATA = json.load(_f)
WORDS = DATA["words"]


class Refusal(Exception):
    pass


def refuse(word, **kw):
    raise Refusal(WORDS[word].format(**kw))


def canonical(value):
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":")).encode("utf-8")


def now():
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


# ---- the person's lists

class Lists:
    def __init__(self, door):
        self.door = door

    @staticmethod
    def kind(name):
        return "record:" + DATA["lists"][name]["row_type"]

    def rid(self, name, row):
        return f"{self.kind(name)}:{row}"

    def ensure(self, *names):
        """Each list is made once with its definition; an existing list is never rewritten."""
        for name in names:
            d = DATA["lists"][name]
            if self.door.read("list", f"list:{d['id']}") is None:
                value = {k: v for k, v in d.items() if k != "id"}
                value.setdefault("indexes", [])
                try:
                    self.door.write([{"id": f"list:{d['id']}", "type": "list", "value": value, "expected": None}],
                                    key="answer-many-states:list:" + content_hash(canonical([d["id"], value])))
                except DoorError as e:
                    if e.code != "original_command_conflict":       # made meanwhile by another run: keep theirs
                        raise

    def row(self, name, row):
        return self.door.read(self.kind(name), self.rid(name, row))

    def rows(self, name, where=None, prefix=None):
        kind = self.kind(name)
        out = []
        for rec in self.door.list(kind, prefix=f"{kind}:{prefix}" if prefix else None, where=where):
            if isinstance(rec.get("value"), dict) and rec["id"].startswith(kind + ":"):
                out.append((rec["id"][len(kind) + 1:], rec["value"]))
        return out

    def put(self, name, rows, key):
        """Rows written whole, in writes of at most most_writes records; the key makes each safe to send again."""
        kind = self.kind(name)
        recs = [{"id": f"{kind}:{r}", "type": kind, "value": v} for r, v in rows]
        step = int(DATA["most_writes"])
        for i in range(0, len(recs), step):
            part = recs[i:i + step]
            self.door.write(part, key=f"answer-many-states:{key}:" + content_hash(canonical(part)))

    def merge(self, name, row, values, stop_seen=None):
        """Merge values into one row, conditional on what was read (a field the person set meanwhile, such as Stop,
        is never overwritten). -> the row as written."""
        kind, rid = self.kind(name), self.rid(name, row)
        for _ in range(4):
            held = self.door.read(kind, rid)
            value = {**(held or {}), **{k: v for k, v in values.items() if v is not None}}
            try:
                self.door.write([{"id": rid, "type": kind, "value": value, "expected": {"type": kind, "value": held} if held is not None else None}],
                                key="answer-many-states:merge:" + content_hash(canonical([rid, held, value])))
                return value
            except DoorError as e:
                if e.code != "original_command_conflict":
                    raise
        raise Refusal(WORDS["no_run"].format(id=row) if name == "runs" else "The row kept changing while this tool wrote it.")


# ---- what a run asks

def family_of(classifier):
    fam = classifier.get("classifier")
    if fam not in DATA["families"]:
        refuse("family_unknown", families=", ".join(sorted(DATA["families"])), family=repr(fam))
    return DATA["families"][fam]


def weights_folder(kept, classifier):
    if not classifier.get("repo") or not classifier.get("revision"):
        raise Refusal("The classifier row needs its Hugging Face repository and a pinned revision.")
    return os.path.join(kept, "models", classifier["repo"].replace("/", "--"), classifier["revision"])


def read_questions(lists, set_name):
    from questions_first import prompt as P
    rows = lists.rows("questions", where={"set": set_name})
    if not rows:
        refuse("no_questions", set=set_name)
    rows.sort(key=lambda r: (r[1].get("order", 0), r[0]))
    out = {}
    for rid, v in rows:
        spec = {"type": v.get("type") or "choice", "instructions": v.get("instructions", "")}
        crit = v.get("criteria")
        if isinstance(crit, str) and crit.strip():
            try:
                crit = json.loads(crit)
            except json.JSONDecodeError:
                refuse("bad_question", id=rid, set=set_name, why="its options are not JSON")
        if crit not in (None, ""):
            spec["criteria"] = crit
        try:
            P.render_question(spec)
        except (ValueError, AttributeError) as e:
            refuse("bad_question", id=rid, set=set_name, why=str(e))
        out[rid] = spec
    return out


def read_states(lists, set_name):
    rows = lists.rows("states", where={"set": set_name})
    if not rows:
        refuse("no_states", set=set_name)
    rows.sort(key=lambda r: (r[1].get("order", 0), r[0]))
    out = []
    for rid, v in rows:
        text = v.get("text", "")
        if isinstance(text, str) and text[:1] in "[{":
            try:
                text = json.loads(text)
            except json.JSONDecodeError:
                pass
        out.append({"id": rid, "text": text})
    return out


def read_settings(lists, row):
    v = lists.row("settings", row)
    if v is None:
        refuse("no_settings", id=row)
    for field, meaning in DATA["settings_meaning"].items():
        if v.get(field) in (None, ""):
            refuse("missing_setting", id=row, field=field, meaning=meaning)
    if v["layout"] not in ("independent", "packed") or v["dtype"] not in ("bfloat16", "float32"):
        raise Refusal(f"The settings row {row}: layout is independent or packed, dtype bfloat16 or float32.")
    for f in ("tokens_per_batch", "max_state_tokens"):
        if not isinstance(v[f], (int, float)) or v[f] < 1:
            raise Refusal(f"The settings row {row}: {f} must be a positive number.")
    return {k: v[k] for k in DATA["settings_meaning"]}


def need(request, field):
    if not isinstance(request.get(field), str) or not request[field]:
        raise Refusal(f"The request needs `{field}`.")
    return request[field]


# ---- get-ready: fetch the weights once into the kept folder

def fetch_json(url, timeout):
    with urllib.request.urlopen(url, timeout=timeout) as r:
        return json.loads(r.read())


def get_ready(request, door, kept, fetch=None, tree_of=None):
    lists = Lists(door)
    lists.ensure("classifiers")
    row = need(request, "classifier")
    c = lists.row("classifiers", row)
    if c is None:
        refuse("no_classifier", id=row)
    fam = family_of(c)
    folder = weights_folder(kept, c)
    os.makedirs(folder, exist_ok=True)
    repo, rev, cfg = c["repo"], c["revision"], DATA["fetch"]
    q = lambda s: urllib.parse.quote(s, safe="/")
    fetch = fetch or (lambda url, path: urllib.request.urlretrieve(url, path))
    try:
        tree = (tree_of or (lambda url: fetch_json(url, cfg["timeout_seconds"])))(cfg["tree"].format(repo=q(repo), revision=q(rev)))
    except urllib.error.HTTPError as e:
        if e.code in (401, 403):
            refuse("gated", repo=repo, status=e.code)
        refuse("fetch_failed", repo=repo, revision=rev, why=f"HTTP {e.code}")
    except (urllib.error.URLError, OSError) as e:
        refuse("fetch_failed", repo=repo, revision=rev, why=str(e))
    wanted = [f for f in tree if f.get("type") == "file" and (f["path"] in fam["files"] or f["path"] == fam.get("index")
                                                                or (f["path"].endswith(fam["weights"]) and "/" not in f["path"]))]
    missing = [n for n in fam["files"] if n not in {f["path"] for f in wanted}]
    if missing or not any(f["path"].endswith(fam["weights"]) for f in wanted):
        raise Refusal(f"{repo} at {rev} lacks {missing or ['*' + fam['weights']]}: it is not a {c['classifier']} model.")
    listing = []
    for f in sorted(wanted, key=lambda f: f["path"]):
        path = os.path.join(folder, f["path"])
        sha = (f.get("lfs") or {}).get("oid")
        size = (f.get("lfs") or {}).get("size", f.get("size"))
        if not (os.path.exists(path) and os.path.getsize(path) == size and (sha is None or sha256_of(path) == sha)):
            tmp = path + ".part"
            try:
                fetch(cfg["file"].format(repo=q(repo), revision=q(rev), path=q(f["path"])), tmp)
            except urllib.error.HTTPError as e:
                if e.code in (401, 403):
                    refuse("gated", repo=repo, status=e.code)
                refuse("fetch_failed", repo=repo, revision=rev, why=f"{f['path']}: HTTP {e.code}")
            got = sha256_of(tmp)
            if os.path.getsize(tmp) != size or (sha is not None and got != sha):
                os.remove(tmp)
                refuse("fetch_failed", repo=repo, revision=rev, why=f"{f['path']} did not arrive as the repository lists it")
            os.replace(tmp, path)
        listing.append([f["path"], os.path.getsize(path), sha or sha256_of(path)])
    identity = content_hash(canonical(listing))
    lists.merge("classifiers", row, {"identity": identity, "files": len(listing), "ready_at": now()})
    return {"classifier": row, "identity": identity, "files": [{"name": n, "bytes": b, "sha256": h} for n, b, h in listing], "ready": True}


def sha256_of(path):
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for block in iter(lambda: f.read(1 << 24), b""):
            h.update(block)
    return h.hexdigest()


# ---- answer: one run, every answer and the measurements kept as rows

def answer(request, door, kept, program, spawn=None):
    lists = Lists(door)
    lists.ensure("classifiers", "questions", "states", "settings", "runs", "answers")
    crow = need(request, "classifier")
    c = lists.row("classifiers", crow)
    if c is None:
        refuse("no_classifier", id=crow)
    family_of(c)
    if not c.get("identity"):
        refuse("not_ready", id=crow)
    folder = weights_folder(kept, c)
    if not os.path.isdir(folder):
        refuse("not_ready", id=crow)
    if not program:
        refuse("no_program")
    qset, sset, srow = need(request, "questions"), need(request, "states"), need(request, "settings")
    questions = read_questions(lists, qset)
    states = read_states(lists, sset)
    settings = read_settings(lists, srow)
    identity = content_hash(canonical({"classifier": c["identity"], "family": c["classifier"], "questions": questions,
                                       "states": states, "settings": settings}))
    run = "run-" + identity[3:27]
    held = lists.row("runs", run) or {}
    if held.get("status") == "finished":
        return {"run": run, **{k: held.get(k) for k in ("status", "states", "states_done", "wall_seconds", "decisions_per_second")}, "already": True}
    done = {r.split(":", 1)[1] for r, _ in lists.rows("answers", prefix=f"{run}:")}
    todo = [s for s in states if s["id"] not in done]
    begun = time.perf_counter()
    lists.merge("runs", run, {"label": f"{qset} over {sset}", "classifier": crow, "questions_set": qset, "states_set": sset,
                              "settings": srow, "status": "running", "questions": len(questions), "states": len(states),
                              "states_done": len(done), "identity": identity, "started_at": held.get("started_at") or now()})
    if not todo:
        return finish(lists, run, len(states), len(states), len(questions), {}, begun, "finished")
    job = {"folder": folder, "questions": questions, "states": todo, "settings": settings}
    proc = (spawn or spawn_worker)(program, job)
    measured, answered, status = {}, len(done), "finished"
    try:
        for line in proc.stdout:
            event = json.loads(line)
            if "loaded" in event:
                measured.update(event["loaded"])
            elif "answered" in event:
                rows = [(f"{run}:{a['id']}", {"run": run, "state": a["id"], "answers": json.dumps(a["answers"], ensure_ascii=False)}) for a in event["answered"]]
                lists.put("answers", rows, key=f"answers:{run}")
                answered += len(rows)
                now_row = lists.merge("runs", run, {"states_done": answered})
                if now_row.get("stop"):
                    status = "stopped"
                    proc.terminate()
                    break
            elif "finished" in event:
                measured.update(event["finished"])
            elif "error" in event:
                lists.merge("runs", run, {"status": "failed", "error": event["error"], "finished_at": now()})
                raise Refusal(event["error"])
    finally:
        proc.wait()
        stream = getattr(proc, "stdout", None)
        if hasattr(stream, "close"):
            stream.close()
    if status == "finished" and answered < len(states):
        lists.merge("runs", run, {"status": "failed", "error": "the worker ended before every state was answered", "finished_at": now()})
        raise Refusal(f"The worker ended after {answered} of {len(states)} states; run again to go on from there.")
    return finish(lists, run, len(states), answered, len(questions), measured, begun, status)


def finish(lists, run, n_states, answered, n_q, measured, begun, status):
    wall = time.perf_counter() - begun
    answer_s = measured.get("answer_seconds")
    values = {"status": status, "states_done": answered, "decisions": answered * n_q, "finished_at": now(),
              "load_seconds": measured.get("load_seconds"), "prepare_seconds": measured.get("prepare_seconds"),
              "answer_seconds": answer_s, "wall_seconds": round(wall, 3),
              "decisions_per_second": round(answered * n_q / wall, 1) if wall > 0 else None,
              "padded_suffix_tokens": measured.get("padded_suffix_tokens"), "machine": measured.get("machine")}
    lists.merge("runs", run, values)
    return {"run": run, "states": n_states, **{k: v for k, v in values.items() if v is not None}}


def spawn_worker(program, job):
    p = subprocess.Popen([program, "-I", os.path.join(HERE, "worker.py")], stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                         stderr=subprocess.DEVNULL, text=True)
    p.stdin.write(json.dumps(job, ensure_ascii=False))
    p.stdin.close()
    return p


# ---- read and stop

def read(request, door):
    lists = Lists(door)
    run = need(request, "run")
    r = lists.row("runs", run)
    if r is None:
        refuse("no_run", id=run)
    out = {"run": run, **{k: v for k, v in r.items() if k != "identity"}}
    if request.get("answers"):
        limit = int(request.get("limit", 20))
        rows = sorted(lists.rows("answers", prefix=f"{run}:"), key=lambda x: x[0])
        after = request.get("after")
        if after:
            rows = [x for x in rows if x[1].get("state", "") > after]
        page = rows[:limit]
        out["answers"] = [{"state": v["state"], "answers": json.loads(v["answers"])} for _, v in page]
        out["next_after"] = page[-1][1]["state"] if len(rows) > limit else None
    return out


def stop(request, door):
    lists = Lists(door)
    run = need(request, "run")
    if lists.row("runs", run) is None:
        refuse("no_run", id=run)
    r = lists.merge("runs", run, {"stop": "Stop"})
    return {"run": run, "status": "stopping" if r.get("status") == "running" else r.get("status")}


def main(argv, door=None):
    if len(argv) < 2 or argv[1] not in ("get-ready", "answer", "read", "stop"):
        print(json.dumps({"error": "name one action: get-ready, answer, read or stop"}))
        return 2
    try:
        request = json.loads(sys.stdin.read() or "{}")
        if not isinstance(request, dict):
            raise Refusal("Send one JSON object on standard input.")
        door = door or RecordsDoor.open()
        action = argv[1]
        if action in ("get-ready", "answer"):
            kept = argv[2] if len(argv) > 2 and argv[2] else None
            if not kept or not os.path.isdir(kept):
                refuse("no_kept_folder")
        if action == "get-ready":
            result = get_ready(request, door, kept)
        elif action == "answer":
            result = answer(request, door, kept, argv[3] if len(argv) > 3 else None)
        elif action == "read":
            result = read(request, door)
        else:
            result = stop(request, door)
        print(json.dumps({"result": result}, ensure_ascii=False))
        return 0
    except (Refusal, DoorError) as e:
        print(json.dumps({"error": str(e)}, ensure_ascii=False))
        return 1


if __name__ == "__main__":
    sys.exit(main(sys.argv))
