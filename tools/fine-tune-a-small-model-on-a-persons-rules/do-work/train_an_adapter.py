"""LoRA-fine-tune decider-2b on data/train.jsonl with cross-entropy on the option letter (the decider recipe).

usage: train.py --out <adapter dir> [--rank 8] [--epochs 2] [--lr 2e-4] [--batch 8] [--budget-min 90]

Runs on MPS at nice 15 with two CPU threads. After 20 steps it projects the whole run; when the projection passes
--budget-min it stops and writes nothing but the log."""
import json
import math
import random
import sys
import time
from pathlib import Path

import torch
import torch.nn.functional as F

sys.path.insert(0, str(Path(__file__).resolve().parent))
import common  # noqa: E402

HERE = Path(__file__).resolve().parent


def arg(argv, name, default, cast=str):
    return cast(argv[argv.index(name) + 1]) if name in argv else default


def main(argv):
    out = Path(arg(argv, "--out", None))
    rank, epochs, lr, bs = arg(argv, "--rank", 8, int), arg(argv, "--epochs", 2, int), arg(argv, "--lr", 2e-4, float), arg(argv, "--batch", 8, int)
    budget = arg(argv, "--budget-min", 90.0, float) * 60
    common.quiet()
    torch.manual_seed(20261017)
    from peft import LoraConfig, get_peft_model
    m = common.load()
    peft = get_peft_model(m.lm, LoraConfig(r=rank, lora_alpha=2 * rank, lora_dropout=0.05, target_modules=common.LORA_TARGETS))   # LoRA goes into m.lm in place
    peft.print_trainable_parameters()
    m.train()
    rows = [json.loads(ln) for ln in open(HERE / "data/train.jsonl")]
    items = [common.item(m.tok, r["text"], r["question"], r["options"], r["gold"]) for r in rows]
    params = [p for p in m.parameters() if p.requires_grad]
    opt = torch.optim.AdamW(params, lr=lr, weight_decay=0.0)
    steps = epochs * math.ceil(len(items) / bs)
    sched = torch.optim.lr_scheduler.LambdaLR(opt, lambda s: min(1.0, (s + 1) / 20) * max(0.05, 1 - s / steps))
    rnd = random.Random(20261017)
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
                print(msg)
                log.write(msg + "\n")
                return 3
    peft.save_pretrained(str(out))
    json.dump({"base": str(common.MODEL), "rank": rank, "alpha": 2 * rank, "targets": common.LORA_TARGETS, "epochs": epochs, "lr": lr, "batch": bs,
               "rows": len(rows), "minutes": round((time.time() - t0) / 60, 1), "final_loss": round(run, 4), "frame": common.FRAME},
              open(out / "train-info.json", "w"), indent=1)
    print("saved", out)
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
