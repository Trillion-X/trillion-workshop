// tools/referral-codes-and-rewards/do-work/make-a-referral-code.mjs
//
// The command of tool:make-a-referral-code. One JSON input (argv[2]):
//   { referrer, target: { on, value }, allowed_on: [sale attributes a code may point at], prefix?, code?, occurred_at? }
// Prints one JSON line { code, event }: the code (made from random letters unless `code` is given) and the event to save
// in the person's records. The tool keeps nothing; the code is live once the person saves the event, and a code already
// taken by another account stays that account's (the first event wins when the events are read).
import { randomBytes } from 'node:crypto';
import { makeReferralCode, normalizeReferralCode, referralCodeCreatedEvent } from '../read-data/referral-codes.mjs';

export function makeAReferralCode(input, random = count => randomBytes(count)) {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) throw new Error('Give { referrer, target, allowed_on }.');
  const code = input.code === undefined ? makeReferralCode({ prefix: input.prefix, randomBytes: random }) : normalizeReferralCode(input.code);
  const occurredAt = input.occurred_at ?? new Date().toISOString();
  const event = referralCodeCreatedEvent({ referrer: input.referrer, code, target: input.target, occurredAt, allowedOn: input.allowed_on });
  return { code: event.material.referral_code, event };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  try { process.stdout.write(`${JSON.stringify(makeAReferralCode(JSON.parse(process.argv[2] ?? '{}')))}\n`); }
  catch (error) { process.stderr.write(`${error.message}\n`); process.exitCode = 1; }
}
