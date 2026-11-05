"""LoRA-fine-tune a decider model on train.jsonl with cross-entropy on the option letter (the decider recipe).

usage: python3 -I train_an_adapter.py <request.json | ->

Request: {base_model, frame, train_file, out, rank, epochs, lr, batch, budget_minutes, seed, lora_targets, device?,
nice?, threads?}, or settings_record with the person's `train` settings under it. Runs at the nice and thread count
asked (default nice 15 with two CPU threads) on the device asked, else DECIDER_DEVICE, else cuda, mps or cpu. After 20
steps it projects the whole run; when the projection passes budget_minutes it stops, writes nothing but the log and
answers an error."""
import json
import math
import random
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "read-data"))
import common  # noqa: E402
from common import Refused, need, run, with_settings  # noqa: E402

FOLDER = "fine-tune-a-small-model-on-a-persons-rules"


def main(req):
    req = with_settings(req, "train", FOLDER)
    out = Path(need(req, "out", str, "the folder the adapter is saved to")).expanduser()
    rank, epochs, lr, bs = need(req, "rank", int, "the LoRA rank"), need(req, "epochs", int, "how many passes over the rows"), need(req, "lr", (int, float), "the learning rate"), need(req, "batch", int, "rows per step")
    budget = need(req, "budget_minutes", (int, float), "the longest the run may take; it stops early when its projection passes this") * 60
    seed = need(req, "seed", int, "the integer seed, so a run can be made again")
    lora_targets = need(req, "lora_targets", list, "the model's module names LoRA goes into")
    train_file = Path(need(req, "train_file", str, "train.jsonl from build_training_rows.py")).expanduser()
    if not train_file.is_file():
        raise Refused(f"train_file {train_file} is not a file: make it with build_training_rows.py")
    common.configure(need(req, "base_model", str, "the decider model folder to train an adapter for"),
                     need(req, "frame", str, "the context the line is put in, holding {text}"), req.get("device"))
    common.LORA_TARGETS = lora_targets
    common.quiet(req.get("nice", 15), req.get("threads", 2))
    torch = common.torch
    import torch.nn.functional as F
    torch.manual_seed(seed)
    from peft import LoraConfig, get_peft_model
    m = common.load()
    peft = get_peft_model(m.lm, LoraConfig(r=rank, lora_alpha=2 * rank, lora_dropout=0.05, target_modules=common.LORA_TARGETS))   # LoRA goes into m.lm in place
    peft.print_trainable_parameters()
    m.train()
    rows = [json.loads(ln) for ln in open(train_file)]
    items = [common.item(m.tok, r["text"], r["question"], r["options"], r["gold"]) for r in rows]
    params = [p for p in m.parameters() if p.requires_grad]
    opt = torch.optim.AdamW(params, lr=lr, weight_decay=0.0)
    steps = epochs * math.ceil(len(items) / bs)
    sched = torch.optim.lr_scheduler.LambdaLR(opt, lambda s: min(1.0, (s + 1) / 20) * max(0.05, 1 - s / steps))
    rnd = random.Random(seed)
    out.parent.mkdir(parents=True, exist_ok=True)
    log = open(out.with_suffix(".log"), "w")
    t0, step = time.time(), 0
    for ep in range(epochs):
        order = list(range(len(items)))
        rnd.shuffle(order)
        run = 0.0
        for k in range(0, len(order), bs):
            b = common.collate([items[i] for i in order[k:k + bs]], m.tok.pad_token_id)
            lg = m.slot_logits(*[b[x].to(common.DEVICE) for x in ("input_ids", "attention_mask", "slot_idx", "slot_batch", "nopts")])
            loss = F.cross_entropy(lg, b["golds"].to(common.DEVICE))
            opt.zero_grad(set_to_none=True)
            loss.backward()
            torch.nn.utils.clip_grad_norm_(params, 1.0)
            opt.step()
            sched.step()
            step += 1
            run = 0.95 * run + 0.05 * loss.item() if step > 1 else loss.item()
            el = time.time() - t0
            if step % 10 == 0 or step == steps:
                msg = f"epoch {ep + 1} step {step}/{steps} loss {run:.4f} elapsed {el / 60:.1f} min projected {el / step * steps / 60:.1f} min"
                print(msg, flush=True)
                log.write(msg + "\n")
                log.flush()
            if step == 20 and el / step * steps > budget:
                msg = f"STOP: projected {el / step * steps / 60:.0f} min > budget {budget / 60:.0f} min"
                log.write(msg + "\n")
                raise Refused(msg + ": raise budget_minutes, or train fewer rows or epochs")
    peft.save_pretrained(str(out))
    json.dump({"base": str(common.MODEL), "rank": rank, "alpha": 2 * rank, "targets": common.LORA_TARGETS, "epochs": epochs, "lr": lr, "batch": bs,
               "rows": len(rows), "minutes": round((time.time() - t0) / 60, 1), "final_loss": round(run, 4), "frame": common.FRAME},
              open(out / "train-info.json", "w"), indent=1)
    print("saved", out)
    return {"adapter": str(out), **json.load(open(out / "train-info.json"))}


if __name__ == "__main__":
    sys.exit(run(main, sys.argv[1:]))
