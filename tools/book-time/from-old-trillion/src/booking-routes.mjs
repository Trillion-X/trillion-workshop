// Where booking meets the rest of the service: a purchase that grants a bookable access (called from the person's
// store as the payment effect lands), the MCP verbs a person's AI calls (/booking/... with the signed-in person
// known), and what the Book a session screen shows. A link from an email (/book/<token>) is an address into that one
// screen (its surface's route_prefix): the token is the key the screen reads, never a page of its own. Each host's
// bookings live in that host's BookingCalendar.
import { bookables, bookableById, bookablesGranted, bookablesHeld, bookablesInOffer, bookingPeriod, bookingScreenPath, grantHeldByActivePurchase, grantKey, mentionFits, purchaseKey } from './booking.mjs';
import { entitlementOffer } from './offer-allocation.mjs';
import { checkoutFor, currentOfferId, keepsDecisions, offersShownTo, priceArmsFor, readPaymentConfig, saleOffers, surfacesSelling } from './payment.mjs';
import { hostOf, addressId } from './resource-host.mjs';

// The arms a booking road quotes: only the price experiments testing an offer that sells a session, so opening Book a
// session never counts the person as shown a price it does not draw (src/payment.mjs priceArmsFor).
const bookingArms = (env, userId, config) => priceArmsFor(env, { userId, config, surfaces: surfacesSelling(config, saleOffers().filter(offer => bookablesInOffer(offer).length).map(offer => offer.id)) });
export const calendarFor = (env, row) => hostOf(env, { kind: 'booking', key: row.host.id });
const personRefOf = (env, userId) => addressId(env, { kind: 'person', key: userId });
const personOf = (env, userId) => hostOf(env, { kind: 'person', key: userId });
const offerOf = effect => saleOffers().find(offer => offer.id === currentOfferId(effect.material?.offer_id ?? effect.object)) ?? null;
const contractOf = effect => {
  const snapshot = effect?.material?.entitlement_snapshot;
  if (snapshot && typeof snapshot === 'object' && !Array.isArray(snapshot)) return snapshot;
  if (typeof snapshot === 'string') {
    try {
      const parsed = JSON.parse(snapshot);
      return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null;
    } catch { return null; }
  }
  return null;
};
const renewable = effect => effect?.kind === 'subscription.renewed' && effect.material?.billing_reason === 'subscription_cycle' && Boolean(contractOf(effect));
const purchases = effects => effects.filter(effect => (effect?.kind === 'payment.confirmed' || renewable(effect)) && (offerOf(effect) || contractOf(effect)));
// The offer that sells a bookable access most directly: the one granting the fewest other things.
// An offer sells a session when what it gives includes the session: its own access, or for a plan bought as spots
// (offer:trillion) the access of the plan each spot holds (entitlementOffer).
const accessGiven = offer => entitlementOffer(offer).access_refs ?? [];
const offerSelling = (row, offers) => offers.filter(offer => accessGiven(offer).includes(row.access)).sort((a, b) => accessGiven(a).length - accessGiven(b).length)[0] ?? null;

/** A payment effect just landed on a person's store: every bookable access its offer grants gets a grant, and the
 * first time, the buyer's link and the host's note go out. */
export async function bookingsFromPurchase(env, { personRef, effect, origin }) {
  if (effect?.kind !== 'payment.confirmed' && !renewable(effect)) return [];
  const offer = offerOf(effect);
  const contract = contractOf(effect);
  const results = [];
  for (const row of bookablesGranted(offer, contract)) {
    const period = bookingPeriod(row, contract, effect);
    if (effect.kind === 'subscription.renewed' && !period) continue;
    results.push(await calendarFor(env, row).grantFromPurchase({ bookable_id: row.id, key: grantKey(row, purchaseKey(effect), personRef), person_ref: personRef, email: effect.material?.customer_email ?? null, name: effect.material?.customer_name ?? null, offer, contract, period, origin }));
  }
  return results;
}

// Purchases made before booking existed get their grants when the person next looks; no message is sent for them.
async function grantsFromPurchases(env, userId) {
  const personRef = personRefOf(env, userId);
  for (const effect of purchases(await personOf(env, userId).paymentEffects())) {
    const offer = offerOf(effect);
    const contract = contractOf(effect);
    for (const row of bookablesGranted(offer, contract)) {
      const period = bookingPeriod(row, contract, effect);
      if (effect.kind === 'subscription.renewed' && !period) continue;
      await calendarFor(env, row).ensureGrant({ bookable_id: row.id, key: grantKey(row, purchaseKey(effect), personRef), person_ref: personRef, email: effect.material?.customer_email ?? null, name: effect.material?.customer_name ?? null, offer_id: offer?.id ?? effect.material?.offer_id ?? null, contract, period });
    }
  }
  return personRef;
}
const hosts = () => [...new Map(bookables().map(row => [row.host.id, row])).values()];
/** Whether `userId` is the host of `row`: the account a setting of the row's calendar or calendar service names. */
export const hostsRow = (env, row, userId) => [row.host.calendar?.account?.setting, row.host.calendar_service?.account?.setting].some(setting => setting && env?.[setting] === userId);

/** Everything the Book a session screen shows one person: per bookable, the offer selling it, what they hold (with open
 * times while a session is left to book), the open times and their picked time when they hold none, and, for the
 * host, every upcoming session. */
export async function bookingScreenFacts(env, userId, origin) {
  // Nothing here waits on another read it does not need: the offers, what the person holds and the host's times are
  // asked for together.
  const [config, access, personRef] = await Promise.all([readPaymentConfig(env), personOf(env, userId).readAccess({ require_current_contracts: true }), grantsFromPurchases(env, userId)]);
  const effects = await personOf(env, userId).paymentEffects();
  const shown = offersShownTo(await bookingArms(env, userId, config), access, config);
  return Promise.all(bookables().map(async row => {
    const calendar = calendarFor(env, row);
    const offer = offerSelling(row, shown);
    const [state, hosting] = await Promise.all([
      calendar.state({ person_ref: personRef, bookable_id: row.id, origin, with_times: true }),
      hostsRow(env, row, userId) ? calendar.upcoming({ bookable_ids: [row.id], origin }) : null,
    ]);
    const held = access.capabilities.includes(row.access)
      ? state.grants.filter(grant => grantHeldByActivePurchase({ effects, episodes: access.episodes, grant, row })) : [];
    const bookable = access.capabilities.includes(row.access) && held.some(grant => grant.sessions_left > 0);
    // An unsold session has no time picker. Reading its host calendar can fail or delay every other session on the page.
    const open = offer && !bookable ? await calendar.times({ bookable_id: row.id, person_ref: personRef }) : null;
    return { row, offer, held, open, hosting };
  }));
}

/** A person picked a time: booked at once when they already hold a session to book, else kept for them while they pay
 * and answered with the checkout. */
export async function pickTime(env, { userId, bookable_id: bookableId, start, origin }) {
  const row = bookableById(bookableId) ?? bookables()[0];
  if (!row) throw Object.assign(new Error('That session is not offered.'), { status: 404 });
  const personRef = await grantsFromPurchases(env, userId);
  const access = await personOf(env, userId).readAccess({ require_current_contracts: true });
  const effects = await personOf(env, userId).paymentEffects();
  const calendar = calendarFor(env, row);
  const held = (await calendar.state({ person_ref: personRef, bookable_id: row.id, origin })).grants
    .filter(grant => grantHeldByActivePurchase({ effects, episodes: access.episodes, grant, row }));
  if (access.capabilities.includes(row.access) && held.some(grant => grant.sessions_left > 0)) {
    const result = await calendar.bookTime({ person_ref: personRef, bookable_id: row.id, start, origin });
    if (result.refused) throw Object.assign(new Error(result.refused.message), { status: result.refused.status });
    return { booked: result.booked };
  }
  const config = await readPaymentConfig(env);
  const arms = await bookingArms(env, userId, config);
  const offer = offerSelling(row, offersShownTo(arms, access, config));
  if (!offer) throw Object.assign(new Error('This session is not on sale right now.'), { status: 404 });
  const link = checkoutFor(config, access, userId, offer.id, arms);
  if (!link) throw Object.assign(new Error('Checkout is not open yet. Try again shortly.'), { status: 503 });
  const kept = await calendar.hold({ bookable_id: row.id, person_ref: personRef, start });
  if (kept.refused) throw Object.assign(new Error(kept.refused.message), { status: kept.refused.status });
  return { held: kept.held, checkout_link: link, offer };
}

/** Whether a person picked a time or bought a session in the last day, so the return from paying opens the booking screen. */
export async function returningToBook(env, userId) {
  const personRef = personRefOf(env, userId);
  for (const host of hosts()) if (await calendarFor(env, host).recent({ person_ref: personRef, since_ms: Date.now() - 24 * 60 * 60 * 1000 })) return true;
  return false;
}

/** Cancels a booking by its own change link's token (the person who booked it, or the host, who sees the same link). */
export async function cancelBooking(env, token, origin) {
  const result = await findAndChange(env, token, { cancel: true, origin });
  if (!result || result.refused) throw Object.assign(new Error(result?.refused?.message ?? 'That session could not be found.'), { status: result?.refused?.status ?? 404 });
  return result;
}
/** Every host's booking calendar, by host id. */
export const bookingCalendars = env => hosts().map(row => ({ id: row.host.id, stub: calendarFor(env, row) }));

/** What the person's screen shows: each bookable session they hold (with open times while one is left to book). */
export async function sessionsForScreen(env, userId, origin) {
  const personRef = await grantsFromPurchases(env, userId);
  const access = await personOf(env, userId).readAccess({ require_current_contracts: true });
  const effects = await personOf(env, userId).paymentEffects();
  const held = [];
  for (const host of hosts()) held.push(...(await calendarFor(env, host).state({ person_ref: personRef, origin, with_times: true })).grants.filter(grant => {
    const row = bookableById(grant.bookable_id);
    return row && access.capabilities.includes(row.access) && grantHeldByActivePurchase({ effects, episodes: access.episodes, grant, row });
  }));
  return held;
}

/** The MCP verbs, answered with the signed-in person known. */
/** The session-offer mention a decision makes (src/tools.mjs afterDecision): answered by this owner on every MCP road,
 *  including the account's own resource mount, where a decision is decided natively. */
export const isBookingMentionCall = path => path === '/booking/mention';
export async function handleBookingCall(env, { userId, origin, path, body = {}, method = 'GET' }) {
  const config = await readPaymentConfig(env);
  const access = await personOf(env, userId).readAccess({ require_current_contracts: true });
  const arms = await bookingArms(env, userId, config);
  const shown = offersShownTo(arms, access, config);
  const heldRows = new Set(bookablesHeld(access.capabilities).map(row => row.id));
  // With no session named, buying means the first session on sale; looking or booking means the one the person holds.
  const sold = () => bookables().find(item => offerSelling(item, shown));
  const owned = () => bookables().find(item => heldRows.has(item.id));
  const rowFor = (id, { buying = false } = {}) => {
    const row = id ? bookableById(id) : buying ? sold() ?? owned() : owned() ?? sold();
    if (!row) throw Object.assign(new Error('That session is not offered. session_offers lists the ones that are.'), { status: 404 });
    return row;
  };
  if (path === '/booking/offers') {
    for (const id of body.not_interested ?? []) if (bookableById(id)) await personOf(env, userId).keepBookingMention(userId, id, { declined_at: new Date().toISOString() });
    const personRef = await grantsFromPurchases(env, userId);
    const effects = await personOf(env, userId).paymentEffects();
    const out = [];
    for (const row of bookables()) {
      const offer = offerSelling(row, shown);
      const state = (await calendarFor(env, row).state({ person_ref: personRef, bookable_id: row.id, origin })).grants
        .filter(grant => grantHeldByActivePurchase({ effects, episodes: access.episodes, grant, row }));
      if (!offer && !heldRows.has(row.id)) continue;
      out.push({
        bookable_id: row.id, title: row.session.title, host: row.host.name, place: row.session.place, hours: row.rules.session_minutes / 60,
        offer: offer ? { id: offer.id, summary: offer.summary, price: offer.price_options?.[0]?.label ?? null } : null,
        held: heldRows.has(row.id),
        sessions_left: heldRows.has(row.id) ? state.reduce((sum, grant) => sum + grant.sessions_left, 0) : 0,
        upcoming: state.flatMap(grant => grant.bookings),
      });
    }
    return { sessions: out, book_here: `${origin}${bookingScreenPath()}`, next: 'open_session_times shows open times; buy_session with the start the person picks keeps that time and returns the checkout link; book_session_time books one once it is bought.' };
  }
  if (path === '/booking/buy') {
    const row = rowFor(body.bookable_id, { buying: true });
    const offer = offerSelling(row, shown);
    if (!offer) throw Object.assign(new Error('This session is not on sale right now.'), { status: 404 });
    if (access.capabilities.includes(row.access)) return { already_bought: true, next: 'Call open_session_times, then book_session_time.' };
    const screen = `${origin}${bookingScreenPath()}`;
    // With the time the person picked, it is kept for them while they pay and the checkout books it; without one, the
    // booking screen shows the open times, and paying there books the one they pick.
    if (!body.start) return { book_here: screen, offer: { id: offer.id, summary: offer.summary, price: offer.price_options?.[0]?.label ?? null }, tell_the_person: [`Pick a time with ${row.host.name} and pay here: ${screen}. Nothing is charged until you confirm on Stripe's page.`], next: 'Or show open_session_times, and call buy_session again with the start the person picks: that time is kept for them while they pay.' };
    const picked = await pickTime(env, { userId, bookable_id: row.id, start: body.start, origin });
    return { checkout_link: picked.checkout_link, held: picked.held, offer: { id: offer.id, summary: offer.summary, price: offer.price_options?.[0]?.label ?? null }, tell_the_person: [`${picked.held.when} is kept for you while you pay. Here is the checkout for ${row.session.title}: ${picked.checkout_link}. Nothing is charged until you confirm on Stripe's page; once you pay, the session is booked and the invitation is in your email. You can also see it at ${screen}.`] };
  }
  if (path === '/booking/times') {
    const row = rowFor(body.bookable_id);
    const personRef = await grantsFromPurchases(env, userId);
    const mine = access.capabilities.includes(row.access)
      ? (await calendarFor(env, row).state({ person_ref: personRef, bookable_id: row.id, origin, with_times: true })).grants.find(grant => grant.sessions_left > 0)
      : null;
    const open = mine ?? await calendarFor(env, row).times({ bookable_id: row.id });
    const limit = Math.min(Math.max(Number(body.limit) || 12, 1), 60);
    return { bookable_id: row.id, timezone: row.rules.timezone, bought: Boolean(mine), times: (open.times ?? []).slice(0, limit), more: Math.max(0, (open.times ?? []).length - limit), ...(open.note ? { tell_the_person: [open.note] } : {}), ...(mine ? {} : { next: `buy_session with the start the person picks keeps that time for them while they pay, or they pick and pay at ${origin}${bookingScreenPath()}.` }) };
  }
  if (path === '/booking/book') {
    const row = rowFor(body.bookable_id);
    const personRef = await grantsFromPurchases(env, userId);
    const result = await calendarFor(env, row).bookTime({ person_ref: personRef, bookable_id: row.id, start: body.start, case_id: body.case_id ?? null, name: body.name ?? null, time_zone: body.time_zone ?? null, origin });
    if (result.refused) throw Object.assign(new Error(result.refused.message), { status: result.refused.status });
    return { booked: result.booked, emails_sent: result.sent.filter(item => item.sent || item.queued).length, tell_the_person: [`Booked: ${result.booked.when} with ${result.booked.host}.${result.booked.video_link ? ` Join the video call at ${result.booked.video_link}.` : ''} ${result.booked.buyer_has_email ? 'Your invitation is sent to your email.' : 'Your booking is saved in your account.'} Change or cancel at ${result.booked.change_or_cancel}.`] };
  }
  if (path === '/booking/change') {
    const token = String(body.change_link ?? '').split('/book/').pop();
    const result = await findAndChange(env, token, { start: body.start ?? null, cancel: body.cancel === true, origin });
    if (!result || result.refused) throw Object.assign(new Error(result?.refused?.message ?? 'That change link is not valid.'), { status: result?.refused?.status ?? 404 });
    return result;
  }
  if (path === '/booking/mention') {
    // Said once, when the decision fits the row's condition, to someone who does not hold it and did not say no.
    const record = body.record ?? {};
    const lines = [];
    const person = personOf(env, userId);
    const said = await person.bookingMentions(userId, bookables().map(row => row.id));
    for (const row of bookables()) {
      const offer = offerSelling(row, shown);
      if (!offer) continue;
      if (!mentionFits({ row, record, holdsAccess: access.capabilities.includes(row.access), seen: said[row.id] ?? null, nowMs: Date.now() })) continue;
      // The decision it was said for is named only for a person whose decisions are kept; a free decision is kept nowhere.
      await person.keepBookingMention(userId, row.id, { mentioned_at: new Date().toISOString(), case_id: keepsDecisions(access) ? record.id ?? null : null });
      lines.push(`${offer.summary} ${row.mention.line}`);
    }
    return lines.length ? { tell_the_person: lines, session_offer: 'buy_session returns the checkout link; open_session_times lists times; session_offers with not_interested stops these mentions.' } : {};
  }
  throw Object.assign(new Error('Not found'), { status: 404 });
}

// A booking's key does not name its host, so each host's calendar is asked in turn.
async function findBooking(env, token, origin) {
  for (const host of hosts()) {
    const page = await calendarFor(env, host).bookingPage({ booking_token: token, origin });
    if (page) return { host, page };
  }
  return null;
}
async function findAndChange(env, token, change) {
  const found = await findBooking(env, token, change.origin);
  return found ? calendarFor(env, found.host).change({ booking_token: token, ...change }) : null;
}

/** The booking a link's key names, with the times it could move to, or null when the key names no booking (a grant's
 * key, an old or mistyped one). Read by the Book a session screen opened at /book/<key>. */
export async function bookingByKey(env, token, origin) {
  if (typeof token !== 'string' || !/^[0-9a-f]{16,}$/.test(token)) return null;
  return (await findBooking(env, token, origin))?.page ?? null;
}
/** Moves a booking to another open time by its key (the person who booked it, or the host, who sees the same key). */
export async function moveBooking(env, token, start, origin) {
  const result = await findAndChange(env, token, { start, origin });
  if (!result || result.refused) throw Object.assign(new Error(result?.refused?.message ?? 'That session could not be found.'), { status: result?.refused?.status ?? 404 });
  return result;
}

/** A person deleting their account: every host cancels their upcoming sessions and forgets their email. */
export async function forgetSessions(env, userId, origin) {
  let cancelled = 0;
  for (const host of hosts()) cancelled += (await calendarFor(env, host).forget({ person_ref: personRefOf(env, userId), origin })).cancelled;
  return { sessions_cancelled: cancelled };
}
