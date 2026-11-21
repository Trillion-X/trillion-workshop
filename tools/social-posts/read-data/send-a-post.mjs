// tools/social-posts/read-data/send-a-post.mjs
//
// Purpose: send one of the person's posts to one of its destinations, once its time has come, through the publisher
// of that place (@opencoredev/social-sdk, MIT, or a publisher shaped like one), and answer the outcome as the post to keep
// (`keep`; the post and the destination's connection are handed in as `records`, and the run stores nothing). A place's row (read-data/post-places.json) says which publisher, how its options are filled and which hosts
// a held value may go to; the destination is one of the person's connection records. One tool row (tool:send-a-post) sends to every place, and its input `place` (the place's slug) chooses the
// variant of the row that names that place's connection kind, held fields and renewal (place-variants.mjs makes them
// from the place rows): the engine hands this run that connection's held values on descriptors 4, 5, ... in the order the place's options name them (`heldFields`), and
// the run's input names which of the person's accounts of that kind (`account_id`).
//
// Non-Negotiable Invariants:
//   1. Only an approved or scheduled post whose time has come is sent, only to a destination it names, and only the
//      approved content.
//   2. A held value reaches a publisher only as a one-use stand-in. The fetch the publisher is handed puts the real
//      value in its place as the request leaves, only for the place's own hosts, and never follows a redirect while
//      carrying one. A stand-in found on any other host refuses the request before anything is sent.
//   3. A destination the post carries as "not known" is never sent again by itself: it is resent only when the
//      caller names it (resend: true) after looking at the place. Every send hands the place an idempotency key made
//      from the post, the account and the attempt, so a send repeated after a cut-off run is one request to the place.
//   4. A destination that already took the post is never sent it again.
//   5. Nothing here names a place, a vendor or a person.
//   6. A post's file comes only from the person's own files, as the address the caller gives: a place is handed a share of it
//      (a signed link that expires) or its bytes streamed a page at a time. No copy of the file is kept here.
//   7. A post goes at its time only through a timed run of workflow:send-each-post-at-its-time, which hands this tool the
//      armed_at the post was set with: a post taken back, changed or set again sends nothing at the old time.
//
import { createHmac } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { SocialError, connectedAccountRef, createSocial } from '@opencoredev/social-sdk';
import { instagram } from '@opencoredev/social-sdk/instagram';
import { linkedin } from '@opencoredev/social-sdk/linkedin';
import { threads } from '@opencoredev/social-sdk/threads';
import { tiktok } from '@opencoredev/social-sdk/tiktok';
import { x } from '@opencoredev/social-sdk/x';
import { youtube } from '@opencoredev/social-sdk/youtube';
import settings from './posts.json' with { type: 'json' };
import placeRows from './post-places.json' with { type: 'json' };
import { heldFields, isHeld, wordsOf } from './posts.mjs';
import { facebookPage } from './publisher-facebook-page.mjs';
import { requests } from './publisher-requests.mjs';
import { substack } from './publisher-substack.mjs';
import { reachesSomeone, shaped } from './post-shape.mjs';
import { slugOf } from './place-variants.mjs';
import { keepRows, recordsIn, valueAt, withKept } from './records-in.mjs';
import { formatOf, publishByFormat } from './publish-by-format.mjs';

// The publishers this tool carries, bound by the names place rows use (`adapter`). A place whose adapter is not here
// is refused in plain words.
export const PUBLISHERS = { 'facebook-page': facebookPage, instagram, linkedin, requests, substack, threads, tiktok, x, youtube };
const FIRST_HELD_DESCRIPTOR = 4;
const TYPE = settings.record_type;
const PLACES = placeRows.places;
const object = value => Boolean(value) && typeof value === 'object' && !Array.isArray(value);
const fillWords = (words, values) => words.replace(/\{(\w+)\}/g, (_, key) => values[key] ?? '');

class Refused extends Error {}
// A refusal made here, wherever a publisher wrapped it.
const ours = error => { for (let at = error, depth = 0; at && depth < 6; at = at.cause, depth += 1) if (at instanceof Refused) return at; return null; };

/** The held values the engine handed this run, by field: descriptor 4 onwards, in the order the place names them.
 *  A descriptor is read to its end once, so each value is read the first time a request needs it and kept only in this
 *  run's memory for its later requests (a place that signs several requests); it is never written anywhere. */
export function heldFromDescriptors(place, read = descriptor => readFileSync(descriptor, 'utf8')) {
  const fields = heldFields(place.options);
  const kept = new Map();
  return field => {
    const at = fields.indexOf(field);
    if (at < 0) throw new Refused(`${place.label} does not sign with a ${field.replace(/_/g, ' ')}.`);
    if (!kept.has(field)) kept.set(field, read(FIRST_HELD_DESCRIPTOR + at).trim());
    const value = kept.get(field);
    if (!value) throw new Refused(`Your ${place.label} connection holds no ${field.replace(/_/g, ' ')}. Connect ${place.label} again.`);
    return value;
  };
}

// A value made from a held one as the request leaves, by its place row's `sign` (`{held, sign}`), so the held value
// itself never goes anywhere. One kind: `jwt-hs256`, a token signed with HMAC-SHA256 from a held value written
// `<key id>:<hex secret>`, with the row's claims, issued now and good for the row's seconds.
const SIGNERS = {
  'jwt-hs256': (value, sign) => {
    const [keyId, secretHex] = value.split(':');
    if (!keyId || !/^[0-9a-f]+$/i.test(secretHex ?? '')) throw new Refused('A held key that signs a token is written as its id and its secret, joined by a colon. Connect the place again.');
    const now = Math.floor(Date.now() / 1000);
    const part = fields => Buffer.from(JSON.stringify(fields)).toString('base64url');
    const unsigned = `${part({ alg: 'HS256', typ: 'JWT', kid: keyId })}.${part({ iat: now, exp: now + sign.seconds, ...sign.claims })}`;
    return `${unsigned}.${createHmac('sha256', Buffer.from(secretHex, 'hex')).update(unsigned).digest('base64url')}`;
  },
};
function signed(value, sign) {
  const signer = SIGNERS[sign.kind];
  if (!signer) throw new Refused(`This tool cannot make a ${sign.kind} from a held value.`);
  return signer(value, sign);
}

// The fetch a publisher is handed: each stand-in in the address, a header or a text body becomes the person's value
// as the request leaves, and only for the place's own hosts. What it refuses is refused before the request leaves, as
// the publishers' own error that is never sent again (invalid_input), so no publisher takes it for a cut-off send.
const refusedBeforeSending = message => new SocialError({ code: 'invalid_input', operation: 'held-fetch', message, retryDisposition: { kind: 'never' } });
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
      if (!hosts.includes(host)) throw refusedBeforeSending(`A connection's key goes only to ${hosts.join(', ')}, so nothing was sent to ${host}.`);
      for (const mark of seen) {
        let value;
        try { value = standIns.get(mark)(); } catch (error) { throw refusedBeforeSending(error.message); }
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
const leaf = value => isHeld(value) || (object(value) && ['plain', 'service_origin', 'value'].some(key => key in value) && Object.keys(value).length === 1);
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
    return standIn(template.held, template.sign);
  }
  return Object.fromEntries(Object.entries(template).map(([key, item]) => [key, filled(item, { plain, standIn, label })]));
}

/** A publisher for one connection: its options filled, its fetch holding the person's values. */
export function publisherFor(place, connection, { held, send = fetch, publishers = PUBLISHERS }) {
  const plain = object(connection.plain) ? connection.plain : {};
  const standIns = new Map();
  const standIn = (field, sign) => {
    const mark = `held-${crypto.randomUUID().replace(/-/g, '')}`;
    standIns.set(mark, () => (sign ? signed(held(field), sign) : held(field)));
    return mark;
  };
  const options = filled(place.options, { plain, standIn, label: place.label });
  const readable = template => filled(template, { plain, standIn: () => { throw new Refused(`${place.label}'s account and hosts are named by readable fields, never held ones.`); }, label: place.label });
  const accountId = readable(place.account);
  const hosts = place.hosts.map(item => (typeof item === 'string' ? item : URL.canParse(readable(item)) ? new URL(readable(item)).hostname : null)).filter(Boolean);
  const make = publishers[place.adapter];
  if (typeof make !== 'function') throw new Refused(`This tool cannot post to ${place.label} yet.`);
  const publisherOptions = { ...options, fetch: heldFetch({ standIns, hosts, send }) };
  const publisher = make(publisherOptions);
  return { social: createSocial({ backend: publisher }), account: connectedAccountRef({ backend: 'default', platform: place.platform, accountId }), options: publisherOptions };
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

// What the place is given of the post's file: the address the caller made of it where the person keeps it (media_url,
// a share such as a signed link, which ranges). A place that fetches from an address is handed that address; a place
// that takes the bytes is streamed them from it as they arrive, so no copy of the file is ever kept here. No address,
// an address that answers that the file is gone, or one that cannot answer, refuses the send before anything leaves.
async function mediaFor(post, place, mediaUrl, fetchMedia) {
  if (!post.media) return null;
  const said = (key, values = {}) => new Refused(fillWords(settings.media.words[key], { platform: place.label, ...values }));
  if (!/^https:\/\//.test(mediaUrl ?? '')) throw said('no_address');
  const mediaType = post.media.media_type ?? 'application/octet-stream';
  const kind = mediaType.startsWith('image/') ? 'image' : mediaType.startsWith('video/') ? 'video' : 'document';
  if (place.media_from === 'stream' || place.media_from === 'whole') {
    let answer;
    try { answer = await fetchMedia(mediaUrl); } catch (error) { throw said('unreachable', { code: error?.code ?? error?.name ?? 'refused' }); }
    if (answer.status === 404 || answer.status === 410) throw said('gone');
    if (!answer.ok || !answer.body) throw said('unreachable', { code: String(answer.status) });
    const size = Number(answer.headers.get('content-length') ?? post.media.byte_length);
    const facts = { kind, mimeType: answer.headers.get('content-type') ?? mediaType, byteSize: size, ...(post.media.name ? { filename: post.media.name.split('/').pop() } : {}) };
    // The first open streams the answer already asked for; a later open (a place's uploader starting over) asks again.
    let fresh = answer.body;
    const again = () => {
      let reader;
      return new ReadableStream({
        async pull(controller) {
          if (!reader) {
            const asked = await fetchMedia(mediaUrl).catch(() => null);
            if (!asked?.ok || !asked.body) return controller.error(said('unreachable', { code: String(asked?.status ?? 'refused') }));
            reader = asked.body.getReader();
          }
          const { done, value } = await reader.read();
          if (done) controller.close(); else controller.enqueue(value);
        },
      });
    };
    const open = () => { const body = fresh ?? again(); fresh = null; return body; };
    if (place.media_from === 'stream') return { ...facts, source: { kind: 'stream', open, fingerprint: post.media.identity } };
    // A place whose uploader takes the file only as one piece is handed it whole, read through the same stream.
    const blob = await answer.blob();
    return { ...facts, source: { kind: 'blob', blob: new Blob([blob], { type: facts.mimeType }), fingerprint: post.media.identity } };
  }
  return { kind, mimeType: mediaType, byteSize: post.media.byte_length, source: { kind: 'https-url', url: mediaUrl } };
}

/** tool:send-a-post: sends the post to one destination once its time has come, and answers the outcome as the post to keep.
 *  The post and the destination's connection are handed in as `records`; the run stores nothing and answers the post as it
 *  ends under `keep`. Given armed_at (the timed run of workflow:send-each-post-at-its-time gives it), it sends nothing once the
 *  post no longer carries it. */
export async function sendAPost(input = {}, { now = () => new Date(), send = fetch, fetchMedia = fetch, held = null, publishers = PUBLISHERS } = {}) {
  const { post_id: postId, place: placeSlug, account_id: accountId, resend = false, armed_at: armedAt, media_url: mediaUrl } = input;
  if (typeof postId !== 'string' || !postId.trim() || typeof accountId !== 'string' || !accountId.trim()) throw new Error('Give post_id and account_id (one of the post\'s destinations).');
  if (typeof placeSlug !== 'string' || !placeSlug.trim()) throw new Error('Give place (the slug of the place account_id belongs to).');
  const { records, kept } = recordsIn(input);
  let post = valueAt(records, TYPE, postId.trim());
  if (!post) throw new Error(`There is no post ${postId.trim()} among the records handed in, so nothing was sent.`);
  if (armedAt !== undefined && (post.armed_at !== armedAt || !settings.at_its_time.sends_while.includes(post.status))) {
    return { post_id: post.post_id, status: post.status, said: settings.at_its_time.words.no_longer_set };
  }
  if (!['approved', 'scheduled', 'partial', 'failed', 'posted'].includes(post.status)) throw new Error(`${post.post_id} is ${post.status}. Only an approved post is sent.`);
  if (!post.approved_at) throw new Error(`${post.post_id} was never approved, so nothing was sent.`);
  if (reachesSomeone(post) && post.approved_by_person !== true) throw new Error(`${post.post_id} reaches someone and the person never approved it, so nothing was sent.`);
  if (!(post.destinations ?? []).includes(accountId)) throw new Error(`${accountId} is not one of ${post.post_id}'s destinations.`);
  const deliveries = { ...(post.deliveries ?? {}) };
  const earlier = deliveries[accountId] ?? {};
  const state = earlier.status ?? 'not sent';
  if (!(settings.resend_states.includes(state) || (state === 'not known' && resend === true))) {
    return { post_id: post.post_id, status: post.status, post: shaped(post), said: state === 'posted' ? 'This destination already has the post.' : state === 'not known' ? fillWords(settings.not_known_words, { platform: earlier.label ?? accountId }) : 'This destination is already taking the post.' };
  }
  const connection = valueAt(records, settings.connection_type, `${settings.connection_prefix}${encodeURIComponent(accountId)}`);
  if (!connection) throw new Error(`${accountId} has no connection record among the records handed in, so nothing was sent.`);
  const place = PLACES.find(item => item.connection_vendor === connection.vendor) ?? null;
  if (!place) throw new Error(`${accountId} is a ${connection.vendor} connection, and no place takes that, so nothing was sent.`);
  if (slugOf(place) !== placeSlug.trim()) throw new Error(`${accountId} belongs to ${slugOf(place)}, not ${placeSlug.trim()}. Nothing was sent.`);
  // A time still ahead: a place that takes the time itself gets the post now, with it (its own run publishes it then); any other place waits for its time.
  const ahead = Boolean(post.scheduled_for) && Date.parse(post.scheduled_for) > now().getTime();
  if (ahead && !place.platform_time) return { post_id: post.post_id, status: post.status, post: shaped(post), said: `Its time has not come: it goes out at ${post.scheduled_for}. Nothing was sent.` };
  const schedule = ahead ? { at: post.scheduled_for } : undefined;
  // The post as it ends, written to the rows this run keeps for the caller to store.
  const settle = () => {
    const at = now().toISOString();
    const next = { ...post, sent_at: post.sent_at ?? at, deliveries: { ...deliveries }, updated_at: at };
    post = { ...next, status: overall(next) };
    return [{ id: post.post_id, type: TYPE, value: post }];
  };
  // The attempt moves on after each send, so a later retry is a new request to the place.
  const attempt = (earlier.attempt ?? 0) + (earlier.status && earlier.status !== 'not sent' ? 1 : 0);
  try {
    const { social, account, options } = publisherFor(place, connection, { held: held ?? heldFromDescriptors(place), send, publishers });
    const media = await mediaFor(post, place, mediaUrl, fetchMedia);
    const byFormat = formatOf(post.format);
    if (byFormat && byFormat.platform !== place.platform) throw new Refused(`${byFormat.label} posts go to ${byFormat.platform}, not ${place.label}. Nothing was sent.`);
    const chosen = { ...(place.default_settings ?? {}), ...(post.settings_by_platform?.[place.platform] ?? {}) };
    // Until the place answers, the outcome is not known: a send that is cut off answers nothing, and the caller's post
    // still says what it said.
    deliveries[accountId] = { platform: place.platform, label: place.label, status: 'not known', attempt, error: fillWords(settings.not_known_words, { platform: place.label }) };
    const outcome = byFormat
      ? await publishByFormat({ format: post.format, options, accountId, mediaUrl, mediaKind: String(post.media?.media_type ?? '').startsWith('image/') ? 'image' : 'video', caption: wordsOf(post, place, accountId), send: options.fetch })
      : (await social.posts.publish({
        targets: [{ account, ...(Object.keys(chosen).length ? { options: chosen } : {}) }],
        ...(schedule ? { schedule } : {}),
        content: { text: wordsOf(post, place, accountId), ...(media ? { media: [media] } : {}) },
        idempotencyKey: `${post.post_id}:${accountId}:${attempt}`,
      })).outcomes?.[0];
    deliveries[accountId] = fromOutcome(place, outcome, attempt);
  } catch (error) {
    // Refused here before anything left: it failed. Anything else after the send began may have reached the place, so
    // it stays not known (invariant 3).
    const refusedHere = ours(error);
    const beforeSending = deliveries[accountId]?.status !== 'not known' || refusedHere || error?.issues?.length || error?.retryDisposition?.kind === 'never';
    if (beforeSending) deliveries[accountId] = { platform: place.platform, label: place.label, status: 'failed', attempt, error: refusedHere?.message ?? wordsFor(place, { code: error?.code, message: error?.issues?.map(issue => issue.message).join(' ') || error?.message, retry: error?.retryDisposition?.kind }) };
  }
  keepRows(kept, settle());
  const shown = shaped(post);
  const mine = shown.destinations.find(item => item.account_id === accountId);
  return withKept({ post_id: post.post_id, status: post.status, post: shown, said: mine.status === 'posted' ? `Posted to ${place.label}.` : mine.error ?? `${place.label}: ${mine.status}.` }, kept);
}
