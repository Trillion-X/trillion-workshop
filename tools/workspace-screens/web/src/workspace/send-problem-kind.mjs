/** How a failed Files request should continue: retry in passing, restart after a conflict, or stop on refusal. */
/** @param {unknown} status */
/** @returns {'again' | 'restart' | 'refused'} */
export function sendProblemKind(status) {
  if (status === 409) return 'restart';
  if (typeof status === 'number' && status >= 400 && status < 500 && status !== 408 && status !== 422 && status !== 429) return 'refused';
  return 'again';
}
