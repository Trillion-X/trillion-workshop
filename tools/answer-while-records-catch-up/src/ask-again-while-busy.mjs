// The one owner of "busy means ask again". An owner that answers busy (service-busy) answers a moment later: an own-records
// book opened cold answers its first call 'These records are catching up' and wakes the upkeep that rebuilds it
// (src/record-book.mjs rebuildRecordProjection), a carry filling it answers busy until it publishes. The caller waits, not
// the person: a call is asked again until it is answered or the budget (src/ask-again-while-busy.json) is spent, and then it
// answers busy itself, with the owner's own words. Only work that is safe to repeat is asked again: a read, or a command
// under the one request key its owner keeps it one command by (src/native-resource-command.mjs).
import { failureOf } from '../../shared-code/src/failure.mjs';
import rule from './ask-again-while-busy.json' with { type: 'json' };

/** Whether a failure is a busy answer (service-busy), which a moment later is answered. */
export const answeredBusy = error => failureOf(error).code === 'service-busy';

/** ask() again while it answers busy, until it answers or { budget_ms } from the first ask is spent; then its last busy
 *  answer is thrown. Any other failure is thrown at once. */
export const askedUntilAnswered = async (ask, { budget_ms = rule.budget_ms, wait_ms = rule.wait_ms } = {}) => {
  const until = Date.now() + budget_ms;
  for (;;) {
    try { return await ask(); } catch (error) {
      if (!answeredBusy(error)) throw error;
      const wait = Number.isFinite(error?.retry_after_ms) ? Math.max(error.retry_after_ms, wait_ms) : wait_ms;
      if (Date.now() + wait > until) throw error;
      await new Promise(resolve => setTimeout(resolve, wait));
    }
  }
};
