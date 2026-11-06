"""The GPU half of a run: started by run_in_engine.py under the Python the person granted (one that has mlx, numpy and
tokenizers), it answers every state of one job and streams the answers back. It touches no records and no network.

    <python with mlx> -I worker.py < job.json

job.json: {"folder": the model's folder, "questions": {id: spec}, "states": [{"id", "text"}], "settings": {...}}.
It prints one JSON line per event, the last one final:
    {"loaded": {"load_seconds", "prepare_seconds", "machine"}}
    {"answered": [{"id": state id, "answers": {question id: answer}}]}       as each batch finishes
    {"finished": {"answer_seconds", "padded_suffix_tokens", "batches"}}   or   {"error": "..."}
It stops at once on SIGTERM (the run stops it when the person sets Stop).
"""
import json, os, sys, time

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)


def say(event):
    sys.stdout.write(json.dumps(event, ensure_ascii=False) + "\n")
    sys.stdout.flush()


def main():
    job = json.loads(sys.stdin.read())
    try:
        import mlx.core as mx
        from questions_first import prompt as P
        from questions_first.backbone import Backbone
        from questions_first.engine import QuestionsFirst
        from questions_first.tokenizer import load_tokenizer
    except ImportError as e:
        say({"error": f"the granted Python cannot run the model: {e}. It needs mlx, numpy and tokenizers."})
        return 1
    folder, settings = job["folder"], job["settings"]
    try:
        with open(os.path.join(folder, "decider_config.json")) as f:
            dc = json.load(f)
        independent = settings["layout"] == "independent"
        t = time.perf_counter()
        bb = Backbone.load(folder, getattr(mx, settings["dtype"]))
        tok, pad = load_tokenizer(folder)
        qf = QuestionsFirst(bb, tok, pad, temperature=float(dc.get("temperature_schema_first", dc.get("temperature", 1.0))),
                            tokens_per_batch=int(settings["tokens_per_batch"]))
        load_s = time.perf_counter() - t
        rqs = {k: P.render_question(v) for k, v in job["questions"].items()}
        rows, index = P.plan_rows(rqs, bool(dc.get("isolated_levels", False)) and independent)
        t = time.perf_counter()
        h = qf.prepare(rows, independent=independent)
        prep_s = time.perf_counter() - t
        say({"loaded": {"load_seconds": round(load_s, 3), "prepare_seconds": round(prep_s, 3),
                        "machine": f"mlx {getattr(mx, '__version__', '?')} on {mx.default_device()}, metal scan {'on' if qf.use_metal else 'off'}"}})
        states = job["states"]
        sent = set()

        def on_batch(finished, total):
            new = [s for s in finished if s not in sent]
            if new:
                sent.update(new)
                say({"answered": [{"id": states[s]["id"], "answers": P.assemble(rqs, index, [list(r) for r in qf.partial[s]])} for s in new]})

        t = time.perf_counter()
        qf.score(h, [P.render_state(s["text"]) for s in states], max_ctx_tokens=int(settings["max_state_tokens"]), on_batch=on_batch)
        say({"finished": {"answer_seconds": round(time.perf_counter() - t, 3), "padded_suffix_tokens": qf.stats["padded_suffix_tokens"],
                          "batches": qf.stats["batches"]}})
        return 0
    except Exception as e:  # noqa: BLE001 - the run writes the worker's own words into the run row
        say({"error": f"{type(e).__name__}: {e}"})
        return 1


if __name__ == "__main__":
    sys.exit(main())
