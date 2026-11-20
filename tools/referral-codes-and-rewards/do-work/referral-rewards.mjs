// tools/referral-codes-and-rewards/do-work/referral-rewards.mjs
//
// The functions the referral rows run through the export command:
//   node /opt/workflows/do-work/run-a-function.mjs /opt/referral-codes-and-rewards/do-work/referral-rewards.mjs <function> < input.json
// Each is `(input) => result`. The business's rule rows (read-data/referral-reward-list.json) come in the request as
// `rules` (the person's AI reads them from their store); the referral events (a code made, withdrawn, a signup) are the
// caller's too. Nothing is read from or kept in any store: every answer holds its whole result.
//   makeAReferralCode      a code, and the event to save; codes may point only at what the rule rows name
//   workOutReferralCodes   the codes; for each typed code what it gives its friend, and for each typed code and sale
//                          what the sale earns, rule by rule
//   giveReferralRewards    the same work, then the rewards as the rows the existing primitives read, for the caller to
//                          keep: `checkout-code-adjustment` rows (take-payments takes them off a price) and
//                          `access-grant` rows (the rows tool:grant-paid-access-to-people writes); and the customer
//                          `credits` (each { id, subject, amount_cents, currency, description }) for the caller to give
//                          through take-payments' giveACustomerCredit, keyed by id. Nothing is sent and no money moves here.
import { isDeepStrictEqual } from 'node:util';
import { grantRow } from '../../paid-access/read-data/access-grants.mjs';
import { makeReferralCode, normalizeReferralCode, referralCodeApplies, referralCodeCreatedEvent, referralCodeFor, referralCodesFromEvents, referralStateFor } from '../read-data/referral-codes.mjs';
import { ADJUSTMENT_TYPE, allowedOnFrom, readRewardRules, rewardsForCode, rewardsForSale } from '../read-data/referral-reward-rules.mjs';
import { randomBytes } from 'node:crypto';

const object = value => Boolean(value) && typeof value === 'object' && !Array.isArray(value);

function rulesFrom(input) {
  if (!Array.isArray(input.rules) || input.rules.some(row => !object(row) || typeof row.id !== 'string')) throw new Error('rules must be the referral reward rule rows, each { id, value }.');
  return readRewardRules(input.rules);
}

/** tool:make-a-referral-code: the code and its event; `allowed_on` is the attributes the business's active rules name. */
export function makeAReferralCode(input) {
  if (!object(input)) throw new Error('Give { referrer, target, rules }.');
  const { rules } = rulesFrom(input);
  const allowedOn = allowedOnFrom(rules);
  if (allowedOn.length === 0) throw new Error('This business has no active referral reward rule yet, so a code would earn nothing: add a row to its referral reward rules list first.');
  const code = input.code === undefined ? makeReferralCode({ prefix: input.prefix, randomBytes }) : normalizeReferralCode(input.code);
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

/** Every code and, per typed code, what it gives a friend and, per sale, what the sale earns. */
function plan(input) {
  checkInput(input);
  const { rules, refused } = rulesFrom(input);
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

/** tool:work-out-referral-codes: what the codes and sales earn under the business's rules. */
export function workOutReferralCodes(input) {
  return plan(input);
}

/** The adjustment rows the rewards give, once each by id; one id with two different terms is refused with why. */
function adjustmentRows(rewards) {
  const rows = new Map();
  const refused = [];
  for (const item of rewards) {
    if (!item.adjustment) continue;
    const held = rows.get(item.adjustment.id);
    if (!held) rows.set(item.adjustment.id, item.adjustment.value);
    else if (!isDeepStrictEqual(held, item.adjustment.value)) refused.push({ id: item.adjustment.id, reason: `${item.adjustment.id} would be given with two different terms in this request` });
  }
  return { rows: [...rows].map(([id, value]) => ({ id, type: ADJUSTMENT_TYPE, value })), refused };
}

/** The access-grant rows the rewards give, once each by id, the way tool:grant-paid-access-to-people shapes them. */
function accessRows(grants) {
  const rows = new Map();
  const refused = [];
  grants.forEach((item, index) => {
    const row = grantRow(item);
    if (row.reason) { refused.push({ index, reason: row.reason }); return; }
    const held = rows.get(row.id);
    if (!held) rows.set(row.id, row.value);
    else if (!isDeepStrictEqual(held, row.value)) refused.push({ index, reason: `${row.id} would be given with two different terms in this request` });
  });
  return { rows: [...rows].map(([id, value]) => ({ id, type: 'access-grant', value })), refused };
}

/** The customer credits the rewards give, once each by id (the id is the idempotency key the credit is given under); one id with two different terms is refused with why. */
function creditRows(rewards) {
  const credits = new Map();
  const refused = [];
  for (const item of rewards) {
    if (!item.credit) continue;
    const held = credits.get(item.credit.id);
    if (!held) credits.set(item.credit.id, item.credit);
    else if (!isDeepStrictEqual(held, item.credit)) refused.push({ id: item.credit.id, reason: `${item.credit.id} would be given with two different terms in this request` });
  }
  return { credits: [...credits.values()], refused };
}

/**
 * tool:give-referral-rewards: the same work as workOutReferralCodes, then what gives the rewards, in the answer: the rows
 * (checkout-code adjustments and access grants, once each by id) and the customer credits, each given through take-payments'
 * giveACustomerCredit with its id as the idempotency key.
 */
export function giveReferralRewards(input) {
  const answer = plan(input);
  const rewards = [...(answer.typed ?? []).flatMap(item => item.friend_rewards), ...(answer.checked ?? []).flatMap(item => item.rewards)]
    .filter(item => item.reward !== 'share' && !item.refused);
  const adjustments = adjustmentRows(rewards);
  const access = accessRows(rewards.filter(item => item.grant).map(item => item.grant));
  const credits = creditRows(rewards);
  return {
    ...answer,
    rows: { adjustments: adjustments.rows, access_grants: access.rows },
    rows_refused: { adjustments: adjustments.refused, access_grants: access.refused },
    credits: credits.credits,
    credits_refused: credits.refused,
  };
}
