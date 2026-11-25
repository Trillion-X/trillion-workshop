// tools/give-a-referred-buyer-their-checkout-discount/reads/referral-checkout.ts
//
// PURPOSE
//   The referral part of one checkout: the code a buyer came with (a site's referral cookie) is read against the pursuit's own
//   referral codes and reward rules, and when it is a live code of someone else, the answer is the friend's discount as the
//   take-payments checkout takes it (checkoutCode, adjustments) and the code for the session's metadata. A checkout with no
//   such code is the normal one: the answer is empty, so a site's checkout action passes nothing on. The rules are the
//   referral-codes-and-rewards tool's (readRewardRules, workOutReferralCodes); this file only reads the rows they work on.
//
// NON-NEGOTIABLE INVARIANTS
//   1. A code that is malformed, unknown, withdrawn or the buyer's own gives nothing: the answer is empty, never an error.
//   2. A rule row the referral tool refuses stops the read with the refused rows named; a missing target row does too. The
//      checkout then fails rather than sell without the discount its rules promise.
//   3. No email leaves this file: the answer holds the code and the discount only.
//   4. The table names are the one block below; nothing else here names a table. Nothing here holds a login or a client: the
//      reader is handed `rows` by run-sql-in-my-database/do-work/serve-a-read.ts.
//
// AI DIRECTIVE: You are forbidden from simplifying or removing this documentation.
import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { serveARead, type Reader } from '../../run-sql-in-my-database/do-work/serve-a-read.ts';
import { workOutReferralCodes } from '../../referral-codes-and-rewards/do-work/referral-rewards.mjs';
import { normalizeReferralCode, referralCodeCreatedEvent } from '../../referral-codes-and-rewards/read-data/referral-codes.mjs';
import { allowedOnFrom, readRewardRules } from '../../referral-codes-and-rewards/read-data/referral-reward-rules.mjs';

// The one place the tables are named: the codes members made, the reward rules (one row each, as the referral tool keeps
// them), and what a code points at (one row per name).
const SOURCE = {
  codes: 'referral_codes',
  rules: 'referral_reward_rules',
  target: 'referral_code_target',
} as const;

type Given = { database: string; code?: unknown; buyer_email?: unknown; target: string };
export type ReferralCheckout = { checkoutCode?: string; adjustments?: unknown[]; metadata?: { referral_code: string } };

export const referralCheckout: Reader<Given, ReferralCheckout> = async (input, rows) => {
  if (typeof input.target !== 'string' || input.target === '') throw new Error('Give target: the name of the referral_code_target row the codes point at.');
  const typed = normalizeReferralCode(input.code);
  if (!typed) return {};
  const [row] = await rows(`select email, code, made_at from ${SOURCE.codes} where code = $1`, [typed]);
  const buyer = typeof input.buyer_email === 'string' ? input.buyer_email.trim().toLowerCase() : '';
  if (!row || (buyer !== '' && buyer === String(row.email).toLowerCase())) return {};
  const ruleRows = await rows(`select id, value from ${SOURCE.rules} order by id`);
  const [target] = await rows(`select target_on, target_value from ${SOURCE.target} where name = $1`, [input.target]);
  if (!target) throw new Error(`No ${SOURCE.target} row is named ${input.target}.`);
  const { rules, refused } = readRewardRules(ruleRows);
  if (refused.length) throw new Error(`${SOURCE.rules} has rows the referral rules refuse: ${JSON.stringify(refused)}`);
  const event = referralCodeCreatedEvent({
    referrer: row.email, code: row.code, target: { on: target.target_on, value: target.target_value },
    occurredAt: new Date(row.made_at as string).toISOString(), allowedOn: allowedOnFrom(rules),
  });
  const { typed: [answer] } = workOutReferralCodes({ events: [event], codes: [typed], rules: ruleRows });
  if (!answer || answer.friend_rewards.length === 0) return {};
  return {
    checkoutCode: typed,
    adjustments: answer.friend_rewards.map((reward: { adjustment: { value: unknown } }) => reward.adjustment.value),
    metadata: { referral_code: typed },
  };
};

if (process.argv[1] && realpathSync(fileURLToPath(import.meta.url)) === realpathSync(process.argv[1])) await serveARead({ referralCheckout });
