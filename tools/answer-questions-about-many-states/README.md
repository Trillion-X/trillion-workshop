# tools/answer-questions-about-many-states/

Asks one fixed set of questions about many states (lines, records, messages), in bulk, with a questions-first classifier on the person's own Mac. The questions are run once as a cached prefix, and the states are batched against that cache on Apple's GPU through MLX. Each state gets, for each question, the classifier's probabilities over the question's options.

The model is data. A model row from the person's list names the classifier family (`classifier`) and where the weights are (`weights`: a local folder, or a Hugging Face repo at a pinned revision). The settings, the question sets and every measured result are rows in the person's lists too. This folder holds only code: it names no model, person, book or voice.

The first family is `questions-first-decider`: a Qwen3.5 hybrid (gated delta-net layers plus gated full attention) trained to answer a prefix of questions (`decider.schema(questions).batch(states)`). This folder ports to MLX:
- the backbone;
- the decider's own prompt layout and answer shapes;
- its schema engine: one prefix per question (`independent`, the decider's default) or all in one (`packed`).

The decider's own engine is CUDA-only (CUDA graphs, flash-linear-attention), and its PyTorch fallback is a Python loop over chunks.

## The lifecycle

| Row | Action | What it does |
|-----|--------|--------------|
| `tool:get-a-classifier-ready-on-this-mac` | `get-ready` | Fetches the model row's weights (once), checks them, and names every file and the whole set by BLAKE3. |
| `tool:answer-questions-about-many-states` | `start` | Starts the run in the background. The job id is the BLAKE3 identity of the whole request, so the same request names the same run. |
| `tool:read-a-bulk-answer-run` | `read` | Gives status and states done. Once the run is finished or cancelled, it also gives the answers as byte pages: `{total, blake3, offset, length, base64, next_after_byte}`, read as `tools/records-door/read-data/byte-pages.mjs` reads a door's pages. |
| `tool:cancel-a-bulk-answer-run` | `cancel` | Stops the run after the batch in hand. The states already answered keep their answers. |

Every row runs `python3 -I tools/answer-questions-about-many-states/do-work/answer_many_states.py <action> --request '<json>'` from the Workshop checkout. A run works in `jobs_folder/<job id>/` (`request.json`, `status.json`, `answers.json`, `log.txt`) on the person's computer. That folder is working space: the caller keeps what matters as rows in the person's lists.

## Settings the person gives (no default in code)

| Setting | What it decides |
|---------|-----------------|
| `layout` | `independent`: each question in its own row, so no question can change another's answer; a state costs one row per question. `packed`: every question in one prefix; a state costs one row of state plus one slot per question, several times fewer tokens, but later questions see earlier ones. |
| `dtype` | `bfloat16` (the model's own) or `float32`. |
| `tokens_per_batch` | How many tokens one GPU pass holds. Larger is faster until memory runs out. |
| `max_state_tokens` | The most tokens of one state the model reads; a longer state is cut there, as the decider does. |
| `page_bytes` | How many bytes of answers one `read` returns. |

## What is fixed in code, and why

- **The prompt is the decider's own, token for token.** It runs `Question k: ... Options: (A) ...`, then `\n\nContext:\n<state>`, then the answer slots. The opening `\n\nContext:\n` is tokenized on its own, as the decider does. It is run once at the end of each prefix, so a state's row carries only its own tokens and slots.
- **Answer shapes and temperature come from the decider and the model folder.**
  - Labels are A..J, then single-token two-letter labels up to 255 options, read from the tied embedding.
  - Isolated score levels are on when the folder's `decider_config.json` says so.
  - The temperature is the folder's `temperature_schema_first`.
- **Batches cross questions.** Prefixes are run in left-padded batches: a pad's input to every delta-net layer is zeroed and attention masks it, so every prefix ends with the state it would have had alone.
  - A suffix batch holds rows of many questions. Each row's mask hides its own prefix's padding, and its positions continue from that prefix's length.
  - Its delta-net layers start from its question's conv and recurrent state, read by index.
  - On Apple's GPU, the index is read inside one Metal kernel, the decider lane's scan with an indexed start, so no state is copied per row.
  - Rows are grouped by state length, so a batch is little padding. One batch is queued while the previous one is read back.
- **The chunked gated-delta rule has a matmul-only solve.** It is ported from transformers' `torch_chunk_gated_delta_rule` and used for prefixes and off Apple's GPU. It solves each chunk's unit lower-triangular system by recursive block inversion: exact, and only matmuls. A Neumann series in powers of the strictly lower part would overflow in float32 when keys are correlated.
- **Norms run in float32.** Zero-centred norms compute in float32 with `(1 + weight)` in float32, rounded once, as transformers does. Adding 1 to a bfloat16 weight moves P(yes) by up to 0.007, as the decider lane measured.

## Files

| File | Purpose |
|------|---------|
| `do-work/answer_many_states.py` | The entry for every row: `get-ready`, `start`, `read`, `cancel`, and `work` (the background run). Holds `FAMILIES`, the classifier families it runs. |
| `do-work/questions_first/backbone.py` | The Qwen3.5 hybrid text backbone in MLX, read from `config.json` and safetensors; prefix and suffix passes. |
| `do-work/questions_first/gated_delta.py` | The chunked gated-delta rule in MLX, and the token-by-token form the tests hold it to. |
| `do-work/questions_first/metal_scan.py` | The Metal gated-delta scan with one start state per row, read by index. |
| `do-work/questions_first/engine.py` | `QuestionsFirst`: `prepare(rows, independent)` once, `score(prepared, states)` in batches, with progress and stop. |
| `do-work/questions_first/prompt.py` | The decider's questions-first prompt and its choice, score and noul answers, ported. |
| `do-work/questions_first/tokenizer.py` | The model folder's `tokenizer.json`, read with `tokenizers`, with no special tokens added. |
| `test/test_questions_first.py` | The MLX forward on a tiny made-up config: chunked = recurrent kernel, the triangular inverse, the cache equal to the plain uncached sequence (independent and packed), batch size changes nothing, stop and progress, and the Metal path's wiring. On a Mac it also runs the Metal kernel itself. |
| `test/test_lifecycle.py` | get-ready, start, read in byte pages, cancel and every refusal, with a made-up classifier family. |
| `test/test_end_to_end.py` | The whole command, through a real background process, on a made-up model folder (tiny random weights, a word-level tokenizer built in the test). |
| `test/agree_with_reference.py` | Agreement with the decider's own PyTorch code (`Decider.schema` → `SchemaEngine` → `CompiledSchema.batch`), two steps. |
| `test/benchmark.py` | Wall time of 303 questions × 132 states, both layouts. |
| `test/synthetic.py` | The made-up tokenizer, questions and states (with the decider lane's speed set). No real text. |
| `test/answer-questions-about-many-states.test.mjs` | Runs the Python tests under `npm test` and checks the rows. |

## Measured

All data below is synthetic.

- **The decider's own PyTorch code, CPU, float32, random weights, 200 made-up question × state pairs.**
  - Tiny config: the MLX answers agree within 1.9e-7, independent and packed, and every choice is the same.
  - The full 2B `config.json` (random weights rounded to bfloat16, computed in float32): agree within 9.2e-6 over the 200 pairs (290 rows), every choice the same. On that CPU-only box the large projections ran through NumPy (`--numpy-projections`), because MLX's Linux CPU build multiplies matrices at about 3 GFLOPS.
- **Still to run on the M5 Max after merge:**
  - `python3 tools/answer-questions-about-many-states/test/benchmark.py --model <decider snapshot folder>` for the 303 × 132 wall time. The target is 60 s. The decider lane's earlier MLX build took 121.0 s on the same set: one question per pass, 5,684 suffix tokens/s.
  - `python3 tools/answer-questions-about-many-states/test/agree_with_reference.py reference --decider-source <snapshot> --model <snapshot> --dtype bfloat16 --out /tmp/agree`, then `... mlx --out /tmp/agree` for agreement on the real weights. The tolerance is 0.01.

## Not here yet

- **Only one classifier family.** `questions-first-decider` is the only one. Another family is a new entry in `FAMILIES` with its own `check` and `answer`.
- **Long states run token by token on the Metal path.** The scan is a recurrence over the state's tokens: right for short lines. A long state (thousands of tokens) would be faster with the chunked rule on the GPU. That needs a chunked kernel that reads its start by index.
- **A run lives only on the Mac that started it.** It is a process there, with its folder there. The engine has no per-tool state folder kept between runs, so `read` and `cancel` must be run on that same Mac with the same `jobs_folder`.

## Dependencies

**Depends on:** `mlx`, `numpy`, `tokenizers`, `blake3`, and `huggingface_hub` (for `get-ready` from a repo), all from the rows' `get_it`. Python's standard library otherwise. No other Workshop folder.

**Depended on by:** `tool-rows.json` and the tests here.

## Licence

The ported decider code is Apache-2.0 (Mapika/decider-2b, snapshot b37f7e1ba3fbc9238004cf531fabbee2619973fd), as is this repository. The model's weights carry their own licence.
