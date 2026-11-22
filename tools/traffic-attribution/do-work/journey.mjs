// tools/traffic-attribution/do-work/journey.mjs
//
// The journey kit: what a client site's server uses to follow a visitor from a tracked link to a booking, a checkout and
// a paid sale, and to write each step to the pursuit's journey_steps table (read-data/journey-steps.sql). Every name and
// limit comes from read-data/journey.json and read-data/ad-return.json. The functions that touch the database take
// `query(sql, params)`, any pg-style client that resolves to { rows } (or the write's rowCount), so the site brings its own.
// A step is one plain object: visitor, touch_id, step, source, ref, joined_by, email_key, offer_id, value_cents.
import { randomBytes, randomUUID } from 'node:crypto';
import { makeHashCodeHexFromBytes } from '../../content-identity/read-data/identity.mjs';
import settings from '../read-data/journey.json' with { type: 'json' };
import adReturn from '../read-data/ad-return.json' with { type: 'json' };

const KEPT = new Set([...settings.kept_params, ...adReturn.click_ids]);
const COOKIE_VALUE = new RegExp(settings.cookie.value_pattern);
const REFERENCE = new RegExp(settings.stripe.client_reference_id.pattern);
const SHORT_ID_BYTES = 9;
const MAX_PARAM_LENGTH = 256;

const text = value => (typeof value === 'string' ? value.trim() : '');
const stepOf = fields => ({ visitor: null, touch_id: null, source: null, ref: null, joined_by: null, email_key: null, offer_id: null, value_cents: null, ...fields });
const webUrl = (value, message) => {
  let url;
  try { url = new URL(value); } catch { throw new TypeError(message); }
  if (!['https:', 'http:'].includes(url.protocol) || !url.hostname || url.username || url.password) throw new TypeError(message);
  return url;
};
const hostOf = referer => {
  try { return referer ? new URL(referer).hostname : null; } catch { return null; }
};
const pickKept = source => Object.fromEntries(Object.entries(source ?? {}).filter(([key, value]) => KEPT.has(key) && text(value)));

function cookieValue(cookieHeader, name) {
  for (const part of String(cookieHeader ?? '').split(';')) {
    const [key, ...rest] = part.trim().split('=');
    if (key === name) return rest.join('=');
  }
  return null;
}

function cookieString(visitor, cookie) {
  return [
    `${cookie.name}=${visitor}`,
    `Max-Age=${cookie.max_age_days * 86_400}`,
    `Path=${cookie.path}`,
    `SameSite=${cookie.same_site}`,
    cookie.http_only && 'HttpOnly',
    cookie.secure && 'Secure',
  ].filter(Boolean).join('; ');
}

/**
 * The visitor's id from the request's cookie, kept as it is when it is well formed; otherwise a new id and its Set-Cookie.
 * Without consent (read-data/journey.json consent.default, false) there is no id and no cookie: { visitor: null, setCookie: null }.
 */
export function visitorOf(cookieHeader, cookie = settings.cookie, { consent = settings.consent.default } = {}) {
  if (!consent) return { visitor: null, setCookie: null };
  const kept = cookieValue(cookieHeader, cookie.name);
  if (kept && COOKIE_VALUE.test(kept)) return { visitor: kept, setCookie: null };
  const visitor = randomUUID();
  return { visitor, setCookie: cookieString(visitor, cookie) };
}

/** The kept parameters of a page's address as its source, with the referrer's host and the landing path; {} when the address carries none. */
export function sourceOf(url, refererHeader) {
  let address;
  try { address = new URL(url, 'https://site.invalid'); } catch { return {}; }
  const source = {};
  for (const [key, value] of address.searchParams) {
    const clean = text(value);
    if (KEPT.has(key) && clean && clean.length <= MAX_PARAM_LENGTH) source[key] = clean;
  }
  if (Object.keys(source).length === 0) return {};
  const host = hostOf(refererHeader);
  if (host) source.referrer_host = host;
  source.landing_path = address.pathname;
  return source;
}

/** The visit step of a page request that came with a source, or null for a page reached with none. */
export function visitStep({ url, refererHeader, visitor = null }) {
  const source = sourceOf(url, refererHeader);
  if (Object.keys(source).length === 0) return null;
  const touchId = text(source[settings.touch_param]) || null;
  return stepOf({ visitor, touch_id: touchId, step: 'visit', source, joined_by: touchId ? 'touch' : visitor ? 'cookie' : null });
}

/** Writes one step; a step with a ref already kept is left as it is. Resolves to { kept }. */
export async function keepStep(query, step) {
  if (!Object.hasOwn(settings.steps, step?.step)) throw new TypeError('A step needs a kind that read-data/journey.json names.');
  const row = stepOf(step);
  const result = await query(
    `INSERT INTO journey_steps (visitor, touch_id, step, source, ref, joined_by, email_key, offer_id, value_cents)
     VALUES ($1, $2, $3, $4::jsonb, $5, $6, $7, $8, $9) ON CONFLICT DO NOTHING`,
    [row.visitor, row.touch_id, row.step, row.source === null ? null : JSON.stringify(row.source), row.ref, row.joined_by, row.email_key, row.offer_id, row.value_cents],
  );
  return { kept: (result.rowCount ?? result.affectedRows ?? 0) > 0 };
}

/**
 * The /go/:id route: finds the touch, keeps a click step and answers the redirect to the destination with the touch's UTM
 * fields and the touch id. Resolves to { status: 404 } for an unknown touch, and to { status: 503, retryAfter } when the
 * touch cannot be read (the database is unreachable). The click step is best effort: a failed write never holds the visitor
 * back. The visitor is `visitor` when given, else the cookie's, and only with consent (none otherwise, and no cookie is set).
 */
export async function goRedirect(query, touchId, { visitor, cookieHeader, refererHeader, cookie = settings.cookie, consent = settings.consent.default } = {}) {
  let found;
  try {
    found = (await query('SELECT id, destination, source FROM journey_touches WHERE id = $1', [touchId])).rows[0];
  } catch {
    return { status: 503, location: null, setCookie: null, retryAfter: settings.retry_after_seconds };
  }
  if (!found) return { status: 404, location: null, setCookie: null };
  const minted = !consent ? { visitor: null, setCookie: null } : visitor ? { visitor, setCookie: null } : visitorOf(cookieHeader, cookie, { consent: true });
  const host = hostOf(refererHeader);
  const source = pickKept(found.source);
  try {
    await keepStep(query, stepOf({ visitor: minted.visitor, touch_id: found.id, step: 'click', source: host ? { ...source, referrer_host: host } : source, joined_by: 'touch' }));
  } catch {
    // best effort: the visitor is redirected whether or not the click was kept
  }
  const location = new URL(found.destination);
  for (const [key, value] of Object.entries(source)) location.searchParams.set(key, value);
  location.searchParams.set(settings.touch_param, found.id);
  return { status: 302, location: location.toString(), setCookie: minted.setCookie };
}

/**
 * The beacon a static page posts its own address to (read-data/journey.json beacon): keeps the visit of an address on the
 * site's own origin and answers 204. A foreign origin, an unreadable or oversized body, or a failed write keeps nothing and
 * still answers 204. Without consent the visit keeps its touch id only.
 */
export async function visitBeacon(query, { cookieHeader, body, siteOrigin, refererHeader, cookie = settings.cookie, consent = settings.consent.default } = {}) {
  const none = { status: 204, setCookie: null };
  if (typeof body !== 'string' || Buffer.byteLength(body) > settings.beacon.max_bytes) return none;
  let address;
  try {
    const href = JSON.parse(body).href;
    if (typeof href !== 'string') return none;
    address = new URL(href, siteOrigin);
    if (address.origin !== new URL(siteOrigin).origin) return none;
  } catch {
    return none;
  }
  const minted = visitorOf(cookieHeader, cookie, { consent });
  const step = visitStep({ url: `${address.pathname}${address.search}`, refererHeader, visitor: minted.visitor });
  if (step) {
    try { await keepStep(query, step); } catch {
      // best effort, as the /go/ click
    }
  }
  return { status: 204, setCookie: minted.setCookie };
}

/** The Stripe Checkout Session fields that carry the visitor and the UTM source, within Stripe's limits; invalid characters are dropped. */
export function checkoutAttribution(visitor, source = {}) {
  const limits = settings.stripe;
  const reference = String(visitor ?? '').replace(/[^A-Za-z0-9_-]/g, '').slice(0, limits.client_reference_id.max_length);
  const metadata = {};
  for (const [key, value] of [[limits.visitor_key, visitor], ...Object.entries(pickKept(source))]) {
    if (Object.keys(metadata).length >= limits.metadata.max_keys) break;
    if (key.length > limits.metadata.max_key_length) continue;
    const clean = text(String(value ?? '')).slice(0, limits.metadata.max_value_length);
    if (clean) metadata[key] = clean;
  }
  return {
    ...(REFERENCE.test(reference) ? { client_reference_id: reference } : {}),
    ...(Object.keys(metadata).length ? { metadata } : {}),
  };
}

/** The email made into its key: the identity (tools/content-identity) of lower(trim(email)). The email itself is never kept. */
export function emailKey(email) {
  const clean = text(email).toLowerCase();
  return clean ? makeHashCodeHexFromBytes(new TextEncoder().encode(clean)) : null;
}

/**
 * The booking step from the /booked route, given the redirect's query as params: the TidyCal names in journey.json. The
 * ref is the provider's booking key when the template sends it, else the email's key with the start time. Null when there
 * is neither an email nor a visitor to keep the booking against.
 */
export function bookedStep({ params = {}, visitor = null }) {
  const names = settings.tidycal;
  const email_key = emailKey(params[names.email]);
  if (!email_key && !visitor) return null;
  const starts = text(params[names.starts]);
  const touchId = text(params[settings.touch_param]) || null;
  const providerKey = text(params[names.booking_key]);
  return stepOf({
    visitor,
    touch_id: touchId,
    step: 'booking',
    ref: providerKey || (email_key && starts ? `${email_key}:${starts}` : null),
    joined_by: touchId ? 'touch' : visitor ? 'cookie' : 'email',
    email_key,
    offer_id: text(params[names.type]) || null,
  });
}

/**
 * The booking step of a kept booking row ({ id, booker_email, starts_at, booking_type, status, offer_id? }): no visitor, its
 * email as the key, so the funnel joins it to the visitor whose lead step carried that email. A cancelled booking keeps no
 * step (null): the journey is written only for bookings that stand.
 */
export function bookingStepOf(row) {
  if (!row || text(row.status).toLowerCase() === 'cancelled') return null;
  return stepOf({
    step: 'booking',
    ref: text(row.id) || null,
    joined_by: 'email',
    email_key: emailKey(row.booker_email),
    offer_id: text(row.offer_id ?? row.booking_type) || null,
  });
}

/**
 * The lead step of a visitor who gave their email on the site (the "Book a call" card asks for it before the TidyCal
 * redirect). Keeps the email's key and the source's self-reported answer; the raw email and the name are never kept.
 */
export function leadStep({ visitor = null, email, offer_id = null, source = {}, self_reported = null }) {
  const email_key = emailKey(email);
  if (!email_key) throw new TypeError('A lead needs an email.');
  const kept = pickKept(source);
  const self = text(self_reported);
  return stepOf({
    visitor,
    step: 'lead',
    source: self ? { ...kept, self_reported: self } : kept,
    joined_by: visitor ? 'cookie' : 'email',
    email_key,
    offer_id: text(offer_id) || null,
  });
}

/**
 * The sale step from a paid Stripe Checkout Session: the visitor from client_reference_id (else the metadata's visitor),
 * the email's key from the customer's email, the offer from the metadata, the amount in the currency's minor units.
 * Its ref is the session id, so a webhook delivered twice keeps one sale.
 */
export function saleStepOf(session) {
  const limits = settings.stripe;
  const metadata = session?.metadata ?? {};
  const visitor = text(session?.client_reference_id) || text(metadata[limits.visitor_key]) || null;
  const email_key = emailKey(session?.customer_details?.email ?? session?.customer_email);
  return stepOf({
    visitor,
    step: 'sale',
    ref: text(session?.id) || null,
    joined_by: visitor ? 'client_reference_id' : email_key ? 'email' : null,
    email_key,
    offer_id: text(metadata[limits.offer_key]) || null,
    value_cents: Number.isInteger(session?.amount_total) ? session.amount_total : null,
  });
}

/**
 * A tracked link's touch row (what tool:run-sql-in-my-database writes to journey_touches) and the short /go/ link that
 * sends a visitor through it. Only the UTM fields and bf_project of `source` are kept on the row.
 */
export function makeTouch({ destination, source = {}, post_id = null, offer_id = null, base }) {
  webUrl(destination, 'The destination must be a web URL without account details.');
  const origin = webUrl(base, 'The site address must be a web URL.').origin;
  const id = randomBytes(SHORT_ID_BYTES).toString('base64url');
  return {
    row: { id, destination: text(destination), source: pickKept(source), post_id, offer_id },
    short_link: `${origin}/go/${id}`,
  };
}
