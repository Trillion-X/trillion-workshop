// tools/referral-codes-and-rewards/do-work/withdraw-a-referral-code.mjs
//
// The command of tool:withdraw-a-referral-code. One JSON input (argv[2]): { referrer, code, occurred_at? }.
// Prints one JSON line { event }: the event to save so the code stops earning. Only the account that made the code can
// withdraw it; the events are read that way, so another account's withdrawal is ignored.
import { referralCodeWithdrawnEvent } from '../read-data/referral-codes.mjs';

export function withdrawAReferralCode(input) {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) throw new Error('Give { referrer, code }.');
  return { event: referralCodeWithdrawnEvent({ referrer: input.referrer, code: input.code, occurredAt: input.occurred_at ?? new Date().toISOString() }) };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  try { process.stdout.write(`${JSON.stringify(withdrawAReferralCode(JSON.parse(process.argv[2] ?? '{}')))}\n`); }
  catch (error) { process.stderr.write(`${error.message}\n`); process.exitCode = 1; }
}
