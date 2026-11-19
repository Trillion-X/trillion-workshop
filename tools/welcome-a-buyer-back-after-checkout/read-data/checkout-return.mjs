// src/checkout-return.mjs
//
// PURPOSE
//   Where a purchase started, carried through checkout to the page that welcomes the buyer back. A purchase started
//   somewhere else (the Chrome extension's Free and Paid cards) opens /buy/<offer id>?from=<place>&return=<page>; the
//   place and the page are kept on the buyer's account, and coming back from checkout opens /welcome: "Welcome to
//   Trillion" and, for a place with its own row in src/checkout-welcome.json, the steps back to what they were doing,
//   each with its picture, the first one opening the page they were on.
//
// NON-NEGOTIABLE INVARIANTS
//   1. The places are DATA (src/checkout-welcome.json `origins`): a new place is a row, never a branch here.
//   2. `return` is only ever an http(s) address with no user name or password in it; anything else is dropped, so it
//      can never become a script address or a way to send someone somewhere else under Trillion's name.
//   3. What was kept is the buyer's own (KV `checkout-return:<account id>`), for `keep_seconds`, and only read by them.
//   4. Nothing here writes markup: the page is section DATA for the shared page shell (tools/ui/show/server-rendered-page).
//
const KEY = userId => `checkout-return:${userId}`;
const LONGEST_ADDRESS = 2048;

/** The web address a person may be sent back to, or null: http(s), no user name or password, not too long. */
export function returnAddress(value) {
  if (typeof value !== 'string' || !value || value.length > LONGEST_ADDRESS) return null;
  let url;
  try { url = new URL(value); } catch { return null; }
  if ((url.protocol !== 'https:' && url.protocol !== 'http:') || url.username || url.password) return null;
  return url.href;
}

/** Content and purchased-offer wording are supplied by their current row/host owners. */
export function makeCheckoutReturn({ welcome, afterPurchase }) {
/** Where a purchase started, from the address that starts it, or null: `from` must name a place in the DATA and
 *  `return` must be a web address a person may be sent back to. */
function cameFromOf(searchParams) {
  const from = searchParams.get('from');
  const back = returnAddress(searchParams.get('return'));
  return back && welcome.origins.some(row => row.from === from) ? { from, return: back } : null;
}

/** Keeps where a purchase started on the buyer's account while they pay. */
const keepCameFrom = (kv, userId, cameFrom) => kv.put(KEY(userId), JSON.stringify(cameFrom), { expirationTtl: welcome.keep_seconds });

/** Where the buyer's latest purchase started, while it is kept, or null. */
async function keptCameFrom(kv, userId) {
  const kept = await kv.get(KEY(userId), 'json');
  const back = returnAddress(kept?.return);
  return back && welcome.origins.some(row => row.from === kept.from) ? { from: kept.from, return: back } : null;
}

/** The address the welcome page answers on. */
const WELCOME_ADDRESS = welcome.address;

// A step's address: a plain address, or { from: 'return' } for the page they were on.
const addressOf = (href, cameFrom) => (href && typeof href === 'object' && href.from === 'return' ? cameFrom?.return ?? null : href);

// The tour button opens Tours with the bought offer's own tour (`/tours?take=<walkthrough id>`), which starts it.
const withTour = (action, tour) => (tour && action.href === welcome.tours_address ? { ...action, href: `${welcome.tours_address}?take=${encodeURIComponent(tour)}` } : action);

/** The welcome page's description for the shared page shell: the welcome in the words of the offer bought (its row's
 *  after_purchase, src/payment.mjs afterPurchase: what they got, what they pay, their next step and tour), and the
 *  steps of the place the purchase started from when it is kept. */
function welcomePage(cameFrom, offer = null) {
  const origin = cameFrom ? welcome.origins.find(row => row.from === cameFrom.from) : null;
  const steps = (origin?.steps ?? []).map(({ action, ...step }) => {
    const href = addressOf(action?.href, cameFrom);
    return { ...step, actions: action && href ? [{ label: action.label, href }] : [] };
  });
  const after = offer ? afterPurchase(offer) : null;
  const bought = after ? [after.got, after.pays].filter(Boolean).join(' ') : '';
  return {
    title: welcome.title,
    robots: 'noindex',
    island: null,
    sections: [{
      heading: after?.heading ?? welcome.welcome.heading,
      heading_level: 1,
      body: [bought, origin?.body ?? (bought ? '' : welcome.welcome.body)].filter(Boolean).join(' '),
      steps,
      // The plan's next step first; a usual action that goes to the same place is not said twice.
      actions: [...(after?.next ? [{ label: after.next.label, href: after.next.href }] : []), ...welcome.welcome.actions.filter(action => action.href !== after?.next?.href).map(action => withTour(action, after?.tour))],
    }],
  };
}

  return { cameFromOf, keepCameFrom, keptCameFrom, WELCOME_ADDRESS, welcomePage };
}

/** The buyer's kept context as rows in hand: the caller reads the selected account's `checkout-return:yours` record
 *  from its own store and hands it in as `stored.records` (value null when absent); a change comes back as `keep`, the
 *  record with the value it expected, so a store refuses it when the record moved. Expiry is checked on every read. */
export function checkoutReturnInHand({ welcome, afterPurchase, now = () => Date.now() }) {
  const owner = makeCheckoutReturn({ welcome, afterPurchase });
  const type = 'checkout-return', id = 'checkout-return:yours';
  // The handed record, or null when the store has none. Leaving it out is refused, never read as absent.
  const heldOf = stored => {
    const record = (Array.isArray(stored?.records) ? stored.records : []).find(row => row?.id === id);
    if (!record) throw new TypeError(`Hand in the ${id} record as stored.records (value null when absent).`);
    return record.value === null || record.value === undefined ? null : { type: record.type ?? type, value: record.value };
  };
  return {
    ...owner,
    keep(input, stored) {
      const cameFrom = owner.cameFromOf(new URLSearchParams(input));
      if (!cameFrom) throw new TypeError('Give a listed origin and a safe return address.');
      const expected = heldOf(stored);
      const value = { came_from: cameFrom, expires_at: now() + welcome.keep_seconds * 1000 };
      return { came_from: cameFrom, keep: [{ id, type, value, expected }] };
    },
    kept(stored) {
      const record = heldOf(stored);
      if (!record || !Number.isFinite(record.value?.expires_at) || record.value.expires_at <= now()) return null;
      return owner.cameFromOf(new URLSearchParams(record.value.came_from));
    },
  };
}
