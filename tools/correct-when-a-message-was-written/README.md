# tools/correct-when-a-message-was-written

tool:correct-when-a-message-was-written shows when the person actually wrote a message their record kept without its original time (an older chat recorded later). The message keeps its id, text and links; it gains `authored_at` (the exact time the person wrote it) and `captured_at` (the time it was kept), and a correction row keeps the evidence.

The time is checked by the same rule every given time follows (keep-and-wake src/claimed-time.mjs): any past time, never one ahead of this service's clock by more than the allowance, and never after the capture time.

Rows in, rows out: the run reads no store. The caller reads the message and any earlier correction, hands them in, and stores the rows answered under `keep`.

Old code: tools.mjs correct_message_authored_at (tools/list-and-run-my-tools-for-any-ai/source-baselines/tools.mjs.held:231 at b6ae0ebf815f). The rule was keep-and-wake src/messages.mjs correctAuthoredAt (no caller on origin/main); it stays there until a caller is wired.

Tests: `node --test test/correct-when-a-message-was-written.test.mjs` (4 tests: a kept message shows the exact time and keeps its id; the same correction answers again and a different one is refused; a future time, a non-time and missing evidence are refused; only a kept person message can be dated and never after its capture time).
