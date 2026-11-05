"""Does the MLX forward give the decider's own PyTorch answers? Two steps, so the two frameworks never share memory:

  1. reference: runs the decider's own code (decider.infer.Decider.schema -> SchemaEngine.prepare -> CompiledSchema.batch,
     eager, no CUDA) over made-up questions and states, and writes every row's probabilities.
         python3 agree_with_reference.py reference --decider-source <dir holding decider/> --out <dir>
                 [--model <dir with config.json + weights + tokenizer> | --random-config <config.json>] [--dtype float32]
     With --random-config it builds a randomly initialised model from that config (seeded), saves its weights in
     <out>/model, and uses the made-up tokenizer: synthetic weights, synthetic text.
  2. mlx: scores the same pairs with this tool's MLX forward and compares.
         python3 agree_with_reference.py mlx --out <dir> [--dtype float32] [--tolerance 0.01]
     Prints one JSON line: {"ok", "pairs", "rows", "max_abs_diff", "tolerance", ...}.

Needs torch and transformers 5.17 for step 1 and mlx for step 2.
"""
import argparse, json, os, sys, time, types

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
sys.path.insert(0, os.path.join(HERE, "..", "do-work"))
import synthetic as S  # noqa: E402


def case(args):
    qs = S.questions(args.questions, seed=args.seed)
    sts = S.states(args.states, seed=args.seed + 1)
    return qs, sts


def reference(args):
    import torch
    sys.path.insert(0, args.decider_source)
    from decider import infer, schema_engine  # the decider's own code
    torch.manual_seed(args.seed)
    dtype = getattr(torch, args.dtype)
    os.makedirs(args.out, exist_ok=True)
    if args.random_config:
        from transformers import AutoConfig, AutoModelForCausalLM
        cfg = AutoConfig.from_pretrained(os.path.dirname(os.path.abspath(args.random_config)))
        with torch.device("cpu"):
            lm = AutoModelForCausalLM.from_config(cfg, dtype=torch.float32)
        lm = lm.to(dtype).eval()
        model_dir = os.path.join(args.out, "model")
        lm.save_pretrained(model_dir, safe_serialization=True)
        tok = S.SyntheticTokenizer()
        tokenizer = "synthetic"
        temperature = 1.18 if args.temperature is None else args.temperature
    else:
        from transformers import AutoModelForCausalLM, AutoTokenizer
        lm = AutoModelForCausalLM.from_pretrained(args.model, dtype=dtype).eval()
        tok = AutoTokenizer.from_pretrained(args.model)
        model_dir, tokenizer = os.path.abspath(args.model), "model"
        dc = json.load(open(os.path.join(args.model, "decider_config.json")))
        temperature = float(dc.get("temperature_schema_first", dc.get("temperature", 1.0))) if args.temperature is None else args.temperature
    from decider.prompt import letter_ids
    letters = torch.tensor(letter_ids(tok))
    eng = types.SimpleNamespace(core=lm.model, W=lm.lm_head.weight[letters].detach().clone(), tok=tok, dev="cpu",
                                use_graphs=False, cfg={}, pool=None)
    dec = types.SimpleNamespace(eng=eng, _se=None, _schemas={}, isolated_levels=True, T_schema=temperature, name="decider-reference")
    qs, sts = case(args)
    t = time.time()
    with torch.no_grad():
        compiled = infer.Decider.schema(dec, qs, independent=not args.packed)
        t_prep = time.time() - t
        from decider.systemone import render_state
        rows = []
        for i in range(0, len(sts), args.states_per_batch):
            probs = dec._se.score(compiled.h, [render_state(s) for s in sts[i:i + args.states_per_batch]], temperature=temperature, max_ctx_tokens=32768)
            rows += [[[float(x) for x in r[:n]] for r, n in zip(p, compiled.h.nopts)] for p in probs]
        answers = compiled.batch(sts)
    json.dump(dict(model_dir=model_dir, tokenizer=tokenizer, dtype=args.dtype, temperature=temperature, packed=args.packed,
                   questions=qs, states=sts, rows=rows, answers=[a["answers"] for a in answers],
                   seconds=dict(prepare=t_prep, total=time.time() - t)), open(os.path.join(args.out, "reference.json"), "w"))
    print(json.dumps(dict(ok=True, wrote=os.path.join(args.out, "reference.json"), seconds=round(time.time() - t, 1))))


def mlx_side(args):
    import mlx.core as mx
    from questions_first.backbone import Backbone
    from questions_first.engine import QuestionsFirst
    from questions_first import prompt as P
    ref = json.load(open(os.path.join(args.out, "reference.json")))
    if ref["tokenizer"] == "synthetic":
        tok = S.SyntheticTokenizer(); pad = tok.pad_token_id
    else:
        from questions_first.tokenizer import load_tokenizer
        tok, pad = load_tokenizer(ref["model_dir"])
    t = time.time()
    bb = Backbone.load(ref["model_dir"], getattr(mx, args.dtype or ref["dtype"]))
    qf = QuestionsFirst(bb, tok, pad, temperature=ref["temperature"])
    rqs = {k: P.render_question(v) for k, v in ref["questions"].items()}
    rows, index = P.plan_rows(rqs, not ref["packed"])
    h = qf.prepare(rows, independent=not ref["packed"])
    probs = qf.score(h, [P.render_state(s) for s in ref["states"]])
    secs = time.time() - t
    worst, at = 0.0, None
    for s, (mine, theirs) in enumerate(zip(probs, ref["rows"])):
        for q, row in enumerate(theirs):
            for j, p in enumerate(row):
                d = abs(mine[q][j] - p)
                if d > worst:
                    worst, at = d, (s, q, j)
    argmax_same = sum(int(max(range(len(row)), key=row.__getitem__) == max(range(len(row)), key=lambda j: mine[q][j]))
                      for mine, theirs in zip(probs, ref["rows"]) for q, row in enumerate(theirs))
    n_rows = sum(len(r) for r in ref["rows"])
    answers = [P.assemble(rqs, index, [list(r) for r in p]) for p in probs]
    ans_worst = 0.0
    for a, b in zip(answers, ref["answers"]):
        for k in a:
            pa = a[k].get("probabilities", {"noul": a[k].get("noul")})
            pb = b[k].get("probabilities", {"noul": b[k].get("noul")})
            for name in pb:
                ans_worst = max(ans_worst, abs(float(pa[str(name)] if str(name) in pa else pa[name]) - float(pb[name])))
    worst = float(worst)
    out = dict(ok=bool(worst <= args.tolerance), pairs=len(ref["questions"]) * len(ref["states"]), rows=n_rows,
               max_abs_diff=worst, worst_at=at, answers_max_abs_diff=float(ans_worst), argmax_agreement=argmax_same / n_rows,
               tolerance=args.tolerance, dtype=args.dtype or ref["dtype"], packed=ref["packed"], mlx_seconds=round(secs, 1),
               reference_seconds=round(ref["seconds"]["total"], 1), device=str(mx.default_device()))
    print(json.dumps(out))
    return 0 if out["ok"] else 1


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("step", choices=["reference", "mlx"])
    ap.add_argument("--out", required=True)
    ap.add_argument("--decider-source")
    ap.add_argument("--model")
    ap.add_argument("--random-config")
    ap.add_argument("--dtype", default=None)
    ap.add_argument("--temperature", type=float, default=None)
    ap.add_argument("--questions", type=int, default=20)
    ap.add_argument("--states", type=int, default=10)
    ap.add_argument("--states-per-batch", type=int, default=2)
    ap.add_argument("--packed", action="store_true")
    ap.add_argument("--seed", type=int, default=0)
    ap.add_argument("--tolerance", type=float, default=0.01)
    a = ap.parse_args()
    if a.step == "reference":
        a.dtype = a.dtype or "float32"
        if not a.decider_source or not (a.model or a.random_config):
            ap.error("reference needs --decider-source and --model or --random-config")
        reference(a)
        return 0
    return mlx_side(a)


if __name__ == "__main__":
    sys.exit(main())
