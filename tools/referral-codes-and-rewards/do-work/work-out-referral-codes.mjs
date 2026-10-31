// tools/referral-codes-and-rewards/do-work/work-out-referral-codes.mjs
//
// The command of tool:work-out-referral-codes. One JSON input (argv[2]):
//   { events: [referral events], codes?: [text a buyer typed], sales?: [sale records], share?: { amount_field, basis_points },
//     account?: "who to count accepted referrals for" }
// Prints one JSON line: { codes: [every code with its referrer, target and whether it is live],
//   checked?: [for each typed code and each sale: the live code, whether the sale earns it, what it earns],
//   state?: { referral_code, accepted_referral_count } }.
// It reads and adds up; it moves no money and sends nothing.
import { referralCodeApplies, referralCodeFor, referralCodesFromEvents, referralStateFor, shareEarned } from '../read-data/referral-codes.mjs';

const object = value => Boolean(value) && typeof value === 'object' && !Array.isArray(value);

export function workOutReferralCodes(input) {
  const problems = [];
  if (!object(input) || !Array.isArray(input.events)) throw new Error('events must be a list of referral events.');
  if (input.codes !== undefined && !(Array.isArray(input.codes) && input.codes.every(code => typeof code === 'string'))) problems.push('codes must be a list of the codes a buyer typed');
  if (input.sales !== undefined && !(Array.isArray(input.sales) && input.sales.every(object))) problems.push('sales must be a list of sale records');
  const share = input.share;
  if (share !== undefined && !(object(share) && typeof share.amount_field === 'string' && Number.isInteger(share.basis_points) && share.basis_points >= 0 && share.basis_points <= 10000)) {
    problems.push('share must be { amount_field, basis_points } with basis_points a whole number from 0 to 10000');
  }
  if (input.account !== undefined && typeof input.account !== 'string') problems.push('account must be text');
  if (problems.length) throw new Error(`${problems.join('; ')}.`);

  const codes = referralCodesFromEvents(input.events);
  const answer = { codes: [...codes.values()].map(code => ({ ...code, live: !code.withdrawn_at })) };
  if (input.codes) {
    const sales = input.sales ?? [{}];
    answer.checked = input.codes.flatMap(typed => sales.map((sale, index) => {
      const live = referralCodeFor(codes, typed);
      const earns = referralCodeApplies(live, sale);
      return { typed, sale_index: input.sales ? index : null, code: live, earns, ...(share && earns ? { earned: shareEarned(sale, share) } : {}) };
    }));
  }
  if (input.account) answer.state = referralStateFor(input.account, input.events);
  return answer;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  try { process.stdout.write(`${JSON.stringify(workOutReferralCodes(JSON.parse(process.argv[2] ?? '{}')))}\n`); }
  catch (error) { process.stderr.write(`${error.message}\n`); process.exitCode = 1; }
}
