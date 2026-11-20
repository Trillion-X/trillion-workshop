// tools/network-people/do-work/network-people.mjs
//
// The three functions the Network rows run, one per job: `(input) => result`, run by do-work/network-people-run.mjs. `subject` is
// the person the caller verified; these functions trust their caller for it. A profile answers what a person shows the Network;
// a contact is kept on the person's own row and is never answered by any of these functions. Nothing here reads or writes a store:
// the caller hands in the profile rows it read (records), and a row a call changes comes back under `keep` for the caller to store.
import { isDeepStrictEqual as isDeepEqualValue } from 'node:util';
import { KINDS, keepRow, profileOf, profilesIn, recordsIn, refuse, rowId, words } from '../read-data/profile-rows.mjs';

const HANDLE = /^[a-z0-9_]{3,30}$/;
const NAME_MOST = 80;
const TEXT_MOST = 500;
const CONTACT_MOST = 200;
const LINKS_MOST = 5;
const NEED_MOST = 300;
const PURSUITS_MOST = 10;
// Words too common to show a match: a short list kept in this function.
const STOP = new Set(['the', 'and', 'for', 'with', 'you', 'your', 'are', 'from', 'that', 'this', 'have', 'looking', 'need', 'want', 'can', 'who', 'how', 'what', 'where', 'about', 'some', 'any']);
// The text fields a person may set, with the most characters each holds.
const TEXT_FIELDS = { name: NAME_MOST, about: TEXT_MOST, offering: TEXT_MOST, seeking: TEXT_MOST, contact: CONTACT_MOST };
const FLAG_FIELDS = ['findable', 'open_to_messages', 'show_ais', 'show_counts', 'show_pursuits', 'share_service_names'];

function subjectOf(input) {
  const subject = words(input?.subject);
  if (!subject) refuse('subject must name the person, the way the Network names them.');
  return subject;
}

/** The words a need or a profile says, as lowercase words of three letters or more, without the common ones. */
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

/** The public view of a profile: what a Network reader may see, never the contact itself. */
function publicView(value) {
  const { contact, ...rest } = value;
  return { ...rest, contact_set: typeof contact === 'string' && contact.length > 0 };
}

/** tool:network-profile: a person changes how they show in the Network. Only the fields sent change, and each field a person wrote
 * is listed in `written`. A handle is unique across the profiles handed in. */
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
    changes.pursuits = input.pursuits.map(words).filter(Boolean);
  }
  const moved = Object.keys(changes).filter(name => !isDeepEqualValue(current[name], changes[name]));
  const written = [...new Set([...(current.written ?? []), ...moved])];
  const value = { ...current, ...changes, subject, written };
  const keep = keepRow('profile', rowId('profile', subject), value, handed);
  return { subject, changed: Object.keys(changes), profile: publicView(value), ...(keep ? { keep: [keep] } : {}) };
}

/** The people a viewer hid by a label they gave: unwanted-requests or unsafe, from this viewer. */
const hiddenBy = (records, viewer) => new Set(records
  .filter(record => record.type === KINDS.label && record.value?.by === viewer && ['unwanted-requests', 'unsafe'].includes(record.value?.label))
  .map(record => record.value.relay));

/** tool:find-network-people: people in the Network whose profiles say what they offer and seek, matched by the words of the need.
 * Only findable profiles with a handle answer, by handle, never by contact. Matching is by shared words, not by meaning. */
export function findNetworkPeople(input) {
  const records = recordsIn(input);
  const subject = subjectOf(input);
  const need = words(input?.need);
  if (!need || need.length > NEED_MOST) refuse(`need says what you are looking for, ${NEED_MOST} characters at most.`);
  const needle = tokens(need);
  const hidden = hiddenBy(records, subject);
  const people = profilesIn(records)
    .map(row => row.value)
    .filter(value => value.subject !== subject && value.findable === true && value.handle && !hidden.has(value.subject))
    .map(value => ({ handle: value.handle, name: value.name ?? null, offering: value.offering ?? '', seeking: value.seeking ?? '', score: Math.max(share(needle, value.offering), share(needle, value.seeking), share(needle, value.about)) }))
    .filter(person => person.score > 0)
    .sort((a, b) => b.score - a.score || (a.handle < b.handle ? -1 : 1));
  return { subject, need, people };
}

/** tool:on-my-path: people whose shown pursuits share words with this person's own pursuits, each with their pursuit beside this
 * person's own, best first. Only profiles that chose to show their pursuits are compared. */
export function onMyPath(input) {
  const records = recordsIn(input);
  const subject = subjectOf(input);
  const mine = profileOf(records, subject)?.value?.pursuits ?? [];
  const hidden = hiddenBy(records, subject);
  const best = new Map();
  for (const value of profilesIn(records).map(row => row.value)) {
    if (value.subject === subject || value.show_pursuits !== true || !value.handle || value.findable !== true || hidden.has(value.subject)) continue;
    for (const theirs of value.pursuits ?? []) for (const own of mine) {
      const score = share(tokens(own), theirs);
      if (score <= 0) continue;
      const held = best.get(value.handle);
      if (!held || score > held.score) best.set(value.handle, { handle: value.handle, name: value.name ?? null, their_pursuit: theirs, your_pursuit: own, score });
    }
  }
  return { subject, people: [...best.values()].sort((a, b) => b.score - a.score || (a.handle < b.handle ? -1 : 1)) };
}
