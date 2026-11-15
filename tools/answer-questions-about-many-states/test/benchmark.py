"""Wall time of a bulk run: made-up questions x made-up states through the MLX questions-first cache.

    python3 tools/answer-questions-about-many-states/test/benchmark.py --model <model folder> [--layout packed|independent|both]
    python3 tools/answer-questions-about-many-states/test/benchmark.py --random-config <config.json>   # no weights needed
    python3 tools/answer-questions-about-many-states/test/benchmark.py --profile-torch --model <model folder>

--model uses the folder's weights and tokenizer; --random-config builds synthetic weights from a config and uses the
made-up tokenizer (its tokens are characters, so a state is several times more tokens than with the real one).
Defaults: 303 questions x 132 states, bfloat16, target 60 s. Prints one JSON line per layout.
--profile-torch preserves the original component profile (20 questions x 4 states by default). Its source was
captured byte for byte in ports/source-baselines/answer-questions-about-many-states/measure_decider_batches.py.held
before this adaptation. It prints load/prefix/state times, component times and call counts. With --random-config,
give --decider-source <directory holding decider/>; it profiles a tiny synthetic model without real weights.
"""
import argparse, json, math, os, sys, time
from collections import defaultdict
from pathlib import Path
from types import SimpleNamespace

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
sys.path.insert(0, os.path.join(HERE, "..", "do-work"))

import synthetic as S  # noqa: E402
from questions_first import prompt as P  # noqa: E402


def inputs(a):
    if a.set == "rules":
        return S.rule_questions(a.questions), S.rule_lines(a.states)
    return S.questions(a.questions, seed=7), [
        P.render_state(s) for s in S.states(a.states, seed=8, words=(a.state_words, a.state_words + 8))]


def profile_reference(engine, rows, lines, temperature, *, device, torch, schema_engine, modeling,
                      clock=time.perf_counter):
    # The reference reader creates index tensors without an explicit device. Keep those constructors on the
    # requested inference device rather than sending temporary CPU indices to MPS asynchronously.
    with S.reference_inputs(device, torch_module=torch, schema_module=schema_engine):
        return _profile_reference(engine, rows, lines, temperature, device=device, torch=torch,
                                  schema_engine=schema_engine, modeling=modeling, clock=clock)


def _profile_reference(engine, rows, lines, temperature, *, device, torch, schema_engine, modeling, clock):
    """The captured PyTorch component measurement, with every hook and patch restored after a run."""
    if not rows or not lines:
        raise ValueError("a profile needs at least one question row and state")
    spent = defaultdict(float)
    calls = defaultdict(int)
    originals, handles, starts = [], [], {}

    def sync():
        if device == "mps":
            torch.mps.synchronize()

    def timed(name, fn):
        def wrapper(*a, **k):
            sync(); t = clock(); out = fn(*a, **k); sync()
            spent[name] += clock() - t; calls[name] += 1
            return out
        return wrapper

    def replace(owner, attribute, label):
        original = getattr(owner, attribute)
        originals.append((owner, attribute, original))
        setattr(owner, attribute, timed(label, original))

    try:
        replace(modeling, "torch_chunk_gated_delta_rule", "gated-delta scan (chunked reference)")
        replace(modeling, "torch_recurrent_gated_delta_rule", "gated-delta scan (recurrent reference)")
        replace(schema_engine.PrefixCache, "__init__", "per-question state copies (PrefixCache)")
        for layer in engine.core.layers:
            for name, module in (("gated-delta layer (whole)", getattr(layer, "linear_attn", None)),
                                 ("full-attention layer (whole)", getattr(layer, "self_attn", None)),
                                 ("MLP", layer.mlp)):
                if module is None:
                    continue

                def before(m, args):
                    sync(); starts[m] = clock()

                def after(m, args, out, name=name):
                    sync(); spent[name] += clock() - starts.pop(m); calls[name] += 1

                handles.append(module.register_forward_pre_hook(before))
                handles.append(module.register_forward_hook(after))

        se = schema_engine.SchemaEngine(engine)
        sync(); t = clock()
        handle = se.prepare(rows, independent=True)
        sync(); prepare_seconds = clock() - t
        prepare_spent = dict(spent); spent.clear()
        probs, line_seconds = [], []
        for line in lines:
            sync(); t = clock()
            p = se.score(handle, [line], temperature=temperature)[0]
            sync(); line_seconds.append(clock() - t)
            probs.append([[float(x) for x in row[:len(r["options"])]] for row, r in zip(p, rows)])
        return dict(prepare_seconds=prepare_seconds, line_seconds=line_seconds, probs=probs,
                    prepare_spent=prepare_spent, line_spent=dict(spent), calls=dict(calls),
                    suffix_tokens=[len(se.tokenize(handle, line)[0]) for line in lines])
    finally:
        for handle in reversed(handles):
            handle.remove()
        for owner, attribute, original in reversed(originals):
            setattr(owner, attribute, original)


def profile_torch(a):
    """Load the original reference engine, or a random tiny model for a source-only fixture."""
    source = a.decider_source or a.model
    if source:
        sys.path.insert(0, os.path.abspath(source))
    with S.reference_convolution():
        return _profile_torch(a)


def _profile_torch(a):
    import torch
    from decider import schema_engine
    from decider.systemone import plan_rows, render_question
    from transformers.models.qwen3_5 import modeling_qwen3_5 as modeling

    started = time.perf_counter()
    if a.model:
        from decider.engine import Engine
        engine = Engine(a.model, device=a.torch_device, dtype=getattr(torch, a.torch_dtype),
                        use_graphs=False, compile=False)
        settings = json.loads(Path(a.model, "decider_config.json").read_text())
        temperature = float(settings.get("temperature_schema_first", settings.get("temperature", a.temperature)))
    else:
        from transformers import AutoConfig, AutoModelForCausalLM
        from decider.prompt import letter_ids
        torch.manual_seed(0)
        cfg = AutoConfig.from_pretrained(str(Path(a.random_config).resolve().parent), local_files_only=True)
        lm = AutoModelForCausalLM.from_config(cfg, dtype=getattr(torch, a.torch_dtype)).to(a.torch_device).eval()
        tok = S.SyntheticTokenizer()
        letters = torch.tensor(letter_ids(tok), device=a.torch_device)
        engine = SimpleNamespace(core=lm.model, W=lm.lm_head.weight[letters].detach().clone(), tok=tok,
                                 dev=a.torch_device, use_graphs=False, cfg={}, pool=None)
        settings, temperature = {}, a.temperature
    loaded = time.perf_counter() - started
    qs, lines = inputs(a)
    rows = plan_rows({k: render_question(v) for k, v in qs.items()}, bool(settings.get("isolated_levels")))[0]
    with torch.no_grad():
        ref = profile_reference(engine, rows, lines, temperature, device=a.torch_device, torch=torch,
                                schema_engine=schema_engine, modeling=modeling)
    ls = ref["line_seconds"]
    probability_rows = [row for state in ref["probs"] for row in state]
    nonfinite = sum(not all(math.isfinite(x) for x in row) for row in probability_rows)
    unnormalized = sum(all(math.isfinite(x) for x in row) and abs(sum(row) - 1.0) > 1e-3
                       for row in probability_rows)
    return dict(mode="profile-torch", questions=a.questions, rows=len(rows), states=a.states,
                device=a.torch_device, dtype=a.torch_dtype, weights="model" if a.model else "synthetic",
                attention=engine.core.config._attn_implementation,
                convolution="decider.engine.patch_conv",
                load_seconds=loaded, prepare_seconds=ref["prepare_seconds"], prepare_spent=ref["prepare_spent"],
                first_line_seconds=ls[0], later_line_seconds_mean=sum(ls[1:]) / max(1, len(ls) - 1),
                line_spent_total=ref["line_spent"], calls=ref["calls"],
                mean_suffix_tokens=sum(ref["suffix_tokens"]) / len(ref["suffix_tokens"]),
                probability_rows=len(probability_rows), nonfinite_probability_rows=nonfinite,
                unnormalized_probability_rows=unnormalized)


def main():
    ap = argparse.ArgumentParser()
    src = ap.add_mutually_exclusive_group(required=True)
    src.add_argument("--model")
    src.add_argument("--random-config")
    ap.add_argument("--questions", type=int)
    ap.add_argument("--states", type=int)
    ap.add_argument("--profile-torch", action="store_true", help="profile the original PyTorch components instead of timing MLX")
    ap.add_argument("--decider-source", help="directory holding the reference decider package (required for a synthetic Torch profile)")
    ap.add_argument("--torch-device", default="mps")
    ap.add_argument("--torch-dtype", default="bfloat16")
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
    a.questions = a.questions if a.questions is not None else (20 if a.profile_torch else 303)
    a.states = a.states if a.states is not None else (4 if a.profile_torch else 132)
    if a.questions < 1 or a.states < 1:
        ap.error("questions and states must be positive")
    if a.profile_torch:
        if a.random_config and not a.decider_source:
            ap.error("a synthetic Torch profile needs --decider-source")
        print(json.dumps(profile_torch(a)), flush=True)
        return

    import mlx.core as mx
    from questions_first.backbone import Backbone, Config
    from questions_first.engine import QuestionsFirst
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
    qs, sts = inputs(a)
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
