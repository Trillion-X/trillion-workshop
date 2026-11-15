"""Does the MLX forward give the decider's own PyTorch answers? Two steps, so the two frameworks never share memory:

  1. reference: runs the decider's own code (decider.infer.Decider.schema -> SchemaEngine.prepare -> CompiledSchema.batch,
     eager, no CUDA) over made-up questions and states, and writes every row's probabilities.
         python3 agree_with_reference.py reference --decider-source <dir holding decider/> --out <dir>
                 [--model <dir with config.json + weights + tokenizer> | --random-config <config.json>]
                 [--dtype float32] [--device cpu|mps|cuda]
     With --random-config it builds a randomly initialised model from that config (seeded), saves its weights in
     <out>/model, and uses the made-up tokenizer: synthetic weights, synthetic text.
  2. mlx: scores the same pairs with this tool's MLX forward and compares.
         python3 agree_with_reference.py mlx --out <dir> [--dtype float32] [--tolerance 0.01]
     Prints one JSON line: {"ok", "pairs", "rows", "max_abs_diff", "tolerance", ...}.

Needs torch and transformers 5.17 for step 1 and mlx for step 2.
"""
import argparse, json, math, os, sys, time, types

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
sys.path.insert(0, os.path.join(HERE, "..", "do-work"))
import synthetic as S  # noqa: E402


def case(args):
    qs = S.questions(args.questions, seed=args.seed)
    sts = S.states(args.states, seed=args.seed + 1)
    return qs, sts


def reference(args):
    sys.path.insert(0, args.decider_source)
    with S.reference_convolution():
        return _reference(args)


def _reference(args):
    import torch
    from decider import infer, schema_engine  # the decider's own code
    torch.manual_seed(args.seed)
    dtype = getattr(torch, args.dtype)
    os.makedirs(args.out, exist_ok=True)
    if args.random_config:
        from transformers import AutoConfig, AutoModelForCausalLM
        cfg = AutoConfig.from_pretrained(os.path.dirname(os.path.abspath(args.random_config)))
        # initialise and save in bfloat16 (the model's own dtype), then read the saved weights back in --dtype:
        # both frameworks read the same bfloat16 weights, and no step holds two full copies (a 15 GB machine runs it).
        # Initialise, round every weight to a bfloat16 value in place (the model's own dtype), and write the weights one
        # layer per safetensors file in bfloat16. Both frameworks then read the same values, and no step holds a second
        # full copy (the 2B config runs on a 15 GB machine).
        from safetensors.torch import save_file
        with torch.device("cpu"):
            lm = AutoModelForCausalLM.from_config(cfg, dtype=torch.float32)
        lm = lm.eval()
        model_dir = os.path.join(args.out, "model")
        os.makedirs(model_dir, exist_ok=True)
        cfg.save_pretrained(model_dir)
        groups = {}
        with torch.no_grad():
            for name, p in lm.named_parameters():
                p.copy_(p.to(torch.bfloat16).to(p.dtype))
                if name == "lm_head.weight" and cfg.tie_word_embeddings:
                    continue
                key = ".".join(name.split(".")[:3]) if name.startswith("model.layers.") else "rest"
                groups.setdefault(key, []).append((name, p))
            for k, (key, items) in enumerate(groups.items()):
                save_file({n: t.detach().to(torch.bfloat16).contiguous() for n, t in items}, os.path.join(model_dir, f"model-{k:05d}.safetensors"))
        lm = lm.to(device=args.device, dtype=dtype)
        tok = S.SyntheticTokenizer()
        tokenizer = "synthetic"
        temperature = 1.18 if args.temperature is None else args.temperature
    else:
        from transformers import AutoModelForCausalLM, AutoTokenizer
        lm = AutoModelForCausalLM.from_pretrained(args.model, dtype=dtype).to(args.device).eval()
        tok = AutoTokenizer.from_pretrained(args.model)
        model_dir, tokenizer = os.path.abspath(args.model), "model"
        dc = json.load(open(os.path.join(args.model, "decider_config.json")))
        temperature = float(dc.get("temperature_schema_first", dc.get("temperature", 1.0))) if args.temperature is None else args.temperature
    from decider.prompt import letter_ids
    letters = torch.tensor(letter_ids(tok), device=args.device)
    eng = types.SimpleNamespace(core=lm.model, W=lm.lm_head.weight[letters].detach().clone(), tok=tok, dev=args.device,
                                use_graphs=False, cfg={}, pool=None)
    dec = types.SimpleNamespace(eng=eng, _se=None, _schemas={}, isolated_levels=True, T_schema=temperature, name="decider-reference")
    qs, sts = case(args)
    t = time.time()
    with torch.no_grad(), S.reference_inputs(args.device, torch_module=torch, schema_module=schema_engine):
        compiled = infer.Decider.schema(dec, qs, independent=not args.packed)
        t_prep = time.time() - t
        from decider.systemone import render_state
        rows = []
        for i in range(0, len(sts), args.states_per_batch):
            probs = dec._se.score(compiled.h, [render_state(s) for s in sts[i:i + args.states_per_batch]], temperature=temperature, max_ctx_tokens=32768)
            rows += [[[float(x) for x in r[:n]] for r, n in zip(p, compiled.h.nopts)] for p in probs]
        # the decider's own assemble over the rows above (CompiledSchema.batch would score every state in one batch)
        from decider.systemone import assemble
        answers = [{"answers": assemble(compiled.rqs, compiled.index, [list(r) for r in rws])} for rws in rows]
    json.dump(dict(model_dir=model_dir, tokenizer=tokenizer, dtype=args.dtype, device=args.device,
                   attention=lm.config._attn_implementation, convolution="decider.engine.patch_conv",
                   temperature=temperature, packed=args.packed,
                   questions=qs, states=sts, rows=rows, answers=[a["answers"] for a in answers],
                   seconds=dict(prepare=t_prep, total=time.time() - t)), open(os.path.join(args.out, "reference.json"), "w"))
    print(json.dumps(dict(ok=True, wrote=os.path.join(args.out, "reference.json"), seconds=round(time.time() - t, 1))))


def numpy_projections():
    """For a CPU-only check: MLX's Linux CPU build multiplies matrices at a few GFLOPS (about 3 on a 4-core box, against
    400+ for NumPy's BLAS), so a 2B forward takes hours. This computes only the weight projections (the linear layers
    and the MLP) with NumPy; the kernel, the cache, masks, rope, norms and the answers stay MLX. Never used on a Mac."""
    import mlx.core as mx
    import numpy as np
    from questions_first import backbone

    def linear(x, w):
        return mx.array(np.asarray(x) @ np.asarray(w).T)

    def mlp(x, wg, wu, wd):
        xn = np.asarray(x)
        g = xn @ np.asarray(wg).T
        return mx.array(((g / (1 + np.exp(-g))) * (xn @ np.asarray(wu).T)) @ np.asarray(wd).T)
    backbone.linear = linear
    backbone._mlp_compiled = mlp


def compare_probabilities(actual, expected, option_counts, state_count, tolerance, normalization_tolerance=1e-5):
    """Compare every active probability; invalid data must never count as agreement."""
    if not math.isfinite(tolerance) or tolerance < 0:
        raise ValueError("tolerance must be finite and nonnegative")
    if not math.isfinite(normalization_tolerance) or normalization_tolerance < 0:
        raise ValueError("normalization tolerance must be finite and nonnegative")
    if not option_counts or state_count <= 0 or any(n <= 0 for n in option_counts):
        raise ValueError("comparison needs nonempty states, rows and options")
    for name, states in (("MLX", actual), ("reference", expected)):
        if len(states) != state_count:
            raise ValueError(f"{name} state count differs from the planned inputs")
        for s, state in enumerate(states):
            if len(state) != len(option_counts):
                raise ValueError(f"{name} row count differs at state {s}")
            for q, (row, n) in enumerate(zip(state, option_counts)):
                if len(row) < n or (name == "reference" and len(row) != n):
                    raise ValueError(f"{name} option count differs at state {s}, row {q}")
                if any(not math.isfinite(float(p)) for p in row):
                    raise ValueError(f"{name} has a nonfinite probability at state {s}, row {q}")
                if any(float(p) < 0 or float(p) > 1 for p in row[:n]):
                    raise ValueError(f"{name} has an invalid probability at state {s}, row {q}")
                if abs(sum(float(p) for p in row[:n]) - 1) > normalization_tolerance:
                    raise ValueError(f"{name} has an unnormalized row at state {s}, row {q}")
                if any(float(p) != 0 for p in row[n:]):
                    raise ValueError(f"{name} has nonzero padding at state {s}, row {q}")
    worst, at, same = 0.0, None, 0
    for s, (mine, theirs) in enumerate(zip(actual, expected)):
        for q, row in enumerate(theirs):
            for j, p in enumerate(row):
                delta = abs(float(mine[q][j]) - float(p))
                if delta > worst:
                    worst, at = delta, (s, q, j)
            same += int(max(range(len(row)), key=row.__getitem__)
                        == max(range(len(row)), key=lambda j: mine[q][j]))
    count = state_count * len(option_counts)
    return dict(max_abs_diff=worst, worst_at=at, argmax_agreement=same / count, rows=count)


def compare_answers(actual, expected):
    """Check the complete JSON answer shape and semantics, retaining numerical deltas."""
    if len(actual) != len(expected):
        raise ValueError("assembled answer state count differs")
    worst, choices, same_choices = 0.0, 0, 0

    def probability(value):
        if isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(value) or not 0 <= value <= 1:
            raise ValueError("assembled answer has an invalid probability")

    def validate(answer):
        for field in ("noul", "confidence", "certainty"):
            if field in answer:
                probability(answer[field])
        for value in answer.get("level_fit", {}).values():
            probability(value)
        if "probabilities" in answer:
            values = list(answer["probabilities"].values())
            if not values:
                raise ValueError("assembled answer has an empty probability map")
            for value in values:
                probability(value)
            # format_answer serializes four decimal places. Each rounded option
            # can contribute half of 1e-4 to the sum, independently of model error.
            # Existing isolated-score assembly preserves zero mass when no level
            # fits. It is an explicit zero-fit answer, not a normalized distribution.
            fits = answer.get("level_fit", {})
            zero_fit = (answer.get("type") == "score" and answer.get("fit_mass") == 0 and bool(fits)
                        and answer["probabilities"].keys() == fits.keys() == answer.get("legend", {}).keys()
                        and all(value == 0 for value in values) and all(value == 0 for value in fits.values()))
            if not zero_fit and abs(sum(values) - 1) > len(values) * 0.5e-4 + 1e-12:
                raise ValueError("assembled answer has an unnormalized probability map")
            if "confidence" in answer and answer["confidence"] != max(values):
                raise ValueError("assembled confidence contradicts its probabilities")
        if "fit_mass" in answer:
            fits = list(answer.get("level_fit", {}).values())
            mass = answer["fit_mass"]
            if isinstance(mass, bool) or not isinstance(mass, (int, float)) or not math.isfinite(mass) or not 0 <= mass <= len(fits):
                raise ValueError("assembled answer has an invalid fit mass")
            if abs(sum(fits) - mass) > (len(fits) + 1) * 0.5e-4 + 1e-12:
                raise ValueError("assembled fit mass contradicts its level probabilities")
        if answer.get("type") == "score":
            value = answer.get("score")
            if isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(value) or not 0 <= value <= len(answer.get("legend", {})) - 1:
                raise ValueError("assembled answer has an invalid score")

    def compare(a, b, path):
        nonlocal worst
        if isinstance(a, dict) and isinstance(b, dict):
            if a.keys() != b.keys():
                raise ValueError(f"assembled answer keys differ at {path}")
            for key in a:
                if key == "choice" and a.get("type") == "choice":
                    continue  # Each choice is checked against its own probabilities below.
                compare(a[key], b[key], f"{path}/{key}")
        elif isinstance(a, list) and isinstance(b, list):
            if len(a) != len(b):
                raise ValueError(f"assembled answer list length differs at {path}")
            for i, (x, y) in enumerate(zip(a, b)):
                compare(x, y, f"{path}/{i}")
        elif isinstance(a, (int, float)) and not isinstance(a, bool) and isinstance(b, (int, float)) and not isinstance(b, bool):
            if not math.isfinite(a) or not math.isfinite(b):
                raise ValueError(f"assembled answer has a nonfinite value at {path}")
            worst = max(worst, abs(a - b))
        elif type(a) is not type(b) or a != b:
            raise ValueError(f"assembled answer value differs at {path}")

    for s, (mine, theirs) in enumerate(zip(actual, expected)):
        for state in (mine, theirs):
            for answer in state.values():
                validate(answer)
        compare(mine, theirs, f"state {s}")
        for key in mine:
            if mine[key].get("type") != "choice":
                continue
            for answer in (mine[key], theirs[key]):
                probabilities = answer.get("probabilities", {})
                choice = answer.get("choice")
                if not probabilities or choice not in probabilities or probabilities[choice] != max(probabilities.values()):
                    raise ValueError(f"assembled choice contradicts its probabilities at state {s}")
            choices += 1
            same_choices += int(mine[key]["choice"] == theirs[key]["choice"])
    return dict(answers_max_abs_diff=worst, answer_choice_agreement=same_choices / choices if choices else None)


def mlx_side(args):
    import mlx.core as mx
    if args.numpy_projections:
        numpy_projections()
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
    # Softmax output roundoff is independent of cross-framework agreement. The
    # lower-precision bounds are half an ulp at one; float32 keeps a reduction allowance.
    normalization_tolerance = {"bfloat16": 2 ** -8, "float16": 2 ** -11}.get(ref["dtype"], 1e-5)
    try:
        comparison = compare_probabilities(probs, ref["rows"], [len(r["options"]) for r in rows],
                                           len(ref["states"]), args.tolerance, normalization_tolerance)
    except ValueError as error:
        print(json.dumps(dict(ok=False, error=str(error), tolerance=args.tolerance)))
        return 1
    answers = [P.assemble(rqs, index, [list(r) for r in p]) for p in probs]
    try:
        answer_comparison = compare_answers(answers, ref["answers"])
    except ValueError as error:
        print(json.dumps(dict(ok=False, error=str(error), tolerance=args.tolerance)))
        return 1
    out = dict(ok=bool(comparison["max_abs_diff"] <= args.tolerance and answer_comparison["answers_max_abs_diff"] <= args.tolerance),
               pairs=len(ref["questions"]) * len(ref["states"]), **comparison, **answer_comparison,
               normalization_tolerance=normalization_tolerance,
               tolerance=args.tolerance, numpy_projections=args.numpy_projections, dtype=args.dtype or ref["dtype"], packed=ref["packed"], mlx_seconds=round(secs, 1),
               reference_seconds=round(ref["seconds"]["total"], 1), device=str(mx.default_device()))
    out.update(reference_device=ref.get("device", "cpu"), reference_attention=ref.get("attention"),
               reference_convolution=ref.get("convolution", "unconfigured"))
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
    ap.add_argument("--device", choices=["cpu", "mps", "cuda"], default="cpu", help="PyTorch reference device; MLX uses its own device")
    ap.add_argument("--temperature", type=float, default=None)
    ap.add_argument("--questions", type=int, default=20)
    ap.add_argument("--states", type=int, default=10)
    ap.add_argument("--states-per-batch", type=int, default=2)
    ap.add_argument("--packed", action="store_true")
    ap.add_argument("--seed", type=int, default=0)
    ap.add_argument("--tolerance", type=float, default=0.01)
    ap.add_argument("--numpy-projections", action="store_true", help="CPU-only boxes: the linear layers through NumPy's BLAS")
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
