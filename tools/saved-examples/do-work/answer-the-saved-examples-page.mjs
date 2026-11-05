// src/saved-examples.mjs
//
// PURPOSE
//   Saved examples: posts, videos and pages other people made that worked, each kept with where it came from, its
//   words, its pictures and why it worked, so a person and any AI can make their own work in a shape that is already
//   proven. Owned here, kept in the person's own store. Reached three ways that all end in this owner:
//   - any AI, as the Workshop tools tool:save-an-example, tool:list-saved-examples and tool:remove-a-saved-example
//     (records/workshop-saved-example-tool-records.json, account actions in src/person-store.mjs);
//   - the person's Saved examples screen (src/workspace/saved-examples-screen.tsx, /work/api/saved-examples);
//   - a share sent with an action that keeps examples (records/share-destination-starters.json
//     saved_example_actions, src/share-destinations.mjs deliver).
//
//   GET  /saved-examples          { examples: [Example], count }            newest first
//   POST /saved-examples          { url, title?, words?, pictures?, why_it_worked?, collection?, added_from? } -> Example
//   POST /saved-examples/remove   { id } -> { id, removed: true }
//
//   Example: { id, url, host, site, title, words, pictures: [url], why_it_worked, collection, added_from, added_at,
//              updated_at }
//
// NON-NEGOTIABLE INVARIANTS
//   1. One example per address: the id is a BLAKE3 digest of the address, so the same post saved twice is one
//      example, and saving it again fills in what was given (why it worked, words) without losing what it had.
//   2. Real data only: what the caller did not give is read from the link itself (src/read-link.mjs); a fact neither
//      states is empty, never guessed.
//   3. Nothing exists until something is saved: an account that never saves an example keeps nothing here.
//   4. Every write is checked whole before it is kept, so a refused save leaves the example as it was.
//
// store: { list() -> [value], put(id, value) }   one current value per id; a removed example is a value with removed_at
// readLink(url) -> the card src/read-link.mjs readLinkCard answers

import { blake3 } from '@noble/hashes/blake3.js';
import { bytesToHex } from '@noble/hashes/utils.js';

export class SavedExamplesError extends Error {}

const MAX_WORDS = 20_000;
const MAX_WHY = 4000;
const MAX_TITLE = 500;
const MAX_PICTURES = 20;
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);

function text(value, max, field) {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string') throw new SavedExamplesError(`${field} is text.`);
  return value.trim().slice(0, max) || null;
}

function address(value, field) {
  let url;
  try { url = new URL(String(value ?? '').trim()); } catch { throw new SavedExamplesError(`${field} must be a web address, for example https://www.instagram.com/p/...`); }
  if (!['http:', 'https:'].includes(url.protocol)) throw new SavedExamplesError(`${field} must be an http or https address.`);
  url.hash = '';
  return url.href;
}

/** The id of the example at one address: one per post, whatever ending its link was pasted with. */
export function exampleId(url) {
  const canonical = new URL(address(url, 'url'));
  canonical.hostname = canonical.hostname.toLowerCase().replace(/^www\./, '');
  const path = canonical.pathname.replace(/\/+$/, '') || '/';
  return `example:${bytesToHex(blake3(new TextEncoder().encode(`${canonical.protocol}//${canonical.host}${path}${canonical.search}`))).slice(0, 32)}`;
}

function picturesFrom(value) {
  if (value === undefined || value === null) return null;
  if (!Array.isArray(value) || value.length > MAX_PICTURES) throw new SavedExamplesError(`pictures is a list of up to ${MAX_PICTURES} picture addresses.`);
  return [...new Set(value.map(one => address(one, 'Each picture')))];
}

// Saving and removing an example are each one synchronous write, committed with their answer through `commit` (kept
// under the command's receipt, src/standalone-resource-behavior.mjs routeReceipts).
export const SAVED_EXAMPLE_RECEIPTED_WRITES = Object.freeze(['saved-examples:save', 'saved-examples:remove']);
export function makeSavedExamples({ store, readLink, now = () => new Date().toISOString(), commit = change => change() }) {
  const current = () => store.list().filter(value => object(value) && typeof value.id === 'string' && !value.removed_at);

  function list() {
    const examples = current().sort((a, b) => String(b.added_at).localeCompare(String(a.added_at)));
    return { examples, count: examples.length };
  }

  async function save(input = {}) {
    if (!object(input)) throw new SavedExamplesError('Give { url } and anything you know about it: title, words, pictures, why_it_worked.');
    const url = address(input.url, 'url');
    const given = {
      title: text(input.title, MAX_TITLE, 'title'),
      words: text(input.words, MAX_WORDS, 'words'),
      pictures: picturesFrom(input.pictures),
      why_it_worked: text(input.why_it_worked, MAX_WHY, 'why_it_worked'),
      collection: text(input.collection, 200, 'collection'),
    };
    const addedFrom = text(input.added_from, 60, 'added_from') ?? 'ai';
    const addressId = exampleId(url);
    // Existing examples retain their identity and provenance. Match the saved address too:
    // older identities omitted nondefault ports, so id equality cannot establish the same post.
    const earlier = current().find(value => {
      try { return exampleId(value.url) === addressId; } catch { return false; }
    }) ?? null;
    let id = earlier?.id ?? addressId;
    if (!earlier && current().some(value => value.id === id)) {
      id = `example:${bytesToHex(blake3(new TextEncoder().encode(`distinct-address:${addressId}`))).slice(0, 32)}`;
      if (current().some(value => value.id === id)) throw new SavedExamplesError('This address could not be saved. Your existing examples were kept.');
    }
    // The link itself fills what nobody gave, the first time it is saved.
    const card = earlier ? null : await readLink(url).catch(() => null);
    const at = now();
    const example = {
      id,
      url: earlier?.url ?? url,
      host: earlier?.host ?? card?.host ?? new URL(url).hostname.replace(/^www\./, ''),
      site: earlier?.site ?? card?.site ?? null,
      title: given.title ?? earlier?.title ?? card?.title ?? null,
      words: given.words ?? earlier?.words ?? card?.description ?? (card?.text ? card.text.slice(0, MAX_WORDS) : null),
      pictures: given.pictures ?? earlier?.pictures ?? (card?.images ?? []).slice(0, MAX_PICTURES),
      why_it_worked: given.why_it_worked ?? earlier?.why_it_worked ?? null,
      collection: given.collection ?? earlier?.collection ?? null,
      added_from: earlier?.added_from ?? addedFrom,
      added_at: earlier?.added_at ?? at,
      updated_at: at,
    };
    return commit(() => { store.put(id, example); return example; }, { operation: 'saved-examples:save' });
  }

  function remove(input = {}) {
    const id = object(input) && typeof input.id === 'string' ? input.id : '';
    if (!current().some(value => value.id === id)) throw new SavedExamplesError(`There is no saved example ${id || 'with no id'}. Read the list for the ids.`);
    return commit(() => { store.put(id, { id, removed_at: now() }); return { id, removed: true }; }, { operation: 'saved-examples:remove' });
  }

  return { list, save, remove };
}

export const isSavedExamplesPath = path => path === '/saved-examples' || path === '/saved-examples/remove';

export async function handleSavedExamplesRequest(examples, request) {
  const path = new URL(request.url).pathname;
  try {
    if (request.method === 'GET' && path === '/saved-examples') return Response.json(examples.list());
    if (request.method !== 'POST') return Response.json({ error: 'Not found' }, { status: 404 });
    const raw = await request.text();
    if (raw.length > 200_000) throw new SavedExamplesError('Request too large');
    const body = JSON.parse(raw || '{}');
    return Response.json(path === '/saved-examples/remove' ? examples.remove(body) : await examples.save(body));
  } catch (error) {
    return Response.json({ error: error.message }, { status: error instanceof SavedExamplesError || error instanceof SyntaxError ? 400 : 500 });
  }
}

// ---------------------------------------------------------------------------------------------------------------------
// tools/saved-examples: the owner above is old trillion's src/saved-examples.mjs at tag old-trillion-before-worker-retire,
// unchanged. The Saved examples page's routes reach it here as a @workshop-routes tool (input { path, method, query,
// body, browser }, result { status, body }), with its store the person's saved-example records through the run's
// records door, read once before the owner runs and written once after (a refused save writes nothing). An example
// the owner removes ({ id, removed_at }) is removed as tool:remove-a-saved-example removes it: its record's value is
// null, and the records keep its history. What a save was not given is read from the public link itself
// (tools/read-a-public-web-link-whole-its-card readLinkCard, the same reader src/read-link.mjs was).
import { readLinkCard } from '../../read-a-public-web-link-whole-its-card/src/read-link.mjs';

const KIND = 'saved-example';

/** tool:answer-the-saved-examples-page: run by tools/records-door/do-work/run-an-export.mjs as fn(input, { door }). */
export async function answerTheSavedExamplesPage(input, { door }) {
  const { path = '', method = 'GET', body } = object(input) ? input : {};
  const values = new Map();
  for await (const record of door.list({ type: KIND })) if (object(record.value)) values.set(record.id, record.value);
  const writes = new Map();
  const store = { list: () => [...values.values()], put: (id, value) => { values.set(id, value); writes.set(id, value); } };
  const examples = makeSavedExamples({ store, readLink: url => readLinkCard(url) });
  const request = new Request(`https://person${path}`, method === 'GET' ? {} : { method, body: JSON.stringify(body ?? {}) });
  const response = await handleSavedExamplesRequest(examples, request);
  if (response.status < 400 && writes.size) {
    await door.write([...writes].map(([id, value]) => ({ id, type: KIND, value: value.removed_at ? null : value })));
  }
  return { status: response.status, body: await response.json() };
}
