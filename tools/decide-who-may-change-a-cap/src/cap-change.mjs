// src/cap-change.mjs
//
// Purpose
//   The one place that decides who may change a person's cap (a use budget or a spend budget), its ceiling, the billing
//   month and the paid ceiling, and how far (plan decision D-I5). Every cap has a finite ceiling (src/cap-change.json).
//   Each guarded value declares in DATA which moves are open to every credential (`safe_moves`); every other move needs
//   a confirmation from one of the person's KNOWN passkeys (src/passkey-authority.mjs) for exactly that change. The
//   budget owners (src/native-resource-spend.mjs, src/standalone-resource-behavior.mjs), the payment owner
//   (src/payment.mjs) and the account routes call these before they write.
//
// Invariants
//   1. A cap is never unlimited: its amount is at most its ceiling, and taking a cap away leaves a cap at its ceiling
//      (or the starting row under it, which the quota never applies above the ceiling).
//   2. The ceiling of a cap is the larger of the default for its period (and measure) and the ceiling the person declared
//      on the row, and never above its maximum (`maxima`, deploy DATA). A replacement that does not name a ceiling keeps
//      the one it replaces, and a raise waiting on it. What a plan or contract gives
//      (its daily cap) never lifts a ceiling: a payment pays for work, it never authorizes more (the quota applies a
//      plan's cap only up to its ceiling, src/resource-budget-owner.mjs).
//   3. Any credential moves a cap's amount anywhere from 0 up to its ceiling, so restoring a cap an AI lowered is always
//      open. A ceiling, the billing month and the paid ceiling move in neither direction without a known passkey's
//      confirmation, so no credential can lower one to force the person through the passkey step to restore it.
//   4. A passkey confirmation is held by the pool for one sign-in (the session that made it) and ONE exact change (its
//      `changeKey`), used once, and past its time after `confirmation_seconds`; a confirmation for one change never
//      authorizes another. The Worker makes one only after verifying a user-verified assertion from a known passkey
//      (src/worker.mjs passkeyConfirm): the UV flag is self-reported, so the wall is custody of enrollment, not the flag.
//   5. A refusal is immediate (status 403) and names the missing step and the exact change to confirm (`step_needed`,
//      `change`); nothing waits for anyone.
//   6. Money is itself capped: within `paid.window_days` what an account paid and committed comes to at most its paid
//      ceiling (`paid.ceiling_dollars`, or the one the person set with a known passkey's confirmation). What a payment
//      commits is read from the request (commitmentCents: unit price times quantity, every recurring charge inside the
//      window after its trial, at most its installments), for every payee; paidCeilingRefusal decides it wherever money
//      can start (src/payment.mjs paidGate).
//   7. One confirmed touch moves one ceiling at most one step (`most_steps`), never above its maximum, and a raise takes
//      effect only once the notice row's hours have passed (src/passkey-authority.json); a known passkey's confirmation
//      setting the ceiling again before then cancels it. So a deceived touch yields at most one bounded, told step.
//   8. A deceived lowering costs the person no wait (the paid ceiling): a confirmed lowering keeps what it lowered from
//      (`restore`: the highest ceiling in force within the paid window, any waiting raise it ended, and the known-from
//      time of the most senior passkey that lowered it). Within the window a rise back up to that ceiling takes effect at
//      once, and up to the ended raise brings that raise back with its own notice time, when confirmed by a known passkey
//      at least as senior (known from no later) as every one that lowered it. A passkey known later restores nothing.
import data from '../../shared-code/src/cap-change.json' with { type: 'json' };
import authority from './passkey-authority.json' with { type: 'json' };

const number = value => (value === null || value === undefined ? null : Number(value));
const same = (a, b) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
const said = (template, values) => template.replace(/\{(\w+)\}/g, (_, key) => String(values[key]));
const refusal = (text, change = null) => Object.assign(new Error(text), { status: 403, ...(change ? { step_needed: authority.step_needed, change } : {}) });
// Whether the DATA leaves this move of `value` open to every credential (src/cap-change.json safe_moves).
const openMove = (value, { inside = false, tighter = false } = {}) => ({ 'within-ceiling': inside, tighter, none: false })[data.safe_moves[value]];
const RAISE = data.raise_field;
const RAISE_WAIT_MS = authority.provenance.notice.wait_hours * 3_600_000;
const DAY_MS = 86_400_000;
const at = (tree, path) => path.reduce((node, key) => node?.[key], tree);
const when = ms => new Date(ms).toUTCString();

/** One change as the text a confirmation is bound to: the same change always gives the same key, whatever its key order. */
export function changeKey(change) {
  const sorted = value => (Array.isArray(value) ? value.map(sorted) : value && typeof value === 'object'
    ? Object.fromEntries(Object.keys(value).sort().filter(key => value[key] !== undefined).map(key => [key, sorted(value[key])])) : value);
  return JSON.stringify(sorted(change ?? null));
}

// Where one cap's ceiling sits in the DATA (`maxima`, `most_steps`, and the family's default `ceilings`).
const ceilingPath = (family, row) => (family === 'use' ? ['use', row.measure, row.period ?? 'day'] : ['spend', row.period === 'month' ? 'month' : 'day']);
const unitOf = (family, row) => (family === 'use' ? row.measure : 'dollars');

/** The default ceiling for this row's period (and measure, for a use budget). */
const defaultCeiling = (family, row) => at(data.families[family].ceilings, ceilingPath(family, row).slice(1)) ?? 0;

/** A kept ceiling value as it stands at `now`: a raise whose notice has passed is the value; one still waiting is not. */
const inForce = (value, raise, now) => (raise && Date.parse(raise.from) <= now ? number(raise.to) : number(value));
const waiting = (raise, now) => (raise && Date.parse(raise.from) > now ? raise : null);

/** The most this cap may be set to now: the larger of the default for its period (and measure) and the declared ceiling
 *  in force, never above its maximum. */
export function ceilingOf(family, row, now = Date.now()) {
  return Math.min(at(data.maxima, ceilingPath(family, row)), Math.max(defaultCeiling(family, row), inForce(row[data.families[family].ceiling_field], row[RAISE], now) ?? 0));
}

/** One ceiling asked to move to `asked` (the one rule caps and the paid ceiling share). `kept` is { value, raise } as
 *  stored, `effective(value)` the ceiling a declared value gives, `cancel` a request to end a waiting raise. → the
 *  { value, raise } to keep and `moves` (whether the ceiling in force or its waiting raise changes); throws when the ask
 *  is past the maximum or more than one step above the ceiling in force. */
function ceilingMove({ path, unit, effective, kept, asked, cancel = false, now }) {
  const value = inForce(kept.value, kept.raise, now), raise = waiting(kept.raise, now), current = effective(value);
  if (cancel) return { value, raise: null, moves: Boolean(raise) };
  // Not named, or named as it reads now (the value kept, the value in force, or the raise waiting): nothing moves.
  if (asked === undefined || asked === value || asked === number(kept.value) || (raise && asked === number(raise.to))) return { value, raise, moves: false };
  const maximum = at(data.maxima, path), step = at(data.most_steps, path), wanted = effective(asked);
  if (asked > maximum) throw refusal(said(data.raise_words.above_maximum, { maximum, unit }));
  if (wanted <= current) return { value: asked, raise: null, moves: wanted !== current || Boolean(raise) };
  if (wanted - current > step) throw refusal(said(data.raise_words.above_step, { step, unit, ceiling: current }));
  return { value, raise: { to: asked, from: new Date(now + RAISE_WAIT_MS).toISOString() }, moves: true };
}

/** The row to keep for `next` replacing `previous`: a ceiling the replacement does not name stays (with any raise waiting
 *  on it); a lower one is kept at once; a higher one is kept as a raise that takes effect after the notice (invariant 7),
 *  and `ceiling_raise: null` on the replacement cancels one waiting. Throws past the maximum or the step. */
export function keepCeiling(family, previous, next, now = Date.now()) {
  const field = data.families[family].ceiling_field;
  const maximum = at(data.maxima, ceilingPath(family, next)), floor = defaultCeiling(family, next);
  const moved = ceilingMove({ path: ceilingPath(family, next), unit: unitOf(family, next), effective: value => Math.min(maximum, Math.max(floor, value ?? 0)),
    kept: { value: previous?.[field], raise: previous?.[RAISE] }, asked: next[field] === undefined ? undefined : number(next[field]), cancel: next[RAISE] === null, now });
  const { [field]: _asked, [RAISE]: _raise, ...rest } = next;
  return { ...rest, ...(moved.value === null || moved.value === undefined ? {} : { [field]: moved.value }), ...(moved.raise ? { [RAISE]: moved.raise } : {}) };
}

/** What a budget row given by a caller keeps of a raise: only `null` there, the request to cancel a raise waiting on
 *  its ceiling (keepCeiling); a raise itself is made only by keepCeiling, never taken from a caller. */
export const raiseAsked = row => (row?.[RAISE] === null ? { [RAISE]: null } : {});

/** Whether the replacement loosens what the cap covers or when it stops (a stop only tightens when it was off). */
function loosensShape(family, previous, next) {
  const spec = data.families[family];
  if (spec.shape.some(field => !same(previous[field], next[field]))) return true;
  return spec.stop === 'flag' ? previous.stop === true && next.stop !== true : previous.stop != null && !same(previous.stop, next.stop);
}

/** Uses up the passkey confirmation `id` for this sign-in and this exact `change`: the passkey that made it
 *  ({ passkey, known_from (ms) }) when the pool held it for exactly both, else null. A confirmation named for another
 *  change is used up too, so it is never tried twice. */
export async function confirmationBy(pool, id, signIn, change) {
  if (typeof id !== 'string' || !id || typeof signIn !== 'string') return null;
  const held = await pool.takePasskeyChallenge(id);
  return held?.mode === 'cap-confirm' && held.sign_in === signIn && held.change === changeKey(change) ? { passkey: held.by?.passkey ?? null, known_from: held.by?.known_from ?? null } : null;
}

/** Whether the confirmation `id` was one for this sign-in and this exact `change` (confirmationBy), used up either way. */
export const takeCapConfirmation = async (pool, id, signIn, change) => (await confirmationBy(pool, id, signIn, change)) !== null;

/** Uses up the passkey confirmation `id` made in account `userId` for this exact `change`, whoever carries it: a change
 *  asked from outside that account (another account moving it in, src/worker.mjs move-in) that its own known passkey
 *  approved. True only when the pool held it for exactly both. */
export async function takeAccountConfirmation(pool, id, userId, change) {
  if (typeof id !== 'string' || !id || typeof userId !== 'string') return false;
  const held = await pool.takePasskeyChallenge(id);
  return held?.mode === 'cap-confirm' && held.user_id === userId && held.change === changeKey(change);
}

/** Keeps a passkey confirmation for `signIn` of account `userId` and one exact `change`, made by `by` (the passkey
 *  { passkey, known_from (ms) }), and returns its id (src/worker.mjs passkeyConfirm). */
export async function holdCapConfirmation(pool, signIn, change, userId = null, by = null) {
  const id = `cap-confirm:${crypto.randomUUID()}`;
  await pool.holdPasskeyChallenge(id, { mode: 'cap-confirm', sign_in: signIn, change: changeKey(change), ...(userId ? { user_id: userId } : {}), ...(by ? { by } : {}) }, data.confirmation_seconds);
  return id;
}

/** Throws unless this change to a cap is allowed. `previous` is the cap in force now (the person's row, else the
 *  starting row, else null), `next` the row keepCeiling made for the change, `confirm(change)` a function that uses up
 *  the passkey confirmation the call carried (true when it was one for exactly `change`). A confirmation is bound to
 *  the row asked for: a raise by the ceiling it asks for, never by when it takes effect. */
export async function allowCapChange({ family, previous, next, confirm, now = Date.now() }) {
  const spec = data.families[family], words = spec.words, field = spec.ceiling_field;
  const ceiling = ceilingOf(family, next, now), raise = waiting(next[RAISE], now);
  if (!openMove('amount', { inside: number(next[spec.amount]) <= ceiling })) {
    throw refusal(raise ? said(data.raise_words.amount_above_in_force, { ceiling, unit: unitOf(family, next) }) : said(words.above_ceiling, { ceiling, period: next.period ?? 'day', measure: next.measure }));
  }
  const before = { ...next, [field]: previous?.[field], [RAISE]: previous?.[RAISE] };
  const movesCeiling = ceiling !== ceilingOf(family, before, now) || !same(raise, waiting(previous?.[RAISE], now));
  const shapeOpen = !previous || openMove('shape', { tighter: !loosensShape(family, previous, next) });
  if ((movesCeiling && !openMove('ceiling')) || !shapeOpen) {
    const change = { action: 'cap', family, row: { ...next, [RAISE]: raise ? { to: raise.to } : undefined } };
    if (!(await confirm(change))) throw refusal(words.needs_passkey, change);
  }
}

/** The change taking a cap away makes: `{ drop: true }` when a starting row lies under it (that row applies again), else
 *  the same cap at its ceiling. A cap is never left unlimited. */
export function removalOf(family, own, starting) {
  return starting ? { drop: true } : { row: { ...own, [data.families[family].amount]: ceilingOf(family, own) } };
}

/** Throws unless this call may move the billing month start (it can reset a month's allowance). */
export async function allowBillingMonthMove({ current, next, confirm }) {
  const change = { action: 'billing-month', cycle_day: number(next) };
  if (number(next) !== number(current) && !openMove('billing_month') && !(await confirm(change))) throw refusal(data.families.spend.words.needs_passkey, change);
}

// The paid ceiling as APP_KV `paid-ceiling:<user id>` keeps it: { dollars, raise, restore } (a bare number is a ceiling kept
// before raises waited, with nothing waiting and nothing to restore).
function keptPaid(text) {
  const value = typeof text === 'string' ? JSON.parse(text) : text ?? null;
  return value && typeof value === 'object' ? { value: number(value.dollars), raise: value.raise ?? null, restore: value.restore ?? null } : { value: number(value), raise: null, restore: null };
}
const WINDOW_MS = data.paid.window_days * DAY_MS;
// What a lowering confirmed now by `by` keeps to restore (invariant 8): the highest ceiling in force within the window, the
// raise it ended (or one an earlier lowering ended), and the most senior lowering passkey's known-from time (null when a
// lowering's passkey is not known: then nothing restores at once).
const restoreAfter = ({ restore, inForceNow, ended, by, now }) => {
  const mine = Number.isFinite(by?.known_from) ? by.known_from : null, earlier = restore ? restore.senior_from : undefined;
  return { to: Math.max(inForceNow, restore?.to ?? 0), raise: ended ?? restore?.raise ?? null, until: new Date(now + WINDOW_MS).toISOString(),
    senior_from: mine === null || earlier === null ? null : earlier === undefined ? mine : Math.min(mine, earlier) };
};
// The { value, raise } a rise to `asked` restores at once (invariant 8), or null when it restores nothing.
function restored(restore, asked, by, now) {
  if (!restore || !(Date.parse(restore.until) > now) || !Number.isFinite(restore.senior_from) || !Number.isFinite(by?.known_from) || by.known_from > restore.senior_from) return null;
  if (asked <= restore.to) return { value: asked, raise: null };
  return restore.raise && asked <= number(restore.raise.to) ? { value: restore.to, raise: { to: asked, from: restore.raise.from } } : null;
}
const paidEffective = value => Math.min(data.maxima.paid, value ?? data.paid.ceiling_dollars);

/** The paid ceiling in force, in dollars: the person's own (kept only through a known passkey's confirmation, a raise
 *  only once its notice has passed), else the default; never above the maximum. */
export const paidCeilingOf = (kept, now = Date.now()) => { const { value, raise } = keptPaid(kept); return paidEffective(inForce(value, raise, now)); };

/** Throws unless this call may set the paid ceiling to `next` dollars: any change, either way, needs a known passkey's
 *  confirmation for exactly it (invariant 3), a raise moves it at most one step and waits out the notice (invariant 7)
 *  unless it restores what a lowering took (invariant 8), and asking for the ceiling in force while a raise waits cancels
 *  that raise. `confirm(change)` uses up the call's confirmation: the passkey that made it (confirmationBy) or null.
 *  → { kept (the text to keep), said }. */
export async function allowPaidCeilingChange({ current, next, confirm, now = Date.now() }) {
  const dollars = Number(next);
  if (!(Number.isFinite(dollars) && dollars >= 0)) throw Object.assign(new Error(data.paid.words.not_a_ceiling), { status: 400 });
  const kept = keptPaid(current), inForceNow = inForce(kept.value, kept.raise, now), raiseNow = waiting(kept.raise, now);
  const restore = kept.restore && Date.parse(kept.restore.until) > now ? kept.restore : null;
  const change = { action: 'paid-ceiling', dollars };
  let by;
  const confirmed = async () => (by === undefined ? (by = (await confirm(change)) || null) : by);
  const needs = async () => { if (!openMove('paid_ceiling') && !(await confirmed())) throw refusal(data.paid.words.needs_passkey, change); };
  // A rise over the ceiling in force that a lowering may have taken: decided by who confirms it (invariant 8).
  const back = restore && paidEffective(dollars) > paidEffective(inForceNow) && !(raiseNow && dollars === number(raiseNow.to)) ? (await needs(), restored(restore, dollars, by, now)) : null;
  const moved = back ? { ...back, moves: true } : ceilingMove({ path: ['paid'], unit: 'dollars', effective: paidEffective, kept, asked: dollars,
    cancel: raiseNow !== null && paidEffective(dollars) === paidEffective(inForceNow), now });
  if (moved.moves) await needs();
  // A lowering (of the ceiling in force or of a waiting raise) keeps what it took, so its passkey's peers restore it at once.
  const lowered = moved.moves && !back && (paidEffective(moved.value) < paidEffective(inForceNow) || (raiseNow && !moved.raise));
  const keepRestore = lowered ? restoreAfter({ restore, inForceNow: paidEffective(inForceNow), ended: raiseNow, by, now }) : back ? null : restore;
  const ceiling = paidEffective(moved.value);
  return { kept: JSON.stringify({ dollars: moved.value, ...(moved.raise ? { raise: moved.raise } : {}), ...(keepRestore ? { restore: keepRestore } : {}) }),
    said: moved.raise ? said(data.paid.words.raise_saved, { to: moved.raise.to, from: when(Date.parse(moved.raise.from)), ceiling, days: data.paid.window_days })
      : said(data.paid.words.saved, { ceiling, days: data.paid.window_days }) };
}

/** What one payment request commits within the paid window, in cents, read from the request itself and never from the
 *  name of its operation: `lines` [{ unit_cents, quantity, every: { interval, count } | null }] (a quantity the buyer may
 *  still change counts at its most), `trial_days` before the first recurring charge, and `installments` (the most
 *  charges of a recurring line, or null for no end); `charges_paid` of each recurring line's charges are already in what
 *  was paid today. A recurring line counts every charge inside the window after the trial, a month as
 *  `interval_days.month` days, so no window holds more charges than are counted. */
export function commitmentCents({ lines = [], trial_days: trial = 0, installments = null, charges_paid: paid = 0 } = {}) {
  const window = data.paid.window_days;
  return lines.reduce((sum, line) => {
    const each = line.unit_cents * line.quantity;
    if (!(Number.isSafeInteger(each) && each >= 0)) throw new Error('A payment line needs a whole unit price and a whole quantity.');
    if (!line.every) return sum + each;
    const days = data.paid.interval_days[line.every.interval] * (line.every.count ?? 1);
    if (!(days > 0)) throw new Error(`${line.every.interval} is not a billing interval.`);
    const charges = Math.max(0, Math.ceil((window - (trial ?? 0)) / days) - paid);
    return sum + each * (installments === null || installments === undefined ? charges : Math.min(charges, installments));
  }, 0);
}

/** The reference a payment effect is counted under: a seller's or share link's offer by its negotiated offer, any other
 *  checkout by its session, so a notice and the admission that reserved it are one purchase. */
export const paymentRef = material => material?.negotiated_offer_id ?? material?.provider_object_ref ?? null;

/** The cents an account paid and committed within the paid window ending at `at`: every completed checkout (any payee)
 *  and every reserved commitment (`reserved` rows { ref, cents, at, standing, episode }), each reference counted once at
 *  the larger of the two; a purchase refunded since is not counted, nor a standing carve whose purchase `active` says
 *  ended. `except` names the reference being decided, left out. */
export function paidWithin({ effects = [], reserved = [], at: end = Date.now(), except = null, active = () => true } = {}) {
  const since = end - data.paid.window_days * DAY_MS;
  const refunded = new Set(effects.filter(effect => effect?.kind === 'payment.refunded').map(effect => effect.material?.payment_intent_ref).filter(Boolean));
  const counted = new Map();
  const count = (ref, cents) => { if (ref && ref !== except) counted.set(ref, Math.max(counted.get(ref) ?? 0, cents)); };
  for (const effect of effects) {
    const material = effect?.material ?? {};
    if (effect?.kind !== 'payment.confirmed' || !material.checkout_attempt_id || !(Date.parse(material.occurred_at) >= since)) continue;
    if (material.payment_intent_ref && refunded.has(material.payment_intent_ref)) continue;
    count(paymentRef(material) ?? effect.effect_id, Number.isSafeInteger(material.amount_due_today_cents) && material.amount_due_today_cents > 0 ? material.amount_due_today_cents : 0);
  }
  for (const row of reserved) if (row.standing ? active(row.episode) : Date.parse(row.at) >= since) count(row.ref, row.cents);
  return [...counted.values()].reduce((sum, cents) => sum + cents, 0);
}

/** The reserved rows with `row` kept under its reference (replacing an earlier one) and the rows past the window gone. */
export function withReserved(rows, row, now = Date.now()) {
  const since = now - data.paid.window_days * DAY_MS;
  return [...(rows ?? []).filter(kept => kept.ref !== row.ref && (kept.standing || Date.parse(kept.at) >= since)), row];
}

/** Null when a new commitment of `amountCents` fits under the paid ceiling after `paidCents` already paid and committed
 *  in the window, else the refusal { error, status: 403, paid_cents, amount_cents, ceiling_dollars }. */
export function paidCeilingRefusal({ paidCents, amountCents, ceilingDollars, words = data.paid.words.above_ceiling }) {
  if (!(amountCents > 0) || paidCents + amountCents <= ceilingDollars * 100) return null;
  return { error: said(words, { ceiling: ceilingDollars, days: data.paid.window_days, paid: dollarsOf(paidCents), amount: dollarsOf(amountCents) }),
    status: 403, paid_cents: paidCents, amount_cents: amountCents, ceiling_dollars: ceilingDollars };
}
const dollarsOf = cents => (cents / 100).toFixed(cents % 100 ? 2 : 0);

/** The words a payment is refused with when what it commits (`amountCents`) is more than the paid ceiling leaves (`roomCents`). */
export const roomRefusalWords = ({ amountCents, roomCents }) => said(data.paid.words.above_room, { amount: dollarsOf(amountCents), room: dollarsOf(roomCents), days: data.paid.window_days });

/** The words a person is told when a purchase past the paid ceiling was given back. */
export const paidRefundWords = ({ amountCents, ceilingDollars }) => ({
  title: data.paid.words.refunded_title,
  body: said(data.paid.words.refunded, { amount: dollarsOf(amountCents), ceiling: ceilingDollars, days: data.paid.window_days }),
});

/** The words a spot is refused with when its carve does not fit the payer's paid ceiling. */
export const SPOT_REFUSED = data.paid.words.spot_refused;

/** What one spot's usage may bill its payer each day, by reading (`paid.spot_carve.per_day`); a reading with no row
 *  carves nothing. */
export const spotCarve = () => data.paid.spot_carve.per_day;

/** One spot's readings for a day clamped to its carve, so what another account's usage bills the payer never passes what
 *  was reserved against the payer's paid ceiling. */
export const withinCarve = readings => Object.fromEntries(Object.entries(readings).map(([name, count]) => [name, Math.min(count, spotCarve()[name] ?? 0)]));

/** The window the paid ceiling counts, in days. */
export const PAID_WINDOW_DAYS = data.paid.window_days;
