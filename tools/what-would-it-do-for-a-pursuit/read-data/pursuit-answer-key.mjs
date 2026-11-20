// tools/what-would-it-do-for-a-pursuit/read-data/pursuit-answer-key.mjs
//
// The key a kept answer is stored under: a BLAKE3 of the rules, the recordings listed and the pursuit's words, so a changed rule,
// a new recording or a new pursuit answers afresh. The old code keyed its KV entry the same way (src/pursuit-plan.mjs pursuitPlan).
import { blake3 } from '@noble/hashes/blake3.js';
import { bytesToHex } from '@noble/hashes/utils.js';
import { PURSUIT_PLAN_RULES } from './pursuit-plan-rules.mjs';

/** The key for one pursuit, given the recordings listed right now. */
export function pursuitAnswerKey(pursuit, recordings = []) {
  const basis = [JSON.stringify(PURSUIT_PLAN_RULES), recordings.map(recording => `${recording.id}:${recording.video ?? ''}`).join(','), pursuit.toLowerCase()].join('\n');
  return `pursuit-plan:${bytesToHex(blake3(new TextEncoder().encode(basis)))}`;
}
