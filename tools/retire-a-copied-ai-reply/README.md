# tools/retire-a-copied-ai-reply

tool:retire-a-copied-ai-reply retires an AI reply that a person's AI recorded by hand (record_messages) when the transcript already kept the same reply. The transcript reply keeps its message id, its source_ref and its links; the copy's links are added to it; the copy's thread index row is retired with it.

Rows in, rows out: the run reads no store. The caller reads the copy, the transcript reply and any thread index row, hands them in, and stores the rows the run answers under `keep` (each with its `expected` value, so a store refuses a row that moved).

Old code: tools.mjs correct_message_duplicate (tools/list-and-run-my-tools-for-any-ai/source-baselines/tools.mjs.held:228 at b6ae0ebf815f). The rule and its tests came from tools/keep-and-wake-ai-sessions-on-this-computer/src/messages.mjs correctDuplicate and test/messages-capture-integrity.test.mjs, which stay where they are until the caller is wired.

Tests: `node --test test/retire-a-copied-ai-reply.test.mjs` (4 tests: the exact copy retires and merges links, the same correction answers again, a different text, conversation or distant time is refused, and a thread index row is retired with the copy).
