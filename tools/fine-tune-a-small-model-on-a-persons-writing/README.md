# tools/fine-tune-a-small-model-on-a-persons-writing/

Teaches a small open chat model to write the way one person writes, from messages they really sent, and writes with it so it can be measured against any other way of writing in their voice on the same cases. Three steps, each one JSON request in and one answer out, all run on the person's own computer with the ready-made MLX trainer (`mlx_lm lora`):

1. **Build the pairs** (`do-work/build_writing_pairs.py`): each training row is the thread before one of the person's messages plus a plain draft of what they meant, and the answer is what they really sent. Threads the measuring cases come from are never written, not even to validation.
2. **Train an adapter** (`do-work/train_a_writing_adapter.py`): a LoRA (or DoRA) adapter on those rows, loss on the person's message only, with the adapter's BLAKE3 in `train-info.json`.
3. **Write with it** (`do-work/write_with_the_adapter.py`): one message per case, refused when the adapter's BLAKE3 differs from the one measured; with `adapter: null` the base model alone answers the same way, the floor to beat.

The cases an adapter is measured on are given the same way as its training rows: `{channel, context: [{who, words}], draft}`. The draft must be made the same way for training and for the cases (the same plain-wording step), or the adapter learns one input and is asked another.

## The person's settings

Everything personal is the request or the person's settings row: their messages and drafts, the held-out threads, the system words and frame, the model, every count and every training setting. The code names no person, channel, model or store.

The settings live in the person's `list:settings` as `record:setting:fine-tune-a-small-model-on-a-persons-writing~<scope_kind>~<scope_id>`; its `settings` hold one object per step, `build`, `train` and `write`, whose keys are that step's request keys. The request reads them through `with_settings` of the rules fine-tune's public `read-data/common.py` (which reads them with `tools/settings`): a key the request gives wins.

## Files

| File | Purpose |
|------|---------|
| `do-work/writing_common.py` | The request helpers (from `tools/fine-tune-a-small-model-on-a-persons-rules/read-data/common.py`, public), `render` (the one way a case becomes chat messages, used by training and writing alike) and `blake3_of`. |
| `do-work/build_writing_pairs.py` | Step 1: `train.jsonl` and `valid.jsonl` (`{messages}`), split by the BLAKE3 of each pair's id, with what was skipped and why. |
| `do-work/train_a_writing_adapter.py` | Step 2: writes mlx_lm's config, runs it at low priority, keeps its log, answers the adapter, its BLAKE3, the losses and the minutes. |
| `do-work/write_with_the_adapter.py` | Step 3: answers `{case_id, words, tokens_in, tokens_out, ms}` per case. |
| `test/test_writing_fine_tune.py` | Building pairs on made-up messages: held-out threads never written, determinism, refusals, the render shape. |

## What is fixed in code, and why

- Training always runs under the request's `memory_limit_gb` (MLX's memory limit) with gradient checkpointing: a 4B model with long rows held about 90 GB without them on Nov 21 2026 and starved the computer.
- The loss is on the person's message only (`mask_prompt`): the thread and draft are what the model is given, not what it learns to say.
- A pair lands in validation by the BLAKE3 of its id, so the same pairs always split the same way.
- A thread is shown as `them:` and `me:` lines, the person's own lines as `me`, because the model is speaking as them.
- Thinking is switched off in the chat template when writing: a message is said, not reasoned about.

## Dependencies

**Depends on:** Python 3 with `blake3`; `mlx` and `mlx_lm` (Apple silicon) for training and writing; `tools/fine-tune-a-small-model-on-a-persons-rules/read-data/common.py` and `tools/settings` for the request and settings.
