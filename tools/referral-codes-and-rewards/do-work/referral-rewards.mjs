// tools/referral-codes-and-rewards/do-work/referral-rewards.mjs
//
// The functions the referral rows run through the records-door command:
//   node /opt/records-door/do-work/run-an-export.mjs /opt/referral-codes-and-rewards/do-work/referral-rewards.mjs <function> < input.json
// Each is `(input, { door }) => result`. The rules are the business's own rows (read-data/referral-reward-list.json), read
// from its records door; the referral events (a code made, withdrawn, a signup) are the caller's, as before.
//   makeAReferralCode      a code, and the event to save; codes may point only at what the rule rows name
//   workOutReferralCodes   the codes; for each typed code what it gives its friend, and for each typed code and sale
//                          what the sale earns, rule by rule; reads only
//   giveReferralRewards    the same work, then writes the rewards as the records the existing primitives read:
//                          `checkout-code-adjustment` rows (take-payments takes them off a price) and `access-grant`
//                          rows (tool:grant-paid-access-to-people's own writer). Nothing is sent and no money moves here.
import { isDeepStrictEqual } from 'node:util';
import { makeHashCodeHexFromBytes } from '../../content-identity/read-data/identity.mjs';
import { grantAccess } from '../../paid-access/read-data/access-grants.mjs';
import { writeBatches } from '../../records-door/read-data/write-batches.mjs';
import { makeReferralCode, normalizeReferralCode, referralCodeApplies, referralCodeCreatedEvent, referralCodeFor, referralCodesFromEvents, referralStateFor } from '../read-data/referral-codes.mjs';
import { ADJUSTMENT_TYPE, allowedOnFrom, rewardRulesFrom, rewardsForCode, rewardsForSale } from '../read-data/referral-reward-rules.mjs';
import { randomBytes } from 'node:crypto';

const WRITE_ROWS = 100;
const WRITE_BYTES = 60_000;
const object = value => Boolean(value) && typeof value === 'object' && !Array.isArray(value);

/** tool:make-a-referral-code: the code and its event; `allowed_on` is the attributes the business's active rules name. */
export async function makeAReferralCode(input, { door }, random = count => randomBytes(count)) {
  if (!object(input)) throw new Error('Give { referrer, target }.');
  const { rules } = await rewardRulesFrom(door);
  const allowedOn = allowedOnFrom(rules);
  if (allowedOn.length === 0) throw new Error('This business has no active referral reward rule yet, so a code would earn nothing: add a row to its referral reward rules list first.');
  const code = input.code === undefined ? makeReferralCode({ prefix: input.prefix, randomBytes: random }) : normalizeReferralCode(input.code);
  const event = referralCodeCreatedEvent({ referrer: input.referrer, code, target: input.target, occurredAt: input.occurred_at ?? new Date().toISOString(), allowedOn });
  return { code: event.material.referral_code, event };
}

function checkInput(input) {
  const problems = [];
  if (!object(input) || !Array.isArray(input.events)) throw new Error('events must be a list of referral events.');
  if (input.codes !== undefined && !(Array.isArray(input.codes) && input.codes.every(code => typeof code === 'string'))) problems.push('codes must be a list of the codes a buyer typed');
  if (input.sales !== undefined && !(Array.isArray(input.sales) && input.sales.every(object))) problems.push('sales must be a list of sale records');
  if (input.account !== undefined && typeof input.account !== 'string') problems.push('account must be text');
  if (problems.length) throw new Error(`${problems.join('; ')}.`);
}

/** Every code and, per typed code, what it gives a friend and, per sale, what the sale earns. Reads only. */
async function plan(input, door) {
  checkInput(input);
  const { rules, refused } = await rewardRulesFrom(door);
  const codes = referralCodesFromEvents(input.events);
  const answer = { codes: [...codes.values()].map(code => ({ ...code, live: !code.withdrawn_at })), rules_used: rules.map(rule => rule.id), rules_refused: refused };
  if (input.codes) {
    const typed = input.codes.map(word => ({ typed: word, code: referralCodeFor(codes, word) }));
    answer.typed = typed.map(({ typed: word, code }) => ({ typed: word, code, friend_rewards: code ? rewardsForCode(code, rules) : [] }));
    if (input.sales) {
      answer.checked = typed.flatMap(({ typed: word, code }) => input.sales.map((sale, index) => {
        const earns = referralCodeApplies(code, sale);
        return { typed: word, sale_index: index, code, earns, rewards: earns ? rewardsForSale(code, sale, rules) : [] };
      }));
    }
  }
  if (input.account) answer.state = referralStateFor(input.account, input.events);
  return answer;
}

/** tool:work-out-referral-codes: what the codes and sales earn under the business's rules. Writes nothing. */
export async function workOutReferralCodes(input, { door }) {
  return plan(input, door);
}

async function writeAdjustments(rewards, door) {
  const wanted = new Map();
  for (const item of rewards) if (item.adjustment) wanted.set(item.adjustment.id, item.adjustment);
  const fresh = [];
  const refused = [];
  let already = 0;
  for (const [id, row] of wanted) {
    const held = await door.read(ADJUSTMENT_TYPE, id);
    if (!held) fresh.push({ id, type: ADJUSTMENT_TYPE, value: row.value, expected: null });
    else if (isDeepStrictEqual(held, row.value)) already += 1;
    else refused.push({ id, reason: `${id} is already kept with different terms; the rule changed after it was given, and the given one stands` });
  }
  for (const batch of writeBatches(fresh, { rows: WRITE_ROWS, bytes: WRITE_BYTES })) {
    await door.write(batch, { key: `give-referral-rewards:${makeHashCodeHexFromBytes(new TextEncoder().encode(JSON.stringify(batch)))}` });
  }
  return { written: fresh.length, already, refused };
}

/** tool:give-referral-rewards: the same work as workOutReferralCodes, then the rewards written, once each. */
export async function giveReferralRewards(input, { door }) {
  const answer = await plan(input, door);
  const rewards = [...(answer.typed ?? []).flatMap(item => item.friend_rewards), ...(answer.checked ?? []).flatMap(item => item.rewards)]
    .filter(item => item.reward !== 'share' && !item.refused);
  const adjustments = await writeAdjustments(rewards, door);
  const grants = rewards.filter(item => item.grant).map(item => item.grant);
  const access = grants.length ? await grantAccess({ grants }, { door }) : { written: 0, already: 0, refused: [] };
  return { ...answer, given: { adjustments, access } };
}
