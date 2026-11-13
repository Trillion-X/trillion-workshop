// tools/referral-codes-and-rewards/read-data/referral-reward-rules.mjs
//
// A business's referral rules are rows it keeps (read-data/referral-reward-list.json: the list and its columns, as DATA).
// A row says who earns (the referrer whose code a buyer typed, or the friend who typed it), what kind of reward it is
// and its terms, and which codes and sales it applies to. A reward is made out of what already exists, never paid here:
//   share     a whole-cent share of a sale (the caller pays it however it pays people);
//   discount  a `checkout-code-adjustment` row, which take-payments takes off a price (a credit is a discount with an
//             amount that applies once);
//   access    an `access-grant` row, which the access rules hold.
// Nothing here names a business, a product, a price or an amount: they are all in the rows.
import { makeHashCodeHexFromBytes } from '../../content-identity/read-data/identity.mjs';
import { shareEarned } from './referral-codes.mjs';

export const RULE_ROW_TYPE = 'record:referral-reward-rule';
export const ADJUSTMENT_TYPE = 'checkout-code-adjustment';

const isRecord = value => Boolean(value) && typeof value === 'object' && !Array.isArray(value);
const text = value => (typeof value === 'string' && value.trim() ? value.trim() : null);
const whole = value => Number.isSafeInteger(value) && value >= 0;
const present = value => value !== undefined && value !== null && value !== '';
const encoder = new TextEncoder();
const hexOf = words => makeHashCodeHexFromBytes(encoder.encode(words)).slice('1f:'.length);

const EARNERS = ['referrer', 'friend'];
const REWARDS = ['share', 'discount', 'access'];
const DURATIONS = ['once', 'repeating', 'forever'];

/** One rule row as a rule, or the reasons it is refused. A row whose state is `inactive` is { inactive: true }. */
function readRule(id, value) {
  if (!isRecord(value)) return { id, problems: ['the row is not an object'] };
  if (value.state === 'inactive') return { id, inactive: true };
  const problems = [];
  const label = text(value.label);
  if (value.state !== 'active') problems.push('state must be active or inactive');
  if (!label) problems.push('label must say what the rule gives');
  if (!EARNERS.includes(value.earner)) problems.push('earner must be referrer or friend');
  if (!REWARDS.includes(value.reward)) problems.push('reward must be share, discount or access');
  const pointsAt = text(value.code_points_at);
  if (!pointsAt) problems.push('code_points_at must name the sale attribute codes point at');
  const offerIds = present(value.offer_ids) ? value.offer_ids : [];
  if (!Array.isArray(offerIds) || !offerIds.every(item => text(item))) problems.push('offer_ids must be a list of offer ids');
  const weight = present(value.weight) ? value.weight : 1;
  if (!Number.isSafeInteger(weight) || weight < 1) problems.push('weight must be a whole number of 1 or more');

  const rule = {
    id, label, earner: value.earner, reward: value.reward, code_points_at: pointsAt,
    code_points_at_value: text(value.code_points_at_value),
    offer_ids: Array.isArray(offerIds) ? offerIds.map(item => text(item)).filter(Boolean) : [],
    arm_group: text(value.arm_group), weight,
  };
  if (value.reward === 'share') {
    if (value.earner !== 'referrer') problems.push('a share goes to the referrer');
    if (!text(value.amount_field)) problems.push('a share needs amount_field, the sale field holding the amount');
    if (!whole(value.basis_points) || value.basis_points > 10000) problems.push('a share needs basis_points, a whole number from 0 to 10000');
    Object.assign(rule, { amount_field: text(value.amount_field), basis_points: value.basis_points });
  } else if (value.reward === 'discount') {
    const percent = present(value.percent), cents = present(value.amount_cents);
    if (percent === cents) problems.push('a discount needs percent or amount_cents, one of them');
    if (percent && !(typeof value.percent === 'number' && value.percent > 0 && value.percent <= 100)) problems.push('percent must be more than 0 and at most 100');
    if (cents && !(Number.isSafeInteger(value.amount_cents) && value.amount_cents > 0)) problems.push('amount_cents must be a whole number of cents above 0');
    if (cents && !/^[a-z]{3}$/i.test(text(value.currency) ?? '')) problems.push('an amount off needs currency, a three-letter code');
    const duration = present(value.duration) ? value.duration : 'once';
    if (!DURATIONS.includes(duration)) problems.push('duration must be once, repeating or forever (blank is once)');
    if (duration === 'repeating' && !(Number.isSafeInteger(value.duration_in_months) && value.duration_in_months > 0)) problems.push('a repeating discount needs duration_in_months');
    if (present(value.max_redemptions) && !(Number.isSafeInteger(value.max_redemptions) && value.max_redemptions > 0)) problems.push('max_redemptions must be a whole number above 0');
    Object.assign(rule, {
      adjustment: percent ? { kind: 'percent', percent: value.percent } : { kind: 'amount_cents', amount_cents: value.amount_cents, currency: text(value.currency)?.toLowerCase() },
      duration, ...(duration === 'repeating' ? { duration_in_months: value.duration_in_months } : {}),
      ...(present(value.max_redemptions) ? { max_redemptions: value.max_redemptions } : {}),
    });
  } else if (value.reward === 'access') {
    if (!text(value.access_ref)) problems.push('access needs access_ref, the access given');
    if (present(value.access_days) && !(Number.isSafeInteger(value.access_days) && value.access_days > 0)) problems.push('access_days must be a whole number of days above 0');
    if (value.earner === 'friend' && !text(value.friend_field)) problems.push('access for the friend needs friend_field, the sale field naming them');
    Object.assign(rule, { access_ref: text(value.access_ref), access_days: present(value.access_days) ? value.access_days : null, friend_field: text(value.friend_field) });
  }
  return problems.length ? { id, problems } : { id, rule };
}

/** The rule rows (records of type record:referral-reward-rule) as { rules: active rules, refused: [{ id, problems }] }. */
export function readRewardRules(records) {
  const rules = [];
  const refused = [];
  for (const record of records) {
    const read = readRule(record.id, record.value);
    if (read.rule) rules.push(read.rule);
    else if (read.problems) refused.push({ id: read.id, problems: read.problems });
  }
  return { rules: rules.sort((a, b) => a.id.localeCompare(b.id)), refused };
}

/** Every rule row the door holds, read. */
export async function rewardRulesFrom(door) {
  const records = [];
  for await (const record of door.list({ type: RULE_ROW_TYPE })) records.push(record);
  return readRewardRules(records);
}

/** The sale attributes a code may point at: those the active rules name. */
export const allowedOnFrom = rules => [...new Set(rules.map(rule => rule.code_points_at))].sort();

/**
 * Rules in one test group are arms: each referrer lands on one arm, the same one every time, by weight. Rules in no
 * group always stand. `referrer` and the group name decide, so adding an arm changes where only the weights move people.
 */
function armsFor(rules, referrer) {
  const grouped = new Map();
  const standing = [];
  for (const rule of rules) {
    if (!rule.arm_group) { standing.push(rule); continue; }
    const key = `${rule.arm_group}\u0000${rule.earner}`;
    grouped.set(key, [...(grouped.get(key) ?? []), rule]);
  }
  for (const [key, arms] of grouped) {
    const total = arms.reduce((sum, arm) => sum + arm.weight, 0);
    let place = parseInt(hexOf(`${key}\u0000${referrer}`).slice(0, 12), 16) % total;
    standing.push(arms.find(arm => (place -= arm.weight) < 0));
  }
  return standing;
}

const matchesCode = (rule, code) => rule.code_points_at === code.target.on && (!rule.code_points_at_value || rule.code_points_at_value === code.target.value);
const matchesSale = (rule, sale) => rule.offer_ids.length === 0 || rule.offer_ids.includes(sale?.offer_id);

const adjustmentRow = (rule, id, code) => ({
  id,
  value: {
    kind: ADJUSTMENT_TYPE, id, label: rule.label, code, adjustment: rule.adjustment, duration: rule.duration,
    ...(rule.duration_in_months ? { duration_in_months: rule.duration_in_months } : {}),
    ...(rule.max_redemptions ? { max_redemptions: rule.max_redemptions } : {}),
    applies_to: { offer_ids: rule.offer_ids }, sort_order: 0, state: 'active',
  },
});

/**
 * What live code `code` gives its friend when a buyer types it: each friend discount that applies, as the standing
 * checkout-code-adjustment row the code is typed against (the referral code itself is the checkout code).
 */
export function rewardsForCode(code, rules) {
  const fitting = armsFor(rules.filter(rule => rule.earner === 'friend' && rule.reward === 'discount' && matchesCode(rule, code)), code.referrer);
  return fitting.map(rule => ({
    rule: rule.id, label: rule.label, earner: 'friend', reward: 'discount', subject: null,
    adjustment: adjustmentRow(rule, `${ADJUSTMENT_TYPE}:referral:${rule.id}:${code.code}`, code.code),
  }));
}

/**
 * What one sale earns code `code`, rule by rule. A share is whole cents. A discount for the referrer is one checkout
 * code of its own (named from the rule and the sale, so the same sale gives the same code). An access reward is the
 * grant for the referrer, or for the person the sale names. Needs `sale.id` for a discount or access reward, and
 * `sale.occurred_at_ms` for access that lasts a number of days.
 */
export function rewardsForSale(code, sale, rules) {
  const fitting = armsFor(rules.filter(rule => !(rule.earner === 'friend' && rule.reward === 'discount') && matchesCode(rule, code) && matchesSale(rule, sale)), code.referrer);
  const saleId = text(sale?.id);
  const rewards = [];
  for (const rule of fitting) {
    const base = { rule: rule.id, label: rule.label, earner: rule.earner, reward: rule.reward };
    if (rule.reward === 'share') {
      rewards.push({ ...base, subject: code.referrer, cents: shareEarned(sale, rule) });
    } else if (!saleId) {
      rewards.push({ ...base, subject: null, refused: 'the sale needs an id so the reward is given once' });
    } else if (rule.reward === 'discount') {
      const id = `${ADJUSTMENT_TYPE}:referral:${rule.id}:${saleId}`;
      rewards.push({ ...base, subject: code.referrer, adjustment: adjustmentRow(rule, id, `RWD-${hexOf(id).slice(0, 8).toUpperCase()}`) });
    } else {
      const subject = rule.earner === 'referrer' ? code.referrer : text(sale[rule.friend_field]);
      const grantRef = `grant:referral:${rule.id}:${saleId}`;
      if (!subject) rewards.push({ ...base, subject: null, refused: `the sale has no ${rule.friend_field} naming the friend` });
      else if (rule.access_days && !whole(sale.occurred_at_ms)) rewards.push({ ...base, subject, refused: 'access that lasts days needs the sale\'s occurred_at_ms' });
      else {
        const window = rule.access_days ? { valid_from_ms: sale.occurred_at_ms, expires_at_ms: sale.occurred_at_ms + rule.access_days * 86_400_000 } : {};
        rewards.push({ ...base, subject, grant: { subject, access_ref: rule.access_ref, grant_ref: grantRef, ...window, note: rule.label } });
      }
    }
  }
  return rewards;
}
