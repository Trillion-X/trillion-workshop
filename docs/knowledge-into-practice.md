# Knowledge into practice

Every source Brian keeps (a YouTube caption file, a book page, an X post, a launch-video analysis, a tennis lesson) becomes rows his AIs follow, step by step. This file is the design for that. The rows themselves live in Brian's Trillion lists. This file only says how they are shaped and which owner does what.

Decision case: `source:a25vd2xlZGdlIGludG8gcHJhY3RpY2U6IGV2ZXJ5IHNvdXJjZSdzIHRlYWNoaW5ncyBiZWNvbWUgZXhwbGljaXQgcm93cyB0aGF0IGFnZW50cyBmb2xsb3cgKEwwODIpLCBtb2RlcyBjaGFpbiB0aGVtLCBhIHJlY3Vyc2l2ZSBnYXAtY2xvc2luZyBydWxlIGtlZXBzIHRoZW0gY29tcGxldGU` (method `trillion-x-mode`, opened 6 Nov 2026 3:30 PM MST). Brian's request: 6 Nov 2026 2:12 PM MST. The binding rule is lesson L082 (banana-level explicit instructions).

## The failure this removes

Measured 6 Nov 2026 between 2:40 and 4:30 PM MST, through the door at `127.0.0.1:8788`. 90 rows were scored by hand. A row passed when it names one action (a tool id, a records call or a command), its exact input, a result someone can see, and a check that proves the step was done.

| Rows | Population | Sampled | Vague | Note |
|---|---|---|---|---|
| Execution-mode steps (`record:check`, `kind: step`, in the 10 modes trillion-x-mode, quintillion, infinity, put-it-in-the-world, real-life-cases, first-win, follow-through, keep-it-working, make-it-perform, personalized-reach-out) | 45 | 29 read | 29 (100%) | Each row is a bundle of prose paragraphs. None of the 45 has `good_answer` or a check. |
| Published workflow steps (`tools/workflows/published/workflow-steps.json`) | 574 | 31 | 12 (39%) | A word-pattern count over all 574 finds 235 steps (41%) with at least one sentence that leaves a choice open, and 791 of 5,511 sentences open. |
| Check rows (`kind: check`) | 815 | 20 | 15 (75%) | 16 of 815 have `good_answer`. Many are a quoted rejection or a pointer, with no instruction. |
| Decision-step checks (`kind: step`, part of `universal`) | 697 | 10 | 0 (0%) | Every one has a `good_answer` with a "Passes:" and a "Fails:" example. This is the shape the rest must copy. |
| All sampled | | 90 | 56 (62%) | |

The Checks list holds 45,697 rows: 39,088 source pieces, 1,006 steps, 815 checks and 23 branches (modes and methods). The pieces are there, but most of them reach no step an agent follows. Stored-and-never-used is the failure Brian named.

## The one primitive: a step row

Every instruction an agent follows is one step row with these fields. The same fields hold for a workflow step (`list:workflow-steps`), a mode step and a method step. There is no second shape.

| Field | What it holds | Example |
|---|---|---|
| `when` | The exact situation that starts the step (its pause point). | "The run's input names a YouTube channel id." |
| `do` | One action: a tool id, a `records:*` call or a command, with every input field named. One verb, one object. | "Call `tool:cite-principles-from-captions` with `extract` on `input.captions_folder`." |
| `submit` | The JSON schema of what the step hands back. | `{ principles: [{ quote, second, video_id }] }` |
| `done_when` | What anyone can see once the step is done: a row id, a file path, quoted visible text. | "Each principle is a row `record:check:<id>`, `kind: piece`, readable with `records:read`." |
| `checks` | Machine checks from `recipe-check-kinds.json` (`exists`, `covers`, `subset-of`, `mentioned-in`, `excludes-words`, `distinct-at-least`, `differs-from`). | `covers this.principles.* of input.videos` |
| `good_answer` | For a judged step: what passes and what fails, each with an example, as the 697 decision checks already do. | "Passes: … Fails: …" |
| `if_missing` | What to do when an input or a prerequisite is absent. A branch, never "use judgement". | "No captions file: run `tool:audio-transcription` on the video first." |
| `why` | The key point and its reason (Toyota job instruction), so the edge case can be handled. | "A quote that is not in the captions is invented." |
| `came_from` | The source piece ids and exact quotes the step was made from. | `["record:check:piece-…"]` |
| `part_of`, `position` | The branch (mode, method or workflow) and the order inside it. | `["infinity"]`, `3` |

A step that leaves any of `when`, `do`, `done_when`, `if_missing` empty, or a judged step with no `good_answer`, is not finished. The recipe validator refuses it (lane 1).

## One transform from any source

`workflow:turn-a-source-into-steps` runs the same steps on every source. Only the reader of the source format differs, and the readers already exist.

1. **Read the source into pieces.** Captions: `tool:cite-principles-from-captions` (`extract`, then `verify`, which fails when a quote is not in the captions). A post or a page: `tools/turn-something-shared-into-what-you-can-use`. A book: its OCR text, read page by page. Each piece is a `record:check` row with `kind: piece`, its exact words and its place (file and line, video and second, page).
2. **State each piece's teaching as a step row** with every field above, or write the piece's `no_check` reason (for example "a story, no instruction in it").
3. **Place the step.** Find the branch whose `when` the step serves (a mode, a method or a content workflow), by `records:list` on `record:check` with `where: {kind: "branch"}`. If none serves it, propose a new branch row in the same run.
4. **Check the step** with the validator (lane 1) and, for a judged step, a second AI (`tools/require-that-a-workflow-steps-ai-answer-comes`).
5. **Write the rows** with `records:write` at `@own-records` and read each back with `records:read`.
6. **Count coverage.** A piece with no step and no `no_check` reason is a gap. This ports old trillion's `scripts/method-sources.mjs:74` (each source's BLAKE3 kept, a test fails while a source piece has no check) from one decision method to every source (lane 3).

Templates and formats (the 353 launch-video analyses, 62 technique files, 128 principles and 230 channel templates in `trillion-launch-video/library/`) go through the same transform. Their steps are part of the `content-production` branch, so the content process reads them as its own steps.

## Modes chain steps

A mode is a branch row (`kind: branch`) whose steps run in `position` order. A mode can chain other modes with `chains: [branch ids]`; the run walks each chained mode's steps in place. Running a mode is `tool:start-a-recipe-run` with the mode's workflow id (`workflow:<branch id>`). Every step's answer is checked and kept by the workflow engine, as old trillion's `src/execution-modes.mjs` compiled a mode into a recipe.

## Routing: the right mode every time

The row `setting:ai-instruction:everywhere-pick-a-mode` goes into every generated Claude and Codex instruction file and into what the door tells every AI. It says: before any work, read the mode branches, pick the one whose `when` matches the request (trillion-x-mode when none is narrower), start its run and walk every step. A check row on the reply judge refuses a reply that names no run.

## The recursive gap rule

While following any step, an agent that has to decide something the step does not decide has found a gap. In the same run it:

1. writes a gap row, `record:check:gap-<step id>-<n>`, `kind: gap`, `part_of: [<step id>]`, holding what was undecided, what it chose, why, and its evidence;
2. rewrites the step row so that choice is decided: it adds the missing `if_missing` branch, the missing value or the missing check;
3. runs the validator on the rewritten step, and closes the gap row (`status: closed`, with the step version that closed it).

A run that leaves a gap row it wrote still open is not done. The count of open gap rows, plus the vague share measured above, is re-measured each week. The rule converges when both reach zero. The rule is written in L082 (the lesson), in the check row `record:check:close-the-gap-you-found` (the judge) and in the routing row above (what every AI is told).

## Where this came from (L078)

- Toyota job instruction: each step has key points and the reasons for them. https://www.lean.org/the-lean-post/articles/twi-job-instruction/
- Checklists (Gawande; Boeing): a defined pause point, 5 to 9 killer items, READ-DO or DO-CONFIRM. https://sive.rs/book/ChecklistManifesto
- Anthropic: a rule that must never be broken belongs in a hook, keep always-loaded files short, long procedures load on demand, tool arguments shaped so mistakes cannot be made. https://code.claude.com/docs/en/best-practices, https://code.claude.com/docs/en/memory, https://www.anthropic.com/engineering/building-effective-agents
- OpenAI: turn existing procedures into routines; every step is a specific action or output; branch for missing information; add guardrails from real failures. https://cdn.openai.com/business-guides-and-resources/a-practical-guide-to-building-agents.pdf
- After-action review (what was expected, what happened, why, what changes), Dalio's issue log, Reflexion (https://arxiv.org/abs/2303.11366) and GEPA (https://arxiv.org/abs/2507.19457): a miss is written back into the rule that will be read next time.
- SweetProcess: every procedure has an owner, an approver and a review date. https://www.sweetprocess.com/standard-operating-procedure/

## Old trillion (`/Users/brianakhtar/dev/trillion`)

- `records/workflow-recipe-records.json`: 124 recipes, 361 steps, each step `id, title, do, submit, checks`. Kept: the engine checks every submit.
- `b6ae0ebf81:src/execution-modes.mjs`: a mode compiled into a recipe. Kept.
- `methods/checks.json` (730 rows with `good_answer`), judged by `b6ae0ebf81:src/check-judge.mjs:106`. Kept as the `good_answer` field.
- `methods/sources.json` with `scripts/method-sources.mjs:74`: source coverage. Ported for every source (lane 3).
- Dropped: modes ran only when named, `do` was free prose, and the after-work review (`b6ae0ebf81:src/after-work-review.json`) shipped `"on": false`. Nothing updated an instruction when an agent hit a gap mid-step. The routing row and the gap rule replace these.

## Build lanes, one per owner, in order

| # | Owner | Files | Done when |
|---|---|---|---|
| 1 | trillion-workshop `tools/workflows` | `read-data/recipe-problems.mjs`, a new DATA file `step-anatomy.json` (the required fields and the open-choice words), `do-work/measure-step-explicitness.mjs`, `test/recipes.test.mjs` | The validator names every missing field of a step. The measure command prints the vague share for any list of steps. Tests pass. |
| 2 | Brian's lists (rows only) | The 45 mode step rows in `list:checks`, rewritten one sub-step per row with every field; then `tools/workflows/published/workflow-steps.json` re-published | The measure command reports 0 vague mode steps. |
| 3 | trillion-workshop `tools/turn-the-decision-methods-own-sources-into-workflows` | Port `from-old-trillion` `scripts/method-workflows.mjs.held` and old `scripts/method-sources.mjs` into one coverage command for any piece list; add the recipe `workflow:turn-a-source-into-steps` | Coverage prints pieces with no step and no reason, per source. |
| 4 | Brian's lists (runs of lane 3's workflow) | YouTube captions under `trillion-launch-video/library/youtube/` (Ryan Daniel Moran first, 660 of 2,727 done), X bookmarks and likes (`agent-junk/2026-10-03/x-library/` plus a fresh pull), the launch-video library, tennis course transcripts, the Hormozi books when the other lane finds them | Each source's coverage reaches 100% (a step or a reason for every piece). |
| 5 | ai-command-center reply judge (a check row, no code) | `record:check:a-turn-names-its-mode-run` in `list:checks`, read by `.claude/hooks/lists-judge-every-reply.py` | A reply with no mode run is refused. |
