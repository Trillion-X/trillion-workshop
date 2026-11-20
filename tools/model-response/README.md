# tools/model-response/

Asking a model for an answer on a person's behalf: whose money pays for the request (a spend gate), content parts materialized from addresses, and an answer read while it is still arriving (words so far, the documents in the run, an unfinished JSON value).

## What is here

| File | Purpose |
|------|---------|
| `do-work/whose-money-pays-for-this.ts` | `spendGateAskForModelRequest`, `spendGateApproved`, `spendGateRefusalMessage`. Pure. Copied byte for byte from bitfield-packages `packages/model-response/do-work/whose-money-pays-for-this.ts` (7e4af0df56). |
| `do-work/materialize-addressed-content-parts.mjs` | `materializeAddressedContentParts` with its policy and error class. Pure. Copied byte for byte from bitfield-packages (ebf06ab600). |
| `read-data/an-answer-arriving-in-documents.ts` | `valueAtPath`, `documentsInTheRun`, `wordsInTheRun`, `oneAnswerFromTheRun`, `readUnfinishedJson`, `textSoFarAt`. Pure. Copied byte for byte from bitfield-packages (ebf06ab600). |
| `test/*.test.mjs` | The old vitest tests, ported to `node:test`. The materializer test generates its bytes in place instead of reading a fixture from another package tree. |
| `moved-from.json`, `part.json` | The receipt (source path and commit for each file) and the tree that imports these files. |

Run the tests with `node --test tools/model-response/test/*.test.mjs`.

## What is not here yet

The request itself (`request-model-response` in bitfield-packages, 5482a2a3c) is not ported. It assembled the provider request from DATA, rendered the body template, ran the spend gate before the candidate loop, sent the request to the HTTP executor, read the structured reply, and built the answer message. It called the retired Bitfield runtime and `slot::workflow` requests, so it cannot load as written.

Callers still name it as `model-response.request-model-response`:

- `tools/messages-screen/packages/chat/do-work/answer-one-addressed-turn.ts` (the answer to a message)
- `tools/ask-a-small-model-for-a-verdict/packages/answer-state-questions/do-work/answer-state-questions.ts`
- `tools/shared-code/packages/ask-a-small-model-for-a-verdict/do-work/ask-through-model-response.mjs`

No current tool serves that name. Those calls are the gap. Its open pieces are recorded as calendar task rows under `record:calendar-task:verify-every-port-model-response-*`, with the verdict table in the study row `verify-every-port/model-response`.

The read rules live only here. `tools/messages-screen/packages/chat/do-work/take-one-part-of-an-answer.ts` imports this file; no other copy exists.

**Depends on:** nothing that loads outside this folder.

**Depended on by:** nothing in this repository yet (see above).
