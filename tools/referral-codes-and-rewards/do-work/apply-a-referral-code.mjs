// tools/referral-codes-and-rewards/do-work/apply-a-referral-code.mjs
//
// The command of tool:apply-a-referral-code. One JSON input (argv[2]): { account, code, events, occurred_at? }.
// Prints one JSON line { events }: the two events to save when `account` types `code`, the account's own record that it
// was given the code and the maker's own signup event naming the account that typed it (which the maker's accepted
// count reads). The code must be live in `events`, nobody applies their own code, and an account's first code stands.
import { referralCodeAppliedEvents } from '../read-data/referral-codes.mjs';

export function applyAReferralCode(input) {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) throw new Error('Give { account, code, events }.');
  return { events: referralCodeAppliedEvents({ account: input.account, code: input.code, events: input.events, occurredAt: input.occurred_at ?? new Date().toISOString() }) };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  try { process.stdout.write(`${JSON.stringify(applyAReferralCode(JSON.parse(process.argv[2] ?? '{}')))}\n`); }
  catch (error) { process.stderr.write(`${error.message}\n`); process.exitCode = 1; }
}
