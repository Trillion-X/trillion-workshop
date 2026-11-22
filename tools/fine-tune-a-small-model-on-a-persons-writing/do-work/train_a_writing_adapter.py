"""LoRA-train a small chat model on train.jsonl and valid.jsonl from build_writing_pairs.py with the ready-made MLX
trainer (mlx_lm lora), loss on the person's message only, and answer the adapter's BLAKE3.

usage: python3 -I train_a_writing_adapter.py <request.json | ->

Request: {base_model, data_dir, out, fine_tune_type, rank, scale, dropout, num_layers, iters, batch, lr,
max_seq_length, seed, memory_limit_gb, nice?}, or settings_record with the person's `train` settings under it. base_model is an MLX
model folder or Hugging Face repo id. The run is mlx_lm's own: this file writes its config (beside the adapter, as
train-config.json), runs it at the nice asked (default 10) under an MLX memory limit of memory_limit_gb, with gradient checkpointing, keeps its log as train-log.txt, and reads the train and
validation losses from it."""
import json
import os
import re
import subprocess
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from writing_common import FOLDER, Refused, blake3_of, need, run, with_settings  # noqa: E402


def main(req):
    req = with_settings(req, "train", FOLDER)
    out = Path(need(req, "out", str, "the folder the adapter is saved to")).expanduser()
    data = Path(need(req, "data_dir", str, "the folder holding train.jsonl and valid.jsonl")).expanduser()
    for side in ("train", "valid"):
        if not (data / f"{side}.jsonl").is_file():
            raise Refused(f"{data / (side + '.jsonl')} is missing: make it with build_writing_pairs.py")
    config = {
        "model": need(req, "base_model", str, "the MLX model folder or Hugging Face repo id"),
        "train": True,
        "data": str(data),
        "fine_tune_type": need(req, "fine_tune_type", str, "lora or dora"),
        "num_layers": need(req, "num_layers", int, "how many of the last layers get an adapter (-1 for all)"),
        "batch_size": need(req, "batch", int, "rows per step"),
        "iters": need(req, "iters", int, "training steps"),
        "learning_rate": need(req, "lr", (int, float), "the learning rate"),
        "max_seq_length": need(req, "max_seq_length", int, "the longest row in tokens"),
        "seed": need(req, "seed", int, "the integer seed, so a run can be made again"),
        "mask_prompt": True,
        "grad_checkpoint": True,
        "adapter_path": str(out),
        "steps_per_report": 10,
        "steps_per_eval": max(10, req["iters"] // 5),
        "save_every": req["iters"],
        "val_batches": -1,
        "lora_parameters": {"rank": need(req, "rank", int, "the LoRA rank"),
                            "scale": need(req, "scale", (int, float), "the LoRA scale"),
                            "dropout": need(req, "dropout", (int, float), "the LoRA dropout")},
    }
    memory_gb = need(req, "memory_limit_gb", (int, float), "the most memory the run may hold, in GB; past it the run stops instead of starving the computer")
    out.mkdir(parents=True, exist_ok=True)
    cfg = out / "train-config.json"
    cfg.write_text(json.dumps(config, indent=1))
    log = out / "train-log.txt"
    start = time.time()
    with open(log, "w") as f:
        launch = ("import sys, mlx.core as mx; mx.set_memory_limit(int(float(sys.argv[1]) * 2**30)); "
                  "from mlx_lm.lora import main; sys.argv = ['mlx_lm.lora', '-c', sys.argv[2]]; main()")
        code = subprocess.run([sys.executable, "-c", launch, str(memory_gb), str(cfg)], stdout=f, stderr=subprocess.STDOUT,
                              preexec_fn=lambda: os.nice(int(req.get("nice", 10)))).returncode
    text = log.read_text()
    if code != 0:
        raise Refused(f"mlx_lm lora ended with code {code}; the last of its log: {text[-600:]}")
    weights = out / "adapters.safetensors"
    if not weights.is_file():
        raise Refused(f"mlx_lm lora wrote no {weights}; the last of its log: {text[-600:]}")
    train = [float(x) for x in re.findall(r"Train loss ([0-9.]+)", text)]
    val = [(int(i), float(x)) for i, x in re.findall(r"Iter (\d+): Val loss ([0-9.]+)", text)]
    rows = {side: sum(1 for _ in open(data / f"{side}.jsonl")) for side in ("train", "valid")}
    peak = [float(x) for x in re.findall(r"Peak mem ([0-9.]+) GB", text)]
    info = {"adapter": str(out), "blake3": blake3_of(weights), "config_blake3": blake3_of(out / "adapter_config.json"),
            "peak_memory_gb": max(peak) if peak else None, "memory_limit_gb": memory_gb,
            "base": config["model"], "rows": rows, "minutes": round((time.time() - start) / 60, 2),
            "train_loss_last": train[-1] if train else None, "val_loss": val,
            "train_files_blake3": {side: blake3_of(data / f"{side}.jsonl") for side in ("train", "valid")}}
    (out / "train-info.json").write_text(json.dumps(info, indent=1))
    return info


if __name__ == "__main__":
    sys.exit(run(main, sys.argv[1:]))
