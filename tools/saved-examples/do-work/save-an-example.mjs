// tools/saved-examples/do-work/save-an-example.mjs
//
// PURPOSE
//   save-an-example as one pure function. Give it one link and what the caller knows; it returns the saved-example
//   record it makes and checks that record against the input. Ported from the save() of the old repository's
//   src/saved-examples.mjs and the tool row in records/workshop-saved-example-tool-records.json (commit b6ae0ebf815f).
//
//   Built and tested, not wired: no tool row, route or page calls this function yet.
//
// PURE
//   It reads no store, makes no request and writes nothing. The caller passes the saved-example records it already keeps
//   (as { type, id, value } rows, or as bare example values), and when it has read the link, the card the link states
//   (what tools/read-a-public-web-link-whole-its-card returns). The caller writes the returned record where it keeps
//   records, and only when `verified` is true.
//
// INVARIANTS
//   1. One example per address: the id is a BLAKE3 digest of the address. Saving the same post again fills in what was
//      given and keeps what it had, including who added it first and when.
//   2. The card fills only a new example, and only what the caller did not give. A fact neither states is null.
//   3. Output contains input: every input field that was given comes back equal in the record (the url names the same
//      post). A record that does not is reported as not verified, and the caller keeps nothing.

import { blake3 } from '@noble/hashes/blake3.js';
import { bytesToHex } from '@noble/hashes/utils.js';

export class SaveAnExampleError extends Error {}

const KIND = 'saved-example';
const MAX_TITLE = 500;
const MAX_WORDS = 20_000;
const MAX_WHY = 4000;
const MAX_COLLECTION = 200;
const MAX_ADDED_FROM = 60;
const MAX_PICTURES = 20;
const INPUT_FIELDS = ['url', 'title', 'words', 'pictures', 'why_it_worked', 'collection'];

const isObject = value => value !== null && typeof value === 'object' && !Array.isArray(value);

function text(value, max, field) {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string') throw new SaveAnExampleError(`${field} is text.`);
  return value.trim().slice(0, max) || null;
}

function addressOf(value, field) {
  let url;
  try { url = new URL(String(value ?? '').trim()); } catch { throw new SaveAnExampleError(`${field} must be a web address, for example https://www.instagram.com/p/...`); }
  if (!['http:', 'https:'].includes(url.protocol)) throw new SaveAnExampleError(`${field} must be an http or https address.`);
  url.hash = '';
  return url.href;
}

function picturesOf(value) {
  if (value === undefined || value === null) return null;
  if (!Array.isArray(value) || value.length > MAX_PICTURES) throw new SaveAnExampleError(`pictures is a list of up to ${MAX_PICTURES} picture addresses.`);
  return [...new Set(value.map(one => addressOf(one, 'Each picture')))];
}

/** The id of the example at one address: one per post, whatever ending its link was pasted with. */
export function exampleIdOf(url) {
  const canonical = new URL(addressOf(url, 'url'));
  canonical.hostname = canonical.hostname.toLowerCase().replace(/^www\./, '');
  const path = canonical.pathname.replace(/\/+$/, '') || '/';
  const digest = blake3(new TextEncoder().encode(`${canonical.protocol}//${canonical.host}${path}${canonical.search}`));
  return `example:${bytesToHex(digest).slice(0, 32)}`;
}

function sameAddress(a, b) {
  try { return exampleIdOf(a) === exampleIdOf(b); } catch { return false; }
}

/** The live example a caller's row holds, or null: a row is { type, id, value } or a bare example; removed ones are not live. */
function liveValueOf(row) {
  let value = null;
  if (isObject(row) && row.type === KIND && isObject(row.value)) value = row.value;
  else if (isObject(row) && row.type === undefined && typeof row.id === 'string' && typeof row.url === 'string') value = row;
  return value && typeof value.id === 'string' && !value.removed_at ? value : null;
}

/** What the input gives, read the same way the record is made. Fields not given are null. */
function givenOf(input) {
  if (!isObject(input)) throw new SaveAnExampleError('Give { url } and anything you know about it: title, words, pictures, why_it_worked.');
  return {
    url: addressOf(input.url, 'url'),
    title: text(input.title, MAX_TITLE, 'title'),
    words: text(input.words, MAX_WORDS, 'words'),
    pictures: picturesOf(input.pictures),
    why_it_worked: text(input.why_it_worked, MAX_WHY, 'why_it_worked'),
    collection: text(input.collection, MAX_COLLECTION, 'collection'),
  };
}

/** The input fields that were given and that the output does not keep equal. An empty field was not given, so it is not checked. */
function differsFrom(given, output) {
  const differs = [];
  for (const field of INPUT_FIELDS) {
    const value = given[field];
    if (value === null || value === undefined) continue;
    const kept = field === 'url'
      ? isObject(output) && sameAddress(output.url, value)
      : isObject(output) && JSON.stringify(output[field]) === JSON.stringify(value);
    if (!kept) differs.push(field);
  }
  return differs;
}

/** The output-contains-input check on its own: the input fields missing or changed in the output. [] means it holds. */
export function verifyOutputContainsInput(input, output) {
  return differsFrom(givenOf(input), output);
}

/**
 * Makes the saved-example record for one link.
 *   input           { url, title?, words?, pictures?, why_it_worked?, collection?, added_from? }
 *   collectionRows  the caller's saved-example records (rows or bare values); the one at the same address is kept
 *   options         card: the link's card when the caller has read it (used only for a new example);
 *                   now: () => ISO time string
 * Returns { example, verified, differs }. Nothing is written here.
 */
export function saveAnExampleOf(input, collectionRows = [], { card = null, now = () => new Date().toISOString() } = {}) {
  if (!Array.isArray(collectionRows)) throw new SaveAnExampleError('collectionRows is a list of saved-example records.');
  const given = givenOf(input);
  const addedFrom = text(input.added_from, MAX_ADDED_FROM, 'added_from') ?? 'ai';
  const live = collectionRows.map(liveValueOf).filter(Boolean);
  const addressId = exampleIdOf(given.url);
  const earlier = live.find(value => sameAddress(value.url, given.url)) ?? null;
  let id = earlier?.id ?? addressId;
  if (!earlier && live.some(value => value.id === id)) {
    // An id taken by another address (an older identity that omitted a port, say) gets a distinct id, never a shared one.
    id = `example:${bytesToHex(blake3(new TextEncoder().encode(`distinct-address:${addressId}`))).slice(0, 32)}`;
    if (live.some(value => value.id === id)) throw new SaveAnExampleError('This address could not be saved. Your existing examples were kept.');
  }
  const fromCard = !earlier && isObject(card) ? card : null;
  const at = now();
  const example = {
    id,
    url: earlier?.url ?? given.url,
    host: earlier?.host ?? fromCard?.host ?? new URL(given.url).hostname.replace(/^www\./, ''),
    site: earlier?.site ?? fromCard?.site ?? null,
    title: given.title ?? earlier?.title ?? fromCard?.title ?? null,
    words: given.words ?? earlier?.words ?? fromCard?.description ?? (fromCard?.text ? String(fromCard.text).slice(0, MAX_WORDS) : null),
    pictures: given.pictures ?? earlier?.pictures ?? (Array.isArray(fromCard?.images) ? fromCard.images.slice(0, MAX_PICTURES) : []),
    why_it_worked: given.why_it_worked ?? earlier?.why_it_worked ?? null,
    collection: given.collection ?? earlier?.collection ?? null,
    added_from: earlier?.added_from ?? addedFrom,
    added_at: earlier?.added_at ?? at,
    updated_at: at,
  };
  const differs = differsFrom(given, example);
  return { example, verified: differs.length === 0, differs };
}
