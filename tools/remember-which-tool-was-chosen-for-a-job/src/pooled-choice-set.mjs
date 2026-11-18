// The content-free set of one tool choice, for the shared pool: how many tools were offered for a job and which position
// was run. Nothing about the job, the tools' names or the account leaves with it. It is built only while the account shares
// what it decides (the caller's share choice, src/sharing-choice.mjs); the caller sends the row it is handed, or nothing.
// The choices themselves are kept by workflow:remember-which-tool-was-chosen-for-a-job in the person's own store.
//
//   pooledChoiceSet({ shares, candidate_count, chosen_index }) -> the pool row, or null when nothing may leave
//   shares           whether this account shares what it decides now
//   candidate_count  how many tools were offered for the job
//   chosen_index     the position of the tool run among them
import { bytesToHex } from '@noble/hashes/utils.js';

export function pooledChoiceSet({ shares, candidate_count, chosen_index }) {
  if (!shares) return null;
  return { source: 'tool', method: null, choice_key: bytesToHex(crypto.getRandomValues(new Uint8Array(16))), candidate_count, chosen_index };
}
