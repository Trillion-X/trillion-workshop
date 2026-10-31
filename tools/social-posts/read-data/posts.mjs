// tools/social-posts/read-data/posts.mjs
//
// Purpose: a person's posts to the places they publish, kept in their own `post` records: drafted, checked for each
// place, approved, and set to go at their time, through the run's records door (tools/records-door). The places are
// rows (read-data/post-places.json) and the person's accounts are their own `connection` records, each naming its
// connection id: the handle the engine reads that account's held values by. No value a place needs to sign a request
// is ever in a record or in this code.
//
//   listPostDestinations {}                          the person's accounts a post can go to, and each place with none
//   draftAPost { post_id?, caption?, media?, ... }   keeps a draft (changing an approved or scheduled post makes it a
//                                                    draft again)
//   checkAPost { post_id }                           whether the post is ready for each place it is going
//   approveAPost { post_id, expected_values }        approves exactly the reviewed post
//   setAPostToGoAtItsTime { post_id }                an approved post with a time still ahead, ready everywhere, is
//                                                    scheduled: it waits for its time and nothing is sent now
//   takeBackAPost { post_id }                        a scheduled post nothing was sent for is a draft again
//
// Non-Negotiable Invariants:
//   1. Nothing here names a place, a vendor, a person or a kind of content. A place is a row; an account is a
//      connection record of the vendor its place row names.
//   2. Nothing here sends a post anywhere. Setting a post for its time only marks it scheduled; sending is its own
//      tool, run at the post's time.
//   3. A post is approved only as it was reviewed (expected_values), and changing anything that goes out makes it a
//      draft again, so a scheduled post that changed sends nothing until it is approved and set again.
//   4. Approval compares the complete reviewed values with the current post; the records door enforces each row's
//      granted read and write rights.
//   5. A check never claims what it did not check: a file this run cannot see is reported as not checked.
//
// Key Concepts: a post record { post_id, status, caption, media ({ identity, name?, media_type?, byte_length?,
//   facts? }), caption_by_platform, settings_by_platform, destinations[] (connection ids), link, scheduled_for,
//   time_zone, source?, format_id?, reaches?, deliveries?, created_at, updated_at, approved_at?, approved_by?,
//   armed_at? }. status is draft, approved, scheduled, posted, failed or partial. A connection record
//   { connection_id, vendor, service?, account_label?, plain: { field: text }, held: [field], can_send? }.
//
import settings from './posts.json' with { type: 'json' };
import placeRows from './post-places.json' with { type: 'json' };
import { mediaFacts, readyFor, readyOverall } from './post-ready.mjs';
import { APPROVAL_FIELDS, changeable, contentOf, shaped } from './post-shape.mjs';

const TYPE = settings.record_type;
const PLACES = placeRows.places;
const object = value => Boolean(value) && typeof value === 'object' && !Array.isArray(value);
const text = (value, max) => (typeof value === 'string' && value.trim() ? value.trim().slice(0, max) : null);
const fillWords = (words, values) => words.replace(/\{(\w+)\}/g, (_, key) => values[key] ?? '');
const completeApprovalValues = value => object(value) && Object.keys(value).length === APPROVAL_FIELDS.length
  && APPROVAL_FIELDS.every(field => Object.hasOwn(value, field));
function requireCurrentReview(expected, post) {
  if (!completeApprovalValues(expected)) throw new Error('Give the complete approval_values from the review as expected_values.');
  if (contentOf(expected) !== contentOf(post)) throw new Error('The post changed after it was reviewed. Read and review its current approval_values before continuing.');
}
function sameReviewExceptSchedule(expected, post) {
  return completeApprovalValues(expected) && contentOf({ ...expected, scheduled_for: null }) === contentOf({ ...post, scheduled_for: null });
}
const textMap = (value, max) => (object(value)
  ? Object.fromEntries(Object.entries(value).map(([key, item]) => [key, text(item, max)]).filter(([key, item]) => /^[a-z0-9_-]{1,40}$/i.test(key) && item))
  : {});
const placeFor = vendor => PLACES.find(place => place.connection_vendor === vendor) ?? null;
const idOf = postId => (postId.startsWith(`${TYPE}:`) ? postId : `${TYPE}:${postId}`);

// A time zone's own name, or null when it is not one.
function timeZoneName(zone) {
  try { return new Intl.DateTimeFormat('en-US', { timeZone: zone }).resolvedOptions().timeZone; } catch { return null; }
}

async function readPostRecord(door, postId) {
  if (typeof postId !== 'string' || !postId.trim()) return null;
  return door.readRecord(TYPE, idOf(postId.trim()));
}

async function readPost(door, postId) {
  return (await readPostRecord(door, postId))?.value ?? null;
}

async function keep(door, post, verb, expected) {
  await door.write([{ id: post.post_id, type: TYPE, value: post, expected }], { key: `${verb}:${post.post_id}:${post.updated_at}` });
  return post;
}

// The person's connection records, each { connection_id, vendor, ... }.
async function connectionsOf(door) {
  const found = [];
  for await (const record of door.list({ type: settings.connection_type })) {
    const value = record.value;
    if (object(value) && typeof value.connection_id === 'string' && typeof value.vendor === 'string') found.push(value);
  }
  return found;
}

/** A held value in a place's options: { held: field }, or { held: field, sign } for a value made from it as the
 *  request leaves (read-data/send-a-post.mjs signers). */
export const isHeld = template => object(template) && typeof template.held === 'string' && Object.keys(template).every(key => key === 'held' || key === 'sign');

// The held fields a place's options name, each once, in the order they first appear.
export function heldFields(template, into = []) {
  if (Array.isArray(template)) template.forEach(item => heldFields(item, into));
  else if (object(template)) {
    if (isHeld(template)) { if (!into.includes(template.held)) into.push(template.held); }
    else Object.values(template).forEach(item => heldFields(item, into));
  }
  return into;
}

// One account as a post destination: ready when its connection says the account and holds every value the place
// signs with, and it may send.
function destinationOf(place, connection) {
  const plain = object(connection.plain) ? connection.plain : {};
  const held = new Set(Array.isArray(connection.held) ? connection.held : []);
  const needsPlain = object(place.account) && 'plain' in place.account && !text(plain[place.account.plain], 500) ? place.account.plain : null;
  const needsHeld = heldFields(place.options).find(field => !held.has(field)) ?? null;
  const said = needsPlain ? `This ${place.label} connection does not say its ${needsPlain.replace(/_/g, ' ')}. Connect ${place.label} again.`
    : needsHeld ? `This ${place.label} connection holds no ${needsHeld.replace(/_/g, ' ')}. Connect ${place.label} again.`
      : connection.can_send === false ? `This ${place.label} connection may not post. Connect ${place.label} again and allow posting.` : null;
  return { account_id: connection.connection_id, platform: place.platform, label: place.label, name: connection.account_label ?? null, ready: !said, ...(said ? { said } : {}) };
}

async function destinationsOf(door, listed = null) {
  const all = listed ?? await connectionsOf(door);
  const destinations = [];
  const notConnected = [];
  for (const place of PLACES) {
    const mine = all.filter(item => item.vendor === place.connection_vendor);
    destinations.push(...mine.map(connection => destinationOf(place, connection)));
    if (!mine.length) notConnected.push({ platform: place.platform, label: place.label, connection_vendor: place.connection_vendor });
  }
  return { destinations, not_connected: notConnected };
}

/** tool:list-post-destinations: the person's accounts a post can go to, and each place they have no account for. */
export async function listPostDestinations(_input, { door }) {
  const { destinations, not_connected } = await destinationsOf(door);
  return { destinations, not_connected,
    said: destinations.length ? `${destinations.length} ${destinations.length === 1 ? 'account is' : 'accounts are'} connected for posting.` : 'No account is connected for posting yet. Connect one, then list again.' };
}

// The people a post contacts first, found outside the person's records, as the caller listed them: each with a
// handle, a public address and at least one place they were found. Null for a list that is not that.
function reachesOf(value, rules) {
  if (!Array.isArray(value) || value.length > rules.most) return null;
  const people = value.map(item => {
    const handle = object(item) ? text(item.handle, 100)?.replace(/^@/, '') : null;
    const profile = object(item) ? text(item.profile_url, 500) : null;
    const provenance = object(item) && Array.isArray(item.provenance) ? item.provenance.slice(0, rules.provenance_most).filter(object)
      .map(row => ({ source: text(row.source, 200), url: text(row.url, 500), title: text(row.title, 200), posted_at: text(row.posted_at, 40) }))
      .filter(row => row.source && row.url && URL.canParse(row.url)) : [];
    const sought = object(item) ? text(item.sought, 600) : null;
    return handle && profile && URL.canParse(profile) && provenance.length ? { network: text(item.network, 40), handle, profile_url: profile, ...(sought ? { sought } : {}), provenance } : null;
  });
  return people.every(Boolean) ? people : null;
}

// The words one destination is sent with: its own caption or the post's, then the link tagged for it.
export function wordsOf(post, place, accountId) {
  const words = post.caption_by_platform?.[place.platform] ?? post.caption ?? '';
  if (!post.link) return words;
  const address = new URL(post.link);
  const from = { post_id: post.post_id, platform: place.platform, account_id: accountId };
  for (const tag of settings.link_tags) address.searchParams.set(tag.param, tag.value ?? from[tag.from] ?? '');
  return [words, address.href].filter(Boolean).join(settings.link_joiner);
}

// Whether the post is ready for each place it is going: the words and settings exactly as each place is sent them,
// the file as the post knows it, the account as the person's connection record says it.
async function checksOf(door, post) {
  const listed = await connectionsOf(door);
  const { destinations: accounts, not_connected: notConnected } = await destinationsOf(door, listed);
  const byId = new Map(accounts.map(item => [item.account_id, item]));
  const all = new Map(listed.map(item => [item.connection_id, item]));
  const media = post.media ? { found: true, media_type: post.media.media_type ?? null, facts: mediaFacts({ byte_length: post.media.byte_length }, post.media.facts) } : null;
  const kind = media?.media_type ? media.media_type.split('/')[0] : 'file';
  const checked = (post.destinations ?? []).map(accountId => {
    const connection = all.get(accountId);
    const place = connection ? placeFor(connection.vendor) : null;
    const chosen = place ? { ...(place.default_settings ?? {}), ...(post.settings_by_platform?.[place.platform] ?? {}) } : {};
    const found = readyFor({ place, account: byId.get(accountId) ?? null, words: place ? wordsOf(post, place, accountId) : '', chosen, media, settings });
    // This run cannot see the person's files, so whether the file is still there is reported, never passed.
    const notChecked = media ? [...found.not_checked, { check: 'media_found', said: fillWords(settings.ready_words.file_not_checked, { kind }) }] : found.not_checked;
    return { account_id: accountId, platform: place?.platform ?? null, label: place?.label ?? null, name: byId.get(accountId)?.name ?? null, ...found, not_checked: notChecked };
  });
  return { ...readyOverall(checked, settings, { connected: accounts, not_connected: notConnected }), destinations: checked };
}

const nowhere = post => new Error(`${post.post_id} goes nowhere yet. Give it destinations: account_id values from tool:list-post-destinations.`);

// A file the caller names for the post: its identity in the person's files, with what the caller knows of it.
function mediaOf(given, facts) {
  if (!object(given) || typeof given.identity !== 'string' || !given.identity.trim()) {
    throw new Error('media is the file as the person\'s files list it: { identity, name?, media_type?, byte_length? }, or null for none.');
  }
  const told = object(facts) ? Object.fromEntries(['duration_seconds', 'width', 'height'].filter(key => Number.isFinite(facts[key]) && facts[key] > 0).map(key => [key, facts[key]])) : {};
  return {
    identity: given.identity.trim(),
    ...(text(given.name, 500) ? { name: text(given.name, 500) } : {}),
    ...(text(given.media_type, 100) ? { media_type: text(given.media_type, 100) } : {}),
    ...(Number.isFinite(given.byte_length) && given.byte_length > 0 ? { byte_length: given.byte_length } : {}),
    ...(Object.keys(told).length ? { facts: told } : {}),
  };
}

/** tool:draft-a-post: keeps a draft for the person to look at. Nothing is posted. */
export async function draftAPost(input = {}, { door, now = () => new Date() }) {
  if (!object(input)) throw new Error('Give the post as an object: caption, and optionally media, destinations, link and scheduled_for.');
  const earlierRecord = input.post_id === undefined ? null : await readPostRecord(door, input.post_id);
  const earlier = earlierRecord?.value ?? null;
  if (input.post_id !== undefined && !earlier) throw new Error(`There is no post ${input.post_id}. Leave post_id out to draft a new one.`);
  if (earlier && !changeable(earlier)) throw new Error(`${earlier.post_id} is already on its way, so it cannot change. Draft a new post instead.`);
  const base = earlier ?? {};
  const caption = input.caption === undefined ? base.caption ?? '' : (typeof input.caption === 'string' ? input.caption.slice(0, settings.max_caption_characters) : '');
  const source = input.source === undefined ? base.source ?? null
    : input.source === null ? null
      : object(input.source) && text(input.source.kind, 100) && text(input.source.id, 300) ? { kind: text(input.source.kind, 100), id: text(input.source.id, 300) }
        : (() => { throw new Error('source names the record a post came from as { kind, id }.'); })();
  const formatId = input.format_id === undefined ? base.format_id ?? null
    : input.format_id === null || input.format_id === '' ? null
      : text(input.format_id, 100) ?? (() => { throw new Error('format_id is the id of one of the person\'s format records.'); })();
  let media = base.media ?? null;
  if (input.media !== undefined) media = input.media === null ? null : mediaOf(input.media, input.media_facts);
  else if (media && object(input.media_facts)) media = mediaOf(media, input.media_facts);
  const given = input.destinations === undefined ? base.destinations ?? [] : input.destinations;
  if (!Array.isArray(given) || given.some(item => typeof item !== 'string' || !item.trim())) throw new Error('destinations is a list of account_id values from tool:list-post-destinations.');
  const destinationIds = [...new Set(given.map(item => item.trim()))];
  if (destinationIds.length > settings.max_destinations) throw new Error(`A post goes to at most ${settings.max_destinations} destinations.`);
  const known = new Set((await connectionsOf(door)).filter(item => placeFor(item.vendor)).map(item => item.connection_id));
  const unknown = destinationIds.filter(id => !known.has(id));
  if (unknown.length) throw new Error(`${unknown.join(', ')} ${unknown.length === 1 ? 'is not an account' : 'are not accounts'} this person can post to. tool:list-post-destinations shows the ones they can.`);
  if (!caption.trim() && !media) throw new Error('A post needs words (caption) or a video or picture (media).');
  const link = input.link === undefined ? base.link ?? null : text(input.link, 2000);
  if (link && !(URL.canParse(link) && new URL(link).protocol === 'https:')) throw new Error('link is a full https address, like the page where people sign up.');
  const scheduledFor = input.scheduled_for === undefined ? base.scheduled_for ?? null : text(input.scheduled_for, 60);
  if (scheduledFor && !Number.isFinite(Date.parse(scheduledFor))) throw new Error('scheduled_for is a date and time with its zone, like 2026-10-01T09:00:00-04:00.');
  const saidZone = input.time_zone === undefined ? base.time_zone ?? null : text(input.time_zone, 80);
  const timeZone = saidZone === null ? null : timeZoneName(saidZone);
  if (saidZone !== null && !timeZone) throw new Error(`${saidZone} is not a time zone; use one like America/New_York.`);
  const reaches = input.reaches === undefined ? base.reaches ?? [] : reachesOf(input.reaches, settings.first_contact);
  if (!reaches) throw new Error(fillWords(settings.first_contact.words.reaches, { most: String(settings.first_contact.most) }));
  const at = now().toISOString();
  const drafter = text(input.drafted_by, 100);
  const post = {
    post_id: earlier?.post_id ?? `${TYPE}:${now().getTime().toString(36).padStart(9, '0')}-${crypto.randomUUID().replace(/-/g, '').slice(0, 12)}`,
    status: 'draft', caption,
    ...(media ? { media } : {}),
    ...(source ? { source } : {}), ...(formatId ? { format_id: formatId } : {}), ...(reaches.length ? { reaches } : {}),
    caption_by_platform: input.caption_by_platform === undefined ? base.caption_by_platform ?? {} : textMap(input.caption_by_platform, settings.max_caption_characters),
    settings_by_platform: input.settings_by_platform === undefined ? base.settings_by_platform ?? {} : (object(input.settings_by_platform) ? Object.fromEntries(Object.entries(input.settings_by_platform).filter(([, value]) => object(value))) : {}),
    destinations: destinationIds, ...(link ? { link } : {}), ...(scheduledFor ? { scheduled_for: new Date(scheduledFor).toISOString() } : {}), ...(timeZone ? { time_zone: timeZone } : {}),
    created_at: base.created_at ?? at, updated_at: at,
    ...(drafter ? { drafted_by: drafter } : base.drafted_by ? { drafted_by: base.drafted_by } : {}),
  };
  if (earlier && contentOf(earlier) === contentOf(post)) return { post: shaped(earlier), ready: await checksOf(door, earlier), said: 'Nothing changed in the post.' };
  await keep(door, post, 'draft', earlierRecord);
  const said = earlier?.status === 'approved' || earlier?.status === 'scheduled' ? 'The post changed, so it is a draft again: approve it once it has been looked at.'
    : destinationIds.length ? 'The post is kept as a draft. Show it to the person, then approve it with tool:approve-a-post.'
      : 'The post is kept as a draft that goes nowhere yet. Pick where it goes (destinations from tool:list-post-destinations) before it can be approved.';
  return { post: shaped(post), ready: await checksOf(door, post), said };
}

/** tool:check-a-post: whether the post is ready for each place it is going. It changes nothing. */
export async function checkAPost({ post_id: postId } = {}, { door }) {
  const post = await readPost(door, postId);
  if (!post) return { post_id: String(postId ?? ''), status: 'missing', said: `There is no post ${postId ?? ''}, so nothing was checked.` };
  return { post_id: post.post_id, status: post.status, ...(await checksOf(door, post)) };
}

/** tool:approve-a-post: approves the post exactly as it was reviewed. */
export async function approveAPost({ post_id: postId, expected_values: expected, approved_by: approvedBy } = {}, { door, now = () => new Date() }) {
  const current = await readPostRecord(door, postId);
  const post = current?.value ?? null;
  if (!post) throw new Error(`There is no post ${postId ?? ''}.`);
  // The reviewed snapshot is compared with the post as it is now, so newer words, destinations or timing are never
  // approved by accident, including by a retry.
  requireCurrentReview(expected, post);
  if (post.status === 'approved') return { post: shaped(post), said: 'The post was already approved.' };
  if (post.status !== 'draft') throw new Error(`${post.post_id} is ${post.status}, so there is nothing to approve.`);
  if (!post.destinations?.length) throw nowhere(post);
  const at = now().toISOString();
  const by = text(approvedBy, 100);
  const approved = await keep(door, { ...post, status: 'approved', approved_at: at, ...(by ? { approved_by: by } : {}), updated_at: at }, 'approve', current);
  return { post: shaped(approved), said: 'Approved. tool:set-a-post-to-go-at-its-time sets it to go at its scheduled time.' };
}

/** tool:publish-a-post-now: queue an approved post at the current time; its own wake and each place's send row own
 *  the send and delivery receipt. This action never reports a queued post as published. */
export async function publishAPostNow({ post_id: postId, expected_values: expected } = {}, { door, now = () => new Date() }) {
  const current = await readPostRecord(door, postId);
  const post = current?.value ?? null;
  if (!post) throw new Error(`There is no post ${postId ?? ''}.`);
  const at = now();

  // Once this action has queued the post, a retry with the same reviewed content returns its current state without
  // changing armed_at or creating another wake. Changing the schedule through the draft tool makes it a draft instead.
  const due = Number.isFinite(Date.parse(post.scheduled_for ?? '')) && Date.parse(post.scheduled_for) <= at.getTime();
  if (due && sameReviewExceptSchedule(expected, post)) {
    if (post.status === 'scheduled') return { post_id: post.post_id, status: post.status, post: shaped(post), said: 'Already queued for the send wake. Each destination will show its own outcome; this action did not send the post.' };
    if (post.status === 'posted') return { post_id: post.post_id, status: post.status, post: shaped(post), said: 'Already published to every destination; no duplicate send was queued.' };
    if (['partial', 'failed'].includes(post.status)) return { post_id: post.post_id, status: post.status, post: shaped(post), said: 'This post already has delivery outcomes. A destination with an unknown outcome is not sent again automatically; check each destination before retrying.' };
  }

  requireCurrentReview(expected, post);
  if (post.status !== 'approved') {
    if (post.status === 'scheduled') throw new Error(`${post.post_id} is already set to go at ${post.scheduled_for}. Take it back before choosing Publish now.`);
    throw new Error(`${post.post_id} is ${post.status}. Only an approved post can be queued to publish now.`);
  }
  if (!post.destinations?.length) throw nowhere(post);
  const ready = await checksOf(door, post);
  if (!ready.ready) return { post_id: post.post_id, status: post.status, post: shaped(post), ready, said: `It was not queued. ${ready.said} ${ready.destinations.filter(item => !item.ready).map(item => item.said).join(' ')}`.trim() };

  const timestamp = at.toISOString();
  const scheduled = await keep(door, { ...post, scheduled_for: timestamp, status: 'scheduled', armed_at: timestamp, updated_at: timestamp }, 'publish-now', current);
  return { post_id: scheduled.post_id, status: scheduled.status, post: shaped(scheduled), ready, said: 'Queued for the send wake now. Each destination will show its own outcome; this action did not send the post.' };
}

/** tool:set-a-post-to-go-at-its-time: an approved post whose time is still ahead and that is ready for every place
 *  is scheduled. Nothing is sent now. */
export async function setAPostToGoAtItsTime({ post_id: postId } = {}, { door, now = () => new Date() }) {
  const current = await readPostRecord(door, postId);
  const post = current?.value ?? null;
  if (!post) throw new Error(`There is no post ${postId ?? ''}.`);
  if (post.status === 'scheduled') return { post_id: post.post_id, status: post.status, post: shaped(post), said: `It is already set to go at ${post.scheduled_for}.` };
  if (post.status !== 'approved') throw new Error(`${post.post_id} is ${post.status}. Only an approved post is set to go: show it to the person, approve it with tool:approve-a-post, then set it.`);
  if (!post.destinations?.length) throw nowhere(post);
  if (!post.scheduled_for || !(Date.parse(post.scheduled_for) > now().getTime())) {
    throw new Error(`${post.post_id} has no time still ahead. Give it one with tool:draft-a-post (scheduled_for), approve it again, then set it.`);
  }
  const ready = await checksOf(door, post);
  if (!ready.ready) return { post_id: post.post_id, status: post.status, post: shaped(post), ready, said: `It was not set to go. ${ready.said} ${ready.destinations.filter(item => !item.ready).map(item => item.said).join(' ')}`.trim() };
  const at = now().toISOString();
  const scheduled = await keep(door, { ...post, status: 'scheduled', armed_at: at, updated_at: at }, 'schedule', current);
  return { post_id: scheduled.post_id, status: scheduled.status, post: shaped(scheduled), ready, said: `It goes out at ${scheduled.scheduled_for}. Nothing was sent now.` };
}

/** tool:take-back-a-post: a scheduled post that nothing was sent for is a draft again, so its time sends nothing. */
export async function takeBackAPost({ post_id: postId } = {}, { door, now = () => new Date() }) {
  const current = await readPostRecord(door, postId);
  const post = current?.value ?? null;
  if (!post) throw new Error(`There is no post ${postId ?? ''}.`);
  if (post.status !== 'scheduled' || post.sent_at || Object.keys(post.deliveries ?? {}).length) {
    throw new Error(`${post.post_id} is ${post.status} and not waiting for its time, so there is nothing to take back.`);
  }
  const at = now().toISOString();
  const { armed_at: _armed, ...rest } = post;
  const back = await keep(door, { ...rest, status: 'draft', cancelled_because: 'taken back', updated_at: at }, 'take-back', current);
  return { post: shaped(back), said: 'Taken back: it is a draft again and nothing will be sent at its time.' };
}
