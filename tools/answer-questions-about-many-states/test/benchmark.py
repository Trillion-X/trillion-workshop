"""Wall time of a bulk run: made-up questions x made-up states through the MLX questions-first cache.

    python3 tools/answer-questions-about-many-states/test/benchmark.py --model <model folder> [--layout packed|independent|both]
    python3 tools/answer-questions-about-many-states/test/benchmark.py --random-config <config.json>   # no weights needed

--model uses the folder's weights and tokenizer; --random-config builds synthetic weights from a config and uses the
made-up tokenizer (its tokens are characters, so a state is several times more tokens than with the real one).
Defaults: 303 questions x 132 states, bfloat16, target 60 s. Prints one JSON line per layout.
"""
import argparse, json, os, sys, time

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
sys.path.insert(0, os.path.join(HERE, "..", "do-work"))

import mlx.core as mx  # noqa: E402

import synthetic as S  # noqa: E402
from questions_first import prompt as P  # noqa: E402
from questions_first.backbone import Backbone, Config  # noqa: E402
from questions_first.engine import QuestionsFirst  # noqa: E402


def main():
    ap = argparse.ArgumentParser()
    src = ap.add_mutually_exclusive_group(required=True)
    src.add_argument("--model")
    src.add_argument("--random-config")
    ap.add_argument("--questions", type=int, default=303)
    ap.add_argument("--states", type=int, default=132)
    ap.add_argument("--set", choices=["rules", "mixed"], default="rules",
                    help="rules: the decider lane's 303 noul rules x 132 short lines (compares with its 121 s); "
                         "mixed: choice, score and noul questions over longer made-up states")
    ap.add_argument("--state-words", type=int, default=60, help="mixed set: about how many words each state has")
    ap.add_argument("--layout", choices=["packed", "independent", "both"], default="both")
    ap.add_argument("--dtype", default="bfloat16")
    ap.add_argument("--tokens-per-batch", type=int, default=16384)
    ap.add_argument("--target-seconds", type=float, default=60.0)
    ap.add_argument("--temperature", type=float, default=1.18)
    a = ap.parse_args()
    dtype = getattr(mx, a.dtype)
    t0 = time.perf_counter()
    if a.model:
        from questions_first.tokenizer import load_tokenizer
        bb = Backbone.load(a.model, dtype)
        tok, pad = load_tokenizer(a.model)
        dc = os.path.join(a.model, "decider_config.json")
        if os.path.exists(dc):
            c = json.load(open(dc))
            a.temperature = float(c.get("temperature_schema_first", c.get("temperature", a.temperature)))
    else:
        bb = Backbone.random(Config(json.load(open(a.random_config))), dtype)
        tok, pad = S.SyntheticTokenizer(), 0
    load_s = time.perf_counter() - t0
    if a.set == "rules":
        qs, sts = S.rule_questions(a.questions), S.rule_lines(a.states)
    else:
        qs = S.questions(a.questions, seed=7)
        sts = [P.render_state(s) for s in S.states(a.states, seed=8, words=(a.state_words, a.state_words + 8))]
    rqs = {k: P.render_question(v) for k, v in qs.items()}
    for layout in (["packed", "independent"] if a.layout == "both" else [a.layout]):
        independent = layout == "independent"
        qf = QuestionsFirst(bb, tok, pad, temperature=a.temperature, tokens_per_batch=a.tokens_per_batch)
        rows, _ = P.plan_rows(rqs, independent)
        t1 = time.perf_counter()
        h = qf.prepare(rows, independent=independent)
        prep_s = time.perf_counter() - t1
        t2 = time.perf_counter()
        probs = qf.score(h, sts)
        score_s = time.perf_counter() - t2
        total = prep_s + score_s
        print(json.dumps(dict(layout=layout, set=a.set, questions=a.questions, metal_scan=qf.use_metal,
                              peak_memory_gb=round(mx.get_peak_memory() / 1e9, 1) if hasattr(mx, "get_peak_memory") else None,
                              padded_suffix_tokens=qf.stats["padded_suffix_tokens"], rows=len(rows), states=a.states,
                              decisions=a.questions * a.states, prepare_seconds=round(prep_s, 2), score_seconds=round(score_s, 2),
                              wall_seconds=round(total, 2), load_seconds=round(load_s, 2),
                              decisions_per_second=round(a.questions * a.states / total, 1),
                              prefix_tokens=qf.stats["prefix_tokens"], suffix_tokens=qf.stats["suffix_tokens"], batches=qf.stats["batches"],
                              target_seconds=a.target_seconds, within_target=total <= a.target_seconds,
                              all_rows_sum_to_one=bool(abs(probs.sum(-1) - 1).max() < 1e-3), dtype=a.dtype,
                              device=str(mx.default_device()), weights="model" if a.model else "synthetic")), flush=True)


if __name__ == "__main__":
    main()
