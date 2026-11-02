// src/record-sharing.mjs
//
// Purpose: who each of a person's own records is shared with, chosen item by item, kept in the person's own store as
// one `sharing` record per record they chose for (DATA shape below). Everything that reads a person's record for
// someone else asks this owner: the shared pool and stories (the network), a copy in a space (through the space's one
// check, src/space-permissions.mjs, as the fact `owner_shares_here`), and a person it was shared with (read live
// through releaseRecord). The sharing sheet (parts/ui/show/sharing-sheet) is drawn from sharingSheet, and its preview
// is the very copy a share makes (src/person-spaces.mjs shareableCopy), so it can never show other fields. The spaces
// it offers are the person's one share list (src/share-destinations.mjs), in their order.
//
//   GET  /sharing/<record>            the sheet: { thing, preview, fields, places, chain, inherited_from }
//   POST /sharing/<record>/preview    { leave_out }   the copy others would see with those fields left out: { preview }
//   POST /sharing/<record>            { network?, spaces?, people?, chain?, leave_out? }   choose; returns the sheet
//   GET  /sharing/<record>/links       the active and ended links for one record
//   POST /sharing/<record>/links       { scope, expires_at? }   make an expiring or open-ended external share
//   POST /sharing/<record>/links/<id>/revoke   stop one external share immediately
//   POST /sharing/<record>/links/<id>/change   { can?, expires_at?, when? }   change what one open link lets someone do
//   POST /sharing/<record>/links/<id>/send     { note? }   email a link made for one email address to that address
//   POST /sharing/<sealed record>/links  { scope, role, sealed_copy: { content_id, value } }   a sealed link (below)
//   GET  /shared-with-me              what people shared with this person: { shared_with_you: [{ offer_id, from,
//                                     kind, title, offered_at }] }
//   POST /shared-with-me/read         { offer_id }   the copy, if its owner still shares it with this person
//
// <record> is a record id (a pursuit, task plan, decision or message), `file:<identity>`, `tool:<id>`, or a part of a
// record (record-sharing.json `parts`, such as one row of a list: `list:<id>:rows:<row id>`), URL-encoded.
//
// The DATA a choice is kept as, one EEAF record `sharing:<record>` of type `sharing`:
//   { record: "<record>", choice_made: boolean, network: true | false | null, spaces: [space ids],
//     people: [relays], chain: boolean, leave_out: [field ids], changed_at }
//   choice_made false means this row exists only to hold external link grants. Old rows without the marker remain
//   explicit choices: an old default-valued row might be someone's deliberate private choice.
//   network  true: into the network (the anonymous shared pool, and stories when those are on); false: never; null:
//            as the account's own network choice (src/sharing-choice.mjs, on by default) for the kinds that choice
//            covers (record-sharing.json places.network.follows_account), and never for any other kind.
//   spaces   the spaces a copy is in. people: the people (as their network relay) who may read it.
//   chain    the choice also covers records recursively along record-sharing.json links, in either direction from
//            the root. Each walk keeps its direction so a decision about two pursuits cannot bridge a share from one
//            pursuit into the other pursuit and all its work. A record's own choice still wins.
//   leave_out fields of share_from_private for its kind that no copy carries.
//   link_grants are direct grants on this record for an external share link. Each grant is checked here again on
//   every read; it never changes the network, space or named-person choices and cannot be inherited by a chain.
// "Not shared" is { network: false, spaces: [], people: [] }; "shared only with" is network false with spaces or people.
//
// A sealed record (parts/sealed-records) has no copy this store can make, so it is shared only by a sealed link
// (record-sharing.json sealed.about_links): the person's device seals a copy with a fresh key of the link's own and
// sends only that sealed copy; the grant keeps it with the link's role (sealed.link_roles), and the key rides only in
// the link's fragment. A holder reads it, and a writer replaces it naming the content_id it replaced (compare-and-set),
// through sealedShareRequest (GET/POST /share/<code>/sealed). Revoking the link drops the sealed copy from the grant.
//
// Non-Negotiable Invariants:
//   1. A record's own choice wins; else the most private chain choice covering it (never shared, then shared only
//      with, then into the network; the latest among equals); else the account's network choice for a kind it covers,
//      and nothing at all for any other kind: a note never shared is with the person alone.
//   2. Nothing ever reads a whole private Trillion: every read is a copy of the fields share_from_private lets out for
//      its kind, less leave_out, with where it came from.
//   3. Every read by someone else decides again at the moment of reading: a choice turned off stops the next read.
//   4. Saving a choice makes every copy match it: copies in spaces not chosen are withdrawn through the space's own
//      check, offers to people not chosen are taken back, and a record out of the network leaves the shared pool and
//      is taken down as a story.
//   5. A record already in spaces before any chain covered it keeps that as its own choice when a chain is chosen
//      around it, so choosing a chain never takes back what was shared one by one.
//
import sharing from './record-sharing.json' with { type: 'json' };
import settings from './space-settings.json' with { type: 'json' };
import { CONFIGURATION_TYPE, ConfigurationError, configurationOpenPath } from './configurations.mjs';
import { reachOf, shareableCopy } from './person-spaces.mjs';
import { matchAsks, shareMatcher } from './share-match.mjs';
import { checkedLinkCopy, SEALED_TYPE } from '../parts/sealed-records/do-work/sealed-records.mjs';
import { timeZoneName } from '../parts/timed-action/do-work/wall-time.ts';
import recordCopies from './record-copies.json' with { type: 'json' };
import { planRecords } from './plan-records.mjs';
import { recordCommercialEvent } from './commercial-events.mjs';
import { sendMail } from './mail-sender.mjs';
import { shownName } from './space-invitation.mjs';
import { signInMethodsOf } from './sign-in-methods.mjs';
import { recordSent } from './sent.mjs';
import { compileRules, ruleVocabulary } from '../parts/formula-engine/rules/compile-rules.mjs';
import ruleOperators from '../parts/formula-engine/rules/rule-operators.json' with { type: 'json' };
import { makeLists, withRowSources } from './lists.mjs';
import { listCopy, shownViewRows } from './list-copy.mjs';
import { claimPublicName, nameFromWords, randomWords, secretName } from './readable-names.mjs';
import { appendCollectionPages, collectionEntriesAtLeaves, collectionEntryAtLeaf, collectionEntryAtOrdinal, openCollectionStore } from './share-collection-store.mjs';
import { featureReach, networkIdentityOf, networkReach } from './network-identity.mjs';
import { blake3 } from '@noble/hashes/blake3.js';
import { bytesToHex } from '@noble/hashes/utils.js';

const KIND = 'sharing';
// The kinds of record the account's own network choice decides when the record has no choice of its own.
const FOLLOWS_ACCOUNT = new Set(sharing.places.network.follows_account);
// A record id never holds "/", while a folder's reference does (folder:/From clients): such a reference is kept under
// its escaped form, which no other reference takes, since every other reference has no "/" to escape.
const rowId = ref => ref.includes('/') ? `${KIND}:~${encodeURIComponent(ref)}` : `${KIND}:${ref}`;
/** The copy a sealed link answers with in place of a readable one: only its role and abilities (never its contents). */
export const SEALED_LINK_KIND = 'sealed-link';
export const RECORD_SHARE_LINK_INDEX = 'record-share-link:';
// A public link listed in search results, by its address (record-sharing.json addresses `listed`): /share/sitemap.xml
// and /share/llms.txt walk this index, and each entry is admitted again by its owner before it is named.
export const RECORD_SHARE_LISTED_INDEX = 'record-share-listed:';
const LINK_INDEX = RECORD_SHARE_LINK_INDEX;
const unique = list => [...new Set(list)];
const COLLECTION_BATCH_LIMIT = 100;
const COLLECTION_READ_LIMIT = 32;
const MAX_SPACE_SHARE_ITEMS = 1001; // Up to 1000 selected things, plus the sender's own words.
const MAX_SPACE_SHARE_BATCH_BYTES = 1024 * 1024;
const shareChoiceFingerprint = choice => bytesToHex(blake3(new TextEncoder().encode(JSON.stringify(choice ?? null))));
// Match a slow public route to its owner's entry and end without logging any
// link, person, or file detail. This pure helper stays outside metered RPCs.
export const beginShareReadProbe = (probeId, method) => {
  if (typeof probeId !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(probeId)) return () => {};
  console.info('public share owner entered', { probe_id: probeId, method });
  return () => console.info('public share owner ended', { probe_id: probeId, method });
};
const strings = (value, label) => {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.some(item => typeof item !== 'string' || !item)) throw new SharingError(`${label} is a list of ids.`);
  return unique(value);
};
// The address a link opens (record-sharing.json `opens`), on the address the person's request came in on, else the
// service's first. Every link opens on /share/<code>, whatever it shares: one page draws any kind and what the link
// lets its recipient do.
const serviceOrigin = given => (typeof given === 'string' && /^https:\/\//.test(given) ? given : typeof SERVICE_ORIGINS === 'undefined' ? '' : SERVICE_ORIGINS[0]);
// The code (or chosen address) a share link opens with, from the whole link (https://<host>/share/<code>, with or
// without its query) or the code alone; null for anything else.
export function shareCodeOf(link) {
  if (typeof link !== 'string' || !link.trim()) return null;
  const text = link.trim();
  let path = text;
  try { path = new URL(text).pathname; } catch {}
  const code = path.startsWith('/share/') ? decodeURIComponent(path.slice('/share/'.length).split('/')[0]) : path;
  return /^[A-Za-z0-9_-]{3,}$/.test(code) ? code : null;
}
export const shareLinkAddress = (origin, code) => `${serviceOrigin(origin)}/share/${encodeURIComponent(code)}`;
// Where someone goes back to after signing in from a share link: /share/<code>, with an optional access_code, and
// nothing else.
const OPENS_PATTERN = /^\/share\/[A-Za-z0-9_-]+$/;
export function shareReturn(next) {
  if (typeof next !== 'string' || !next.startsWith('/') || next.startsWith('//') || next.includes('\\')) return null;
  let url;
  try { url = new URL(next, 'https://here.invalid'); } catch { return null; }
  if (url.origin !== 'https://here.invalid' || !OPENS_PATTERN.test(url.pathname)) return null;
  const keys = [...url.searchParams.keys()];
  if (keys.some(key => key !== 'access_code')) return null;
  return `${url.pathname}${url.search}`;
}
// What a link lets its recipient do (record-sharing.json abilities): the abilities a kind may carry, and the ones a new
// link carries when the sharer names none.
const ABILITIES = new Map(sharing.abilities.list.map(ability => [ability.id, ability]));
export const abilitiesOffered = kind => sharing.abilities.offered[kind] ?? sharing.abilities.offered.default;
const abilitiesGiven = kind => sharing.abilities.given[kind] ?? sharing.abilities.given.default;
// A link's own condition (`when`) is a rule tree in the formula engine's shape over record-sharing.json when_facts.
// It is compiled once when the link is made, so a rule that names no fact, or one left unfinished, is refused then
// rather than read later as "no condition".
const WHEN_FIELDS = sharing.when_facts.map(fact => ({ id: fact.id, kind: fact.kind }));
const WHEN_VOCABULARY = ruleVocabulary(ruleOperators);
// Whether a rule tree names one fact: a link counts its opens only when its own condition reads them.
const namesFact = (tree, id) => tree?.kind === 'rule' ? tree.field === id : (tree?.rules ?? []).some(rule => namesFact(rule, id));
const ZONED = new Set(sharing.when_facts.filter(fact => fact.zoned).map(fact => fact.id));
const namesZone = tree => tree?.kind === 'rule' ? ZONED.has(tree.field) : (tree?.rules ?? []).some(namesZone);
const zoneOk = zone => timeZoneName(zone) !== null;
// The clock read in the link's own zone (time_zone), so hour and weekday turn at that zone's midnight. A missing or
// unknown zone reads as null, so a rule on it fails closed rather than guessing a zone.
const clockFact = (fact, now, zone) => {
  if (!fact.part) return now;
  if (!zoneOk(zone)) return null;
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone: zone, hour: 'numeric', hourCycle: 'h23', weekday: 'long' }).formatToParts(new Date(now)).map(part => [part.type, part.value]));
  return fact.part === 'hour' ? Number(parts.hour) : String(parts.weekday).toLowerCase();
};
export const whenFactsOf = (grant, record, now) => Object.fromEntries(sharing.when_facts.map(fact => [fact.id,
  fact.from === 'clock' ? clockFact(fact, now, grant.time_zone) : pick(fact.from === 'grant' ? grant : record, fact.path) ?? fact.unset ?? null]));
// Why a link's zone and its condition do not go together, or null: a zone must be a real IANA zone, and a rule on the
// hour or the day needs one.
export function zoneProblem(condition, zone) {
  if (zone !== null && zone !== undefined && !zoneOk(zone)) return 'time_zone is an IANA zone such as Europe/London.';
  if (condition && namesZone(condition) && !zoneOk(zone)) return 'A rule on the hour or the day needs time_zone: an IANA zone such as Europe/London.';
  return null;
}
const filled = (template, values) => template.replace(/\{(\w+)\}/g, (whole, name) => values[name] ?? whole);
const pick = (value, path) => path.reduce((at, key) => (at && typeof at === 'object' ? at[key] : undefined), value);
const ADDRESS = new RegExp(sharing.addresses.pattern);
// A random code is hex (token below); an address a person may choose never looks like one, so a code is never claimed.
const LOOKS_LIKE_CODE = /^[0-9a-f]{20,}$/;
/** A link's address made from the shared thing's first words (record-sharing.json addresses), or null. */
export const addressFromWords = words => nameFromWords(words, { first: sharing.addresses.first_words, longest: sharing.addresses.longest, pattern: ADDRESS });
// A part of a record (record-sharing.json `parts`): `<whole>:<segment>:<id>` (a record id holds no "/"), where each part
// row names the kind of whole it narrows and the segment that marks it. Sharing a part is sharing its whole narrowed to
// that one piece.
const PARTS = sharing.parts ?? [];
export function partOf(ref) {
  for (const part of PARTS) {
    const at = typeof ref === 'string' && ref.startsWith(`${part.whole}:`) ? ref.indexOf(`:${part.segment}:`, part.whole.length + 1) : -1;
    if (at > 0 && ref.length > at + part.segment.length + 2) return { whole: ref.slice(0, at), id: ref.slice(at + part.segment.length + 2), kind: part.kind, segment: part.segment };
  }
  return null;
}
const token = (bytes = 24) => [...crypto.getRandomValues(new Uint8Array(bytes))].map(byte => byte.toString(16).padStart(2, '0')).join('');
const normalEmail = value => typeof value === 'string' ? value.trim().toLowerCase() : '';
const normalPhone = value => typeof value === 'string' ? value.replace(/[ ()-]/g, '') : '';
const sameSecret = (left, right) => {
  if (typeof left !== 'string' || typeof right !== 'string' || left.length !== right.length) return false;
  let difference = 0;
  for (let index = 0; index < left.length; index++) difference |= left.charCodeAt(index) ^ right.charCodeAt(index);
  return difference === 0;
};
/** The ids a link field names: an id, a list of ids, or an object keyed by ids. */
// Whether a recipient is the one a link names. Every identity here comes from the route, never from the page.
const namedBy = (scope, recipient = {}) => scope.kind === 'public'
  || (scope.kind === 'private' && recipient.relay === scope.value)
  || (scope.kind === 'email' && normalEmail(recipient.verified_email) === scope.value)
  || (scope.kind === 'phone' && normalPhone(recipient.verified_phone) === scope.value)
  || (scope.kind === 'code' && sameSecret(recipient.access_code, scope.value));
// What someone a link does not name yet can prove to be admitted: an email (a code, no account), a phone or an account
// (signing in), or the access code.
const PROOF_FOR = { email: 'email', phone: 'phone', private: 'account', code: 'code' };
export const idsIn = value => (typeof value === 'string' ? [value] : Array.isArray(value) ? value.filter(item => typeof item === 'string') : value && typeof value === 'object' ? Object.keys(value) : []);

export class SharingError extends Error {
  constructor(message, options) { super(message, options); this.name = 'SharingError'; }
}

// A configuration edit is one synchronous owner mutation after the final
// awaited admission. Re-read the live grant because a condition can await while
// its link is revoked, narrowed, replaced or expires. A returned grant is never
// a cached permission to use later, and no supplied configuration body is auth.
function currentConfigurationGrant(owner, code, recipient, admitted) {
  const { index, grant: admittedGrant } = admitted;
  if (owner.store.eeaf.typeOf(index.record) !== CONFIGURATION_TYPE) throw new SharingError('This link does not share a saved configuration.');
  const grant = owner.sharingRowOf(index.record)?.link_grants?.find(item => item.share_id === index.share_id && item.code === (index.code ?? code));
  const now = Date.now(), until = grant?.expires_at ? Date.parse(grant.expires_at) : null;
  if (!grant || grant.published === false || grant.revoked_at || (until !== null && (!Number.isFinite(until) || until <= now))) throw new SharingError('This share link has ended.');
  if (!namedBy(grant.scope, recipient) || JSON.stringify(grant) !== (admitted.signature ?? JSON.stringify(admittedGrant))) throw new SharingError('This share link changed. Open it again before continuing.');
  if (!(grant.can ?? ['view']).includes('view')) throw new SharingError('This link does not let you read this configuration.');
  return { index, grant };
}

function configurationShareView(owner, code, { index, grant }, recipient = {}) {
  const current = owner.configurations().get(index.record);
  if (!current) throw new SharingError('This saved configuration is no longer shared.');
  const copy = shareableCopy(CONFIGURATION_TYPE, index.record, current, owner.copyShape(index.record));
  const id = `shared-configuration:${code}`;
  const profileName = owner.profile?.()?.name;
  const name = typeof profileName === 'string' && profileName.trim() && profileName !== 'You' ? profileName : 'Account owner';
  const by = { id: owner.fact?.('network_relay') ?? 'owner', name };
  const proven = Boolean(typeof recipient.relay === 'string' && recipient.relay.trim() || normalEmail(recipient.verified_email));
  return { configuration: { ...copy.body, id, record_ref: id, owner: by, owner_name: name,
    ...(typeof copy.body.open_path === 'string' ? { open_path: configurationOpenPath(copy.body.open_path, code, 'shared_configuration') } : {}) },
    can: (grant.can ?? ['view']).filter(ability => ability !== 'edit' || proven), expires_at: grant.expires_at ?? null, owner: by };
}

// The folder a `folder:<path>` reference names, as a clean path from the top, or null for anything else (a part that
// climbs out, an empty part, a control character).
export function folderOf(ref) {
  const path = typeof ref === 'string' && ref.startsWith('folder:') ? ref.slice('folder:'.length).trim().replace(/\/+$/, '') || '/' : null;
  if (!path || !path.startsWith('/') || path.length > 1000 || /[\u0000-\u001f\u007f]/.test(path)) return null;
  const parts = path.split('/').slice(1);
  if (path !== '/' && parts.some(part => !part || part === '.' || part === '..')) return null;
  return path;
}

// A file's own name as someone sending it gave it, made safe to keep in a folder: its last part only, no control
// characters, never hidden or empty, at most 200 characters (its kind kept at the end).
export function keptFileName(given) {
  const last = String(given ?? '').split(/[\\/]/).at(-1).replace(/[\u0000-\u001f\u007f]/g, '').trim().replace(/^\.+/, '');
  if (!last) return 'file';
  if (last.length <= 200) return last;
  const dot = last.lastIndexOf('.');
  const kind = dot > 0 && last.length - dot <= 12 ? last.slice(dot) : '';
  return last.slice(0, 200 - kind.length) + kind;
}

function shareTitle(item) {
  if (item.title === undefined || item.title === null || item.title === '') return {};
  if (typeof item.title !== 'string' || item.title.trim().length > 300) throw new SharingError('One shared title holds at most 300 characters. Shorten it before sharing.');
  return item.title.trim() ? { title: item.title.trim() } : {};
}

function shareItem(item) {
  if (!item || typeof item !== 'object' || Array.isArray(item)) throw new SharingError('A share item must be a record, link, words or another share.');
  if (item.kind === 'record') {
    if (typeof item.record !== 'string' || !item.record) throw new SharingError('A record share item needs a record reference.');
    return { kind: 'record', record: item.record, ...shareTitle(item) };
  }
  if (item.kind === 'link') {
    if (typeof item.url !== 'string' || !/^https?:\/\//i.test(item.url)) throw new SharingError('A shared link needs an http or https address.');
    try {
      const url = new URL(item.url);
      if (!['http:', 'https:'].includes(url.protocol) || !url.hostname) throw new Error('Invalid web address');
    } catch { throw new SharingError('A shared link needs a valid http or https address.'); }
    return { kind: 'link', url: item.url, ...shareTitle(item) };
  }
  if (item.kind === 'text') {
    if (typeof item.text !== 'string' || !item.text.trim()) throw new SharingError('Shared words cannot be empty.');
    if (item.text.length > 20000) throw new SharingError('One shared text item holds at most 20,000 characters. Shorten it before sharing.');
    return { kind: 'text', text: item.text, ...shareTitle(item) };
  }
  if (item.kind === 'share') {
    if (typeof item.code !== 'string' || !item.code) throw new SharingError('A nested share needs its link code.');
    return { kind: 'share', code: item.code, ...shareTitle(item) };
  }
  throw new SharingError('A share item must be a record, link, words or another share.');
}

// A sealed link's role (record-sharing.json sealed.link_roles) and its checked sealed copy. A sealed record takes only
// a sealed link; anything else takes none; a role a link may not give, or `can` beside a role, is refused.
const SEALED_ROLES = new Map(sharing.sealed.link_roles.map(row => [row.id, row]));
function sealedLinkOf({ sealedRef, refs, inline, sealedCopy, role, can }) {
  if (!sealedRef) throw new SharingError(sharing.sealed.not_sealed_record);
  if (refs.length !== 1 || inline.length || sealedCopy === null || sealedCopy === undefined) throw new SharingError(sharing.sealed.only_sealed_link);
  const row = SEALED_ROLES.get(role ?? 'reader');
  if (!row?.granted_by_link || (can !== null && can !== undefined)) throw new SharingError(filled(sharing.sealed.role_refused, { roles: [...SEALED_ROLES.values()].filter(item => item.granted_by_link).map(item => item.id).join(', ') }));
  try { return { copy: checkedLinkCopy(sealedCopy), role: row.id, can: row.can }; }
  catch (error) { throw new SharingError(error.message); }
}

const entriesInGrant = (grant, index) => grant.entries?.length ? grant.entries
  : (grant.records ?? (grant.items ? [] : [index.record])).map(record => ({ kind: 'record', record })).concat(grant.items ?? []);

/** The records one record names through record-sharing.json links. */
export function linksFrom(kind, value) {
  return unique(sharing.links.filter(link => link.from === kind).flatMap(link => idsIn(pick(value, link.field))));
}

// How private a choice is: 0 never shared, 1 shared only with, 2 into the network (or as the account chooses).
const privacy = row => (row.network === false ? (row.spaces.length || row.people.length ? 1 : 0) : 2);
const hasChoice = row => Boolean(row && row.choice_made !== false);

/** The choice in force for a record (invariant 1): its own, else the most private chain covering it, else null. */
// The kinds a device may seal (record-copies.json sealable_types), and the sheet's switch for it: on, and why it cannot
// be switched now (null when it can).
const sealable = new Set(recordCopies.sealable_types);
const sealedSwitch = (on, blocked) => ({ on, label: sharing.sealed.label, detail: sharing.sealed.detail, blocked: blocked ?? null });

export function resolveSharing(ref, { own, chains, linked }) {
  if (hasChoice(own)) return { ...own, from: ref, inherited: false };
  const covering = chains.filter(row => hasChoice(row) && row.record !== ref && linked(row.record, ref));
  if (!covering.length) return null;
  const [chosen] = covering.sort((a, b) => privacy(a) - privacy(b) || String(b.changed_at).localeCompare(String(a.changed_at)));
  return { ...chosen, from: chosen.record, inherited: true };
}

/** A value as the preview shows it, by its label row in record-sharing.json fields: `show`, the path read inside an
 *  object; `each`, the part of every item of a list, one line per item; `words`, plain words for a value or for the
 *  start of one (the longest start that fits); `as`, how a value reads (`date`: its day, `size`: a count of bytes). */
const SIZE_UNITS = ['bytes', 'KB', 'MB', 'GB', 'TB'];
const AS = {
  date: value => { const at = new Date(value); return Number.isNaN(at.getTime()) ? null : at.toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric', timeZone: 'UTC' }); },
  size: value => {
    if (!Number.isFinite(value) || value < 0) return null;
    const step = Math.min(SIZE_UNITS.length - 1, value > 0 ? Math.floor(Math.log10(value) / 3) : 0);
    return `${step ? (value / 1000 ** step).toFixed(1).replace(/\.0$/, '') : value} ${SIZE_UNITS[step]}`;
  },
};
const wordsFor = (value, words) => {
  if (!words || typeof value !== 'string') return null;
  if (Object.hasOwn(words, value)) return words[value];
  const start = Object.keys(words).filter(key => value.startsWith(key)).sort((a, b) => b.length - a.length)[0];
  return start === undefined ? null : words[start];
};
function shownValue(value, row = {}) {
  if (Array.isArray(row.each) && Array.isArray(value)) return sectionWords(value.map(item => pick(item, row.each))).slice(0, 500);
  const inner = row.show && value && typeof value === 'object' ? pick(value, row.show) : value;
  if (inner === undefined || inner === null) return '';
  const said = wordsFor(inner, row.words) ?? (AS[row.as]?.(inner) ?? null);
  if (said !== null) return said;
  if (typeof inner === 'string') return inner;
  if (typeof inner === 'number' || typeof inner === 'boolean') return String(inner);
  return JSON.stringify(inner).slice(0, 500);
}

const fieldWords = id => String(id).replace(/([a-z])([A-Z])/g, '$1 $2').replace(/[_-]+/g, ' ').replace(/^./, letter => letter.toUpperCase());
// A DATA-declared section shows only fields already admitted by the sharing projection.
function sectionWords(value) {
  if (value === undefined || value === null) return '';
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (Array.isArray(value)) return value.map((item, index) => `${index + 1}. ${sectionWords(item)}`).filter(line => !line.endsWith('. ')).join('\n');
  return Object.entries(value).map(([key, item]) => {
    const words = sectionWords(item);
    return words ? `${fieldWords(key)}: ${words}` : '';
  }).filter(Boolean).join(' · ');
}

// A shared thing that holds rows (a list: body.fields describe them, body.rows are them) gets one page per row at
// /share/<address>/<row address>: each row's address is its title's first words, numbered when two rows read alike,
// and never one of a link's own parts. Nothing here names a kind: any copy of this shape gets row pages.
const LINK_PARTS = new Set(['items', 'file', 'preview', 'poster', 'transcript', 'look', 'prove', 'sign', 'pay']);
export function listRows(copy) {
  const rows = copy?.body?.rows;
  if (!Array.isArray(rows) || !Array.isArray(copy.body.fields)) return null;
  const dates = copy.body.fields.filter(field => sharing.addresses.date_kinds.includes(field.kind)).map(field => field.id);
  const taken = new Set();
  return rows.map(row => {
    const base = addressFromWords(row.title) ?? 'row';
    let address = LINK_PARTS.has(base) ? `${base}-row` : base;
    for (let n = 2; taken.has(address); n++) address = `${base}-${n}`;
    taken.add(address);
    const changed = dates.map(id => row.values?.[id]).filter(day => typeof day === 'string' && /^\d{4}-\d{2}-\d{2}/.test(day)).map(day => day.slice(0, 10)).sort().at(-1) ?? null;
    return { id: row.id, address, title: row.title ?? null, values: row.values ?? {}, changed };
  });
}
/** The newest day any row of a shared list names in a date field, or null. */
export const latestDay = copy => (listRows(copy) ?? []).map(row => row.changed).filter(Boolean).sort().at(-1) ?? null;

function sectionPreview(value, id, section) {
  if (!Array.isArray(section?.path) || !section.path.length || typeof section.label !== 'string') return null;
  const found = pick(value, section.path);
  if (found === undefined || found === null) return null;
  let words = sectionWords(found);
  if (section.format === 'currency_cents' && Number.isSafeInteger(found) && Array.isArray(section.currency_path)) {
    const direct = pick(value, section.currency_path);
    const rows = Array.isArray(section.currency_collection_path) ? pick(value, section.currency_collection_path) : null;
    const currencies = [...new Set((Array.isArray(rows) ? rows : []).map(row => row?.currency).filter(currency => typeof currency === 'string'))];
    const currency = typeof direct === 'string' && direct ? direct : currencies.length === 1 ? currencies[0] : null;
    try { words = currency ? new Intl.NumberFormat('en', { style: 'currency', currency }).format(found / 100) : `${found} cents`; }
    catch { words = `${found} cents`; }
  }
  return words ? { id: `${id}.${section.path.join('.')}`, label: section.label, value: words,
    ...(section.hide_when_ability ? { hide_when_ability: section.hide_when_ability } : {}) } : null;
}

/** The preview of a copy: its title and each field it carries, labelled from record-sharing.json. */
export function previewOf(copy) {
  const labels = sharing.fields[copy.kind] ?? {};
  return {
    title: copy.title ?? null,
    fields: Object.entries(copy.body ?? {}).flatMap(([id, value]) => Array.isArray(labels[id]?.sections)
      ? labels[id].sections.map(section => sectionPreview(value, id, section)).filter(Boolean)
      : [{ id, label: labels[id]?.label ?? id, value: shownValue(value, labels[id]) }]),
  };
}

export const recordSharingMethods = {
  sharingRowOf(ref) { return this.store.eeaf.read(rowId(ref)) ?? null; },
  shareLinksOf(ref) {
    return (this.sharingRowOf(ref)?.link_grants ?? []).map(({ code: _code, ...grant }) => ({
      ...grant,
      scope: grant.scope?.kind === 'code' ? { kind: 'code' } : grant.scope,
      ...(grant.sealed_copy ? { sealed_copy: { content_id: grant.sealed_copy.content_id } } : {}),
    }));
  },
  // Mixed links have their own owner records, rather than a file or workflow to reopen. Page only those
  // records by their indexed prefix, so a person can find and stop a link after closing its creation panel.
  collectionLinks({ before = null, limit = 16, origin = null } = {}) {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 32) throw new SharingError('Choose 1 to 32 links per page.');
    const prefix = `${KIND}:share-bundle:`;
    if (before !== null && (typeof before !== 'string' || !before.startsWith(prefix) || before.length > prefix.length + 64)) throw new SharingError('That share-link page is unavailable.');
    const ids = this.store.eeaf.ids(KIND, { prefix, ...(before === null ? {} : { before }), limit: limit + 1 });
    const links = ids.slice(0, limit).flatMap(id => {
      const row = this.store.eeaf.read(id);
      return (row?.link_grants ?? []).map(grant => ({
        share_id: grant.share_id,
        address: shareLinkAddress(origin, grant.address ?? grant.code),
        published: grant.published !== false,
        created_at: grant.created_at,
        expires_at: grant.expires_at ?? null,
        revoked_at: grant.revoked_at ?? null,
        entry_count: grant.collection?.entry_count ?? grant.entries?.length ?? 0,
        first_title: grant.entries?.[0]?.title ?? (grant.collection ? collectionEntryAtOrdinal(this.sql, grant.share_id, 0)?.title : null) ?? null,
        scope: grant.scope?.kind === 'code' ? { kind: 'code' } : grant.scope,
      }));
    });
    return { links, next_before: ids.length > limit ? ids[limit - 1] : null };
  },
  // The choices that cover the records linked to theirs (chain: true), read from the declared `chain` index
  // (record-indexes.json), so only the few that chose it are read. Until that index is built (its backfill runs in the
  // store's idle work) every sharing row is read, which answers the same.
  chainSharingRows() {
    const records = this.store.eeaf;
    const ids = records.indexReady(KIND, 'chain') ? records.scan(KIND, 'chain', { equal: [true] }).map(entry => entry.id) : records.ids(KIND, { all: true });
    return ids.map(id => records.read(id)).filter(row => hasChoice(row) && row.chain === true);
  },
  // Whether a chain rooted at a reaches b through declared links, read from the records themselves.
  recordsLinked(a, b) { return this.chainMembers(a).includes(b); },
  effectiveSharing(ref) {
    const own = this.sharingRowOf(ref);
    if (hasChoice(own)) return resolveSharing(ref, { own, chains: [], linked: () => false });
    const chains = this.chainSharingRows();
    if (!chains.length) return null;
    // A chain rooted at a reaches ref exactly when a is among the records chained to ref: a path between them has the
    // same stopping points walked from either end, so one walk from ref answers for every chain row.
    let around = null;
    return resolveSharing(ref, { own, chains, linked: root => (around ??= new Set(this.chainMembers(ref))).has(root) });
  },
  // The records that name `at` in a sharing link's field, from the scope link index (one row per link a record
  // carries, written in the same transaction as the record). While that index is still being built it is not trusted:
  // a record missing from it would leave a more private chain choice off, so every record of the kind is read instead.
  sharingLinkSources(at, kind) {
    const links = sharing.links.filter(link => link.to === kind);
    if (!links.length) return [];
    if (!this.scopeIndexed()) {
      return links.flatMap(link => this.store.eeaf.ids(link.from, { all: true }).filter(id => idsIn(pick(this.store.eeaf.read(id), link.field)).includes(at)));
    }
    // reads-ok: the links that name one record, through the scope link target index
    return this.scopeSql().exec('SELECT ref, kind, via FROM scope_links WHERE target = ? AND via IN (SELECT value FROM json_each(?))', at, JSON.stringify(unique(links.map(link => link.field.join('.')))))
      .toArray().filter(row => links.some(link => link.from === row.kind && link.field.join('.') === row.via)).map(row => row.ref);
  },
  // Walk each direction separately. Switching direction at an intermediate node would share siblings: for example
  // pursuit A -> decision citing A and B -> pursuit B. A visited set makes cycles finite without a depth limit.
  chainMembers(ref) {
    // This walk is synchronous. Resolve each visited current kind once while
    // walking both directions; a fresh walk reads every kind again.
    const kinds = new Map();
    const kindOf = id => {
      if (!kinds.has(id)) kinds.set(id, this.store.eeaf.typeOf(id));
      return kinds.get(id);
    };
    if (!kindOf(ref)) return [];
    const children = (at, direction) => {
      const kind = kindOf(at);
      if (!kind) return [];
      if (direction === 'forward') return linksFrom(kind, this.store.eeaf.read(at));
      return this.sharingLinkSources(at, kind);
    };
    const walk = direction => {
      const found = new Set([ref]);
      const queue = [ref];
      for (let index = 0; index < queue.length; index++) {
        if (queue[index] !== ref && hasChoice(this.sharingRowOf(queue[index]))) continue;
        for (const id of children(queue[index], direction)) {
          if (found.has(id) || !kindOf(id)) continue;
          found.add(id);
          queue.push(id);
        }
      }
      found.delete(ref);
      return found;
    };
    return unique([...walk('forward'), ...walk('backward')]);
  },
  // Whether a record goes into the network: its choice when it has one; else the account's (src/sharing-choice.mjs),
  // but only for a kind the account's choice covers (record-sharing.json places.network.follows_account). Any other
  // record with no choice of its own (a note, a file, a tool, a pursuit) stays with the person alone.
  networkMay(ref, record) {
    const chosen = this.effectiveSharing(ref)?.network;
    if (typeof chosen === 'boolean') return chosen;
    return FOLLOWS_ACCOUNT.has(this.store.eeaf.typeOf(ref)) && this.sharingOn(record ?? {});
  },
  // A record as the network's privacy rewrite reads it: without the fields its choice leaves out, and with each field it
  // shares to match only as its mark.
  withFieldsLeftOut(ref, record) {
    const { leave_out: leftOut, match_only: matchOnly, match } = this.copyShape(ref);
    if (!leftOut.length && !matchOnly.length) return record;
    return Object.fromEntries(Object.entries(record).filter(([field]) => !leftOut.includes(field)).map(([field, value]) => [field, matchOnly.includes(field) ? match(field, value) : value]));
  },
  // How copies of one record are cut: the fields its choice leaves out (or `leaveOut`, when a preview names them), the
  // fields it shares to match only, and the one function that marks them (src/share-match.mjs).
  copyShape(ref, leaveOut) {
    const chosen = this.effectiveSharing(ref);
    this.shareMatch ??= shareMatcher(this.env);
    return { leave_out: leaveOut ?? chosen?.leave_out ?? [], match_only: chosen?.match_only ?? [], match: this.shareMatch };
  },
  // One of the person's own records by its reference: from the record log, or, for a kind a Workshop tool keeps (a
  // sales contract, src/sales-contracts.mjs), its newest kept value, when share_from_private lets that kind be shared.
  ownRecord(ref) {
    const type = this.store.eeaf.typeOf(ref);
    if (type) return type === KIND ? null : { type, value: this.store.eeaf.read(ref) };
    const connection = this.connectionMetadataRecord?.(ref);
    if (connection) return connection;
    const kind = ref.slice(0, Math.max(0, ref.indexOf(':')));
    const value = settings.share_from_private[kind] ? this.workshopValue?.(ref) : null;
    return value && !value.removed_at ? { type: kind, value } : null;
  },
  // The copy others get of one record: the fields share_from_private lets out, less what its choice leaves out.
  // facts ({ now, opened }) is the moment a link reads it: a list's rows show only while their own rule holds then
  // (src/list-copy.mjs). Read without a link (the sharing sheet), it is now and no opens.
  async sharedCopy(ref, leaveOut, facts = { now: Date.now(), opened: 0 }) {
    // A folder (`folder:<path>`) shares only its own name: a link to it lets someone add files there (add_files),
    // never read what it already holds. The folder need not exist yet; the first file added makes it.
    if (ref.startsWith('folder:')) {
      const folder = folderOf(ref);
      if (!folder) throw new SharingError('A folder is named by its path from the top, like folder:/From clients.');
      return { kind: 'folder', private_ref: ref, title: folder === '/' ? 'Files' : folder.split('/').at(-1), body: { folder } };
    }
    const source = (sharing.source_references ?? []).find(row => ref.startsWith(row.prefix));
    if (source) {
      if (typeof this[source.copy_method] !== 'function') throw new SharingError('This shared source cannot be read.');
      return this[source.copy_method](ref);
    }
    if (ref.startsWith('file:')) return this.shareableRecord({ file: ref.slice('file:'.length) });
    // Tool references already carry the Workshop's canonical `tool:` id. Keep
    // that prefix when describing the owner tool; stripping it makes the live
    // Workshop lookup treat an existing own tool as missing.
    if (ref.startsWith('tool:')) return this.shareableRecord({ tool: ref });
    if (ref.startsWith('workflow:')) return this.shareableRecord({ record_id: ref });
    // One row of a list (`list:<id>:rows:<row id>`, record-sharing.json parts): the list's copy narrowed to that row,
    // so a single row goes by link or email with the same fields, rules and pages as its whole list.
    const part = partOf(ref);
    if (part) {
      const whole = await this.sharedCopy(part.whole, leaveOut, facts);
      // A saved view (`list:<id>:views:<view id>`): the rows that view keeps among the rows that already leave, read
      // through the same projection the app draws it with (src/list-copy.mjs shownViewRows).
      if (part.segment === 'views') return this.sharedViewCopy(ref, part, whole, facts);
      const rows = (whole.body?.rows ?? []).filter(row => row.id === part.id);
      if (!rows.length) throw new SharingError(`${ref} is not in your Trillion.`);
      const mediaFields = (whole.body?.fields ?? []).filter(field => field.media === true);
      const fileIds = new Set(rows.flatMap(row => mediaFields.flatMap(field => [row.values?.[field.id]].flat())));
      const rowIds = new Set(rows.map(row => row.id));
      const copy = { ...whole, private_ref: ref, title: rows[0].title ?? whole.title, body: { ...whole.body, rows,
        files: (whole.body?.files ?? []).filter(file => fileIds.has(file.identity)),
        ...(Array.isArray(whole.body?.shown_views) ? { shown_views: whole.body.shown_views.map(view => ({ ...view,
          row_ids: (view.row_ids ?? []).filter(id => rowIds.has(id)) })) } : {}) } };
      return Object.defineProperty(copy, 'counts_opens', { value: whole.counts_opens === true, enumerable: false });
    }
    const { type, value } = this.ownRecord(ref) ?? {};
    if (!value) throw new SharingError(`${ref} is not in your Trillion.`);
    // A list shares its rows with it: each row's values for the fields the list shows, never other values a tool
    // keeps on the same record (src/lists.mjs invariant 3).
    // Rows other owners keep (the account's own work, src/work-item-rows.mjs) leave like its own, by the same rules.
    const listed = type === sharing.list_kind ? await withRowSources(makeLists({ eeaf: this.store.eeaf }), this.listRowSources?.() ?? {}).read(ref) : null;
    if (listed) {
      const copied = await listCopy({ fields: listed.list.fields, rows: listed.rows, views: listed.list.views, share_when: listed.list.share_when, facts, filterRows: input => this.filterRowsByRules(input),
        fileOf: async name => {
          try { return (await this.shareableRecord({ file: name })).body; }
          catch (error) { if (error instanceof SharingError) return null; throw error; }
        } });
      const copy = shareableCopy(type, ref, { ...value, fields: copied.fields, rows: copied.rows, files: copied.files, shown_views: copied.shown_views }, this.copyShape(ref, leaveOut));
      // Whether this read counts as an open is for the link alone, so it never shows in the copy itself.
      return Object.defineProperty(copy, 'counts_opens', { value: copied.names_opened, enumerable: false });
    }
    const shareValue = type === 'plan' ? {
      ...value,
      progress: planRecords(this.store.eeaf).read(ref, { offset: Math.max(0, (value.progress_ids ?? []).length - 25), limit: 25 })?.progress
        .map(({ summary, status, step, at }) => ({ summary, status, step, at })) ?? [],
    } : value;
    return shareableCopy(type, ref, shareValue, this.copyShape(ref, leaveOut));
  },

  // One saved view of a list as a copy: the list's copy narrowed to the rows the view keeps (its order), headed by the
  // view's label. A view that is not in the list, or whose rules cannot be checked over the fields that leave, is not
  // there to share (src/list-copy.mjs invariant 5), never shown unfiltered.
  async sharedViewCopy(ref, part, whole, facts) {
    const listed = await withRowSources(makeLists({ eeaf: this.store.eeaf }), this.listRowSources?.() ?? {}).read(part.whole);
    const view = (listed?.list?.views ?? []).find(item => item?.id === part.id);
    if (!view) throw new SharingError(`${ref} is not in your Trillion.`);
    const kept = await shownViewRows({ view, fields: whole.body?.fields ?? [], rows: whole.body?.rows ?? [], facts, filterRows: input => this.filterRowsByRules(input) });
    if (!kept) throw new SharingError(`${ref} cannot be shown: its rules cannot be checked over the fields that are shared.`);
    const byId = new Map((whole.body?.rows ?? []).map(row => [row.id, row]));
    const rows = kept.map(id => byId.get(id)).filter(Boolean);
    const mediaFields = (whole.body?.fields ?? []).filter(field => field.media === true);
    const fileIds = new Set(rows.flatMap(row => mediaFields.flatMap(field => [row.values?.[field.id]].flat())));
    const copy = { ...whole, private_ref: ref, title: view.label ?? whole.title, body: { ...whole.body, rows,
      files: (whole.body?.files ?? []).filter(file => fileIds.has(file.identity)),
      shown_views: view.display?.as ? [{ id: view.id, label: view.label, display: view.display, row_ids: rows.map(row => row.id) }] : [] } };
    return Object.defineProperty(copy, 'counts_opens', { value: whole.counts_opens === true, enumerable: false });
  },

  // The facts src/network-identity.mjs derives this Trillion's network from: the address it serves under, and whether
  // the person's files are kept in storage they attached (the Namespace's own attached origins, read through its owner).
  // A store that cannot say (no Namespace owner here, or its read failed) has no attached-storage fact, which decides
  // nothing (network-identity invariant 2): the sheet still opens and says the network the address alone shows.
  async networkFacts(origin) {
    const attached = typeof this.namespaceAttachedOrigins === 'function' ? await this.namespaceAttachedOrigins().catch(() => null) : null;
    return { origin: serviceOrigin(origin), attached_storage: Array.isArray(attached) && attached.some(row => row.marker !== 'read-only') };
  },

  // The sharing sheet for one record: the copy others would see, its fields with which are left out, every place it
  // can go with which are chosen, and the chain switch where its kind links to others.
  async sharingSheet(ref) {
    // A record only the person's devices can open (parts/sealed-records) has no copy to share: its sheet is the one
    // switch that opens it again, on a device that holds the key.
    if (this.store.eeaf.typeOf(ref) === SEALED_TYPE) {
      return { thing: { record: ref, kind: SEALED_TYPE, title: null }, preview: { title: null, fields: [] }, fields: [], places: [], links: this.shareLinksOf(ref), abilities: [], abilities_given: [], link_roles: [...SEALED_ROLES.values()].filter(row => row.granted_by_link).map(({ id, label, can }) => ({ id, label, can })), chain: null, inherited_from: null, match_asks: [], sealed: sealedSwitch(true, null), link_words: sharing.sealed.link_words };
    }
    const copy = await this.sharedCopy(ref);
    // A part (one row of a list) goes by link or email only; its whole is what goes into spaces and the network.
    const part = partOf(ref);
    const own = this.sharingRowOf(ref);
    const effective = this.effectiveSharing(ref);
    const relay = this.relay();
    const network = this.network();
    const [{ destinations, all_destinations: every }, { people }, { spaces: holding }] = await Promise.all([this.shareDestinationsOwner().read(), network.peopleKnown({ relay }), network.spacesHolding({ relay, private_ref: ref })]);
    // Spaces in the person's one share list (src/share-destinations.mjs): the ones they show, in their order, and any
    // hidden one this record is in now.
    const spaces = every.filter(place => place.to.space_id && (destinations.some(shown => shown.id === place.id) || holding.includes(place.to.space_id))).map(place => ({ space_id: place.to.space_id, title: place.label }));
    const value = this.ownRecord(ref)?.value ?? (copy.kind === 'workflow' ? copy.body : null);
    const leftOut = effective?.leave_out ?? [];
    const matchOnly = effective?.match_only ?? [];
    const chosenSpaces = new Set(holding);
    const chosenPeople = new Set(effective?.people ?? []);
    const rule = settings.share_from_private[copy.kind];
    const labels = sharing.fields[copy.kind] ?? {};
    const chainable = !part && sharing.links.some(link => link.from === copy.kind || link.to === copy.kind) && Boolean(sharing.chain[copy.kind]);
    return {
      thing: { record: ref, kind: copy.kind, title: copy.title ?? copy.body?.name ?? null },
      preview: previewOf(copy),
      fields: rule ? rule.fields.filter(id => value?.[id] !== undefined).map(id => ({ id, label: labels[id]?.label ?? id, included: !leftOut.includes(id), match_only: matchOnly.includes(id) })) : [],
      places: part ? [] : [
        { id: 'network', to: { network: true }, label: sharing.places.network.label, icon: sharing.places.network.icon, picked: this.networkMay(ref, value) },
        ...spaces.map(space => ({ id: `space ${space.space_id}`, to: { space_id: space.space_id }, label: space.title, icon: sharing.places.space.icon, picked: chosenSpaces.has(space.space_id) })),
        ...people.map(person => ({ id: `person ${person.relay}`, to: { person: person.relay }, label: `${person.name}, ${person.in}`, icon: sharing.places.person.icon, picked: chosenPeople.has(person.relay) })),
      ],
      links: this.shareLinksOf(ref),
      // What a link to this may let its recipient do (record-sharing.json abilities), in their order, and the ones a new
      // link carries when none are named: the sheet's roles.
      abilities: abilitiesOffered(copy.kind).map(id => ABILITIES.get(id)).filter(Boolean).map(({ id, label, icon }) => ({ id, label, icon })),
      abilities_given: abilitiesGiven(copy.kind),
      chain: chainable ? { label: sharing.chain[copy.kind], on: own?.chain === true } : null,
      inherited_from: effective?.inherited ? { record: effective.from, title: (await this.sharedCopy(effective.from).catch(() => null))?.title ?? null } : null,
      // Every value someone checked against a field shared to match only, newest first (src/share-match.mjs matchAsks).
      match_asks: this.keptAsks().of(ref),
      // Which network this Trillion is on, and which of links, email shares, the network and spaces others can reach
      // from it (src/network-identity.mjs), so the sheet says up front what nobody else could open.
      network_reach: networkReach(await this.networkFacts(null)),
      // Whether this record can be made one only the person's devices open: a kind record-copies.json lets a device
      // seal, and in no space, with no person and no open link, since a sealed record has no copy for anyone else. The
      // network takes nothing from a sealed record (it has no shareable copy), so the network choice never blocks it.
      sealed: sealable.has(copy.kind) && !part ? sealedSwitch(false, holding.length || (effective?.people ?? []).length || this.shareLinksOf(ref).some(link => !link.revoked_at) ? sharing.sealed.shared_first : null) : null,
    };
  },

  // The copy with other fields left out, for the sheet while the person toggles fields: the same copy a share makes.
  async previewSharing(ref, leaveOut) {
    return { preview: previewOf(await this.sharedCopy(ref, strings(leaveOut, 'leave_out') ?? [])) };
  },
  // The mark a value would carry in a copy that shares `field` to match only, so a person or their AI can tell whether a
  // value they already know is the one a shared copy holds, without the copy ever showing it (src/share-match.mjs).
  // Whether a value someone already knows is the one a copy shared with them holds in a field shared to match only.
  // The question goes to the record's owner, who answers it and keeps who asked (answerMatch), so a value is never
  // tested against a copy without its owner seeing it. `space_id` with `item_id` names a space's copy; `offer_id` one
  // shared with this person.
  async matchSharedValue({ space_id: spaceId, item_id: itemId, offer_id: offerId, field, value } = {}) {
    if (typeof field !== 'string' || !field.trim()) throw new SharingError('Name the field the value is in.');
    if (value === undefined) throw new SharingError('Give the value to compare.');
    const relay = this.relay();
    const network = this.network();
    let source;
    if (typeof offerId === 'string' && offerId) {
      const offer = await network.openOffer({ relay, offer_id: offerId });
      source = { person_ref: offer.person_ref, private_ref: offer.private_ref, asker: { relay, name: offer.to }, place: { person: relay } };
    } else if (typeof spaceId === 'string' && spaceId && typeof itemId === 'string' && itemId) {
      const found = await network.matchSourceOf({ relay, space_id: spaceId, item_id: itemId });
      source = { ...found, place: { space_id: spaceId } };
    } else throw new SharingError('Name the shared copy: space_id with item_id, or offer_id.');
    const owner = this.env.PERSON.get(this.env.PERSON.idFromString(source.person_ref));
    return owner.answerMatch({ private_ref: source.private_ref, place: source.place, asker: source.asker, field: field.trim(), value });
  },

  // The owner's side: answers whether `value` is what its record holds in a field it shares to match only with that
  // place, and keeps the question in match_asks first, whatever the answer (keptAsk).
  async answerMatch({ private_ref: ref, place, asker, field, value }) {
    const effective = this.effectiveSharing(String(ref ?? ''));
    const shared = place?.space_id ? effective?.spaces.includes(place.space_id) : effective?.people.includes(place?.person);
    if (!shared) throw new SharingError(sharing.refused.not_shared_here);
    if (!(effective.match_only ?? []).includes(field)) throw new SharingError(`${field} is not shared to match only, so there is nothing to check it against.`);
    const own = this.ownRecord(ref)?.value?.[field];
    this.shareMatch ??= shareMatcher(this.env);
    const matched = own !== undefined && this.shareMatch(field, own).match === this.shareMatch(field, value).match;
    this.keptAsks().ask({ record: ref, field, asker: asker?.name ?? 'Someone', asker_relay: asker?.relay ?? null, place: place.space_id ?? 'person', matched });
    return { field, matched };
  },
  keptAsks() {
    this.matchAsks ??= matchAsks(this.quietSql ?? this.sql);
    return this.matchAsks;
  },

  // Keeps a choice for one record and makes every copy match it (invariant 4). Omitted parts keep what is in force.
  async setRecordSharing(ref, input = {}) {
    // Reserve the owner's order before any projection or Network read can yield to a newer choice.
    const intentOrder = this.nextSpaceShareIntentOrder();
    const startedRevision = this.sharingRowOf(ref)?.choice_revision ?? null;
    const copy = await this.sharedCopy(ref);
    const relay = this.relay();
    const network = this.network();
    const [{ spaces: mine }, { people: known }, { spaces: holding }] = await Promise.all([network.spaces({ relay }), network.peopleKnown({ relay }), network.spacesHolding({ relay, private_ref: ref })]);
    const now = this.effectiveSharing(ref);
    if (input.network !== undefined && input.network !== null && typeof input.network !== 'boolean') throw new SharingError('network is true, false or null.');
    const spaces = strings(input.spaces, 'spaces') ?? holding;
    const people = strings(input.people, 'people') ?? now?.people ?? [];
    const leaveOut = strings(input.leave_out, 'leave_out') ?? now?.leave_out ?? [];
    const matchOnly = strings(input.match_only, 'match_only') ?? now?.match_only ?? [];
    const spaceIds = new Set(mine.map(space => space.space_id));
    const relays = new Set(known.map(person => person.relay));
    if (spaces.some(id => !spaceIds.has(id)) || people.some(id => !relays.has(id))) throw new SharingError(sharing.refused.unknown_place);
    const fields = settings.share_from_private[copy.kind]?.fields ?? [];
    const stray = [...leaveOut, ...matchOnly].filter(id => !fields.includes(id));
    if (stray.length) throw new SharingError(`${stray.join(', ')} ${stray.length === 1 ? 'is not a field' : 'are not fields'} a ${copy.kind} shares.`);
    const both = matchOnly.filter(id => leaveOut.includes(id));
    if (both.length) throw new SharingError(`${both.join(', ')} cannot be both left out and shared to match only.`);
    if (matchOnly.length) (this.shareMatch ??= shareMatcher(this.env))('check', '');
    const chain = input.chain === undefined ? this.sharingRowOf(ref)?.chain === true : input.chain === true;
    const members = this.chainMembers(ref);
    const startedMemberRevisions = new Map(members.map(member => [member, this.sharingRowOf(member)?.choice_revision ?? null]));
    const records = [ref, ...members];
    const previouslyShared = new Map(records.map(record => [record, this.effectiveSharing(record)?.spaces ?? []]));
    // Records shared one by one before a chain came around them keep that as their own choice (invariant 5).
    const preserved = [];
    if (chain) for (const member of members) {
      if (hasChoice(this.sharingRowOf(member)) || this.effectiveSharing(member)) continue;
      const { spaces: held } = await network.spacesHolding({ relay, private_ref: member });
      if (held.length) preserved.push({ member, held });
    }
    // The Network sees this fence before the owner changes the live choice. An older batch may finish before the
    // fence, while the old choice is still in force, or after it, when the old bytes are refused at the writer.
    if (this.sharingChoiceSuperseded(ref, startedRevision, intentOrder)) throw new SharingError('Sharing changed while this choice was being saved. Read it again.');
    const affected = [ref, ...members];
    for (let start = 0; start < affected.length; start += 1000) {
      await network.fencePrivateShareIntents({ relay, private_refs: affected.slice(start, start + 1000), intent_order: intentOrder });
    }
    // The fence call yields. A later choice may have committed while it was in flight; an older answer must not
    // overwrite that choice, including a member's independent choice when this is a chain.
    if (this.sharingChoiceSuperseded(ref, startedRevision, intentOrder)
      || members.some(member => this.sharingChoiceSuperseded(member, startedMemberRevisions.get(member), intentOrder))) {
      throw new SharingError('Sharing changed while this choice was being saved. Read it again.');
    }
    for (const { member, held } of preserved) if (!hasChoice(this.sharingRowOf(member))) {
      this.keepSharing(member, { network: null, spaces: held, people: [], chain: false, leave_out: [] }, crypto.randomUUID(), intentOrder);
    }
    this.keepSharing(ref, { network: input.network === undefined ? (now?.inherited ? now.network : this.sharingRowOf(ref)?.network ?? null) : input.network, spaces, people, chain, leave_out: leaveOut, match_only: matchOnly }, crypto.randomUUID(), intentOrder);
    for (const record of records) await this.applySharing(record, previouslyShared.get(record), intentOrder);
    return this.sharingSheet(ref);
  },

  sharingChoiceSuperseded(ref, startedRevision, intentOrder) {
    const latest = this.sharingRowOf(ref);
    if ((latest?.choice_revision ?? null) === startedRevision) return false;
    // A newer request may have started later but committed after this request yielded. An older request that happened
    // to finish first must not force the newer one to lose its choice.
    return !Number.isSafeInteger(latest?.owner_intent_order) || latest.owner_intent_order >= intentOrder;
  },

  sharingIntentOvertaken(ref, intentOrder) {
    const effective = this.effectiveSharing(ref);
    const choice = this.sharingRowOf(effective?.from ?? ref);
    return Number.isSafeInteger(choice?.owner_intent_order) && choice.owner_intent_order > intentOrder;
  },

  keepSharing(ref, choice, revision = crypto.randomUUID(), intentOrder = null) {
    const prior = this.sharingRowOf(ref);
    this.store.eeaf.write([{ id: rowId(ref), type: KIND, value: { record: ref, ...choice, choice_made: true, ...(prior?.link_grants ? { link_grants: prior.link_grants } : {}), ...(intentOrder === null ? (prior?.owner_intent_order === undefined ? {} : { owner_intent_order: prior.owner_intent_order }) : { owner_intent_order: intentOrder }), changed_at: new Date().toISOString(), choice_revision: revision } }], { actor: { by: 'person' } });
  },

  nextSpaceShareIntentOrder() {
    const name = 'space-share-intent-order';
    const earlier = this.fact(name) ?? 0;
    if (!Number.isSafeInteger(earlier) || earlier < 0 || earlier === Number.MAX_SAFE_INTEGER) throw new SharingError('This pursuit cannot keep another share order.');
    const order = earlier + 1;
    this.setFact(name, order);
    return order;
  },

  // The count is fixed when a nested link is added. A published collection cannot gain more entries;
  // revocation and expiry remain live checks on every later read.
  async shareEntryLeaves(entry, seen = new Set(), counts = new Map()) {
    if (entry.kind !== 'share') return 1;
    if (seen.has(entry.code)) throw new SharingError('This share contains a circular nested link.');
    if (counts.has(entry.code)) return counts.get(entry.code);
    const { index, grant } = await this.recordShareGrant(entry.code);
    if (index.person_ref !== this.ctx?.id?.toString?.()) throw new SharingError('A nested share must belong to this Trillion and still be open.');
    if (grant.collection) {
      counts.set(entry.code, grant.collection.leaf_count);
      return grant.collection.leaf_count;
    }
    const entries = entriesInGrant(grant, index);
    let leaves = 0;
    for (const child of entries) {
      leaves += await this.shareEntryLeaves(child, new Set(seen).add(entry.code), counts);
      if (!Number.isSafeInteger(leaves)) throw new SharingError('This share has too many items to index safely.');
    }
    counts.set(entry.code, leaves);
    return leaves;
  },

  // One external grant is stored beside the private sharing choice, without changing that choice. The opaque code is
  // indexed to the owning person in APP_KV so a public route can find this store; the store row itself remains the
  // authority for expiry, recipient match, revocation and the current sharing choice.
  async createRecordShare(ref, { scope, expires_at: expiresAt = null, records = [], items = [], origin = null, can = null, when = null, time_zone: timeZone = null, look = null, address = null, listed = false, publish = true, expected_total: expectedTotal = null, sealed_copy: sealedCopy = null, role = null } = {}) {
    if (ref !== null && (typeof ref !== 'string' || !ref)) throw new SharingError('Name the first record to share, or use a collection with items.');
    if (!Array.isArray(records) || records.length > 99 || records.some(item => typeof item !== 'string' || !item)) throw new SharingError('records is a list of at most 99 additional records.');
    if (!Array.isArray(items) || items.length > COLLECTION_BATCH_LIMIT) throw new SharingError('items is a list of at most 100 share items.');
    if (typeof publish !== 'boolean') throw new SharingError('publish is true or false.');
    if (!publish && (!Number.isSafeInteger(expectedTotal) || expectedTotal < 1)) throw new SharingError('expected_total is the number of chosen items before making a draft link.');
    const normalizedItems = items.map(shareItem);
    const inline = normalizedItems.filter(item => item.kind !== 'record');
    const itemRefs = normalizedItems.filter(item => item.kind === 'record').map(item => item.record);
    const refs = unique([...(ref ? [ref] : []), ...records, ...itemRefs]);
    if (!refs.length && !inline.length) throw new SharingError('Choose at least one item to share.');
    if (refs.length + inline.length > 100) throw new SharingError('Choose at most 100 items for one link.');
    // Resolve every item before making the grant. The owner keeps references, not duplicate file bytes.
    const sealedRef = Boolean(ref) && this.store.eeaf.typeOf(ref) === SEALED_TYPE;
    const sealedLink = sealedRef || sealedCopy !== null ? sealedLinkOf({ sealedRef, refs, inline, sealedCopy, role, can }) : null;
    if (sealedLink) {
      if (listed === true) throw new SharingError(sharing.sealed.not_listed);
      can = sealedLink.can;
    }
    else if (role !== null) throw new SharingError(sharing.sealed.not_sealed_record);
    const kinds = sealedLink ? [SEALED_TYPE] : [];
    const titles = sealedLink ? [null] : [];
    for (const item of sealedLink ? [] : refs) { const copy = await this.sharedCopy(item); kinds.push(copy.kind); titles.push(copy.title); }
    const owner = this.ctx?.id?.toString?.();
    if (!owner || !this.env?.APP_KV?.put) throw new SharingError('The share link could not be indexed by its owner.');
    for (const nested of inline.filter(item => item.kind === 'share')) {
      const found = await this.recordShareGrant(nested.code).catch(() => null);
      if (!found || found.index.person_ref !== owner) throw new SharingError('A nested share must belong to this Trillion and still be open.');
    }
    if (!scope || !['public', 'private', 'email', 'phone', 'code'].includes(scope.kind)) throw new SharingError('scope.kind is public, private, email, phone or code.');
    const value = typeof scope.value === 'string' ? scope.value.trim() : '';
    if (scope.kind === 'private' && !value) throw new SharingError('A private share names the recipient account relay.');
    if (scope.kind === 'email' && (!value || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalEmail(value)))) throw new SharingError('An email share needs a valid recipient email.');
    if (scope.kind === 'phone' && !/^\+[1-9]\d{7,14}$/.test(normalPhone(value))) throw new SharingError('A phone share needs the recipient number in international format.');
    if (scope.kind === 'code' && value.length < 8) throw new SharingError('A code share needs a code with at least 8 characters.');
    if (scope.kind === 'public' && scope.value !== undefined) throw new SharingError('A public share does not take a recipient value.');
    let until = null;
    if (expiresAt !== null && expiresAt !== undefined) {
      if (typeof expiresAt !== 'string') throw new SharingError('expires_at must be a future time, or null for no expiry.');
      const instant = Date.parse(expiresAt);
      if (!Number.isFinite(instant) || instant <= Date.now()) throw new SharingError('expires_at must be a future time, or null for no expiry.');
      until = new Date(instant).toISOString();
    }
    // What the link lets its recipient do: the abilities its kind may carry (record-sharing.json abilities), the kind's
    // given ones when the sharer names none. A link to several things carries only what every one of them offers.
    const offered = unique([...kinds, ...(inline.length || !kinds.length ? ['default'] : [])]).map(kind => abilitiesOffered(kind)).reduce((common, list) => common.filter(id => list.includes(id)));
    const abilities = can === null || can === undefined ? (unique(kinds).length === 1 && !inline.length ? abilitiesGiven(kinds[0]) : ['view']).filter(id => offered.includes(id)) : strings(can, 'can');
    if (!abilities.includes('view')) throw new SharingError('A link always lets its recipient see what it shares: include view in can.');
    const unoffered = abilities.filter(id => !ABILITIES.has(id) || !offered.includes(id));
    if (unoffered.length) throw new SharingError(`A link to this cannot let someone ${unoffered.join(', ')}. It can: ${offered.join(', ')}.`);
    let condition = null;
    if (when !== null && when !== undefined) {
      if (!when || typeof when !== 'object' || Array.isArray(when)) throw new SharingError('when is a rule tree: { kind: "group", combinator, rules: [{ kind: "rule", field, operator, params }] }.');
      const { binding, incomplete } = compileRules(when, { fields: WHEN_FIELDS, vocabulary: WHEN_VOCABULARY });
      if (!binding || incomplete.length) throw new SharingError(`when names a fact or comparison a link cannot check. Its facts are: ${sharing.when_facts.map(fact => `${fact.id} (${fact.kind})`).join(', ')}.`);
      condition = structuredClone(when);
    }
    const zoneError = zoneProblem(condition, timeZone);
    if (zoneError) throw new SharingError(zoneError);
    if (look !== null && look !== undefined && !['own', 'trillion'].includes(look)) throw new SharingError('look is own (your brand) or trillion.');
    if (listed !== false && listed !== true) throw new SharingError('listed is true or false.');
    if (listed && scope.kind !== 'public') throw new SharingError(sharing.addresses.listed_needs_public);
    if (address !== null && address !== undefined && (typeof address !== 'string' || !ADDRESS.test(address) || LOOKS_LIKE_CODE.test(address))) throw new SharingError(sharing.addresses.refused);
    const shareId = token(16);
    const root = ref || `share-bundle:${shareId}`;
    // The link's own code is a secret name (src/readable-names.mjs): words, as hard to guess as a random code, and never
    // one a name or another code already holds in the one name list.
    let code = secretName();
    while (await this.env.APP_KV.get(`${LINK_INDEX}${code}`)) code = secretName();
    // The address (record-sharing.json addresses): the one the sharer chose, else for a public link the shared thing's
    // first words, then those words with a word from the list when they are taken. A link for one recipient keeps only
    // its secret name unless the sharer names it.
    const named = typeof address === 'string' ? address : null;
    const firstWords = titles.find(title => typeof title === 'string' && title.trim()) ?? inline.find(item => item.title)?.title ?? null;
    const base = named ?? (scope.kind === 'public' ? addressFromWords(firstWords) ?? randomWords(2).join('-') : null);
    // A draft never takes a public name away from an existing live link. Claim it only at publication.
    const claimed = publish && base ? await this.claimShareAddress(base, { owner, record: root, chosen: Boolean(named) }) : null;
    const row = this.sharingRowOf(root) ?? { record: root, choice_made: false, network: null, spaces: [], people: [], chain: false, leave_out: [], changed_at: new Date().toISOString() };
    const entries = ref
      ? [...refs.map(record => ({ kind: 'record', record })), ...inline]
      : normalizedItems;
    if (!publish && expectedTotal < entries.length) throw new SharingError('expected_total cannot be less than the first batch.');
    const leafCounts = [];
    const counts = new Map();
    for (const entry of entries) leafCounts.push(await this.shareEntryLeaves(entry, new Set(), counts));
    // Inline grants predate paged collections. Keep each nested occurrence's size as well so withdrawing a child
    // cannot move a later sibling's public index. Paged grants keep these counts in their SQL pages instead.
    const keptEntries = publish ? entries.map((entry, at) => entry.kind === 'share' ? { ...entry, leaf_count: leafCounts[at] } : entry) : entries;
    const grant = { share_id: shareId, code, ...(publish ? { ...(refs.length ? { records: refs } : {}), ...(inline.length ? { items: inline } : {}), entries: keptEntries } : { published: false, expected_total: expectedTotal, ...(base ? { pending_address: base, pending_address_chosen: Boolean(named) } : {}) }), scope: { kind: scope.kind, ...(scope.kind === 'public' ? {} : { value: scope.kind === 'email' ? normalEmail(value) : scope.kind === 'phone' ? normalPhone(value) : value }) }, can: abilities, ...(condition ? { when: condition, ...(namesFact(condition, 'opened') ? { counts_opens: true } : {}) } : {}), ...(look ? { look } : {}), ...(timeZone ? { time_zone: timeZone } : {}), created_at: new Date().toISOString(), expires_at: until, revoked_at: null, ...(claimed ? { address: claimed } : {}), ...(listed ? { listed: true } : {}), ...(sealedLink ? { sealed_copy: sealedLink.copy, role: sealedLink.role } : {}) };
    await this.env.APP_KV.put(`${LINK_INDEX}${code}`, JSON.stringify({ person_ref: owner, record: root, share_id: shareId }));
    try {
      if (!publish) openCollectionStore(this.sql);
      this.transaction(() => {
        if (!publish) grant.collection = appendCollectionPages(this.sql, shareId, entries, leafCounts, { pageCount: 0, entryCount: 0, leafCount: 0 });
        this.store.eeaf.write([{ id: rowId(root), type: KIND, value: { ...row, link_grants: [...(row.link_grants ?? []), grant], changed_at: new Date().toISOString() } }], { actor: { by: 'person' } });
      });
    } catch (error) {
      await this.env.APP_KV.delete(`${LINK_INDEX}${code}`).catch(() => {});
      throw error;
    }
    if (claimed) {
      // A failed grant write must leave the old named link live. Move the name only after the new grant exists.
      const earlier = await this.env.APP_KV.get(`${LINK_INDEX}${claimed}`, 'json');
      if (earlier?.person_ref && (earlier.person_ref !== owner || !named && earlier.record !== root)) throw new SharingError(sharing.addresses.taken);
      await this.env.APP_KV.put(`${LINK_INDEX}${claimed}`, JSON.stringify({ person_ref: owner, record: root, share_id: shareId, code }));
      if (earlier?.person_ref === owner && earlier.share_id && earlier.share_id !== shareId) {
        try { await this.revokeRecordShare(earlier.record, earlier.share_id); }
        catch (error) {
          // The old grant is still open when its revoke transaction fails. Restore its address before
          // reporting failure, and end the new code so a retry does not leave a second live link.
          await this.env.APP_KV.put(`${LINK_INDEX}${claimed}`, JSON.stringify(earlier));
          await this.revokeRecordShare(root, shareId).catch(() => null);
          throw error;
        }
      }
    }
    if (listed && publish) await this.env.APP_KV.put(`${RECORD_SHARE_LISTED_INDEX}${claimed}`, JSON.stringify({ person_ref: owner, record: root, share_id: shareId, listed_at: grant.created_at }));
    try { recordCommercialEvent(this.store.eeaf, { event_id: `share-${shareId}-created`, event: 'share_created', subject_kind: refs.length ? 'record' : 'collection', subject_id: root }); }
    catch { /* The link is already live. Analytics cannot turn its successful creation into an error. */ }
    return { share_id: shareId, code, record: root, address: shareLinkAddress(origin, claimed ?? code), ...(claimed ? { name: claimed } : {}), ...(listed ? { listed: true } : {}), scope: grant.scope, can: grant.can, ...(grant.when ? { when: grant.when } : {}), ...(grant.look ? { look: grant.look } : {}), created_at: grant.created_at, expires_at: until, published: publish, entry_count: entries.length, ...(sealedLink ? { role: sealedLink.role, content_id: sealedLink.copy.content_id } : {}) };
  },

  // A large selection is sent in bounded batches. expected_count is the first ordinal of this batch;
  // replaying the same batch is harmless, while a different concurrent edit must be retried from its new count.
  async appendRecordShare(ref, shareId, { items, expected_count: expectedCount } = {}) {
    if (!Array.isArray(items) || !items.length || items.length > COLLECTION_BATCH_LIMIT) throw new SharingError('Choose 1 to 100 items for this batch.');
    if (!Number.isSafeInteger(expectedCount) || expectedCount < 0) throw new SharingError('expected_count must be the item count before this batch.');
    const entries = items.map(shareItem);
    const row = this.sharingRowOf(ref);
    const grant = row?.link_grants?.find(item => item.share_id === shareId);
    if (!grant?.collection || grant.published !== false || grant.revoked_at) throw new SharingError('This share is not open for more items.');
    if (grant.expires_at && Date.parse(grant.expires_at) <= Date.now()) throw new SharingError('This share link has ended.');
    if (expectedCount < grant.collection.entry_count && expectedCount + entries.length <= grant.collection.entry_count) {
      const repeated = entries.every((entry, index) => JSON.stringify(collectionEntryAtOrdinal(this.sql, shareId, expectedCount + index)) === JSON.stringify(entry));
      if (repeated) return { share_id: shareId, ...grant.collection, published: false };
    }
    if (expectedCount !== grant.collection.entry_count) throw new SharingError(`This share now has ${grant.collection.entry_count} items. Retry from that count.`);
    if (expectedCount + entries.length > grant.expected_total) throw new SharingError('This batch exceeds the number of items chosen for the link.');
    const leafCounts = [];
    const counts = new Map();
    for (const entry of entries) {
      if (entry.kind === 'record') {
        const copy = await this.sharedCopy(entry.record);
        if ((grant.can ?? []).some(ability => !abilitiesOffered(copy.kind).includes(ability))) throw new SharingError('This item cannot carry all the link abilities.');
      } else if ((grant.can ?? []).some(ability => !abilitiesOffered('default').includes(ability))) {
        throw new SharingError('This item cannot carry all the link abilities.');
      }
      leafCounts.push(await this.shareEntryLeaves(entry, new Set(), counts));
    }
    openCollectionStore(this.sql);
    return this.transaction(() => {
      const latest = this.sharingRowOf(ref);
      const current = latest?.link_grants?.find(item => item.share_id === shareId);
      if (!current?.collection || current.published !== false || current.revoked_at || (current.expires_at && Date.parse(current.expires_at) <= Date.now()) || current.collection.entry_count !== expectedCount) throw new SharingError('This share changed or ended while these items were being added.');
      const collection = appendCollectionPages(this.sql, shareId, entries, leafCounts, {
        pageCount: current.collection.page_count, entryCount: current.collection.entry_count, leafCount: current.collection.leaf_count,
      });
      this.store.eeaf.write([{ id: rowId(ref), type: KIND, value: {
        ...latest, link_grants: latest.link_grants.map(item => item.share_id === shareId ? { ...item, collection } : item), changed_at: new Date().toISOString(),
      } }], { actor: { by: 'person' } });
      return { share_id: shareId, ...collection, published: false };
    });
  },

  async publishRecordShare(ref, shareId, { origin = null } = {}) {
    const row = this.sharingRowOf(ref);
    const grant = row?.link_grants?.find(item => item.share_id === shareId);
    if (!grant?.collection || grant.revoked_at) throw new SharingError('This share is unavailable.');
    if (grant.expires_at && Date.parse(grant.expires_at) <= Date.now()) throw new SharingError('This share link has ended.');
    if (grant.collection.entry_count !== grant.expected_total) throw new SharingError(`This share has ${grant.collection.entry_count} of ${grant.expected_total} chosen items. Add the rest before opening the link.`);
    const owner = this.ctx.id.toString();
    const claimed = grant.published ? grant.address ?? null : grant.pending_address
      ? await this.claimShareAddress(grant.pending_address, { owner, record: ref, chosen: grant.pending_address_chosen }) : null;
    const holder = claimed ? await this.env.APP_KV.get(`${LINK_INDEX}${claimed}`, 'json') : null;
    if (holder && (holder.person_ref !== owner || !grant.pending_address_chosen && holder.record !== ref)) throw new SharingError(sharing.addresses.taken);
    const replaces = grant.replaces ?? (holder?.share_id && holder.share_id !== shareId
      ? { record: holder.record, share_id: holder.share_id } : null);
    const committed = grant.published ? { address: grant.address ?? null, replaces: grant.replaces ?? null } : this.transaction(() => {
      const latest = this.sharingRowOf(ref);
      const current = latest?.link_grants?.find(item => item.share_id === shareId);
      if (!current?.collection || current.revoked_at || (current.expires_at && Date.parse(current.expires_at) <= Date.now())) throw new SharingError('This share is unavailable.');
      if (current.published) return { address: current.address ?? null, replaces: current.replaces ?? null };
      this.store.eeaf.write([{ id: rowId(ref), type: KIND, value: {
        ...latest, link_grants: latest.link_grants.map(item => item.share_id === shareId ? { ...item, published: true, ...(claimed ? { address: claimed } : {}), ...(replaces ? { replaces } : {}), pending_address: undefined, pending_address_chosen: undefined } : item), changed_at: new Date().toISOString(),
      } }], { actor: { by: 'person' } });
      return { address: claimed, replaces };
    });
    if (committed.address) await this.env.APP_KV.put(`${LINK_INDEX}${committed.address}`, JSON.stringify({ person_ref: owner, record: ref, share_id: shareId, code: grant.code }));
    if (committed.replaces) await this.revokeRecordShare(committed.replaces.record, committed.replaces.share_id);
    if (grant.listed && committed.address) await this.env.APP_KV.put(`${RECORD_SHARE_LISTED_INDEX}${committed.address}`, JSON.stringify({ person_ref: owner, record: ref, share_id: shareId, listed_at: grant.created_at }));
    return { share_id: shareId, entry_count: grant.collection.entry_count, published: true, address: shareLinkAddress(origin, committed.address ?? grant.code), ...(committed.address ? { name: committed.address } : {}) };
  },

  // A link made for one email address is told to that address: one email drawn by the shared email part and sent by
  // the one sender (src/mail-sender.mjs), in the words record-sharing.json `delivery` keeps for the record's kind, from
  // the sharer's name and replying to the sharer's own email. The email names what was shared, never its contents:
  // the recipient proves that address with a one-time code, so a private price stays behind the link's own check.
  async sendRecordShare(ref, shareId, { note = null, origin = null } = {}) {
    const row = this.sharingRowOf(ref);
    const grant = row?.link_grants?.find(item => item.share_id === shareId);
    if (!grant || grant.published === false || grant.revoked_at || (grant.expires_at && Date.parse(grant.expires_at) <= Date.now())) throw new SharingError('That share link is not open on this record.');
    if (grant.scope?.kind !== 'email') throw new SharingError('Only a link made for one email address can be emailed. Make the link for their email address first.');
    // An email would hand someone an address they cannot open when nobody else can reach this Trillion.
    const reach = featureReach(networkIdentityOf(await this.networkFacts(origin)), 'share_by_email');
    if (reach.refused) throw new SharingError(reach.reason);
    if (note !== null && (typeof note !== 'string' || note.length > 2000)) throw new SharingError('note is your own words to them, at most 2000 characters.');
    const entries = grant.collection ? null : grant.entries ?? (grant.records ?? [ref]).map(record => ({ kind: 'record', record }));
    const entryCount = grant.collection?.leaf_count ?? entries.length;
    const first = entryCount === 1 ? (grant.collection ? collectionEntryAtOrdinal(this.sql, shareId, 0) : entries[0]) : null;
    const copy = first?.kind === 'record' ? await this.sharedCopy(first.record) : null;
    const kind = entryCount === 1 ? copy?.kind ?? null : null;
    const words = sharing.delivery[kind] ?? sharing.delivery.default;
    const sender = shownName(await this.accountName()) ?? sharing.delivery.someone;
    const title = entryCount > 1 ? `${entryCount} items`
      : copy?.title ?? first?.title ?? (first?.kind === 'text' ? 'shared words' : first?.kind === 'link' ? 'a link' : 'a collection');
    const values = { sender, title };
    const ownerId = this.fact('owner_user_id');
    const replyTo = ownerId ? (await signInMethodsOf(this.env.APP_KV, ownerId)).email?.address ?? null : null;
    const own = typeof note === 'string' && note.trim() ? `\n\n${filled(sharing.delivery.note_heading, values)}\n\n> ${note.trim().replace(/\n/g, '\n> ')}` : '';
    const message = {
      to: grant.scope.value, subject: filled(words.subject, values), preheader: filled(words.preheader, values),
      markdown: `${filled(words.markdown, values)}${own}`, action: { label: filled(words.action, values), href: shareLinkAddress(origin, grant.code) },
    };
    const sent = await sendMail(this.env, replyTo ? { reply_to: replyTo } : null, { kind: sharing.delivery.kind, ...message });
    if (!sent.sent) throw new SharingError(`The email to ${grant.scope.value} did not go out: ${sent.error}`);
    const at = new Date().toISOString();
    const latest = this.sharingRowOf(ref);
    this.store.eeaf.write([{ id: rowId(ref), type: KIND, value: { ...latest, link_grants: latest.link_grants.map(item => item.share_id === shareId ? { ...item, sent_at: at } : item), changed_at: at } }], { actor: { by: 'person' } });
    recordSent(this.store.eeaf, {
      kind: 'email', to: [grant.scope.value], ...(replyTo ? { reply_to: replyTo } : {}), subject: message.subject, preheader: message.preheader,
      body_markdown: message.markdown, sent_at: at, provider: 'cloudflare-email-sending', ...(sent.id ? { provider_id: sent.id } : {}), by: { app: 'Trillion' },
    }, { by: 'person' });
    return { share_id: shareId, sent_to: grant.scope.value, sent_at: at };
  },

  // Claims an address in the one network-wide name list (APP_KV, beside the codes): a chosen name is the sharer's when
  // it is free or already theirs (it then moves to the new link), and refused when someone else has it; a name made from
  // first words takes the first free one of those words alone, then with each word of the list, then with a short code.
  async claimShareAddress(base, { owner, record, chosen }) {
    try {
      return await claimPublicName(base, { chosen, holder: name => this.env.APP_KV.get(`${LINK_INDEX}${name}`, 'json'),
        mine: held => held.person_ref === owner && (chosen || held.record === record), longest: sharing.addresses.longest, pattern: ADDRESS,
        tries: sharing.addresses.more_word_tries, taken: sharing.addresses.taken });
    } catch (error) { throw error.message === sharing.addresses.taken ? new SharingError(error.message) : error; }
  },

  // A listed link as search engines and answer engines are told of it: its address, title, the day it last changed,
  // and its rows when it shares a list. Admitted again here, so a link revoked, expired or no longer public is never
  // named; null then.
  async listedShare(name) {
    try {
      const index = await this.env.APP_KV.get(`${LINK_INDEX}${name}`, 'json');
      const { grant } = await this.admittedGrant(name, { link_index: index });
      if (!grant.listed || grant.scope?.kind !== 'public') return null;
      const copy = await this.resolveRecordShare(name, { link_index: index, record_view: false, count_open: false });
      const rows = listRows(copy);
      return { name, title: copy.title ?? null, changed: latestDay(copy) ?? grant.created_at.slice(0, 10),
        copy: rows ? { title: copy.title ?? null, body: { about: copy.body?.about ?? null, fields: copy.body.fields, rows: copy.body.rows,
          ...(copy.body?.public_page ? { public_page: copy.body.public_page } : {}) } } : { title: copy.title ?? null, preview: copy.preview ?? null } };
    } catch (error) {
      if (error instanceof SharingError) return null;
      throw error;
    }
  },

  // Changes what one open link lets its recipient do, until when, and under what condition (`can`, `expires_at`,
  // `when`; a field left out stays). Every read checks the grant again, so the change holds from the next open.
  async changeRecordShare(ref, shareId, { can, expires_at: expiresAt, when, time_zone: timeZone } = {}) {
    const row = this.sharingRowOf(ref);
    const grant = row?.link_grants?.find(item => item.share_id === shareId);
    if (!grant || grant.revoked_at) throw new SharingError('That share link is not open on this record.');
    const next = { ...grant };
    if (can !== undefined) {
      const kinds = grant.collection ? ['default'] : unique((grant.records ?? [ref]).map(record => this.store.eeaf.typeOf(record) ?? partOf(record)?.kind ?? record.slice(0, Math.max(0, record.indexOf(':')))));
      const offered = kinds.map(kind => abilitiesOffered(kind)).reduce((common, list) => common.filter(id => list.includes(id)));
      const abilities = strings(can, 'can');
      if (!abilities.includes('view')) throw new SharingError('A link always lets its recipient see what it shares: include view in can.');
      const unoffered = abilities.filter(id => !ABILITIES.has(id) || !offered.includes(id));
      if (unoffered.length) throw new SharingError(`A link to this cannot let someone ${unoffered.join(', ')}. It can: ${offered.join(', ')}.`);
      next.can = abilities;
    }
    if (expiresAt !== undefined) {
      if (expiresAt === null) next.expires_at = null;
      else {
        const instant = typeof expiresAt === 'string' ? Date.parse(expiresAt) : NaN;
        if (!Number.isFinite(instant) || instant <= Date.now()) throw new SharingError('expires_at must be a future time, or null for no expiry.');
        next.expires_at = new Date(instant).toISOString();
      }
    }
    if (when !== undefined) {
      if (when === null) { delete next.when; delete next.counts_opens; }
      else {
        const { binding, incomplete } = compileRules(when, { fields: WHEN_FIELDS, vocabulary: WHEN_VOCABULARY });
        if (!binding || incomplete.length) throw new SharingError(`when names a fact or comparison a link cannot check. Its facts are: ${sharing.when_facts.map(fact => `${fact.id} (${fact.kind})`).join(', ')}.`);
        next.when = structuredClone(when);
        if (namesFact(when, 'opened')) next.counts_opens = true; else delete next.counts_opens;
      }
    }
    if (timeZone !== undefined) {
      if (timeZone === null) delete next.time_zone;
      else next.time_zone = timeZone;
    }
    if (when !== undefined || timeZone !== undefined) {
      const zoneError = zoneProblem(next.when, next.time_zone);
      if (zoneError) throw new SharingError(zoneError);
    }
    const changedAt = new Date().toISOString();
    this.store.eeaf.write([{ id: rowId(ref), type: KIND, value: { ...row, link_grants: row.link_grants.map(item => item.share_id === shareId ? next : item), changed_at: changedAt } }], { actor: { by: 'person' } });
    const { code: _code, ...shown } = next;
    return { ...shown, scope: shown.scope?.kind === 'code' ? { kind: 'code' } : shown.scope };
  },

  async revokeRecordShare(ref, shareId) {
    const row = this.sharingRowOf(ref);
    const grant = row?.link_grants?.find(item => item.share_id === shareId);
    if (!grant) throw new SharingError('That share link is not on this record.');
    if (grant.revoked_at) {
      if (grant.collection) {
        openCollectionStore(this.sql);
        this.sql.exec('DELETE FROM share_collection_pages WHERE share_id = ?', shareId);
      }
      return { share_id: shareId, revoked_at: grant.revoked_at };
    }
    const revokedAt = new Date().toISOString();
    if (grant.collection) openCollectionStore(this.sql);
    this.transaction(() => {
      this.store.eeaf.write([{ id: rowId(ref), type: KIND, value: { ...row, link_grants: row.link_grants.map(item => item.share_id === shareId ? { ...item, revoked_at: revokedAt, ...(item.sealed_copy ? { sealed_copy: null } : {}) } : item), changed_at: revokedAt } }], { actor: { by: 'person' } });
      if (grant.collection) this.sql.exec('DELETE FROM share_collection_pages WHERE share_id = ?', shareId);
    });
    if (grant.listed && grant.address) await this.env?.APP_KV?.delete?.(`${RECORD_SHARE_LISTED_INDEX}${grant.address}`).catch(() => {});
    try { recordCommercialEvent(this.store.eeaf, { event_id: `share-${shareId}-revoked`, event: 'share_revoked', subject_kind: 'record', subject_id: ref, occurred_at: revokedAt }); }
    catch { /* The grant has ended. Analytics cannot report a false revoke failure. */ }
    return { share_id: shareId, revoked_at: revokedAt };
  },

// Called by the shared-link route after it has looked up the owner from APP_KV. Identity values must come from the
// signed-in account, never from query or form fields. Public and code grants need only the bearer link and optional
// code; all recipient-bound scopes fail closed unless the route supplies a verified identity.
  async resolveRecordShare(code, { now = Date.now(), record_view = true, count_open = record_view, item_index = null, item_offset = null, item_limit = COLLECTION_READ_LIMIT, ...recipient } = {}) {
    const { index, grant } = await this.admittedGrant(code, recipient, now);
    // Direct grants are checked against current owner data on every read, and only the shareable copy leaves this store.
    // A list whose rows read how often the link was opened (src/list-copy.mjs) counts this open as one of them.
    let rowsCountOpens = false;
    // A sealed link carries no copy this store can read: the page that opens it fetches the sealed copy (sealedShareRequest)
    // and opens it in the browser with the key in the link's fragment (src/workspace/sealed-link-view.tsx).
    if (grant.sealed_copy) return { kind: SEALED_LINK_KIND, title: null, body: { role: grant.role, can: grant.can ?? ['view'] }, preview: { title: null, fields: [] } };
    const recordCopy = async ref => {
      const shared = await this.sharedCopy(ref, undefined, { now, opened: (grant.opened ?? 0) + (count_open ? 1 : 0) });
      if (shared.counts_opens) rowsCountOpens = true;
      const { private_ref: _private, ...copy } = shared;
      return { ...copy, preview: previewOf(copy) };
    };
    const recordEntryCopy = async entry => {
      try {
        const copy = await recordCopy(entry.record);
        return entry.title ? { ...copy, title: entry.title, preview: { ...copy.preview, title: entry.title } } : copy;
      } catch (error) {
        // One withdrawn source must not close a mixed link whose other items still belong to this owner.
        // Keep its published position without exposing the former title or file address. A focused item read
        // (including every byte route) and a single direct link still refuse the missing source.
        const leafCount = grant.collection?.leaf_count
          ?? entriesOf(grant, index).reduce((sum, item) => sum + (item.leaf_count ?? 1), 0);
        if (!(error instanceof SharingError) || item_index !== null || leafCount < 2) throw error;
        return withdrawnCopy();
      }
    };
    const inlineCopy = item => item.kind === 'link'
      ? { kind: 'link', title: item.title ?? item.url, body: { url: item.url }, preview: { title: item.title ?? item.url, fields: [{ id: 'url', label: 'Link', value: item.url }] } }
      : item.kind === 'text'
        ? { kind: 'text', title: item.title ?? 'Shared words', body: { text: item.text }, preview: { title: item.title ?? 'Shared words', fields: [{ id: 'text', label: 'Words', value: item.text }] } }
        : null;
    const entriesOf = entriesInGrant;
    const nestedGrantsRead = new Map();
    const endedNested = new Set();
    // A collection keeps stable leaf positions after publication. An ended child
    // occupies those positions without exposing its former title, preview or body.
    // Indexed reads (including file bytes) still refuse that child's position.
    const withdrawnCopy = () => ({ kind: 'withdrawn', title: 'No longer shared' });
    const nestedEntries = async (entry, seen) => {
      if (seen.has(entry.code)) throw new SharingError('This share contains a circular nested link.');
      if (endedNested.has(entry.code)) return null;
      let nested;
      try { nested = await this.recordShareGrant(entry.code, now); }
      catch (error) {
        if (!(error instanceof SharingError)
          || !['This share link has ended.', 'This share link is unavailable.'].includes(error.message)) throw error;
        endedNested.add(entry.code);
        return null;
      }
      if (nested.index.person_ref !== index.person_ref) throw new SharingError('This share contains a link from another Trillion.');
      nestedGrantsRead.set(entry.code, nested.index);
      return { ...nested, entries: nested.grant.collection ? null : entriesOf(nested.grant, nested.index), seen: new Set(seen).add(entry.code) };
    };
    const entries = grant.collection ? null : entriesOf(grant, index);
    // A nested collection's fixed count is indexed. Its grant is checked now; no unrelated source bodies are read.
    const counts = new Map();
    const countEntry = async (entry, seen) => {
      if (entry.kind !== 'share') return 1;
      if (seen.has(entry.code)) throw new SharingError('This share contains a circular nested link.');
      if (Number.isSafeInteger(entry.leaf_count) && entry.leaf_count > 0) return entry.leaf_count;
      if (counts.has(entry.code)) return counts.get(entry.code);
      const nested = await nestedEntries(entry, seen);
      if (!nested) {
        // An older inline grant cannot reconstruct a withdrawn subtree's original positions safely.
        throw new SharingError('This shared collection is unavailable.');
      }
      if (nested.grant.collection) {
        counts.set(entry.code, nested.grant.collection.leaf_count);
        return nested.grant.collection.leaf_count;
      }
      let total = 0;
      for (const item of nested.entries) {
        total += await countEntry(item, nested.seen);
        if (!Number.isSafeInteger(total)) throw new SharingError('This shared collection is too large to index safely.');
      }
      counts.set(entry.code, total);
      return total;
    };
    const copyAtEntries = async (list, at, seen) => {
      for (const entry of list) {
        const count = await countEntry(entry, seen);
        if (at < count) {
          if (entry.kind === 'share') {
            const nested = await nestedEntries(entry, seen);
            if (!nested) {
              if (item_index !== null) throw new SharingError('This share link has ended.');
              return withdrawnCopy();
            }
            return copyAtGrant(nested.grant, nested.index, at, nested.seen);
          }
          return entry.kind === 'record' ? recordEntryCopy(entry) : inlineCopy(entry);
        }
        at -= count;
      }
      return null;
    };
    const copyFound = async (found, seen) => {
      if (found.entry.kind === 'share') {
        const nested = await nestedEntries(found.entry, seen);
        if (!nested) {
          if (item_index !== null) throw new SharingError('This share link has ended.');
          return withdrawnCopy();
        }
        return copyAtGrant(nested.grant, nested.index, found.inside, nested.seen);
      }
      return found.entry.kind === 'record' ? recordEntryCopy(found.entry) : inlineCopy(found.entry);
    };
    const copyAtGrant = async (oneGrant, oneIndex, at, seen) => {
      if (oneGrant.collection) {
        if (at >= oneGrant.collection.leaf_count) return null;
        const found = collectionEntryAtLeaf(this.sql, oneIndex.share_id, at);
        if (!found) throw new SharingError('This shared collection is incomplete.');
        return copyFound(found, seen);
      }
      return copyAtEntries(entriesOf(oneGrant, oneIndex), at, seen);
    };
    const copiesAtGrant = async (oneGrant, oneIndex, at, length, seen) => {
      if (!oneGrant.collection) return Promise.all(Array.from({ length }, (_, n) => copyAtGrant(oneGrant, oneIndex, at + n, seen)));
      const found = collectionEntriesAtLeaves(this.sql, oneIndex.share_id, at, length);
      if (found.length !== length) throw new SharingError('This shared collection is incomplete.');
      const groups = [];
      for (let n = 0; n < found.length;) {
        const first = found[n];
        if (first.entry.kind !== 'share') {
          groups.push(Promise.resolve(copyFound(first, seen)).then(copy => [copy]));
          n += 1;
          continue;
        }
        let count = 1;
        while (n + count < found.length && found[n + count].entry === first.entry && found[n + count].inside === first.inside + count) count += 1;
        groups.push((async () => {
          const nested = await nestedEntries(first.entry, seen);
          if (!nested) {
            if (item_index !== null) throw new SharingError('This share link has ended.');
            return Array.from({ length: count }, withdrawnCopy);
          }
          return copiesAtGrant(nested.grant, nested.index, first.inside, count, nested.seen);
        })());
        n += count;
      }
      return (await Promise.all(groups)).flat();
    };
    const expand = async (entry, seen) => {
      if (entry.kind === 'record') return [await recordEntryCopy(entry)];
      if (entry.kind !== 'share') return [inlineCopy(entry)];
      const nested = await nestedEntries(entry, seen);
      if (!nested) return Array.from({ length: await countEntry(entry, seen) }, withdrawnCopy);
      if (nested.grant.collection) return Promise.all(Array.from({ length: nested.grant.collection.leaf_count }, (_, at) => copyAtGrant(nested.grant, nested.index, at, nested.seen)));
      return (await Promise.all(nested.entries.map(item => expand(item, nested.seen)))).flat();
    };
    if (item_index !== null && (!Number.isSafeInteger(item_index) || item_index < 0)) throw new SharingError('This item is not in this share.');
    if (item_offset !== null && (!Number.isSafeInteger(item_offset) || item_offset < 0)) throw new SharingError('This page is not in this share.');
    if (!Number.isSafeInteger(item_limit) || item_limit < 1 || item_limit > COLLECTION_READ_LIMIT) throw new SharingError('Choose up to 32 items per page.');
    const total = grant.collection?.leaf_count ?? (await Promise.all(entries.map(entry => countEntry(entry, new Set([code]))))).reduce((sum, count) => sum + count, 0);
    if (!Number.isSafeInteger(total)) throw new SharingError('This shared collection is too large to index safely.');
    const offset = item_offset ?? 0;
    const bounded = grant.collection || item_offset !== null || total > COLLECTION_BATCH_LIMIT;
    const copies = item_index !== null
      ? [await copyAtGrant(grant, index, item_index, new Set([code]))].filter(Boolean)
      : grant.collection
        ? await copiesAtGrant(grant, index, offset, Math.max(0, Math.min(item_limit, total - offset)), new Set([code]))
      : bounded
        ? await Promise.all(Array.from({ length: Math.max(0, Math.min(item_limit, total - offset)) }, (_, n) => copyAtGrant(grant, index, offset + n, new Set([code]))))
        : (await Promise.all(entries.map(entry => expand(entry, new Set([code]))))).flat();
    // Source reads can await other work. Recheck every grant that supplied this response after they finish,
    // so a revoke during a pending source read does not return a copy from an ended link.
    const finalNow = Math.max(now, Date.now());
    await this.admittedGrant(code, { ...recipient, link_index: index }, finalNow);
    await Promise.all([...nestedGrantsRead].map(([nestedCode, nestedIndex]) => this.recordShareGrant(nestedCode, finalNow, nestedIndex)));
    // A video fetch can ask for many byte ranges. Count a share page at most once; reading each range or
    // revisiting the same page must not append an unbounded commercial-event row to the owner's account log.
    // View analytics is a side effect of a successful grant read, so a full account log must never turn an
    // authorized share into an ended link. The grant and every source check above remain synchronous and fail closed.
    if (record_view) {
      try {
        recordCommercialEvent(this.store.eeaf, { event_id: `share-${index.share_id}-view`, event: 'share_viewed', subject_kind: 'record', subject_id: index.record });
      } catch {
        // Best-effort analytics: the shared copy is already authorized and must still be returned.
      }
    }
    // A link whose own condition reads how often it was opened (when_facts `opened`) counts each page open
    // (`count_open`, which a page asks for even when it records no view); this count is access state, so a write that
    // fails refuses the page rather than letting it open uncounted. Every other link writes nothing on a read.
    if (count_open && (grant.counts_opens || rowsCountOpens)) this.changeGrant(index, kept => ({ ...kept, opened: (kept.opened ?? 0) + 1 }));
    const provenance = { origin: 'shared by link', shared_at: grant.created_at, read_at: new Date(now).toISOString(), expires_at: grant.expires_at };
    if (item_index !== null) return copies.length ? { ...copies[0], provenance } : null;
    return total === 1 && offset === 0 ? { ...copies[0], provenance }
      : { kind: 'collection', title: `${total} shared items`, items: copies, item_offset: offset, item_count: total, has_more: offset + copies.length < total, provenance };
  },

  async recordShareGrant(code, now = Date.now(), linkIndex = null) {
    if (typeof code !== 'string' || !code) throw new SharingError('This share link is unavailable.');
    // The public Worker already read this index to route to this exact store. A second KV request on every
    // video byte range adds latency without strengthening the grant check, which remains in this owner's log.
    if (linkIndex && linkIndex.person_ref !== this.ctx?.id?.toString?.()) throw new SharingError('This share link is unavailable.');
    const index = linkIndex ?? await this.env.APP_KV.get(`${LINK_INDEX}${code}`, 'json');
    if (!index?.record || !index.share_id) throw new SharingError('This share link is unavailable.');
    const row = this.sharingRowOf(index.record);
    const grant = row?.link_grants?.find(item => item.share_id === index.share_id && item.code === (index.code ?? code));
    if (!grant || grant.published === false || grant.revoked_at || (grant.expires_at && Date.parse(grant.expires_at) <= now)) throw new SharingError('This share link has ended.');
    return { index, grant };
  },

  // Negotiated checkout asks this owner before reading terms or creating a payment session. Buyer identity is supplied
  // by the authenticated server route, not by the page that carries the link.
  // Negotiated checkout asks this owner before reading terms or creating a payment session: the same admission as every
  // read, plus the buyer the authenticated route named (null while the recipient has not proved who they are, which
  // lets them read the terms and nothing more), and whether a link that asks for a signature is still unsigned.
  async resolveRecordShareGrant(code, recipient = {}, now = Date.now()) {
    const { index, grant } = await this.admittedGrant(code, recipient, now);
    await this.sharedCopy(index.record);
    const buyer = typeof recipient.buyer_ref === 'string' && recipient.buyer_ref ? recipient.buyer_ref : null;
    return { record_ref: index.record, share_id: index.share_id, buyer_ref: buyer, unsigned: (grant.can ?? []).includes('sign') && grant.signed !== 'yes' };
  },

  // Reusable configurations share only their settings. These methods never
  // read a selected task/account/list row or transfer permission to that data.
  // A DATA-declared static view carries the original record grant, not another permission store.
  async sharedRecordViewForLink(code, recipient = {}, path = 'index.html') {
    const first = await this.admittedGrant(code, recipient);
    const copy = await this.resolveRecordShare(code, { ...recipient, record_view: false, count_open: false });
    const source = (sharing.source_references ?? []).find(row => row.kind === copy?.kind);
    if (!source?.view_method || typeof this[source.view_method] !== 'function') throw new SharingError('This share has no static view.');
    const result = await this[source.view_method](copy.body, path);
    const final = await this.admittedGrant(code, { ...recipient, link_index: first.index });
    const settledSource = await this[source.view_method](copy.body, path, true);
    const current = this.sharingRowOf(first.index.record)?.link_grants?.find(row => row.share_id === first.index.share_id && row.code === (first.index.code ?? code));
    const now = Date.now();
    if (first.signature !== final.signature || JSON.stringify(current) !== final.signature || !current
      || current.published === false || current.revoked_at || current.expires_at && Date.parse(current.expires_at) <= now
      || !namedBy(current.scope, recipient) || !(current.can ?? ['view']).includes('view'))
      throw new SharingError('This shared view changed or ended while it was being read.');
    if (result.installation_id !== copy.body.installation_id || result.revision !== copy.body.revision
      || result.draft_revision !== copy.body.draft_revision || settledSource.installation_id !== result.installation_id
      || settledSource.revision !== result.revision || settledSource.draft_revision !== result.draft_revision)
      throw new SharingError('This shared source changed while it was being read.');
    return result;
  },
  // Expected grant/source refusal crosses Durable Object RPC as data. Transport/storage failures still throw.
  async sharedRecordViewRequest(code, recipient = {}, path = 'index.html') {
    try { return { file: await this.sharedRecordViewForLink(code, recipient, path) }; }
    catch (error) { if (error instanceof SharingError) return { denied: true }; throw error; }
  },
  async readConfigurationShare(code, recipient = {}) {
    const admitted = await this.admittedGrant(code, recipient);
    const current = currentConfigurationGrant(this, code, recipient, admitted);
    return configurationShareView(this, code, current, recipient);
  },
  async editConfigurationShare(code, recipient = {}, input = {}) {
    const admitted = await this.admittedGrant(code, recipient);
    const current = currentConfigurationGrant(this, code, recipient, admitted);
    const relay = typeof recipient.relay === 'string' && recipient.relay.trim() ? recipient.relay : null;
    const email = normalEmail(recipient.verified_email) || null;
    if (!relay && !email) throw new SharingError('Prove your identity before editing this configuration.');
    if (!(current.grant.can ?? ['view']).includes('edit')) throw new SharingError('This link lets you view this configuration, not edit it.');
    if (!input || typeof input !== 'object' || Array.isArray(input)) throw new ConfigurationError('Configuration changes must be an object.');
    const allowed = ['label', 'settings', 'aspects', 'expected_revision'];
    if (Object.keys(input).some(key => !allowed.includes(key))) throw new ConfigurationError('A shared edit can change only the name and saved settings.');
    const shape = this.copyShape(current.index.record);
    const hidden = new Set([...(shape.leave_out ?? []), ...(shape.match_only ?? [])]);
    if (['label', 'settings', 'aspects'].some(field => Object.hasOwn(input, field) && hidden.has(field))) throw new SharingError('This configuration does not share that field for editing.');
    // There is no await from the live grant check through this synchronous
    // revision-checked mutation. The owner and all target/data rights stay put.
    this.configurations().save({ ...input, id: current.index.record }, { actor: { by: 'share-recipient', ...(relay ? { relay } : {}), ...(email ? { email } : {}) } });
    return configurationShareView(this, code, current, recipient);
  },
  // Durable Object RPC does not preserve custom Error classes/properties.
  // Expected permission and revision refusals cross as data; storage failures
  // still fail the request and must never look like a denied or missing share.
  async configurationShareRequest(code, recipient = {}, input = null) {
    try {
      return input === null ? await this.readConfigurationShare(code, recipient) : await this.editConfigurationShare(code, recipient, input);
    } catch (error) {
      if (error instanceof SharingError) return { refused: { error: error.message, status: 403, code: 'configuration_share_denied' } };
      if (error instanceof ConfigurationError) return { refused: { error: error.message, status: error.status, code: error.code } };
      throw error;
    }
  },

  // The one admission every read and action of a link goes through: the link is open, the recipient is the one it
  // names (identity comes from the route: a signed-in account, or an email proved with a code, never from the page),
  // and the link's own condition holds now.
  async admittedGrant(code, recipient = {}, now = Date.now()) {
    const { index, grant } = await this.recordShareGrant(code, now, recipient.link_index ?? null);
    const signature = JSON.stringify(grant);
    if (!namedBy(grant.scope, recipient)) throw new SharingError('This share link is for someone else, or needs its access code.');
    if (grant.when && !(await this.linkConditionHolds(grant, index, now))) throw new SharingError('This share link is not open right now.');
    return { index, grant, signature };
  },
  // A prepared recipient admission is checked again synchronously with the
  // domain mutation. Conditions use the shared formula evaluator at commit
  // time; an earlier successful remote check cannot authorize a later write.
  async prepareGrantCommit(code, recipient = {}, ability = null) {
    const admitted = await this.admittedGrant(code, recipient, Date.now());
    if (ability && !(admitted.grant.can ?? ['view']).includes(ability)) throw new SharingError('This share does not allow that action.');
    const filterNow = admitted.grant.when && typeof this.prepareRulesForCommit === 'function' ? await this.prepareRulesForCommit() : null;
    return { ...admitted, code, recipient: structuredClone(recipient), ability, filterNow };
  },
  assertGrantCommit(proof, now = Date.now()) {
    if (!proof?.index || !proof.signature || !proof.recipient) throw new SharingError('Current recipient admission is required.');
    const grant = this.sharingRowOf(proof.index.record)?.link_grants?.find(row => row.share_id === proof.index.share_id && row.code === (proof.index.code ?? proof.code));
    if (!grant || JSON.stringify(grant) !== proof.signature || grant.published === false || grant.revoked_at
      || grant.expires_at && (!Number.isFinite(Date.parse(grant.expires_at)) || Date.parse(grant.expires_at) <= now) || !namedBy(grant.scope, proof.recipient)
      || proof.ability && !(grant.can ?? ['view']).includes(proof.ability)) throw new SharingError('This share changed or ended before the action could commit.');
    if (grant.when) {
      if (typeof proof.filterNow !== 'function') throw new SharingError('The current rule evaluator is not available for this action.');
      const result = proof.filterNow({ tree: grant.when, fields: WHEN_FIELDS, rows: [whenFactsOf(grant, this.ownRecord(proof.index.record)?.value ?? null, now)] });
      if (result?.incomplete?.length || result?.matches?.length !== 1 || result.matches[0] !== 0) throw new SharingError('This share is not open at the moment of the action.');
    }
    return { index: proof.index, grant };
  },
  async linkConditionHolds(grant, index, now) {
    const record = this.ownRecord(index.record)?.value ?? null;
    const { matches } = await this.filterRowsByRules({ tree: grant.when, fields: WHEN_FIELDS, rows: [whenFactsOf(grant, record, now)] });
    return matches.length === 1;
  },
  // An address proposed for email proof is eligibility, never verified identity.
  // This returns no record, recipient, signature or proof and writes no grant.
  async mayAdmitShareEmail(code, { email } = {}, recipient = {}, now = Date.now(), checkCurrent = async () => {}) {
    const proposed = normalEmail(email);
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(proposed)) return false;
    const eligible = grant => grant.scope?.kind === 'email'
      ? proposed === grant.scope.value : namedBy(grant.scope, recipient);
    try {
      const first = await this.recordShareGrant(code, now, recipient.link_index ?? null);
      const signature = JSON.stringify(first.grant);
      if (!eligible(first.grant) || first.grant.when && !(await this.linkConditionHolds(first.grant, first.index, now))) return false;
      await checkCurrent();
      const freshNow = Math.max(now, Date.now());
      const fresh = await this.recordShareGrant(code, freshNow, first.index);
      if (JSON.stringify(fresh.grant) !== signature || !eligible(fresh.grant)
        || fresh.grant.when && !(await this.linkConditionHolds(fresh.grant, fresh.index, freshNow))) return false;
      await checkCurrent();
      const final = await this.recordShareGrant(code, Math.max(freshNow, Date.now()), fresh.index);
      return JSON.stringify(final.grant) === signature && eligible(final.grant);
    } catch (error) {
      if (error instanceof SharingError) return false;
      throw error;
    }
  },
  // A sealed link's copy for its holder (input null), or a writer's replacement { sealed_copy, expected_content_id }
  // (compare-and-set on the content_id it replaced). The store checks the grant, the role and the copy's shape and
  // identity; it never opens either copy. Refusals cross Durable Object RPC as data, like configurationShareRequest.
  async sealedShareRequest(code, recipient = {}, input = null) {
    try {
      if (input === null) {
        const { grant } = await this.admittedGrant(code, recipient);
        if (!grant.sealed_copy) throw new SharingError(sharing.sealed.not_sealed_link);
        return { content_id: grant.sealed_copy.content_id, value: grant.sealed_copy.value, role: grant.role, can: grant.can ?? ['view'] };
      }
      if (!input || typeof input !== 'object' || Array.isArray(input)) throw new SharingError('A sealed change is { sealed_copy, expected_content_id }.');
      const proof = await this.prepareGrantCommit(code, recipient, 'replace_sealed');
      let copy;
      try { copy = checkedLinkCopy(input.sealed_copy); } catch (error) { throw new SharingError(error.message); }
      // No await from here to the write: the grant, its role and its current copy are checked with the change.
      const { index, grant } = this.assertGrantCommit(proof);
      if (!grant.sealed_copy) throw new SharingError(sharing.sealed.not_sealed_link);
      if (grant.sealed_copy.content_id !== input.expected_content_id) return { refused: { error: sharing.sealed.changed, status: 409, code: 'sealed_copy_changed', content_id: grant.sealed_copy.content_id } };
      const changedAt = new Date().toISOString();
      this.changeGrant(index, item => ({ ...item, sealed_copy: copy, sealed_changed_at: changedAt }));
      return { content_id: copy.content_id, role: grant.role, changed_at: changedAt };
    } catch (error) {
      if (error instanceof SharingError) return { refused: { error: error.message, status: 403, code: 'sealed_share_denied' } };
      throw error;
    }
  },
  // One link's grant changed in place (a signature, a payment, an open), in the record's one sharing row.
  changeGrant(index, change) {
    const row = this.sharingRowOf(index.record);
    if (!row?.link_grants?.some(item => item.share_id === index.share_id)) throw new SharingError('This share link is unavailable.');
    this.store.eeaf.write([{ id: rowId(index.record), type: KIND, value: { ...row, link_grants: row.link_grants.map(item => item.share_id === index.share_id ? change(item) : item) } }], { actor: { by: 'share-recipient' } });
  },

  // What the recipient page needs before it draws anything: whether this recipient is admitted, and when not, what they
  // can prove (an email by code, no account; a phone or an account by signing in; the access code); what the link lets
  // them do; whose brand it carries; and who signed. Nothing of the record itself leaves here.
  async shareAccess(code, recipient = {}, now = Date.now(), measure = () => {}, { defer_sender = false } = {}) {
    let started = performance.now();
    const { index, grant } = await this.recordShareGrant(code, now, recipient.link_index ?? null);
    const named = namedBy(grant.scope, recipient);
    const open = !grant.when || await this.linkConditionHolds(grant, index, now);
    const can = grant.can ?? ['view'];
    const email = normalEmail(recipient.verified_email) || null;
    const signatures = named && open ? (grant.signatures ?? []) : [];
    measure('grant', performance.now() - started);
    // A public link that only lets its reader view can paint its shared copy before a
    // remote account-name lookup. Proof, signing and payment still need the name in
    // their first response. The page reads the current name separately after paint.
    const deferredSender = defer_sender && named && open && grant.scope?.kind === 'public'
      && can.length === 1 && can[0] === 'view';
    started = performance.now();
    const sender = deferredSender ? null : shownName(await this.accountName?.()) ?? sharing.delivery.someone;
    if (!deferredSender) measure('sender', performance.now() - started);
    return {
      admitted: named && open,
      needs: named ? null : PROOF_FOR[grant.scope.kind] ?? null,
      closed: !open,
      can,
      acts_need_proof: can.some(id => ABILITIES.get(id)?.needs_proof === true),
      proven: Boolean(email || recipient.relay),
      sender,
      deferred_sender: deferredSender,
      look: await this.lookWithWorn(grant),
      signatures: signatures.map(({ name, signed_at: signedAt }) => ({ name, signed_at: signedAt })),
      signed_by_you: signatures.some(item => (email && item.email === email) || (recipient.relay && item.relay === recipient.relay)),
      paid: grant.paid === 'yes',
      address: grant.address ?? null,
      listed: grant.listed === true && grant.scope?.kind === 'public',
      public: grant.scope?.kind === 'public',
      // Signing gives the signer something (a free deal): the page names the account it goes to before signing.
      delivers_on_sign: named && open && can.includes('sign') && Boolean(this.signDelivers?.(index, grant)),
    };
  },

  // A page needs its access state and its current shared copy together. Keep both
  // checks inside one owner call; resolveRecordShare still rechecks the grant and
  // every source before anything private leaves this store.
  async sharedPageForLink(code, recipient = {}, { count_open = true, caller_started_at: callerStartedAt = null, item_offset = null, item_limit = COLLECTION_READ_LIMIT, row_address: rowAddress = null, probe_id: probeId = null } = {}) {
    const endProbe = beginShareReadProbe(probeId, 'page-access');
    try {
      const enteredAt = Date.now();
      const firstCall = this.shareReadFirstCall;
      this.shareReadFirstCall = false;
      const timing = {
        ...(firstCall ? { constructor_ms: this.shareReadConstructorMs } : {}),
        ...(Number.isFinite(callerStartedAt) ? { owner_arrival_ms: Math.max(0, enteredAt - callerStartedAt) } : {}),
      };
      const finish = answer => {
        timing.owner_method_ms = Date.now() - enteredAt;
        return answer;
      };
      try {
        const access = await this.shareAccess(code, recipient, Date.now(), (phase, duration) => { timing[`${phase}_ms`] = duration; }, { defer_sender: true });
        if (!access.admitted) return finish({ access, copy: null, _timing: timing });
        const started = performance.now();
        let copy = await this.resolveRecordShare(code, { ...recipient, record_view: false, count_open, item_offset, item_limit });
        const source = copy.body?.public_page?.evidence_rows;
        if (rowAddress && source?.evidence_list && source.claim_ids_field) {
          const row = listRows(copy)?.find(item => item.address === rowAddress);
          if (row?.values?.[source.kind_field] === source.comparison_kind) {
            const list = this.store.eeaf.read(`list:${source.evidence_list}`);
            if (!list?.row_type) throw new Error('Comparison evidence list is unavailable.');
            const ids = row.values[source.claim_ids_field] ?? [];
            if (!Array.isArray(ids) || ids.length > 100 || ids.some(id => typeof id !== 'string' || id.includes('/')))
              throw new Error('Comparison evidence references are invalid.');
            const read = id => this.store.eeaf.read(`record:${list.row_type}:${id}`);
            const claims = ids.map(id => ({ id, values: read(id) }));
            if (claims.some(item => item.values?.[source.kind_field] !== source.claim_kind
              || item.values?.[source.owner_field] !== row.id)) throw new Error('Comparison evidence is incomplete.');
            const sourceIds = [...new Set(claims.map(item => item.values?.[source.source_ref_field]).filter(Boolean))];
            const sources = sourceIds.map(id => ({ id, values: read(id) }));
            if (sources.some(item => item.values?.[source.kind_field] !== source.source_kind))
              throw new Error('Comparison source is unavailable.');
            copy = { ...copy, body: { ...copy.body, evidence_rows: [...claims, ...sources] } };
          }
        }
        timing.copy_ms = performance.now() - started;
        return finish({ access, copy, _timing: timing });
      } catch (error) {
        // Durable Object RPC does not preserve custom Error classes. Carry an expected
        // grant/source refusal as data; the public route still treats other failures as 503.
        if (error instanceof SharingError) return finish({ denied: true, _timing: timing });
        throw error;
      }
    } finally {
      endProbe();
    }
  },

  // Deferred attribution cannot carry a stale name past a revocation that happens
  // while the account-name store is answering. Its second grant check is the last
  // owner read before the name leaves this person store.
  async shareSenderForLink(code, recipient = {}) {
    await this.admittedGrant(code, recipient);
    const sender = shownName(await this.accountName?.()) ?? null;
    await this.admittedGrant(code, recipient);
    return sender;
  },

  // A recipient signs what the link shares: their typed name, with the email they proved (or their account), kept on
  // the link's grant and told to the sharer's rules as a share_signed event, so a follow-up can run when it happens.
  async signRecordShare(code, recipient = {}, { name } = {}, now = Date.now()) {
    const { index, grant } = await this.admittedGrant(code, recipient, now);
    if (!(grant.can ?? []).includes('sign')) throw new SharingError('This link does not ask for a signature.');
    const email = normalEmail(recipient.verified_email) || null;
    if (!email && !recipient.relay) throw new SharingError(sharing.proof.body);
    const signer = typeof name === 'string' ? name.trim().replace(/\s+/g, ' ') : '';
    if (signer.length < 2 || signer.length > 200) throw new SharingError(sharing.signing.refused_name);
    const earlier = (grant.signatures ?? []).find(item => (email && item.email === email) || (recipient.relay && item.relay === recipient.relay));
    if (earlier) return { name: earlier.name, signed_at: earlier.signed_at };
    const signedAt = new Date(now).toISOString();
    const signature = { name: signer, ...(email ? { email } : {}), ...(recipient.relay ? { relay: recipient.relay } : {}), signed_at: signedAt };
    this.changeGrant(index, kept => ({ ...kept, signed: 'yes', signatures: [...(kept.signatures ?? []), signature] }));
    recordCommercialEvent(this.store.eeaf, { event_id: `share-${index.share_id}-signed-${token(8)}`, event: 'share_signed', subject_kind: 'record', subject_id: index.record, occurred_at: signedAt });
    return { name: signer, signed_at: signedAt };
  },
  // Where a link that takes files puts them (add_files on a `folder:` link): the folder, the account the files are kept
  // under, and a free name in that folder for each file given, so nothing someone sends ever replaces a file already
  // there. Checked against the current grant on every send, so a closed or ended link takes nothing.
  // A link that cannot take these files answers { refused } rather than throwing, since an error's kind does not cross
  // to the page route that asked.
  async shareFolderForAdding(code, recipient = {}, names = [], now = Date.now()) {
    try { return await this.folderForAdding(code, recipient, names, now); }
    catch (error) { if (error instanceof SharingError) return { refused: error.message }; throw error; }
  },
  async folderForAdding(code, recipient, names, now) {
    const { index, grant } = await this.admittedGrant(code, recipient, now);
    if (!(grant.can ?? []).includes('add_files')) throw new SharingError('This link does not take files.');
    const folder = folderOf(index.record);
    if (!folder) throw new SharingError('This link does not take files.');
    if (!Array.isArray(names) || names.length > sharing.adding.most_files) throw new SharingError(`Send at most ${sharing.adding.most_files} files at a time.`);
    const taken = new Set();
    const free = given => {
      const name = keptFileName(given);
      const dot = name.lastIndexOf('.');
      const [stem, kind] = dot > 0 ? [name.slice(0, dot), name.slice(dot)] : [name, ''];
      for (let copy = 1; ; copy += 1) {
        const path = `${folder === '/' ? '' : folder}/${copy === 1 ? name : `${stem} (${copy})${kind}`}`;
        if (!taken.has(path) && !this.namespace.byName(path)) { taken.add(path); return path; }
      }
    };
    return { owner: this.namespaceOwner(), folder, names: names.map(free), sender: shownName(await this.accountName?.()) ?? sharing.delivery.someone, look: await this.lookWithWorn(grant) };
  },
  // Files someone added through a link: the grant counts them, so the sharer sees on the link how many arrived and when.
  async noteFilesAddedThroughShare(code, count, now = Date.now()) {
    if (!Number.isSafeInteger(count) || count < 1) return null;
    const { index } = await this.recordShareGrant(code, now);
    return this.changeGrant(index, kept => ({ ...kept, files_added: (kept.files_added ?? 0) + count, last_added_at: new Date(now).toISOString() }));
  },
  // A payment through the link settled (the seller's own Stripe said so): the grant remembers it for its condition.
  markRecordSharePaid(code) {
    return this.recordShareGrant(code).then(({ index }) => this.changeGrant(index, kept => ({ ...kept, paid: 'yes' })));
  },

  // The brand a recipient page carries: the sharer's own (record-sharing.json look; kept once per account as the fact
  // share-look) unless the link asks for Trillion's, and Trillion's when the account has none. Every page also ends with
  // look.made_with.
  shareLook() { return this.fact('share-look') ?? null; },
  setShareLook(input = {}) {
    if (input === null) { this.setFact('share-look', null); return { look: null }; }
    const name = typeof input.name === 'string' ? input.name.trim().slice(0, 80) : '';
    if (!name) throw new SharingError('Give your brand a name.');
    const accent = input.accent === undefined || input.accent === null ? null : String(input.accent);
    if (accent !== null && !/^#[0-9a-f]{6}$/i.test(accent)) throw new SharingError('accent is a colour like #1a73e8.');
    const logo = input.logo === undefined || input.logo === null ? null : String(input.logo);
    if (logo !== null && !/^(1f|12):[0-9a-f]{64}$/.test(logo)) throw new SharingError('logo is one of your picture files, by its identity.');
    const look = { name, ...(accent ? { accent } : {}), ...(logo ? { logo } : {}), changed_at: new Date().toISOString() };
    this.setFact('share-look', look);
    return { look };
  },
  lookOf(grant) {
    const own = this.shareLook();
    if (grant.look === 'trillion' || !own?.name) return { kind: 'trillion', name: sharing.look.trillion.name };
    return { kind: 'own', name: own.name, ...(own.accent ? { accent: own.accent } : {}), ...(own.logo ? { logo: true } : {}) };
  },
  // The look a recipient page wears: the sharer's own worn look (src/looks.mjs `page`, the same answer their screens and
  // their AI app's views read), with the brand above over it. Never the service operator's look: a link someone shares
  // looks like the Trillion they use (2026-10-11: a share wore the operator's black while the sharer's lists were light).
  async lookWithWorn(grant) {
    const worn = await this.looks().page({ host: 'web' });
    return { ...this.lookOf(grant), ...(worn ? { worn } : {}) };
  },
  // The sharer's logo file, for the recipient page of an open link that carries their brand.
  async shareLookLogo(code) {
    const { grant } = await this.recordShareGrant(code);
    const own = this.shareLook();
    return grant.look !== 'trillion' && own?.logo ? own.logo : null;
  },

  // Makes every copy of one record match the choice in force for it (invariant 4).
  async applySharing(ref, previousSpaces = [], intentOrder = this.nextSpaceShareIntentOrder()) {
    const effective = this.effectiveSharing(ref);
    const relay = this.relay();
    const network = this.network();
    const wanted = effective?.spaces ?? [];
    const copy = await this.sharedCopy(ref);
    for (const space of wanted) await network.shareIntoSpace({ relay, space_id: space, record: { ...copy, shared_here: true }, intent_order: intentOrder });
    await network.withdrawCopies({ relay, private_ref: ref, keep: wanted, prior_space_ids: previousSpaces, intent_order: intentOrder });
    await network.offerRecord({ relay, private_ref: ref, kind: copy.kind, title: copy.title ?? null, to: effective?.people ?? [], intent_order: intentOrder });
    const value = this.store.eeaf.typeOf(ref) ? this.store.eeaf.read(ref) : null;
    if (!this.networkMay(ref, value)) await this.leaveNetwork(ref);
    else if (this.store.eeaf.typeOf(ref) === 'decision') this.ctx.waitUntil(this.share(ref).then(() => this.publishStory(ref)).catch(() => {}));
  },

  // A decision taken out of the network leaves the shared pool and stops showing as a story; turned back on, both
  // follow it again.
  async leaveNetwork(ref) {
    const shared = this.fact(`shared:${ref}`);
    if (shared?.pool_id) await this.pool().remove(shared.pool_id);
    if (shared) await this.setFact(`shared:${ref}`, null);
    const story = this.fact(`story:${ref}`);
    if (story?.published && story.id) {
      await this.pool().unpublishStory(story.id);
      await this.setFact(`story:${ref}`, { published: false, id: story.id, reason: 'not shared', at: new Date().toISOString() });
    }
  },

  // One record shared into one space on its own (share_to_space, the Share button in a space). Its choice then names
  // that space too; a record chosen out of this space is refused by the space's one check (invariant 3).
  async shareInto(spaceId, body, orderAt = null, app = null) {
    const intentOrder = this.nextSpaceShareIntentOrder();
    const copy = typeof body?.record === 'string' && body.record ? await this.sharedCopy(body.record) : await this.shareableRecord(body);
    const ref = copy.private_ref;
    const relay = this.relay();
    const network = this.network();
    const effective = this.effectiveSharing(ref);
    const sharedHere = !effective || effective.network !== false || effective.spaces.includes(spaceId);
    if (this.sharingIntentOvertaken(ref, intentOrder)) throw new SharingError('A newer sharing choice already changed this record. Share it again to choose it now.');
    if (!sharedHere) throw new SharingError(sharing.refused.not_shared_here);
    const row = this.sharingRowOf(ref);
    const own = hasChoice(row) ? row : null;
    const base = own ?? (effective ?? { network: null, people: [], leave_out: [], spaces: (await network.spacesHolding({ relay, private_ref: ref })).spaces });
    if (shareChoiceFingerprint(this.effectiveSharing(ref)) !== shareChoiceFingerprint(effective)) throw new SharingError('This sharing choice changed while the pursuit was being checked. Share it again to use the current choice.');
    this.keepSharing(ref, { network: base.network, people: base.people, leave_out: base.leave_out, match_only: base.match_only ?? [], chain: own?.chain === true, spaces: unique([...base.spaces, spaceId]) }, crypto.randomUUID(), intentOrder);
    const answer = await network.shareIntoSpace({ relay, space_id: spaceId, record: { ...copy, shared_here: true }, ...(orderAt ? { order_at: orderAt } : {}), intent_order: intentOrder, app });
    if (answer.shared === false || answer.withdrawn) throw new SharingError('A newer sharing choice already changed this pursuit item. Share it again to choose it now.');
    return answer;
  },

  // One request for a mixed selection into a Space. Every private reference goes through the same live projection
  // and Space permission check as shareInto; literal links, words and nested grants become ordinary Space items. The
  // private entries are resolved before the first write, so a bad file/workflow/record cannot leave a half-delivery.
  async shareIntoMany(spaceId, { records = [], items = [], request_key: requestKey = null } = {}, app = null) {
    if (!Array.isArray(records) || !Array.isArray(items) || records.length + items.length > MAX_SPACE_SHARE_ITEMS) throw new SharingError(`Choose at most ${MAX_SPACE_SHARE_ITEMS} items for one Space share.`);
    if (records.some(record => typeof record !== 'string' || !record.trim())) throw new SharingError('records is a list of record references.');
    if (requestKey !== null && (typeof requestKey !== 'string' || !requestKey.trim() || requestKey.length > 500)) throw new SharingError('request_key is unique text of at most 500 characters for this Space share.');
    const nestedShareUrl = code => {
      if (typeof code !== 'string' || !code.trim()) throw new SharingError('A nested pursuit share needs its link code.');
      return `/share/${encodeURIComponent(code.trim())}`;
    };
    const ordered = unique(records).map(record => ({ private: { record } }));
    const nestedCodes = [];
    for (const item of items) {
      if (!item || typeof item !== 'object' || Array.isArray(item)) throw new SharingError('A Pursuit share item is not valid.');
      if (item.title !== undefined && item.title !== null && (typeof item.title !== 'string' || item.title.trim().length > 300)) throw new SharingError('One pursuit item title holds at most 300 characters. Shorten it before sharing.');
      // Any item carrying a record reference stays an owner-backed reference, regardless of the label an app gave it.
      if (typeof item.record === 'string' && item.record.trim()) {
        ordered.push({ private: { record: item.record.trim() } });
        continue;
      }
      if ((item.kind === 'file' || item.file !== undefined) && typeof item.file === 'string' && item.file.trim()) {
        ordered.push({ private: { file: item.file.trim() } });
        continue;
      }
      if ((item.kind === 'tool' || item.tool !== undefined || item.tool_id !== undefined) && typeof (item.tool ?? item.tool_id) === 'string' && String(item.tool ?? item.tool_id).trim()) {
        ordered.push({ private: { tool: String(item.tool ?? item.tool_id).trim() } });
        continue;
      }
      if (item.kind === 'workflow' || item.workflow_id !== undefined || item.workflow !== undefined) {
        const workflow = typeof item.workflow_id === 'string' ? item.workflow_id : typeof item.workflow === 'string' ? item.workflow : item.workflow?.id;
        if (typeof workflow === 'string' && workflow.trim()) {
          const ref = workflow.startsWith('workflow:') ? workflow.trim() : `workflow:${workflow.trim()}`;
          ordered.push({ private: { record: ref } });
          continue;
        }
      }
      if (item.kind === 'link' && typeof item.url === 'string' && /^https?:\/\//i.test(item.url)) {
        ordered.push({ literal: { kind: 'link', title: item.title ?? item.url, body: { url: item.url } } });
        continue;
      }
      if (item.kind === 'text' && typeof item.text === 'string' && item.text.trim()) {
        ordered.push({ literal: { kind: 'text', title: item.title ?? 'Shared words', body: { text: item.text } } });
        continue;
      }
      // A nested external grant remains a link to its own owner and grant. Opening it later rechecks expiry and
      // revocation; no bytes or copied record are stored in the Space.
      if (item.kind === 'share' || item.share_code !== undefined || item.code !== undefined) {
        const code = item.code ?? item.share_code;
        const url = code === undefined && typeof item.url === 'string' && /^https?:\/\//i.test(item.url)
          ? item.url : nestedShareUrl(code);
        if (code !== undefined) nestedCodes.push(String(code).trim());
        ordered.push({ literal: { kind: 'link', title: item.title ?? 'Shared collection', body: { url } } });
        continue;
      }
      throw new SharingError('A Pursuit share item must be a record, file, tool, workflow, link, words or another share.');
    }
    // Fix the owner's intent before the first await. Network arrival order is not selection order: a delayed first
    // batch must remain older than a later choice or selection even if it reaches the Space last.
    const selectionKey = requestKey ?? crypto.randomUUID();
    const selectionId = bytesToHex(blake3(new TextEncoder().encode(selectionKey)));
    const fingerprint = bytesToHex(blake3(new TextEncoder().encode(JSON.stringify(ordered.map(entry => entry.private
      ? { private: entry.private } : { literal: entry.literal })))));
    const factName = `space-share-selection:${spaceId}:${selectionId}`;
    const earlier = requestKey === null ? null : this.fact(factName);
    if (earlier && (earlier.fingerprint !== fingerprint || !Number.isFinite(Date.parse(earlier.started_at)))) throw new SharingError('This request_key was already used for a different pursuit selection.');
    const sharedAt = earlier ? Date.parse(earlier.started_at) : Date.now();
    const intentOrder = earlier ? (earlier.intent_order ?? 0) : requestKey === null ? this.nextSpaceShareIntentOrder() : this.transaction(() => {
      const order = this.nextSpaceShareIntentOrder();
      this.setFact(factName, { fingerprint, intent_order: order, started_at: new Date(sharedAt).toISOString() });
      return order;
    });
    if (!Number.isSafeInteger(intentOrder) || intentOrder < 0) throw new SharingError('This pursuit selection has an invalid share order.');
    const relay = this.relay();
    const network = this.network();
    if (ordered.length) await network.checkSpaceShare({ relay, space_id: spaceId,
      has_private: ordered.some(entry => Boolean(entry.private)), has_literal: ordered.some(entry => Boolean(entry.literal)) });
    // Resolve every private source before the first Space write. Repeated references in one selection point at the
    // first placement, so they cannot move that placement behind a later copy of themselves.
    const firstPrivate = new Map();
    const privateEntries = [];
    for (const [index, entry] of ordered.entries()) {
      if (!entry.private) continue;
      const copy = entry.private.record ? await this.sharedCopy(entry.private.record) : await this.shareableRecord(entry.private);
      const ref = copy.private_ref;
      if (firstPrivate.has(ref)) { entry.aliasOf = firstPrivate.get(ref); continue; }
      firstPrivate.set(ref, index);
      entry.copy = copy;
      privateEntries.push(entry);
    }
    // The Space's per-item body bound must hold for the entire selection before an earlier slice can be written.
    for (const entry of ordered) {
      const body = entry.private ? entry.copy?.body : entry.literal.body;
      if (body !== undefined && JSON.stringify(body ?? null).length > settings.max_item_bytes) throw new SharingError(`One Space item holds at most ${settings.max_item_bytes} characters.`);
    }
    const owner = this.ctx?.id?.toString?.();
    for (const code of unique(nestedCodes)) {
      const found = await this.recordShareGrant(code).catch(() => null);
      if (!owner || !found || found.index.person_ref !== owner) throw new SharingError('A nested share must belong to this Trillion and still be open.');
    }
    const needsHolding = privateEntries.filter(entry => {
      const ref = entry.copy.private_ref;
      const row = this.sharingRowOf(ref);
      entry.own = hasChoice(row) ? row : null;
      entry.effective = this.effectiveSharing(ref);
      entry.copy = { ...entry.copy, shared_here: true };
      return !entry.own && !entry.effective;
    });
    const holding = needsHolding.length
      ? (await network.spacesHoldingMany({ relay, private_refs: needsHolding.map(entry => entry.copy.private_ref) })).holding
      : [];
    const heldByRef = new Map(holding.map(row => [row.private_ref, row.spaces]));
    const choiceFingerprints = ordered.map(entry => entry.private ? shareChoiceFingerprint(entry.effective) : null);
    const remembered = requestKey === null ? null : this.fact(factName);
    const originalFingerprints = remembered?.choice_fingerprints ?? choiceFingerprints;
    if (requestKey !== null && !remembered?.choice_fingerprints) {
      this.setFact(factName, { ...remembered, fingerprint, choice_fingerprints: choiceFingerprints, intent_order: intentOrder, started_at: new Date(sharedAt).toISOString() });
    }
    const shared = [];
    const placed = new Array(ordered.length);
    // One retained selection time keeps the first picked item first even when a later batch is resumed after an
    // interruption. The feed remains newest first; private and literal entries use the same global item index.
    const orderAt = index => new Date(sharedAt - index).toISOString();
    const writes = ordered.map((entry, index) => ({ entry, index, wire: entry.private
      ? { record: entry.copy, order_at: orderAt(index) }
      : { item: entry.literal, source_ref: `shared-selection:${selectionId}:${index}`, order_at: orderAt(index) } }))
      .filter(({ entry }) => entry.aliasOf === undefined);
    const wireBytes = writes.map(({ wire }) => new TextEncoder().encode(JSON.stringify(wire)).byteLength);
    if (wireBytes.some(size => size + 2 > MAX_SPACE_SHARE_BATCH_BYTES)) throw new SharingError('One pursuit item is too large to send. Shorten it before sharing.');
    // Admit the full selection without changing any source choice: a denied late source must not leave an
    // earlier slice placed. Use the same admission again after each awaited Space write, since another owner
    // choice can overtake this selection while a prior slice is in flight.
    const choiceToKeep = ({ entry, index }) => {
      if (!entry.private) return null;
      const ref = entry.copy.private_ref;
      const own = this.sharingRowOf(ref);
      const current = this.effectiveSharing(ref);
      if (this.sharingIntentOvertaken(ref, intentOrder)) {
        // A later explicit owner choice refuses this old request. A later Space selection can instead answer with
        // its withdrawn placement from the Space writer, preserving the idempotent retry result.
        const effectiveNow = this.effectiveSharing(ref);
        const newer = this.sharingRowOf(effectiveNow?.from ?? ref);
        if (newer?.choice_revision?.startsWith('space-share:')) return null;
        if (effectiveNow?.network === false && !effectiveNow.spaces.includes(spaceId)) throw new SharingError(sharing.refused.not_shared_here);
        throw new SharingError('This sharing choice changed since the pursuit selection. Share it again to use the current choice.');
      }
      const original = originalFingerprints[index];
      const selectionRevision = `space-share:${selectionId}:${index}`;
      const sourceOrder = this.sharingRowOf(current?.from ?? ref)?.owner_intent_order;
      const changedByOlderIntent = Number.isSafeInteger(sourceOrder) && sourceOrder < intentOrder;
      // A later owner edit can still include this Space before its own Network write arrives. Its changed
      // revision must not let an older request fill that gap or report its old selection as current.
      if (current?.spaces.includes(spaceId)) {
        if (earlier && shareChoiceFingerprint(current) !== original && own?.choice_revision !== selectionRevision && !changedByOlderIntent)
          throw new SharingError('This sharing choice changed since the pursuit selection. Share it again to use the current choice.');
        return null;
      }
      if ((shareChoiceFingerprint(current) !== original && !changedByOlderIntent) || (hasChoice(own) && own.network === false)) throw new SharingError(sharing.refused.not_shared_here);
      const base = (hasChoice(own) ? own : current) ?? { network: null, people: [], leave_out: [], spaces: heldByRef.get(ref) ?? [] };
      return { ref, choice: { network: base.network, people: base.people, leave_out: base.leave_out, match_only: base.match_only ?? [], chain: own?.chain === true, spaces: unique([...base.spaces, spaceId]) }, revision: selectionRevision };
    };
    for (const write of writes) choiceToKeep(write);
    for (let start = 0; start < writes.length;) {
      const group = [];
      let bytes = 2;
      while (start < writes.length && group.length < 100 && bytes + wireBytes[start] + (group.length ? 1 : 0) <= MAX_SPACE_SHARE_BATCH_BYTES) {
        group.push(writes[start]);
        bytes += wireBytes[start] + (group.length > 1 ? 1 : 0);
        start += 1;
      }
      // Keep each admitted source choice before the Space can notify another member. Recheck it here rather
      // than trusting the full-selection check across an await; retained revisions still fence old retries.
      for (const write of group) {
        const choice = choiceToKeep(write);
        if (choice) this.keepSharing(choice.ref, choice.choice, choice.revision, intentOrder);
      }
      const answer = await network.addSharedSpaceItems({ relay, space_id: spaceId, app, selection_key: selectionId, intent_order: intentOrder, entries: group.map(({ wire }) => wire) });
      shared.push(answer);
      group.forEach(({ entry, index }, offset) => {
        const wasWithdrawn = answer.withdrawn?.[offset] === true;
        placed[index] = { item_id: answer.ids[offset], ...(wasWithdrawn ? { withdrawn: true } : {}) };
        // Older selections may have reached Space before this owner-first protocol. Their unchanged choice can
        // still be repaired here; a newer choice or withdrawn Space row always wins.
        if (!entry.private || wasWithdrawn || intentOrder !== 0) return;
        const ref = entry.copy.private_ref;
        const current = this.effectiveSharing(ref);
        const original = earlier?.choice_fingerprints?.[index];
        if (shareChoiceFingerprint(current) !== original || current?.spaces.includes(spaceId)) return;
        const own = this.sharingRowOf(ref);
        const base = (hasChoice(own) ? own : current) ?? { network: null, people: [], leave_out: [], spaces: heldByRef.get(ref) ?? [] };
        this.keepSharing(ref, { network: base.network, people: base.people, leave_out: base.leave_out, match_only: base.match_only ?? [], chain: own?.chain === true, spaces: unique([...base.spaces, spaceId]) });
      });
    }
    ordered.forEach((entry, index) => { if (entry.aliasOf !== undefined) placed[index] = placed[entry.aliasOf]; });
    return { space_id: spaceId, shared, placed, count: ordered.length };
  },

  // What other people shared with this person one by one, newest first (the Shared with me screen, shared_with_me).
  async sharedWithMe() {
    return this.network().recordsOffered({ relay: this.relay() });
  },

  // One thing another person shared with this person, read from its owner's store at this moment (invariant 3).
  async readSharedWithMe(offerId, { bounded = false } = {}) {
    const relay = bounded ? this.fact('network_relay') : this.relay();
    if (!relay) throw new SharingError(sharing.refused.not_shared_with_you);
    const input = { relay, offer_id: offerId, ...(bounded ? { bounded: true } : {}) };
    const offer = await this.network().openOffer(input);
    const copy = typeof this.releaseOfferedRecord === 'function'
      ? await this.releaseOfferedRecord({ person_ref: offer.person_ref, private_ref: offer.private_ref })
      : await this.env.PERSON.get(this.env.PERSON.idFromString(offer.person_ref)).releaseRecord({ private_ref: offer.private_ref, asking_relay: relay });
    // Membership and the offer can change while its owner reads. The present
    // offer must still name that same owner and source when the copy leaves.
    const current = await this.network().openOffer(input);
    if (current.person_ref !== offer.person_ref || current.private_ref !== offer.private_ref || current.from_relay !== offer.from_relay) throw new SharingError(sharing.refused.not_shared_with_you);
    return { ...copy, provenance: { ...copy.provenance, from: current.from, owner_ref: current.from_relay } };
  },

  // Another person reads one record this person shared with them: decided now (invariant 3), a copy only (invariant 2).
  async releaseRecord({ private_ref: ref, asking_relay: asking }) {
    const effective = this.effectiveSharing(String(ref ?? ''));
    if (!effective?.people.includes(asking)) throw new SharingError(sharing.refused.not_shared_with_you);
    const choice = JSON.stringify(effective);
    const { private_ref: _hidden, ...copy } = await this.sharedCopy(ref);
    // The source may await a list or native owner. Recheck both access and
    // field choices after it, so a revoked/narrowed share releases no old copy.
    const current = this.effectiveSharing(String(ref ?? ''));
    if (!current?.people.includes(asking) || JSON.stringify(current) !== choice) throw new SharingError(sharing.refused.not_shared_with_you);
    return { ...copy, preview: previewOf(copy), provenance: { origin: 'shared with you from a private Trillion', shared_at: effective.changed_at, read_at: new Date().toISOString() } };
  },

  // A tool shared by a link that lets its holder run it (record-sharing.json abilities `run`): this owner's current
  // saved tool, released to the recipient the link names while the link is open and its own condition holds, every
  // time a run is started, begun or described (src/workshop.mjs `share`). The recipient's own Workshop runs it with
  // their own connections; nothing of this account's locked box goes with it. An ended, revoked or someone else's
  // link, or one that lets its holder only see, releases nothing.
  async releaseSharedTool(code, recipient = {}, toolId = null, now = Date.now()) {
    const { index, grant } = await this.admittedGrant(code, recipient, now);
    if (!(grant.can ?? ['view']).includes('run')) throw new SharingError('This link lets you see this tool, not run it.');
    const shared = unique([index.record, ...(grant.records ?? [])]).filter(ref => typeof ref === 'string' && ref.startsWith('tool:'));
    const ref = toolId ? shared.find(item => item === toolId) : shared.length === 1 ? shared[0] : null;
    if (!ref) throw new SharingError(toolId ? `This link does not share ${toolId}.` : 'Name the tool this link shares (tool_id).');
    return this.sharedToolRow(ref);
  },

  // A Space has already checked its reader's membership and item rules. The owner still checks its current choice
  // and projects its current record on every read, so a stored Space item cannot become a second source of truth.
  async releaseRecordToSpace({ private_ref: ref, space_id: spaceId }) {
    const mayRead = () => typeof ref === 'string' && Boolean(ref) && typeof spaceId === 'string' && Boolean(spaceId)
      && this.effectiveSharing(ref)?.spaces.includes(spaceId);
    if (!mayRead()) {
      throw new SharingError(sharing.refused.not_shared_here);
    }
    const copy = await this.sharedCopy(ref);
    // sharedCopy may await an owner-specific source. Recheck after it so a share withdrawn during that read cannot
    // return its previously authorized words.
    if (!mayRead()) throw new SharingError(sharing.refused.not_shared_here);
    return copy;
  },
};

export const isSharingPath = path => path.startsWith('/sharing/') || path === '/shared-with-me' || path === '/shared-with-me/read';

export async function handleSharingRequest(person, request) {
  try {
    if (!reachOf(request).private) throw new SharingError('This sign-in reaches only your pursuits, so it cannot choose or read what is shared from a private Trillion.');
    const path = new URL(request.url).pathname;
    const body = request.method === 'GET' ? {} : await request.json().catch(() => ({}));
    // The brand every recipient page of this account carries (record-sharing.json look): read, set, or cleared with null.
    if (path === '/sharing/look') return Response.json(request.method === 'GET' ? { look: person.shareLook() } : person.setShareLook(body.clear === true ? null : body));
    if (path === '/sharing/collection/links' && request.method === 'GET') {
      const url = new URL(request.url);
      const limit = url.searchParams.has('limit') ? Number(url.searchParams.get('limit')) : 16;
      return Response.json(person.collectionLinks({ limit, before: url.searchParams.get('before'), origin: request.headers.get('x-trillion-origin') }));
    }
    if (path === '/sharing/collection/links' && request.method === 'POST') {
      if (!Array.isArray(body.items)) throw new SharingError('items is a list of share items.');
      return Response.json(await person.createRecordShare(null, { ...body, origin: request.headers.get('x-trillion-origin') }));
    }
    const collectionAppend = path.match(/^\/sharing\/collection\/links\/([^/]+)\/items$/);
    if (collectionAppend && request.method === 'POST') {
      const shareId = decodeURIComponent(collectionAppend[1]);
      return Response.json(await person.appendRecordShare(`share-bundle:${shareId}`, shareId, body));
    }
    const collectionPublish = path.match(/^\/sharing\/collection\/links\/([^/]+)\/publish$/);
    if (collectionPublish && request.method === 'POST') {
      const shareId = decodeURIComponent(collectionPublish[1]);
      return Response.json(await person.publishRecordShare(`share-bundle:${shareId}`, shareId, { origin: request.headers.get('x-trillion-origin') }));
    }
    const collectionSend = path.match(/^\/sharing\/collection\/links\/([^/]+)\/send$/);
    if (collectionSend && request.method === 'POST') return Response.json(await person.sendRecordShare(`share-bundle:${decodeURIComponent(collectionSend[1])}`, decodeURIComponent(collectionSend[1]), { note: body.note ?? null, origin: request.headers.get('x-trillion-origin') }));
    const collectionRevoke = path.match(/^\/sharing\/collection\/links\/([^/]+)\/revoke$/);
    if (collectionRevoke && request.method === 'POST') return Response.json(await person.revokeRecordShare(`share-bundle:${decodeURIComponent(collectionRevoke[1])}`, decodeURIComponent(collectionRevoke[1])));
    if (path === '/shared-with-me' && request.method === 'GET') return Response.json(await person.sharedWithMe());
    if (path === '/shared-with-me/read' && request.method === 'POST') return Response.json(await person.readSharedWithMe(body.offer_id));
    if (path === '/sharing/match' && request.method === 'POST') return Response.json(await person.matchSharedValue(body));
    const rest = path.slice('/sharing/'.length);
    const linksAt = rest.lastIndexOf('/links');
    if (linksAt >= 0) {
      const namedRecord = decodeURIComponent(rest.slice(0, linksAt));
      const tail = rest.slice(linksAt + '/links'.length).split('/').filter(Boolean);
      if (!namedRecord) return Response.json({ error: 'Not found' }, { status: 404 });
      // A sealed record has no copy this store can make: its links (sealed links only) are managed by its own id.
      const sealedRecord = person.store.eeaf.typeOf(namedRecord) === SEALED_TYPE;
      // A mixed selection owns its existing link in a sharing row, not an ordinary record. Manage that owned
      // grant even after expiry; each operation still checks its share id, abilities and revocation state.
      const collectionOwner = namedRecord.startsWith('share-bundle:') && person.sharingRowOf(namedRecord)?.link_grants?.some(grant =>
        namedRecord === `share-bundle:${grant.share_id}` && (grant.collection || Array.isArray(grant.entries)));
      const ref = sealedRecord || collectionOwner && (tail.length || request.method === 'GET') ? namedRecord : (await person.sharedCopy(namedRecord)).private_ref;
      if (!tail.length && request.method === 'GET') return Response.json({ links: person.shareLinksOf(ref) });
      if (!tail.length && request.method === 'POST') {
        if (body.records !== undefined && (!Array.isArray(body.records) || body.records.length > 99)) throw new SharingError('records is a list of at most 99 additional records.');
        const records = body.records === undefined ? [] : await Promise.all(body.records.map(async item => {
          if (typeof item !== 'string' || !item) throw new SharingError('records must name records in your Trillion.');
          return (await person.sharedCopy(item)).private_ref;
        }));
        return Response.json(await person.createRecordShare(ref, { ...body, records, origin: request.headers.get('x-trillion-origin') }));
      }
      if (tail.length === 2 && tail[1] === 'items' && request.method === 'POST') return Response.json(await person.appendRecordShare(ref, tail[0], body));
      if (tail.length === 2 && tail[1] === 'publish' && request.method === 'POST') return Response.json(await person.publishRecordShare(ref, tail[0], { origin: request.headers.get('x-trillion-origin') }));
      if (tail.length === 2 && tail[1] === 'revoke' && request.method === 'POST') return Response.json(await person.revokeRecordShare(ref, tail[0]));
      if (tail.length === 2 && tail[1] === 'change' && request.method === 'POST') return Response.json(await person.changeRecordShare(ref, tail[0], body));
      if (tail.length === 2 && tail[1] === 'send' && request.method === 'POST') return Response.json(await person.sendRecordShare(ref, tail[0], { note: body.note ?? null, origin: request.headers.get('x-trillion-origin') }));
      return Response.json({ error: 'Not found' }, { status: 404 });
    }
    const previewing = rest.endsWith('/preview');
    const named = decodeURIComponent(previewing ? rest.slice(0, -'/preview'.length) : rest);
    if (!named) return Response.json({ error: 'Not found' }, { status: 404 });
    // A file named by its name is chosen for as the file it is (file:<identity>), wherever it is named from.
    const ref = person.store.eeaf.typeOf(named) === SEALED_TYPE ? named : (await person.sharedCopy(named)).private_ref;
    if (previewing && request.method === 'POST') return Response.json(await person.previewSharing(ref, body.leave_out));
    if (!previewing && request.method === 'GET') return Response.json(await person.sharingSheet(ref));
    if (!previewing && request.method === 'POST') return Response.json(await person.setRecordSharing(ref, body));
    return Response.json({ error: 'Not found' }, { status: 404 });
  } catch (error) {
    if (!engineFault(error)) return Response.json({ error: error.message }, { status: 400 });
    sayEngineFault(error, request);
    return Response.json({ error: SHARING_FAULT_WORDS, code: 'sharing_internal_fault', retryable: false }, { status: 500 });
  }
}

// A JavaScript engine fault (a JSON.parse of a value that is not text, a missing property) raised anywhere under a sharing request
// comes from stored state or our own code, never from what the caller asked: it answers 500 with a typed code and its own words,
// not a 400 that blames the caller with the engine's message. The name survives a call across a Durable Object (the class does not).
const ENGINE_FAULTS = new Set(['SyntaxError', 'TypeError', 'RangeError', 'ReferenceError', 'URIError', 'EvalError']);
const engineFault = error => ENGINE_FAULTS.has(error?.name);
const SHARING_FAULT_WORDS = 'Trillion hit a problem it did not expect while sharing this. Nothing was shared.';
// Said once per fault name and first line (bounded): the record's kind, the file of the step that threw and the first line of the
// engine's message, never a value from the request.
const saidFaults = new Set();
function sayEngineFault(error, request) {
  const first = String(error?.message ?? '').split('\n')[0].slice(0, 200);
  const key = `${error.name}:${first}`;
  if (saidFaults.has(key)) return;
  if (saidFaults.size >= 100) saidFaults.clear();
  saidFaults.add(key);
  const at = /^\s*at .*?([\w.-]+\.mjs):\d+:\d+\)?$/m.exec(String(error.stack ?? ''))?.[1] ?? null;
  const record = /^\/sharing\/([^/?]+)/.exec(new URL(request.url).pathname)?.[1] ?? '';
  console.error(JSON.stringify({ event: 'sharing_request_engine_fault', name: error.name, message: first, step_owner: at,
    record_kind: decodeURIComponent(record).split(':')[0].slice(0, 40) || null }));
}

// Shared with me as the account tool tool:shared-with-me (records/workshop-sharing-tool-records.json, run by
// src/person-store.mjs accountActions): the list, or one of them read when offer_id names it.
export const recordSharingActions = person => ({
  'shared-with-me': async ({ offer_id: offerId } = {}) => (offerId ? { shared: await person.readSharedWithMe(String(offerId)) } : person.sharedWithMe()),
});

// What a link's `can` says, once, for every tool that takes it (the service refuses a list without view).
const linkAbilities = { type: 'array', items: { type: 'string' }, description: 'What the recipient may do. Always include "view" (a link always lets them see what it shares); add sign, pay, add_files or run only where the record offers them. Left out, the kind of record gives its usual ones.' };
const recordRef = { type: 'string', description: 'A pursuit id, decision case_id or message id; file:<identity> for a file; tool:<id> for one of their own tools; workflow:<id> for a workflow; list:<list id> for a list with its rows; list:<list id>:rows:<row id> for one row of a list; list:<list id>:views:<view id> for one saved view of a list (only the rows it keeps); site:<installation id> for the current static files of a site this account installed; folder:<path> for a folder people can add files to without an account (its link carries add_files and never shows what the folder holds)' };

export const sharingTools = call => [
  { name: 'sharing_of', description: 'Who one of this person\'s records is shared with, as the sharing sheet shows it: the copy others would see (preview, only the fields that leave), its fields with which are left out, every place it can go (the Trillion network, each space they are in, each person they share a space with) with picked true for where it goes now, the chain switch (the record together with the records linked to it, like a pursuit and its decisions) and inherited_from when a chain choice on another record decides it. It changes nothing.', inputSchema: { type: 'object', required: ['record'], properties: { record: recordRef } }, run: ({ record }) => call(`/sharing/${encodeURIComponent(record)}`) },
  { name: 'set_sharing', description: 'Chooses who one of this person\'s records is shared with, only when they asked. network: true into the network (anonymous learning, and stories when those are on), false never, null as their account chooses (on by default). spaces: the space ids a copy is in; people: the people (the `to.person` of a place from sharing_of) who may read it. Not shared at all is network false with no spaces or people. chain: true to cover the records linked to it too. leave_out: field ids no copy carries. match_only: field ids every copy carries only as a mark ({ match: 1f:... }), so those it is shared with can tell copies holding the same value apart and check a value they already know with match_shared_value, without being shown it. Parts left out stay as they are. Copies made elsewhere are changed to match at once. Returns what sharing_of returns.', inputSchema: { type: 'object', required: ['record'], properties: { record: recordRef, network: { type: ['boolean', 'null'] }, spaces: { type: 'array', items: { type: 'string' } }, people: { type: 'array', items: { type: 'string' } }, chain: { type: 'boolean' }, leave_out: { type: 'array', items: { type: 'string' } }, match_only: { type: 'array', items: { type: 'string' } } } }, run: ({ record, ...choice }) => call(`/sharing/${encodeURIComponent(record)}`, choice) },
  { name: 'match_shared_value', description: 'Whether a value you already know is the one a copy shared with you holds in a field shared to match only (case and spacing of words ignored): name the copy by space_id and item_id (from read_space) or by offer_id (from shared_with_me). Answers { field, matched }. The copy never shows the value, and the record\'s owner sees every question asked: who, which field, when and whether it matched. Two copies holding the same { match } hold the same value.', inputSchema: { type: 'object', required: ['field', 'value'], properties: { space_id: { type: 'string' }, item_id: { type: 'string' }, offer_id: { type: 'string' }, field: { type: 'string' }, value: {} } }, run: input => call('/sharing/match', input) },
  { name: 'shared_with_me', description: 'What other people shared with this person one by one, newest first: each with offer_id, who shared it (the name they show in a pursuit you share), its kind and title. It changes nothing.', inputSchema: { type: 'object', properties: {} }, run: () => call('/shared-with-me') },
  { name: 'read_shared', description: 'Reads one thing another person shared with this person (offer_id from shared_with_me): the copy they share, with where it came from. Refused once they stop sharing it.', inputSchema: { type: 'object', required: ['offer_id'], properties: { offer_id: { type: 'string' } } }, run: ({ offer_id }) => call('/shared-with-me/read', { offer_id }) },
  { name: 'share_record_by_link', description: 'Makes an expiring or open-ended link to one or several records others may read. records lists up to 99 additional record references for one link. scope is { kind: "public" }, { kind: "private", value: recipient relay }, { kind: "email", value: address }, { kind: "phone", value: international number }, or { kind: "code", value: access code }. Recipient-bound links require verified identity when opened. can lists what the recipient may do and always includes view, because a link always lets them see what it shares; add sign, pay, add_files or run only where the kind of record offers them (sign and pay ask the recipient to prove their email with a code, no account needed). Left out, the kind of record gives its usual ones. A link to tool:<id> with run lets the person it names run that tool from their own Trillion (run_tool with share: the link), on their own connections, until the link ends or is stopped. A link to folder:<path> asks for files: anyone it names opens it and drops files in, each kept under a name of its own in that folder, and a computer or AI sends JSON { name, byte_length } to <address>/add for an address to send a file of any size to. when is a rule tree (formula-engine shape) over now, hour, weekday, opened, signed, paid and status that must hold for the link to open. hour and weekday read the clock in time_zone, an IANA zone such as Europe/London, which is required with them. look is own (the account brand, see share_look) or trillion. address names the link\'s own address, /share/<address> (3 to 64 lowercase letters, numbers and hyphens, like spring-pricing); a public link without one gets an address from the shared thing\'s first words. listed true (public links only) puts its page in search results and answer engines: it drops noindex, carries structured data, and can be found from /share/sitemap.xml and /share/llms.txt, which link to smaller documents when many links are listed; a shared list gets one page per row. Returns the opaque link code once, its address and its expiry.', inputSchema: { type: 'object', required: ['record', 'scope'], properties: { record: recordRef, records: { type: 'array', maxItems: 99, items: recordRef }, scope: { type: 'object', required: ['kind'], properties: { kind: { type: 'string', enum: ['public', 'private', 'email', 'phone', 'code'] }, value: { type: 'string' } } }, expires_at: { type: ['string', 'null'] }, can: linkAbilities, when: { type: 'object' }, time_zone: { type: ['string', 'null'] }, look: { type: 'string', enum: ['own', 'trillion'] }, address: { type: 'string', pattern: sharing.addresses.pattern }, listed: { type: 'boolean' } } }, run: ({ record, ...share }) => call(`/sharing/${encodeURIComponent(record)}/links`, share) },
  { name: 'share_collection_by_link', description: 'Makes one link for a mixed selection of records, files, links and words. items is the first batch of up to 100 entries. For more, set publish false and expected_total to the full chosen count, add batches with add_to_share_collection_link, then publish_share_collection_link; recipients cannot open a draft or a partial selection. Nothing is copied. Every source and nested grant is checked again when the link is opened. If a nested link ends, its items show only an unavailable marker while the other items remain; stopping the outer link ends the whole collection.', inputSchema: { type: 'object', required: ['items', 'scope'], properties: { items: { type: 'array', maxItems: 100, items: { type: 'object' } }, scope: { type: 'object', required: ['kind'], properties: { kind: { type: 'string', enum: ['public', 'private', 'email', 'phone', 'code'] }, value: { type: 'string' } } }, expires_at: { type: ['string', 'null'] }, can: linkAbilities, when: { type: 'object' }, time_zone: { type: ['string', 'null'] }, look: { type: 'string', enum: ['own', 'trillion'] }, address: { type: 'string', pattern: sharing.addresses.pattern }, listed: { type: 'boolean' }, publish: { type: 'boolean' }, expected_total: { type: 'integer', minimum: 1 } } }, run: input => call('/sharing/collection/links', input) },
  { name: 'add_to_share_collection_link', description: 'Adds the next ordered batch of up to 100 items to an unpublished mixed share. expected_count is the count before this batch. Repeating the same batch is safe; a conflicting count is refused.', inputSchema: { type: 'object', required: ['share_id', 'expected_count', 'items'], properties: { share_id: { type: 'string' }, expected_count: { type: 'integer', minimum: 0 }, items: { type: 'array', minItems: 1, maxItems: 100, items: { type: 'object' } } } }, run: ({ share_id, ...input }) => call(`/sharing/collection/links/${encodeURIComponent(share_id)}/items`, input) },
  { name: 'publish_share_collection_link', description: 'Opens one completed mixed share to its chosen recipients after every batch was added. The same call can be safely repeated.', inputSchema: { type: 'object', required: ['share_id'], properties: { share_id: { type: 'string' } } }, run: ({ share_id }) => call(`/sharing/collection/links/${encodeURIComponent(share_id)}/publish`, {}) },
  { name: 'send_share_collection_link', description: 'Emails one mixed collection link to the address named by its email scope. The email carries the link without copying or attaching the shared items. Use share_id returned by share_collection_by_link.', inputSchema: { type: 'object', required: ['share_id'], properties: { share_id: { type: 'string' }, note: { type: 'string' } } }, run: ({ share_id, note }) => call(`/sharing/collection/links/${encodeURIComponent(share_id)}/send`, { note }) },
  { name: 'revoke_share_collection_link', description: 'Stops one mixed collection link immediately, including every item and nested share reached through it. Use share_id returned by share_collection_by_link.', inputSchema: { type: 'object', required: ['share_id'], properties: { share_id: { type: 'string' } } }, run: ({ share_id }) => call(`/sharing/collection/links/${encodeURIComponent(share_id)}/revoke`, {}) },
  { name: 'sharing_links_of', description: 'Lists the links made for one of this person’s records, including recipient scope, expiry and whether each ended. It never returns the access code.', inputSchema: { type: 'object', required: ['record'], properties: { record: recordRef } }, run: ({ record }) => call(`/sharing/${encodeURIComponent(record)}/links`) },
  { name: 'share_look', description: 'The brand every page this person shares carries for its recipients: name, accent (a #hex colour) and logo (one of their own picture files, by identity). With no fields it reads the brand; with fields it sets it; clear true goes back to Trillion\'s look. Every page also ends with Made with Trillion.', inputSchema: { type: 'object', properties: { name: { type: 'string' }, accent: { type: 'string' }, logo: { type: 'string' }, clear: { type: 'boolean' } } }, run: input => (Object.keys(input ?? {}).length ? call('/sharing/look', input) : call('/sharing/look')) },
  { name: 'send_share_link', description: 'Emails one open link for a record to the email address the link was made for (share_record_by_link with scope { kind: "email" }): the email says who shared what, carries the link and, with note, your own words, and goes from Trillion in your name, replying to your own email. It shows in Sent. Use share_id from share_record_by_link or sharing_links_of. A link for a phone number goes by text with send_message or tool:send-to-an-audience.', inputSchema: { type: 'object', required: ['record', 'share_id'], properties: { record: recordRef, share_id: { type: 'string' }, note: { type: 'string', maxLength: 2000 } } }, run: ({ record, share_id, note }) => call(`/sharing/${encodeURIComponent(record)}/links/${encodeURIComponent(share_id)}/send`, note === undefined ? {} : { note }) },
  { name: 'change_record_share_link', description: 'Changes one open share link for a record without making a new one: can (what the recipient may do, always including view), expires_at (a future time, or null for no end) and when (a rule tree over now, hour, weekday, opened, signed, paid and status, or null for no condition), with time_zone (an IANA zone such as Europe/London, which hour and weekday read the clock in). Fields left out stay as they are. Use share_id from sharing_links_of; the change holds from the next time the link is opened.', inputSchema: { type: 'object', required: ['record', 'share_id'], properties: { record: recordRef, share_id: { type: 'string' }, can: linkAbilities, expires_at: { type: ['string', 'null'] }, when: { type: ['object', 'null'] }, time_zone: { type: ['string', 'null'] } } }, run: ({ record, share_id, ...change }) => call(`/sharing/${encodeURIComponent(record)}/links/${encodeURIComponent(share_id)}/change`, change) },
  { name: 'revoke_record_share_link', description: 'Stops one share link for a record immediately. Use share_id from sharing_links_of.', inputSchema: { type: 'object', required: ['record', 'share_id'], properties: { record: recordRef, share_id: { type: 'string' } } }, run: ({ record, share_id }) => call(`/sharing/${encodeURIComponent(record)}/links/${encodeURIComponent(share_id)}/revoke`, {}) },
];

export const sharingAnnotations = {
  sharing_of: { title: 'See who a record is shared with', readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  set_sharing: { title: 'Choose who a record is shared with', readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  match_shared_value: { title: 'Check a value against a shared copy', readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  shared_with_me: { title: 'See what people shared with me', readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  read_shared: { title: 'Read something shared with me', readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  share_record_by_link: { title: 'Make a link to a record', readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
  share_collection_by_link: { title: 'Make one link for a mixed selection', readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  add_to_share_collection_link: { title: 'Add items to a share link', readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  publish_share_collection_link: { title: 'Open a completed share link', readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  send_share_collection_link: { title: 'Email a mixed share link', readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
  revoke_share_collection_link: { title: 'Stop a mixed share link', readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
  sharing_links_of: { title: 'See links to a record', readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  share_look: { title: 'Read or set the brand on shared pages', readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  send_share_link: { title: 'Email a share link', readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
  change_record_share_link: { title: 'Change a share link', readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  revoke_record_share_link: { title: 'Stop a share link', readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
};
