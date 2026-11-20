// tools/network-people/do-work/network-people.mjs
//
// The Network's four jobs as pure functions, `(input) => result`, run by do-work/network-profile-sql.mjs (the one process the rows
// run, which reads and writes the rows in the database the caller names). Nothing here touches a store: the records a call needs are
// handed in as `records` ({ id, type, value }), and a row a call changes comes back under `keep` for the caller's store to write.
//
// Meaning: a listing carries its own embedding (a vector the person's AI made), and a search compares a need's embedding with it by
// cosine (old src/network.mjs find, 2009-2017, and onPath, 2022-2060). Thresholds are DATA, read from the Network settings the
// introduce-two-people owner keeps (min_similarity for find, on_your_path.min_similarity for the path). With no embedding for the
// need, find falls back to the share of the need's words a listing holds (old 2007-2014), and the path has no fallback (old 2053-2060).
//
// Contact: a person's contact is kept on their own profile and is answered only by readNetworkContact, and only while an introduction
// between the two people is in a released state (see RELEASED below, and its check in the tests).
import { isDeepStrictEqual } from 'node:util';
import settings from '../../introduce-two-people/src/network-settings.json' with { type: 'json' };
import introductionStates from '../../introduce-two-people/src/introduction-states.json' with { type: 'json' };
import { KINDS, keepRow, profileOf, profilesIn, recordsIn, refuse, rowId, words } from '../read-data/profile-rows.mjs';

const HANDLE = /^[a-z0-9_]{3,30}$/;
const NAME_MOST = 80;
const TEXT_MOST = 500;
const CONTACT_MOST = 200;
const LINKS_MOST = 5;
const NEED_MOST = 300;
const PURSUITS_MOST = 10;
const TITLE_MOST = 200;
const DIMENSIONS_MOST = 4096;
// Words too common to show a match (the word-share fallback only).
const STOP = new Set(['the', 'and', 'for', 'with', 'you', 'your', 'are', 'from', 'that', 'this', 'have', 'looking', 'need', 'want', 'can', 'who', 'how', 'what', 'where', 'about', 'some', 'any']);
const TEXT_FIELDS = { name: NAME_MOST, about: TEXT_MOST, offering: TEXT_MOST, seeking: TEXT_MOST, contact: CONTACT_MOST };
const FLAG_FIELDS = ['findable', 'open_to_messages', 'show_ais', 'show_counts', 'show_pursuits', 'share_service_names'];
// The introduction states a contact is released in: both people said yes, and nothing has ended it. The states are the owner's
// (introduce-two-people/src/introduction-states.json); the test checks each one here is a state there, and that the rest are not released.
export const RELEASED = Object.freeze(['accepted', 'waiting_for_ais', 'introduced', 'talked']);
const MIN_SIMILARITY = settings.min_similarity;
const PATH_MIN_SIMILARITY = settings.on_your_path.min_similarity;
export const KNOWN_STATES = Object.freeze(Object.keys(introductionStates.states));

function subjectOf(input, label = 'subject') {
  const subject = words(input?.[label]);
  if (!subject) refuse(`${label} must name the person, the way the Network names them.`);
  return subject;
}

/** The words a need or a listing says, as lowercase words of three letters or more, without the common ones. */
export function tokens(text) {
  return new Set(String(text ?? '').toLowerCase().split(/[^a-z0-9]+/).filter(word => word.length >= 3 && !STOP.has(word)));
}

/** How many of the needle's words the text holds, as a share of the needle's words (0 to 1). */
function share(needle, text) {
  if (!needle.size) return 0;
  const held = tokens(text);
  let hits = 0;
  for (const word of needle) if (held.has(word)) hits += 1;
  return hits / needle.size;
}

/** Cosine of two embeddings of the same length (old src/meaning.mjs). */
export function cosine(a, b) {
  let dot = 0; let na = 0; let nb = 0;
  for (let i = 0; i < a.length; i += 1) { dot += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i]; }
  return dot / Math.sqrt(na * nb);
}

/** An embedding a caller hands in: a list of finite numbers, of one length, at most DIMENSIONS_MOST long. */
function embeddingOf(value, label) {
  if (value === null) return null;
  if (!Array.isArray(value) || value.length === 0 || value.length > DIMENSIONS_MOST || !value.every(Number.isFinite)) refuse(`${label} must be a list of numbers.`);
  return value;
}

/** The public view of a profile: what a Network reader may see; never the contact, and never a vector. */
function publicView(value) {
  const { contact, embedding, pursuits = [], ...rest } = value;
  return { ...rest, pursuits: pursuits.map(({ embedding: _, ...pursuit }) => pursuit), contact_set: typeof contact === 'string' && contact.length > 0, embedded: Array.isArray(embedding) };
}

/** tool:network-profile: a person changes how they show in the Network. Only the fields sent change; a field a person wrote is listed
 * in `written`; a handle is unique across the profiles handed in. Pursuits are { title, embedding? } and an embedding for the profile
 * itself is kept when sent, so the Network can compare meaning. */
export function networkProfile(input) {
  const records = recordsIn(input);
  const subject = subjectOf(input);
  const handed = profileOf(records, subject);
  const current = handed?.value ?? { subject, findable: true, open_to_messages: true, show_ais: false, show_counts: false, show_pursuits: false, share_service_names: false, links: [], pursuits: [], written: [] };
  const changes = {};
  for (const name of FLAG_FIELDS) if (input?.[name] !== undefined) {
    if (typeof input[name] !== 'boolean') refuse(`${name} must be true or false.`);
    changes[name] = input[name];
  }
  for (const [name, most] of Object.entries(TEXT_FIELDS)) if (input?.[name] !== undefined) {
    const text = input[name] === null ? '' : words(input[name]);
    if (text === null) refuse(`${name} must be words.`);
    if (text.length > most) refuse(`${name} is ${most} characters at most.`);
    changes[name] = text;
  }
  if (input?.handle !== undefined) {
    const handle = words(input.handle)?.toLowerCase() ?? '';
    if (!HANDLE.test(handle)) refuse('handle is 3 to 30 letters, digits or underscores.');
    if (profilesIn(records).some(row => row.value.handle === handle && row.value.subject !== subject)) refuse('That handle is taken; choose another.');
    changes.handle = handle;
  }
  if (input?.links !== undefined) {
    if (!Array.isArray(input.links) || input.links.length > LINKS_MOST) refuse(`links is a list of ${LINKS_MOST} web addresses at most.`);
    for (const link of input.links) if (!/^https?:\/\/\S+$/.test(String(link))) refuse('each link must be a web address starting with http:// or https://.');
    changes.links = input.links.map(String);
  }
  if (input?.pursuits !== undefined) {
    if (!Array.isArray(input.pursuits) || input.pursuits.length > PURSUITS_MOST) refuse(`pursuits is a list of ${PURSUITS_MOST} things at most.`);
    changes.pursuits = input.pursuits.map(pursuit => {
      const title = words(typeof pursuit === 'string' ? pursuit : pursuit?.title);
      if (!title || title.length > TITLE_MOST) refuse(`each pursuit needs a title of ${TITLE_MOST} characters at most.`);
      const embedding = embeddingOf(pursuit?.embedding ?? null, 'a pursuit embedding');
      return embedding ? { title, embedding } : { title };
    });
  }
  if (input?.embedding !== undefined) changes.embedding = embeddingOf(input.embedding, 'embedding');
  const moved = Object.keys(changes).filter(name => !isDeepStrictEqual(current[name], changes[name]));
  const written = [...new Set([...(current.written ?? []), ...moved])];
  const value = { ...current, ...changes, subject, written };
  const keep = keepRow('profile', rowId('profile', subject), value, handed);
  return { subject, changed: Object.keys(changes), profile: publicView(value), ...(keep ? { keep: [keep] } : {}) };
}

/** The people a viewer hid by a label they gave: unwanted-requests or unsafe, from this viewer (old network.mjs hiddenFor). */
const hiddenBy = (records, viewer) => new Set(records
  .filter(record => record.type === KINDS.label && record.value?.by === viewer && ['unwanted-requests', 'unsafe'].includes(record.value?.label))
  .map(record => record.value.relay));

/** tool:find-network-people: people whose listings are close in meaning to the need. With the need's `embedding`, a listing answers
 * when its embedding's cosine is at least min_similarity; without one, a listing answers when it shares a word with the need. Only
 * findable profiles with a handle answer, by handle, never by contact. */
export function findNetworkPeople(input) {
  const records = recordsIn(input);
  const subject = subjectOf(input);
  const need = words(input?.need);
  if (!need || need.length > NEED_MOST) refuse(`need says what you are looking for, ${NEED_MOST} characters at most.`);
  const embedding = embeddingOf(input?.embedding ?? null, 'the need embedding');
  const needle = tokens(need);
  const hidden = hiddenBy(records, subject);
  const people = profilesIn(records)
    .map(row => row.value)
    .filter(value => value.subject !== subject && value.findable === true && value.handle && !hidden.has(value.subject))
    .map(value => {
      const score = embedding
        ? (Array.isArray(value.embedding) && value.embedding.length === embedding.length ? cosine(embedding, value.embedding) : -1)
        : Math.max(share(needle, value.offering), share(needle, value.seeking), share(needle, value.about));
      return { handle: value.handle, name: value.name ?? null, offering: value.offering ?? '', seeking: value.seeking ?? '', score };
    })
    .filter(person => (embedding ? person.score >= MIN_SIMILARITY : person.score > 0))
    .sort((a, b) => b.score - a.score || (a.handle < b.handle ? -1 : 1));
  return { subject, need, matched_by: embedding ? 'meaning' : 'words', people };
}

/** tool:on-my-path: people whose shown pursuits are close in meaning to one of this person's pursuits (cosine at least the path's
 * min_similarity), each with their pursuit beside this person's own, best first. Only profiles that chose to show their pursuits, and
 * only pursuits that carry an embedding, are compared. */
export function onMyPath(input) {
  const records = recordsIn(input);
  const subject = subjectOf(input);
  const mine = (profileOf(records, subject)?.value?.pursuits ?? []).filter(pursuit => Array.isArray(pursuit.embedding));
  const hidden = hiddenBy(records, subject);
  const best = new Map();
  for (const value of profilesIn(records).map(row => row.value)) {
    if (value.subject === subject || value.show_pursuits !== true || !value.handle || value.findable !== true || hidden.has(value.subject)) continue;
    for (const theirs of (value.pursuits ?? []).filter(pursuit => Array.isArray(pursuit.embedding))) for (const own of mine) {
      if (own.embedding.length !== theirs.embedding.length) continue;
      const score = cosine(own.embedding, theirs.embedding);
      if (score < PATH_MIN_SIMILARITY) continue;
      const held = best.get(value.handle);
      if (!held || score > held.score) best.set(value.handle, { handle: value.handle, name: value.name ?? null, their_pursuit: theirs.title, your_pursuit: own.title, score });
    }
  }
  return { subject, people: [...best.values()].sort((a, b) => b.score - a.score || (a.handle < b.handle ? -1 : 1)) };
}

/** tool:read-a-network-contact: one person's contact, to another person, only while an introduction between them is in a released
 * state. The introduction record names its two people in `between`; a stranger, an unreleased or ended introduction, and a person
 * with no contact kept are each refused. */
export function readNetworkContact(input) {
  const records = recordsIn(input);
  const viewer = subjectOf(input, 'subject');
  const owner = subjectOf(input, 'of');
  const owned = profileOf(records, owner)?.value;
  if (!owned || typeof owned.contact !== 'string' || !owned.contact) refuse('No contact is kept for this person.');
  const pair = [viewer, owner].sort();
  const introduction = records.find(record => record.type === KINDS.introduction && record.id === rowId('introduction', ...pair));
  if (!introduction || !Array.isArray(introduction.value.between) || !isDeepStrictEqual([...introduction.value.between].sort(), pair)) refuse('Contact is released only after both people agree to meet.');
  if (!RELEASED.includes(introduction.value.state)) refuse('Contact is released only after both people agree to meet and while both stay connected.');
  return { subject: viewer, of: owner, state: introduction.value.state, contact: owned.contact };
}
