// tools/social-posts/read-data/send-a-post.mjs
//
// Purpose: send one of the person's posts to one of its destinations, once its time has come, through the publisher
// of that place (@opencoredev/social-sdk, MIT, or a publisher shaped like one), and keep the outcome on the post
// record. A place's row (read-data/post-places.json) says which publisher, how its options are filled and which hosts
// a held value may go to; the destination is one of the person's connection records. Each place has its own tool row
// (tool:send-a-post-to-<place>), because each place signs with its own held fields: the engine hands this run that
// connection's held values on descriptors 4, 5, ... in the order the place's options name them (`heldFields`), and
// the run's input names which of the person's accounts of that kind (`account_id`).
//
// Non-Negotiable Invariants:
//   1. Only an approved or scheduled post whose time has come is sent, only to a destination it names, and only the
//      approved content.
//   2. A held value reaches a publisher only as a one-use stand-in. The fetch the publisher is handed puts the real
//      value in its place as the request leaves, only for the place's own hosts, and never follows a redirect while
//      carrying one. A stand-in found on any other host refuses the request before anything is sent.
//   3. A destination is marked "not known" before the send begins, so a send that is cut off is never sent again by
//      itself: it is resent only when the caller names it (resend: true) after looking at the place.
//   4. A destination that already took the post is never sent it again.
//   5. Nothing here names a place, a vendor or a person.
//
import { readFileSync } from 'node:fs';
import { connectedAccountRef, createSocial } from '@opencoredev/social-sdk';
import { instagram } from '@opencoredev/social-sdk/instagram';
import { linkedin } from '@opencoredev/social-sdk/linkedin';
import { threads } from '@opencoredev/social-sdk/threads';
import { tiktok } from '@opencoredev/social-sdk/tiktok';
import { x } from '@opencoredev/social-sdk/x';
import { youtube } from '@opencoredev/social-sdk/youtube';
import settings from './posts.json' with { type: 'json' };
import placeRows from './post-places.json' with { type: 'json' };
import { heldFields, wordsOf } from './posts.mjs';
import { facebookPage } from './publisher-facebook-page.mjs';
import { substack } from './publisher-substack.mjs';
import { shaped } from './post-shape.mjs';

// The publishers this tool carries, bound by the names place rows use (`adapter`). A place whose adapter is not here
// is refused in plain words.
export const PUBLISHERS = { 'facebook-page': facebookPage, instagram, linkedin, substack, threads, tiktok, x, youtube };
const FIRST_HELD_DESCRIPTOR = 4;
const TYPE = settings.record_type;
const PLACES = placeRows.places;
const object = value => Boolean(value) && typeof value === 'object' && !Array.isArray(value);
const fillWords = (words, values) => words.replace(/\{(\w+)\}/g, (_, key) => values[key] ?? '');

class Refused extends Error {}
// A refusal made here, wherever a publisher wrapped it.
const ours = error => { for (let at = error, depth = 0; at && depth < 6; at = at.cause, depth += 1) if (at instanceof Refused) return at; return null; };

/** The held values the engine handed this run, by field: descriptor 4 onwards, in the order the place names them. */
export function heldFromDescriptors(place) {
  const fields = heldFields(place.options);
  return field => {
    const at = fields.indexOf(field);
    if (at < 0) throw new Refused(`${place.label} does not sign with a ${field.replace(/_/g, ' ')}.`);
    const value = readFileSync(FIRST_HELD_DESCRIPTOR + at, 'utf8').trim();
    if (!value) throw new Refused(`Your ${place.label} connection holds no ${field.replace(/_/g, ' ')}. Connect ${place.label} again.`);
    return value;
  };
}

// The fetch a publisher is handed: each stand-in in the address, a header or a text body becomes the person's value
// as the request leaves, and only for the place's own hosts.
export function heldFetch({ standIns, hosts, send = fetch }) {
  return async (input, init = {}) => {
    const source = input instanceof Request ? input : null;
    let url = String(source ? source.url : input);
    const headers = new Headers(init.headers ?? source?.headers ?? undefined);
    let body = init.body !== undefined ? init.body : source?.body ?? undefined;
    if (body instanceof URLSearchParams) body = body.toString();
    const seen = [...standIns.keys()].filter(mark => url.includes(mark) || [...headers.values()].some(value => value.includes(mark)) || (typeof body === 'string' && body.includes(mark)));
    if (seen.length) {
      const host = new URL(url).hostname;
      if (!hosts.includes(host)) throw new Refused(`A connection's key goes only to ${hosts.join(', ')}, so nothing was sent to ${host}.`);
      for (const mark of seen) {
        const value = standIns.get(mark)();
        url = url.split(mark).join(encodeURIComponent(value));
        for (const [name, current] of [...headers]) if (current.includes(mark)) headers.set(name, current.split(mark).join(value));
        if (typeof body === 'string') body = body.split(mark).join(value);
      }
    }
    const streamed = body instanceof ReadableStream;
    return send(url, { method: init.method ?? source?.method ?? 'GET', headers, ...(body !== undefined && body !== null ? { body } : {}), ...(streamed ? { duplex: 'half' } : {}), ...(init.signal ?? source?.signal ? { signal: init.signal ?? source.signal } : {}), redirect: seen.length ? 'manual' : init.redirect ?? source?.redirect ?? 'follow' });
  };
}

// One value of a publisher's options, from where its place row says it comes.
const leaf = value => object(value) && ['held', 'plain', 'service_origin', 'value'].some(key => key in value) && Object.keys(value).length === 1;
function filled(template, { plain, standIn, label }) {
  if (Array.isArray(template)) return template.map(item => filled(item, { plain, standIn, label }));
  if (!object(template)) return template;
  if (leaf(template)) {
    if ('value' in template) return template.value;
    if (template.service_origin) throw new Refused(`${label} needs a public address of the person's own service, which this run does not have.`);
    if ('plain' in template) {
      const found = plain[template.plain];
      if (typeof found !== 'string' || !found) throw new Refused(`Your ${label} connection does not say its ${template.plain.replace(/_/g, ' ')}, so nothing can be posted there. Connect ${label} again.`);
      return found;
    }
    return standIn(template.held);
  }
  return Object.fromEntries(Object.entries(template).map(([key, item]) => [key, filled(item, { plain, standIn, label })]));
}

/** A publisher for one connection: its options filled, its fetch holding the person's values. */
export function publisherFor(place, connection, { held, send = fetch, publishers = PUBLISHERS }) {
  const plain = object(connection.plain) ? connection.plain : {};
  const standIns = new Map();
  const standIn = field => {
    const mark = `held-${crypto.randomUUID().replace(/-/g, '')}`;
    standIns.set(mark, () => held(field));
    return mark;
  };
  const options = filled(place.options, { plain, standIn, label: place.label });
  const readable = template => filled(template, { plain, standIn: () => { throw new Refused(`${place.label}'s account and hosts are named by readable fields, never held ones.`); }, label: place.label });
  const accountId = readable(place.account);
  const hosts = place.hosts.map(item => (typeof item === 'string' ? item : URL.canParse(readable(item)) ? new URL(readable(item)).hostname : null)).filter(Boolean);
  const make = publishers[place.adapter];
  if (typeof make !== 'function') throw new Refused(`This tool cannot post to ${place.label} yet.`);
  const publisher = make({ ...options, fetch: heldFetch({ standIns, hosts, send }) });
  return { social: createSocial({ backend: publisher }), account: connectedAccountRef({ backend: 'default', platform: place.platform, accountId }) };
}

// The words for a failed or unknown destination.
function wordsFor(place, { code = '', message = '', retry = null }) {
  const detail = String(message || code || 'it gave no reason').slice(0, 300);
  const lower = `${code} ${message}`.toLowerCase();
  const row = settings.outcome_words.find(item => (item.retry && item.retry === retry) || (item.contains_any ?? []).some(word => lower.includes(word)));
  return fillWords(row?.says ?? settings.outcome_fallback, { platform: place.label, detail });
}
function fromOutcome(place, outcome, attempt) {
  const status = settings.outcome_states[outcome?.state] ?? 'not known';
  const detail = outcome?.message ?? outcome?.diagnostic ?? ((outcome?.issues ?? []).map(issue => issue.message).join(' ') || outcome?.reason);
  return {
    platform: place.platform, label: place.label, status, attempt,
    ...(outcome?.url ? { url: String(outcome.url) } : {}),
    ...(outcome?.post?.postId ? { platform_post_id: String(outcome.post.postId) } : {}),
    ...(outcome?.delivery ? { delivery_ref: outcome.delivery } : outcome?.job ? { delivery_ref: outcome.job } : {}),
    ...(status === 'failed' ? { error: wordsFor(place, { code: outcome?.code ?? outcome?.reason, message: detail, retry: outcome?.retryDisposition?.kind }) } : {}),
    ...(status === 'not known' ? { error: fillWords(settings.not_known_words, { platform: place.label }) } : {}),
  };
}

// The overall state of a post from the state of each destination.
function overall(post) {
  const states = post.destinations.map(id => post.deliveries?.[id]?.status ?? 'not sent');
  if (states.every(state => state === 'posted')) return 'posted';
  if (states.every(state => state === 'failed')) return 'failed';
  if (states.some(state => state === 'failed' || state === 'not known')) return 'partial';
  return 'scheduled';
}

// What the place is given of the post's file. This run reads no file bytes and makes no public address for one, so a
// post with a file is refused here until the person's files hand the run one.
function mediaFor(post, place) {
  if (!post.media) return null;
  throw new Refused(place.media_from === 'bytes'
    ? `${place.label} takes the file's bytes, and this run cannot read the person's files yet, so nothing was sent.`
    : `${place.label} fetches the file from a public address, and this run cannot make one for the person's file yet, so nothing was sent.`);
}

/** tool:send-a-post-to-<place>: sends the post to one destination once its time has come, and keeps the outcome. */
export async function sendAPost({ post_id: postId, account_id: accountId, resend = false } = {}, { door, now = () => new Date(), send = fetch, held = null, publishers = PUBLISHERS }) {
  if (typeof postId !== 'string' || !postId.trim() || typeof accountId !== 'string' || !accountId.trim()) throw new Error('Give post_id and account_id (one of the post\'s destinations).');
  let post = await door.read(TYPE, postId.trim());
  if (!post) throw new Error(`There is no post ${postId}.`);
  if (!['approved', 'scheduled', 'partial', 'failed', 'posted'].includes(post.status)) throw new Error(`${post.post_id} is ${post.status}. Only an approved post is sent.`);
  if (!post.approved_at) throw new Error(`${post.post_id} was never approved, so nothing was sent.`);
  if (post.scheduled_for && Date.parse(post.scheduled_for) > now().getTime()) return { post_id: post.post_id, status: post.status, post: shaped(post), said: `Its time has not come: it goes out at ${post.scheduled_for}. Nothing was sent.` };
  if (!(post.destinations ?? []).includes(accountId)) throw new Error(`${accountId} is not one of ${post.post_id}'s destinations.`);
  const deliveries = { ...(post.deliveries ?? {}) };
  const earlier = deliveries[accountId] ?? {};
  const state = earlier.status ?? 'not sent';
  if (!(settings.resend_states.includes(state) || (state === 'not known' && resend === true))) {
    return { post_id: post.post_id, status: post.status, post: shaped(post), said: state === 'posted' ? 'This destination already has the post.' : state === 'not known' ? fillWords(settings.not_known_words, { platform: earlier.label ?? accountId }) : 'This destination is already taking the post.' };
  }
  const connection = await door.read(settings.connection_type, `${settings.connection_prefix}${encodeURIComponent(accountId)}`);
  const place = connection ? PLACES.find(item => item.connection_vendor === connection.vendor) ?? null : null;
  const keep = async verb => {
    const at = now().toISOString();
    const next = { ...post, sent_at: post.sent_at ?? at, deliveries: { ...deliveries }, updated_at: at };
    post = { ...next, status: overall(next) };
    await door.write([{ id: post.post_id, type: TYPE, value: post }], { key: `${verb}:${post.post_id}:${accountId}:${at}` });
  };
  // The attempt moves on after each send, so a later retry is a new request to the place.
  const attempt = (earlier.attempt ?? 0) + (earlier.status && earlier.status !== 'not sent' ? 1 : 0);
  if (!place) {
    deliveries[accountId] = { ...earlier, status: 'failed', attempt, error: 'That account is no longer connected. Connect it again, then send again.' };
    await keep('send-failed');
    return { post_id: post.post_id, status: post.status, post: shaped(post), said: deliveries[accountId].error };
  }
  try {
    const { social, account } = publisherFor(place, connection, { held: held ?? heldFromDescriptors(place), send, publishers });
    const media = mediaFor(post, place);
    const chosen = { ...(place.default_settings ?? {}), ...(post.settings_by_platform?.[place.platform] ?? {}) };
    // Recorded before the send: if the send is cut off, its outcome is not known and it is not resent by itself.
    deliveries[accountId] = { platform: place.platform, label: place.label, status: 'not known', attempt, error: fillWords(settings.not_known_words, { platform: place.label }) };
    await keep('send-begun');
    const result = await social.posts.publish({
      targets: [{ account, ...(Object.keys(chosen).length ? { options: chosen } : {}) }],
      content: { text: wordsOf(post, place, accountId), ...(media ? { media: [media] } : {}) },
      idempotencyKey: `${post.post_id}:${accountId}:${attempt}`,
    });
    deliveries[accountId] = fromOutcome(place, result.outcomes?.[0], attempt);
  } catch (error) {
    // Refused here before anything left: it failed. Anything else after the send began may have reached the place, so
    // it stays not known (invariant 3).
    const refusedHere = ours(error);
    const beforeSending = deliveries[accountId]?.status !== 'not known' || refusedHere || error?.issues?.length || error?.retryDisposition?.kind === 'never';
    if (beforeSending) deliveries[accountId] = { platform: place.platform, label: place.label, status: 'failed', attempt, error: refusedHere?.message ?? wordsFor(place, { code: error?.code, message: error?.message, retry: error?.retryDisposition?.kind }) };
  }
  await keep('send-done');
  const shown = shaped(post);
  const mine = shown.destinations.find(item => item.account_id === accountId);
  return { post_id: post.post_id, status: post.status, post: shown, said: mine.status === 'posted' ? `Posted to ${place.label}.` : mine.error ?? `${place.label}: ${mine.status}.` };
}
