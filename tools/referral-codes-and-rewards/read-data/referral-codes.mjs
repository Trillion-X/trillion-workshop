// tools/referral-codes-and-rewards/read-data/referral-codes.mjs
//
// Referral codes that point at something. A code names the sales it earns a share of, as DATA: a target is
// { on, value }, the sale attribute the code matches and the value that attribute must have. A code for one product is
// { on: "product_id", value: <id> }; a code for everything one seller sells is { on: "seller_ref", value: <seller> }.
// Nothing here names a product, a seller or an attribute: a new kind of target is a new `on` value in the caller's list
// of allowed attributes.
//
// Codes are folded from events, like every other referral fact. `referral_code_created` makes a code (the first
// creation of a code wins, so nobody can take over a code another account made) and `referral_code_withdrawn` stops it
// (only the account that made it can). The fold is pure: the same events give the same codes in any order.
//
// An event is { kind?, subject, material: { event_type?, referral_code?, target?, occurred_at, ... } }. The event type is
// material.event_type, else kind.

const CODE = /^[A-Z0-9][A-Z0-9-]{3,31}$/;
// Crockford base32 without I, L, O, U, so a code read aloud or retyped is not mistaken for another.
const LETTERS = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

const isRecord = value => Boolean(value) && typeof value === 'object' && !Array.isArray(value);
const text = value => (typeof value === 'string' && value.trim() ? value.trim() : null);

export function normalizeReferralCode(value) {
  const code = text(value)?.toUpperCase() ?? null;
  return code && CODE.test(code) ? code : null;
}

/** A readable code from random bytes: PREFIX-XXXXXX. `randomBytes(count)` is handed in so the function stays pure. */
export function makeReferralCode({ prefix = 'REF', randomBytes }) {
  const head = normalizeReferralCode(prefix)?.slice(0, 12) ?? 'REF';
  const tail = Array.from(randomBytes(6), byte => LETTERS[byte % LETTERS.length]).join('');
  return `${head}-${tail}`;
}

/** The event that makes a code. `allowedOn` is the caller's list of sale attributes a code may point at. */
export function referralCodeCreatedEvent({ referrer, code, target, occurredAt, allowedOn }) {
  const normalized = normalizeReferralCode(code);
  if (!normalized) throw new Error('A referral code is 4 to 32 letters, digits or dashes.');
  if (!text(referrer)) throw new Error('A referral code needs the account that shares it.');
  if (!isRecord(target) || !text(target.on) || !text(target.value)) throw new Error('A referral code points at { on, value }: the sale attribute and the value it must have.');
  if (!Array.isArray(allowedOn) || allowedOn.length === 0) throw new Error('Say which sale attributes a code may point at (allowed_on).');
  if (!allowedOn.includes(target.on)) throw new Error(`A referral code can point at ${allowedOn.join(', ')}, not ${target.on}.`);
  return { kind: 'referral_code_created', subject: referrer, material: { event_type: 'referral_code_created', referral_code: normalized, target: { on: target.on, value: target.value }, occurred_at: occurredAt } };
}

export function referralCodeWithdrawnEvent({ referrer, code, occurredAt }) {
  const normalized = normalizeReferralCode(code);
  if (!normalized) throw new Error('A referral code is 4 to 32 letters, digits or dashes.');
  if (!text(referrer)) throw new Error('Withdrawing a code needs the account that made it.');
  return { kind: 'referral_code_withdrawn', subject: referrer, material: { event_type: 'referral_code_withdrawn', referral_code: normalized, occurred_at: occurredAt } };
}

const eventType = event => text(event.material?.event_type) ?? text(event.kind);
const at = event => text(event.material?.occurred_at) ?? text(event.material?.created_at) ?? '';

/** Fold events into Map<code, { code, referrer, target, created_at, withdrawn_at? }>. */
export function referralCodesFromEvents(events) {
  const codes = new Map();
  const ordered = [...events].filter(isRecord).sort((a, b) => at(a).localeCompare(at(b)));
  for (const event of ordered) {
    const code = normalizeReferralCode(event.material?.referral_code);
    const referrer = text(event.subject);
    if (!code || !referrer) continue;
    const held = codes.get(code);
    if (eventType(event) === 'referral_code_created') {
      const target = event.material?.target;
      if (held || !isRecord(target) || !text(target.on) || !text(target.value)) continue;
      codes.set(code, { code, referrer, target: { on: String(target.on), value: String(target.value) }, created_at: at(event) });
    } else if (eventType(event) === 'referral_code_withdrawn' && held && held.referrer === referrer && !held.withdrawn_at) {
      codes.set(code, { ...held, withdrawn_at: at(event) });
    }
  }
  return codes;
}

/** The live code a person typed, or null (unknown, malformed or withdrawn). */
export function referralCodeFor(codes, value) {
  const code = normalizeReferralCode(value);
  const found = code ? codes.get(code) : undefined;
  return found && !found.withdrawn_at ? found : null;
}

/** A sale earns a code its share when the attribute the code points at has the value it names. */
export function referralCodeApplies(code, sale) {
  return Boolean(code && !code.withdrawn_at && isRecord(sale) && sale[code.target.on] === code.target.value);
}

/**
 * One account's referral state: the newest code it made, and how many accepted referrals name it as the referrer.
 * A signup event carries material.referrer_account_id; the count is scoped to this account.
 */
export function referralStateFor(accountId, events) {
  const mine = events.filter(isRecord);
  const referralCode = [...mine]
    .sort((a, b) => at(b).localeCompare(at(a)))
    .map(event => {
      const type = eventType(event);
      return type === 'referral_code_created' || type === 'referral.code' ? text(event.material?.referral_code) : null;
    })
    .find(code => Boolean(code)) ?? null;
  const acceptedReferralCount = mine.filter(event => {
    const type = eventType(event);
    return (type === 'referral_signup' || type === 'referral.signup') && text(event.material?.referrer_account_id) === accountId;
  }).length;
  return { referral_code: referralCode, accepted_referral_count: acceptedReferralCount };
}

/**
 * What a code earns on one sale: whole cents, rounded down. `share` is the caller's rule:
 * { amount_field, basis_points } (1000 basis points is 10 percent). A sale with no whole-number amount earns nothing.
 */
export function shareEarned(sale, share) {
  const amount = isRecord(sale) ? sale[share.amount_field] : undefined;
  if (!Number.isInteger(amount) || amount < 0) return 0;
  return Math.floor((amount * share.basis_points) / 10000);
}
