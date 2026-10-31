// tools/lessons-and-learning-paths/do-work/plan-an-evaluation-write.mjs
//
// The writes that accept one evaluation of a learner's step: the receipt, then the learner's next progress state.
// Run by the Workshop tool `tool:plan-an-evaluation-write` in the tool container:
//
//   node do-work/plan-an-evaluation-write.mjs < <the input as JSON>
//
// and prints { idempotent, receipt_ref, state_ref, revision, decision_key, writes } as JSON on its last line. It
// writes nothing: the caller writes `writes` through the records door, each with its `expect`, and reads them back.
// A stale revision, a conflicting receipt or an unsound receipt is refused with the reason.
import { text } from 'node:stream/consumers';
import { acceptEvaluation } from './learning-progress.mjs';

const input = JSON.parse((await text(process.stdin)) || '{}');
console.log(JSON.stringify(acceptEvaluation({
  receipt: input.receipt,
  expectedStateRevision: input.expected_state_revision,
  storedReceipt: input.stored_receipt ?? null,
}, input.current_state ?? null)));
