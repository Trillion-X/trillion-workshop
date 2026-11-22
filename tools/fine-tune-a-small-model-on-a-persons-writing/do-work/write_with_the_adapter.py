"""Write each case's message with the base model and the person's adapter, checked by its BLAKE3 first.

usage: python3 -I write_with_the_adapter.py <request.json | ->

Request: {base_model, adapter, adapter_blake3, system, frame, context_lines, max_tokens, temperature, cases}, or
settings_record with the person's `write` settings under it. `cases` are rows {case_id, channel, context, draft} (inline
or {"file": a JSON Lines file}). The system words, frame and context_lines must be the ones the adapter was trained
with. adapter may be null to ask the base model alone, the same way. Answers one row per case: {case_id, words,
tokens_in, tokens_out, ms}."""
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from writing_common import FOLDER, Refused, blake3_of, need, render, rows_of, run, with_settings  # noqa: E402


def main(req):
    req = with_settings(req, "write", FOLDER)
    base = need(req, "base_model", str, "the MLX model folder or Hugging Face repo id the adapter was trained on")
    adapter = req.get("adapter")
    if adapter is not None:
        weights = Path(adapter).expanduser() / "adapters.safetensors"
        if not weights.is_file():
            raise Refused(f"{weights} is not a file: give the adapter folder train_a_writing_adapter.py wrote")
        want = need(req, "adapter_blake3", str, "the adapter's BLAKE3, from train-info.json")
        got = blake3_of(weights)
        if got != want:
            raise Refused(f"the adapter's BLAKE3 is {got}, not {want}: this is not the adapter that was measured")
    system, frame = need(req, "system", str, "the system words it was trained with"), need(req, "frame", str, "the frame it was trained with")
    context_lines = need(req, "context_lines", int, "how many thread lines it was trained with")
    max_tokens = need(req, "max_tokens", int, "the most tokens one message may take")
    temperature = need(req, "temperature", (int, float), "the sampling temperature (0 for the most likely words)")
    cases = rows_of(need(req, "cases", (list, dict), "rows {case_id, channel, context, draft}"), "cases")
    from mlx_lm import generate, load
    from mlx_lm.sample_utils import make_sampler
    model, tok = load(base, adapter_path=str(Path(adapter).expanduser()) if adapter else None)
    sampler = make_sampler(temp=float(temperature))
    answers = []
    for case in cases:
        prompt = tok.apply_chat_template(render(frame, system, case, context_lines), add_generation_prompt=True,
                                         tokenize=False, enable_thinking=False)
        start = time.time()
        words = generate(model, tok, prompt=prompt, max_tokens=max_tokens, sampler=sampler, verbose=False)
        answers.append({"case_id": case.get("case_id"), "words": words.strip(),
                        "tokens_in": len(tok.encode(prompt)), "tokens_out": len(tok.encode(words)),
                        "ms": round((time.time() - start) * 1000)})
    return {"base": base, "adapter": adapter, "answers": answers}


if __name__ == "__main__":
    sys.exit(run(main, sys.argv[1:]))
