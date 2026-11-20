# tools/correct-a-message-recorded-as-the-person

tool:correct-a-message-recorded-as-the-person corrects a message the person's record kept as their own words when it was really said by a sdk diagnostic, a peer or generated context. The corrected message keeps its text and time under a new id (derived the same way as every message id), with `corrected_from` naming the old one; the old row, its arrival rows and its thread index row retire with the evidence.

Rows in, rows out: the run reads no store. The caller reads the message, its arrival rows and its thread index row, hands them in, and stores the rows answered under `keep` (each with its `expected` value).

Old code: tools.mjs correct_message_provenance (tools/list-and-run-my-tools-for-any-ai/source-baselines/tools.mjs.held:230 at b6ae0ebf815f). The rule was in keep-and-wake src/messages.mjs correctProvenance (no caller, no test on origin/main); this tool's tests are the first.

Tests: `node --test test/correct-a-message-recorded-as-the-person.test.mjs` (3 tests: the message moves to a new id and its arrivals and thread row retire; a different correction for the same message is refused; only a kept person message can be corrected and the speaker and evidence are required).
