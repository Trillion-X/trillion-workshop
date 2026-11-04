// tools/choose-and-save-local-files/run/requests-kept-here.mjs
//
// Stands in for the workspace's #workspace-records in a run of this folder's row (run/package.json maps it here):
// sendRequestToBitfieldTarget keeps each request it is asked to send, in order, and sends nothing. It answers what
// answerWith was given (an empty answer when nothing was), so code that reads an answer reads that one.
export const kept = [];
let answer = () => ({});

export function answerWith(next) {
  answer = typeof next === 'function' ? next : () => next;
}

export async function sendRequestToBitfieldTarget(request) {
  kept.push(structuredClone(request));
  return answer(request);
}
