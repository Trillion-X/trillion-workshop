// Paying for other people's places: one purchase that pays for several people, each place taken by another account
// accepting the payer's invitation, places that end with the purchase, and each taker's own room kept for life. The
// cases are moved from trillion test/team-seats.test.mjs (pure seat rules), test/unified-pricing.test.mjs (the
// beneficiary's one pending claim) and test/born-account-funding.test.mjs (the payer gives, the beneficiary keeps the
// effects once), over a made-up club instead of the old app's offers. The old Plan-screen and payment-link cases stay
// with their owners (the screen, and tools/take-payments ensure-offer-payment-links).
import test from 'node:test';
import assert from 'node:assert/strict';
import { seatsFor, seatLinkCodeIn } from '../read-data/seats.mjs';
import { makeFundingAcceptance } from '../read-data/funding-acceptance.mjs';
import { entitlementOffer } from '../read-data/offer-allocation.mjs';
import { currentCapabilityState } from '../read-data/effect-lifecycle.mjs';
import events from '../read-data/take-payments-events.json' with { type: 'json' };

const lifecycle = events.lifecycle;
const member = { id: 'offer:club-member', label: 'Club member', access_refs: ['access:lessons', 'access:room', 'access:archive'],
  price_options: [{ id: 'price:member', amount_cents: 2000, currency: 'usd', payment_timing: 'subscription', interval: 'month' }] };
const room = { id: 'offer:own-room', label: 'Your own room', access_refs: ['access:room'],
  price_options: [{ id: 'price:room', amount_cents: 500, currency: 'usd', payment_timing: 'one_time' }] };
const team = { id: 'offer:club-team', label: 'Club for teams', access_refs: ['access:lessons', 'access:room', 'access:archive'],
  seats: { grants_offer: member.id, keeps_for_life: room.id },
  price_options: [{ id: 'price:team-seat', amount_cents: 2000, currency: 'usd', payment_timing: 'subscription', interval: 'month', seats: { minimum: 2, maximum: 50 } }] };
const places = { id: 'offer:club-places', label: 'Club places', allocation: { grants_offer: member.id },
  price_options: [{ id: 'price:place', amount_cents: 2000, currency: 'usd', payment_timing: 'subscription', interval: 'month', quantity: { minimum: 1 } }] };
const offers = [member, room, team, places];
const words = {
  taken: '{taken} of {total} places taken, including yours', single: '1 place, yours.', single_team: 'Use {team} to pay for more places.',
  copy: 'Copy invitation', copied_text: 'Take a place on my team: {link}', took: 'You have a place. You are on {plan}.',
  allocated: '{taken} of {total} places assigned.', pending: 'The quantity is not confirmed yet.', invitation: 'I am paying for a place for you: {link}',
  assigned: 'Your paid place is active.',
  refused: { full: 'All {total} places are taken.', covered: 'You already have {plan}.', ended: 'This purchase has ended.',
    unverified: 'The quantity is not confirmed yet.', not_a_seat_link: 'This invitation does not work.' },
};
const seats = seatsFor({ offers, lifecycle, words });
const { endsSeatPurchase, ownsFirstSpot, seatEndEffects, seatPurchases, seatWords, seatsBought, takeSeat, tookWords, singleSeatWords } = seats;
const access = effects => currentCapabilityState({ effects, offers, lifecycle });

const bought = (count, at = '2026-09-29T10:00:00Z') => ({
  effect_id: 'evt_team', kind: 'payment.confirmed', subject: 'buyer', object: team.id,
  material: { occurred_at: at, offer_id: team.id, price_option_id: 'price:team-seat', subscription_id: 'sub_team', payment_status: 'paid', subtotal_cents: count * 2000, amount_due_today_cents: count * 1000 },
});
const ended = { effect_id: 'evt_team_end', kind: 'subscription.ended', subject: 'buyer', object: team.id, material: { occurred_at: '2026-10-29T10:00:00Z', offer_id: team.id, subscription_id: 'sub_team' } };
const nothing = access([]);

test('the seat count is the amount before any code over the seat price; nothing else buys seats', () => {
  assert.equal(seatsBought(bought(5)), 5, 'a half-price code does not change the count');
  assert.equal(seatsBought({ ...bought(5), material: { ...bought(5).material, subtotal_cents: 12345 } }), null, 'an amount that is not whole seats buys none');
  assert.equal(seatsBought({ ...bought(5), material: { ...bought(5).material, offer_id: member.id } }), null);
  assert.deepEqual(seatPurchases([bought(3)]).map(row => [row.offer.id, row.total]), [[team.id, 3]]);
  assert.deepEqual(seatPurchases([bought(3), ended]), [], 'an ended purchase sells no seats');
});

test('a seat gives the paid plan and the own room for life; the buyer holds one seat, and the count is kept', () => {
  const purchases = seatPurchases([bought(3)]);
  const first = takeSeat({ purchases, taken: [], buyer: 'buyer', taker: 'ana', taker_access: nothing });
  assert.equal(first.refused, undefined);
  const held = access(first.effects);
  for (const ref of member.access_refs) assert.ok(held.capabilities.includes(ref), ref);
  assert.equal(tookWords(purchases[0]), 'You have a place. You are on Club member.');
  const taken = [first.seat];
  assert.deepEqual(takeSeat({ purchases, taken, buyer: 'buyer', taker: 'ana', taker_access: held }).effects.map(effect => effect.effect_id), first.effects.map(effect => effect.effect_id), 'opening the invitation again changes nothing');
  const second = takeSeat({ purchases, taken, buyer: 'buyer', taker: 'ben', taker_access: nothing });
  const full = takeSeat({ purchases, taken: [...taken, second.seat], buyer: 'buyer', taker: 'cai', taker_access: nothing });
  assert.equal(full.refused, 'full');
  assert.equal(full.words, 'All 3 places are taken.');
  assert.equal(seatWords(purchases[0], [...taken, second.seat], 'https://club.example/seat/x').detail, '3 of 3 places taken, including yours');
  assert.deepEqual(seatWords(purchases[0], [], 'https://club.example/seat/x').action, { label: 'Copy invitation', tone: 'primary', copy: 'Take a place on my team: https://club.example/seat/x' });
});

test('someone who already has the plan, or the buyer, takes no seat; an ended purchase gives none', () => {
  const purchases = seatPurchases([bought(3)]);
  const paying = access([{ effect_id: 'own', kind: 'payment.confirmed', subject: 'dee', object: member.id, material: { occurred_at: '2026-09-01T00:00:00Z', offer_id: member.id, subscription_id: 'sub_dee', payment_status: 'paid' } }]);
  assert.equal(takeSeat({ purchases, taken: [], buyer: 'buyer', taker: 'dee', taker_access: paying }).words, 'You already have Club member.');
  assert.equal(takeSeat({ purchases, taken: [], buyer: 'buyer', taker: 'buyer', taker_access: access([bought(3)]) }).refused, 'covered');
  assert.equal(takeSeat({ purchases: seatPurchases([bought(3), ended]), taken: [], buyer: 'buyer', taker: 'ana', taker_access: nothing }).refused, 'ended');
});

test('when the purchase ends every seat ends, and each taker keeps their own room', () => {
  const purchases = seatPurchases([bought(3)]);
  const seat = takeSeat({ purchases, taken: [], buyer: 'buyer', taker: 'ana', taker_access: nothing, at: '2026-09-30T09:00:00Z' });
  const which = endsSeatPurchase(ended, [bought(3), ended]);
  assert.deepEqual(which, { offer_id: team.id, episode_ref: 'sub_team' });
  assert.equal(endsSeatPurchase(bought(3), [bought(3)]), null, 'a payment ends nothing');
  assert.equal(endsSeatPurchase(bought(3), () => { throw new Error('Unused history read'); }), null);
  let reads = 0;
  assert.deepEqual(endsSeatPurchase(ended, () => { reads += 1; return [bought(3), ended]; }), which);
  assert.equal(reads, 1, 'an actual cancellation still reads the history exactly once');
  const ends = seatEndEffects({ purchase_offer: which.offer_id, episode_ref: which.episode_ref, taken: [seat.seat], at: ended.material.occurred_at });
  assert.deepEqual(ends.map(row => row.taker), ['ana']);
  const after = access([...seat.effects, ...ends.map(row => row.effect), ...ends.map(row => row.effect)]);
  assert.ok(after.capabilities.includes('access:room'), 'their own room is kept');
  assert.ok(!after.capabilities.includes('access:archive'), 'the paid plan ended with the purchase');
  assert.ok(!nothing.capabilities.includes('access:room'), 'the own room is only ever given or bought, never held by everyone');
});

test('a buyer\'s first purchase of spots gives them one at once; a later purchase, or one by someone holding a spot, is for others', () => {
  const spots = (id, at) => ({ effect_id: `evt_${id}`, kind: 'payment.confirmed', subject: 'buyer', object: places.id,
    material: { occurred_at: at, offer_id: places.id, price_option_id: 'price:place', subscription_id: id, payment_status: 'paid', amount_due_today_cents: 0 } });
  const verified = id => ({ [id]: { subscription_id: id, offer_id: places.id, source: 'provider-subscription', count: 1 } });
  const first = seatPurchases([spots('sub_1', '2026-10-06T10:00:00Z')], verified('sub_1'));
  assert.equal(ownsFirstSpot({ owner: 'buyer', purchases: first, taken: [], episode: 'sub_1' }), true);
  const own = takeSeat({ purchases: first, taken: [], buyer: 'buyer', taker: 'buyer', taker_access: nothing });
  assert.equal(own.refused, undefined, 'the buyer takes their own first spot');
  assert.ok(own.effects.some(effect => effect.material.offer_id === member.id), 'which puts them on the plan');
  const taken = [own.seat];
  const both = seatPurchases([spots('sub_1', '2026-10-06T10:00:00Z'), spots('sub_2', '2026-10-06T11:00:00Z')], { ...verified('sub_1'), ...verified('sub_2') });
  assert.equal(ownsFirstSpot({ owner: 'buyer', purchases: both, taken, episode: 'sub_2' }), false, 'a second purchase is for someone else');
  assert.equal(ownsFirstSpot({ owner: 'buyer', purchases: first, taken, episode: 'sub_1' }), false, 'once held, never taken twice');
  assert.equal(ownsFirstSpot({ owner: 'buyer', purchases: seatPurchases([spots('sub_1', '2026-10-06T10:00:00Z')]), taken: [], episode: 'sub_1' }), false, 'nothing before the provider verifies the quantity');
  assert.equal(seatWords(first[0], taken, 'x').detail, '1 of 1 places assigned.');
  assert.equal(tookWords(first[0]), 'Your paid place is active.');
  assert.deepEqual(entitlementOffer(places, offers).access_refs, member.access_refs, 'what the places purchase pays for is the plan it grants');
});

test('the seat line on a plan bought for one person names the offer that sells places while one is for sale', () => {
  assert.equal(singleSeatWords(), 'Use Club for teams to pay for more places.');
  assert.equal(seatsFor({ offers: offers.map(offer => ({ ...offer, for_sale: false })), lifecycle, words }).singleSeatWords(), '1 place, yours.');
});

test('acceptance survives unknown outcomes and rejects a competing sponsor before any second reservation', async () => {
  let state = null; let fail = true; const effects = [];
  const accept = makeFundingAcceptance({ read: () => state, write: value => { state = value; }, access: async () => nothing,
    give: async args => { if (fail) throw new Error('unknown RPC outcome'); return { words: 'accepted', effects: [{ effect_id: args.buyer }] }; },
    record: async effect => effects.push(effect),
  });
  await assert.rejects(accept({ buyer: 's', taker: 'c', episode_ref: 'sub_S' }), /unknown/);
  assert.equal((await accept({ buyer: 'j', taker: 'c', episode_ref: 'sub_J' })).refused, 'pending');
  fail = false;
  assert.equal((await accept({ buyer: 's', taker: 'c', episode_ref: 'sub_S' })).words, 'accepted');
  assert.equal(state, null); assert.equal(effects.length, 1);
});

test('a place is a change on two accounts: the payer gives one place of their purchase, the beneficiary keeps its effects once', async () => {
  // The payer's side keeps the places taken; the beneficiary's side keeps the one pending claim and its own effects.
  const payer = { effects: [bought(2)], taken: [] };
  const beneficiary = { pending: null, effects: [] };
  const give = async ({ buyer, taker, episode_ref, taker_access }) => {
    const result = takeSeat({ purchases: seatPurchases(payer.effects), taken: payer.taken, buyer, taker, taker_access, episode_ref, at: '2026-10-01T00:00:00Z' });
    if (result.refused) return result;
    if (!payer.taken.some(row => row.taker === taker && row.episode_ref === result.seat.episode_ref)) payer.taken.push(result.seat);
    return { effects: result.effects, words: tookWords(result.purchase) };
  };
  const accept = makeFundingAcceptance({ read: () => beneficiary.pending, write: value => { beneficiary.pending = value; },
    access: async () => access(beneficiary.effects), give,
    record: async effect => { if (!beneficiary.effects.some(row => row.effect_id === effect.effect_id)) beneficiary.effects.push(effect); } });
  assert.deepEqual(await accept({ buyer: 'buyer', taker: 'ana', episode_ref: 'sub_team' }), { words: 'You have a place. You are on Club member.' });
  assert.ok(access(beneficiary.effects).active_offers.includes(member.id), 'the beneficiary holds the plan the payer pays for');
  await accept({ buyer: 'buyer', taker: 'ana', episode_ref: 'sub_team' });
  assert.equal(payer.taken.length, 1, 'accepting twice takes one place');
  assert.equal(beneficiary.effects.length, 2, 'and keeps its effects once');
  await assert.rejects(accept({ buyer: 'buyer', taker: '', episode_ref: 'sub_team' }), /payer and a beneficiary/);
});

test('an invitation code is made once and kept', async () => {
  const kept = new Map();
  const store = { read: async key => kept.get(key), write: async (key, code) => { kept.set(key, code); } };
  const code = await seatLinkCodeIn(store, 'seat_link_code:sub_team');
  assert.match(code, /^[0-9a-f]{32}$/);
  assert.equal(await seatLinkCodeIn(store, 'seat_link_code:sub_team'), code);
});
